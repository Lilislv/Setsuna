import { useEffect, useState, type ReactNode } from "react";
import { IconPlayerTab, IconRefresh, IconSearch } from "../../components/Icons";
import {
    episodeProgress,
    naturalOrder,
    readProgress,
    suggestedEpisode,
    type LibraryDirectory,
    type SavedProgress,
} from "./libraryModel";
import type { PlayerLibraryData } from "./usePlayerLibrary";
import { episodeLabel, fileName } from "./localMedia";
import { formatClock } from "./model";
import { catalogEntries, inferMediaTitle, type Poster, type TitleHint } from "./posterModel";
import { deleteLocalPoster } from "./localPoster";
import { LibraryDialog, PosterArt, PosterPicker, PosterSource } from "./PosterPicker";
import "./library.css";

const posterKey = "setsuna.player.posters";
type Show = {
    id: string;
    root: string;
    directory: LibraryDirectory;
    hint: TitleHint;
    poster?: Poster;
};
type ShowPanel = { kind: "info" | "poster"; path: string };
type Filter = "all" | "watching" | "watched";

function readPosters(): Record<string, Poster> {
    try {
        return JSON.parse(localStorage.getItem(posterKey) || "{}") || {};
    } catch {
        return {};
    }
}

function showTitle(show: Show) {
    return (
        ((show.poster?.kind !== "image" || show.poster?.source === "Local") && show.poster?.title) ||
        show.hint.title ||
        fileName(show.directory.path)
    );
}

function status(show: Show, progress: SavedProgress) {
    const episodes = show.directory.episodes;
    let watched = 0;
    let lastPlayedAt = 0;
    for (const episode of episodes) {
        const played = episodeProgress(progress[episode.path]);
        if (played.completed) watched++;
        lastPlayedAt = Math.max(lastPlayedAt, played.lastPlayedAt || 0);
    }
    const index = suggestedEpisode(episodes, progress);
    const item = episodeProgress(progress[episodes[index]?.path]);
    return { watched, index, item, count: episodes.length, lastPlayedAt };
}

function episodeCount(count: number, en: boolean) {
    return en ? String(count) + (count === 1 ? " episode" : " episodes") : "Серий: " + count;
}

export function PlayerLibrary({
    library,
    en,
    opening,
    openEpisode,
    actions,
}: {
    library: PlayerLibraryData;
    en: boolean;
    opening: boolean;
    openEpisode: (root: string, directory: LibraryDirectory, index: number) => void;
    actions?: ReactNode;
}) {
    const [query, setQuery] = useState("");
    const [filter, setFilter] = useState<Filter>("all");
    const [sort, setSort] = useState("title");
    const [posters, setPosters] = useState(readPosters);
    const [progress, setProgress] = useState(readProgress);
    const [panel, setPanel] = useState<ShowPanel>();
    const [autoRoot, setAutoRoot] = useState("");
    const [foldersOpen, setFoldersOpen] = useState(false);
    useEffect(() => setProgress(readProgress()), []);
    useEffect(() => {
        if (!autoRoot) return;
        const scan = library.results[autoRoot];
        if (!scan) return;
        if ("folder" in scan && scan.folder.directories.length === 1) {
            const entries = catalogEntries(scan.folder.directories[0]);
            const path = entries[0]?.id;
            if (path && entries.length === 1 && !posters[path]) setPanel({ kind: "poster", path });
        }
        setAutoRoot("");
    }, [autoRoot, library.results, posters]);

    const addFolder = async () => {
        const path = await library.chooseFolder();
        if (path) {
            setFilter("all");
            setQuery("");
            setAutoRoot(path);
        }
    };
    const savePoster = (show: Show, poster?: Poster) => {
        const next = { ...posters };
        if (poster) next[show.id] = poster;
        else delete next[show.id];
        setPosters(next);
        try {
            localStorage.setItem(posterKey, JSON.stringify(next));
            if (show.poster?.imageUrl !== poster?.imageUrl)
                void deleteLocalPoster(show.poster).catch(console.warn);
        } catch {
            /* Current-session state still works. */
        }
        setPanel(undefined);
    };

    const shows: Show[] = [];
    const seen = new Set<string>();
    for (const root of library.roots) {
        const scan = library.results[root];
        if (!scan || !("folder" in scan)) continue;
        for (const group of scan.folder.directories) {
            for (const { id, directory } of catalogEntries(group)) {
                if (!directory.episodes.length || seen.has(id)) continue;
                seen.add(id);
                shows.push({ id, root, directory, hint: inferMediaTitle(directory, root), poster: posters[id] });
            }
        }
    }
    const scanning = library.roots.some((root) => !library.results[root]);
    const failures = library.roots.filter((root) => library.results[root] && "error" in library.results[root]);
    const needle = query.toLocaleLowerCase().trim();
    const items = shows.map((show) => ({ show, info: status(show, progress) }));
    const visible = items
        .filter(({ show, info }) => {
            if (filter === "watched" && info.watched !== info.count) return false;
            if (filter === "watching" && !info.item.time && (info.watched === 0 || info.watched === info.count))
                return false;
            return (
                !needle ||
                [
                    showTitle(show),
                    show.hint.title,
                    ...show.directory.episodes.map((episode) => fileName(episode.path)),
                ].some((title) => title.toLocaleLowerCase().includes(needle))
            );
        })
        .sort(
            (a, b) =>
                (sort === "recent" ? b.info.lastPlayedAt - a.info.lastPlayedAt : 0) ||
                naturalOrder(showTitle(a.show), showTitle(b.show)),
        );
    const current = panel && shows.find((show) => show.id === panel.path);

    return (
        <div className="sp-library">
            <div className="sp-library-inner">
                <header className="sp-library-header">
                    <div className="sp-library-title">
                        <h1>{en ? "Video library" : "Видеотека"}</h1>
                        {shows.length > 0 && (
                            <span title={en ? "Titles in library" : "Тайтлов в видеотеке"}>{shows.length}</span>
                        )}
                    </div>
                    <div className="sp-library-actions">
                        {actions}
                        {!!library.roots.length && (
                            <button aria-expanded={foldersOpen} onClick={() => setFoldersOpen((value) => !value)}>
                                {en ? "Folders" : "Папки"}
                                {failures.length > 0 && " · !"}
                            </button>
                        )}
                        {!!library.roots.length && (
                            <button
                                className="sp-library-primary"
                                disabled={library.pending}
                                onClick={() => void addFolder()}
                            >
                                {en ? "+ Add folder" : "+ Добавить папку"}
                            </button>
                        )}
                    </div>
                </header>
                {library.error && (
                    <p role="alert" className="sp-library-notice">
                        {library.error}
                    </p>
                )}
                {foldersOpen && !!library.roots.length && (
                    <section
                        className="sp-library-folders"
                        aria-label={en ? "Library folders" : "Папки видеотеки"}
                    >
                        <div className="sp-folders-head">
                            <strong>{en ? "Library folders" : "Папки видеотеки"}</strong>
                            <button onClick={library.refresh} disabled={scanning || library.pending}>
                                <IconRefresh /> {en ? "Refresh" : "Обновить"}
                            </button>
                        </div>
                        {library.roots.map((root) => {
                            const scan = library.results[root];
                            return (
                                <div key={root} className="sp-folder-row">
                                    <div>
                                        <strong title={root}>{fileName(root)}</strong>
                                        <span title={root}>{root}</span>
                                        {scan && "error" in scan && (
                                            <p className="sp-library-notice">{scan.error}</p>
                                        )}
                                    </div>
                                    <button
                                        disabled={library.pending || !scan}
                                        onClick={() => void library.removeFolder(root)}
                                    >
                                        {en ? "Remove from library" : "Убрать из видеотеки"}
                                    </button>
                                </div>
                            );
                        })}
                    </section>
                )}
                {shows.length > 0 && (
                    <div className="sp-library-filter-row">
                        <div className="sp-library-tabs" aria-label={en ? "Playback status" : "Статус просмотра"}>
                            {(
                                [
                                    ["all", en ? "All" : "Все"],
                                    ["watching", en ? "Watching" : "Смотрю"],
                                    ["watched", en ? "Watched" : "Просмотрено"],
                                ] as const
                            ).map(([value, label]) => (
                                <button
                                    key={value}
                                    aria-pressed={value === filter}
                                    onClick={() => setFilter(value)}
                                >
                                    {label}
                                </button>
                            ))}
                        </div>
                        <div className="sp-library-filters">
                            <label className="sp-library-search">
                                <IconSearch />
                                <input
                                    type="search"
                                    value={query}
                                    aria-label={en ? "Find a title or episode" : "Найти тайтл или серию"}
                                    placeholder={en ? "Find a title or episode…" : "Найти тайтл или серию…"}
                                    onChange={(event) => setQuery(event.target.value)}
                                />
                            </label>
                            <select
                                value={sort}
                                onChange={(event) => setSort(event.target.value)}
                                aria-label={en ? "Sort" : "Сортировка"}
                            >
                                <option value="title">{en ? "By title" : "По названию"}</option>
                                <option value="recent">{en ? "Recently played" : "Недавно смотрел"}</option>
                            </select>
                        </div>
                    </div>
                )}
                {scanning && (
                    <p className="sp-library-muted" role="status">
                        {en ? "Scanning folders…" : "Сканирование папок…"}
                    </p>
                )}
                {!scanning && !shows.length && (
                    <div className="sp-library-empty">
                        <div className="sp-library-empty-art" aria-hidden="true">
                            <div />
                            <div />
                            <div>
                                <IconPlayerTab />
                            </div>
                        </div>
                        <h2>
                            {library.roots.length
                                ? en
                                    ? "No videos found"
                                    : "Видео пока нет"
                                : en
                                  ? "Add your first title"
                                  : "Добавь первый тайтл"}
                        </h2>
                        <p>
                            {en
                                ? "Choose a folder with anime, films or shows."
                                : "Выбери папку с аниме, фильмами или сериалами."}
                        </p>
                        <button
                            className="sp-library-primary"
                            disabled={library.pending}
                            onClick={() => void addFolder()}
                        >
                            {en ? "+ Add folder" : "+ Добавить папку"}
                        </button>
                    </div>
                )}
                {!!shows.length && !visible.length && (
                    <p className="sp-library-empty-filter">{en ? "No matching titles." : "Тайтлы не найдены."}</p>
                )}
                <section className="sp-library-grid" aria-label={en ? "Titles" : "Тайтлы"}>
                    {visible.map(({ show, info }) => (
                        <article className="sp-library-card" key={show.id}>
                            <button
                                className="sp-library-cover"
                                onClick={() => setPanel({ kind: "info", path: show.id })}
                                aria-label={showTitle(show)}
                            >
                                <PosterArt poster={show.poster} label={showTitle(show)} />
                                {(info.watched > 0 || info.item.time > 0) && (
                                    <span
                                        className="sp-library-card-progress"
                                        title={en ? "Watch progress" : "Прогресс просмотра"}
                                    >
                                        {info.watched === info.count ? "✓" : info.watched + " / " + info.count}
                                    </span>
                                )}
                            </button>
                            <div className="sp-library-card-body">
                                <button
                                    className="sp-library-card-title"
                                    title={showTitle(show)}
                                    onClick={() => setPanel({ kind: "info", path: show.id })}
                                >
                                    {showTitle(show)}
                                </button>
                                <span className="sp-library-card-meta">
                                    {[show.poster?.year || show.hint.year, episodeCount(info.count, en)]
                                        .filter(Boolean)
                                        .join(" · ")}
                                </span>
                                {info.item.time > 0 ? (
                                    <button
                                        className="sp-library-card-link"
                                        disabled={opening}
                                        onClick={() => openEpisode(show.root, show.directory, info.index)}
                                    >
                                        {en ? "Continue" : "Продолжить"} · {formatClock(info.item.time)}
                                    </button>
                                ) : (
                                    <button
                                        className="sp-library-card-link"
                                        onClick={() => setPanel({ kind: "poster", path: show.id })}
                                    >
                                        {show.poster
                                            ? en
                                                ? "Change poster"
                                                : "Сменить обложку"
                                            : en
                                              ? "Find poster"
                                              : "Найти обложку"}
                                    </button>
                                )}
                            </div>
                        </article>
                    ))}
                </section>
            </div>
            {current && panel.kind === "poster" && (
                <PosterPicker
                    key={current.id}
                    initial={{
                        title: showTitle(current),
                        year: current.poster?.year || current.hint.year,
                    }}
                    selected={current.poster}
                    en={en}
                    onClose={() => setPanel(undefined)}
                    onChoose={(poster) => savePoster(current, poster)}
                />
            )}
            {current && panel.kind === "info" && (
                <ShowDetails
                    show={current}
                    progress={progress}
                    en={en}
                    opening={opening}
                    onClose={() => setPanel(undefined)}
                    onPoster={() => setPanel({ kind: "poster", path: current.id })}
                    onPlay={(index) => openEpisode(current.root, current.directory, index)}
                />
            )}
        </div>
    );
}

function ShowDetails({
    show,
    progress,
    en,
    opening,
    onClose,
    onPoster,
    onPlay,
}: {
    show: Show;
    progress: SavedProgress;
    en: boolean;
    opening: boolean;
    onClose: () => void;
    onPoster: () => void;
    onPlay: (index: number) => void;
}) {
    const info = status(show, progress);
    return (
        <LibraryDialog title={showTitle(show)} en={en} onClose={onClose}>
            <div className="sp-show-layout">
                <div className="sp-library-details">
                    <PosterArt poster={show.poster} label={showTitle(show)} />
                    <div className="sp-library-details-actions">
                        <p className="sp-library-muted">
                            {[show.poster?.year || show.hint.year, episodeCount(info.count, en)].filter(Boolean).join(" · ")}
                        </p>
                        <button className="sp-library-primary" disabled={opening} onClick={() => onPlay(info.index)}>
                            {info.item.time ? (en ? "Continue" : "Продолжить") + " · " + formatClock(info.item.time) : en ? "Watch" : "Смотреть"}
                        </button>
                        <button onClick={onPoster}>
                            {show.poster ? (en ? "Change poster" : "Сменить обложку") : (en ? "Find poster" : "Найти обложку")}
                        </button>
                        {show.poster && <PosterSource poster={show.poster}/>}
                    </div>
                </div>
                {info.count > 1 && <section className="sp-episode-list">
                    <h3>{en ? "Episodes" : "Серии"}</h3>
                    <ul className="sp-library-episodes">
                        {show.directory.episodes.map((episode,index) => {
                            const state = episodeProgress(progress[episode.path]);
                            return <li key={episode.path}>
                                <button title={fileName(episode.path)} disabled={opening} data-current={info.index === index} onClick={() => onPlay(index)}>
                                    <span>{episodeLabel(episode.path,index,en)}</span>
                                    {state.completed ? <span aria-label={en ? "Watched" : "Просмотрено"}>✓</span>
                                        : state.time > 0 && <time>{formatClock(state.time)}</time>}
                                </button>
                            </li>;
                        })}
                    </ul>
                </section>}
            </div>
        </LibraryDialog>
    );
}
