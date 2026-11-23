export type EpubLanguage = "ja" | "en";
export type EpubOrientationSetting = "auto" | "horizontal" | "vertical";
export type EpubResolvedOrientation = "horizontal" | "vertical";

export interface EpubChapterMeta {
    index: number;
    id: string;
    href: string;
    title: string | null;
    charCount?: number;
}

export interface EpubTocItem {
    title: string;
    chapterIndex: number;
    fragment?: string | null;
    startChar: number;
}

export interface EpubBookMeta {
    title: string;
    author: string | null;
    series?: string | null;
    seriesPosition?: number | null;
    language: EpubLanguage;
    metadataLanguage: string | null;
    pageProgressionDirection: string | null;
    primaryWritingMode: string | null;
    cssWritingMode: string | null;
    defaultVertical: boolean;
    chapters: EpubChapterMeta[];
    toc?: EpubTocItem[];
    cover: string | null;
    totalChars?: number;
}

export interface EpubGalleryImage {
    chapterIndex: number;
    chapterTitle: string | null;
    paragraphIndex: number;
    src: string;
    alt: string | null;
}

export type EpubHighlightColor = "amber" | "emerald" | "sky" | "rose";
export type EpubFuriganaMode = "show" | "hover" | "hide";
export type EpubBlurImagesMode = "off" | "after-toc" | "all";
export type EpubTextIndentMode = "auto" | "none" | "indent";

export interface EpubHighlight {
    id: string;
    chapterIndex: number;
    chapterTitle?: string;
    paragraphIndex: number;
    text: string;
    color: EpubHighlightColor;
    note?: string;
    createdAt: number;
}

export interface EpubBookNote {
    id: string;
    title: string;
    body: string;
    chapterIndex?: number;
    chapterTitle?: string;
    paragraphIndex?: number;
    createdAt: number;
    updatedAt: number;
}

export interface EpubReadingPoint {
    chapterIndex: number;
    paragraphIndex: number;
    chapterTitle?: string;
    excerpt?: string;
    savedAt: number;
}

export interface EpubSearchHit {
    chapterIndex: number;
    chapterTitle: string | null;
    paragraphIndex: number;
    snippet: string;
}

export const SUPPORTED_BOOK_EXTENSIONS = ["epub", "txt", "htmlz"] as const;

export function isSupportedBookPath(filePath: string): boolean {
    const clean = filePath.trim().toLowerCase();
    return SUPPORTED_BOOK_EXTENSIONS.some((ext) => clean.endsWith(`.${ext}`));
}

export type EpubParagraphKind =
    | "paragraph"
    | "heading"
    | "image"
    | "blockquote"
    | "list-item"
    | "separator";

export interface EpubParagraph {
    index: number;
    id: string | null;
    anchorIds: string[];
    kind: EpubParagraphKind;
    html: string;
    text: string;
    imageSrc: string | null;
    imageAlt: string | null;
}

export interface EpubChapterContent {
    index: number;
    id: string;
    href: string;
    title: string | null;
    html: string;
    text: string;
    paragraphs: EpubParagraph[];
}

export interface CountedPosition {
    chapterIndex: number;
    paragraphIndex: number;
}

const LANGUAGE_SAMPLE_CHARS = 5000;

/**
 * Parses an OPF `<dc:language>` tag into `"ja"` or `"en"` when recognized.
 */
export const parseEpubLanguageTag = (raw: string | null | undefined): EpubLanguage | null => {
    if (!raw) return null;
    const normalized = raw.trim().toLowerCase().replace(/_/g, "-");
    if (!normalized) return null;
    const primary = normalized.split("-")[0];
    if (primary === "ja" || primary === "jpn") return "ja";
    if (primary === "en" || primary === "eng") return "en";
    return null;
};

const countScriptChars = (sample: string) => {
    let kana = 0;
    let kanji = 0;
    let latin = 0;
    let seen = 0;

    for (const ch of sample) {
        if (seen >= LANGUAGE_SAMPLE_CHARS) break;
        seen += 1;
        const code = ch.codePointAt(0) ?? 0;
        if (code >= 0x3040 && code <= 0x30ff) {
            kana += 1;
        } else if (
            (code >= 0x4e00 && code <= 0x9fff)
            || (code >= 0x3400 && code <= 0x4dbf)
            || ch === "々"
            || ch === "〆"
            || ch === "ヶ"
        ) {
            kanji += 1;
        } else if (
            (code >= 0x41 && code <= 0x5a)
            || (code >= 0x61 && code <= 0x7a)
            || (code >= 0x00c0 && code <= 0x024f)
        ) {
            latin += 1;
        }
    }

    return { kana, kanji, latin };
};

/**
 * Fallback character check on plain book text (excluding `<rt>`/`<rp>`).
 * Japanese when kana + kanji >= 30% of letters AND kana > 0.
 */
export const detectEpubLanguageFromSample = (sample: string): EpubLanguage => {
    const { kana, kanji, latin } = countScriptChars(sample);
    const total = kana + kanji + latin;
    if (total === 0 || kana === 0) return "en";
    return (kana + kanji) * 100 >= total * 30 ? "ja" : "en";
};

/**
 * Resolves the book language per A1:
 * 1) First recognized `<dc:language>` tag.
 * 2) Recommended override when metadata says `en` but text is overwhelmingly Japanese with real kana.
 * 3) Fallback to character check of the text sample.
 */
export const detectEpubLanguage = (
    metadataLanguages: readonly string[],
    textSample: string,
): EpubLanguage => {
    let recognized: EpubLanguage | null = null;
    for (const raw of metadataLanguages) {
        const parsed = parseEpubLanguageTag(raw);
        if (parsed) {
            recognized = parsed;
            break;
        }
    }

    if (recognized === "ja") return "ja";
    if (recognized === "en") {
        const { kana, kanji, latin } = countScriptChars(textSample);
        const total = kana + kanji + latin;
        if (total > 0 && kana >= 20 && (kana + kanji) * 100 >= total * 60) {
            return "ja";
        }
        return "en";
    }

    return detectEpubLanguageFromSample(textSample);
};

/**
 * Resolves the effective writing orientation per A2:
 * - English books are ALWAYS horizontal.
 * - Japanese books respect an explicit per-book override, then `epubTextOrientation`,
 *   with `'auto'` following the book's own direction (`defaultVertical`).
 */
export const resolveEpubOrientation = (
    bookLanguage: EpubLanguage | undefined,
    globalSetting: EpubOrientationSetting | undefined,
    bookDefaultVertical: boolean | undefined,
    bookOverride?: EpubOrientationSetting,
): EpubResolvedOrientation => {
    if (bookLanguage !== "ja") return "horizontal";

    const effectiveSetting: EpubOrientationSetting =
        bookOverride && bookOverride !== "auto"
            ? bookOverride
            : bookOverride === "auto"
                ? "auto"
                : globalSetting || "auto";

    if (effectiveSetting === "vertical") return "vertical";
    if (effectiveSetting === "horizontal") return "horizontal";
    return bookDefaultVertical ? "vertical" : "horizontal";
};

export const clamp01 = (value: number): number => {
    if (!Number.isFinite(value)) return 0;
    return Math.min(1, Math.max(0, value));
};

export const computeBookProgress = (
    chapterIndex: number,
    chapterCount: number,
    chapterFraction: number,
): number => {
    if (!Number.isFinite(chapterCount) || chapterCount <= 0) return 0;
    const safeChapter = Math.min(chapterCount - 1, Math.max(0, Math.floor(chapterIndex)));
    const safeFraction = clamp01(chapterFraction);
    return clamp01((safeChapter + safeFraction) / chapterCount);
};

/**
 * Character-weighted book progress: weights each chapter by its actual character count
 * so a short prologue doesn't count as 50% of the book. Falls back to `computeBookProgress`
 * when chapter character counts are unavailable.
 */
export const computeWeightedBookProgress = (
    chapterIndex: number,
    chapters: readonly Pick<EpubChapterMeta, "charCount">[],
    chapterFraction: number,
): number => {
    if (chapters.length === 0) return 0;
    let total = 0;
    for (const ch of chapters) {
        if (typeof ch.charCount === "number" && ch.charCount > 0) {
            total += ch.charCount;
        }
    }
    if (total <= 0) {
        return computeBookProgress(chapterIndex, chapters.length, chapterFraction);
    }
    const safeChapter = Math.min(chapters.length - 1, Math.max(0, Math.floor(chapterIndex)));
    const safeFraction = clamp01(chapterFraction);
    let before = 0;
    for (let i = 0; i < safeChapter; i++) {
        before += Math.max(0, chapters[i]?.charCount || 0);
    }
    const currentChars = Math.max(0, chapters[safeChapter]?.charCount || 0);
    return clamp01((before + currentChars * safeFraction) / total);
};

export const parseCountedThrough = (marker: string | undefined | null): CountedPosition | null => {
    if (!marker) return null;
    const parts = marker.split(":");
    if (parts.length !== 2) return null;
    const chapterIndex = Number.parseInt(parts[0], 10);
    const paragraphIndex = Number.parseInt(parts[1], 10);
    if (!Number.isInteger(chapterIndex) || !Number.isInteger(paragraphIndex)) return null;
    if (chapterIndex < 0 || paragraphIndex < 0) return null;
    return { chapterIndex, paragraphIndex };
};

export const formatCountedThrough = (chapterIndex: number, paragraphIndex: number): string => {
    return `${Math.max(0, Math.floor(chapterIndex))}:${Math.max(0, Math.floor(paragraphIndex))}`;
};

export const isParagraphAlreadyCounted = (
    marker: string | undefined | null,
    chapterIndex: number,
    paragraphIndex: number,
): boolean => {
    const parsed = parseCountedThrough(marker);
    if (!parsed) return false;
    if (chapterIndex < parsed.chapterIndex) return true;
    if (chapterIndex > parsed.chapterIndex) return false;
    return paragraphIndex <= parsed.paragraphIndex;
};

export const resolveEpubHrefTarget = (
    rawHref: string,
    chapters: readonly Pick<EpubChapterMeta, "index" | "href">[],
): { chapterIndex: number; fragment?: string } | null => {
    const trimmed = rawHref.trim();
    if (!trimmed) return null;
    const hashIdx = trimmed.indexOf("#");
    const pathPart = hashIdx === -1 ? trimmed : trimmed.slice(0, hashIdx);
    const fragment = hashIdx === -1 ? undefined : trimmed.slice(hashIdx + 1) || undefined;

    const normalizedTarget = pathPart.replace(/^\/+/, "");
    const match = chapters.find((chapter) => {
        const chapterHref = chapter.href.replace(/^\/+/, "");
        return chapterHref === normalizedTarget
            || decodeURIComponentSafe(chapterHref) === decodeURIComponentSafe(normalizedTarget);
    });
    if (!match) return null;
    return { chapterIndex: match.index, fragment };
};

const decodeURIComponentSafe = (value: string): string => {
    try {
        return decodeURIComponent(value);
    } catch {
        return value;
    }
};
