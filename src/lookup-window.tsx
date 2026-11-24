import { useCallback, useEffect, useRef, useState } from "react";
import ReactDOM from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import LookupSurface from "./features/lookup/LookupSurface";
import { TokenizedLine } from "./components/TextContainer";
import type { DictEntry, LookupData, LookupScreenshotSource } from "./components/Lookuper";
import type { CaptureSourceBinding } from "./utils/constants";
import { DEFAULT_SETTINGS, themes } from "./utils/constants";
import { loadCustomFont } from "./utils/customFonts";
import { getDecks } from "./utils/anki";
import { getTranslator, translateBackendError, type AppLanguage } from "./utils/i18n";
import "./styles/design.css";
import { installAutoHideScrollbars } from "./utils/autoScrollbars";
installAutoHideScrollbars();
import "./styles/motion.css";
import "./index.css";
import "./App.css";
import "./lookup-window.css";
import { disableNativeContextMenu } from "./utils/nativeContextMenu";

disableNativeContextMenu();

type HoveredText = {
  x: number;
  y: number;
  text?: string | null;
  context?: string | null;
  cursor?: number | null;
  source?: string | null;
  foreground_pid?: number | null;
  foreground_title?: string | null;
  foreground_process?: string | null;
};

type CursorLookup = {
  entries: DictEntry[];
  match_start: number;
  match_len: number;
  word: string;
};

type LiveLookupReady = {
  x: number;
  y: number;
  word: string;
  sentence: string;
  match_start: number;
  match_len: number;
  entries: DictEntry[];
  source: string;
  foreground_pid?: number | null;
  foreground_title?: string | null;
  foreground_process?: string | null;
};

type CaptureWindowInfo = {
  id?: number;
  title: string;
  app_name: string;
  process_name: string;
  path: string;
  pid?: number;
  width: number;
  height: number;
  is_focused?: boolean;
  is_recent?: boolean;
  icon?: string | null;
};

const SETTINGS_KEY = "txthk-settings";
const CAPTURE_SOURCE_KEY = "setsuna-external-lookup-capture-source";

const readSettings = () => {
  try {
    return { ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}") };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
};

const applyTheme = (settings: ReturnType<typeof readSettings>) => {
  const root = document.documentElement;
  const theme = themes[settings.theme as keyof typeof themes] || themes.dark;
  Object.entries(theme).forEach(([key, value]) => root.style.setProperty(key, String(value)));
  root.style.setProperty("--txt-font-size", `${settings.fontSize || DEFAULT_SETTINGS.fontSize}px`);
  root.style.setProperty(
    "--font-stack",
    '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif, "Yu Gothic", "Meiryo"',
  );
  root.style.setProperty("--txt-font-family", settings.fontFamily || DEFAULT_SETTINGS.fontFamily);
  void loadCustomFont(settings);
};

const readSavedCaptureSource = (): CaptureSourceBinding | null => {
  try {
    const parsed = JSON.parse(localStorage.getItem(CAPTURE_SOURCE_KEY) || "null") as CaptureSourceBinding | null;
    return parsed?.name ? parsed : null;
  } catch {
    return null;
  }
};

const makeLookupData = (
  entries: DictEntry[],
  word: string,
  sentence: string,
  point: { x: number; y: number },
  match?: { start: number; length: number },
): LookupData => ({
  rect: new DOMRect(0, 0, 0, 0),
  entries,
  word,
  sentence,
  source: "external",
  screenPoint: point,
  match,
});

const isEnglishToken = (value: string) => /^[A-Za-z]+(?:['’-][A-Za-z]+)*$/.test(value);
const HAS_LOOKUPABLE_CHARS_RE = /[\u3040-\u30ff\u3400-\u9fffA-Za-z]/;
const HAS_JAPANESE_RE = /[\u3040-\u30ff\u3400-\u9fff]/;

const currentTranslator = () => getTranslator(readSettings().appLanguage as AppLanguage);

function ExternalLookupAgent() {
  const [settings, setSettings] = useState(readSettings);
  const [stack, setStack] = useState<LookupData[]>([]);
  const [status, setStatus] = useState("");
  const [queryInput, setQueryInput] = useState("");
  const [contextSentence, setContextSentence] = useState("");
  const [activeMatch, setActiveMatch] = useState<{ start: number; length: number } | null>(null);
  const [captureSourceKind, setCaptureSourceKind] = useState<string>("");
  const [pinned, setPinned] = useState(false);
  const [toolsOpen, setToolsOpen] = useState(false);

  const [captureWindows, setCaptureWindows] = useState<CaptureWindowInfo[]>([]);
  const [captureSource, setCaptureSource] = useState<CaptureSourceBinding | null>(readSavedCaptureSource);
  const [autoCaptureSource, setAutoCaptureSource] = useState<CaptureSourceBinding | null>(null);
  const [regionImage, setRegionImage] = useState<string | null>(null);
  const [loadingSources, setLoadingSources] = useState(false);
  const [ankiDecks, setAnkiDecks] = useState<string[]>([]);
  const [selectedDeck, setSelectedDeck] = useState("");

  const busyRef = useRef(false);
  const pinnedRef = useRef(false);
  pinnedRef.current = pinned;
  const capturingRegionRef = useRef(false);
  const lastShownAtRef = useRef(0);
  const popupVisibleRef = useRef(false);
  const lastAnchorRef = useRef<{ x: number; y: number } | null>(null);
  const lastLiveKeyRef = useRef<string>("");
  const liveScanSeqRef = useRef(0);
  const lastPointRef = useRef<{ x: number; y: number }>({ x: 120, y: 120 });
  const searchInputRef = useRef<HTMLInputElement | null>(null);

  const language = (settings.appLanguage || "ru") as AppLanguage;
  const isEn = language === "en";
  const t = getTranslator(language);

  const effectiveDeck = settings.ankiDeckMode === "contextual"
    ? (selectedDeck || settings.ankiGlobalDeck || settings.ankiDeck)
    : settings.ankiDeck;

  const activeCaptureBinding = captureSource || autoCaptureSource;
  const screenshotSource: LookupScreenshotSource = regionImage
    ? { kind: "region", dataUrl: regionImage }
    : activeCaptureBinding
      ? { kind: "process", captureSource: activeCaptureBinding }
      : { kind: "none" };

  const hidePopup = useCallback((restoreFocus = false) => {
    popupVisibleRef.current = false;
    lastAnchorRef.current = null;
    lastLiveKeyRef.current = "";
    void invoke("hide_external_lookup_window", { restoreFocus }).catch(() => {});
  }, []);

  const refreshCaptureWindows = useCallback(async () => {
    setLoadingSources(true);
    try {
      const windows = await invoke<CaptureWindowInfo[]>("get_capture_windows");
      setCaptureWindows(windows);
    } catch (error) {
      setStatus(currentTranslator()("lookup.error.processes", { error: String(error) }));
    } finally {
      setLoadingSources(false);
    }
  }, []);

  const showAt = useCallback(async (
    point: { x: number; y: number },
    nextSettings?: ReturnType<typeof readSettings>,
    opts?: { focus?: boolean; smoothAnchor?: boolean },
  ) => {
    const cfg = nextSettings || readSettings();
    const width = Math.max(380, Math.min(720, Math.round((cfg.lookupWidth || 400) + 40)));
    const focus = opts?.focus ?? true;
    let targetPoint = point;
    // During continuous live hover-scan, avoid jittering the window position for small moves on the same line
    if (opts?.smoothAnchor && popupVisibleRef.current && lastAnchorRef.current) {
      const dx = Math.abs(point.x - lastAnchorRef.current.x);
      const dy = Math.abs(point.y - lastAnchorRef.current.y);
      if (dx < 110 && dy < 34) {
        targetPoint = lastAnchorRef.current;
      }
    }
    lastAnchorRef.current = targetPoint;
    popupVisibleRef.current = true;
    lastShownAtRef.current = Date.now();
    await invoke("show_lookup_agent_window", {
      x: targetPoint.x,
      y: targetPoint.y,
      width,
      height: 520,
      focus,
    }).catch(() => {});
  }, []);

  const runDirectQuery = useCallback(async (
    rawQuery: string,
    opts?: { sentence?: string; cursor?: number; boundaries?: number[]; lemma?: string; sourceKind?: string },
  ): Promise<{ start: number; length: number } | null> => {
    const trimmed = rawQuery.trim();
    if (!trimmed) {
      setStack([]);
      setStatus("");
      setActiveMatch(null);
      return null;
    }

    const sentence = (opts?.sentence ?? trimmed).trim();
    const cursor = typeof opts?.cursor === "number" ? opts.cursor : 0;
    let result: CursorLookup | null = null;

    if (opts?.sentence !== undefined) {
      result = await invoke<CursorLookup>("scan_cursor", {
        sentence,
        cursor,
        boundaries: opts?.boundaries,
      }).catch(() => null);
    }

    if (!result?.entries?.length) {
      result = await invoke<CursorLookup>("scan_cursor", {
        sentence: trimmed,
        cursor: 0,
      }).catch(() => null);
      if (result?.entries?.length && opts?.sentence !== undefined) {
        result = {
          ...result,
          match_start: cursor + result.match_start,
        };
      }
    }

    if (!result?.entries?.length) {
      const query = isEnglishToken(trimmed) ? trimmed.toLowerCase() : trimmed;
      const entries = await invoke<DictEntry[]>("lookup_word", { word: query }).catch(() => []);
      if (entries.length > 0) {
        result = {
          entries,
          match_start: cursor,
          match_len: Array.from(trimmed).length,
          word: query,
        };
      }
    }

    if (!result?.entries?.length && opts?.lemma) {
      const entries = await invoke<DictEntry[]>("lookup_word", { word: opts.lemma }).catch(() => []);
      if (entries.length > 0) {
        result = {
          entries,
          match_start: cursor,
          match_len: Array.from(trimmed).length,
          word: opts.lemma,
        };
      }
    }

    if (!result?.entries?.length) {
      setStack([]);
      setActiveMatch(null);
      setStatus(currentTranslator()("lookup.error.noWord"));
      return null;
    }

    const match = { start: result.match_start, length: Math.max(1, result.match_len) };
    setQueryInput(result.word);
    setActiveMatch(match);
    setStatus("");
    if (opts?.sourceKind) setCaptureSourceKind(opts.sourceKind);
    setStack([makeLookupData(result.entries, result.word, sentence || result.word, lastPointRef.current, match)]);
    return match;
  }, []);

  const lookupFromClipboard = useCallback(async () => {
    const raw = await invoke<string | null>("read_system_clipboard_text").catch(() => null);
    const clip = (raw || "").replace(/\s+/g, " ").trim();
    if (!clip) {
      setStatus(isEn ? "Clipboard is empty" : "Буфер обмена пуст");
      return;
    }
    const clipped = clip.length > 240 ? clip.slice(0, 240) : clip;
    setContextSentence(clipped);
    setCaptureSourceKind("clipboard");
    await runDirectQuery(clipped, { sentence: clipped, cursor: 0, sourceKind: "clipboard" });
  }, [isEn, runDirectQuery]);

  const activateLookup = useCallback(async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    const nextSettings = readSettings();
    applyTheme(nextSettings);
    setSettings(nextSettings);
    let point = lastPointRef.current;

    try {
      const hovered = await invoke<HoveredText>("copy_hovered_text_to_clipboard", {
        allowSelection: nextSettings.globalLookupUseSelection !== false,
        restoreClipboard: nextSettings.globalLookupRestoreClipboard !== false,
      });
      point = { x: hovered.x, y: hovered.y };
      lastPointRef.current = point;

      // Auto-bind foreground process for seamless Anki screenshots
      if (hovered.foreground_pid && (hovered.foreground_process || hovered.foreground_title)) {
        setAutoCaptureSource({
          name: hovered.foreground_process || hovered.foreground_title || "Window",
          active: true,
          pid: hovered.foreground_pid,
          sourceType: "local",
        });
      }

      const source = hovered.source || "none";
      const context = (hovered.context || "").trim();
      const hoveredText = (hovered.text || "").trim();
      const cursor = typeof hovered.cursor === "number" ? hovered.cursor : 0;

      // If nothing found under cursor or selected, check clipboard as a smart fallback
      if (!context && !hoveredText) {
        const clipRaw = await invoke<string | null>("read_system_clipboard_text").catch(() => null);
        const clip = (clipRaw || "").replace(/\s+/g, " ").trim();
        if (clip && clip.length <= 200 && HAS_LOOKUPABLE_CHARS_RE.test(clip)) {
          setContextSentence(clip);
          setCaptureSourceKind("clipboard");
          await runDirectQuery(clip, { sentence: clip, cursor: 0, sourceKind: "clipboard" });
          await showAt(point, nextSettings);
          return;
        }
        setStack([]);
        setContextSentence("");
        setActiveMatch(null);
        setQueryInput("");
        setCaptureSourceKind("");
        setStatus(
          (nextSettings.appLanguage || "ru") === "en"
            ? "No text under cursor — select text or type a word above."
            : "Текст под курсором не найден — выдели слово или введи в поиск сверху.",
        );
        await showAt(point, nextSettings);
        window.setTimeout(() => searchInputRef.current?.focus(), 40);
        return;
      }

      setCaptureSourceKind(source);
      setContextSentence(context || hoveredText);

      let result: CursorLookup | null = null;
      let resultCameFromContext = false;

      // 1. For selection: scan the selected text first (supports inflected Japanese & exact phrases)
      if (source === "selection" && hoveredText) {
        result = await invoke<CursorLookup>("scan_cursor", {
          sentence: hoveredText,
          cursor: 0,
        }).catch(() => null);
        if (!result?.entries?.length) {
          const query = isEnglishToken(hoveredText) ? hoveredText.toLowerCase() : hoveredText;
          const entries = await invoke<DictEntry[]>("lookup_word", { word: query }).catch(() => []);
          if (entries.length > 0) {
            result = {
              entries,
              match_start: 0,
              match_len: Array.from(hoveredText).length,
              word: query,
            };
          }
        }
      }

      // 2. For UIA / hover context: scan directly at exact cursor offset FIRST
      if (!result?.entries?.length && context) {
        result = await invoke<CursorLookup>("scan_cursor", {
          sentence: context,
          cursor,
        }).catch(() => null);
        if (result?.entries?.length) {
          resultCameFromContext = source === "uia";
        }
      }

      // 3. Fallback: try direct hoveredText token lookup
      if (!result?.entries?.length && hoveredText) {
        const query = isEnglishToken(hoveredText) ? hoveredText.toLowerCase() : hoveredText;
        const entries = await invoke<DictEntry[]>("lookup_word", { word: query }).catch(() => []);
        if (entries.length > 0) {
          result = {
            entries,
            match_start: 0,
            match_len: Array.from(hoveredText).length,
            word: query,
          };
        }
      }

      // 4. Last fallback for bounding-box estimates (Discord/Telegram): scan from start of captured phrase
      if (!result?.entries?.length && context && cursor > 0) {
        result = await invoke<CursorLookup>("scan_cursor", {
          sentence: context,
          cursor: 0,
        }).catch(() => null);
      }

      if (!result?.entries?.length) {
        setStack([]);
        setActiveMatch(null);
        setQueryInput(hoveredText || "");
        setStatus(currentTranslator()("lookup.error.noWord"));
        await showAt(point, nextSettings);
        window.setTimeout(() => searchInputRef.current?.focus(), 40);
        return;
      }

      if (resultCameFromContext) {
        await invoke("select_hovered_lookup_range", {
          x: point.x,
          y: point.y,
          matchStart: result.match_start,
          matchLen: result.match_len,
        }).catch(() => {});
      }

      const match = { start: result.match_start, length: Math.max(1, result.match_len) };
      setQueryInput(result.word);
      setActiveMatch(match);
      setStatus("");
      setStack([makeLookupData(result.entries, result.word, context || hoveredText || result.word, point, match)]);
      await showAt(point, nextSettings);
    } catch (error) {
      const translate = currentTranslator();
      setStack([]);
      setActiveMatch(null);
      setStatus(translate("lookup.error.failed", {
        error: translateBackendError(error, translate),
      }));
      await showAt(point, nextSettings);
    } finally {
      window.setTimeout(() => {
        busyRef.current = false;
      }, 140);
    }
  }, [runDirectQuery, showAt]);

  const handleLiveHoverScan = useCallback(async (hovered: HoveredText) => {
    const context = (hovered.context || "").trim();
    const hoveredText = (hovered.text || "").trim();
    const source = hovered.source || "uia";
    let cursor = typeof hovered.cursor === "number" ? hovered.cursor : 0;
    if (!context && !hoveredText) return;

    const liveKey = `${context}|${cursor}|${hoveredText}`;
    if (popupVisibleRef.current && lastLiveKeyRef.current === liveKey) {
      return;
    }

    const seq = ++liveScanSeqRef.current;
    const point = { x: hovered.x, y: hovered.y };
    lastPointRef.current = point;

    if (hovered.foreground_pid && (hovered.foreground_process || hovered.foreground_title)) {
      setAutoCaptureSource({
        name: hovered.foreground_process || hovered.foreground_title || "Window",
        active: true,
        pid: hovered.foreground_pid,
        sourceType: "local",
      });
    }

    // For bounding-box estimated cursors (Discord/Telegram), snap cursor to the start of the enclosing Japanese token
    if (source === "uia_name" && context && HAS_JAPANESE_RE.test(context)) {
      try {
        const tokens = await invoke<Array<{ start?: number; end?: number }>>("get_furigana", {
          text: context,
          contextBefore: "",
          contextAfter: "",
        });
        if (seq !== liveScanSeqRef.current) return;
        if (Array.isArray(tokens)) {
          const hit = tokens.find(
            (tk) => typeof tk.start === "number" && typeof tk.end === "number" && cursor >= tk.start && cursor < tk.end,
          );
          if (hit && typeof hit.start === "number") {
            cursor = hit.start;
          }
        }
      } catch {}
    }

    let result: CursorLookup | null = null;
    if (context) {
      result = await invoke<CursorLookup>("scan_cursor", {
        sentence: context,
        cursor,
      }).catch(() => null);
      if (seq !== liveScanSeqRef.current) return;
    }
    if (!result?.entries?.length && hoveredText) {
      const query = isEnglishToken(hoveredText) ? hoveredText.toLowerCase() : hoveredText;
      const entries = await invoke<DictEntry[]>("lookup_word", { word: query }).catch(() => []);
      if (seq !== liveScanSeqRef.current) return;
      if (entries.length > 0) {
        result = {
          entries,
          match_start: 0,
          match_len: Array.from(hoveredText).length,
          word: query,
        };
      }
    }

    if (!result?.entries?.length) return;

    const nextSettings = readSettings();
    applyTheme(nextSettings);
    setSettings(nextSettings);

    lastLiveKeyRef.current = liveKey;
    const match = { start: result.match_start, length: Math.max(1, result.match_len) };
    setCaptureSourceKind(source);
    setContextSentence(context || hoveredText);
    setQueryInput(result.word);
    setActiveMatch(match);
    setStatus("");
    setStack([makeLookupData(result.entries, result.word, context || hoveredText || result.word, point, match)]);
    await showAt(point, nextSettings, { focus: false, smoothAnchor: true });
  }, [showAt]);

  const applyReadyPayload = useCallback((ready: LiveLookupReady) => {
    const readyKey = `${ready.sentence}|${ready.match_start}|${ready.match_len}|${ready.word}`;
    if (popupVisibleRef.current && lastLiveKeyRef.current === readyKey) {
      return;
    }
    lastLiveKeyRef.current = readyKey;

    const nextSettings = readSettings();
    applyTheme(nextSettings);
    setSettings(nextSettings);

    const point = { x: ready.x, y: ready.y };
    lastPointRef.current = point;
    popupVisibleRef.current = true;
    lastShownAtRef.current = Date.now();

    if (ready.foreground_pid && (ready.foreground_process || ready.foreground_title)) {
      setAutoCaptureSource({
        name: ready.foreground_process || ready.foreground_title || "Window",
        active: true,
        pid: ready.foreground_pid,
        sourceType: "local",
      });
    }

    const match = { start: ready.match_start, length: Math.max(1, ready.match_len) };
    setCaptureSourceKind(ready.source || "uia");
    setContextSentence(ready.sentence || ready.word);
    setQueryInput(ready.word);
    setActiveMatch(match);
    setStatus("");
    setStack([makeLookupData(ready.entries, ready.word, ready.sentence || ready.word, point, match)]);
  }, []);

  useEffect(() => {
    applyTheme(settings);
    invoke("update_lookup_agent_shortcut", {
      shortcut: settings.globalLookupShortcut || "Alt+Q",
    }).catch(() => {});
    invoke("update_global_live_scan_config", {
      enabled: settings.globalLiveScanEnabled !== false,
      modifier: settings.globalLiveScanModifier || "Shift",
      lookupWidth: settings.lookupWidth || 400,
    }).catch(() => {});
    void refreshCaptureWindows();
    getDecks().then((decks) => {
      setAnkiDecks(decks);
    }).catch(() => setAnkiDecks(settings.ankiDeck ? [settings.ankiDeck] : []));

    const pullLatest = () => {
      void invoke<LiveLookupReady | null>("get_latest_live_lookup")
        .then((latest) => {
          if (latest && latest.entries?.length) {
            applyReadyPayload(latest);
          }
        })
        .catch(() => {});
    };
    pullLatest();
    const onVisibility = () => {
      if (document.visibilityState === "visible") {
        pullLatest();
      }
    };
    const pollId = window.setInterval(() => {
      if (document.visibilityState === "visible") {
        pullLatest();
      }
    }, 300);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.clearInterval(pollId);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [applyReadyPayload]);

  useEffect(() => {
    let disposed = false;
    const unlisteners: UnlistenFn[] = [];
    const register = async () => {
      unlisteners.push(await listen("lookup_agent_activate", () => void activateLookup()));
      unlisteners.push(await listen<LiveLookupReady>("lookup_agent_ready", (event) => {
        if (event.payload?.entries?.length) {
          applyReadyPayload(event.payload);
        }
      }));
      unlisteners.push(await listen<HoveredText>("lookup_agent_live_scan", (event) => {
        void handleLiveHoverScan(event.payload);
      }));
      unlisteners.push(await listen("lookup_agent_toggle_hide", () => {
        hidePopup(true);
      }));
      unlisteners.push(await listen("lookup_agent_outside_click", () => {
        const cfg = readSettings();
        if (pinnedRef.current || capturingRegionRef.current) return;
        if (cfg.globalLookupAutoClose === false) return;
        if (Date.now() - lastShownAtRef.current < 160) return;
        hidePopup(false);
      }));
      unlisteners.push(await listen("lookup_agent_escape", () => {
        if (capturingRegionRef.current) return;
        setStack((prev) => {
          if (prev.length > 1) return prev.slice(0, -1);
          hidePopup(false);
          return prev;
        });
      }));
      unlisteners.push(await listen("lookup_agent_blur", () => {
        const cfg = readSettings();
        if (pinnedRef.current || capturingRegionRef.current) return;
        if (cfg.globalLookupAutoClose === false) return;
        // Ignore transient focus flicker within 220ms of showing the popup
        if (Date.now() - lastShownAtRef.current < 220) return;
        hidePopup(false);
      }));
      unlisteners.push(await listen<{ image: string }>("lookup_region_selected", (event) => {
        capturingRegionRef.current = false;
        setRegionImage(event.payload.image);
        setCaptureSource(null);
        setStatus("");
      }));
      unlisteners.push(await listen<{ error: string }>("lookup_region_failed", (event) => {
        capturingRegionRef.current = false;
        setStatus(currentTranslator()("lookup.error.region", { error: event.payload.error }));
      }));
      if (disposed) unlisteners.splice(0).forEach((unlisten) => unlisten());
    };
    void register();
    return () => {
      disposed = true;
      unlisteners.splice(0).forEach((unlisten) => unlisten());
    };
  }, [activateLookup, handleLiveHoverScan, hidePopup]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setStack((prev) => {
          if (prev.length > 1) return prev.slice(0, -1);
          hidePopup(true);
          return prev;
        });
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [hidePopup]);

  const handleSentenceTokenLookup = useCallback(
    (token: string, sentence: string, cursor: number, boundaries?: number[], lemma?: string) => {
      return runDirectQuery(token, { sentence, cursor, boundaries, lemma });
    },
    [runDirectQuery],
  );

  const sourceBadgeLabel = captureSourceKind === "selection"
    ? (isEn ? "Selection" : "Выделение")
    : captureSourceKind === "clipboard"
      ? (isEn ? "Clipboard" : "Буфер")
      : captureSourceKind === "uia" || captureSourceKind === "scintilla"
        ? (isEn ? "Hover" : "Курсор")
        : captureSourceKind === "uia_name"
          ? (isEn ? "Text" : "Текст")
          : "";

  const showSentenceStrip = Boolean(
    contextSentence
    && (HAS_JAPANESE_RE.test(contextSentence) || contextSentence.includes(" ")),
  );

  return (
    <main className="lookup-agent-root">
      <header className="lookup-agent-header" data-tauri-drag-region>
        <form
          className="lookup-agent-search"
          onSubmit={(event) => {
            event.preventDefault();
            const q = queryInput.trim();
            if (!q) return;
            setContextSentence((prev) => (prev && prev.includes(q) ? prev : q));
            setCaptureSourceKind("manual");
            void runDirectQuery(q, { sentence: q, cursor: 0, sourceKind: "manual" });
          }}
        >
          <span className="lookup-agent-mark" data-tauri-drag-region>刹</span>
          <input
            ref={searchInputRef}
            type="text"
            className="lookup-agent-search-input"
            value={queryInput}
            onChange={(event) => setQueryInput(event.target.value)}
            placeholder={isEn ? "Type or paste a word…" : "Поиск слова…"}
            aria-label={isEn ? "Search dictionary" : "Поиск в словаре"}
          />
          {sourceBadgeLabel && <span className="lookup-agent-badge">{sourceBadgeLabel}</span>}
        </form>

        <div className="lookup-agent-actions">
          <button
            type="button"
            className="lookup-agent-icon-btn"
            title={isEn ? "Look up clipboard" : "Лукап из буфера обмена"}
            aria-label={isEn ? "Look up clipboard" : "Лукап из буфера обмена"}
            onClick={() => void lookupFromClipboard()}
          >
            📋
          </button>
          <button
            type="button"
            className={`lookup-agent-icon-btn${regionImage ? " is-active" : ""}`}
            title={t("lookupAgent.selectRegion")}
            aria-label={t("lookupAgent.selectRegion")}
            onClick={() => {
              capturingRegionRef.current = true;
              void invoke("begin_lookup_region_capture").catch((error) => {
                capturingRegionRef.current = false;
                setStatus(String(error));
              });
            }}
          >
            ▣
          </button>
          <button
            type="button"
            className={`lookup-agent-icon-btn${pinned ? " is-active" : ""}`}
            title={pinned
              ? (isEn ? "Pinned (click to auto-close on blur)" : "Закреплено (нажми, чтобы закрывалось при клике мимо)")
              : (isEn ? "Pin popup on top" : "Закрепить окно поверх всех")}
            aria-label={isEn ? "Pin popup" : "Закрепить окно"}
            aria-pressed={pinned}
            onClick={() => setPinned((prev) => !prev)}
          >
            📌
          </button>
          <button
            type="button"
            className={`lookup-agent-icon-btn${toolsOpen ? " is-active" : ""}`}
            title={isEn ? "Anki deck & screenshot source" : "Колода Anki и источник скриншота"}
            aria-label={isEn ? "Anki & screenshot options" : "Настройки Anki и скриншота"}
            onClick={() => {
              setToolsOpen((prev) => {
                if (!prev) void refreshCaptureWindows();
                return !prev;
              });
            }}
          >
            ⚙
          </button>
          <button
            type="button"
            className="lookup-agent-icon-btn lookup-agent-close"
            title={`${t("common.close")} (Esc)`}
            aria-label={t("common.close")}
            onClick={() => hidePopup(true)}
          >
            ×
          </button>
        </div>
      </header>

      {toolsOpen && (
        <div className="lookup-agent-drawer">
          <label className="lookup-agent-field">
            <span>{t("lookupAgent.screenshot")}</span>
            <select
              aria-label={t("lookupAgent.process")}
              value={captureSource?.pid ? String(captureSource.pid) : ""}
              onFocus={() => void refreshCaptureWindows()}
              onChange={(event) => {
                const selected = captureWindows.find((win) => String(win.pid || "") === event.target.value);
                if (!selected) {
                  setCaptureSource(null);
                  localStorage.removeItem(CAPTURE_SOURCE_KEY);
                  return;
                }
                const next: CaptureSourceBinding = {
                  name: selected.process_name || selected.app_name || selected.title,
                  active: true,
                  icon: selected.icon || undefined,
                  path: selected.path || undefined,
                  pid: selected.pid,
                  sourceType: "local",
                };
                setCaptureSource(next);
                setRegionImage(null);
                localStorage.setItem(CAPTURE_SOURCE_KEY, JSON.stringify(next));
              }}
            >
              <option value="">
                {autoCaptureSource
                  ? `${isEn ? "Auto" : "Авто"}: ${autoCaptureSource.name}`
                  : (loadingSources ? t("lookupAgent.refreshing") : t("lookupAgent.processPlaceholder"))}
              </option>
              {captureWindows.map((win) => (
                <option key={`${win.id || win.pid}-${win.title}`} value={String(win.pid || "")}>
                  {win.title || win.app_name || win.process_name}
                </option>
              ))}
            </select>
          </label>
          <label className="lookup-agent-field">
            <span>{t("lookupAgent.ankiDeck")}</span>
            <select
              aria-label={t("lookupAgent.ankiDeck")}
              value={effectiveDeck || ""}
              disabled={settings.ankiDeckMode !== "contextual"}
              title={settings.ankiDeckMode === "contextual" ? t("lookupAgent.deckForCard") : t("lookupAgent.deckSingleMode")}
              onChange={(event) => setSelectedDeck(event.target.value)}
            >
              {!effectiveDeck && <option value="">{t("lookupAgent.deckNotSelected")}</option>}
              {ankiDecks.map((deck) => <option key={deck} value={deck}>{deck}</option>)}
            </select>
          </label>
        </div>
      )}

      {showSentenceStrip && (
        <div
          className="lookup-agent-sentence"
          title={isEn ? "Click any word to look it up" : "Нажми на любое слово для поиска"}
        >
          <TokenizedLine
            text={contextSentence}
            searchQuery=""
            furiganaMode="none"
            activeRange={activeMatch}
            onLookupToken={handleSentenceTokenLookup}
          />
        </div>
      )}

      <div className="lookup-agent-body">
        {stack.length > 0 ? (
          <LookupSurface
            mode="external"
            stack={stack}
            onAppend={(data) => setStack((previous) => [...previous, data])}
            onReplace={(data) => setStack([data])}
            onReplaceAt={(index, data) => setStack((previous) => [...previous.slice(0, index + 1), data])}
            onSlice={(index) => setStack((previous) => previous.slice(0, index + 1))}
            settings={settings}
            ankiDeck={effectiveDeck}
            captureSource={activeCaptureBinding}
            screenshotSource={screenshotSource}
          />
        ) : (
          <div className="lookup-agent-empty">
            <p>{status || (isEn ? "Select text or hover over a word and press your hotkey." : "Выдели текст или наведи курсор на слово и нажми горячую клавишу.")}</p>
            <div className="lookup-agent-empty-actions">
              <button type="button" className="lookup-agent-pill-btn" onClick={() => void lookupFromClipboard()}>
                📋 {isEn ? "Look up clipboard" : "Из буфера обмена"}
              </button>
            </div>
          </div>
        )}
      </div>
    </main>
  );
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(<ExternalLookupAgent />);
