import { useCallback, useEffect, useRef, useState } from "react";
import ReactDOM from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import LookupSurface from "./features/lookup/LookupSurface";
import type { DictEntry, LookupData, LookupScreenshotSource } from "./components/Lookuper";
import type { CaptureSourceBinding } from "./utils/constants";
import { DEFAULT_SETTINGS, themes } from "./utils/constants";
import { getDecks } from "./utils/anki";
import "./index.css";
import "./App.css";
import "./lookup-window.css";

type HoveredText = {
  x: number;
  y: number;
  text?: string | null;
  context?: string | null;
  cursor?: number | null;
};

type CursorLookup = {
  entries: DictEntry[];
  match_start: number;
  match_len: number;
  word: string;
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
): LookupData => ({
  rect: new DOMRect(10, 78, 0, 0),
  entries,
  word,
  sentence,
  source: "external",
  screenPoint: point,
});

const isEnglishToken = (value: string) => /^[A-Za-z]+(?:['’-][A-Za-z]+)*$/.test(value);

function ExternalLookupAgent() {
  const [settings, setSettings] = useState(readSettings);
  const [stack, setStack] = useState<LookupData[]>([]);
  const [status, setStatus] = useState("Alt+Q - lookup");
  const [captureWindows, setCaptureWindows] = useState<CaptureWindowInfo[]>([]);
  const [captureSource, setCaptureSource] = useState<CaptureSourceBinding | null>(readSavedCaptureSource);
  const [regionImage, setRegionImage] = useState<string | null>(null);
  const [loadingSources, setLoadingSources] = useState(false);
  const [ankiDecks, setAnkiDecks] = useState<string[]>([]);
  const [selectedDeck, setSelectedDeck] = useState("");
  const busyRef = useRef(false);

  const effectiveDeck = settings.ankiDeckMode === "contextual"
    ? (selectedDeck || settings.ankiGlobalDeck || settings.ankiDeck)
    : settings.ankiDeck;

  const screenshotSource: LookupScreenshotSource = regionImage
    ? { kind: "region", dataUrl: regionImage }
    : captureSource
      ? { kind: "process", captureSource }
      : { kind: "none" };

  const refreshCaptureWindows = useCallback(async () => {
    setLoadingSources(true);
    try {
      const windows = await invoke<CaptureWindowInfo[]>("get_capture_windows");
      setCaptureWindows(windows);
    } catch (error) {
      setStatus(`Не удалось получить процессы: ${String(error)}`);
    } finally {
      setLoadingSources(false);
    }
  }, []);

  const showAt = useCallback(async (point: { x: number; y: number }) => {
    await invoke("show_lookup_agent_window", point).catch(() => {});
  }, []);

  const activateLookup = useCallback(async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    let point = { x: 120, y: 120 };

    try {
      const hovered = await invoke<HoveredText>("copy_hovered_text_to_clipboard");
      point = { x: hovered.x, y: hovered.y };
      invoke("log_frontend_diagnostics", {
        payload: {
          source: "lookup-agent",
          event: "uia-result",
          textLen: hovered.text?.length || 0,
          contextLen: hovered.context?.length || 0,
          cursor: hovered.cursor,
          x: hovered.x,
          y: hovered.y,
          ts: Date.now(),
        },
      }).catch(() => {});
      const context = hovered.context?.trim() || "";
      const hoveredText = hovered.text?.trim() || "";
      let result: CursorLookup | null = null;
      let resultCameFromContext = false;

      if (hoveredText) {
        const query = isEnglishToken(hoveredText) ? hoveredText.toLowerCase() : hoveredText;
        const entries = await invoke<DictEntry[]>("lookup_word", { word: query }).catch(() => []);
        if (entries.length > 0) {
          result = {
            entries,
            match_start: 0,
            match_len: query.length,
            word: query,
          };
        }
      }

      if (!result && context && typeof hovered.cursor === "number") {
        result = await invoke<CursorLookup>("scan_cursor", {
          sentence: context,
          cursor: hovered.cursor,
        }).catch(() => null);
        resultCameFromContext = Boolean(result);
      }

      if (!result?.entries?.length) {
        setStack([]);
        setStatus("Под курсором нет доступного для чтения слова");
        await showAt(point);
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

      const nextSettings = readSettings();
      applyTheme(nextSettings);
      setSettings(nextSettings);
      setStatus("");
      setStack([makeLookupData(result.entries, result.word, context || hoveredText || result.word, point)]);
      await showAt(point);
    } catch (error) {
      setStack([]);
      setStatus(`Лукап не сработал: ${String(error)}`);
      await showAt(point);
    } finally {
      window.setTimeout(() => {
        busyRef.current = false;
      }, 180);
    }
  }, [showAt]);

  useEffect(() => {
    applyTheme(settings);
    invoke("update_lookup_agent_shortcut", {
      shortcut: settings.globalLookupShortcut || "Alt+Q",
    }).catch(() => {});
    void refreshCaptureWindows();
    getDecks().then((decks) => {
      setAnkiDecks(decks);
    }).catch(() => setAnkiDecks(settings.ankiDeck ? [settings.ankiDeck] : []));
  }, []);

  useEffect(() => {
    let disposed = false;
    const unlisteners: UnlistenFn[] = [];
    const register = async () => {
      unlisteners.push(await listen("lookup_agent_activate", () => void activateLookup()));
      unlisteners.push(await listen<{ image: string }>("lookup_region_selected", (event) => {
        setRegionImage(event.payload.image);
        setCaptureSource(null);
        setStatus("");
      }));
      unlisteners.push(await listen<{ error: string }>("lookup_region_failed", (event) => {
        setStatus(`Не удалось снять область: ${event.payload.error}`);
      }));
      if (disposed) unlisteners.splice(0).forEach((unlisten) => unlisten());
    };
    void register();
    return () => {
      disposed = true;
      unlisteners.splice(0).forEach((unlisten) => unlisten());
    };
  }, [activateLookup]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") invoke("hide_external_lookup_window").catch(() => {});
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const controls = (
    <header className="lookup-agent-toolbar">
      <div className="lookup-agent-titlebar">
        <div className="lookup-agent-title">
          <span className="lookup-agent-mark">S</span>
          <div><strong>Setsuna Lookup</strong><span>{stack[0]?.word || "Alt+Q"}</span></div>
        </div>
        <button
          type="button"
          className="lookup-agent-close"
          title="Закрыть"
          aria-label="Закрыть"
          onClick={() => invoke("hide_external_lookup_window").catch(() => {})}
        >
          ×
        </button>
      </div>
      <div className="lookup-agent-tools">
      <label className="lookup-agent-field lookup-agent-field-process">
        <span>Скриншот</span>
        <select
        aria-label="Процесс для скриншота"
        title="Процесс для скриншота"
        value={captureSource?.pid ? String(captureSource.pid) : ""}
        onFocus={() => void refreshCaptureWindows()}
        onChange={(event) => {
          const selected = captureWindows.find((window) => String(window.pid || "") === event.target.value);
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
        <option value="">{loadingSources ? "Обновляю..." : "Процесс для скрина"}</option>
        {captureWindows.map((window) => (
          <option key={`${window.id || window.pid}-${window.title}`} value={String(window.pid || "")}>
            {window.title || window.app_name || window.process_name}
          </option>
        ))}
        </select>
      </label>
      <button
        type="button"
        className={`lookup-agent-region ${regionImage ? "is-active" : ""}`}
        title="Выбрать область экрана"
        onClick={() => invoke("begin_lookup_region_capture").catch((error) => setStatus(String(error)))}
      >
        <span aria-hidden="true">▣</span><span>Область</span>
      </button>
      <label className="lookup-agent-field lookup-agent-field-deck">
        <span>Колода Anki</span>
        <select
          aria-label="Колода Anki"
          value={effectiveDeck || ""}
          disabled={settings.ankiDeckMode !== "contextual"}
          title={settings.ankiDeckMode === "contextual" ? "Колода для этой карточки" : "В настройках выбрана одна колода для всего"}
          onChange={(event) => {
            setSelectedDeck(event.target.value);
          }}
        >
          {!effectiveDeck && <option value="">Не выбрана</option>}
          {ankiDecks.map((deck) => <option key={deck} value={deck}>{deck}</option>)}
        </select>
      </label>
      <span className={`lookup-agent-source ${regionImage || captureSource ? "is-ready" : ""}`} title={regionImage ? "Выбранная область" : captureSource?.name || "Скриншот не настроен"}>
        {regionImage ? "Область готова" : captureSource ? "Процесс выбран" : "Без скрина"}
      </span>
      </div>
    </header>
  );

  return (
    <main className="lookup-agent-root">
      <LookupSurface
        mode="external"
        controls={controls}
        stack={stack}
        onAppend={(data) => setStack((previous) => [...previous, data])}
        onReplace={(data) => setStack([data])}
        onReplaceAt={(index, data) => setStack((previous) => [...previous.slice(0, index + 1), data])}
        onSlice={(index) => setStack((previous) => previous.slice(0, index + 1))}
        settings={settings}
        ankiDeck={effectiveDeck}
        captureSource={captureSource}
        screenshotSource={screenshotSource}
        playerClip={null}
      />
      {status && <div className="lookup-agent-status">{status}</div>}
    </main>
  );
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(<ExternalLookupAgent />);
