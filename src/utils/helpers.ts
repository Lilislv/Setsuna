const JAPANESE_RE = /[぀-ヿ㐀-鿿ｦ-ﾟ]/;
const SENTENCE_END_RE = /[。．！？!?｡]+[」』）)】〉》"'”’］\]]*|\.(?=\s|$)/g;

let wordSegmenter: { segment: (text: string) => Iterable<{ isWordLike?: boolean }> } | null | undefined;
const getWordSegmenter = () => {
    if (wordSegmenter !== undefined) return wordSegmenter;
    const Segmenter = (Intl as any).Segmenter;
    wordSegmenter = typeof Segmenter === 'function' ? new Segmenter('ja', { granularity: 'word' }) : null;
    return wordSegmenter;
};

const countWords = (text: string) => {
    if (JAPANESE_RE.test(text)) {
        const segmenter = getWordSegmenter();
        if (segmenter) {
            let words = 0;
            for (const segment of segmenter.segment(text)) if (segment.isWordLike) words++;
            return words;
        }
        return Math.ceil(text.replace(/[^\p{L}\p{N}]/gu, '').length / 2.5);
    }
    return text.split(/\s+/).filter((part) => /[\p{L}\p{N}]/u.test(part)).length;
};

/**
 * Quick synchronous estimate used while a line is added. The authoritative
 * word/sentence counts come from the native counter (`utils/textStats.ts`),
 * which replaces these values for the active tab shortly after.
 * The method follows the script of the text, not the UI language.
 */
export const calculateStats = (text: string, _language: string = 'ru') => {
    const chars = text.replace(/[^\p{L}\p{N}]/gu, '').length;
    const trimmed = text.trim();
    if (!trimmed) return { chars, words: 0, sentences: 0 };

    const words = countWords(trimmed);
    let sentences = 0;
    let lastEnd = 0;
    for (const match of trimmed.matchAll(SENTENCE_END_RE)) {
        const end = (match.index ?? 0) + match[0].length;
        if (/[\p{L}\p{N}]/u.test(trimmed.slice(lastEnd, end))) sentences++;
        lastEnd = end;
    }
    if (countWords(trimmed.slice(lastEnd)) >= 2) sentences++;

    return { chars, words, sentences };
};

const GENERIC_BROWSER_TITLES = new Set([
    "browser",
    "site",
    "new tab",
    "blank",
    "about:blank",
    "txthk browser",
    "браузер",
    "сайт",
    "новая вкладка",
]);

export const getSmartTitle = (url: string, currentTitle: string = "") => {
    const cleanTitle = (currentTitle || "").trim();

    try {
        const u = new URL(url);
        const domain = u.hostname.replace(/^www\./, '');
        const lowerTitle = cleanTitle.toLowerCase();

        if (
            cleanTitle &&
            !/^https?:\/\//i.test(cleanTitle) &&
            !GENERIC_BROWSER_TITLES.has(lowerTitle) &&
            cleanTitle.length > 1
        ) {
            return cleanTitle;
        }

        if (
            domain.includes('duckduckgo') ||
            domain.includes('google') ||
            domain.includes('bing') ||
            domain.includes('yandex')
        ) {
            const query = u.searchParams.get('q') || u.searchParams.get('text');
            if (query) return `🔍 ${decodeURIComponent(query)}`;
            return 'Search';
        }

        if (domain.includes('jisho.org')) {
            const query = url.split('/').pop()?.replace(/%20/g, ' ');
            if (query && !url.endsWith('search/')) {
                return `Jisho: ${decodeURIComponent(query)}`;
            }
            return 'Jisho';
        }

        if (domain.includes('youtube.com') || domain.includes('youtu.be')) {
            return 'YouTube';
        }

        const pathPart = u.pathname
            .replace(/\/+$/, '')
            .split('/')
            .filter(Boolean)
            .pop();

        if (pathPart && pathPart.length > 1 && pathPart.length < 50) {
            return decodeURIComponent(pathPart);
        }

        return domain || 'Site';
    } catch {
        if (cleanTitle && !GENERIC_BROWSER_TITLES.has(cleanTitle.toLowerCase())) {
            return cleanTitle;
        }
        return "Site";
    }
};
