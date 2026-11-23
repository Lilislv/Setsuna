import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { getTranslator, type AppLanguage } from "../../utils/i18n";
import { IconBookTab, IconClose } from "../../components/Icons";
import {
    alignEpubAudio,
    alignEpubAudioText,
    allowEpubAudioFile,
    clearEpubAudioAlignment,
    loadEpubAudioAlignment,
    type EpubAudioAlignment,
} from "./epubApi";
import {
    DEFAULT_AUDIO_PREFS,
    findAlignedCueAtTime,
    findTimestampForParagraph,
    formatAlignmentAsSrt,
    loadBookAudioConfig,
    makeBookAudioKey,
    saveBookAudioConfig,
    type EpubBookAudioConfig,
} from "./epubAudioStorage";
import type { EpubLanguage, EpubParagraph } from "./epubModel";
import { formatAudioTime } from "./epubSubtitles";

export interface AudiobookActiveMedia {
    audioPath: string;
    duration: number;
    alignment: EpubAudioAlignment | null;
}

interface EpubAudioBarProps {
    open: boolean;
    isMobile: boolean;
    zenMode: boolean;
    lookupOpen: boolean;
    bottomChromeVisible: boolean;
    language: AppLanguage;
    bookLanguage: EpubLanguage;
    bookPath: string;
    bookTitle: string;
    bookAuthor?: string;
    coverDataUrl?: string | null;
    chapterIndex: number;
    chapterCount: number;
    paragraphs: EpubParagraph[];
    startParagraphIndex: number;
    seekToParagraphRequest?: { chapterIndex: number; paragraphIndex: number; nonce: number } | null;
    onFocusParagraph: (paragraphIndex: number | null) => void;
    onJumpToChapterParagraph: (chapterIndex: number, paragraphIndex: number) => void;
    onAdvanceChapter: () => void;
    onAudiobookMediaChange?: (media: AudiobookActiveMedia | null) => void;
    onOpenPanel: () => void;
    onClosePanel: () => void;
}

const SPEED_OPTIONS = [0.75, 0.9, 1.0, 1.15, 1.3, 1.5, 1.75, 2.0];
const SKIP_OPTIONS = [3, 5, 10, 15];

function basename(path: string): string {
    const clean = path.replace(/\\/g, "/");
    const idx = clean.lastIndexOf("/");
    return idx >= 0 ? clean.slice(idx + 1) : clean;
}

export default function EpubAudioBar({
    open,
    isMobile,
    zenMode,
    lookupOpen,
    bottomChromeVisible,
    language,
    bookLanguage,
    bookPath,
    bookTitle,
    bookAuthor,
    coverDataUrl,
    chapterIndex,
    chapterCount,
    paragraphs,
    startParagraphIndex,
    seekToParagraphRequest,
    onFocusParagraph,
    onJumpToChapterParagraph,
    onAdvanceChapter,
    onAudiobookMediaChange,
    onOpenPanel,
    onClosePanel,
}: EpubAudioBarProps) {
    const t = getTranslator(language);
    const bookKey = useMemo(() => makeBookAudioKey(bookTitle || bookPath), [bookTitle, bookPath]);

    const [mode, setMode] = useState<"audiobook" | "tts">("audiobook");
    const [audioTab, setAudioTab] = useState<"resources" | "chapters" | "settings">("resources");

    // --- TTS state ---
    const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
    const [selectedVoiceUri, setSelectedVoiceUri] = useState<string>("");
    const [ttsRate, setTtsRate] = useState<number>(1.0);
    const [ttsPlaying, setTtsPlaying] = useState(false);
    const [ttsPaused, setTtsPaused] = useState(false);
    const [ttsCursorIdx, setTtsCursorIdx] = useState<number | null>(null);
    const ttsSessionRef = useRef(0);
    const autoContinueChapterRef = useRef(false);

    // --- Audiobook (Sasayaki-grade) state ---
    const audioRef = useRef<HTMLAudioElement>(null);
    const mobileAudioInputRef = useRef<HTMLInputElement>(null);
    const mobileSrtInputRef = useRef<HTMLInputElement>(null);

    const [config, setConfig] = useState<EpubBookAudioConfig | null>(null);
    const [audioSrc, setAudioSrc] = useState<string>("");
    const [mobileObjectUrl, setMobileObjectUrl] = useState<string | null>(null);
    const [pendingSrtText, setPendingSrtText] = useState<string | null>(null);
    const [alignment, setAlignment] = useState<EpubAudioAlignment | null>(null);
    const [aligning, setAligning] = useState(false);
    const [audioError, setAudioError] = useState<string | null>(null);
    const [audioPlaying, setAudioPlaying] = useState(false);
    const [audioTime, setAudioTime] = useState(0);
    const [audioDuration, setAudioDuration] = useState(0);

    const lastCueIndexRef = useRef<number>(-1);
    const lastSavedTimeRef = useRef<number>(0);
    const pausedByLookupRef = useRef<boolean>(false);
    const restoredTimeRef = useRef<boolean>(false);

    const speakableParagraphs = useMemo(
        () => paragraphs.filter((p) => p.kind !== "image" && p.kind !== "separator" && p.text.trim().length > 0),
        [paragraphs],
    );

    const ttsSupported = typeof window !== "undefined" && "speechSynthesis" in window;

    // Load persisted audiobook link + cached full-book alignment when switching books
    useEffect(() => {
        let cancelled = false;
        setAudioError(null);
        setAudioPlaying(false);
        setAudioDuration(0);
        setPendingSrtText(null);
        lastCueIndexRef.current = -1;
        pausedByLookupRef.current = false;
        restoredTimeRef.current = false;

        const saved = loadBookAudioConfig(bookKey);
        setConfig(saved);
        setAudioTime(saved?.lastTimeSec || 0);

        if (saved?.audioPath && !isMobile) {
            void allowEpubAudioFile(saved.audioPath)
                .then(() => {
                    if (!cancelled) {
                        setAudioSrc(convertFileSrc(saved.audioPath));
                    }
                })
                .catch((err) => {
                    if (!cancelled) {
                        setAudioSrc("");
                        setAudioError(String(err));
                    }
                });
        } else {
            setAudioSrc("");
        }

        void loadEpubAudioAlignment(bookKey)
            .then((cached) => {
                if (!cancelled) setAlignment(cached);
            })
            .catch(() => {
                if (!cancelled) setAlignment(null);
            });

        return () => {
            cancelled = true;
        };
    }, [bookKey, isMobile]);

    // Notify parent Reader so aligned paragraphs can bind to Anki `subtitleScenes`
    useEffect(() => {
        if (!onAudiobookMediaChange) return;
        if (config?.audioPath && audioDuration > 0 && alignment) {
            onAudiobookMediaChange({
                audioPath: config.audioPath,
                duration: audioDuration,
                alignment,
            });
        } else {
            onAudiobookMediaChange(null);
        }
    }, [onAudiobookMediaChange, config?.audioPath, audioDuration, alignment]);

    // Cleanup object URL on unmount
    useEffect(() => () => {
        if (mobileObjectUrl) URL.revokeObjectURL(mobileObjectUrl);
        if (ttsSupported) {
            try {
                window.speechSynthesis.cancel();
            } catch {}
        }
    }, [mobileObjectUrl, ttsSupported]);

    const persistConfig = useCallback((next: EpubBookAudioConfig | null) => {
        setConfig(next);
        saveBookAudioConfig(bookKey, next);
    }, [bookKey]);

    const updateConfig = useCallback((patch: Partial<EpubBookAudioConfig>) => {
        setConfig((prev) => {
            if (!prev) return prev;
            const next = { ...prev, ...patch };
            saveBookAudioConfig(bookKey, next);
            return next;
        });
    }, [bookKey]);

    // Apply playback rate to <audio>
    useEffect(() => {
        if (audioRef.current) {
            audioRef.current.playbackRate = config?.playbackRate ?? DEFAULT_AUDIO_PREFS.playbackRate;
        }
    }, [config?.playbackRate, audioSrc]);

    // Auto-pause audiobook on dictionary lookup & auto-resume when lookup closes
    useEffect(() => {
        const el = audioRef.current;
        if (!el || !audioSrc || !(config?.autoPauseOnLookup ?? true)) return;
        if (lookupOpen) {
            if (!el.paused) {
                pausedByLookupRef.current = true;
                el.pause();
            }
        } else if (pausedByLookupRef.current) {
            pausedByLookupRef.current = false;
            void el.play().catch(() => {});
        }
    }, [lookupOpen, audioSrc, config?.autoPauseOnLookup]);

    // Reverse sync: Alt+Click paragraph or explicit request seeks audio to exact timestamp
    useEffect(() => {
        if (!seekToParagraphRequest || !alignment || !audioRef.current || !audioSrc) return;
        const found = findTimestampForParagraph(
            alignment.paragraphs,
            seekToParagraphRequest.chapterIndex,
            seekToParagraphRequest.paragraphIndex,
        );
        if (!found) return;
        audioRef.current.currentTime = found.startSec;
        setAudioTime(found.startSec);
        lastCueIndexRef.current = -1;
        if (audioRef.current.paused) {
            void audioRef.current.play().catch(() => {});
        }
    }, [seekToParagraphRequest, alignment, audioSrc]);

    // Active aligned cue & Audio -> Text auto-follow across pages and chapters
    const activeCue = useMemo(
        () => (alignment ? findAlignedCueAtTime(alignment.cues, audioTime) : null),
        [alignment, audioTime],
    );

    useEffect(() => {
        if (!audioPlaying || !(config?.autoFollow ?? true) || !activeCue) return;
        if (activeCue.index === lastCueIndexRef.current) return;
        lastCueIndexRef.current = activeCue.index;
        if (activeCue.chapterIndex === null || activeCue.paragraphIndex === null) return;
        if (activeCue.chapterIndex !== chapterIndex) {
            onJumpToChapterParagraph(activeCue.chapterIndex, activeCue.paragraphIndex);
        } else {
            onFocusParagraph(activeCue.paragraphIndex);
        }
    }, [
        audioPlaying,
        config?.autoFollow,
        activeCue,
        chapterIndex,
        onJumpToChapterParagraph,
        onFocusParagraph,
    ]);

    // --- Audiobook actions ---
    const handlePickAudiobook = useCallback(async () => {
        setAudioError(null);
        if (isMobile) {
            mobileAudioInputRef.current?.click();
            return;
        }
        try {
            const selected = await openDialog({
                multiple: false,
                directory: false,
                filters: [
                    {
                        name: "Audiobooks",
                        extensions: ["m4b", "m4a", "mp3", "ogg", "opus", "wav", "flac", "aac"],
                    },
                ],
            });
            const path = typeof selected === "string" ? selected.trim() : "";
            if (!path) return;

            const linkInfo = await allowEpubAudioFile(path);
            const nextCfg: EpubBookAudioConfig = {
                ...DEFAULT_AUDIO_PREFS,
                ...(config || {}),
                audioPath: linkInfo.audioPath,
                audioName: basename(linkInfo.audioPath),
                srtPath: linkInfo.companionSrt || config?.srtPath,
                srtName: linkInfo.companionSrt ? basename(linkInfo.companionSrt) : config?.srtName,
                cuePath: linkInfo.companionCue || config?.cuePath,
                cueName: linkInfo.companionCue ? basename(linkInfo.companionCue) : config?.cueName,
                lastTimeSec: config?.audioPath === linkInfo.audioPath ? (config.lastTimeSec || 0) : 0,
                updatedAt: Date.now(),
            };
            restoredTimeRef.current = false;
            persistConfig(nextCfg);
            setAudioSrc(convertFileSrc(linkInfo.audioPath));
            setAudioTime(nextCfg.lastTimeSec);
            setMode("audiobook");

            // If companion SRT was auto-detected in the same folder, align right away!
            if (linkInfo.companionSrt && bookPath) {
                setAligning(true);
                try {
                    const res = await alignEpubAudio(
                        bookPath,
                        linkInfo.companionSrt,
                        linkInfo.companionCue || null,
                        bookKey,
                    );
                    setAlignment(res);
                } catch (err) {
                    setAudioError(String(err));
                } finally {
                    setAligning(false);
                }
            }
        } catch (err) {
            setAudioError(String(err));
        }
    }, [isMobile, config, persistConfig, bookPath, bookKey]);

    const handlePickSrt = useCallback(async () => {
        setAudioError(null);
        if (isMobile) {
            mobileSrtInputRef.current?.click();
            return;
        }
        try {
            const selected = await openDialog({
                multiple: false,
                directory: false,
                filters: [{ name: "Subtitles", extensions: ["srt", "vtt"] }],
            });
            const path = typeof selected === "string" ? selected.trim() : "";
            if (!path) return;
            const nextCfg: EpubBookAudioConfig = {
                ...DEFAULT_AUDIO_PREFS,
                ...(config || { audioPath: "", audioName: "", lastTimeSec: 0 }),
                srtPath: path,
                srtName: basename(path),
                updatedAt: Date.now(),
            };
            persistConfig(nextCfg);
        } catch (err) {
            setAudioError(String(err));
        }
    }, [isMobile, config, persistConfig]);

    const handleRunMatch = useCallback(async () => {
        if (!bookPath) return;
        setAudioError(null);
        setAligning(true);
        try {
            let res: EpubAudioAlignment;
            if (config?.srtPath && !isMobile) {
                res = await alignEpubAudio(bookPath, config.srtPath, config.cuePath || null, bookKey);
            } else if (pendingSrtText) {
                res = await alignEpubAudioText(bookPath, pendingSrtText, null, bookKey);
            } else {
                setAudioError(t("epub.audioNeedSrt"));
                return;
            }
            setAlignment(res);
            lastCueIndexRef.current = -1;
        } catch (err) {
            setAudioError(String(err));
        } finally {
            setAligning(false);
        }
    }, [bookPath, config?.srtPath, config?.cuePath, isMobile, pendingSrtText, bookKey, t]);

    const handleRemoveAudiobook = useCallback(async () => {
        audioRef.current?.pause();
        if (mobileObjectUrl) {
            URL.revokeObjectURL(mobileObjectUrl);
            setMobileObjectUrl(null);
        }
        setAudioSrc("");
        setAudioPlaying(false);
        setAudioTime(0);
        setAudioDuration(0);
        setAlignment(null);
        setPendingSrtText(null);
        setAudioError(null);
        persistConfig(null);
        onFocusParagraph(null);
        await clearEpubAudioAlignment(bookKey).catch(() => {});
    }, [mobileObjectUrl, persistConfig, onFocusParagraph, bookKey]);

    const handleExportSrt = useCallback(() => {
        if (!alignment) return;
        const text = formatAlignmentAsSrt(alignment);
        const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `${(bookTitle || "audiobook").replace(/[\\/:*?"<>|]+/g, "_")}.srt`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        window.setTimeout(() => URL.revokeObjectURL(url), 1500);
    }, [alignment, bookTitle]);

    const toggleAudioPlay = useCallback(() => {
        const el = audioRef.current;
        if (!el || !audioSrc) return;
        pausedByLookupRef.current = false;
        if (el.paused) {
            void el.play().catch((err) => setAudioError(String(err)));
        } else {
            el.pause();
        }
    }, [audioSrc]);

    const seekAudioBy = useCallback((deltaSec: number) => {
        const el = audioRef.current;
        if (!el || !audioSrc) return;
        const max = Number.isFinite(el.duration) ? el.duration : audioDuration;
        const next = Math.min(max || 0, Math.max(0, el.currentTime + deltaSec));
        el.currentTime = next;
        setAudioTime(next);
        lastCueIndexRef.current = -1;
    }, [audioSrc, audioDuration]);

    const handleSyncAudioToPage = useCallback(() => {
        if (!alignment || !audioRef.current || !audioSrc) return;
        const found = findTimestampForParagraph(alignment.paragraphs, chapterIndex, startParagraphIndex);
        if (!found) return;
        audioRef.current.currentTime = found.startSec;
        setAudioTime(found.startSec);
        lastCueIndexRef.current = -1;
    }, [alignment, audioSrc, chapterIndex, startParagraphIndex]);

    // --- TTS logic ---
    useEffect(() => {
        if (!ttsSupported) return;
        const load = () => setVoices(window.speechSynthesis.getVoices() || []);
        load();
        window.speechSynthesis.addEventListener?.("voiceschanged", load);
        return () => window.speechSynthesis.removeEventListener?.("voiceschanged", load);
    }, [ttsSupported]);

    const sortedVoices = useMemo(() => {
        const targetPrefix = bookLanguage === "ja" ? "ja" : "en";
        return [...voices].sort((a, b) => {
            const aMatch = a.lang.toLowerCase().startsWith(targetPrefix) ? 0 : 1;
            const bMatch = b.lang.toLowerCase().startsWith(targetPrefix) ? 0 : 1;
            if (aMatch !== bMatch) return aMatch - bMatch;
            return a.name.localeCompare(b.name);
        });
    }, [voices, bookLanguage]);

    useEffect(() => {
        if (sortedVoices.length === 0) return;
        const targetPrefix = bookLanguage === "ja" ? "ja" : "en";
        const current = sortedVoices.find((v) => v.voiceURI === selectedVoiceUri);
        if (!current || !current.lang.toLowerCase().startsWith(targetPrefix)) {
            const preferred = sortedVoices.find((v) => v.lang.toLowerCase().startsWith(targetPrefix)) || sortedVoices[0];
            if (preferred) setSelectedVoiceUri(preferred.voiceURI);
        }
    }, [sortedVoices, bookLanguage, selectedVoiceUri]);

    const stopTts = useCallback(() => {
        ttsSessionRef.current += 1;
        autoContinueChapterRef.current = false;
        if (ttsSupported) {
            try {
                window.speechSynthesis.cancel();
            } catch {}
        }
        setTtsPlaying(false);
        setTtsPaused(false);
        setTtsCursorIdx(null);
        onFocusParagraph(null);
    }, [ttsSupported, onFocusParagraph]);

    const speakFromSpeakablePos = useCallback((speakablePos: number) => {
        if (!ttsSupported) return;
        const item = speakableParagraphs[speakablePos];
        if (!item) {
            if (chapterIndex + 1 < chapterCount) {
                autoContinueChapterRef.current = true;
                onAdvanceChapter();
            } else {
                stopTts();
            }
            return;
        }
        const session = ++ttsSessionRef.current;
        try {
            window.speechSynthesis.cancel();
        } catch {}

        const utter = new SpeechSynthesisUtterance(item.text);
        utter.lang = bookLanguage === "ja" ? "ja-JP" : "en-US";
        utter.rate = ttsRate;
        const voice = voices.find((v) => v.voiceURI === selectedVoiceUri);
        if (voice) {
            utter.voice = voice;
            utter.lang = voice.lang;
        }
        setTtsPlaying(true);
        setTtsPaused(false);
        setTtsCursorIdx(item.index);
        onFocusParagraph(item.index);

        utter.onend = () => {
            if (ttsSessionRef.current !== session) return;
            speakFromSpeakablePos(speakablePos + 1);
        };
        utter.onerror = (ev) => {
            if (ttsSessionRef.current !== session) return;
            if (ev.error === "interrupted" || ev.error === "canceled") return;
            setTtsPlaying(false);
            setTtsPaused(false);
        };
        window.speechSynthesis.speak(utter);
    }, [
        ttsSupported,
        speakableParagraphs,
        chapterIndex,
        chapterCount,
        onAdvanceChapter,
        stopTts,
        bookLanguage,
        ttsRate,
        voices,
        selectedVoiceUri,
        onFocusParagraph,
    ]);

    useEffect(() => {
        if (mode !== "tts" || !autoContinueChapterRef.current) return;
        if (speakableParagraphs.length === 0) return;
        autoContinueChapterRef.current = false;
        speakFromSpeakablePos(0);
    }, [mode, chapterIndex, speakableParagraphs, speakFromSpeakablePos]);

    const handleTtsPlayPause = useCallback(() => {
        if (!ttsSupported || speakableParagraphs.length === 0) return;
        if (ttsPlaying && !ttsPaused) {
            window.speechSynthesis.pause();
            setTtsPaused(true);
            return;
        }
        if (ttsPlaying && ttsPaused) {
            window.speechSynthesis.resume();
            setTtsPaused(false);
            return;
        }
        const startPos = speakableParagraphs.findIndex((p) => p.index >= startParagraphIndex);
        speakFromSpeakablePos(startPos >= 0 ? startPos : 0);
    }, [ttsSupported, speakableParagraphs, ttsPlaying, ttsPaused, startParagraphIndex, speakFromSpeakablePos]);

    const handleTtsStep = useCallback((delta: -1 | 1) => {
        if (speakableParagraphs.length === 0) return;
        const curIdx = ttsCursorIdx ?? startParagraphIndex;
        let pos = speakableParagraphs.findIndex((p) => p.index >= curIdx);
        if (pos < 0) pos = speakableParagraphs.length - 1;
        const nextPos = Math.min(speakableParagraphs.length - 1, Math.max(0, pos + delta));
        speakFromSpeakablePos(nextPos);
    }, [speakableParagraphs, ttsCursorIdx, startParagraphIndex, speakFromSpeakablePos]);

    const skipStep = config?.skipSeconds ?? DEFAULT_AUDIO_PREFS.skipSeconds;
    const playbackRate = config?.playbackRate ?? DEFAULT_AUDIO_PREFS.playbackRate;
    const autoFollow = config?.autoFollow ?? DEFAULT_AUDIO_PREFS.autoFollow;
    const autoPauseOnLookup = config?.autoPauseOnLookup ?? DEFAULT_AUDIO_PREFS.autoPauseOnLookup;

    const cycleSpeed = (current: number, setter: (next: number) => void) => {
        const idx = SPEED_OPTIONS.findIndex((s) => Math.abs(s - current) < 0.01);
        setter(SPEED_OPTIONS[(idx + 1) % SPEED_OPTIONS.length]);
    };

    const showMiniBar = !open && !zenMode && !bottomChromeVisible && !lookupOpen && Boolean(audioSrc);

    return (
        <>
            {/* Persistent <audio> element stays alive even while full Sasayaki sheet is closed */}
            <audio
                ref={audioRef}
                src={audioSrc || undefined}
                preload="metadata"
                onPlay={() => setAudioPlaying(true)}
                onPause={() => {
                    setAudioPlaying(false);
                    if (config && audioRef.current) {
                        updateConfig({ lastTimeSec: audioRef.current.currentTime });
                    }
                }}
                onEnded={() => setAudioPlaying(false)}
                onError={() => {
                    if (audioSrc) {
                        setAudioError(t("epub.audioDecodeError"));
                    }
                }}
                onLoadedMetadata={(e) => {
                    const el = e.currentTarget;
                    setAudioDuration(el.duration || 0);
                    el.playbackRate = playbackRate;
                    if (!restoredTimeRef.current && config?.lastTimeSec && config.lastTimeSec > 0 && config.lastTimeSec < (el.duration || 0)) {
                        restoredTimeRef.current = true;
                        el.currentTime = config.lastTimeSec;
                        setAudioTime(config.lastTimeSec);
                    }
                }}
                onTimeUpdate={(e) => {
                    const cur = e.currentTarget.currentTime;
                    setAudioTime(cur);
                    if (config && Math.abs(cur - lastSavedTimeRef.current) >= 5) {
                        lastSavedTimeRef.current = cur;
                        updateConfig({ lastTimeSec: cur });
                    }
                }}
            />

            {/* Mobile fallback file pickers */}
            <input
                ref={mobileAudioInputRef}
                type="file"
                accept="audio/*,.mp3,.m4a,.m4b,.ogg,.opus,.wav,.flac,.aac"
                style={{ display: "none" }}
                onChange={(e) => {
                    const f = e.target.files?.[0] || null;
                    e.target.value = "";
                    if (!f) return;
                    if (mobileObjectUrl) URL.revokeObjectURL(mobileObjectUrl);
                    const url = URL.createObjectURL(f);
                    setMobileObjectUrl(url);
                    setAudioSrc(url);
                    persistConfig({
                        ...DEFAULT_AUDIO_PREFS,
                        ...(config || {}),
                        audioPath: "",
                        audioName: f.name,
                        lastTimeSec: 0,
                        updatedAt: Date.now(),
                    });
                }}
            />
            <input
                ref={mobileSrtInputRef}
                type="file"
                accept=".srt,.vtt,text/vtt"
                style={{ display: "none" }}
                onChange={(e) => {
                    const f = e.target.files?.[0] || null;
                    e.target.value = "";
                    if (!f) return;
                    void f.text().then((txt) => {
                        setPendingSrtText(txt);
                        persistConfig({
                            ...DEFAULT_AUDIO_PREFS,
                            ...(config || { audioPath: "", audioName: "", lastTimeSec: 0 }),
                            srtName: f.name,
                            updatedAt: Date.now(),
                        });
                    });
                }}
            />

            {/* Unobtrusive bottom-left mini playback controls (Hoshi/Sasayaki style) */}
            {showMiniBar && (
                <div
                    className="epub-audio-mini"
                    onClick={(e) => e.stopPropagation()}
                >
                    <button
                        type="button"
                        className="epub-audio-mini-btn"
                        title={`−${skipStep}s`}
                        onClick={() => seekAudioBy(-skipStep)}
                    >
                        «
                    </button>
                    <button
                        type="button"
                        className={`epub-audio-mini-btn${audioPlaying ? " is-active" : ""}`}
                        onClick={toggleAudioPlay}
                    >
                        {audioPlaying ? "⏸" : "▶"}
                    </button>
                    <button
                        type="button"
                        className="epub-audio-mini-btn"
                        title={`+${skipStep}s`}
                        onClick={() => seekAudioBy(skipStep)}
                    >
                        »
                    </button>
                    <button
                        type="button"
                        className="epub-audio-mini-time"
                        title={t("epub.audioTitle")}
                        onClick={onOpenPanel}
                    >
                        {formatAudioTime(audioTime)}
                    </button>
                    {alignment && (
                        <button
                            type="button"
                            className="epub-audio-mini-btn"
                            title={t("epub.audioSyncToPage")}
                            onClick={handleSyncAudioToPage}
                        >
                            ⌖
                        </button>
                    )}
                </div>
            )}

            {/* Full Sasayaki-style Audio Sheet */}
            {open && (
                <div
                    className="epub-audio-bar epub-sasayaki-sheet"
                    role="dialog"
                    aria-label={t("epub.audioTitle")}
                    onClick={(e) => e.stopPropagation()}
                >
                    <div className="epub-audio-bar-top">
                        <div className="epub-segmented">
                            <button
                                type="button"
                                className={`epub-seg-btn${mode === "audiobook" ? " is-active" : ""}`}
                                onClick={() => {
                                    stopTts();
                                    setMode("audiobook");
                                }}
                            >
                                {t("epub.audiobookMode")}
                            </button>
                            <button
                                type="button"
                                className={`epub-seg-btn${mode === "tts" ? " is-active" : ""}`}
                                onClick={() => {
                                    audioRef.current?.pause();
                                    setMode("tts");
                                }}
                            >
                                {t("epub.ttsMode")}
                            </button>
                        </div>

                        <button
                            type="button"
                            className="epub-glass-btn epub-glass-circle"
                            aria-label={t("common.close")}
                            onClick={onClosePanel}
                        >
                            <IconClose />
                        </button>
                    </div>

                    {mode === "audiobook" ? (
                        <div className="epub-sasayaki-body">
                            {/* Header: Cover + Title + Transport */}
                            <div className="epub-sasayaki-hero">
                                <div className="epub-sasayaki-cover">
                                    {coverDataUrl ? (
                                        <img src={coverDataUrl} alt="" />
                                    ) : (
                                        <IconBookTab />
                                    )}
                                </div>
                                <div className="epub-sasayaki-meta">
                                    <div className="epub-sasayaki-title">{bookTitle}</div>
                                    {bookAuthor && <div className="epub-sasayaki-author">{bookAuthor}</div>}
                                    {activeCue && (
                                        <button
                                            type="button"
                                            className="epub-sasayaki-cue-preview"
                                            onClick={() => {
                                                if (activeCue.chapterIndex !== null && activeCue.paragraphIndex !== null) {
                                                    if (activeCue.chapterIndex !== chapterIndex) {
                                                        onJumpToChapterParagraph(activeCue.chapterIndex, activeCue.paragraphIndex);
                                                    } else {
                                                        onFocusParagraph(activeCue.paragraphIndex);
                                                    }
                                                }
                                            }}
                                        >
                                            {activeCue.text}
                                        </button>
                                    )}
                                </div>
                            </div>

                            {audioSrc && (
                                <div className="epub-sasayaki-transport">
                                    <input
                                        type="range"
                                        className="epub-audio-scrubber"
                                        min={0}
                                        max={Math.max(1, audioDuration)}
                                        step={0.25}
                                        value={Math.min(audioTime, Math.max(1, audioDuration))}
                                        onChange={(e) => {
                                            const next = Number(e.target.value);
                                            setAudioTime(next);
                                            if (audioRef.current) audioRef.current.currentTime = next;
                                            lastCueIndexRef.current = -1;
                                        }}
                                    />
                                    <div className="epub-sasayaki-transport-row">
                                        <span className="epub-audio-time-left">{formatAudioTime(audioTime)}</span>
                                        <div className="epub-sasayaki-transport-btns">
                                            <button
                                                type="button"
                                                className="epub-glass-btn"
                                                onClick={() => seekAudioBy(-skipStep)}
                                            >
                                                −{skipStep}s
                                            </button>
                                            <button
                                                type="button"
                                                className={`epub-glass-btn epub-audio-play-btn${audioPlaying ? " is-active" : ""}`}
                                                onClick={toggleAudioPlay}
                                            >
                                                {audioPlaying ? "⏸" : "▶"}
                                            </button>
                                            <button
                                                type="button"
                                                className="epub-glass-btn"
                                                onClick={() => seekAudioBy(skipStep)}
                                            >
                                                +{skipStep}s
                                            </button>
                                            <button
                                                type="button"
                                                className="epub-glass-btn epub-audio-speed-btn"
                                                title={t("epub.audioSpeed")}
                                                onClick={() =>
                                                    cycleSpeed(playbackRate, (next) => updateConfig({ playbackRate: next }))
                                                }
                                            >
                                                {playbackRate.toFixed(2).replace(/\.00$/, "").replace(/(\.\d)0$/, "$1")}×
                                            </button>
                                            {alignment && (
                                                <button
                                                    type="button"
                                                    className="epub-glass-btn"
                                                    title={t("epub.audioSyncToPage")}
                                                    onClick={handleSyncAudioToPage}
                                                >
                                                    ⌖ {t("epub.audioSyncToPageShort")}
                                                </button>
                                            )}
                                        </div>
                                        <span className="epub-audio-time-right">{formatAudioTime(audioDuration)}</span>
                                    </div>
                                </div>
                            )}

                            {audioError && <div className="epub-audio-error">{audioError}</div>}

                            {/* Sub-tabs: Resources | Chapters | Settings */}
                            <div className="epub-segmented epub-sasayaki-tabs">
                                <button
                                    type="button"
                                    className={`epub-seg-btn${audioTab === "resources" ? " is-active" : ""}`}
                                    onClick={() => setAudioTab("resources")}
                                >
                                    {t("epub.audioTabResources")}
                                </button>
                                <button
                                    type="button"
                                    className={`epub-seg-btn${audioTab === "chapters" ? " is-active" : ""}`}
                                    onClick={() => setAudioTab("chapters")}
                                >
                                    {t("epub.audioTabChapters")}
                                    {alignment && alignment.chapters.length > 0 ? ` (${alignment.chapters.length})` : ""}
                                </button>
                                <button
                                    type="button"
                                    className={`epub-seg-btn${audioTab === "settings" ? " is-active" : ""}`}
                                    onClick={() => setAudioTab("settings")}
                                >
                                    {t("epub.audioTabSettings")}
                                </button>
                            </div>

                            {audioTab === "resources" && (
                                <div className="epub-sasayaki-cards">
                                    <div className="epub-sasayaki-card">
                                        <div className="epub-sasayaki-card-info">
                                            <strong>{t("epub.audiobookMode")}</strong>
                                            <span>
                                                {config?.audioName
                                                    ? config.audioName
                                                    : t("epub.audioNoFile")}
                                            </span>
                                        </div>
                                        <div className="epub-sasayaki-card-actions">
                                            <button
                                                type="button"
                                                className="epub-glass-btn"
                                                onClick={() => void handlePickAudiobook()}
                                            >
                                                {config?.audioName ? t("epub.changeAudio") : t("epub.loadAudio")}
                                            </button>
                                            {config?.audioName && (
                                                <button
                                                    type="button"
                                                    className="epub-glass-btn is-danger"
                                                    onClick={() => void handleRemoveAudiobook()}
                                                >
                                                    {t("epub.audioRemove")}
                                                </button>
                                            )}
                                        </div>
                                    </div>

                                    <div className="epub-sasayaki-card">
                                        <div className="epub-sasayaki-card-info">
                                            <strong>{t("epub.loadSubtitles")}</strong>
                                            <span>
                                                {config?.srtName
                                                    ? config.srtName
                                                    : t("epub.audioNoSrt")}
                                            </span>
                                        </div>
                                        <div className="epub-sasayaki-card-actions">
                                            <button
                                                type="button"
                                                className="epub-glass-btn"
                                                onClick={() => void handlePickSrt()}
                                            >
                                                {t("epub.audioChooseSrt")}
                                            </button>
                                            <button
                                                type="button"
                                                className="btn-primary epub-match-btn"
                                                disabled={aligning || (!config?.srtPath && !pendingSrtText)}
                                                onClick={() => void handleRunMatch()}
                                            >
                                                {aligning ? t("epub.audioMatching") : t("epub.audioMatchBtn")}
                                            </button>
                                        </div>
                                    </div>

                                    {alignment && (
                                        <div className="epub-sasayaki-card epub-sasayaki-match-card">
                                            <div className="epub-sasayaki-card-info">
                                                <strong>{t("epub.audioCurrentMatch")}</strong>
                                                <span className="epub-match-stats">
                                                    {alignment.matchedChars.toLocaleString()} / {alignment.totalChars.toLocaleString()} ({alignment.matchPct.toFixed(1)}%)
                                                    {" · "}
                                                    {t("epub.audioMatchedCues", {
                                                        matched: alignment.matchedCues,
                                                        total: alignment.totalCues,
                                                    })}
                                                </span>
                                            </div>
                                            <div className="epub-sasayaki-card-actions">
                                                <button
                                                    type="button"
                                                    className="epub-glass-btn"
                                                    onClick={handleExportSrt}
                                                >
                                                    Export SRT
                                                </button>
                                            </div>
                                        </div>
                                    )}

                                    {alignment && (
                                        <div className="epub-sasayaki-tip">
                                            {t("epub.audioAltClickTip")}
                                        </div>
                                    )}
                                </div>
                            )}

                            {audioTab === "chapters" && (
                                <div className="epub-sasayaki-chapters">
                                    {!alignment || alignment.chapters.length === 0 ? (
                                        <div className="epub-audio-empty">{t("epub.audioNoChapters")}</div>
                                    ) : (
                                        alignment.chapters.map((ch, idx) => {
                                            const nextStart = alignment.chapters[idx + 1]?.startSec ?? Number.POSITIVE_INFINITY;
                                            const isCurrent = audioTime >= ch.startSec - 0.5 && audioTime < nextStart - 0.5;
                                            return (
                                                <button
                                                    key={`${ch.title}-${ch.startSec}-${idx}`}
                                                    type="button"
                                                    className={`epub-sasayaki-ch-row${isCurrent ? " is-active" : ""}`}
                                                    onClick={() => {
                                                        if (audioRef.current && audioSrc) {
                                                            audioRef.current.currentTime = ch.startSec;
                                                            setAudioTime(ch.startSec);
                                                            lastCueIndexRef.current = -1;
                                                        }
                                                        if (ch.chapterIndex !== null) {
                                                            const para = findTimestampForParagraph(alignment.paragraphs, ch.chapterIndex, 0);
                                                            onJumpToChapterParagraph(ch.chapterIndex, para?.paragraphIndex ?? 0);
                                                        }
                                                    }}
                                                >
                                                    <span className="epub-sasayaki-ch-title">{ch.title}</span>
                                                    <span className="epub-sasayaki-ch-time">{formatAudioTime(ch.startSec)}</span>
                                                </button>
                                            );
                                        })
                                    )}
                                </div>
                            )}

                            {audioTab === "settings" && (
                                <div className="epub-sasayaki-settings">
                                    <label className="epub-pop-row epub-pop-check-row">
                                        <span className="epub-pop-label">{t("epub.audioAutoFollow")}</span>
                                        <input
                                            type="checkbox"
                                            checked={autoFollow}
                                            onChange={(e) => updateConfig({ autoFollow: e.target.checked })}
                                            disabled={!config}
                                        />
                                    </label>
                                    <label className="epub-pop-row epub-pop-check-row">
                                        <span className="epub-pop-label">{t("epub.audioAutoPauseLookup")}</span>
                                        <input
                                            type="checkbox"
                                            checked={autoPauseOnLookup}
                                            onChange={(e) => updateConfig({ autoPauseOnLookup: e.target.checked })}
                                            disabled={!config}
                                        />
                                    </label>
                                    <div className="epub-pop-row">
                                        <span className="epub-pop-label">{t("epub.audioSkipStep")}</span>
                                        <div className="epub-segmented">
                                            {SKIP_OPTIONS.map((sec) => (
                                                <button
                                                    key={sec}
                                                    type="button"
                                                    className={`epub-seg-btn${skipStep === sec ? " is-active" : ""}`}
                                                    disabled={!config}
                                                    onClick={() => updateConfig({ skipSeconds: sec })}
                                                >
                                                    {sec}s
                                                </button>
                                            ))}
                                        </div>
                                    </div>
                                </div>
                            )}
                        </div>
                    ) : (
                        <div className="epub-audio-controls-row">
                            {!ttsSupported ? (
                                <span className="epub-audio-empty">{t("epub.ttsUnsupported")}</span>
                            ) : (
                                <>
                                    <button
                                        type="button"
                                        className="epub-glass-btn epub-glass-circle"
                                        title={t("epub.ttsPrevPara")}
                                        onClick={() => handleTtsStep(-1)}
                                    >
                                        ⏮
                                    </button>
                                    <button
                                        type="button"
                                        className={`epub-glass-btn epub-audio-play-btn${ttsPlaying && !ttsPaused ? " is-active" : ""}`}
                                        onClick={handleTtsPlayPause}
                                    >
                                        {ttsPlaying && !ttsPaused ? "⏸" : "▶"}
                                    </button>
                                    <button
                                        type="button"
                                        className="epub-glass-btn epub-glass-circle"
                                        title={t("epub.ttsStop")}
                                        onClick={stopTts}
                                        disabled={!ttsPlaying}
                                    >
                                        ■
                                    </button>
                                    <button
                                        type="button"
                                        className="epub-glass-btn epub-glass-circle"
                                        title={t("epub.ttsNextPara")}
                                        onClick={() => handleTtsStep(1)}
                                    >
                                        ⏭
                                    </button>
                                    <button
                                        type="button"
                                        className="epub-glass-btn epub-audio-speed-btn"
                                        title={t("epub.audioSpeed")}
                                        onClick={() => cycleSpeed(ttsRate, setTtsRate)}
                                    >
                                        {ttsRate.toFixed(2).replace(/\.00$/, "").replace(/(\.\d)0$/, "$1")}×
                                    </button>
                                    <select
                                        className="epub-audio-voice-select"
                                        aria-label={t("epub.ttsVoice")}
                                        value={selectedVoiceUri}
                                        onChange={(e) => setSelectedVoiceUri(e.target.value)}
                                    >
                                        {sortedVoices.length === 0 ? (
                                            <option value="">{t("epub.ttsDefaultVoice")}</option>
                                        ) : (
                                            sortedVoices.map((v) => (
                                                <option key={v.voiceURI} value={v.voiceURI}>
                                                    {v.name} ({v.lang})
                                                </option>
                                            ))
                                        )}
                                    </select>
                                </>
                            )}
                        </div>
                    )}
                </div>
            )}
        </>
    );
}
