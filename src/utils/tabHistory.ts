import { invoke } from '@tauri-apps/api/core';
import type { Tab } from './constants';

/**
 * Full line history of every tab lives in its own file (`tab-lines/<id>.json`)
 * so a new hooked line only rewrites the file of the tab that changed. The
 * workspace file and the localStorage cache hold tab metadata plus, for the
 * cache, only the newest lines for a fast first paint.
 *
 * Safety rule: a tab whose in-memory lines are only that cached tail
 * (`historyTail`) is never written back to its history file.
 */

export const CACHE_TAIL_LINES = 300;

interface StoredHistory {
    version: 1;
    lines: string[];
    lineFurigana?: unknown[];
}

const savedArrays = new Map<number, { lines: unknown; furigana: unknown }>();
let writeChain: Promise<void> = Promise.resolve();

/** Workspace-file form of a tab: no lines, just how many there are. */
export const slimTabForWorkspace = (tab: Tab) => {
    const { lines, lineFurigana, historyTail, ...rest } = tab;
    void lineFurigana;
    void historyTail;
    return { ...rest, lineCount: Math.max(lines.length, tab.historyTail ? tab.lineCount || 0 : 0), historyFile: true as const };
};

/** localStorage form of a tab: metadata plus the newest lines. */
export const tailTabForCache = (tab: Tab) => {
    const { lineFurigana, historyTail, ...rest } = tab;
    void historyTail;
    const total = tab.historyTail ? Math.max(tab.lineCount || 0, tab.lines.length) : tab.lines.length;
    const tail = tab.lines.slice(-CACHE_TAIL_LINES);
    const furigana = Array.isArray(lineFurigana) && lineFurigana.length === tab.lines.length ? lineFurigana.slice(-CACHE_TAIL_LINES) : undefined;
    return { ...rest, lines: tail, lineFurigana: furigana, lineCount: total, historyTail: total > tail.length };
};

/** Writes history files for tabs whose lines changed since the last save. */
export const saveChangedTabHistories = (tabs: Tab[]) => {
    const pending = tabs.filter((tab) => {
        if (tab.historyTail) return false;
        const saved = savedArrays.get(tab.id);
        return !saved || saved.lines !== tab.lines || saved.furigana !== tab.lineFurigana;
    });
    for (const tab of pending) {
        const lines = tab.lines;
        const furigana = tab.lineFurigana;
        const content: StoredHistory = {
            version: 1,
            lines,
            ...(Array.isArray(furigana) && furigana.length === lines.length && furigana.some((item) => item != null) ? { lineFurigana: furigana } : {}),
        };
        writeChain = writeChain
            .then(() => invoke<void>('save_tab_lines', { tabId: tab.id, content: JSON.stringify(content) }))
            .then(() => { savedArrays.set(tab.id, { lines, furigana }); })
            .catch((error) => console.warn(`Failed to save history of tab ${tab.id}`, error));
    }
    return writeChain;
};

/** Marks lines as already persisted (e.g. right after loading them). */
export const markTabHistorySaved = (tab: Tab) => {
    savedArrays.set(tab.id, { lines: tab.lines, furigana: tab.lineFurigana });
};

export const loadTabHistory = async (tabId: number): Promise<StoredHistory | null> => {
    try {
        const content = await invoke<string | null>('load_tab_lines', { tabId });
        if (!content) return null;
        const parsed = JSON.parse(content);
        return parsed && Array.isArray(parsed.lines) ? parsed : null;
    } catch (error) {
        console.warn(`Failed to load history of tab ${tabId}`, error);
        return null;
    }
};

/**
 * Combines the history file with the in-memory tab. If the file is behind
 * (the app closed before the last history write), the newest lines are taken
 * from the cached tail.
 */
export const mergeTabHistory = (tab: Tab, history: StoredHistory | null): Tab => {
    if (!history || !tab.historyTail) {
        // No history file, or memory already holds a full history (legacy
        // workspace, Drive restore): memory is authoritative.
        return { ...tab, historyTail: false };
    }
    const fileLines = history.lines.filter((line) => typeof line === 'string');
    const expected = tab.lineCount || 0;
    let lines = fileLines;
    let furigana: unknown[] | undefined = Array.isArray(history.lineFurigana) && history.lineFurigana.length === fileLines.length ? history.lineFurigana : undefined;
    const missing = expected - fileLines.length;
    if (missing > 0 && missing <= tab.lines.length) {
        lines = [...fileLines, ...tab.lines.slice(-missing)];
        furigana = furigana ? [...furigana, ...new Array(missing).fill(null)] : undefined;
    }
    return { ...tab, lines, lineFurigana: furigana ?? lines.map(() => null), historyTail: false, lineCount: lines.length };
};

/** Removes history files of tabs that were deleted. */
/** Deletes the history files of explicitly deleted tabs only (never of tabs that are just missing). */
export const pruneTabHistories = (tabs: Tab[], deletedIds: number[]) =>
    invoke<number>('prune_tab_lines', { keepIds: tabs.map((tab) => tab.id), deleteIds: deletedIds }).catch(() => 0);

/** Ids of every tab that has a history file. */
export const listTabHistoryIds = () => invoke<number[]>('list_tab_lines').catch(() => [] as number[]);
