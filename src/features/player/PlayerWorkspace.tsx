import { useCompatibleVideo } from "./useCompatibleVideo";
import { readWebText, webVideoPage, type WebTrack } from "./webMedia";
import { createPortal } from "react-dom";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { usePlayerSource } from "./usePlayerSource";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { AppSettings } from "../../components/SettingsModal";
import DeckPicker from "../../components/DeckPicker";
import { FuriganaLine } from "../../components/TextContainer";
import { PlayerCardEditor, type SceneDraft } from "./PlayerCardEditor";
import {
    escapeCardText,
    clipInterval,
    scenePaddingSeconds,
    previousCue,
    nextCue,
    cueAt,
    formatClock,
    sceneForCue,
    type Cue,
    type PlayerScene,
} from "./model";
import { addPlayerNote, subtitleScenes } from "./mining";
import { SubtitleTracks } from "./SubtitleTracks";
import { episodeLabel, fileName, mediaExtensions, isMediaPath, isSubtitlePath, matchSubtitlePaths } from "./localMedia";
import { PlayerTransport, readPlaybackAudio, writePlaybackAudio, type PlaybackAudio } from "./PlayerTransport";
import { IconArchive, IconChevronDown, IconChevronUp, IconPlayerTab, IconSettings } from "../../components/Icons";
import { LibraryDialog } from "./PosterPicker";
import { cleanReleaseTitle, inferMediaTitle } from "./posterModel";
import { PlayerLibrary } from "./PlayerLibrary";
import { usePlayerLibrary } from "./usePlayerLibrary";
import { episodeProgress, naturalOrder, positionKey, readProgress, type LibraryDirectory } from "./libraryModel";
import "./player.css";

type Props = { settings: AppSettings; language?: "ru" | "en"; shortcutsBlocked: boolean };
type AudioTrackList = ArrayLike<{ label: string; language: string; enabled: boolean }> & EventTarget;
function availableAudio(element: HTMLVideoElement) {
    return (element as HTMLVideoElement & { audioTracks?: AudioTrackList }).audioTracks;
}
type Mode = "normal" | "pause" | "pauseStart" | "fast" | "repeat" | "skip";
function CueText({ cue, scene, furigana }: { cue: Cue; scene?: PlayerScene; furigana: string }) {
    return (
        <span
            className="sp-cue text-line"
            ref={(node) => {
                if (node && scene) subtitleScenes.set(node, scene);
                return () => {
                    if (node) subtitleScenes.delete(node);
                };
            }}
        >
            <FuriganaLine text={cue.text} mode={furigana} searchQuery="" />
        </span>
    );
}

export default function PlayerWorkspace(props: Props & { onDeckChange?: (deck: string | null) => void }) {
    const en = props.language === "en";
    const library = usePlayerLibrary();
    const [libraryOpen, setLibraryOpen] = useState(true);
    const [libraryQueue, setLibraryQueue] = useState<{ root: string; directory: LibraryDirectory } | null>(null);
    const [deckPickerOpen, setDeckPickerOpen] = useState(false);
    const closeDeckPicker = useCallback(() => setDeckPickerOpen(false), []);
    const [droppedTracks, setDroppedTracks] = useState<string[]>([]);
    const [matchOnly, setMatchOnly] = useState(false);
    const [overMedia, setOverMedia] = useState(false);
    const [sources, setSources] = useState<string[]>([]);
    const [autoNext, setAutoNext] = useState(false);
    const [index, setIndex] = useState(0);
    const [webTracks, setWebTracks] = useState<WebTrack[]>([]);
    const [pageMode, setPageMode] = useState(false);
    const [loading, setLoading] = useState(false);
    const request = useRef(0);
    const [urlVisible, setUrlVisible] = useState(false);
    const [url, setUrl] = useState("");
    const [error, setError] = useState("");
    const openLocalMedia = (paths: string[]) => {
        request.current++;
        setLoading(false);
        setWebTracks([]);
        setSources([...new Set(paths)].sort(naturalOrder));
        setLibraryQueue(null);
        setLibraryOpen(false);
        setAutoNext(false);
        setIndex(0);
        setError("");
        setUrlVisible(false);
    };
    const choose = async () => {
        try {
            const paths = await open({
                multiple: true,
                filters: [{ name: en ? "Media" : "Видео и аудио", extensions: mediaExtensions }],
            });
            if (paths?.length) {
                setDroppedTracks([]);
                openLocalMedia(paths);
            }
        } catch (e) {
            setError(String(e));
        }
    };
    useEffect(() => {
        if (!isTauri()) return;
        let disposed = false;
        let stop: (() => void) | undefined;
        void getCurrentWebview()
            .onDragDropEvent(({ payload }) => {
                if (payload.type === "leave") setOverMedia(false);
                if (payload.type === "enter")
                    setOverMedia(payload.paths.some((path) => isMediaPath(path) || isSubtitlePath(path)));
                if (payload.type !== "drop") return;
                setOverMedia(false);
                const media = payload.paths.filter(isMediaPath);
                const subtitles = payload.paths.filter(isSubtitlePath);
                if (media.length) {
                    setMatchOnly(media.length > 1);
                    setDroppedTracks(subtitles);
                    openLocalMedia(media);
                } else if (subtitles.length) {
                    setMatchOnly(false);
                    setDroppedTracks(subtitles);
                }
            })
            .then((unlisten) => {
                if (disposed) unlisten();
                else stop = unlisten;
            })
            .catch(console.warn);
        return () => {
            disposed = true;
            stop?.();
        };
    }, []);

    const openLibraryEpisode = async (
        root: string,
        directory: LibraryDirectory,
        episodeIndex: number,
        autoplay = false,
    ) => {
        const selected = directory.episodes[episodeIndex];
        if (!selected) return;
        const id = ++request.current;
        setLoading(true);
        setError("");
        try {
            await invoke("player_allow_library_media", { root, path: selected.path });
            if (request.current !== id) return;
            setLibraryQueue({ root, directory });
            setSources(directory.episodes.map((episode) => episode.path));
            setDroppedTracks([]);
            setMatchOnly(true);
            setWebTracks([]);
            setIndex(episodeIndex);
            setAutoNext(autoplay);
            setLibraryOpen(false);
            setUrlVisible(false);
        } catch (failure) {
            if (request.current === id) setError(String(failure));
        } finally {
            if (request.current === id) setLoading(false);
        }
    };
    const switchEpisode = (nextIndex: number, autoplay: boolean) => {
        if (libraryQueue) {
            void openLibraryEpisode(libraryQueue.root, libraryQueue.directory, nextIndex, autoplay);
            return;
        }
        setAutoNext(autoplay);
        if (!matchOnly) setDroppedTracks([]);
        setIndex(nextIndex);
    };
    const currentSource = sources[index] || "";
    const sidecars = droppedTracks.length ? droppedTracks : libraryQueue?.directory.subtitles || [];
    const [primaryFile, translationFile] = matchSubtitlePaths(currentSource, sidecars, !matchOnly);
    const sourceFile = fileName(currentSource).split("?")[0];
    const title = libraryQueue
        ? inferMediaTitle(libraryQueue.directory, libraryQueue.root).title
        : cleanReleaseTitle(sourceFile, true).title || sourceFile;
    const sourceActions = (
        <div className={libraryOpen ? "sp-source is-library" : "sp-source"}>
            {!libraryOpen && (
                <button
                    onClick={() => {
                        setAutoNext(false);
                        setLibraryOpen(true);
                    }}
                >
                    <IconArchive /> {en ? "Library" : "Видеотека"}
                </button>
            )}
            {libraryOpen && currentSource && (
                <button onClick={() => setLibraryOpen(false)}>{en ? "Back to video" : "К видео"}</button>
            )}
            {!libraryOpen && (
                <div className="sp-watch-title" title={sourceFile}>
                    <IconPlayerTab />
                    <strong>{title}</strong>
                </div>
            )}
            {!libraryOpen && sources.length > 1 && (
                <select
                    className="sp-episode-select"
                    aria-label={en ? "Episode" : "Серия"}
                    value={index}
                    disabled={loading}
                    onChange={(e) => switchEpisode(Number(e.target.value), false)}
                >
                    {sources.map((source, i) => (
                        <option key={source} value={i}>{episodeLabel(source, i, en)}</option>
                    ))}
                </select>
            )}
            <div className="sp-source-actions">
                <button onClick={() => void choose()}>{en ? "Open media…" : "Открыть видео…"}</button>
                <button aria-expanded={urlVisible} onClick={() => setUrlVisible(!urlVisible)}>URL</button>
                {props.onDeckChange && (
                    <button
                        className="sp-deck"
                        onClick={() => setDeckPickerOpen(true)}
                        title={en ? "Choose the Anki deck for this mode" : "Выбрать колоду Anki для плеера"}
                    >
                        {props.settings.playerAnkiDeck || "Anki"}
                    </button>
                )}
            </div>
            {urlVisible && (
                <form
                    onSubmit={async (e) => {
                        e.preventDefault();
                        const id = ++request.current;
                        setLoading(true);
                        try {
                            const address = new URL(url.trim());
                            if (address.protocol !== "https:")
                                throw new Error(
                                    en ? "Use a direct HTTPS media URL" : "Нужна прямая HTTPS-ссылка на видео",
                                );
                            let source = address.href;
                            let tracks: WebTrack[] = [];
                            if (pageMode) {
                                const page = await readWebText(source);
                                if (request.current !== id) return;
                                const media = webVideoPage(page.text, page.url);
                                if (!media)
                                    throw new Error(
                                        en
                                            ? "This page does not publish an HTML video source. Use a direct media link."
                                            : "Страница не содержит открытой ссылки на HTML-видео. Вставь прямую ссылку на видео.",
                                    );
                                source = media.source;
                                tracks = media.tracks;
                            }
                            setDroppedTracks([]);
                            setWebTracks(tracks);
                            setSources([source]);
                            setLibraryQueue(null);
                            setLibraryOpen(false);
                            setAutoNext(false);
                            setIndex(0);
                            setUrlVisible(false);
                            setError("");
                        } catch (err) {
                            if (id === request.current) setError(String(err));
                        } finally {
                            if (id === request.current) setLoading(false);
                        }
                    }}
                >
                    <input
                        type="url"
                        required
                        autoFocus
                        aria-label="HTTPS URL"
                        placeholder="https://…/episode.mp4"
                        value={url}
                        onChange={(e) => setUrl(e.target.value)}
                    />
                    <label>
                        <input
                            type="checkbox"
                            checked={pageMode}
                            onChange={(e) => setPageMode(e.target.checked)}
                        />
                        {en ? "Video page" : "Страница с видео"}
                    </label>
                    <button disabled={loading}>{loading ? "…" : en ? "Open" : "Открыть"}</button>
                </form>
            )}
            {error && <span role="alert">{error}</span>}
        </div>
    );
    return (
        <div className="sp-workspace">
            {!libraryOpen && sourceActions}
            {deckPickerOpen &&
                createPortal(
                    <DeckPicker
                        open={deckPickerOpen}
                        en={en}
                        current={props.settings.playerAnkiDeck}
                        defaultDeck={props.settings.ankiDeck}
                        tabName={en ? "Anime Player" : "Аниме-плеер"}
                        onClose={closeDeckPicker}
                        onPick={(deck) => {
                            props.onDeckChange?.(deck);
                            closeDeckPicker();
                        }}
                    />,
                    document.body,
                )}
            {overMedia && (
                <div className="sp-drop" aria-hidden="true">
                    {en ? "Drop video or subtitles" : "Отпусти видео или субтитры"}
                </div>
            )}
            {libraryOpen ? (
                <PlayerLibrary
                    library={library}
                    en={en}
                    opening={loading}
                    openEpisode={openLibraryEpisode}
                    actions={sourceActions}
                />
            ) : (
                <Session
                    key={currentSource}
                    language={props.language}
                    settings={
                        props.settings.playerAnkiDeck
                            ? { ...props.settings, ankiDeck: props.settings.playerAnkiDeck }
                            : props.settings
                    }
                    shortcutsBlocked={props.shortcutsBlocked || deckPickerOpen}
                    source={currentSource}
                    primaryFile={primaryFile}
                    translationFile={translationFile}
                    openFile={choose}
                    webTracks={webTracks}
                    autoNext={autoNext}
                    nextEpisode={index + 1 < sources.length ? () => switchEpisode(index + 1, true) : undefined}
                />
            )}
        </div>
    );
}

function Session({
    source,
    openFile,
    nextEpisode,
    autoNext,
    webTracks,
    primaryFile,
    translationFile,
    language,
    settings,
    shortcutsBlocked,
}: Props & {
    source: string;
    openFile: () => void;
    nextEpisode?: () => void;
    autoNext: boolean;
    webTracks: WebTrack[];
    primaryFile?: string;
    translationFile?: string;
}) {
    const tr = (en: string, ru: string) => (language === "en" ? en : ru);
    const video = useRef<HTMLVideoElement>(null);

    const list = useRef<HTMLDivElement>(null);
    const [cues, setCues] = useState<Cue[]>([]);
    const [translations, setTranslations] = useState<Cue[]>([]);
    const [resume] = useState(() => episodeProgress(readProgress()[source]));
    const [offset, setOffset] = useState(resume.offset);
    const [translationOffset, setTranslationOffset] = useState(resume.translationOffset);
    const [current, setCurrent] = useState(0);
    const [draft, setDraft] = useState<SceneDraft | null>(null);
    const [studyOpen, setStudyOpen] = useState(false);
    const [tracks, setTracks] = useState<string[]>([]);
    const [audioTrack, setAudioTrack] = useState<number>();
    const [audioOnly, setAudioOnly] = useState(false);
    const [duration, setDuration] = useState(0);
    const [ready, setReady] = useState(false);
    const [isPlaying, setPlaying] = useState(false);
    const [audio, setAudio] = useState(readPlaybackAudio);
    const [transcriptOpen, setTranscriptOpen] = useState(true);
    const [fullscreen, setFullscreen] = useState(Boolean(document.fullscreenElement));
    const [query, setQuery] = useState("");
    const [pausedLine, setPausedLine] = useState<Cue>();
    const [mode, setMode] = useState<Mode>("normal");
    const [rate, setRate] = useState(1);
    const [repeatLimit, setRepeatLimit] = useState(0);
    const repeats = useRef({ id: -1, count: 0 });
    const [range, setRange] = useState<{ a?: number; b?: number }>({});
    const [showSubs, setShowSubs] = useState(true);
    const [follow, setFollow] = useState(true);
    const [message, report] = useState("");
    const compatible = useCompatibleVideo(source, report);
    usePlayerSource(video, compatible.copy || source, report);
    const mining = useRef(false);
    const [busy, setBusy] = useState(false);
    const lastTime = useRef(0);
    const lastSaved = useRef(-1);
    const playing = useRef(false);
    const ended = useRef(false);
    const saveOnLeave = useRef<(element: HTMLVideoElement | null) => void>(() => {});
    const replayEnd = useRef<number | null>(null);
    const clock = current + offset;
    const cue = pausedLine && cues.includes(pausedLine) ? pausedLine : cueAt(cues, clock);
    const translation = cueAt(translations, clock + translationOffset);
    const filtered = useMemo(() => {
        const needle = query.trim().toLocaleLowerCase();
        return needle ? cues.filter((c) => c.text.toLocaleLowerCase().includes(needle)) : cues;
    }, [query, cues]);
    const rows = useVirtualizer({
        count: filtered.length,
        getScrollElement: () => list.current,
        estimateSize: () => 64,
        overscan: 6,
    });
    useEffect(() => {
        if (!follow || !cue || query) return;
        const index = filtered.indexOf(cue);
        if (index >= 0) rows.scrollToIndex(index, { align: "auto" });
    }, [cue, follow, query, filtered, rows]);

    const seek = (time: number) => {
        const el = video.current;
        if (!el || !Number.isFinite(el.duration)) return;
        setPausedLine(undefined);
        lastTime.current = Math.max(0, Math.min(el.duration, time));
        setCurrent(lastTime.current);
        el.currentTime = lastTime.current;
    };
    const play = () => {
        void video.current?.play().catch((e) => report(String(e)));
    };
    const togglePlayback = () => {
        if (!video.current) return;
        if (video.current.paused) play();
        else video.current.pause();
    };
    const markLoopEnd = () => {
        if (range.a !== undefined && current > range.a) setRange({ a: range.a, b: current });
    };
    const toggleFullscreen = () => {
        const action = document.fullscreenElement
            ? document.exitFullscreen()
            : document.documentElement.requestFullscreen();
        void action.catch((error) => report(String(error)));
    };
    const seekByUser = (position: number) => {
        replayEnd.current = null;
        repeats.current = { id: -1, count: 0 };
        seek(position);
    };
    const applyAudio = (next: PlaybackAudio) => {
        const element = video.current;
        if (element) {
            element.volume = next.volume;
            element.muted = next.muted;
        }
        setAudio(next);
        writePlaybackAudio(next);
    };
    useLayoutEffect(() => {
        const element = video.current;
        if (element) {
            element.volume = audio.volume;
            element.muted = audio.muted;
        }
    }, []);
    useEffect(() => {
        const sync = () => setFullscreen(Boolean(document.fullscreenElement));
        document.addEventListener("fullscreenchange", sync);
        return () => document.removeEventListener("fullscreenchange", sync);
    }, []);

    const moveCue = (forward: boolean) => {
        const target = nextCue(cues, clock, forward ? 1 : -1, offset, duration);
        if (!target) return;
        replayEnd.current = null;
        repeats.current = { id: -1, count: 0 };
        seek(target.start - offset);
    };
    const persist = (time: number, played = false, complete = false) => {
        if (!source || source.startsWith("https:") || !Number.isFinite(time)) return;
        const saved = readProgress();
        const item = episodeProgress(saved[source]);
        delete saved[source];
        try {
            localStorage.setItem(
                positionKey,
                JSON.stringify(
                    Object.fromEntries([
                        ...Object.entries(saved).slice(-4999),
                        [
                            source,
                            {
                                ...item,
                                time,
                                offset,
                                translationOffset,
                                duration: duration || item.duration,
                                lastPlayedAt: played ? Date.now() : item.lastPlayedAt,
                                completed: complete || item.completed,
                            },
                        ],
                    ]),
                ),
            );
        } catch {
            /* Storage may be unavailable. */
        }
    };
    saveOnLeave.current = (element) => {
        if (playing.current && !ended.current) persist(element?.currentTime ?? lastTime.current, true);
    };
    useLayoutEffect(() => {
        const element = video.current;
        return () => saveOnLeave.current(element);
    }, []);
    useEffect(() => {
        persist(video.current?.readyState ? video.current.currentTime : resume.time);
    }, [offset, translationOffset]);
    const tick = (el: HTMLVideoElement) => {
        const now = el.currentTime;
        const previous = lastTime.current;
        lastTime.current = now;
        setCurrent(now);
        const bucket = Math.floor(now / 3);
        if (bucket !== lastSaved.current && !el.seeking) {
            if (!el.ended) persist(now, now > 0);
            lastSaved.current = bucket;
        }
        if (el.paused || el.seeking) return;
        if (replayEnd.current !== null && now >= replayEnd.current) {
            replayEnd.current = null;
            el.pause();
            return;
        }
        if (range.a !== undefined && range.b !== undefined && now >= range.b) {
            seek(range.a);
            return;
        }
        if (mode === "pauseStart") {
            const starting = cues.find((c) => c.start > previous + offset && c.start <= now + offset);
            if (starting) {
                el.pause();
                seek(starting.start - offset);
                return;
            }
        }
        const ending =
            (mode === "repeat" || mode === "pause") &&
            cues.find((c) => c.end > previous + offset && c.end <= now + offset);
        if (ending) {
            if (mode === "repeat") {
                if (repeats.current.id !== ending.id) repeats.current = { id: ending.id, count: 0 };
                if (!repeatLimit || repeats.current.count < repeatLimit) {
                    repeats.current.count++;
                    seek(ending.start - offset);
                }
            } else {
                el.pause();
                seek(ending.end - offset);
                setPausedLine(ending);
            }
        } else if (mode === "skip" && !cueAt(cues, now + offset)) {
            const next = cues.find((c) => c.start > now + offset);
            if (next && next.start - (now + offset) > 0.08) seek(next.start - offset);
        }
    };

    const sceneFor = (line: Cue) => {
        const scene = sceneForCue(source, line, offset, duration);
        return scene && { ...scene, audioOnly, audioTrack };
    };
    const saveCard = async (
        { word, sentence, meaning, scene }: SceneDraft,
        exact = false,
    ): Promise<string | undefined> => {
        if (mining.current) return tr("Adding a card…", "Добавление карточки…");
        if (!settings.ankiDeck || !settings.ankiModel) {
            const message = tr(
                "Choose a deck and note type in Anki settings.",
                "Выбери колоду и тип записи в настройках Anki.",
            );
            report(message);
            return message;
        }
        mining.current = true;
        setBusy(true);
        video.current?.pause();
        report(tr("Adding scene to Anki…", "Добавление сцены в Anki…"));
        try {
            const result = await addPlayerNote(
                settings,
                { word: escapeCardText(word), sentence, meaning: escapeCardText(meaning) },
                scene,
                false,
                exact,
            );
            report(result.error || result.warning || tr("Card added to Anki", "Карточка добавлена в Anki"));
            if (!result.error && settings.playerMiningReplayOnMine) {
                const replay = exact ? scene : clipInterval(scene);
                seek(replay.start);
                replayEnd.current = replay.end;
                play();
            }
            return result.error || undefined;
        } finally {
            setBusy(false);
            mining.current = false;
        }
    };
    const mine = async (edit = false) => {
        const selected = cue || previousCue(cues, clock);
        const selectedScene = selected && sceneFor(selected);
        if (!source || !duration) return;
        const scene = selectedScene || {
            source,
            start: Math.max(0, current - scenePaddingSeconds),
            end: Math.min(duration, current + scenePaddingSeconds),
            duration,
            audioOnly,
            audioTrack,
        };
        const data = {
            word: selected?.text || "",
            sentence: selected?.text || "",
            meaning: selected
                ? cueAt(translations, (selected.start + selected.end) / 2 + translationOffset)?.text || ""
                : "",
            scene,
        };
        if (!selectedScene || edit) {
            video.current?.pause();
            const interval =
                range.a !== undefined && range.b !== undefined
                    ? { start: range.a, end: range.b }
                    : selectedScene ? clipInterval(scene) : scene;
            setDraft({ ...data, scene: { ...scene, ...interval } });
        } else await saveCard(data);
    };
    useEffect(() => {
        if (shortcutsBlocked) video.current?.pause();
    }, [shortcutsBlocked]);
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (
                draft ||
                studyOpen ||
                shortcutsBlocked ||
                e.defaultPrevented ||
                e.ctrlKey ||
                e.metaKey ||
                e.altKey ||
                e.shiftKey ||
                (e.target as HTMLElement)?.closest("input,select,textarea,[contenteditable=true],dialog")
            )
                return;
            const match = (key: string) => [e.code, e.key].some((s) => s.toLowerCase() === key.toLowerCase());
            if (match(settings.playerKeyPlayPause || "Space")) {
                if ((e.target as HTMLElement)?.closest("button")) return;
                togglePlayback();
            } else if (match(settings.playerKeyBack || "ArrowLeft"))
                seekByUser(current - settings.playerRewindSeconds);
            else if (match(settings.playerKeyForward || "ArrowRight"))
                seekByUser(current + settings.playerRewindSeconds);
            else if (match(settings.playerKeyMine || "m")) {
                if (!e.repeat) void mine();
            } else if (match(settings.playerKeyOffsetMinus || "["))
                setOffset((n) => n - settings.playerSubtitleStep);
            else if (match(settings.playerKeyOffsetPlus || "]")) setOffset((n) => n + settings.playerSubtitleStep);
            else if (match("ArrowUp")) moveCue(false);
            else if (match("ArrowDown")) moveCue(true);
            else if (match("KeyF") && !e.repeat) toggleFullscreen();
            else if (match("KeyT") && !e.repeat) setTranscriptOpen((open) => !open);
            else if (match("KeyI") && ready && !e.repeat) setRange({ a: current });
            else if (match("KeyO") && !e.repeat) markLoopEnd();
            else return;
            e.preventDefault();
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    });

    useEffect(() => {
        if (video.current)
            video.current.playbackRate = mode === "fast" && !cue && cues.length ? Math.max(4, rate) : rate;
    }, [mode, cue, cues, rate]);

    useEffect(() => {
        const el = video.current;
        if (!el) return;
        const list = availableAudio(el);
        if (!list) return;
        const refresh = () => {
            const tracks = Array.from(list);
            setTracks(tracks.map((track, i) => track.label || track.language || "#" + (i + 1)));
            const enabled = tracks.findIndex((track) => track.enabled);
            setAudioTrack(enabled >= 0 ? enabled : undefined);
        };
        refresh();
        list.addEventListener("change", refresh);
        list.addEventListener("addtrack", refresh);
        list.addEventListener("removetrack", refresh);
        return () => {
            list.removeEventListener("change", refresh);
            list.removeEventListener("addtrack", refresh);
            list.removeEventListener("removetrack", refresh);
        };
    }, [source]);

    const activeScene = cue && sceneFor(cue);
    return (
        <div className="sp-body" data-transcript-open={transcriptOpen} data-fullscreen={fullscreen}>
            <main className="sp-main">
                <div className="sp-screen">
                    {source ? (
                        <video
                            ref={video}
                            playsInline
                            onClick={togglePlayback}
                            onCanPlay={() => setReady(true)}
                            onEmptied={() => {
                                setReady(false);
                                setPlaying(false);
                                setDuration(0);
                            }}
                            onDurationChange={(event) => {
                                const length = event.currentTarget.duration;
                                setDuration(Number.isFinite(length) ? length : 0);
                            }}
                            autoPlay={autoNext}
                            onTimeUpdate={(e) => tick(e.currentTarget)}
                            onLoadedMetadata={(e) => {
                                const el = e.currentTarget;
                                setReady(true);
                                setAudioOnly(el.videoWidth === 0);
                                setDuration(Number.isFinite(el.duration) ? el.duration : 0);
                                el.playbackRate = rate;
                                const saved = resume.time;
                                if (saved > 0 && saved < el.duration - 2) seek(saved);
                            }}
                            onPlay={() => {
                                setPlaying(true);
                                playing.current = true;
                                ended.current = false;
                                setPausedLine(undefined);
                            }}
                            onSeeking={(e) => {
                                if (Math.abs(lastTime.current - e.currentTarget.currentTime) > 0.005) {
                                    setPausedLine(undefined);
                                    replayEnd.current = null;
                                    lastTime.current = e.currentTarget.currentTime;
                                }
                            }}
                            onPause={(e) => {
                                setPlaying(false);
                                if (!e.currentTarget.ended) persist(e.currentTarget.currentTime, playing.current);
                            }}
                            onEnded={() => {
                                setPlaying(false);
                                ended.current = true;
                                persist(0, true, true);
                                nextEpisode?.();
                            }}
                            onError={() => {
                                setReady(false);
                                setPlaying(false);
                                compatible.setFailed(true);
                                report(
                                    tr(
                                        "The system player cannot decode this video.",
                                        "Системный плеер не смог декодировать видео.",
                                    ),
                                );
                            }}
                        />
                    ) : (
                        <button className="sp-open" onClick={openFile}>
                            ▶　{tr("Open or drop a video", "Открыть или перетащить видео")}
                        </button>
                    )}
                    {showSubs && (cue || translation) && (
                        <div className="sp-overlay">
                            {cue && <CueText furigana={settings.furiganaMode} cue={cue} scene={activeScene} />}
                            {translation && <span className="sp-translation">{translation.text}</span>}
                        </div>
                    )}
                </div>
                <PlayerTransport
                    en={language === "en"}
                    ready={ready}
                    playing={isPlaying}
                    current={current}
                    duration={duration}
                    audio={audio}
                    transcriptOpen={transcriptOpen}
                    fullscreen={fullscreen}
                    onPlayPause={togglePlayback}
                    onSeek={seekByUser}
                    onAudio={applyAudio}
                    onToggleTranscript={() => setTranscriptOpen((open) => !open)}
                    onFullscreen={toggleFullscreen}
                    onSettings={() => setStudyOpen(true)}
                    settingsLabel={rate !== 1 ? rate + "×" : undefined}
                    studyActive={mode !== "normal" || range.b !== undefined}
                >
                    <div className="sp-card-actions">
                        <button
                            className="sp-mine"
                            disabled={busy || !duration}
                            onClick={() => void mine()}
                            aria-label={tr("Add sentence to Anki", "Добавить реплику в Anki")}
                        >
                            {busy ? (
                                "…"
                            ) : (
                                <>
                                    <span className="sp-wide-label">
                                        {tr("+ Sentence to Anki", "+ Реплику в Anki")}
                                    </span>
                                    <span className="sp-compact-label" aria-hidden="true">
                                        + Anki
                                    </span>
                                </>
                            )}
                        </button>
                        <button
                            disabled={busy || !duration}
                            onClick={() => void mine(true)}
                            aria-label={tr("Edit card", "Изменить карточку")}
                        >
                            <span className="sp-wide-label">{tr("Edit card…", "Изменить карточку…")}</span>
                            <span className="sp-compact-label" aria-hidden="true">
                                ✎
                            </span>
                        </button>
                    </div>
                </PlayerTransport>
                {studyOpen && (
                    <LibraryDialog
                        title={tr("Playback settings", "Настройки просмотра")}
                        en={language === "en"}
                        onClose={() => setStudyOpen(false)}
                    >
                        <div className="sp-study">
                            <label>
                                {tr("Study mode", "Режим просмотра")}
                                <select value={mode} onChange={(e) => setMode(e.target.value as Mode)}>
                                    <option value="normal">{tr("Normal playback", "Обычный просмотр")}</option>
                                    <option value="pause">{tr("Pause after each line", "Пауза после реплики")}</option>
                                    <option value="pauseStart">{tr("Pause at line start", "Пауза в начале реплики")}</option>
                                    <option value="fast">{tr("Fast-forward gaps", "Ускорять паузы")}</option>
                                    <option value="repeat">{tr("Repeat line", "Повтор реплики")}</option>
                                    <option value="skip">{tr("Skip gaps", "Пропуск пауз")}</option>
                                </select>
                            </label>
                            {mode === "repeat" && (
                                <label>
                                    {tr("Repeat count", "Число повторов")}
                                    <select
                                        value={repeatLimit}
                                        onChange={(e) => {
                                            setRepeatLimit(Number(e.target.value));
                                            repeats.current = { id: -1, count: 0 };
                                        }}
                                    >
                                        {[0, 1, 2, 3, 5].map((n) => (
                                            <option key={n} value={n}>{n ? n + "×" : "∞"}</option>
                                        ))}
                                    </select>
                                </label>
                            )}
                            <label>
                                {tr("Playback speed", "Скорость")}
                                <select value={rate} onChange={(e) => setRate(Number(e.target.value))}>
                                    {[0.5, 0.75, 1, 1.25, 1.5, 2, 3].map((n) => (
                                        <option key={n} value={n}>{n}×</option>
                                    ))}
                                </select>
                            </label>
                            {tracks.length > 1 && (
                                <label>
                                    {tr("Audio track", "Озвучка")}
                                    <select
                                        value={audioTrack ?? 0}
                                        onChange={(e) => {
                                            const list = video.current && availableAudio(video.current);
                                            if (list)
                                                Array.from(list).forEach((track, i) => {
                                                    track.enabled = i === Number(e.target.value);
                                                });
                                        }}
                                    >
                                        {tracks.map((name, i) => (
                                            <option key={i} value={i}>{name}</option>
                                        ))}
                                    </select>
                                </label>
                            )}
                            <fieldset>
                                <legend>{tr("A–B loop", "Повтор отрезка A–B")}</legend>
                                <button
                                    disabled={!ready}
                                    data-set={range.a !== undefined}
                                    title={tr("Mark loop start (I)", "Начало повтора (I)")}
                                    onClick={() => setRange({ a: current })}
                                >
                                    A {range.a !== undefined && formatClock(range.a)}
                                </button>
                                <button
                                    data-set={range.b !== undefined}
                                    disabled={range.a === undefined || current <= range.a}
                                    title={tr("Mark loop end (O)", "Конец повтора (O)")}
                                    onClick={markLoopEnd}
                                >
                                    B {range.b !== undefined && formatClock(range.b)}
                                </button>
                                {range.a !== undefined && (
                                    <button onClick={() => setRange({})}>{tr("Clear A–B", "Сбросить A–B")}</button>
                                )}
                            </fieldset>
                        </div>
                    </LibraryDialog>
                )}
                {draft && (
                    <PlayerCardEditor
                        draft={draft}
                        en={language === "en"}
                        onClose={() => setDraft(null)}
                        onSave={(data) => saveCard(data, true)}
                    />
                )}
                {compatible.failed && source && !source.startsWith("https:") && (
                    <div className="sp-controls">
                        {compatible.busy ? (
                            <>
                                <span>
                                    {tr("Preparing a compatible MP4…", "Подготовка совместимой копии MP4…")}
                                </span>
                                <button onClick={compatible.cancel}>{tr("Cancel", "Отмена")}</button>
                            </>
                        ) : (
                            <button onClick={() => void compatible.prepare()}>
                                {tr(
                                    "Prepare compatible MP4 with FFmpeg",
                                    "Подготовить совместимую MP4-копию через FFmpeg",
                                )}
                            </button>
                        )}
                    </div>
                )}
                {message && <output className="sp-status">{message}</output>}
            </main>
            <aside className="sp-side" aria-label={tr("Transcript", "Реплики")}>
                <header className="sp-side-head">
                    <h2>{tr("Transcript", "Реплики")}</h2>
                    <div className="sp-line-navigation">
                        <button
                            disabled={!cues.length}
                            onClick={() => moveCue(false)}
                            aria-label={tr("Previous line", "Предыдущая реплика")}
                            title={tr("Previous line (↑)", "Предыдущая реплика (↑)")}
                        >
                            <IconChevronUp />
                        </button>
                        <button
                            disabled={!cues.length}
                            onClick={() => moveCue(true)}
                            aria-label={tr("Next line", "Следующая реплика")}
                            title={tr("Next line (↓)", "Следующая реплика (↓)")}
                        >
                            <IconChevronDown />
                        </button>
                    </div>
                </header>
                <details className="sp-track-settings">
                    <summary>
                        <IconSettings /> {tr("Subtitle tracks", "Дорожки субтитров")}
                    </summary>
                    <SubtitleTracks
                        webTracks={webTracks}
                        primaryFile={primaryFile}
                        translationFile={translationFile}
                        en={language === "en"}
                        source={source}
                        onPrimary={setCues}
                        onTranslation={setTranslations}
                        report={report}
                    />
                    <div className="sp-tools">
                        <label>
                            {tr("Offset (s)", "Сдвиг (с)")}{" "}
                            <input
                                aria-label={tr("Subtitle offset", "Сдвиг субтитров")}
                                type="number"
                                step={settings.playerSubtitleStep || 0.1}
                                key={Math.round(offset * 100)}
                                defaultValue={Number(offset.toFixed(2))}
                                onBlur={(e) => setOffset(Number(e.target.value))}
                                onKeyDown={(e) => {
                                    if (e.key === "Enter") e.currentTarget.blur();
                                }}
                            />
                        </label>
                        {translations.length > 0 && (
                            <label>
                                {tr("Translation (s)", "Перевод (с)")}{" "}
                                <input
                                    aria-label={tr("Translation offset", "Сдвиг перевода")}
                                    type="number"
                                    step={settings.playerSubtitleStep || 0.1}
                                    key={Math.round(translationOffset * 100)}
                                    defaultValue={Number(translationOffset.toFixed(2))}
                                    onBlur={(e) => setTranslationOffset(Number(e.target.value))}
                                    onKeyDown={(e) => {
                                        if (e.key === "Enter") e.currentTarget.blur();
                                    }}
                                />
                            </label>
                        )}
                        <label>
                            <input
                                type="checkbox"
                                checked={showSubs}
                                onChange={(e) => setShowSubs(e.target.checked)}
                            />
                            {tr("On video", "На видео")}
                        </label>
                        <label>
                            <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} />
                            {tr("Follow", "Автопрокрутка")}
                        </label>
                    </div>
                </details>
                <input
                    aria-label={tr("Find a subtitle", "Поиск реплики")}
                    className="sp-search"
                    type="search"
                    value={query}
                    placeholder={tr("Find a subtitle…", "Найти реплику…")}
                    onChange={(e) => setQuery(e.target.value)}
                />
                <div className="sp-list" ref={list}>
                    {!filtered.length && (
                        <p>
                            {query
                                ? tr("No matching lines", "Совпадений нет")
                                : tr(
                                      "Select subtitles to see the transcript.",
                                      "Выбери субтитры, чтобы увидеть реплики.",
                                  )}
                        </p>
                    )}
                    <div style={{ height: rows.getTotalSize(), position: "relative" }}>
                        {rows.getVirtualItems().map((row) => {
                            const item = filtered[row.index];
                            return (
                                <div
                                    key={row.key}
                                    ref={rows.measureElement}
                                    data-index={row.index}
                                    className="sp-row"
                                    data-active={cue?.id === item.id}
                                    style={{ transform: "translateY(" + row.start + "px)" }}
                                >
                                    <button
                                        onClick={() => seekByUser(item.start - offset)}
                                        title={tr("Seek to line", "Перейти к реплике")}
                                    >
                                        {formatClock(item.start - offset)}
                                    </button>
                                    <CueText furigana={settings.furiganaMode} cue={item} scene={sceneFor(item)} />
                                </div>
                            );
                        })}
                    </div>
                </div>
            </aside>
        </div>
    );
}
