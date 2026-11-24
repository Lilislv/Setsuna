export const mediaExtensions = ["mp4", "mkv", "webm", "mov", "m4v", "ogv", "avi", "mp3", "m4a", "ogg", "flac"];
export const subtitleExtensions = ["srt", "vtt", "ass", "ssa"];

export const fileName = (path: string) => path.split(/[\\/]/).pop() || path;

export function isMediaPath(path: string) {
    return mediaExtensions.includes(path.split(".").pop()?.toLowerCase() || "");
}

export function isSubtitlePath(path: string) {
    return subtitleExtensions.includes(path.split(".").pop()?.toLowerCase() || "");
}

const stem = (path: string) =>
    fileName(path)
        .replace(/\.[^.]+$/, "")
        .toLowerCase();
const japanese = /(?:^|[. _\[\(-])(?:ja|jpn|jp|japanese)(?=$|[. _\]\)-])/i;
const otherLanguage = /(?:^|[. _\[\(-])(?:ru|rus|russian|en|eng|english)(?=$|[. _\]\)-])/i;

export function isJapaneseSubtitlePath(path: string) {
    return japanese.test(stem(path));
}

function releaseStem(path: string) {
    return stem(path)
        .normalize("NFKC")
        .replace(/\[[^\]]*\]/g, "")
        .replace(/(?:[. _-]+)(?:ja|jpn|jp|japanese|ru|rus|russian|en|eng|english)$/i, "")
        .replace(/\s+/g, " ")
        .trim();
}

export function matchSubtitlePaths(mediaPath: string, subtitlePaths: string[], singleEpisode: boolean) {
    const episode = stem(mediaPath);
    const candidates = subtitlePaths.filter((path) => {
        const name = stem(path);
        return name === episode || (name.startsWith(episode) && /^[. _-]/.test(name.slice(episode.length)));
    });
    const release = releaseStem(mediaPath);
    const related = release ? subtitlePaths.filter((path) => releaseStem(path) === release) : [];
    const matched = [...new Set([...candidates, ...related])];
    const choices = matched.length || !singleEpisode ? matched : subtitlePaths;
    const primary =
        choices.find(isJapaneseSubtitlePath) ||
        choices.find((path) => !otherLanguage.test(stem(path))) ||
        choices[0];
    return [primary, choices.find((path) => path !== primary)] as const;
}
