import type { AppSettings } from "../components/SettingsModal";
import { defaultStats, type Tab } from "./constants";

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
    const runtimeLines = sourceLines.map(trimRuntimeLine);
    const sourceFurigana = Array.isArray(tab.lineFurigana) ? tab.lineFurigana : [];
    const runtimeFurigana = sourceFurigana.length === sourceLines.length
        ? sourceFurigana
        : [];
    const epubLines = Array.isArray(tab.epub?.lines) ? tab.epub.lines : [];
    return {
        ...tab,
        lines: runtimeLines,
        lineFurigana: runtimeFurigana,
        epub: tab.epub
            ? {
                  ...tab.epub,
                  lines: epubLines.slice(0, MAX_EPUB_LINES_PER_TAB).map(trimRuntimeLine),
                  html: undefined,
                  blocks: undefined,
                  chapters: undefined,
                  progress: Math.min(1, Math.max(0, tab.epub.progress || 0)),
              }
            : undefined,
    };
};

export const formatDiscordMode = (mode: Tab["mode"] | undefined, settings: AppSettings) => {
    const language = settings.appLanguage || "ru";
    const isEn = language === "en";
    if (mode === "epub") return isEn ? "Reading EPUB" : "\u0427\u0438\u0442\u0430\u0435\u0442 EPUB";
    if (mode === "player") return isEn ? "Watching with subtitles" : "\u0421\u043c\u043e\u0442\u0440\u0438\u0442 \u0441 \u0441\u0443\u0431\u0442\u0438\u0442\u0440\u0430\u043c\u0438";
    if (mode === "text") {
        if (settings.discordTextStatus === "custom" && settings.discordCustomTextStatus?.trim()) {
            return settings.discordCustomTextStatus.trim();
        }
        if (settings.discordTextStatus === "playing") return isEn ? "Playing a visual novel" : "\u0418\u0433\u0440\u0430\u0435\u0442 \u0432 \u0432\u0438\u0437\u0443\u0430\u043b\u044c\u043d\u0443\u044e \u043d\u043e\u0432\u0435\u043b\u043b\u0443";
        if (settings.discordTextStatus === "watching") return isEn ? "Watching a visual novel" : "\u0421\u043c\u043e\u0442\u0440\u0438\u0442 \u0432\u0438\u0437\u0443\u0430\u043b\u044c\u043d\u0443\u044e \u043d\u043e\u0432\u0435\u043b\u043b\u0443";
        if (settings.discordTextStatus === "mining") return isEn ? "Mining Japanese lines" : "\u041c\u0430\u0439\u043d\u0438\u0442 \u044f\u043f\u043e\u043d\u0441\u043a\u0438\u0435 \u0441\u0442\u0440\u043e\u043a\u0438";
        return isEn ? "Reading hooked text" : "\u0427\u0438\u0442\u0430\u0435\u0442 \u0447\u0435\u0440\u0435\u0437 \u0445\u0443\u043a\u0435\u0440";
    }
    return isEn ? "Choosing a mode" : "\u0412\u044b\u0431\u0438\u0440\u0430\u0435\u0442 \u0440\u0435\u0436\u0438\u043c";
};

export const formatDiscordStats = (tab: Tab, settings: AppSettings) => {
    const parts: string[] = [];
    const stats = tab.stats || defaultStats;
    const isEn = (settings.appLanguage || "ru") === "en";
    if (settings.discordShowStats) {
        if ((settings.discordShowChars ?? true) && stats.chars > 0) parts.push(`${stats.chars} ${isEn ? "chars" : "симв."}`);
        if ((settings.discordShowWords ?? true) && stats.words > 0) parts.push(`${stats.words} ${isEn ? "words" : "слов"}`);
        if ((settings.discordShowSentences ?? true) && stats.sentences > 0) parts.push(`${stats.sentences} ${isEn ? "lines" : "строк"}`);
    }
    if (settings.discordShowProgress && tab.mode === "epub") {
        parts.push(`${Math.round((tab.epub?.progress || tab.readerProgress || 0) * 100)}%`);
    }
    return parts.join(" / ") || "Setsuna";
};

export const discordActivityTypeForMode = (mode: Tab["mode"] | undefined, settings: AppSettings) => {
    if (mode === "player") return "watching";
    if (mode === "text") {
        if (settings.discordTextActivityType) return settings.discordTextActivityType;
        if (settings.discordTextStatus === "watching") return "watching";
        return "playing";
    }
    return "playing";
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
