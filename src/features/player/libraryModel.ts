import { fileName } from "./localMedia.ts";

export type LibraryEpisode = { path: string };
export type LibraryDirectory = { path: string; episodes: LibraryEpisode[]; subtitles: string[] };
export type LibraryFolder = { path: string; directories: LibraryDirectory[] };
export type EpisodeProgress = {
    time: number;
    offset: number;
    translationOffset: number;
    duration?: number;
    completed?: boolean;
    lastPlayedAt?: number;
};
export const positionKey = "setsuna.player.positions";
export const libraryKey = "setsuna.player.libraryFolders";
export type SavedProgress = Record<string, number | EpisodeProgress>;

export function readProgress(): SavedProgress {
    try {
        return JSON.parse(localStorage.getItem(positionKey) || "{}") || {};
    } catch {
        return {};
    }
}

export function episodeProgress(item: SavedProgress[string] | undefined): EpisodeProgress {
    if (typeof item === "number") return { time: item, offset: 0, translationOffset: 0 };
    return {
        ...item,
        time: item?.time || 0,
        offset: item?.offset || 0,
        translationOffset: item?.translationOffset || 0,
    };
}

export const naturalOrder = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true });

export function suggestedEpisode(episodes: LibraryEpisode[], progress: SavedProgress) {
    let recent = 0;
    for (let i = 1; i < episodes.length; i++) {
        const current = episodeProgress(progress[episodes[i].path]);
        const previous = episodeProgress(progress[episodes[recent].path]);
        const last = current.lastPlayedAt ?? Number(current.time > 0);
        const before = previous.lastPlayedAt ?? Number(previous.time > 0);
        if (last > before) recent = i;
    }
    if (!episodes[recent]) return 0;
    const latest = episodeProgress(progress[episodes[recent].path]);
    if ((latest.lastPlayedAt || latest.time) && !latest.completed) return recent;
    const next = episodes.findIndex(
        (episode, index) => index >= recent && !episodeProgress(progress[episode.path]).completed,
    );
    if (next >= 0) return next;
    return Math.max(
        0,
        episodes.findIndex((episode) => !episodeProgress(progress[episode.path]).completed),
    );
}

export function libraryTitle(directory: LibraryDirectory, root: string) {
    const subpath = directory.path.slice(root.length).replace(/^[\\/]+/, "");
    const name = fileName(directory.path);
    // Technical encoding folders often contain a single show named by the imported root.
    return /^(?:aac|avc|hevc|flac|x26[45]|\d{3,4}p)$/i.test(name) && subpath
        ? fileName(directory.path.slice(0, -(name.length + 1)))
        : subpath
          ? subpath.replace(/[\\/]/g, " / ")
          : fileName(root);
}
