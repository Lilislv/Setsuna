import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getTranslator, type AppLanguage } from "../../utils/i18n";
import { IconClose } from "../../components/Icons";
import type { EpubLanguage, EpubParagraph } from "./epubModel";
import {
    findActiveCueIndex,
    formatAudioTime,
    matchCueToParagraphIndex,
    parseSubtitles,
    type SubtitleCue,
} from "./epubSubtitles";

interface EpubAudioBarProps {
    open: boolean;
    language: AppLanguage;
    bookLanguage: EpubLanguage;
    chapterIndex: number;
    chapterCount: number;
    paragraphs: EpubParagraph[];
    startParagraphIndex: number;
    onFocusParagraph: (paragraphIndex: number | null) => void;
    onAdvanceChapter: () => void;
    onClose: () => void;
}

const SPEED_OPTIONS = [0.75, 0.9, 1.0, 1.15, 1.3, 1.5, 1.75, 2.0];

export default function EpubAudioBar({
    open,
    language,
    bookLanguage,
    chapterIndex,
    chapterCount,
    paragraphs,
    startParagraphIndex,
    onFocusParagraph,
    onAdvanceChapter,
    onClose,
}: EpubAudioBarProps) {
    const t = getTranslator(language);
    const [mode, setMode] = useState<"tts" | "audiobook">("tts");

    // --- TTS state ---
    const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
    const [selectedVoiceUri, setSelectedVoiceUri] = useState<string>("");
    const [ttsRate, setTtsRate] = useState<number>(1.0);
    const [ttsPlaying, setTtsPlaying] = useState(false);
    const [ttsPaused, setTtsPaused] = useState(false);
    const [ttsCursorIdx, setTtsCursorIdx] = useState<number | null>(null);
    const ttsSessionRef = useRef(0);
    const autoContinueChapterRef = useRef(false);

    // --- Audiobook state ---
    const audioRef = useRef<HTMLAudioElement>(null);
    const audioInputRef = useRef<HTMLInputElement>(null);
    const subInputRef = useRef<HTMLInputElement>(null);
    const [audioUrl, setAudioUrl] = useState<string | null>(null);
    const [audioFileName, setAudioFileName] = useState<string>("");
    const [audioPlaying, setAudioPlaying] = useState(false);
    const [audioTime, setAudioTime] = useState(0);
    const [audioDuration, setAudioDuration] = useState(0);
    const [audioRate, setAudioRate] = useState(1.0);
    const [cues, setCues] = useState<SubtitleCue[]>([]);
    const [subFileName, setSubFileName] = useState<string>("");
    const lastCueIdxRef = useRef<number>(-1);
    const lastMatchedParaRef = useRef<number>(startParagraphIndex);

    const speakableParagraphs = useMemo(
        () => paragraphs.filter((p) => p.kind !== "image" && p.kind !== "separator" && p.text.trim().length > 0),
        [paragraphs],
    );

    const ttsSupported = typeof window !== "undefined" && "speechSynthesis" in window;

    // Load available speech synthesis voices
    useEffect(() => {
        if (!ttsSupported) return;
        const load = () => {
            const list = window.speechSynthesis.getVoices() || [];
            setVoices(list);
        };
        load();
        window.speechSynthesis.addEventListener?.("voiceschanged", load);
        return () => {
            window.speechSynthesis.removeEventListener?.("voiceschanged", load);
        };
    }, [ttsSupported]);

    // Auto-select best voice matching book language
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

    // Stop TTS when bar closes or unmounts
    useEffect(() => {
        if (!open) {
            stopTts();
        }
    }, [open, stopTts]);

    useEffect(() => () => {
        if (ttsSupported) {
            try {
                window.speechSynthesis.cancel();
            } catch {}
        }
        if (audioUrl) {
            URL.revokeObjectURL(audioUrl);
        }
    }, [ttsSupported, audioUrl]);

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

    // Continue TTS automatically when chapter advances
    useEffect(() => {
        if (!open || mode !== "tts" || !autoContinueChapterRef.current) return;
        if (speakableParagraphs.length === 0) return;
        autoContinueChapterRef.current = false;
        speakFromSpeakablePos(0);
    }, [open, mode, chapterIndex, speakableParagraphs, speakFromSpeakablePos]);

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

    // --- Audiobook handlers ---
    const handlePickAudioFile = useCallback((file: File | null) => {
        if (!file) return;
        if (audioUrl) URL.revokeObjectURL(audioUrl);
        const nextUrl = URL.createObjectURL(file);
        setAudioUrl(nextUrl);
        setAudioFileName(file.name);
        setAudioTime(0);
        setAudioDuration(0);
        setAudioPlaying(false);
        lastCueIdxRef.current = -1;
    }, [audioUrl]);

    const handlePickSubtitleFile = useCallback(async (file: File | null) => {
        if (!file) return;
        try {
            const text = await file.text();
            const parsed = parseSubtitles(text);
            setCues(parsed);
            setSubFileName(file.name);
            lastCueIdxRef.current = -1;
        } catch {
            setCues([]);
        }
    }, []);

    const toggleAudioPlay = useCallback(() => {
        const el = audioRef.current;
        if (!el || !audioUrl) return;
        if (el.paused) {
            void el.play().catch(() => {});
        } else {
            el.pause();
        }
    }, [audioUrl]);

    const seekAudioBy = useCallback((deltaSec: number) => {
        const el = audioRef.current;
        if (!el || !audioUrl) return;
        const max = Number.isFinite(el.duration) ? el.duration : audioDuration;
        el.currentTime = Math.min(max || 0, Math.max(0, el.currentTime + deltaSec));
    }, [audioUrl, audioDuration]);

    useEffect(() => {
        if (audioRef.current) {
            audioRef.current.playbackRate = audioRate;
        }
    }, [audioRate, audioUrl]);

    const activeCueIdx = useMemo(
        () => (mode === "audiobook" && cues.length > 0 ? findActiveCueIndex(cues, audioTime) : -1),
        [mode, cues, audioTime],
    );
    const activeCue = activeCueIdx >= 0 ? cues[activeCueIdx] : null;

    // Sync active audiobook subtitle cue to matching EPUB paragraph
    useEffect(() => {
        if (!open || mode !== "audiobook" || activeCueIdx < 0 || activeCueIdx === lastCueIdxRef.current) {
            return;
        }
        lastCueIdxRef.current = activeCueIdx;
        const cue = cues[activeCueIdx];
        if (!cue) return;
        const matched = matchCueToParagraphIndex(cue.text, speakableParagraphs, lastMatchedParaRef.current);
        if (matched !== null) {
            lastMatchedParaRef.current = matched;
            onFocusParagraph(matched);
        }
    }, [open, mode, activeCueIdx, cues, speakableParagraphs, onFocusParagraph]);

    if (!open) return null;

    const cycleSpeed = (current: number, setter: (next: number) => void) => {
        const idx = SPEED_OPTIONS.findIndex((s) => Math.abs(s - current) < 0.01);
        const next = SPEED_OPTIONS[(idx + 1) % SPEED_OPTIONS.length];
        setter(next);
    };

    return (
        <div
            className="epub-audio-bar"
            role="region"
            aria-label={t("epub.audioTitle")}
            onClick={(e) => e.stopPropagation()}
        >
            <div className="epub-audio-bar-top">
                <div className="epub-segmented">
                    <button
                        type="button"
                        className={`epub-seg-btn${mode === "tts" ? " is-active" : ""}`}
                        onClick={() => setMode("tts")}
                    >
                        {t("epub.ttsMode")}
                    </button>
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
                </div>

                <button
                    type="button"
                    className="epub-glass-btn epub-glass-circle"
                    aria-label={t("common.close")}
                    onClick={() => {
                        stopTts();
                        audioRef.current?.pause();
                        onClose();
                    }}
                >
                    <IconClose />
                </button>
            </div>

            {mode === "tts" ? (
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
            ) : (
                <div className="epub-audiobook-body">
                    <audio
                        ref={audioRef}
                        src={audioUrl || undefined}
                        onPlay={() => setAudioPlaying(true)}
                        onPause={() => setAudioPlaying(false)}
                        onEnded={() => setAudioPlaying(false)}
                        onTimeUpdate={(e) => setAudioTime(e.currentTarget.currentTime)}
                        onLoadedMetadata={(e) => setAudioDuration(e.currentTarget.duration || 0)}
                    />
                    <input
                        ref={audioInputRef}
                        type="file"
                        accept="audio/*,.mp3,.m4a,.m4b,.ogg,.wav,.flac,.aac"
                        style={{ display: "none" }}
                        onChange={(e) => {
                            const f = e.target.files?.[0] || null;
                            e.target.value = "";
                            handlePickAudioFile(f);
                        }}
                    />
                    <input
                        ref={subInputRef}
                        type="file"
                        accept=".srt,.vtt,text/vtt"
                        style={{ display: "none" }}
                        onChange={(e) => {
                            const f = e.target.files?.[0] || null;
                            e.target.value = "";
                            void handlePickSubtitleFile(f);
                        }}
                    />

                    <div className="epub-audio-controls-row">
                        <button
                            type="button"
                            className="epub-glass-btn"
                            onClick={() => audioInputRef.current?.click()}
                        >
                            {audioFileName ? t("epub.changeAudio") : t("epub.loadAudio")}
                        </button>
                        <button
                            type="button"
                            className="epub-glass-btn"
                            onClick={() => subInputRef.current?.click()}
                            title={subFileName || undefined}
                        >
                            {cues.length > 0 ? `CC (${cues.length})` : t("epub.loadSubtitles")}
                        </button>

                        {audioUrl && (
                            <>
                                <button
                                    type="button"
                                    className="epub-glass-btn"
                                    onClick={() => seekAudioBy(-5)}
                                >
                                    −5s
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
                                    onClick={() => seekAudioBy(5)}
                                >
                                    +5s
                                </button>
                                <button
                                    type="button"
                                    className="epub-glass-btn epub-audio-speed-btn"
                                    title={t("epub.audioSpeed")}
                                    onClick={() => cycleSpeed(audioRate, setAudioRate)}
                                >
                                    {audioRate.toFixed(2).replace(/\.00$/, "").replace(/(\.\d)0$/, "$1")}×
                                </button>
                                <span className="epub-audio-time">
                                    {formatAudioTime(audioTime)} / {formatAudioTime(audioDuration)}
                                </span>
                            </>
                        )}
                    </div>

                    {audioUrl && (
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
                            }}
                        />
                    )}

                    {activeCue && (
                        <button
                            type="button"
                            className="epub-audio-sub-line"
                            onClick={() => {
                                const matched = matchCueToParagraphIndex(activeCue.text, speakableParagraphs, lastMatchedParaRef.current);
                                if (matched !== null) {
                                    lastMatchedParaRef.current = matched;
                                    onFocusParagraph(matched);
                                }
                            }}
                        >
                            {activeCue.text}
                        </button>
                    )}
                </div>
            )}
        </div>
    );
}
