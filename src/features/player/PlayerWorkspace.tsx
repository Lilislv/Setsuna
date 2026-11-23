import { useCompatibleVideo } from "./useCompatibleVideo";
import { readWebText, webVideoPage, type WebTrack } from "./webMedia";
import { useEffect, useMemo, useRef, useState } from "react";
import { usePlayerSource } from "./usePlayerSource";
import { open } from "@tauri-apps/plugin-dialog";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { AppSettings } from "../../components/SettingsModal";
import { FuriganaLine } from "../../components/TextContainer";
import { PlayerCardEditor, type SceneDraft } from "./PlayerCardEditor";
import {
    escapeCardText,
    clipInterval,
    previousCue,
    cueAt,
    formatClock,
    sceneForCue,
    type Cue,
    type PlayerScene,
} from "./model";
import { addPlayerNote, subtitleScenes } from "./mining";
import { SubtitleTracks } from "./SubtitleTracks";
import "./player.css";

type Props = { settings: AppSettings; language?: "ru" | "en"; shortcutsBlocked: boolean };
type AudioTrackList = ArrayLike<{ label: string; language: string; enabled: boolean }> & EventTarget;
function availableAudio(element: HTMLVideoElement) {
    return (element as HTMLVideoElement & { audioTracks?: AudioTrackList }).audioTracks;
}
type Mode = "normal" | "pause" | "pauseStart" | "fast" | "repeat" | "skip";
const fileName = (path: string) => path.split(/[\\/]/).pop() || path;
const positionKey = "setsuna.player.positions";

function positions(): Record<string, number> {
    try {
        return JSON.parse(localStorage.getItem(positionKey) || "{}") || {};
    } catch {
        return {};
    }
}

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

export default function PlayerWorkspace(props: Props) {
    const en = props.language === "en";
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
    const choose = async () => {
        try {
            const paths = await open({
                multiple: true,
                filters: [
                    {
                        name: en ? "Media" : "Видео",
                        extensions: ["mp4", "mkv", "webm", "mov", "m4v", "ogv", "mp3", "m4a", "ogg"],
                    },
                ],
            });
            if (paths?.length) {
                request.current++;
                setLoading(false);
                setWebTracks([]);
                setSources([...paths].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })));
                setAutoNext(false);
                setIndex(0);
                setError("");
                setUrlVisible(false);
            }
        } catch (e) {
            setError(String(e));
        }
    };
    return (
        <div className="sp-workspace">
            <div className="sp-source">
                <button onClick={() => void choose()}>{en ? "Open media…" : "Открыть видео…"}</button>
                <button aria-expanded={urlVisible} onClick={() => setUrlVisible(!urlVisible)}>
                    URL
                </button>
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
                                setWebTracks(tracks);
                                setSources([source]);
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
                {sources.length > 1 ? (
                    <select
                        aria-label={en ? "Episode" : "Серия"}
                        value={index}
                        onChange={(e) => {
                            setAutoNext(false);
                            setIndex(Number(e.target.value));
                        }}
                    >
                        {sources.map((s, i) => (
                            <option key={s} value={i}>
                                {fileName(s)}
                            </option>
                        ))}
                    </select>
                ) : (
                    <span className="sp-name">{sources[0] && fileName(sources[0]).split("?")[0]}</span>
                )}
                {error && <span role="alert">{error}</span>}
            </div>
            <Session
                key={sources[index] || ""}
                {...props}
                source={sources[index] || ""}
                openFile={choose}
                webTracks={webTracks}
                autoNext={autoNext}
                nextEpisode={
                    index + 1 < sources.length
                        ? () => {
                              setAutoNext(true);
                              setIndex(index + 1);
                          }
                        : undefined
                }
            />
        </div>
    );
}

function Session({
    source,
    openFile,
    nextEpisode,
    autoNext,
    webTracks,
    language,
    settings,
    shortcutsBlocked,
}: Props & {
    source: string;
    openFile: () => void;
    nextEpisode?: () => void;
    autoNext: boolean;
    webTracks: WebTrack[];
}) {
    const tr = (en: string, ru: string) => (language === "en" ? en : ru);
    const video = useRef<HTMLVideoElement>(null);

    const list = useRef<HTMLDivElement>(null);
    const [cues, setCues] = useState<Cue[]>([]);
    const [translations, setTranslations] = useState<Cue[]>([]);
    const [offset, setOffset] = useState(0);
    const [current, setCurrent] = useState(0);
    const [draft, setDraft] = useState<SceneDraft | null>(null);
    const [tracks, setTracks] = useState<string[]>([]);
    const [audioTrack, setAudioTrack] = useState<number>();
    const [audioOnly, setAudioOnly] = useState(false);
    const [duration, setDuration] = useState(0);
    const [query, setQuery] = useState("");
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
    const replayEnd = useRef<number | null>(null);
    const clock = current + offset;
    const cue = cueAt(cues, clock);
    const translation = cueAt(translations, clock);
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
        lastTime.current = Math.max(0, Math.min(el.duration, time));
        el.currentTime = lastTime.current;
    };
    const play = () => {
        void video.current?.play().catch((e) => report(String(e)));
    };
    const moveCue = (forward: boolean) => {
        const prev = previousCue(cues, clock - 0.12);
        const target = forward ? cues.find((c) => c.start > clock + 0.12) : prev;
        if (target) seek(target.start - offset);
    };
    const persist = (time: number) => {
        if (!source || source.startsWith("https:") || !Number.isFinite(time)) return;
        const saved = positions();
        delete saved[source];
        try {
            localStorage.setItem(
                positionKey,
                JSON.stringify(Object.fromEntries([...Object.entries(saved).slice(-49), [source, time]])),
            );
        } catch {
            /* Storage may be unavailable. */
        }
    };
    const tick = (el: HTMLVideoElement) => {
        const now = el.currentTime;
        const previous = lastTime.current;
        lastTime.current = now;
        setCurrent(now);
        const bucket = Math.floor(now / 3);
        if (bucket !== lastSaved.current && !el.seeking) {
            persist(now);
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
                seek(scene.start);
                replayEnd.current = scene.end;
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
            start: Math.max(0, current - 5),
            end: Math.min(duration, Math.max(0.1, current)),
            duration,
            audioOnly,
            audioTrack,
        };
        const data = {
            word: selected?.text || "",
            sentence: selected?.text || "",
            meaning: selected ? cueAt(translations, (selected.start + selected.end) / 2)?.text || "" : "",
            scene,
        };
        if (!selectedScene || edit) {
            video.current?.pause();
            const interval =
                range.a !== undefined && range.b !== undefined
                    ? { start: range.a, end: range.b }
                    : selectedScene
                      ? clipInterval(
                            scene,
                            audioOnly || settings.playerCardFormat === "audio"
                                ? settings.playerMiningLeadIn
                                : (settings.playerSceneLeadIn ?? 5),
                            settings.playerMiningLeadOut,
                        )
                      : scene;
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
                if (video.current?.paused) play();
                else video.current?.pause();
            } else if (match(settings.playerKeyBack || "ArrowLeft")) seek(current - settings.playerRewindSeconds);
            else if (match(settings.playerKeyForward || "ArrowRight"))
                seek(current + settings.playerRewindSeconds);
            else if (match(settings.playerKeyMine || "m")) {
                if (!e.repeat) void mine();
            } else if (match(settings.playerKeyOffsetMinus || "["))
                setOffset((n) => n - settings.playerSubtitleStep);
            else if (match(settings.playerKeyOffsetPlus || "]")) setOffset((n) => n + settings.playerSubtitleStep);
            else if (match("ArrowUp")) moveCue(false);
            else if (match("ArrowDown")) moveCue(true);
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
        <div className="sp-body">
            <main className="sp-main">
                <div className="sp-screen">
                    {source ? (
                        <video
                            ref={video}
                            controls
                            controlsList="nofullscreen"
                            playsInline
                            autoPlay={autoNext}
                            onTimeUpdate={(e) => tick(e.currentTarget)}
                            onLoadedMetadata={(e) => {
                                const el = e.currentTarget;
                                setAudioOnly(el.videoWidth === 0);
                                setDuration(Number.isFinite(el.duration) ? el.duration : 0);
                                el.playbackRate = rate;
                                const saved = positions()[source];
                                if (saved > 0 && saved < el.duration - 2) seek(saved);
                            }}
                            onPause={(e) => persist(e.currentTarget.currentTime)}
                            onEnded={() => {
                                persist(0);
                                nextEpisode?.();
                            }}
                            onError={() => {
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
                            ▶　{tr("Open a film or episodes", "Открыть фильм или серии")}
                        </button>
                    )}
                    {showSubs && (cue || translation) && (
                        <div className="sp-overlay">
                            {cue && <CueText furigana={settings.furiganaMode} cue={cue} scene={activeScene} />}
                            {translation && <span className="sp-translation">{translation.text}</span>}
                        </div>
                    )}
                </div>
                <div className="sp-controls">
                    <button
                        disabled={!cues.length}
                        onClick={() => moveCue(false)}
                        title={tr("Previous line (↑)", "Предыдущая реплика (↑)")}
                    >
                        ↑
                    </button>
                    <button
                        disabled={!cues.length}
                        onClick={() => moveCue(true)}
                        title={tr("Next line (↓)", "Следующая реплика (↓)")}
                    >
                        ↓
                    </button>
                    <select
                        aria-label={tr("Study mode", "Режим просмотра")}
                        value={mode}
                        onChange={(e) => setMode(e.target.value as Mode)}
                    >
                        <option value="normal">{tr("Normal playback", "Обычный просмотр")}</option>
                        <option value="pause">{tr("Pause after each line", "Пауза после реплики")}</option>
                        <option value="pauseStart">{tr("Pause at line start", "Пауза в начале реплики")}</option>
                        <option value="fast">{tr("Fast-forward gaps", "Ускорять паузы")}</option>
                        <option value="repeat">{tr("Repeat line", "Повтор реплики")}</option>
                        <option value="skip">{tr("Skip gaps", "Пропуск пауз")}</option>
                    </select>
                    {mode === "repeat" && (
                        <select
                            aria-label={tr("Repeat count", "Число повторов")}
                            value={repeatLimit}
                            onChange={(e) => {
                                setRepeatLimit(Number(e.target.value));
                                repeats.current = { id: -1, count: 0 };
                            }}
                        >
                            {[0, 1, 2, 3, 5].map((n) => (
                                <option key={n} value={n}>
                                    {n ? n + "×" : "∞"}
                                </option>
                            ))}
                        </select>
                    )}
                    <select
                        aria-label={tr("Playback speed", "Скорость")}
                        value={rate}
                        onChange={(e) => {
                            const n = Number(e.target.value);
                            setRate(n);
                            if (video.current) video.current.playbackRate = n;
                        }}
                    >
                        {[0.5, 0.75, 1, 1.25, 1.5, 2, 3].map((n) => (
                            <option key={n} value={n}>
                                {n}×
                            </option>
                        ))}
                    </select>
                    {tracks.length > 1 && (
                        <select
                            aria-label={tr("Audio track", "Озвучка")}
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
                                <option key={i} value={i}>
                                    {name}
                                </option>
                            ))}
                        </select>
                    )}
                    <button
                        title={tr("Mark loop start", "Начало повтора")}
                        onClick={() => setRange({ a: current })}
                    >
                        A {range.a !== undefined && formatClock(range.a)}
                    </button>
                    <button
                        disabled={range.a === undefined || current <= range.a}
                        title={tr("Mark loop end", "Конец повтора")}
                        onClick={() => setRange({ ...range, b: current })}
                    >
                        B {range.b !== undefined && formatClock(range.b)}
                    </button>
                    {range.a !== undefined && (
                        <button onClick={() => setRange({})}>{tr("Clear A–B", "Сброс A–B")}</button>
                    )}
                    <button
                        onClick={() =>
                            void (
                                document.fullscreenElement
                                    ? document.exitFullscreen()
                                    : document.documentElement.requestFullscreen()
                            )?.catch((e) => report(String(e)))
                        }
                    >
                        {tr("Full screen", "Во весь экран")}
                    </button>
                    <button className="sp-mine" disabled={busy || !duration} onClick={() => void mine()}>
                        {busy ? "…" : tr("+ Sentence to Anki", "+ Реплику в Anki")}
                    </button>
                    <button disabled={busy || !duration} onClick={() => void mine(true)}>
                        {tr("Edit card…", "Изменить карточку…")}
                    </button>
                </div>
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
            <aside className="sp-side">
                <SubtitleTracks
                    webTracks={webTracks}
                    en={language === "en"}
                    source={source.startsWith("https:") && !duration ? "" : source}
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
                            value={Number(offset.toFixed(2))}
                            onChange={(e) => setOffset(Number(e.target.value))}
                        />
                    </label>
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
                <input
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
                                        onClick={() => {
                                            replayEnd.current = null;
                                            seek(item.start - offset);
                                        }}
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
