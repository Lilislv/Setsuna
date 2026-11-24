import { fileName } from "./localMedia.ts";
import type { LibraryDirectory } from "./libraryModel.ts";

export type Poster = {
    id: string;
    title: string;
    year?: number;
    kind: string;
    source: string;
    imageUrl: string;
    pageUrl: string;
    attribution?: string;
};
export type PosterSearch = { candidates: Poster[]; unavailable: string[] };
export type TitleHint = { title: string; year?: number };

const generic =
    /^(?:anime|movies?|films?|tv(?: series)?|shows?|media|video|аниме|сериалы|фильмы|кино|видео|downloads|(?:season|сезон|s)[ ._-]*\d+|(?:aac|avc|hevc|flac|x26[45]|\d{3,4}p))$/iu;
const episodes =
    /(?:^|[\s_.\[(\-])(?:s\d{1,3}[ ._-]*e\d{1,4}|\d{1,3}x\d{1,4}|(?:ep(?:isode)?|серия|e)[ ._-]*\d{1,4})(?=$|[^\p{L}\p{N}])/iu;
const technical =
    /(?:^|[\s_.-])(?:\d{3,4}[pi]|4k|uhd|web[ ._-]*(?:dl|rip)|blu[ ._-]*ray|b[dr]rip|hdtv|x26[45]|hevc|avc|aac|eac3|atmos|remux)(?=$|[^\p{L}\p{N}])/iu;
const mediaExtension = /\.(?:mkv|mp4|avi|webm|mov|m4v|ogv|mp3|flac|ogg|m4a)$/i;

export function cleanReleaseTitle(path: string, isFile = false): TitleHint {
    const basename = fileName(path.replace(/[\\/]+$/, "")).normalize("NFKC");
    let title = isFile ? basename.replace(mediaExtension, "") : basename;
    // A leading bracket is a release group, while later brackets hold edition tags.
    title = title
        .replace(/\[[^\]]*\]/g, " ")
        .replace(/_/g, " ")
        .trim();
    if (title.split(".").length >= 3 && !/\s/.test(title)) title = title.replace(/\./g, " ");
    const episodeAt = title.search(episodes);
    if (episodeAt !== -1) title = title.slice(0, episodeAt);
    const tagsAt = title.search(technical);
    const hadTechnicalTags = tagsAt !== -1;
    if (hadTechnicalTags) title = title.slice(0, tagsAt);
    title = title.replace(/\s+(?:season|сезон|s)[ ._-]*\d+\s*$/iu, "").trimEnd();
    const dated =
        title.match(/\s*[(]\s*((?:19|20)\d{2})\s*[)]\s*$/) ||
        (hadTechnicalTags || episodeAt !== -1 ? title.match(/\s+((?:19|20)\d{2})\s*$/) : null);
    if (dated) title = title.slice(0, dated.index);
    title = title
        .replace(/\s+[-–—]\s+\d{1,4}(?:v\d+)?\s*$/i, "")
        .replace(/\s+(?:season|сезон)\s*\d+\s*$/iu, "")
        .replace(/[\s._–—-]+$/g, "")
        .replace(/\s+/g, " ")
        .trim();
    return { title, ...(dated ? { year: Number(dated[1]) } : {}) };
}

export function catalogEntries(directory: LibraryDirectory) {
    const name = fileName(directory.path);
    const films = /^(?:movies?|films?|кино|фильмы)$/iu.test(name);
    if (
        !films ||
        directory.episodes.length < 2 ||
        directory.episodes.some((episode) => episodes.test(fileName(episode.path)))
    ) {
        return [{ id: directory.path, directory }];
    }
    return directory.episodes.map((episode) => ({
        id: episode.path,
        directory: { ...directory, episodes: [episode] },
    }));
}

export function inferMediaTitle(directory: LibraryDirectory, root: string): TitleHint {
    const folder = cleanReleaseTitle(directory.path);
    const parent = cleanReleaseTitle(directory.path.replace(/[\\/][^\\/]+[\\/]?$/, ""));
    const rootHint = cleanReleaseTitle(root);
    const samples = directory.episodes
        .slice(0, 8)
        .map((episode) => cleanReleaseTitle(episode.path, true))
        .filter((hint) => hint.title && !generic.test(hint.title) && /\p{L}/u.test(hint.title));
    const first = samples[0];
    if (folder.title && !generic.test(folder.title)) {
        return { title: folder.title, year: folder.year || first?.year || rootHint.year };
    }
    if (
        first &&
        (samples.length === 1 ||
            samples.filter((hint) => hint.title.toLowerCase() === first.title.toLowerCase()).length >=
                Math.ceil(samples.length / 2))
    ) {
        return { title: first.title, year: first.year || parent.year || rootHint.year };
    }
    const related = [parent, rootHint].find((hint) => hint.title && !generic.test(hint.title));
    return related || first || folder;
}

const comparable = (text: string) =>
    text
        .normalize("NFKC")
        .toLocaleLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, " ")
        .trim();

export function rankPosters(candidates: Poster[], query: string, year?: number) {
    const expected = comparable(query);
    const queryWords = new Set(expected.split(" "));
    const score = (item: Poster) => {
        const title = comparable(item.title);
        const words = new Set(title.split(" "));
        const overlap = [...words].filter((word) => queryWords.has(word)).length;
        const match = title === expected ? 100 : (overlap * 78) / Math.max(words.size, queryWords.size);
        return (
            match +
            (year && item.year ? (year === item.year ? 18 : -Math.min(28, Math.abs(year - item.year) * 4 + 7)) : 0)
        );
    };
    const seen = new Set<string>();
    return candidates
        .filter((item) => {
            if (!item.imageUrl.startsWith("https://") || seen.has(item.id)) return false;
            seen.add(item.id);
            return true;
        })
        .sort((a, b) => score(b) - score(a));
}
