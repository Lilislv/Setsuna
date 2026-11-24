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
import { getTranslator, type AppLanguage } from "./utils/i18n";
import "./styles/design.css";
import { installAutoHideScrollbars } from "./utils/autoScrollbars";
installAutoHideScrollbars();
import "./styles/motion.css";
import "./index.css";
import "./App.css";
import "./lookup-window.css";
import { disableNativeContextMenu } from "./utils/nativeContextMenu";

disableNativeContextMenu();

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

  const pinnedRef = useRef(false);
  pinnedRef.current = pinned;
  const capturingRegionRef = useRef(false);
  const lastShownAtRef = useRef(0);
  const popupVisibleRef = useRef(false);
  const lastLiveKeyRef = useRef<string>("");
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
    const rawCombo = settings.globalLiveScanModifier || "Shift+KeyZ";
    const normalizedCombo = (rawCombo === "Shift" || rawCombo === "Alt") ? "Shift+KeyZ" : rawCombo;
    invoke("update_global_live_scan_config", {
      enabled: settings.globalLiveScanEnabled !== false,
      modifier: normalizedCombo,
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
      unlisteners.push(await listen<LiveLookupReady>("lookup_agent_ready", (event) => {
        if (event.payload?.entries?.length) {
          applyReadyPayload(event.payload);
        }
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
  }, [applyReadyPayload, hidePopup]);

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
            <p>{status || (isEn ? "Hold Shift+Z and hover over any word on screen." : "Зажми Shift+Z и наведи курсор на любое слово на экране.")}</p>
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
