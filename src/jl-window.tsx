import { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { IconPin } from "./components/Icons";
import type { AppSettings } from "./components/SettingsModal";
import type { DictEntry, LookupData } from "./components/Lookuper";
import { loadCustomFont } from "./utils/customFonts";
import "./styles/design.css";
import { installAutoHideScrollbars } from "./utils/autoScrollbars";
installAutoHideScrollbars();
import "./styles/motion.css";
import "./jl-window.css";
import { disableNativeContextMenu } from "./utils/nativeContextMenu";

disableNativeContextMenu();

type ResizeEdge = "East" | "North" | "NorthEast" | "NorthWest" | "South" | "SouthEast" | "SouthWest" | "West";
type CursorLookupResult = { entries: DictEntry[]; match_start: number; match_len: number; word: string };
type FlowStats = {
    tabName: string;
    chars: number;
    words: number;
    sentences: number;
    time: number;
    running: boolean;
    speedMetric: "chars" | "words" | "sentences";
    speedTimeframe: "minute" | "hour";
};

const formatClock = (seconds: number) => {
    const total = Math.max(0, Math.floor(seconds));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const sec = total % 60;
    return `${h > 0 ? `${h}:` : ""}${String(m).padStart(h > 0 ? 2 : 1, "0")}:${String(sec).padStart(2, "0")}`;
};
type CaretDocument = Document & {
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
};

const SETTINGS_KEY = "txthk-settings";
const LAST_LINE_KEY = "setsuna-jl-mode-last-line";
const BACKLOG_KEY = "setsuna-jl-mode-backlog-v2";
const windowApi = "__TAURI_INTERNALS__" in window ? getCurrentWindow() : null;

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

const readSettings = (): AppSettings => {
    try {
        return JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}") as AppSettings;
    } catch {
        return {} as AppSettings;
    }
};

const decodeInitialLine = () => {
    const value = new URLSearchParams(window.location.search).get("line");
    if (!value) return "";
    try {
        const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
        const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
        return new TextDecoder().decode(Uint8Array.from(atob(padded), (char) => char.charCodeAt(0))).trim();
    } catch {
        return "";
    }
};

const readBacklog = () => {
    try {
        const parsed = JSON.parse(localStorage.getItem(BACKLOG_KEY) || "[]");
        return Array.isArray(parsed) ? parsed.filter((line): line is string => typeof line === "string" && line.trim().length > 0) : [];
    } catch {
        return [] as string[];
    }
};

const normalizeLine = (value: unknown) => String(value || "").replace(/\r\n?/g, "\n").trim();

function JlWindow() {
    const initialLine = decodeInitialLine() || normalizeLine(localStorage.getItem(LAST_LINE_KEY));
    const [settings, setSettings] = useState(readSettings);
    const [backlog, setBacklog] = useState<string[]>(() => {
        const stored = readBacklog();
        if (initialLine && stored[stored.length - 1] !== initialLine) stored.push(initialLine);
        return stored.length > 0 ? stored : (initialLine ? [initialLine] : []);
    });
    const [historyIndex, setHistoryIndex] = useState(() => Math.max(0, backlog.length - 1));
    const [frozen, setFrozen] = useState(false);
    const [copied, setCopied] = useState(false);
    const [timerPaused, setTimerPaused] = useState(true);
    const [appearanceOpen, setAppearanceOpen] = useState(false);
    const [flashKey, setFlashKey] = useState(0);
    // Lines that arrived while an older line was on screen.
    const [newCount, setNewCount] = useState(0);
    const [stats, setStats] = useState<FlowStats | null>(null);
    // The control bar shows only when the pointer goes to the top edge.
    const [barVisible, setBarVisible] = useState(false);
    const barTimerRef = useRef(0);
    const emptyHoverTimerRef = useRef(0);
    const wheelRef = useRef({ delta: 0, at: 0 });
    const textRef = useRef<HTMLDivElement>(null);
    const backlogRef = useRef(backlog);
    const historyIndexRef = useRef(historyIndex);
    const frozenRef = useRef(frozen);
    const hoverTimerRef = useRef<number | null>(null);
    const lookupSerialRef = useRef(0);
    const lastLookupRef = useRef("");
    const settingsRawRef = useRef(localStorage.getItem(SETTINGS_KEY) || "{}");

    const currentLine = backlog[historyIndex] || "";
    const language = settings.appLanguage === "en" ? "en" : "ru";
    // "scan": dwelling on a word looks it up (no key needed — keys would go to
    // the game, which keeps focus); moving to the next word follows it, like
    // Shift-scanning. "click": a click on the word.
    const lookupMode = settings.jlModeLookupMode === "click" ? "click" : "scan";
    const canHover = lookupMode === "scan";
    const canClick = true;
    const scanDelay = clamp(Number(settings.jlModeScanDelay ?? 200), 0, 1000);

    useEffect(() => { backlogRef.current = backlog; }, [backlog]);
    useEffect(() => { historyIndexRef.current = historyIndex; }, [historyIndex]);
    useEffect(() => { frozenRef.current = frozen; }, [frozen]);

    useEffect(() => {
        const root = document.documentElement;
        void loadCustomFont(settings);
        root.style.setProperty("--jl-font", settings.jlModeFontFamily || settings.fontFamily || "'Noto Serif JP', 'Yu Mincho', 'Meiryo', serif");
        root.style.setProperty("--jl-font-size", `${clamp(Number(settings.jlModeFontSize) || 42, 12, 160)}px`);
        root.style.setProperty("--jl-padding", `${clamp(Number(settings.jlModePadding) || 18, 4, 80)}px`);
        root.style.setProperty("--jl-opacity", `${clamp(Number(settings.jlModeOpacity) || 72, 5, 100) / 100}`);
        root.style.setProperty("--jl-bg-rgb", hexToRgb(settings.jlModeBackgroundColor || "#050505"));
        root.style.setProperty("--jl-text", settings.jlModeTextColor || "#f4f4f4");
        root.style.setProperty("--jl-border", settings.jlModeBorderColor || "#5f5f5f");
        if (windowApi) void windowApi.setAlwaysOnTop(settings.jlModeAlwaysOnTop !== false);
    }, [settings]);

    useEffect(() => {
        const capacity = clamp(Number(settings.jlModeBacklogCapacity) || 300, 20, 5000);
        const trimmed = backlog.slice(-capacity);
        localStorage.setItem(BACKLOG_KEY, JSON.stringify(trimmed));
        if (trimmed.length !== backlog.length) {
            setBacklog(trimmed);
            setHistoryIndex((index) => Math.max(0, index - (backlog.length - trimmed.length)));
        }
    }, [backlog, settings.jlModeBacklogCapacity]);

    const hideLookup = useCallback(() => {
        lastLookupRef.current = "";
        window.getSelection()?.removeAllRanges();
        void invoke("hide_jl_lookup_window").catch(() => {});
    }, []);

    const persistSettings = useCallback((patch: Partial<AppSettings>) => {
        setSettings((current) => {
            const next = { ...current, ...patch };
            const raw = JSON.stringify(next);
            settingsRawRef.current = raw;
            localStorage.setItem(SETTINGS_KEY, raw);
            return next;
        });
    }, []);

    const appendLine = useCallback((raw: unknown) => {
        const line = normalizeLine(raw);
        if (!line) return;
        const lines = backlogRef.current;
        if (lines[lines.length - 1] === line) return;
        const capacity = clamp(Number(readSettings().jlModeBacklogCapacity) || 300, 20, 5000);
        const next = [...lines, line].slice(-capacity);
        backlogRef.current = next;
        setBacklog(next);
        localStorage.setItem(LAST_LINE_KEY, line);
        // Follow new text only while the newest line is shown; when an older
        // line is on screen (scrolled back with the wheel) or the line is
        // pinned, keep it and count the new ones instead.
        const wasLive = historyIndexRef.current >= lines.length - 1;
        if (!frozenRef.current && wasLive) {
            historyIndexRef.current = next.length - 1;
            setHistoryIndex(next.length - 1);
            setFlashKey((key) => key + 1);
        } else {
            setNewCount((count) => count + 1);
        }
        if (readSettings().jlModeHideLookupOnNewText !== false) hideLookup();
    }, [hideLookup]);

    useEffect(() => {
        let unlisten: (() => void) | undefined;
        listen<string>("jl_mode_line", (event) => appendLine(event.payload)).then((fn) => { unlisten = fn; });
        invoke<string>("get_jl_mode_line").then(appendLine).catch(() => {});
        const settingsTimer = window.setInterval(() => {
            const raw = localStorage.getItem(SETTINGS_KEY) || "{}";
            if (raw === settingsRawRef.current) return;
            settingsRawRef.current = raw;
            setSettings(readSettings());
        }, 700);
        const lineTimer = window.setInterval(() => invoke<string>("get_jl_mode_line").then(appendLine).catch(() => {}), 900);
        return () => {
            unlisten?.();
            window.clearInterval(settingsTimer);
            window.clearInterval(lineTimer);
        };
    }, [appendLine]);

    useEffect(() => {
        let unlisten: (() => void) | undefined;
        listen<FlowStats>("flow_stats", (event) => setStats(event.payload)).then((fn) => { unlisten = fn; });
        return () => unlisten?.();
    }, []);

    useEffect(() => {
        let disposed = false;
        const syncTimer = () => {
            void invoke<boolean>("get_flow_timer_state")
                .then((paused) => {
                    if (!disposed) setTimerPaused(paused);
                })
                .catch(() => {});
        };
        syncTimer();
        const timer = window.setInterval(syncTimer, 250);
        return () => {
            disposed = true;
            window.clearInterval(timer);
        };
    }, []);

    const caretIndexFromPoint = useCallback((x: number, y: number) => {
        const host = textRef.current;
        if (!host) return null;
        const caretDocument = document as CaretDocument;
        const position = caretDocument.caretPositionFromPoint?.(x, y);
        const range = !position ? caretDocument.caretRangeFromPoint?.(x, y) : null;
        const node = position?.offsetNode || range?.startContainer || null;
        let offset = position?.offset ?? range?.startOffset ?? 0;
        if (!node || !host.contains(node)) return null;
        // The caret sits between characters: over the right half of a character
        // it lands after it. Use the character whose box actually contains the
        // pointer (the one after the caret, else the one before it).
        if (node.nodeType === Node.TEXT_NODE) {
            const length = node.textContent?.length || 0;
            const contains = (index: number) => {
                if (index < 0 || index >= length) return false;
                const charRange = document.createRange();
                charRange.setStart(node, index);
                charRange.setEnd(node, index + 1);
                return Array.from(charRange.getClientRects()).some((rect) =>
                    rect.width > 0 && x >= rect.left && x < rect.right && y >= rect.top && y < rect.bottom);
            };
            if (!contains(offset) && contains(offset - 1)) offset -= 1;
        }
        const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
        let consumed = 0;
        for (let current = walker.nextNode(); current; current = walker.nextNode()) {
            if (current === node) return consumed + offset;
            consumed += current.textContent?.length || 0;
        }
        return null;
    }, []);

    const pointTouchesText = useCallback((x: number, y: number) => {
        const host = textRef.current;
        if (!host) return false;
        const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
            if (!node.textContent?.trim()) continue;
            const range = document.createRange();
            range.selectNodeContents(node);
            for (const rect of Array.from(range.getClientRects())) {
                if (x >= rect.left - 3 && x <= rect.right + 3 && y >= rect.top - 3 && y <= rect.bottom + 3) {
                    return true;
                }
            }
        }
        return false;
    }, []);

    const selectMatch = useCallback((start: number, length: number) => {
        const host = textRef.current;
        const selection = window.getSelection();
        if (!host || !selection || start < 0 || length <= 0) return null;
        const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
        let consumed = 0;
        let startNode: Node | null = null;
        let endNode: Node | null = null;
        let startOffset = 0;
        let endOffset = 0;
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
            const nodeLength = node.textContent?.length || 0;
            if (!startNode && consumed + nodeLength > start) {
                startNode = node;
                startOffset = start - consumed;
            }
            if (startNode && consumed + nodeLength >= start + length) {
                endNode = node;
                endOffset = start + length - consumed;
                break;
            }
            consumed += nodeLength;
        }
        if (!startNode || !endNode) return null;
        const range = document.createRange();
        range.setStart(startNode, startOffset);
        range.setEnd(endNode, endOffset);
        selection.removeAllRanges();
        selection.addRange(range);
        return range.getBoundingClientRect();
    }, []);

    const showLookup = useCallback(async (result: CursorLookupResult, fallbackX: number, fallbackY: number) => {
        if (!result?.entries?.length || !result.word) return;
        const key = `${historyIndexRef.current}|${result.match_start}|${result.match_len}|${result.word}`;
        if (key === lastLookupRef.current) return;
        lastLookupRef.current = key;
        const rect = selectMatch(result.match_start, result.match_len) || new DOMRect(fallbackX, fallbackY, 1, 1);
        const payload: Omit<LookupData, "rect"> = {
            entries: result.entries,
            word: result.word,
            sentence: currentLine,
            source: "internal",
        };
        // Screen position of the word; the backend fits the lookup window
        // under it (or above when there is no room) within the monitor.
        // Place the lookup under (or above) the whole Flow card, not just under
        // the word, so it never covers the line being scanned.
        const card = document.querySelector(".flow-card")?.getBoundingClientRect();
        const anchor = {
            x: window.screenX + rect.left,
            top: window.screenY + (card?.top ?? rect.top),
            bottom: window.screenY + (card?.bottom ?? rect.bottom),
        };
        await invoke("show_jl_lookup_window", { payload, anchor });
    }, [currentLine, selectMatch]);

    const runLookupAt = useCallback(async (x: number, y: number, explicitCursor?: number) => {
        if (!currentLine) return;
        const cursor = explicitCursor ?? caretIndexFromPoint(x, y);
        if (cursor === null || cursor < 0) return;
        const serial = ++lookupSerialRef.current;
        try {
            const result = await invoke<CursorLookupResult>("scan_cursor", { sentence: currentLine, cursor });
            if (serial !== lookupSerialRef.current) return;
            await showLookup(result, x, y);
        } catch {
            // No dictionary result is a normal state while moving over punctuation.
        }
    }, [caretIndexFromPoint, currentLine, showLookup]);

    useEffect(() => {
        lastLookupRef.current = "";
        if (!currentLine || settings.jlModeAutoLookupFirstWord !== true || historyIndex !== backlog.length - 1) return;
        const first = currentLine.search(/[A-Za-z\u3040-\u30ff\u3400-\u9fff]/);
        if (first >= 0) window.setTimeout(() => void runLookupAt(30, 44, first), 80);
    }, [currentLine, historyIndex, backlog.length, settings.jlModeAutoLookupFirstWord, runLookupAt]);

    const changeFont = (delta: number) => {
        persistSettings({ jlModeFontSize: clamp((Number(settings.jlModeFontSize) || 42) + delta, 12, 160) });
    };

    const navigate = (delta: number) => {
        hideLookup();
        setHistoryIndex((index) => {
            const next = clamp(index + delta, 0, Math.max(0, backlogRef.current.length - 1));
            if (next >= backlogRef.current.length - 1) setNewCount(0);
            return next;
        });
    };

    const showBarSoon = () => {
        window.clearTimeout(barTimerRef.current);
        barTimerRef.current = window.setTimeout(() => setBarVisible(true), 140);
    };
    const hideBarSoon = () => {
        window.clearTimeout(barTimerRef.current);
        barTimerRef.current = window.setTimeout(() => setBarVisible(false), 650);
    };
    useEffect(() => () => window.clearTimeout(barTimerRef.current), []);

    const goLatest = () => {
        hideLookup();
        setFrozen(false);
        setNewCount(0);
        setHistoryIndex(Math.max(0, backlogRef.current.length - 1));
    };

    // Mouse wheel over the window walks through the lines; Ctrl+wheel resizes text.
    const onWheel = (event: React.WheelEvent) => {
        if (event.ctrlKey) {
            event.preventDefault();
            changeFont(event.deltaY > 0 ? -2 : 2);
            return;
        }
        const text = textRef.current;
        // Let a long line scroll first; switch lines only at its edges.
        if (text && text.scrollHeight > text.clientHeight + 2) {
            const atTop = text.scrollTop <= 0;
            const atBottom = text.scrollTop + text.clientHeight >= text.scrollHeight - 2;
            if ((event.deltaY < 0 && !atTop) || (event.deltaY > 0 && !atBottom)) return;
        }
        const now = performance.now();
        const wheel = wheelRef.current;
        if (now - wheel.at > 400) wheel.delta = 0;
        wheel.at = now;
        wheel.delta += event.deltaY;
        if (Math.abs(wheel.delta) < 60) return;
        navigate(wheel.delta > 0 ? 1 : -1);
        wheel.delta = 0;
    };

    const copyCurrent = async () => {
        if (!currentLine) return;
        try { await writeText(currentLine); } catch { await navigator.clipboard.writeText(currentLine); }
        setCopied(true);
        window.setTimeout(() => setCopied(false), 900);
    };

    const toggleTimer = () => {
        const optimisticState = !timerPaused;
        setTimerPaused(optimisticState);
        void invoke<boolean>("toggle_flow_timer")
            .then(setTimerPaused)
            .catch(() => setTimerPaused(!optimisticState));
    };

    useEffect(() => {
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key === "Escape") { hideLookup(); return; }
            if (event.ctrlKey && event.key === "ArrowUp") { event.preventDefault(); navigate(-1); }
            if (event.ctrlKey && event.key === "ArrowDown") { event.preventDefault(); navigate(1); }
        };
        window.addEventListener("keydown", onKeyDown);
        return () => window.removeEventListener("keydown", onKeyDown);
    }, [backlog.length, hideLookup]);

    const isEn = language === "en";
    const L = (en: string, ru: string) => (isEn ? en : ru);
    const isLive = historyIndex >= backlog.length - 1;
    const counter = backlog.length > 0 ? `${historyIndex + 1} / ${backlog.length}` : "0 / 0";
    const controlsVisible = settings.jlModeShowControls !== false;
    const running = stats ? stats.running : !timerPaused;
    const speedText = (() => {
        if (!stats || stats.time < 60) return "";
        const amount = stats.speedMetric === "words" ? stats.words : stats.speedMetric === "sentences" ? stats.sentences : stats.chars;
        const perMinute = stats.speedTimeframe === "minute";
        const value = Math.round((amount / stats.time) * (perMinute ? 60 : 3600));
        const unit = stats.speedMetric === "words" ? L("words", "слов") : stats.speedMetric === "sentences" ? L("sent.", "предл.") : L("ch", "с");
        return `${value.toLocaleString(isEn ? "en-US" : "ru-RU")} ${unit}/${perMinute ? L("min", "мин") : L("h", "ч")}`;
    })();
    const charsText = stats ? `${Math.round(stats.chars).toLocaleString(isEn ? "en-US" : "ru-RU")} ${L("chars", "симв.")}` : "";

    return (
        <main
            className={`flow-shell${isLive ? "" : " is-history"}${frozen ? " is-pinned" : ""}${controlsVisible ? "" : " no-controls"}${barVisible || appearanceOpen ? " is-bar" : ""}`}
            data-flash={flashKey}
            onWheel={onWheel}
        >
            {controlsVisible && (
                <header
                    className="flow-bar"
                    data-tauri-drag-region
                    onMouseEnter={() => { window.clearTimeout(barTimerRef.current); setBarVisible(true); }}
                    onMouseLeave={hideBarSoon}
                >
                    <div className="flow-group" >
                        <button onClick={() => navigate(-1)} disabled={historyIndex <= 0} title={L("Previous line (wheel up)", "Предыдущая строка (колесо вверх)")}>‹</button>
                        <span className="flow-counter">{counter}</span>
                        <button onClick={() => navigate(1)} disabled={isLive} title={L("Next line (wheel down)", "Следующая строка (колесо вниз)")}>›</button>
                    </div>
                    <button className={`flow-timer${running ? " is-running" : ""}`} onClick={toggleTimer} title={running ? L("Pause the reading timer", "Остановить таймер чтения") : L("Start the reading timer", "Запустить таймер чтения")}>
                        <span aria-hidden="true">{running ? "❚❚" : "▶"}</span>
                        {stats ? formatClock(stats.time) : (running ? L("Running", "Идёт") : L("Start", "Старт"))}
                    </button>
                    {(charsText || speedText) && (
                        <span className="flow-stats" data-tauri-drag-region>
                            {charsText}{charsText && speedText ? " · " : ""}{speedText && <b>{speedText}</b>}
                        </span>
                    )}
                    <span className="flow-spacer" data-tauri-drag-region />
                    <div className="flow-group">
                        <button className={frozen ? "active" : ""} onClick={() => setFrozen((value) => !value)} title={L("Pin this line", "Закрепить строку")}><IconPin /></button>
                        <button onClick={copyCurrent} title={L("Copy line", "Копировать строку")}>{copied ? "✓" : "⧉"}</button>
                    </div>
                    <div className="flow-group">
                        <button onClick={() => changeFont(-2)} title={L("Smaller text (Ctrl+wheel)", "Меньше текст (Ctrl+колесо)")}>A−</button>
                        <button onClick={() => changeFont(2)} title={L("Larger text (Ctrl+wheel)", "Больше текст (Ctrl+колесо)")}>A+</button>
                        <button
                            className={appearanceOpen ? "active" : ""}
                            onClick={(event) => { event.stopPropagation(); setAppearanceOpen((value) => !value); }}
                            title={L("Background opacity", "Прозрачность фона")}
                        >◐</button>
                    </div>
                    <div className="flow-group">
                        <button onClick={() => { if (windowApi) void windowApi.minimize(); }} title={L("Minimize", "Свернуть")}>−</button>
                        <button className="danger" onClick={() => void invoke("close_jl_mode_window")} title={L("Close Flow", "Закрыть Flow")}>×</button>
                    </div>
                </header>
            )}

            {controlsVisible && (
                <div className="flow-bar-zone" onMouseEnter={showBarSoon} onMouseLeave={hideBarSoon} aria-hidden="true">
                    <span className="flow-bar-grip" />
                </div>
            )}
            <section className="flow-card">
                <div
                    ref={textRef}
                    key={`${historyIndex}|${flashKey}`}
                    className={`flow-text ${currentLine ? "" : "empty"}`}
                    onMouseMove={(event) => {
                        if (!canHover || !currentLine) return;
                        if (hoverTimerRef.current !== null) window.clearTimeout(hoverTimerRef.current);
                        const x = event.clientX;
                        const y = event.clientY;
                        if (!pointTouchesText(x, y)) {
                            // Resting on empty space for a while puts the lookup away.
                            if (!emptyHoverTimerRef.current) {
                                emptyHoverTimerRef.current = window.setTimeout(() => {
                                    emptyHoverTimerRef.current = 0;
                                    hideLookup();
                                }, 1200);
                            }
                            return;
                        }
                        window.clearTimeout(emptyHoverTimerRef.current);
                        emptyHoverTimerRef.current = 0;
                        hoverTimerRef.current = window.setTimeout(() => void runLookupAt(x, y), scanDelay);
                    }}
                    onMouseLeave={() => {
                        if (hoverTimerRef.current !== null) window.clearTimeout(hoverTimerRef.current);
                        window.clearTimeout(emptyHoverTimerRef.current);
                        emptyHoverTimerRef.current = 0;
                    }}
                    onClick={(event) => {
                        setAppearanceOpen(false);
                        if (!canClick || !pointTouchesText(event.clientX, event.clientY)) {
                            hideLookup();
                            return;
                        }
                        void runLookupAt(event.clientX, event.clientY);
                    }}
                >
                    {currentLine || L("Waiting for text from the game…", "Жду текст из игры…")}
                </div>

                {/* Always-visible corner status: reading time, and where in the history you are. */}
                <div className="flow-status" aria-hidden="true">
                    {!isLive && <span className="flow-status-history">{L("History", "История")} {counter}</span>}
                    {stats && (
                        <span className={`flow-status-timer${running ? " is-running" : ""}`}>
                            <i />{formatClock(stats.time)}
                        </span>
                    )}
                </div>

                {!isLive && (
                    <button type="button" className="flow-latest" onClick={goLatest} title={L("Back to the newest line", "Вернуться к последней строке")}>
                        <span aria-hidden="true">↓</span>
                        {newCount > 0 ? L(`Latest · +${newCount}`, `К последней · +${newCount}`) : L("Latest", "К последней")}
                    </button>
                )}

                {appearanceOpen && (
                    <section className="flow-appearance" onMouseDown={(event) => event.stopPropagation()}>
                        <div className="flow-appearance-label">
                            <span>{L("Background", "Фон")}</span>
                            <strong>{clamp(Number(settings.jlModeOpacity) || 72, 5, 100)}%</strong>
                        </div>
                        <input
                            type="range"
                            min="5"
                            max="100"
                            step="1"
                            value={clamp(Number(settings.jlModeOpacity) || 72, 5, 100)}
                            onChange={(event) => persistSettings({ jlModeOpacity: Number(event.target.value) })}
                            aria-label={L("Background opacity", "Прозрачность фона")}
                        />
                    </section>
                )}

                {(["North", "East", "South", "West", "NorthWest", "NorthEast", "SouthWest", "SouthEast"] as ResizeEdge[]).map((edge) => (
                    <div key={edge} className={`jl-resize ${edge.toLowerCase()}`} onMouseDown={() => { if (windowApi) void windowApi.startResizeDragging(edge); }} />
                ))}
            </section>
        </main>
    );
}

const hexToRgb = (hex: string) => {
    const clean = hex.replace("#", "").trim();
    const full = clean.length === 3 ? clean.split("").map((char) => char + char).join("") : clean;
    const value = Number.parseInt(full, 16);
    if (!Number.isFinite(value)) return "5, 5, 5";
    return `${(value >> 16) & 255}, ${(value >> 8) & 255}, ${value & 255}`;
};

createRoot(document.getElementById("root")!).render(<JlWindow />);
