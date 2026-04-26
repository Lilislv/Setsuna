export const calculateStats = (text: string, language: string = 'ru') => {
    const cleanTextForChars = text.replace(/[^\p{L}\p{N}]/gu, '');
    const chars = cleanTextForChars.length;

    const trimmed = text.trim();
    const sentenceMatches = trimmed.match(/[。！？.!?]+/g) || [];
    const sentences =
        sentenceMatches.length > 0
            ? sentenceMatches.length
            : trimmed.length > 0
                ? 1
                : 0;

    let words = 0;

    if (language === 'ru' || language === 'en') {
        words = text
            .split(/\s+/)
            .map((s) => s.trim())
            .filter(Boolean).length;
    } else {
        // Для японского без Intl.Segmenter, чтобы не падал билд
        const cleaned = text
            .replace(/[。、！？.!?\s]+/g, ' ')
            .trim();

        if (!cleaned) {
            words = 0;
        } else {
            words = cleaned
                .split(/\s+/)
                .filter(Boolean)
                .length;

            if (words === 0) {
                words = Math.max(1, Math.ceil(chars / 2.5));
            }
        }
    }

    return { chars, words, sentences };
};

export const getSmartTitle = (url: string, currentTitle: string = "") => {
    const cleanTitle = (currentTitle || "").trim();

    try {
        const u = new URL(url);
        const domain = u.hostname.replace(/^www\./, '');

        if (
            cleanTitle &&
            !/^https?:\/\//i.test(cleanTitle) &&
            cleanTitle !== "Браузер" &&
            cleanTitle !== "Сайт" &&
            cleanTitle !== "Новая вкладка" &&
            cleanTitle !== "txthk Browser" &&
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
            return 'Поиск';
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

        return domain || 'Сайт';
    } catch {
        return cleanTitle || "Сайт";
    }
};