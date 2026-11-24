export const mediaExtensions = ["mp4", "mkv", "webm", "mov", "m4v", "ogv", "avi", "mp3", "m4a", "ogg", "flac"];
export const subtitleExtensions = ["srt", "vtt", "ass", "ssa"];

export const fileName = (path: string) => path.split(/[\\/]/).pop() || path;

export function episodeLabel(path: string, index: number, en: boolean) {
    const basename = fileName(path).replace(/\.[^.]+$/, "").replace(/\[[^\]]*\]/g, " ").trim();
    const season = basename.match(/(?:^|[\s._-])s(\d{1,3})[ ._-]*e(\d{1,4})(?=$|[^\p{L}\p{N}])/iu)
        || basename.match(/(?:^|[\s._-])(\d{1,3})x(\d{1,4})(?=$|[^\p{L}\p{N}])/iu);
    const number = season?.[2] || basename.match(/(?:^|[\s._-])(?:episode|ep|e|серия)[ ._-]*(\d{1,4})(?=$|[^\p{L}\p{N}])/iu)?.[1]
        || basename.match(/\s[-–—]\s*(\d{1,4})(?:v\d+)?\s*$/i)?.[1];
    const episode = (en ? "Episode " : "Серия ") + (number === undefined ? index + 1 : Number(number));
    if (!season) return episode;
    const pad = (value: string) => String(Number(value)).padStart(2, "0");
    return `S${pad(season[1])}E${pad(season[2])}`;
}

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
