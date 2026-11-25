import { useState, type CSSProperties, type ReactNode } from "react";
import { IconSettings, IconTextTab } from "../../components/Icons";
import { formatClock } from "./model";

export type PlaybackAudio = { volume: number; muted: boolean };
const audioKey = "setsuna.player.audio";

export function readPlaybackAudio(): PlaybackAudio {
    try {
        const value = JSON.parse(localStorage.getItem(audioKey) || "null");
        if (typeof value?.volume === "number" && value.volume >= 0 && value.volume <= 1) {
            return { volume: value.volume, muted: value.muted === true };
        }
    } catch {
        /* Storage may be unavailable. */
    }
    return { volume: 1, muted: false };
}

export function writePlaybackAudio(value: PlaybackAudio) {
    try {
        localStorage.setItem(audioKey, JSON.stringify(value));
    } catch {
        /* Storage may be unavailable. */
    }
}

function PlayIcon() {
    return (
        <svg viewBox="0 0 20 20" width="17" height="17" fill="currentColor" aria-hidden="true">
            <path d="M5.5 3.8a.9.9 0 0 1 1.37-.77l9.5 5.7a.9.9 0 0 1 0 1.54l-9.5 5.7A.9.9 0 0 1 5.5 15.2V3.8Z" />
        </svg>
    );
}

function PauseIcon() {
    return (
        <svg viewBox="0 0 20 20" width="17" height="17" fill="currentColor" aria-hidden="true">
            <rect x="5" y="3.8" width="3.5" height="12.4" rx="1.1" />
            <rect x="11.5" y="3.8" width="3.5" height="12.4" rx="1.1" />
        </svg>
    );
}

function StepCueIcon({ next }: { next?: boolean }) {
    return (
        <svg
            viewBox="0 0 20 20"
            width="15"
            height="15"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.9"
            strokeLinecap="round"
            strokeLinejoin="round"
            style={next ? undefined : { transform: "scaleX(-1)" }}
            aria-hidden="true"
        >
            <path d="M5.5 4.5v11" />
            <path d="M9 5.2 15.2 10 9 14.8V5.2Z" fill="currentColor" stroke="none" />
        </svg>
    );
}

function VolumeSvg({ level, muted }: { level: number; muted: boolean }) {
    const isMuted = muted || level <= 0;
    return (
        <svg
            viewBox="0 0 20 20"
            width="16"
            height="16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
        >
            <path d="M3.5 8h3l4.2-3.4v10.8L6.5 12h-3V8Z" fill="currentColor" stroke="none" />
            {isMuted ? (
                <path d="M13.5 7.5 17 12.5M17 7.5l-3.5 5" />
            ) : (
                <>
                    <path d="M13.2 7.4a3.8 3.8 0 0 1 0 5.2" />
                    {level > 0.5 && <path d="M15.4 5.2a6.8 6.8 0 0 1 0 9.6" />}
                </>
            )}
        </svg>
    );
}

function FullscreenSvg({ exit }: { exit: boolean }) {
    return (
        <svg
            viewBox="0 0 20 20"
            width="16"
            height="16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.85"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
        >
            {exit ? (
                <path d="M7.5 3.5v4h-4M12.5 3.5v4h4M7.5 16.5v-4h-4M12.5 16.5v-4h4" />
            ) : (
                <path d="M3.5 7.5v-4h4M16.5 7.5v-4h-4M3.5 12.5v4h4M16.5 12.5v4h-4" />
            )}
        </svg>
    );
}

function SubtitlesSvg() {
    return (
        <svg
            viewBox="0 0 20 20"
            width="16"
            height="16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.75"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
        >
            <rect x="2.5" y="4.5" width="15" height="11" rx="2.4" />
            <path d="M6 10.5h3.5M11.5 10.5H14M6 13h5M12.8 13H14" />
        </svg>
    );
}

export function PlayerTransport({
    en,
    ready,
    playing,
    current,
    duration,
    audio,
    transcriptOpen,
    fullscreen,
    onPlayPause,
    onSeek,
    onAudio,
    onToggleTranscript,
    onFullscreen,
    onSettings,
    settingsLabel,
    studyActive,
    loopRange,
    showSubs,
    onToggleSubs,
    hasCues,
    onPrevCue,
    onNextCue,
    idleHidden,
    onInteract,
    children,
}: {
    en: boolean;
    ready: boolean;
    playing: boolean;
    current: number;
    duration: number;
    audio: PlaybackAudio;
    transcriptOpen: boolean;
    fullscreen: boolean;
    onPlayPause: () => void;
    onSeek: (seconds: number) => void;
    onAudio: (audio: PlaybackAudio) => void;
    onToggleTranscript: () => void;
    onFullscreen: () => void;
    onSettings: () => void;
    settingsLabel?: string;
    studyActive: boolean;
    loopRange?: { a?: number; b?: number };
    showSubs?: boolean;
    onToggleSubs?: () => void;
    hasCues?: boolean;
    onPrevCue?: () => void;
    onNextCue?: () => void;
    idleHidden?: boolean;
    onInteract?: () => void;
    children: ReactNode;
}) {
    const [hoverRatio, setHoverRatio] = useState<number | null>(null);

    const playLabel = playing ? (en ? "Pause" : "Пауза") : en ? "Play" : "Воспроизвести";
    const muteLabel =
        audio.muted || !audio.volume ? (en ? "Unmute" : "Включить звук") : en ? "Mute" : "Выключить звук";
    const screenLabel = fullscreen
        ? en
            ? "Exit full screen"
            : "Выйти из полноэкранного режима"
        : en
          ? "Full screen"
          : "Во весь экран";
    const position = duration > 0 ? Math.max(0, Math.min(duration, current)) : 0;
    const ratio = duration > 0 ? position / duration : 0;
    const effectiveVolume = audio.muted ? 0 : audio.volume;

    let loopLeftPct = 0;
    let loopWidthPct = 0;
    if (loopRange?.a !== undefined && duration > 0) {
        const start = Math.max(0, Math.min(duration, loopRange.a));
        const end =
            loopRange.b !== undefined
                ? Math.max(start, Math.min(duration, loopRange.b))
                : start;
        loopLeftPct = (start / duration) * 100;
        loopWidthPct = loopRange.b !== undefined ? Math.max(0.8, ((end - start) / duration) * 100) : 0.7;
    }

    return (
        <div
            className="sp-transport"
            data-idle={idleHidden ? "true" : undefined}
            aria-label={en ? "Playback controls" : "Управление воспроизведением"}
            onPointerMove={onInteract}
            onPointerDown={onInteract}
            onFocus={onInteract}
        >
            <div
                className="sp-timeline-wrap"
                onPointerMove={(e) => {
                    if (duration <= 0) return;
                    const rect = e.currentTarget.getBoundingClientRect();
                    if (rect.width <= 0) return;
                    const r = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
                    setHoverRatio(r);
                }}
                onPointerLeave={() => setHoverRatio(null)}
            >
                {loopRange?.a !== undefined && duration > 0 && (
                    <span
                        className="sp-timeline-loop"
                        style={{ left: `${loopLeftPct}%`, width: `${loopWidthPct}%` }}
                        aria-hidden="true"
                    />
                )}
                {hoverRatio !== null && duration > 0 && (
                    <span
                        className="sp-timeline-tooltip"
                        style={{ left: `${Math.max(4, Math.min(96, hoverRatio * 100))}%` }}
                        aria-hidden="true"
                    >
                        {formatClock(hoverRatio * duration)}
                    </span>
                )}
                <input
                    type="range"
                    className="sp-timeline"
                    min={0}
                    max={duration || 1}
                    step="any"
                    value={position}
                    disabled={duration <= 0}
                    style={{ "--sp-played": ratio * 100 + "%" } as CSSProperties}
                    aria-label={en ? "Seek" : "Позиция воспроизведения"}
                    aria-valuetext={formatClock(position) + " / " + formatClock(duration)}
                    onChange={(event) => onSeek(Number(event.target.value))}
                />
            </div>
            <div className="sp-transport-row">
                <button
                    type="button"
                    className="sp-play-button"
                    disabled={!ready}
                    title={playLabel}
                    aria-label={playLabel}
                    onClick={onPlayPause}
                >
                    {playing ? <PauseIcon /> : <PlayIcon />}
                </button>
                {onPrevCue && onNextCue && (
                    <div className="sp-transport-step">
                        <button
                            type="button"
                            disabled={!hasCues}
                            title={en ? "Previous line (↑)" : "Предыдущая реплика (↑)"}
                            aria-label={en ? "Previous line" : "Предыдущая реплика"}
                            onClick={onPrevCue}
                        >
                            <StepCueIcon />
                        </button>
                        <button
                            type="button"
                            disabled={!hasCues}
                            title={en ? "Next line (↓)" : "Следующая реплика (↓)"}
                            aria-label={en ? "Next line" : "Следующая реплика"}
                            onClick={onNextCue}
                        >
                            <StepCueIcon next />
                        </button>
                    </div>
                )}
                <div className="sp-transport-audio">
                    <button
                        type="button"
                        title={muteLabel}
                        aria-label={muteLabel}
                        onClick={() =>
                            onAudio({
                                volume: audio.volume || 0.65,
                                muted: !!audio.volume && !audio.muted,
                            })
                        }
                    >
                        <VolumeSvg level={audio.volume} muted={audio.muted} />
                    </button>
                    <input
                        type="range"
                        className="sp-vol-range"
                        min={0}
                        max={1}
                        step={0.01}
                        value={effectiveVolume}
                        style={{ "--sp-vol": effectiveVolume * 100 + "%" } as CSSProperties}
                        aria-label={en ? "Volume" : "Громкость"}
                        onChange={(event) => onAudio({ volume: Number(event.target.value), muted: false })}
                    />
                </div>
                <span className="sp-clock">
                    {formatClock(current)}
                    <span className="sp-clock-sep" aria-hidden="true"> / </span>
                    <span className="sp-clock-dur">{duration > 0 ? formatClock(duration) : ready ? (en ? "Live" : "Эфир") : "—"}</span>
                </span>
                {children}
                <div className="sp-transport-view">
                    {onToggleSubs && (
                        <button
                            type="button"
                            aria-pressed={showSubs}
                            aria-label={en ? "Subtitles on video" : "Субтитры на видео"}
                            title={en ? "Toggle subtitles on video" : "Субтитры поверх видео"}
                            onClick={onToggleSubs}
                        >
                            <SubtitlesSvg />
                        </button>
                    )}
                    <button
                        type="button"
                        data-active={studyActive}
                        aria-label={en ? "Playback settings" : "Настройки просмотра"}
                        title={en ? "Playback settings" : "Настройки просмотра"}
                        onClick={onSettings}
                    >
                        <IconSettings /> {settingsLabel && <span>{settingsLabel}</span>}
                    </button>
                    <button
                        type="button"
                        aria-pressed={transcriptOpen}
                        aria-label={en ? "Transcript" : "Реплики"}
                        onClick={onToggleTranscript}
                        title={en ? "Subtitle panel (T)" : "Панель субтитров (T)"}
                    >
                        <IconTextTab />
                    </button>
                    <button
                        type="button"
                        title={screenLabel}
                        aria-label={screenLabel}
                        onClick={onFullscreen}
                    >
                        <FullscreenSvg exit={fullscreen} />
                    </button>
                </div>
            </div>
        </div>
    );
}
