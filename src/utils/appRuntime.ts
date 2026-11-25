import type { AppSettings } from "../components/SettingsModal";
import { type Tab } from "./constants";

export const MAX_EPUB_LINES_PER_TAB = 8000;
export const TAB_ORDER_STORAGE_KEY = "txthk-tab-order";

export const applyTabOrder = (tabs: Tab[], order: number[]): Tab[] => {
    if (tabs.length < 2 || order.length === 0) return tabs;

    const orderById = new Map<number, number>();
    order.forEach((id, index) => {
        if (Number.isFinite(id) && !orderById.has(id)) orderById.set(id, index);
    });
    if (orderById.size === 0) return tabs;

    return tabs
        .map((tab, originalIndex) => ({ tab, originalIndex }))
        .sort((left, right) => {
            const leftOrder = orderById.get(left.tab.id);
            const rightOrder = orderById.get(right.tab.id);
            if (leftOrder === undefined && rightOrder === undefined) return left.originalIndex - right.originalIndex;
            if (leftOrder === undefined) return 1;
            if (rightOrder === undefined) return -1;
            return leftOrder - rightOrder;
        })
        .map(({ tab }) => tab);
};

export const readStoredTabOrder = (): number[] => {
    try {
        const parsed = JSON.parse(localStorage.getItem(TAB_ORDER_STORAGE_KEY) || "[]");
        return Array.isArray(parsed)
            ? parsed.filter((id): id is number => typeof id === "number" && Number.isFinite(id))
            : [];
    } catch {
        return [];
    }
};

export const trimRuntimeLine = (line: unknown): string => {
    return typeof line === "string" ? line : String(line ?? "");
};

const LATIN_LETTER_RE = /[A-Za-z\u00c0-\u024f]/;

export const normalizeIncomingHookText = (value: string, removeWhitespace: boolean): string => {
    let text = value
        .replace(/\[\s*%[A-Za-z]\s*\]/g, "")
        // Strip short texthooker control markers like $d / $n / $r (a single latin letter
        // after $), which some hooks emit as separators — e.g. "杏$d椋$d智代".
        .replace(/\$[A-Za-z](?![A-Za-z])/g, "")
        .replace(/\r\n?/g, "\n")
        .replace(/[\t\f\v ]+/g, " ");

    if (!removeWhitespace) return text;

    if (LATIN_LETTER_RE.test(text)) {
        return text
            .replace(/\s*\n+\s*/g, " ")
            .replace(/\s+([.,!?;:)\]}])/g, "$1")
            .replace(/([([{])\s+/g, "$1");
    }

    return text.replace(/\s+/g, "");
};

export const trimTabForRuntime = (tab: Tab): Tab => {
    const sourceLines = Array.isArray(tab.lines) ? tab.lines : [];
    const runtimeLines = sourceLines.every((line) => typeof line === 'string')
        ? sourceLines : sourceLines.map(trimRuntimeLine);
    const sourceFurigana = Array.isArray(tab.lineFurigana) ? tab.lineFurigana : [];
    const runtimeFurigana = sourceFurigana.length === sourceLines.length
        ? sourceFurigana
        : [];
    return {
        ...tab,
        lines: runtimeLines,
        lineFurigana: runtimeFurigana,
        epub: tab.epub
            ? {
                  ...tab.epub,
                  lines: [],
                  html: undefined,
                  blocks: undefined,
                  chapters: undefined,
                  progress: Math.min(1, Math.max(0, tab.epub.progress || 0)),
              }
            : undefined,
    };
};

export type DiscordActivityText = {
    details: string;
    state: string;
    activityType: "playing" | "watching" | "listening" | "competing";
};

/** What the reader is doing, used when the title is hidden. */
export const discordModePhrase = (mode: Tab["mode"] | undefined, settings: AppSettings) => {
    const isEn = (settings.appLanguage || "ru") === "en";
    const custom = settings.discordCustomTextStatus?.trim();
    if (mode === "epub") return isEn ? "Reading a book" : "Читает книгу";
    if (mode === "player") return isEn ? "Watching video" : "Смотрит видео";
    if (custom) return custom;
    return isEn ? "Reading a visual novel" : "Читает визуальную новеллу";
};

/**
 * The two lines shown in Discord. Line 1: the title (or what is being read);
 * line 2: the same numbers as the stats panel — characters read in this tab
 * and the reading speed in the units chosen for the panel — or the pause state.
 */
export const buildDiscordActivity = (
    tab: Tab,
    settings: AppSettings,
    paused: boolean,
): DiscordActivityText => {
    const isEn = (settings.appLanguage || "ru") === "en";
    const format = (value: number) => Math.round(value).toLocaleString(isEn ? "en-US" : "ru-RU");
    const phrase = discordModePhrase(tab.mode, settings);
    const title = settings.discordShowTab !== false && tab.name?.trim() ? tab.name.trim() : "";
    const stats = tab.stats || { chars: 0, words: 0, sentences: 0, time: 0 };

    const parts: string[] = [];
    if (paused) parts.push(isEn ? "Paused" : "На паузе");
    if (settings.discordShowStats !== false && stats.chars > 0) {
        parts.push(isEn ? `${format(stats.chars)} chars` : `${format(stats.chars)} симв.`);
    }
    if (tab.mode === "epub" && settings.discordShowStats !== false) {
        const progress = tab.epub?.progress || tab.readerProgress || 0;
        if (progress > 0) parts.push(isEn ? `${Math.round(progress * 100)}% of the book` : `${Math.round(progress * 100)}% книги`);
    }
    if (!paused && settings.discordShowSpeed !== false && stats.time >= 60) {
        // Same formula and units as the stats panel.
        const metric = settings.speedMetric || "chars";
        const perMinute = settings.speedTimeframe === "minute";
        const amount = metric === "words" ? stats.words : metric === "sentences" ? stats.sentences : stats.chars;
        const speed = (amount / stats.time) * (perMinute ? 60 : 3600);
        if (speed > 0) {
            const unit = metric === "words"
                ? (isEn ? "words" : "слов")
                : metric === "sentences" ? (isEn ? "sent." : "предл.") : (isEn ? "chars" : "симв.");
            parts.push(`${format(speed)} ${unit}/${perMinute ? (isEn ? "min" : "мин") : (isEn ? "h" : "ч")}`);
        }
    }

    const details = title || phrase;
    // Discord rejects one-letter fields; fall back to the reading phrase.
    let state = parts.join(" · ");
    if (state.length < 2) state = title ? phrase : "Setsuna";

    const activityType = tab.mode === "player"
        ? "watching"
        : (settings.discordTextActivityType || "playing");
    return { details, state, activityType };
};

export const normalizeWebSocketUrl = (value: string) => {
    const trimmed = value.trim();
    if (!trimmed) return "";
    if (/^wss?:\/\//i.test(trimmed)) return trimmed;
    return `ws://${trimmed}`;
};

export type HookPayload = {
    text: string;
    furigana?: unknown;
};

const FURIGANA_KEYS = ["furigana", "ruby", "readings", "textFurigana", "text_furigana", "rubyText"];

const firstPayloadValue = (record: Record<string, unknown>, keys: string[]) => {
    for (const key of keys) {
        if (record[key] !== undefined && record[key] !== null) return record[key];
    }
    return undefined;
};

/** Extracts hook text without losing readings supplied by agents such as LunaTranslator. */
export const extractHookPayload = (payload: unknown): HookPayload => {
    if (typeof payload === "string") {
        const trimmed = payload.trim();
        if (!trimmed) return { text: "" };
        if ((trimmed.startsWith("{") && trimmed.endsWith("}")) || (trimmed.startsWith("[") && trimmed.endsWith("]"))) {
            try { return extractHookPayload(JSON.parse(trimmed)); } catch {}
        }
        if (/<ruby\b/i.test(payload)) {
            const plain = payload
                .replace(/<rt\b[^>]*>[\s\S]*?<\/rt>/gi, "")
                .replace(/<rp\b[^>]*>[\s\S]*?<\/rp>/gi, "")
                .replace(/<[^>]+>/g, "");
            return { text: plain, furigana: payload };
        }
        return { text: payload };
    }

    if (Array.isArray(payload)) {
        const parts = payload.map(extractHookPayload).filter((item) => item.text.trim());
        return {
            text: parts.map((item) => item.text).join("\n"),
            furigana: parts.find((item) => item.furigana !== undefined)?.furigana,
        };
    }

    if (payload && typeof payload === "object") {
        const record = payload as Record<string, unknown>;
        const suppliedFurigana = firstPayloadValue(record, FURIGANA_KEYS);
        for (const key of ["sentence", "text", "message", "content", "line", "original", "source", "html", "markup"]) {
            if (record[key] === undefined) continue;
            const result = extractHookPayload(record[key]);
            if (result.text.trim()) return { text: result.text, furigana: suppliedFurigana ?? result.furigana };
        }
        for (const key of ["data", "payload", "body", "result"]) {
            if (record[key] === undefined) continue;
            const result = extractHookPayload(record[key]);
            if (result.text.trim()) return { text: result.text, furigana: suppliedFurigana ?? result.furigana };
        }
    }

    return { text: "" };
};

export const extractHookText = (payload: unknown): string => {
    return extractHookPayload(payload).text;
};

export const normalizeLookupText = (value: string) =>
    value
        .normalize("NFKC")
        .replace(/[\u200b-\u200f\u202a-\u202e\u2060-\u206f]/g, "")
        .replace(/\s+/g, "")
        .trim();

export type CursorLookupToken = {
    text: string;
    lookup: boolean;
    cursor: number;
};

const LATIN_LOOKUP_CHAR_RE = /[A-Za-z\u00c0-\u024f]/u;
const JAPANESE_LOOKUP_CHAR_RE = /[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff\uff66-\uff9f\u3005\u3006]/u;
const KANJI_LOOKUP_CHAR_RE = /[\u3400-\u9fff\uf900-\ufaff]/u;
const HIRAGANA_LOOKUP_CHAR_RE = /[\u3040-\u309f]/u;
const KATAKANA_LOOKUP_CHAR_RE = /[\u30a0-\u30ff\uff66-\uff9f]/u;
const SINGLE_HIRAGANA_PARTICLES = new Set(Array.from(
    "\u306f\u304c\u3092\u306b\u3078\u3067\u3068\u306e\u3082\u3084\u304b\u306d\u3088\u305e\u3055",
));

const fallbackJapaneseSegmentLength = (chars: string[], start: number) => {
    const first = chars[start];
    if (!first) return 0;

    if (KANJI_LOOKUP_CHAR_RE.test(first)) {
        let end = start;
        while (end < chars.length && KANJI_LOOKUP_CHAR_RE.test(chars[end]) && end - start < 4) end += 1;
        const kanjiEnd = end;
        while (end < chars.length && HIRAGANA_LOOKUP_CHAR_RE.test(chars[end]) && end - kanjiEnd < 4) {
            if (end === kanjiEnd && SINGLE_HIRAGANA_PARTICLES.has(chars[end])) break;
            end += 1;
        }
        return Math.max(1, end - start);
    }

    if (KATAKANA_LOOKUP_CHAR_RE.test(first)) {
        let end = start + 1;
        while (end < chars.length && KATAKANA_LOOKUP_CHAR_RE.test(chars[end]) && end - start < 12) end += 1;
        return end - start;
    }

    if (HIRAGANA_LOOKUP_CHAR_RE.test(first)) {
        if (SINGLE_HIRAGANA_PARTICLES.has(first)) return 1;
        let end = start + 1;
        while (end < chars.length && HIRAGANA_LOOKUP_CHAR_RE.test(chars[end]) && end - start < 6) {
            if (SINGLE_HIRAGANA_PARTICLES.has(chars[end])) break;
            end += 1;
        }
        return end - start;
    }

    return 1;
};

export const tokenizeLookupText = (text: string): CursorLookupToken[] => {
    const chars = Array.from(text);
    const parts: CursorLookupToken[] = [];
    let cursor = 0;

    while (cursor < chars.length) {
        const start = cursor;
        const first = chars[cursor];

        if (LATIN_LOOKUP_CHAR_RE.test(first)) {
            cursor += 1;
            while (cursor < chars.length) {
                if (LATIN_LOOKUP_CHAR_RE.test(chars[cursor])) {
                    cursor += 1;
                    continue;
                }
                const isJoiner = chars[cursor] === "'" || chars[cursor] === "\u2019" || chars[cursor] === '-';
                if (isJoiner && LATIN_LOOKUP_CHAR_RE.test(chars[cursor + 1] || '')) {
                    cursor += 1;
                    continue;
                }
                break;
            }
            parts.push({ text: chars.slice(start, cursor).join(''), lookup: true, cursor: start });
            continue;
        }

        if (JAPANESE_LOOKUP_CHAR_RE.test(first)) {
            cursor += Math.max(1, fallbackJapaneseSegmentLength(chars, cursor));
            parts.push({ text: chars.slice(start, cursor).join(''), lookup: true, cursor: start });
            continue;
        }

        cursor += 1;
        while (
            cursor < chars.length
            && !LATIN_LOOKUP_CHAR_RE.test(chars[cursor])
            && !JAPANESE_LOOKUP_CHAR_RE.test(chars[cursor])
        ) {
            cursor += 1;
        }
        parts.push({ text: chars.slice(start, cursor).join(''), lookup: false, cursor: start });
    }

    return parts;
};

export const normalizeJapaneseFontStack = (fontFamily: string) => {
    const fallback = "'Yu Mincho', 'YuMincho', 'Hiragino Mincho ProN', 'BIZ UDPMincho', 'Meiryo', serif";
    if (!fontFamily || /Yu Mincho|YuMincho|Meiryo|BIZ UDPMincho|Yu Gothic/.test(fontFamily)) {
        return fontFamily;
    }
    return `${fontFamily}, ${fallback}`;
};
