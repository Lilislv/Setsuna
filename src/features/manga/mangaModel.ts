export interface MokuroBlock {
    /** Bounding box `[xmin, ymin, xmax, ymax]` in source image pixels. */
    box: [number, number, number, number];
    vertical: boolean;
    fontSize: number;
    lines: string[];
    linesCoords?: number[][][];
}

export interface MangaPageInfo {
    index: number;
    name: string;
    width: number;
    height: number;
    charCount: number;
    blockCount: number;
}

export interface MangaMeta {
    title: string;
    volume?: string | null;
    series?: string | null;
    seriesPosition?: number | null;
    pageCount: number;
    hasMokuro: boolean;
    mokuroPath?: string | null;
    sourceKind: "folder" | "cbz";
    totalChars: number;
    cover?: string | null;
    pages: MangaPageInfo[];
}

export interface MangaPagePayload {
    index: number;
    name: string;
    /** `asset://` URL on desktop folders or `data:image/...;base64,...` for archives/mobile. */
    imageSrc: string;
    width: number;
    height: number;
    blocks: MokuroBlock[];
}

export interface MangaMokuroStatus {
    available: boolean;
    command: string | null;
    version: string | null;
}

export type MangaSpreadMode = "single" | "spread" | "webtoon";
export type MangaFitMode = "height" | "width" | "original";
export type MangaOverlayMode = "hover" | "outline" | "readable";
export type MangaCropMode = "bubble" | "full";

export interface MangaReaderPrefs {
    spreadMode: MangaSpreadMode;
    rtl: boolean;
    coverOffset: boolean;
    fitMode: MangaFitMode;
    overlayMode: MangaOverlayMode;
    cropMode: MangaCropMode;
    fontScale: number;
    dimBackground: boolean;
}

export const DEFAULT_MANGA_PREFS: MangaReaderPrefs = {
    spreadMode: "single",
    rtl: true,
    coverOffset: true,
    fitMode: "height",
    overlayMode: "hover",
    cropMode: "bubble",
    fontScale: 1,
    dimBackground: false,
};

const MANGA_PREFS_KEY = "setsuna-manga-prefs-v1";
const CJK_RE = /[\u3000-\u30ff\u3400-\u9fff\uff00-\uffef]/;

export function loadMangaPrefs(): MangaReaderPrefs {
    try {
        if (typeof localStorage === "undefined") return { ...DEFAULT_MANGA_PREFS };
        const raw = localStorage.getItem(MANGA_PREFS_KEY);
        if (!raw) return { ...DEFAULT_MANGA_PREFS };
        const parsed = JSON.parse(raw) as Partial<MangaReaderPrefs>;
        return {
            ...DEFAULT_MANGA_PREFS,
            ...parsed,
            fontScale: typeof parsed.fontScale === "number"
                ? Math.max(0.7, Math.min(1.8, parsed.fontScale))
                : DEFAULT_MANGA_PREFS.fontScale,
        };
    } catch {
        return { ...DEFAULT_MANGA_PREFS };
    }
}

export function saveMangaPrefs(prefs: MangaReaderPrefs): void {
    try {
        if (typeof localStorage === "undefined") return;
        localStorage.setItem(MANGA_PREFS_KEY, JSON.stringify(prefs));
    } catch {
        // Ignore quota errors
    }
}

export function isMangaFileExtension(ext?: string | null): boolean {
    if (!ext) return false;
    const clean = ext.toLowerCase().replace(/^\./, "");
    return clean === "cbz" || clean === "zip" || clean === "mokuro" || clean === "manga-dir";
}

export function isMangaTabData(epub?: { format?: string; fileExt?: string } | null): boolean {
    if (!epub) return false;
    return epub.format === "manga" || isMangaFileExtension(epub.fileExt);
}

/**
 * Join `.mokuro` OCR lines into a clean lookupable sentence:
 * - No artificial spaces between Japanese/CJK lines
 * - Single space between Latin/English lines
 */
export function joinMokuroLines(lines: string[]): string {
    const cleaned = lines
        .map((line) => line.replace(/\r?\n/g, "").trim())
        .filter((line) => line.length > 0);
    if (cleaned.length === 0) return "";
    let out = cleaned[0];
    for (let i = 1; i < cleaned.length; i += 1) {
        const prevChar = out[out.length - 1] || "";
        const nextChar = cleaned[i][0] || "";
        const needsSpace = !CJK_RE.test(prevChar) && !CJK_RE.test(nextChar);
        out += (needsSpace ? " " : "") + cleaned[i];
    }
    return out;
}

/**
 * Font size (in source-image pixels) that guarantees the joined bubble text fits the
 * OCR box without clipping. Vertical: every original line fits one column (box height)
 * and all columns fit the box width; horizontal is the transposed case. Because the
 * longest line fits a single run, greedy wrapping of the joined text never needs more
 * runs than the original line count.
 */
export function computeFittedBubbleFontPx(block: Pick<MokuroBlock, "box" | "vertical" | "fontSize" | "lines">): number {
    const [x1, y1, x2, y2] = block.box;
    const boxW = Math.max(1, x2 - x1);
    const boxH = Math.max(1, y2 - y1);
    const lines = (block.lines || []).map((l) => l.replace(/\r?\n/g, "").trim()).filter(Boolean);
    const numLines = Math.max(1, lines.length);
    const maxChars = Math.max(1, ...lines.map((l) => Array.from(l).length));
    const along = block.vertical ? boxH : boxW;
    const across = block.vertical ? boxW : boxH;
    const LINE_HEIGHT = 1.15;
    const byLength = (along / maxChars) * 0.9;
    const byLines = across / (numLines * LINE_HEIGHT);
    const ocrSize = block.fontSize > 0 ? block.fontSize : byLength;
    return Math.max(4, Math.min(ocrSize, byLength, byLines));
}

export function countMangaBlocksChars(blocks: MokuroBlock[]): number {
    let total = 0;
    for (const block of blocks) {
        const joined = joinMokuroLines(block.lines || []);
        for (const ch of joined) {
            if (!/\s/.test(ch)) total += 1;
        }
    }
    return total;
}

/**
 * Group page indices into display spreads.
 * In `spread` mode with `coverOffset = true`: `[0], [1, 2], [3, 4], ...`
 * In `spread` mode with `coverOffset = false`: `[0, 1], [2, 3], ...`
 * Each pair is returned in logical reading order `[firstPage, secondPage]`;
 * the renderer places `firstPage` on the RIGHT when `rtl === true`.
 */
export function buildSpreadPairs(
    pageCount: number,
    spreadMode: MangaSpreadMode,
    coverOffset: boolean,
): number[][] {
    const count = Math.max(0, Math.floor(pageCount));
    if (count === 0) return [];
    if (spreadMode !== "spread") {
        return Array.from({ length: count }, (_, i) => [i]);
    }
    const pairs: number[][] = [];
    let i = 0;
    if (coverOffset) {
        pairs.push([0]);
        i = 1;
    }
    while (i < count) {
        if (i + 1 < count) {
            pairs.push([i, i + 1]);
            i += 2;
        } else {
            pairs.push([i]);
            i += 1;
        }
    }
    return pairs;
}

export function findSpreadIndexForPage(pairs: number[][], pageIndex: number): number {
    if (pairs.length === 0) return 0;
    const clamped = Math.max(0, pageIndex);
    const idx = pairs.findIndex((pair) => pair.includes(clamped));
    return idx >= 0 ? idx : pairs.length - 1;
}

export interface CropRect {
    x: number;
    y: number;
    width: number;
    height: number;
}

/**
 * Compute a context-rich crop rectangle around a speech bubble for Anki cards.
 * Expands the bubble box into an approximate panel window (at least 42% of page width
 * and 30% of page height) while clamping cleanly inside `[0..imgWidth, 0..imgHeight]`.
 */
export function computeBubbleCropRect(
    box: [number, number, number, number],
    imgWidth: number,
    imgHeight: number,
): CropRect {
    const w = Math.max(1, imgWidth);
    const h = Math.max(1, imgHeight);
    const x1 = Math.max(0, Math.min(w, box[0]));
    const y1 = Math.max(0, Math.min(h, box[1]));
    const x2 = Math.max(x1, Math.min(w, box[2]));
    const y2 = Math.max(y1, Math.min(h, box[3]));

    const bw = Math.max(16, x2 - x1);
    const bh = Math.max(16, y2 - y1);
    const cx = (x1 + x2) / 2;
    const cy = (y1 + y2) / 2;

    const targetW = Math.min(w, Math.max(bw * 3.0, w * 0.56));
    const targetH = Math.min(h, Math.max(bh * 2.1, h * 0.36));

    const left = Math.max(0, Math.min(w - targetW, Math.round(cx - targetW / 2)));
    const top = Math.max(0, Math.min(h - targetH, Math.round(cy - targetH / 2)));

    return {
        x: left,
        y: top,
        width: Math.max(1, Math.round(Math.min(targetW, w - left))),
        height: Math.max(1, Math.round(Math.min(targetH, h - top))),
    };
}

export function applyBlockTextOverrides(
    blocks: MokuroBlock[],
    overrides: Record<number, string> | undefined,
): MokuroBlock[] {
    if (!overrides) return blocks;
    return blocks.map((block, idx) => {
        const edited = overrides[idx];
        if (typeof edited !== "string") return block;
        const lines = edited.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
        return {
            ...block,
            lines: lines.length > 0 ? lines : [edited],
        };
    });
}
