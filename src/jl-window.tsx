import { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { IconPin } from "./components/Icons";
import type { AppSettings } from "./components/SettingsModal";
import type { DictEntry, LookupData } from "./components/Lookuper";
import "./jl-window.css";

type ResizeEdge = "East" | "North" | "NorthEast" | "NorthWest" | "South" | "SouthEast" | "SouthWest" | "West";
type CursorLookupResult = { entries: DictEntry[]; match_start: number; match_len: number; word: string };
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
    const [flashKey, setFlashKey] = useState(0);
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
    const lookupTrigger = settings.jlModeLookupTrigger || "click";
    const canHover = lookupTrigger === "hover" || lookupTrigger === "both";
    const canClick = lookupTrigger === "click" || lookupTrigger === "both";

    useEffect(() => { backlogRef.current = backlog; }, [backlog]);
    useEffect(() => { historyIndexRef.current = historyIndex; }, [historyIndex]);
    useEffect(() => { frozenRef.current = frozen; }, [frozen]);

    useEffect(() => {
        const root = document.documentElement;
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
        void invoke("hide_jl_lookup_window").catch(() => {});
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
        if (!frozenRef.current) {
            historyIndexRef.current = next.length - 1;
            setHistoryIndex(next.length - 1);
            setFlashKey((key) => key + 1);
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
        const offset = position?.offset ?? range?.startOffset ?? 0;
        if (!node || !host.contains(node)) return null;
        const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
        let consumed = 0;
        for (let current = walker.nextNode(); current; current = walker.nextNode()) {
            if (current === node) return consumed + offset;
            consumed += current.textContent?.length || 0;
        }
        return null;
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
        const popupWidth = 520;
        const popupHeight = 620;
        const screenLeft = window.screenX + rect.left;
        const screenTop = window.screenY + rect.bottom + 8;
        const x = clamp(screenLeft, 0, Math.max(0, window.screen.availWidth - popupWidth));
        const yBelow = screenTop + popupHeight <= window.screen.availHeight;
        const y = clamp(yBelow ? screenTop : window.screenY + rect.top - popupHeight - 8, 0, Math.max(0, window.screen.availHeight - popupHeight));
        const payload: Omit<LookupData, "rect"> = {
            entries: result.entries,
            word: result.word,
            sentence: currentLine,
            source: "internal",
        };
        await invoke("show_jl_lookup_window", { payload, x, y });
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
        const next = { ...settings, jlModeFontSize: clamp((Number(settings.jlModeFontSize) || 42) + delta, 12, 160) };
        const raw = JSON.stringify(next);
        settingsRawRef.current = raw;
        localStorage.setItem(SETTINGS_KEY, raw);
        setSettings(next);
    };

    const navigate = (delta: number) => {
        hideLookup();
        setHistoryIndex((index) => clamp(index + delta, 0, Math.max(0, backlog.length - 1)));
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

    const counter = backlog.length > 0 ? `${historyIndex + 1}/${backlog.length}` : "0/0";
    const controlsVisible = settings.jlModeShowControls !== false;

    return (
        <main className="jl-shell" data-flash={flashKey} onMouseDown={hideLookup}>
            <header className="jl-titlebar">
                <div className="jl-identity" data-tauri-drag-region>
                    <span className="jl-mark">FLOW</span>
                    <span className="jl-counter">{counter}</span>
                    {frozen && <span className="jl-frozen">{language === "en" ? "Pinned" : "Закреплено"}</span>}
                </div>
                <div
                    className="jl-drag-handle"
                    data-tauri-drag-region
                    title={language === "en" ? "Drag to move the window" : "Потяните, чтобы переместить окно"}
                />
                {controlsVisible && (
                    <nav className="jl-controls" aria-label={language === "en" ? "Flow controls" : "Управление Setsuna Flow"}>
                        <div className="jl-control-group">
                            <button onClick={() => navigate(-1)} disabled={historyIndex <= 0} aria-label={language === "en" ? "Previous line" : "Предыдущая строка"} title={language === "en" ? "Previous line (Ctrl+Up)" : "Предыдущая строка (Ctrl+Up)"}>‹</button>
                            <button onClick={() => navigate(1)} disabled={historyIndex >= backlog.length - 1} aria-label={language === "en" ? "Next line" : "Следующая строка"} title={language === "en" ? "Next line (Ctrl+Down)" : "Следующая строка (Ctrl+Down)"}>›</button>
                        </div>
                        <button className={`jl-timer-button ${timerPaused ? "" : "active"}`} onClick={toggleTimer} title={timerPaused ? (language === "en" ? "Start reading timer" : "Запустить таймер чтения") : (language === "en" ? "Stop reading timer" : "Остановить таймер чтения")}>
                            <span aria-hidden="true">{timerPaused ? "▶" : "■"}</span>
                            <span>{timerPaused ? (language === "en" ? "Start" : "Старт") : (language === "en" ? "Stop" : "Стоп")}</span>
                        </button>
                        <div className="jl-control-group">
                            <button className={frozen ? "active" : ""} onClick={() => setFrozen((value) => !value)} aria-label={language === "en" ? "Pin line" : "Закрепить строку"} title={language === "en" ? "Pin current line" : "Закрепить текущую строку"}><IconPin /></button>
                            <button onClick={copyCurrent} aria-label={language === "en" ? "Copy line" : "Копировать строку"} title={language === "en" ? "Copy line" : "Копировать строку"}>{copied ? "✓" : "⧉"}</button>
                        </div>
                        <div className="jl-control-group">
                            <button onClick={() => changeFont(-2)} title={language === "en" ? "Smaller text" : "Уменьшить текст"}>A−</button>
                            <button onClick={() => changeFont(2)} title={language === "en" ? "Larger text" : "Увеличить текст"}>A+</button>
                        </div>
                        <button onClick={() => { if (windowApi) void windowApi.minimize(); }} title={language === "en" ? "Minimize" : "Свернуть"}>−</button>
                        <button className="danger" onClick={() => void invoke("close_jl_mode_window")} title={language === "en" ? "Close" : "Закрыть"}>×</button>
                    </nav>
                )}
            </header>
            <div
                ref={textRef}
                className={`jl-text ${currentLine ? "" : "empty"}`}
                onMouseMove={(event) => {
                    if (!canHover || !currentLine) return;
                    if (hoverTimerRef.current !== null) window.clearTimeout(hoverTimerRef.current);
                    const x = event.clientX;
                    const y = event.clientY;
                    hoverTimerRef.current = window.setTimeout(() => void runLookupAt(x, y), clamp(Number(settings.jlModeHoverDelay) || 0, 0, 1000));
                }}
                onMouseLeave={() => {
                    if (hoverTimerRef.current !== null) window.clearTimeout(hoverTimerRef.current);
                }}
                onClick={(event) => { if (canClick) void runLookupAt(event.clientX, event.clientY); }}
                onWheel={(event) => {
                    if (!event.ctrlKey) return;
                    event.preventDefault();
                    changeFont(event.deltaY > 0 ? -2 : 2);
                }}
            >
                {currentLine || (language === "en" ? "Waiting for hooked text..." : "Ожидаю захваченный текст...")}
            </div>
            {(["North", "East", "South", "West", "NorthWest", "NorthEast", "SouthWest", "SouthEast"] as ResizeEdge[]).map((edge) => (
                <div key={edge} className={`jl-resize ${edge.toLowerCase()}`} onMouseDown={() => { if (windowApi) void windowApi.startResizeDragging(edge); }} />
            ))}
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
