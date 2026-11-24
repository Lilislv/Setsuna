import { useEffect, useState } from "react";
import {
    episodeProgress,
    libraryTitle,
    readProgress,
    suggestedEpisode,
    type LibraryDirectory,
    type SavedProgress,
} from "./libraryModel";
import type { PlayerLibraryData } from "./usePlayerLibrary";
import { fileName } from "./localMedia";
import { formatClock } from "./model";
import "./library.css";

export function PlayerLibrary({
    library,
    en,
    opening,
    openEpisode,
}: {
    library: PlayerLibraryData;
    en: boolean;
    opening: boolean;
    openEpisode: (root: string, directory: LibraryDirectory, index: number) => void;
}) {
    const [query, setQuery] = useState("");
    const [progress, setProgress] = useState(readProgress);
    useEffect(() => setProgress(readProgress()), []);

    const needle = query.trim().toLocaleLowerCase();
    const matches = (d: LibraryDirectory, root: string) =>
        !needle ||
        libraryTitle(d, root).toLocaleLowerCase().includes(needle) ||
        d.episodes.some((episode) => fileName(episode.path).toLocaleLowerCase().includes(needle));
    return (
        <div className="sp-library">
            <header className="sp-library-header">
                <h1>{en ? "Video library" : "Видеотека"}</h1>
                <div className="sp-library-actions">
                    {!!library.roots.length && (
                        <>
                            <input
                                type="search"
                                value={query}
                                aria-label={en ? "Find a show or episode" : "Найти сериал или серию"}
                                placeholder={en ? "Find a show or episode…" : "Найти сериал или серию…"}
                                onChange={(e) => setQuery(e.target.value)}
                            />
                            <button onClick={library.refresh} disabled={library.pending}>
                                {en ? "Refresh folders" : "Обновить папки"}
                            </button>
                        </>
                    )}
                    <button
                        className="sp-library-add"
                        onClick={() => void library.chooseFolder()}
                        disabled={library.pending}
                    >
                        {en ? "+ Add folder" : "+ Добавить папку"}
                    </button>
                </div>
            </header>
            {library.error && (
                <p role="alert" className="sp-library-error">
                    {library.error}
                </p>
            )}
            {!library.roots.length && (
                <div className="sp-library-empty">
                    <p>
                        {en
                            ? "Add a folder with films or episodes. Subtitle files are picked up alongside the videos."
                            : "Добавь папку с фильмами или сериями. Субтитры из неё загрузятся вместе с видео."}
                    </p>
                </div>
            )}
            {library.roots.map((root) => {
                const scan = library.results[root];
                const groups = scan && "folder" in scan ? scan.folder.directories : [];
                const visible = groups.filter((d) => matches(d, root));
                return (
                    <section className="sp-library-folder" key={root}>
                        <header>
                            <div>
                                <h2 title={root}>{fileName(root)}</h2>
                                <span title={root}>{root}</span>
                            </div>
                            <button
                                disabled={library.pending || !scan}
                                onClick={() => void library.removeFolder(root)}
                                title={en ? "Remove folder from library" : "Убрать папку из видеотеки"}
                            >
                                {en ? "Remove from library" : "Убрать из видеотеки"}
                            </button>
                        </header>
                        {!scan ? (
                            <p role="status">{en ? "Scanning folder…" : "Сканирование папки…"}</p>
                        ) : "error" in scan ? (
                            <p className="sp-library-error">{scan.error}</p>
                        ) : !groups.length ? (
                            <p>
                                {en
                                    ? "No supported media in this folder."
                                    : "В папке нет поддерживаемых видео или аудио."}
                            </p>
                        ) : !visible.length ? (
                            <p>{en ? "No matches in this folder." : "В этой папке ничего не найдено."}</p>
                        ) : (
                            <div className="sp-library-grid">
                                {visible.map((directory) => (
                                    <LibrarySeries
                                        key={directory.path}
                                        root={root}
                                        directory={directory}
                                        progress={progress}
                                        en={en}
                                        needle={needle}
                                        opening={opening}
                                        open={(index) => openEpisode(root, directory, index)}
                                    />
                                ))}
                            </div>
                        )}
                    </section>
                );
            })}
        </div>
    );
}

function LibrarySeries({
    root,
    directory,
    progress,
    en,
    needle,
    opening,
    open,
}: {
    root: string;
    directory: LibraryDirectory;
    progress: SavedProgress;
    en: boolean;
    needle: string;
    opening: boolean;
    open: (index: number) => void;
}) {
    const episodes = directory.episodes;
    const finished = episodes.filter((episode) => episodeProgress(progress[episode.path]).completed).length;
    const suggested = suggestedEpisode(episodes, progress);
    const resume = episodeProgress(progress[episodes[suggested]?.path]).time;
    const withMatchingName = (path: string) => fileName(path).toLocaleLowerCase().includes(needle);
    return (
        <article className="sp-library-series">
            <div className="sp-library-series-heading">
                <h3>{libraryTitle(directory, root)}</h3>
                <span>
                    {finished} / {episodes.length}
                </span>
            </div>
            {finished > 0 && (
                <progress
                    value={finished}
                    max={episodes.length}
                    aria-label={en ? "Episodes watched" : "Просмотренные серии"}
                />
            )}
            <button
                className="sp-library-play"
                disabled={opening}
                title={fileName(episodes[suggested].path)}
                onClick={() => open(suggested)}
            >
                {resume > 0
                    ? (en ? "Continue" : "Продолжить") + " · " + formatClock(resume)
                    : en
                      ? "Watch"
                      : "Смотреть"}
            </button>
            <details open={needle ? true : undefined}>
                <summary>{en ? "Episodes" : "Список серий"}</summary>
                <ol>
                    {episodes.map((episode, index) => {
                        if (
                            needle &&
                            !withMatchingName(episode.path) &&
                            !libraryTitle(directory, root).toLocaleLowerCase().includes(needle)
                        )
                            return null;
                        const item = episodeProgress(progress[episode.path]);
                        return (
                            <li key={episode.path}>
                                <button disabled={opening} onClick={() => open(index)} title={episode.path}>
                                    <span>{fileName(episode.path)}</span>
                                    {item.completed ? (
                                        <span aria-label={en ? "Watched" : "Просмотрено"}>✓</span>
                                    ) : (
                                        item.time > 0 && <time>{formatClock(item.time)}</time>
                                    )}
                                </button>
                            </li>
                        );
                    })}
                </ol>
            </details>
        </article>
    );
}
