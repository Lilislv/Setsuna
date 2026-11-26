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

export function fitMangaPage(
    width: number, height: number, viewportWidth: number, viewportHeight: number,
    mode: MangaFitMode, twoUp: boolean, zoom: number,
): { width: number; height: number } {
    // The viewport's content box excludes padding. Adjacent pages share an 8px gap.
    const available = Math.max(1, twoUp ? (viewportWidth - 8) / 2 : viewportWidth);
    let scale = 1;
    if (mode === "width") scale = Math.min(available, twoUp ? 560 : 920) / width;
    if (mode === "height") scale = Math.min(available / width, Math.max(1, viewportHeight) / height);
    return { width: width * scale * zoom, height: height * scale * zoom };
}
export type MangaOverlayMode = "hover" | "outline" | "readable";
export type MangaCropMode = "bubble" | "full";
export type MangaBgTheme = "dark" | "black" | "gray" | "paper";

export interface MangaReaderPrefs {
    spreadMode: MangaSpreadMode;
    rtl: boolean;
    coverOffset: boolean;
    fitMode: MangaFitMode;
    overlayMode: MangaOverlayMode;
    cropMode: MangaCropMode;
    fontScale: number;
    dimBackground: boolean;
    bgTheme: MangaBgTheme;
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
    bgTheme: "dark",
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

export interface BubbleDisplayLine {
    text: string;
    offset: number;
    appendSpace: boolean;
}

/**
 * Split `.mokuro` OCR lines into display lines while preserving exact code-point
 * offsets into `joinMokuroLines(lines)` so word lookup spans line breaks cleanly.
 */
export function prepareBubbleDisplayLines(lines: string[]): BubbleDisplayLine[] {
    const cleaned = lines
        .map((line) => line.replace(/\r?\n/g, "").trim())
        .filter((line) => line.length > 0);
    if (cleaned.length === 0) return [];
    const out: BubbleDisplayLine[] = [];
    let offset = 0;
    for (let i = 0; i < cleaned.length; i += 1) {
        const cur = cleaned[i];
        const next = cleaned[i + 1];
        const curLast = cur[cur.length - 1] || "";
        const nextFirst = next ? next[0] || "" : "";
        const appendSpace = Boolean(next && !CJK_RE.test(curLast) && !CJK_RE.test(nextFirst));
        out.push({ text: cur, offset, appendSpace });
        offset += Array.from(cur).length + (appendSpace ? 1 : 0);
    }
    return out;
}

export interface PlacedBubbleLine extends BubbleDisplayLine {
    /** Line box relative to the block box, in percent of the block box size. */
    left: number;
    top: number;
    width: number;
    height: number;
    /** Font size in source-image pixels. */
    fontPx: number;
}

/**
 * Place every OCR line exactly where Mokuro found it (`linesCoords`), so the overlay
 * columns sit on top of the printed text instead of being re-flowed and centred in
 * the block box. Returns null when the coordinates do not match the lines (old
 * files, edited text with a different line count, manual crop OCR).
 */
export function placeBubbleLines(
    block: Pick<MokuroBlock, "box" | "vertical" | "lines" | "linesCoords">,
): PlacedBubbleLine[] | null {
    const raw = block.lines || [];
    const coords = block.linesCoords;
    if (!coords || coords.length !== raw.length || raw.length === 0) return null;
    const display = prepareBubbleDisplayLines(raw);
    const rawIndices = raw
        .map((line, idx) => (line.replace(/\r?\n/g, "").trim() ? idx : -1))
        .filter((idx) => idx >= 0);
    if (rawIndices.length !== display.length || display.length === 0) return null;
    const [bx1, by1, bx2, by2] = block.box;
    const bw = Math.max(1, bx2 - bx1);
    const bh = Math.max(1, by2 - by1);
    const out: PlacedBubbleLine[] = [];
    for (let i = 0; i < display.length; i += 1) {
        const poly = coords[rawIndices[i]];
        if (!Array.isArray(poly)) return null;
        let minX = Infinity;
        let minY = Infinity;
        let maxX = -Infinity;
        let maxY = -Infinity;
        for (const pt of poly) {
            if (!Array.isArray(pt) || !Number.isFinite(pt[0]) || !Number.isFinite(pt[1])) continue;
            minX = Math.min(minX, pt[0]);
            maxX = Math.max(maxX, pt[0]);
            minY = Math.min(minY, pt[1]);
            maxY = Math.max(maxY, pt[1]);
        }
        const w = maxX - minX;
        const h = maxY - minY;
        if (!(w > 0) || !(h > 0)) return null;
        const chars = Math.max(1, Array.from(display[i].text).length);
        const along = block.vertical ? h : w;
        const across = block.vertical ? w : h;
        out.push({
            ...display[i],
            left: ((minX - bx1) / bw) * 100,
            top: ((minY - by1) / bh) * 100,
            width: (w / bw) * 100,
            height: (h / bh) * 100,
            fontPx: Math.max(4, Math.min(across * 0.92, along / chars)),
        });
    }
    return out;
}

/**
 * Font size (in source-image pixels) that guarantees the bubble text fits the
 * OCR box without clipping, including long unwrapped single-line text in large boxes.
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
    const byLength = (along / maxChars) * 0.88;
    const byLines = across / (numLines * LINE_HEIGHT);
    const ocrSize = block.fontSize > 0 ? block.fontSize : byLength;
    const singleRun = Math.min(ocrSize, byLength, byLines);
    if (numLines === 1 && byLength < ocrSize * 0.7 && across >= singleRun * 3) {
        let best = singleRun;
        for (let fs = ocrSize; fs >= singleRun; fs -= 0.5) {
            const charsPerRun = Math.max(1, Math.floor((along * 0.9) / fs));
            const neededRuns = Math.ceil(maxChars / charsPerRun);
            if (neededRuns * fs * 1.25 <= across * 0.92) {
                best = fs;
                break;
            }
        }
        return Math.max(4, best);
    }
    return Math.max(4, singleRun);
}

/**
 * Compute proportional CSS line-height so compact speech bubbles stay tight while
 * spacious multi-line blurbs fill their box vertically/horizontally.
 */
export function computeBubbleLineHeight(
    block: Pick<MokuroBlock, "box" | "vertical" | "lines">,
    fittedPx: number,
): number {
    const [x1, y1, x2, y2] = block.box;
    const across = block.vertical ? Math.max(1, x2 - x1) : Math.max(1, y2 - y1);
    const lines = (block.lines || []).map((l) => l.replace(/\r?\n/g, "").trim()).filter(Boolean);
    const numLines = Math.max(1, lines.length);
    if (numLines <= 1 || fittedPx <= 0) return 1.28;
    const pitch = across / (numLines * fittedPx);
    return Number(Math.max(1.2, Math.min(1.75, pitch * 0.9)).toFixed(2));
}

/**
 * Detect visual paragraph breaks between adjacent OCR lines using Mokuro `linesCoords`.
 */
export function detectBubbleParagraphGaps(
    block: Pick<MokuroBlock, "vertical" | "lines" | "linesCoords">,
): boolean[] {
    const rawLines = block.lines || [];
    const cleanIndices: number[] = [];
    rawLines.forEach((line, idx) => {
        if (line.replace(/\r?\n/g, "").trim().length > 0) cleanIndices.push(idx);
    });
    const out = new Array<boolean>(cleanIndices.length).fill(false);
    if (
        !block.linesCoords
        || block.linesCoords.length !== rawLines.length
        || cleanIndices.length < 3
    ) {
        return out;
    }

    const axis = block.vertical ? 0 : 1;
    const centers: Array<number | null> = cleanIndices.map((rawIdx) => {
        const poly = block.linesCoords?.[rawIdx];
        if (!Array.isArray(poly) || poly.length === 0) return null;
        let sum = 0;
        let count = 0;
        for (const pt of poly) {
            if (Array.isArray(pt) && typeof pt[axis] === "number" && Number.isFinite(pt[axis])) {
                sum += pt[axis];
                count += 1;
            }
        }
        return count > 0 ? sum / count : null;
    });

    const deltas: Array<number | null> = new Array(cleanIndices.length).fill(null);
    const positives: number[] = [];
    for (let i = 1; i < centers.length; i += 1) {
        const a = centers[i - 1];
        const b = centers[i];
        if (a !== null && b !== null) {
            const d = Math.abs(b - a);
            deltas[i] = d;
            if (d > 0) positives.push(d);
        }
    }
    if (positives.length < 2) return out;
    const sorted = [...positives].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    if (median <= 0) return out;
    for (let i = 1; i < deltas.length; i += 1) {
        const d = deltas[i];
        if (d !== null && d > median * 1.38) {
            out[i] = true;
        }
    }
    return out;
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

export type MangaMobileOcrEngine = "auto" | "remote" | "onnx" | "mlkit";

export interface MangaOcrPrefs {
    mobileEngine: MangaMobileOcrEngine;
    remoteUrl: string;
    remoteToken: string;
    pcServerEnabled: boolean;
    pcServerPort: number;
    pcServerToken: string;
    autoRefineMlKitWithOnnx: boolean;
}

export const DEFAULT_MANGA_OCR_PREFS: MangaOcrPrefs = {
    mobileEngine: "auto",
    remoteUrl: "",
    remoteToken: "",
    pcServerEnabled: false,
    pcServerPort: 47123,
    pcServerToken: "",
    autoRefineMlKitWithOnnx: true,
};

const MANGA_OCR_PREFS_KEY = "setsuna-manga-ocr-prefs-v1";

export function loadMangaOcrPrefs(): MangaOcrPrefs {
    try {
        if (typeof localStorage === "undefined") return { ...DEFAULT_MANGA_OCR_PREFS };
        const raw = localStorage.getItem(MANGA_OCR_PREFS_KEY);
        if (!raw) return { ...DEFAULT_MANGA_OCR_PREFS };
        const parsed = JSON.parse(raw) as Partial<MangaOcrPrefs>;
        return {
            ...DEFAULT_MANGA_OCR_PREFS,
            ...parsed,
            pcServerPort: typeof parsed.pcServerPort === "number" && parsed.pcServerPort > 0 && parsed.pcServerPort <= 65535
                ? Math.round(parsed.pcServerPort)
                : DEFAULT_MANGA_OCR_PREFS.pcServerPort,
        };
    } catch {
        return { ...DEFAULT_MANGA_OCR_PREFS };
    }
}

export function saveMangaOcrPrefs(prefs: MangaOcrPrefs): void {
    try {
        if (typeof localStorage === "undefined") return;
        localStorage.setItem(MANGA_OCR_PREFS_KEY, JSON.stringify(prefs));
    } catch {
        // Ignore quota errors
    }
}

/** Normalize user-entered LAN OCR URL (e.g. "192.168.1.42:47123/" -> "http://192.168.1.42:47123"). */
export function normalizeOcrServerUrl(raw: string): string {
    const trimmed = raw.trim().replace(/\/+$/, "");
    if (!trimmed) return "";
    if (/^https?:\/\//i.test(trimmed)) return trimmed;
    return `http://${trimmed}`;
}

/** Ordered list of mobile OCR engines to try given current user preference and ONNX readiness. */
export function resolveMobileOcrChain(
    prefs: Pick<MangaOcrPrefs, "mobileEngine" | "remoteUrl">,
    onnxReady: boolean,
): Array<"remote" | "onnx" | "mlkit"> {
    const hasRemote = normalizeOcrServerUrl(prefs.remoteUrl).length > 0;
    if (prefs.mobileEngine === "remote") return ["remote"];
    if (prefs.mobileEngine === "onnx") return ["onnx"];
    if (prefs.mobileEngine === "mlkit") return ["mlkit"];

    const chain: Array<"remote" | "onnx" | "mlkit"> = [];
    if (hasRemote) chain.push("remote");
    if (onnxReady) chain.push("onnx");
    chain.push("mlkit");
    return chain;
}

const JUNK_MANGA_RE = /^(?:setsuna-mokuro-[a-f0-9]+|book[_ ]\d{4,}|dlraw|rawkuma|klmanga|nyaa|manga-extracted|manga-mokuro|books|volume|[a-f0-9]{16,})$/i;
const BARE_VOLUME_RE = /^(?:vol(?:ume)?\.?|v|part|chap(?:ter)?|том|第)?[\s.#_-]*\d+(?:\.\d+)?[巻話]?$/i;
const PACK_RANGE_RE = /\s+(?:(?:vol(?:ume)?\.?|v|part|том)\s*)?\d+\s*[-~～]\s*\d+\s*巻?$/i;

export function needsMangaTitleCleanup(value?: string | null): boolean {
    if (!value) return false;
    const t = value.trim();
    if (!t) return false;
    return (
        /setsuna-mokuro-[a-f0-9]+/i.test(t)
        || /^[a-z0-9-]+\.(?:net|org|com|to|moe|cc|io|ru|jp|me|xyz)[_\s-]/i.test(t)
        || /—/.test(t)
        || /_[a-zA-Z0-9\u3040-\u30ff\u4e00-\u9fff]/.test(t)
        || /-[a-f0-9]{8}$/i.test(t)
        || PACK_RANGE_RE.test(t)
        || JUNK_MANGA_RE.test(t)
    );
}

function cleanSingleLabel(raw: string): string {
    let s = raw.trim().replace(/_/g, " ");
    for (let i = 0; i < 4; i += 1) {
        const noDomain = s.replace(/^[a-z0-9-]+\.(?:net|org|com|to|moe|cc|io|ru|jp|me|xyz)[\s._-]+/i, "").trim();
        if (noDomain && noDomain !== s) {
            s = noDomain;
            continue;
        }
        const noBracket = s
            .replace(/^(?:\[[^\]]+\]|【[^】]+】)[\s._-]+/, "")
            .replace(/[\s._-]+(?:\([^)]+\)|\[[^\]]+\])$/, "")
            .trim();
        if (noBracket && noBracket !== s) {
            s = noBracket;
            continue;
        }
        break;
    }
    s = s.replace(/-[a-f0-9]{8}$/i, "").trim();
    return s.replace(/\s+/g, " ");
}

export function cleanMangaSeries(rawSeries?: string | null): string | undefined {
    if (!rawSeries) return undefined;
    const trimmed = rawSeries.trim();
    if (!trimmed || JUNK_MANGA_RE.test(trimmed)) return undefined;
    const cleaned = cleanSingleLabel(trimmed).replace(PACK_RANGE_RE, "").trim();
    if (!cleaned || JUNK_MANGA_RE.test(cleaned)) return undefined;
    return cleaned;
}

export function cleanMangaTitle(rawTitle: string, filePath?: string): string {
    const trimmed = rawTitle.trim();
    if (trimmed.includes("—")) {
        const parts = trimmed.split(/\s*—\s*/);
        const left = cleanMangaSeries(parts[0]);
        const right = cleanSingleLabel(parts.slice(1).join(" — "));
        if (right && !JUNK_MANGA_RE.test(right)) {
            if (BARE_VOLUME_RE.test(right) && left) return `${left} ${right}`;
            return right;
        }
        if (left) return left;
    }
    if (!trimmed || JUNK_MANGA_RE.test(trimmed)) {
        if (filePath) {
            const stem = filePath.split(/[\\/]/).pop()?.replace(/\.(cbz|zip|rar|cbr|7z|cb7|mokuro(?:\.gz)?)$/i, "") || "";
            const fromFile = cleanSingleLabel(stem);
            if (fromFile && !JUNK_MANGA_RE.test(fromFile)) return fromFile;
        }
        return "Manga";
    }
    const single = cleanSingleLabel(trimmed);
    return JUNK_MANGA_RE.test(single) ? "Manga" : single;
}

/** Infer a clean catalog search query (title without volume number) from folder, filename, or series. */
export function inferBookCatalogQuery(book: {
    title?: string | null;
    series?: string | null;
    path?: string | null;
}): string {
    const stripTrailingVol = (value: string) => {
        let s = value.normalize("NFKC").trim();
        for (let i = 0; i < 4; i += 1) {
            const next = s
                .replace(/\s*(?:【[^】]+】|\[[^\]]+\]|特装版|限定版|\((?:特装版|限定版|コミック|[^)]*(?:コミックス|文庫)[^)]*)\))\s*$/u, "")
                .replace(/\s*\(\s*\d+(?:\.\d+)?\s*\)\s*$/, "")
                .replace(/\s*:\s*\d+(?:\.\d+)?\s*$/, "")
                .replace(PACK_RANGE_RE, "")
                .replace(/\s+(?:(?:vol(?:ume)?\.?|v|part|том|第)[\s.#_-]*)?\d+(?:\.\d+)?[巻話]?$/i, "")
                .replace(/([\u3000-\u9fff])\d+(?:\.\d+)?[巻話]?$/i, "$1")
                .trim();
            if (next === s) break;
            s = next;
        }
        return s;
    };

    const fromSeries = cleanMangaSeries(book.series);
    if (fromSeries) {
        const stripped = stripTrailingVol(fromSeries);
        if (stripped && !JUNK_MANGA_RE.test(stripped)) return stripped;
    }

    if (book.title) {
        const cleaned = cleanMangaTitle(book.title, book.path ?? undefined);
        const stripped = stripTrailingVol(cleaned);
        if (stripped && stripped !== "Manga" && !JUNK_MANGA_RE.test(stripped)) {
            return stripped;
        }
    }

    if (book.path) {
        const parts = book.path.split(/[\\/]/).filter(Boolean);
        const fileStem = (parts[parts.length - 1] || "").replace(
            /\.(epub|fb2(?:\.zip)?|pdf|docx|mobi|azw3|htmlz?|md|txt|cbz|zip|rar|cbr|7z|cb7|mokuro(?:\.gz)?)$/i,
            "",
        );
        const fromFile = stripTrailingVol(cleanSingleLabel(fileStem));
        if (fromFile && !JUNK_MANGA_RE.test(fromFile)) return fromFile;
        for (let i = parts.length - 2; i >= 0; i -= 1) {
            const parent = cleanMangaSeries(parts[i]);
            if (parent) return parent;
        }
    }

    return "";
}

/** Extract a volume number from a string such as `DLraw.net_Houseki no Kuni v02` or `宝石の国(02)`. */
export function extractVolumeNumberFromText(raw?: string | null): number | null {
    if (!raw) return null;
    const normalized = raw.normalize("NFKC").trim();
    if (!normalized || JUNK_MANGA_RE.test(normalized)) return null;
    const stem = normalized
        .replace(/\.(epub|fb2(?:\.zip)?|pdf|docx|mobi|azw3|htmlz?|md|txt|cbz|zip|rar|cbr|7z|cb7|mokuro(?:\.gz)?)$/i, "")
        .replace(/-[a-f0-9]{8}$/i, "")
        .trim();
    const cleaned = cleanSingleLabel(stem);
    if (!cleaned || JUNK_MANGA_RE.test(cleaned)) return null;
    const strippedPack = cleaned.replace(PACK_RANGE_RE, "").trim();

    // Explicit volume marker anywhere near the end (`v02`, `vol. 12`, `第2巻`, `(02)`)
    const explicit = strippedPack.match(
        /(?:(?:vol(?:ume)?\.?|v|том|第)[\s.#_-]*(\d+(?:\.\d+)?)\s*[巻]?|\((\d+(?:\.\d+)?)\))(?:\s|$)/i,
    );
    const trailingAttachedJa = strippedPack.match(/[\u3000-\u9fff](\d+(?:\.\d+)?)\s*[巻]?$/)?.[1];
    const rawCandidate =
        explicit?.[1]
        || explicit?.[2]
        || strippedPack.match(/(?:^|[\s._-])(\d+(?:\.\d+)?)\s*[巻]?$/)?.[1]
        || trailingAttachedJa;
    if (!rawCandidate) return null;
    const parsed = Number(rawCandidate);
    if (!Number.isFinite(parsed) || parsed <= 0 || parsed >= 1000) return null;
    return parsed;
}

/** Extract a volume number across a book's explicit position, title, tab name, or stored path. */
export function extractVolumeNumberFromBook(book: {
    title?: string | null;
    name?: string | null;
    seriesPosition?: number | null;
    path?: string | null;
}): number | null {
    if (typeof book.seriesPosition === "number" && Number.isFinite(book.seriesPosition) && book.seriesPosition > 0) {
        return book.seriesPosition;
    }
    const fromTitle = extractVolumeNumberFromText(book.title);
    if (fromTitle !== null) return fromTitle;
    const fromName = extractVolumeNumberFromText(book.name);
    if (fromName !== null) return fromName;
    if (book.path) {
        const parts = book.path.split(/[\\/]/).filter(Boolean);
        for (let i = parts.length - 1; i >= 0; i -= 1) {
            const found = extractVolumeNumberFromText(parts[i]);
            if (found !== null) return found;
        }
    }
    return null;
}

/** Format a volume's display title using the chosen series name while keeping its volume number. */
export function formatVolumeTitleWithSeries(
    seriesTitle: string,
    currentTitle: string,
    seriesPosition?: number | null,
    filePath?: string | null,
): string {
    const cleanSeries = seriesTitle.trim();
    if (!cleanSeries) return currentTitle;

    const volNum = extractVolumeNumberFromBook({
        title: currentTitle,
        seriesPosition,
        path: filePath,
    });
    if (volNum === null) return cleanSeries;
    const label = Number.isInteger(volNum) && volNum < 10 ? `0${volNum}` : String(volNum);
    return `${cleanSeries} ${label}`;
}
