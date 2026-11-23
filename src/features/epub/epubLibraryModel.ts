import type { EpubBookData, EpubBookmark, Tab, TabStats } from "../../utils/constants";
import type { EpubBookNote, EpubHighlight } from "./epubModel";

export type LibraryStatusFilter = "all" | "reading" | "unread" | "completed";
export type LibraryLangFilter = "all" | "ja" | "en";
export type LibraryGroupBy = "none" | "series" | "author";
export type LibraryBookSort = "recent" | "added" | "title" | "author" | "series" | "characters" | "progress";
export type LibraryGroupSort = "alpha" | "recent" | "progress" | "count";
export type SortDirection = "asc" | "desc";
export type CoverFitMode = "cover" | "contain";

export interface EpubLibraryPrefs {
    statusFilter: LibraryStatusFilter;
    langFilter: LibraryLangFilter;
    groupBy: LibraryGroupBy;
    sortBy: LibraryBookSort;
    sortDir: SortDirection;
    groupSortBy: LibraryGroupSort;
    groupSortDir: SortDirection;
    cardSize: number;
    coverFit: CoverFitMode;
    showAuthor: boolean;
    showSeries: boolean;
    showTags: boolean;
    showChars: boolean;
    showProgress: boolean;
    keepDataOnDelete: boolean;
}

export const DEFAULT_LIBRARY_PREFS: EpubLibraryPrefs = {
    statusFilter: "all",
    langFilter: "all",
    groupBy: "none",
    sortBy: "recent",
    sortDir: "desc",
    groupSortBy: "alpha",
    groupSortDir: "asc",
    cardSize: 176,
    coverFit: "cover",
    showAuthor: true,
    showSeries: false,
    showTags: true,
    showChars: false,
    showProgress: true,
    keepDataOnDelete: true,
};

const LIBRARY_PREFS_KEY = "setsuna-epub-library-prefs";
const RETAINED_DATA_KEY = "setsuna-epub-retained-data";

export interface RetainedBookRecord {
    title: string;
    savedAt: number;
    series?: string;
    seriesPosition?: number | null;
    tags?: string[];
    manualStatus?: "unread" | "reading" | "completed";
    coverBlurred?: boolean;
    bookmarks?: EpubBookmark[];
    highlights?: EpubHighlight[];
    notes?: EpubBookNote[];
    stats?: TabStats;
}

const JA_COLLATOR = new Intl.Collator("ja-JP", { numeric: true, sensitivity: "base" });
const EN_COLLATOR = new Intl.Collator("en", { numeric: true, sensitivity: "base" });

const KANJI_DIGITS: Record<string, number> = {
    "〇": 0, "零": 0,
    "一": 1, "壱": 1,
    "二": 2, "弐": 2,
    "三": 3, "参": 3,
    "四": 4,
    "五": 5,
    "六": 6,
    "七": 7,
    "八": 8,
    "九": 9,
};

/**
 * Parses a Japanese kanji numeral string (1..999) into an integer.
 * Examples: "一" -> 1, "十" -> 10, "十一" -> 11, "二十" -> 20, "百二十三" -> 123.
 */
export function parseKanjiNumeral(raw: string): number | null {
    const s = raw.trim();
    if (!s || !/^[〇零一壱二弐三参四五六七八九十百]+$/u.test(s)) return null;

    // Positional digits like "二〇" or single digit
    if (!s.includes("十") && !s.includes("百")) {
        if (s.length === 1) return KANJI_DIGITS[s] ?? null;
        let val = 0;
        for (const ch of s) {
            const d = KANJI_DIGITS[ch];
            if (d === undefined) return null;
            val = val * 10 + d;
        }
        return val > 0 && val <= 999 ? val : null;
    }

    let total = 0;
    let current = 0;
    for (const ch of s) {
        if (ch === "百") {
            total += (current === 0 ? 1 : current) * 100;
            current = 0;
        } else if (ch === "十") {
            total += (current === 0 ? 1 : current) * 10;
            current = 0;
        } else {
            const d = KANJI_DIGITS[ch];
            if (d === undefined) return null;
            current = d;
        }
    }
    total += current;
    return total > 0 && total <= 999 ? total : null;
}

const ROMAN_MAP: Record<string, number> = {
    I: 1, II: 2, III: 3, IV: 4, V: 5, VI: 6, VII: 7, VIII: 8, IX: 9, X: 10,
    XI: 11, XII: 12, XIII: 13, XIV: 14, XV: 15, XVI: 16, XVII: 17, XVIII: 18, XIX: 19, XX: 20,
    XXI: 21, XXII: 22, XXIII: 23, XXIV: 24, XXV: 25, XXX: 30,
};

export function parseRomanNumeral(raw: string): number | null {
    const upper = raw.normalize("NFKC").trim().toUpperCase();
    return ROMAN_MAP[upper] ?? null;
}

const PART_MARKER_MAP: Record<string, string> = {
    "上": "001",
    "中": "002",
    "下": "003",
    "前": "001",
    "後": "002",
};

/**
 * Builds a context-aware normalized sort key for book titles:
 * 1. NFKC normalization (`１` -> `1`, `Ⅰ` -> `I`, fullwidth spaces -> spaces).
 * 2. Converts Japanese volume numerals (`第一巻` -> `第1巻`, `第二十巻` -> `第20巻`, `三巻` -> `3巻`).
 * 3. Converts contextual part markers (`上`/`中`/`下`, `前`/`後` when delimited, parenthesized, or followed by `巻`/`編`)
 *    without touching ordinary kanji words like `中学` or `上下`.
 * 4. Converts standalone/delimited Roman numerals (`I`, `IV`, `IX`, `X`) to digits so `IV < V` and `IX < X`.
 * 5. Strips whitespace so inconsistent spaces (`生活 4` vs `生活3`) sort cleanly.
 */
export function buildTitleSortKey(rawTitle: string): string {
    let key = rawTitle.normalize("NFKC").trim();
    if (!key) return "";

    // 1. Japanese volume markers with kanji numerals: 第十巻, 第二十話, 三巻, 第十一
    key = key.replace(
        /(第)?([〇零一壱二弐三参四五六七八九十百]+)([巻話部章編集])/gu,
        (full, prefix: string | undefined, numStr: string, suffix: string) => {
            const n = parseKanjiNumeral(numStr);
            if (n === null) return full;
            return `${prefix || ""}${n}${suffix}`;
        },
    );
    key = key.replace(
        /第([〇零一壱二弐三参四五六七八九十百]+)(?=$|[\s\-–—:：・()（）\[\]【】])/gu,
        (full, numStr: string) => {
            const n = parseKanjiNumeral(numStr);
            return n === null ? full : `第${n}`;
        },
    );

    // 2. Part markers 上/中/下 and 前/後 ONLY in volume/part context:
    //    - "(上)", "【中】", "[下]", "上巻", "下編", or delimited/trailing " 上", "・中", " 下"
    key = key.replace(
        /([(\[【（])([上中下前後])([)\]】）])/gu,
        (_full, open: string, part: string, close: string) => `${open}${PART_MARKER_MAP[part]}${close}`,
    );
    key = key.replace(
        /(^|[\s\-–—:：・/])([上中下前後])([巻編部篇])(?=$|[\s\-–—:：・/(\[【（])/gu,
        (_full, sep: string, part: string, unit: string) => `${sep}${PART_MARKER_MAP[part]}${unit}`,
    );
    key = key.replace(
        /([\s\-–—:：・/])([上中下])(?=$|[\s\-–—:：・/(\[【（])/gu,
        (_full, sep: string, part: string) => `${sep}${PART_MARKER_MAP[part]}`,
    );

    // 3. Standalone/delimited Roman numerals (uppercase I..XXX) after space/delimiter or at end
    //    Avoids touching normal English words like "I" at the start of a sentence ("I Am a Cat")
    //    by requiring a preceding delimiter or volume prefix (Vol./Part/Book/#) or trailing position after text.
    key = key.replace(
        /((?:^|\s|[-–—:：・/(【\[])(?:(?:vol(?:ume)?|book|part|pt|act|chapter)\.?\s*)?)(X{1,3}(?:IX|IV|VI{0,3}|I{1,3})?|IX|IV|VI{0,3}|I{1,3})(?=$|[\s\-–—:：・/)】\]])/gu,
        (full, prefix: string, roman: string, offset: number) => {
            // Do not convert a leading "I " at the very start of an English title (e.g. "I Am a Cat")
            if (offset === 0 && roman === "I" && prefix === "") return full;
            const n = parseRomanNumeral(roman);
            if (n === null) return full;
            return `${prefix}${n}`;
        },
    );

    return key.replace(/\s+/g, "");
}

function containsJapaneseScript(text: string): boolean {
    return /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff]/u.test(text);
}

export function loadLibraryPrefs(): EpubLibraryPrefs {
    try {
        const raw = localStorage.getItem(LIBRARY_PREFS_KEY);
        if (!raw) return { ...DEFAULT_LIBRARY_PREFS };
        const parsed = JSON.parse(raw);
        return {
            ...DEFAULT_LIBRARY_PREFS,
            ...(parsed && typeof parsed === "object" ? parsed : {}),
            cardSize: Math.min(260, Math.max(130, Number(parsed?.cardSize) || DEFAULT_LIBRARY_PREFS.cardSize)),
        };
    } catch {
        return { ...DEFAULT_LIBRARY_PREFS };
    }
}

export function saveLibraryPrefs(prefs: EpubLibraryPrefs): void {
    try {
        localStorage.setItem(LIBRARY_PREFS_KEY, JSON.stringify(prefs));
    } catch {
        // Ignore storage errors
    }
}

export function normalizeTitleKey(title: string): string {
    return title.normalize("NFKC").replace(/\s+/g, "").toLowerCase();
}

export function compareNaturalStrings(a: string, b: string, locale = "ja"): number {
    const keyA = buildTitleSortKey(a);
    const keyB = buildTitleSortKey(b);
    const useJa = containsJapaneseScript(a) || containsJapaneseScript(b) || locale.startsWith("ja");
    const collator = useJa ? JA_COLLATOR : EN_COLLATOR;
    const cmp = collator.compare(keyA, keyB);
    if (cmp !== 0) return cmp;
    return collator.compare(a.normalize("NFKC"), b.normalize("NFKC"));
}

/**
 * Infers a series name from a book title by stripping trailing volume markers
 * (e.g. "Re：ゼロから始める異世界生活 1" -> "Re:ゼロから始める異世界生活",
 * "Mushoku Tensei Vol. 12" -> "Mushoku Tensei", "本好きの下剋上 第一巻" -> "本好きの下剋上").
 * Returns null if no clear volume marker is detected.
 */
export function inferBookSeries(rawTitle: string): string | null {
    const trimmed = rawTitle.trim();
    if (!trimmed) return null;
    const normalized = trimmed.normalize("NFKC");

    const patterns: RegExp[] = [
        // Japanese volume suffixes: 第一巻, 第3巻, 3巻, 上巻, (3), 【上】, [3]
        /\s*(?:第?\s*(?:\d+(?:\.\d+)?|[〇零一壱二弐三参四五六七八九十百]+)\s*[巻話部章編集]|[上中下前後][巻編部篇]|[（(【\[]\s*(?:第?(?:\d+(?:\.\d+)?|[〇零一壱二弐三参四五六七八九十百]+)|[上下中前後])\s*[）)】\]])\s*$/u,
        // English volume suffixes: Vol. 3, Volume IV, Book 3, Part 3, #3, - 3
        /\s*(?:(?:vol(?:ume)?|book|part|pt|ep(?:isode)?|ch(?:apter)?)\.?\s*(?:\d+(?:\.\d+)?|X{1,3}(?:IX|IV|VI{0,3}|I{1,3})?|IX|IV|VI{0,3}|I{1,3})|#\d+(?:\.\d+)?|[-–—:]\s*\d+(?:\.\d+)?)\s*$/iu,
        // Trailing delimited 上/中/下 or Roman numeral
        /[\s\-–—:：・/]+(?:[上中下]|X{1,3}(?:IX|IV|VI{0,3}|I{1,3})?|IX|IV|VI{0,3}|I{1,3})\s*$/u,
        // Trailing bare number (e.g. "Re:ゼロから始める異世界生活 1" or "Re:ゼロから始める異世界生活2")
        /(?:\s+|(?<=[^\d]))(\d{1,3}(?:\.\d+)?)\s*$/u,
    ];

    for (const pattern of patterns) {
        const match = normalized.match(pattern);
        if (!match) continue;
        const candidate = normalized.slice(0, match.index).replace(/[\s\-–—:：・/]+$/u, "").trim();
        if (candidate.length >= 2 && candidate.length < normalized.length) {
            return candidate;
        }
    }

    return null;
}

export function resolveBookSeries(book: Pick<Tab, "name" | "epub">, allBooks?: readonly Pick<Tab, "name" | "epub">[]): string {
    const explicit = book.epub?.series?.trim();
    if (explicit) return explicit;
    const title = book.epub?.title || book.name || "";
    const inferred = inferBookSeries(title);
    if (!inferred) return "";
    if (!allBooks) return inferred;
    const inferredKey = normalizeTitleKey(inferred);
    let matches = 0;
    for (const item of allBooks) {
        const itemExplicit = item.epub?.series?.trim();
        if (itemExplicit && normalizeTitleKey(itemExplicit) === inferredKey) {
            matches += 1;
        } else {
            const itemInferred = inferBookSeries(item.epub?.title || item.name || "");
            if (itemInferred && normalizeTitleKey(itemInferred) === inferredKey) {
                matches += 1;
            }
        }
        if (matches >= 2) return inferred;
    }
    return "";
}

export function resolveBookStatus(book: Pick<Tab, "epub">): "unread" | "reading" | "completed" {
    const manual = book.epub?.manualStatus;
    if (manual === "completed" || manual === "unread" || manual === "reading") {
        return manual;
    }
    const progress = book.epub?.progress || 0;
    if (progress >= 0.99) return "completed";
    if (
        progress > 0
        || (book.epub?.chapterIndex || 0) > 0
        || (book.epub?.chapterOffset || 0) > 0
    ) {
        return "reading";
    }
    return "unread";
}

function compareSeriesPosition(a: Tab, b: Tab): number {
    const posA = typeof a.epub?.seriesPosition === "number" && Number.isFinite(a.epub.seriesPosition)
        ? a.epub.seriesPosition
        : null;
    const posB = typeof b.epub?.seriesPosition === "number" && Number.isFinite(b.epub.seriesPosition)
        ? b.epub.seriesPosition
        : null;
    if (posA !== null && posB !== null) {
        if (posA !== posB) return posA - posB;
        return 0;
    }
    // Books with an explicit volume position sort before unpositioned entries
    if (posA !== null) return -1;
    if (posB !== null) return 1;
    return 0;
}

export function compareBooks(
    a: Tab,
    b: Tab,
    sortBy: LibraryBookSort,
    direction: SortDirection,
    locale: string,
    allBooks?: readonly Tab[],
    insideSeriesGroup = false,
): number {
    const titleA = a.epub?.title || a.name || "";
    const titleB = b.epub?.title || b.name || "";
    const tieBreak = () => {
        const t = compareNaturalStrings(titleA, titleB, locale);
        return t !== 0 ? t : (a.id - b.id);
    };
    const dirMul = direction === "asc" ? 1 : -1;

    // Inside a series group, explicit seriesPosition takes priority when sorting by title or series
    if (insideSeriesGroup && (sortBy === "title" || sortBy === "series")) {
        const posCmp = compareSeriesPosition(a, b);
        if (posCmp !== 0) return posCmp * dirMul;
    }

    switch (sortBy) {
        case "title":
            return tieBreak() * dirMul;
        case "added": {
            const addedA = a.epub?.addedAt || a.id;
            const addedB = b.epub?.addedAt || b.id;
            const diff = addedA - addedB;
            return diff !== 0 ? diff * dirMul : tieBreak();
        }
        case "author": {
            const authorA = a.epub?.author?.trim() || "";
            const authorB = b.epub?.author?.trim() || "";
            if (!authorA && authorB) return 1;
            if (authorA && !authorB) return -1;
            const cmp = compareNaturalStrings(authorA, authorB, locale);
            return cmp !== 0 ? cmp * dirMul : tieBreak();
        }
        case "series": {
            const seriesA = resolveBookSeries(a, allBooks);
            const seriesB = resolveBookSeries(b, allBooks);
            if (!seriesA && seriesB) return 1;
            if (seriesA && !seriesB) return -1;
            const cmp = compareNaturalStrings(seriesA, seriesB, locale);
            if (cmp !== 0) return cmp * dirMul;
            const posCmp = compareSeriesPosition(a, b);
            if (posCmp !== 0) return posCmp * dirMul;
            return tieBreak();
        }
        case "characters": {
            const charsA = a.epub?.totalChars || a.stats?.chars || 0;
            const charsB = b.epub?.totalChars || b.stats?.chars || 0;
            const diff = charsA - charsB;
            return diff !== 0 ? diff * dirMul : tieBreak();
        }
        case "progress": {
            const diff = (a.epub?.progress || 0) - (b.epub?.progress || 0);
            return diff !== 0 ? diff * dirMul : tieBreak();
        }
        case "recent":
        default: {
            const statusA = resolveBookStatus(a);
            const statusB = resolveBookStatus(b);
            const startedA = statusA !== "unread";
            const startedB = statusB !== "unread";
            if (startedA !== startedB) {
                return (startedA ? 1 : -1) * dirMul;
            }
            if (startedA && startedB) {
                const timeDiff = (a.epub?.lastOpenedAt || 0) - (b.epub?.lastOpenedAt || 0);
                if (timeDiff !== 0) return timeDiff * dirMul;
            }
            // For unopened books (or ties), respect series position first if in a series group, then natural title
            if (insideSeriesGroup) {
                const posCmp = compareSeriesPosition(a, b);
                if (posCmp !== 0) return posCmp;
            }
            return tieBreak();
        }
    }
}

export interface LibraryBookGroup {
    key: string;
    label: string;
    unassigned: boolean;
    books: Tab[];
    aggregateProgress: number;
    lastOpenedAt: number;
    totalChars: number;
}

export function buildLibraryGroups(
    books: readonly Tab[],
    allBooks: readonly Tab[],
    prefs: EpubLibraryPrefs,
    locale: string,
    labels: { noSeries: string; noAuthor: string },
): LibraryBookGroup[] {
    if (prefs.groupBy === "none") {
        return [];
    }

    const bucketMap = new Map<string, { label: string; unassigned: boolean; books: Tab[] }>();
    for (const book of books) {
        let rawLabel = "";
        if (prefs.groupBy === "series") {
            rawLabel = resolveBookSeries(book, allBooks);
        } else if (prefs.groupBy === "author") {
            rawLabel = book.epub?.author?.trim() || "";
        }
        const unassigned = !rawLabel;
        const key = unassigned ? "__unassigned__" : normalizeTitleKey(rawLabel);
        const label = unassigned
            ? (prefs.groupBy === "series" ? labels.noSeries : labels.noAuthor)
            : rawLabel;

        let bucket = bucketMap.get(key);
        if (!bucket) {
            bucket = { label, unassigned, books: [] };
            bucketMap.set(key, bucket);
        }
        bucket.books.push(book);
    }

    const groups: LibraryBookGroup[] = [];
    const isSeriesGrouping = prefs.groupBy === "series";
    for (const [key, bucket] of bucketMap.entries()) {
        const sortedBooks = [...bucket.books].sort((a, b) =>
            compareBooks(a, b, prefs.sortBy, prefs.sortDir, locale, allBooks, isSeriesGrouping && !bucket.unassigned),
        );
        let weightedChars = 0;
        let knownTotalChars = 0;
        let simpleProgressSum = 0;
        let lastOpenedAt = 0;

        for (const book of sortedBooks) {
            const p = Math.min(1, Math.max(0, book.epub?.progress || 0));
            const tc = book.epub?.totalChars || 0;
            if (tc > 0) {
                weightedChars += tc * p;
                knownTotalChars += tc;
            }
            simpleProgressSum += p;
            lastOpenedAt = Math.max(lastOpenedAt, book.epub?.lastOpenedAt || 0);
        }

        const aggregateProgress = knownTotalChars > 0
            ? weightedChars / knownTotalChars
            : (sortedBooks.length > 0 ? simpleProgressSum / sortedBooks.length : 0);

        groups.push({
            key,
            label: bucket.label,
            unassigned: bucket.unassigned,
            books: sortedBooks,
            aggregateProgress,
            lastOpenedAt,
            totalChars: knownTotalChars,
        });
    }

    const dirMul = prefs.groupSortDir === "asc" ? 1 : -1;
    groups.sort((a, b) => {
        if (a.unassigned !== b.unassigned) {
            return a.unassigned ? 1 : -1;
        }
        switch (prefs.groupSortBy) {
            case "recent": {
                const diff = a.lastOpenedAt - b.lastOpenedAt;
                return diff !== 0 ? diff * dirMul : compareNaturalStrings(a.label, b.label, locale);
            }
            case "progress": {
                const diff = a.aggregateProgress - b.aggregateProgress;
                return diff !== 0 ? diff * dirMul : compareNaturalStrings(a.label, b.label, locale);
            }
            case "count": {
                const diff = a.books.length - b.books.length;
                return diff !== 0 ? diff * dirMul : compareNaturalStrings(a.label, b.label, locale);
            }
            case "alpha":
            default:
                return compareNaturalStrings(a.label, b.label, locale) * dirMul;
        }
    });

    return groups;
}

export function saveRetainedBookData(book: Tab): void {
    if (!book.epub) return;
    const title = book.epub.title || book.name || "";
    const key = normalizeTitleKey(title);
    if (!key) return;
    try {
        const raw = localStorage.getItem(RETAINED_DATA_KEY);
        const map: Record<string, RetainedBookRecord> = raw ? JSON.parse(raw) : {};
        map[key] = {
            title,
            savedAt: Date.now(),
            series: book.epub.series,
            seriesPosition: book.epub.seriesPosition,
            tags: book.epub.tags,
            manualStatus: book.epub.manualStatus,
            coverBlurred: book.epub.coverBlurred,
            bookmarks: book.epub.bookmarks,
            highlights: book.epub.highlights,
            notes: book.epub.notes,
            stats: book.stats,
        };
        localStorage.setItem(RETAINED_DATA_KEY, JSON.stringify(map));
    } catch {
        // Ignore storage quota errors
    }
}

export function restoreRetainedBookData(title: string): Partial<{ epub: Partial<EpubBookData>; stats: TabStats }> | null {
    const key = normalizeTitleKey(title);
    if (!key) return null;
    try {
        const raw = localStorage.getItem(RETAINED_DATA_KEY);
        if (!raw) return null;
        const map: Record<string, RetainedBookRecord> = JSON.parse(raw);
        const found = map[key];
        if (!found) return null;
        return {
            epub: {
                series: found.series,
                seriesPosition: found.seriesPosition,
                tags: found.tags,
                manualStatus: found.manualStatus,
                coverBlurred: found.coverBlurred,
                bookmarks: found.bookmarks,
                highlights: found.highlights,
                notes: found.notes,
            },
            stats: found.stats,
        };
    } catch {
        return null;
    }
}
