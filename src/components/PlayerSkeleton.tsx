import { useEffect, useMemo, useRef, useState } from "react";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { AppSettings } from "./SettingsModal";
import { PlayerMiningClip } from "../utils/constants";

type Cue = {
    id: number;
    start: number;
    end: number;
    text: string;
    translation?: string;
};

type PlayerClipResult = {
    path: string;
    filename: string;
    media_type: "audio" | "video";
};

type PlayerProps = {
    language?: "ru" | "en";
    settings: AppSettings;
    onClipReady?: (clip: PlayerMiningClip) => void;
};

const pad2 = (value: number) => value.toString().padStart(2, "0");

const formatClock = (seconds: number) => {
    if (!Number.isFinite(seconds) || seconds <= 0) return "00:00";
    const total = Math.floor(seconds);
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    return h > 0 ? `${h}:${pad2(m)}:${pad2(s)}` : `${pad2(m)}:${pad2(s)}`;
};

const parseTimestamp = (value: string) => {
    const clean = value.trim().replace(",", ".");
    const parts = clean.split(":");
    if (parts.length < 2) return 0;
    const sec = Number(parts.pop() || 0);
    const min = Number(parts.pop() || 0);
    const hour = Number(parts.pop() || 0);
    return hour * 3600 + min * 60 + sec;
};

const stripAssTags = (value: string) =>
    value
        .replace(/\{[^}]*\}/g, "")
        .replace(/\\N/g, "\n")
        .replace(/\\n/g, "\n")
        .trim();

const parseSrtOrVtt = (text: string): Cue[] => {
    const blocks = text
        .replace(/\r/g, "")
        .replace(/^WEBVTT[^\n]*\n/i, "")
        .split(/\n{2,}/)
        .map((block) => block.trim())
        .filter(Boolean);

    return blocks.flatMap((block, index) => {
        const lines = block.split("\n").map((line) => line.trim()).filter(Boolean);
        const timeIndex = lines.findIndex((line) => line.includes("-->"));
        if (timeIndex < 0) return [];
        const [startRaw, endRaw] = lines[timeIndex].split("-->").map((part) => part.trim().split(/\s+/)[0]);
        const body = lines.slice(timeIndex + 1).join("\n").replace(/<[^>]+>/g, "").trim();
        if (!body) return [];
        return [{ id: index, start: parseTimestamp(startRaw), end: parseTimestamp(endRaw), text: body }];
    });
};

const parseAss = (text: string): Cue[] => {
    const lines = text.replace(/\r/g, "").split("\n");
    let format: string[] = [];
    const cues: Cue[] = [];

    lines.forEach((line) => {
        if (line.startsWith("Format:")) {
            format = line.slice(7).split(",").map((part) => part.trim().toLowerCase());
            return;
        }
        if (!line.startsWith("Dialogue:")) return;
        const raw = line.slice(9);
        const textIndex = format.indexOf("text");
        const startIndex = format.indexOf("start");
        const endIndex = format.indexOf("end");
        const minParts = Math.max(textIndex, startIndex, endIndex);
        const parts = raw.split(",", minParts + 1);
        if (textIndex < 0 || startIndex < 0 || endIndex < 0 || parts.length <= minParts) return;
        const prefix = parts.slice(0, textIndex);
        const cueText = raw.split(",").slice(textIndex).join(",");
        const body = stripAssTags(cueText);
        if (!body) return;
        cues.push({
            id: cues.length,
            start: parseTimestamp(prefix[startIndex]?.trim() || "0"),
            end: parseTimestamp(prefix[endIndex]?.trim() || "0"),
            text: body,
        });
    });

    return cues;
};

const parseSubtitleFile = (text: string, fileName: string) => {
    if (fileName.toLowerCase().endsWith(".ass") || fileName.toLowerCase().endsWith(".ssa")) {
        return parseAss(text);
    }
    return parseSrtOrVtt(text);
};

export default function PlayerSkeleton({ language = "ru", settings, onClipReady }: PlayerProps) {
    const isEn = language === "en";
    const videoRef = useRef<HTMLVideoElement>(null);
    const [videoSrc, setVideoSrc] = useState("");
    const [videoPath, setVideoPath] = useState("");
    const [videoName, setVideoName] = useState("");
    const [cues, setCues] = useState<Cue[]>([]);
    const [subtitleName, setSubtitleName] = useState("");
    const [currentTime, setCurrentTime] = useState(0);
    const [duration, setDuration] = useState(0);
    const [isPlaying, setIsPlaying] = useState(false);
    const [query, setQuery] = useState("");
    const [subtitleOffset, setSubtitleOffset] = useState(0);
    const [rate, setRate] = useState(1);
    const [abStart, setAbStart] = useState<number | null>(null);
    const [abEnd, setAbEnd] = useState<number | null>(null);
    const [replayEnd, setReplayEnd] = useState<number | null>(null);
    const [status, setStatus] = useState("");

    const activeCue = cues.find((cue) => currentTime + subtitleOffset >= cue.start && currentTime + subtitleOffset <= cue.end);
    const miningCue = activeCue || [...cues].reverse().find((cue) => cue.start <= currentTime + subtitleOffset);
    const filteredCues = useMemo(() => {
        const needle = query.trim().toLowerCase();
        if (!needle) return cues;
        return cues.filter((cue) => cue.text.toLowerCase().includes(needle));
    }, [cues, query]);

    const openVideo = async () => {
        const selected = await open({
            multiple: false,
            directory: false,
            filters: [{ name: "Video", extensions: ["mp4", "mkv", "webm", "m4v", "mov"] }],
        });
        if (!selected || typeof selected !== "string") return;
        setVideoPath(selected);
        setVideoName(selected.split(/[\\/]/).pop() || selected);
        setVideoSrc(convertFileSrc(selected));
        setStatus("");
    };

    const openSubtitles = async () => {
        const selected = await open({
            multiple: false,
            directory: false,
            filters: [{ name: "Subtitles", extensions: ["srt", "vtt", "ass", "ssa"] }],
        });
        if (!selected || typeof selected !== "string") return;
        try {
            const content = await invoke<string>("load_sync_file", { path: selected });
            const parsed = parseSubtitleFile(content, selected);
            setCues(parsed);
            setSubtitleName(selected.split(/[\\/]/).pop() || selected);
            setStatus(isEn ? `Loaded ${parsed.length} subtitles` : `Загружено субтитров: ${parsed.length}`);
        } catch (error) {
            setStatus(isEn ? `Subtitle load error: ${String(error)}` : `Ошибка загрузки субтитров: ${String(error)}`);
        }
    };

    const togglePlay = async () => {
        const video = videoRef.current;
        if (!video) return;
        if (video.paused) {
            await video.play();
        } else {
            video.pause();
        }
    };

    const seekTo = (seconds: number) => {
        if (!videoRef.current) return;
        videoRef.current.currentTime = Math.max(0, Math.min(duration || seconds, seconds));
    };

    const changeRate = (nextRate: number) => {
        setRate(nextRate);
        if (videoRef.current) videoRef.current.playbackRate = nextRate;
    };

    const normalizeKey = (value?: string) => String(value || "").toLowerCase();
    const matchesKey = (event: KeyboardEvent, value?: string) => {
        const wanted = normalizeKey(value);
        if (!wanted) return false;
        return normalizeKey(event.key) === wanted || normalizeKey(event.code) === wanted;
    };

    const replayCue = async (cue: Cue) => {
        const video = videoRef.current;
        if (!video) return;
        const leadIn = Math.max(0, settings.playerMiningLeadIn ?? 0.15);
        const leadOut = Math.max(0, settings.playerMiningLeadOut ?? 0.25);
        setReplayEnd(cue.end - subtitleOffset + leadOut);
        seekTo(Math.max(0, cue.start - subtitleOffset - leadIn));
        try { await video.play(); } catch {}
    };

    const mineCard = async () => {
        if (!miningCue) {
            setStatus(isEn ? "No active subtitle to mine." : "Нет активной реплики для карточки.");
            return;
        }
        if (settings.playerMiningReplayOnMine ?? true) {
            await replayCue(miningCue);
        }

        const leadIn = Math.max(0, settings.playerMiningLeadIn ?? 0.15);
        const leadOut = Math.max(0, settings.playerMiningLeadOut ?? 0.25);
        const start = Math.max(0, miningCue.start - leadIn);
        const end = Math.max(start + 0.1, miningCue.end + leadOut);
        let clip: PlayerMiningClip = {
            subtitle: miningCue.text,
            videoName,
            start,
            end,
            createdAt: Date.now(),
        };

        if (videoPath) {
            try {
                const cut = await invoke<PlayerClipResult>("extract_player_clip", {
                    sourcePath: videoPath,
                    start,
                    end,
                    preferVideo: settings.playerMiningPreferVideo ?? false,
                });
                clip = { ...clip, path: cut.path, filename: cut.filename, mediaType: cut.media_type };
                setStatus(isEn ? `Clip ready: ${cut.filename}` : `Клип готов: ${cut.filename}`);
            } catch (error) {
                setStatus(isEn ? `Segment replayed. ffmpeg clip cut failed: ${String(error)}` : `Отрезок переигран. ffmpeg не смог вырезать клип: ${String(error)}`);
            }
        } else {
            setStatus(isEn ? "Segment replayed. Open a video file to cut clips." : "Отрезок переигран. Открой видеофайл, чтобы вырезать клип.");
        }

        onClipReady?.(clip);
    };

    useEffect(() => {
        const handleKeyDown = (event: KeyboardEvent) => {
            const target = event.target as HTMLElement | null;
            if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;

            if (matchesKey(event, settings.playerKeyPlayPause || "Space")) {
                event.preventDefault();
                togglePlay();
            } else if (matchesKey(event, settings.playerKeyBack || "ArrowLeft")) {
                event.preventDefault();
                seekTo(currentTime - (settings.playerRewindSeconds ?? 2));
            } else if (matchesKey(event, settings.playerKeyForward || "ArrowRight")) {
                event.preventDefault();
                seekTo(currentTime + (settings.playerRewindSeconds ?? 2));
            } else if (matchesKey(event, settings.playerKeyMine || "m")) {
                event.preventDefault();
                mineCard();
            } else if (matchesKey(event, settings.playerKeyOffsetMinus || "[")) {
                event.preventDefault();
                setSubtitleOffset((value) => Number((value - (settings.playerSubtitleStep ?? 0.1)).toFixed(2)));
            } else if (matchesKey(event, settings.playerKeyOffsetPlus || "]")) {
                event.preventDefault();
                setSubtitleOffset((value) => Number((value + (settings.playerSubtitleStep ?? 0.1)).toFixed(2)));
            }
        };

        window.addEventListener("keydown", handleKeyDown);
        return () => window.removeEventListener("keydown", handleKeyDown);
    }, [currentTime, duration, settings, miningCue, videoPath, videoName, subtitleOffset]);

    return (
        <div style={{ height: "100%", display: "grid", gridTemplateColumns: "minmax(0, 1fr) 330px", background: "#050505", color: "#f5f5f5" }}>
            <div style={{ display: "grid", gridTemplateRows: "1fr auto", minWidth: 0 }}>
                <div style={{ position: "relative", display: "flex", alignItems: "center", justifyContent: "center", overflow: "hidden", background: "radial-gradient(circle at 50% 30%, #181818 0%, #050505 68%)" }}>
                    <div style={{ position: "absolute", top: 12, left: 14, right: 14, display: "flex", justifyContent: "space-between", alignItems: "center", color: "rgba(255,255,255,0.72)", fontSize: 12, zIndex: 3 }}>
                        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                            <span style={{ width: 8, height: 8, borderRadius: "50%", background: videoSrc ? "#4CAF50" : "var(--accent-blue)", display: "inline-block" }} />
                            {videoName || "Setsuna Player"}
                        </div>
                        <div>{subtitleName || (isEn ? "No subtitles loaded" : "Субтитры не загружены")}</div>
                    </div>

                    {videoSrc ? (
                        <video
                            ref={videoRef}
                            src={videoSrc}
                            onTimeUpdate={(e) => {
                                const next = e.currentTarget.currentTime;
                                setCurrentTime(next);
                                if (replayEnd !== null && next >= replayEnd) {
                                    e.currentTarget.pause();
                                    setReplayEnd(null);
                                }
                                if (abStart !== null && abEnd !== null && next >= abEnd) seekTo(abStart);
                            }}
                            onLoadedMetadata={(e) => {
                                setDuration(e.currentTarget.duration || 0);
                                e.currentTarget.playbackRate = rate;
                            }}
                            onPlay={() => setIsPlaying(true)}
                            onPause={() => setIsPlaying(false)}
                            style={{ width: "100%", height: "100%", objectFit: "contain", background: "#000" }}
                        />
                    ) : (
                        <button onClick={openVideo} style={{ width: "min(1040px, 92%)", aspectRatio: "16 / 9", background: "linear-gradient(135deg, #111 0%, #242424 52%, #080808 100%)", border: "1px solid #2d2d2d", boxShadow: "0 24px 80px rgba(0,0,0,0.55)", color: "rgba(255,255,255,0.62)", fontSize: 14, cursor: "pointer" }}>
                            {isEn ? "Open video file" : "Открыть видео"}
                        </button>
                    )}

                    {activeCue && (
                        <div style={{ position: "absolute", left: "8%", right: "8%", bottom: "12%", textAlign: "center", pointerEvents: "none", zIndex: 4 }}>
                            <div style={{ display: "inline-block", maxWidth: "100%", padding: "6px 14px", borderRadius: 4, background: "rgba(0,0,0,0.58)", color: "#fff", fontSize: 24, lineHeight: 1.45, fontWeight: 800, textShadow: "0 2px 8px #000", whiteSpace: "pre-line" }}>
                                {activeCue.text}
                            </div>
                        </div>
                    )}
                </div>

                <div style={{ background: "#101010", borderTop: "1px solid #2b2b2b", padding: "10px 14px 12px", display: "grid", gap: 10 }}>
                    <div style={{ display: "grid", gridTemplateColumns: "auto 1fr auto", gap: 12, alignItems: "center" }}>
                        <button onClick={togglePlay} style={{ width: 34, height: 34, borderRadius: "50%", background: "var(--accent-blue)", border: "none", color: "#fff", cursor: "pointer", fontWeight: 900 }}>{isPlaying ? "Ⅱ" : "▶"}</button>
                        <input type="range" min={0} max={duration || 0} step="0.05" value={currentTime} onChange={(e) => seekTo(Number(e.target.value))} style={{ width: "100%", accentColor: "var(--accent-blue)" }} />
                        <div style={{ color: "rgba(255,255,255,0.7)", fontSize: 12, fontVariantNumeric: "tabular-nums" }}>{formatClock(currentTime)} / {formatClock(duration)}</div>
                    </div>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10 }}>
                        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                            <button onClick={() => seekTo(currentTime - 2)} style={controlBtn}>-2s</button>
                            <button onClick={() => seekTo(currentTime + 2)} style={controlBtn}>+2s</button>
                            <button onClick={() => setAbStart(currentTime)} style={controlBtn}>A</button>
                            <button onClick={() => setAbEnd(currentTime)} style={controlBtn}>B</button>
                            <button onClick={() => { setAbStart(null); setAbEnd(null); }} style={controlBtn}>A-B off</button>
                            <button onClick={mineCard} style={controlBtn}>{isEn ? "Mine card" : "Карточка"}</button>
                        </div>
                        <select value={rate} onChange={(e) => changeRate(Number(e.target.value))} style={{ background: "#1b1b1b", color: "rgba(255,255,255,0.82)", border: "1px solid #333", borderRadius: 5, padding: "5px 8px" }}>
                            {[0.5, 0.75, 1, 1.25, 1.5, 2].map((value) => <option key={value} value={value}>{value.toFixed(2)}x</option>)}
                        </select>
                    </div>
                    {status && <div style={{ color: "rgba(255,255,255,0.58)", fontSize: 12 }}>{status}</div>}
                </div>
            </div>

            <aside style={{ borderLeft: "1px solid #2b2b2b", background: "var(--bg-panel)", display: "grid", gridTemplateRows: "auto auto 1fr", minWidth: 0 }}>
                <div style={{ padding: "14px", borderBottom: "1px solid var(--border-main)" }}>
                    <div style={{ color: "var(--text-main)", fontWeight: 800, marginBottom: 8 }}>{isEn ? "Subtitle tools" : "Субтитры"}</div>
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                        <button onClick={openVideo} style={sideBtn}>{isEn ? "Open video" : "Видео"}</button>
                        <button onClick={openSubtitles} style={sideBtn}>{isEn ? "Open subs" : "Сабы"}</button>
                    </div>
                </div>

                <div style={{ padding: "12px 14px", borderBottom: "1px solid var(--border-main)", display: "grid", gap: 8 }}>
                    <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={isEn ? "Search subtitles..." : "Поиск по субтитрам..."} style={{ background: "var(--bg-main)", color: "var(--text-main)", border: "1px solid var(--border-main)", borderRadius: 5, padding: "8px 10px", outline: "none" }} />
                    <div style={{ display: "grid", gridTemplateColumns: "auto 1fr auto", gap: 8, alignItems: "center", color: "var(--text-muted)", fontSize: 12 }}>
                        <span>{isEn ? "Shift" : "Сдвиг"}</span>
                        <input type="range" min="-5" max="5" step="0.1" value={subtitleOffset} onChange={(e) => setSubtitleOffset(Number(e.target.value))} style={{ accentColor: "var(--accent-blue)" }} />
                        <span>{subtitleOffset.toFixed(1)}s</span>
                    </div>
                </div>

                <div style={{ overflowY: "auto", padding: 10, display: "grid", gap: 8, alignContent: "start" }}>
                    {filteredCues.length === 0 ? (
                        <div style={{ color: "var(--text-muted)", fontSize: 13, padding: 10 }}>
                            {isEn ? "Open a subtitle file to see lines here." : "Открой файл субтитров, и реплики появятся здесь."}
                        </div>
                    ) : filteredCues.map((cue) => {
                        const active = activeCue?.id === cue.id;
                        return (
                            <button key={cue.id} onClick={() => seekTo(Math.max(0, cue.start - subtitleOffset))} style={{ background: active ? "rgba(79,166,255,0.14)" : "var(--bg-side)", border: `1px solid ${active ? "var(--accent-blue)" : "var(--border-main)"}`, color: "var(--text-main)", borderRadius: 6, padding: 10, textAlign: "left", cursor: "pointer", display: "grid", gap: 5 }}>
                                <div style={{ color: "var(--accent-blue)", fontSize: 11, fontVariantNumeric: "tabular-nums" }}>{formatClock(cue.start)} - {formatClock(cue.end)}</div>
                                <div style={{ fontWeight: 700, lineHeight: 1.35, whiteSpace: "pre-line" }}>{cue.text}</div>
                            </button>
                        );
                    })}
                </div>
            </aside>
        </div>
    );
}

const controlBtn = {
    background: "#1b1b1b",
    color: "rgba(255,255,255,0.78)",
    border: "1px solid #333",
    borderRadius: 5,
    padding: "5px 9px",
    cursor: "pointer",
    fontSize: 12,
};

const sideBtn = {
    background: "var(--bg-side)",
    border: "1px solid var(--border-main)",
    color: "var(--text-main)",
    borderRadius: 5,
    padding: "7px",
    cursor: "pointer",
};
