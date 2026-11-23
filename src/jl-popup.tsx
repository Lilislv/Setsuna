import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import Lookuper, { type LookupData } from "./components/Lookuper";
import type { AppSettings } from "./components/SettingsModal";
import { loadCustomFont } from "./utils/customFonts";
import "./styles/design.css";
import { installAutoHideScrollbars } from "./utils/autoScrollbars";
installAutoHideScrollbars();
import "./styles/motion.css";
import "./App.css";
import "./jl-popup.css";
import { disableNativeContextMenu } from "./utils/nativeContextMenu";

disableNativeContextMenu();

const SETTINGS_KEY = "txthk-settings";

const readSettings = (): AppSettings => {
    try {
        return JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}") as AppSettings;
    } catch {
        return {} as AppSettings;
    }
};

const normalizePayload = (payload: any): LookupData | null => {
    if (!payload || !Array.isArray(payload.entries) || payload.entries.length === 0) return null;
    return {
        ...payload,
        rect: new DOMRect(10, 8, 1, 1),
        source: "internal",
    } as LookupData;
};

function JlPopup() {
    const [settings, setSettings] = useState(readSettings);
    const [stack, setStack] = useState<LookupData[]>([]);
    const [loadError, setLoadError] = useState("");
    const settingsRawRef = useRef(localStorage.getItem(SETTINGS_KEY) || "{}");
    const payloadKeyRef = useRef("");
    const language = settings.appLanguage === "en" ? "en" : "ru";
    const popupSettings = useMemo(() => ({ ...settings, lookupHotkey: "__disabled__" }), [settings]);

    useEffect(() => {
        void loadCustomFont(settings);
    }, [settings]);

    useEffect(() => {
        let unlisten: (() => void) | undefined;
        const applyPayload = (payload: any) => {
            const data = normalizePayload(payload);
            if (!data) return;
            const firstEntry = data.entries[0];
            const key = [data.word, data.sentence, data.entries.length, firstEntry?.term, firstEntry?.dict_name].join("\u0000");
            if (key === payloadKeyRef.current) return;
            payloadKeyRef.current = key;
            setLoadError("");
            setStack([data]);
        };
        const refreshPayload = () => {
            void invoke<any>("get_jl_lookup_payload")
                .then(applyPayload)
                .catch((error) => setLoadError(String(error)));
        };
        listen<any>("jl_lookup_result", (event) => applyPayload(event.payload)).then((fn) => { unlisten = fn; });
        refreshPayload();
        const payloadTimer = window.setInterval(refreshPayload, 400);
        const timer = window.setInterval(() => {
            const raw = localStorage.getItem(SETTINGS_KEY) || "{}";
            if (raw === settingsRawRef.current) return;
            settingsRawRef.current = raw;
            setSettings(readSettings());
        }, 800);
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key === "Escape") void invoke("hide_jl_lookup_window");
        };
        window.addEventListener("keydown", onKeyDown);
        return () => {
            unlisten?.();
            window.clearInterval(payloadTimer);
            window.clearInterval(timer);
            window.removeEventListener("keydown", onKeyDown);
        };
    }, []);

    // The window is sized to the article: measure the rendered content and let
    // the backend resize (and re-place) the window, up to its maximum height.
    const rootRef = useRef<HTMLElement | null>(null);
    useEffect(() => {
        const root = rootRef.current;
        if (!root || typeof ResizeObserver === "undefined") return;
        let frame = 0;
        let lastHeight = 0;
        const report = () => {
            window.cancelAnimationFrame(frame);
            frame = window.requestAnimationFrame(() => {
                const popup = root.querySelector<HTMLElement>(".dict-popup");
                const content = root.querySelector<HTMLElement>(".dict-popup-content");
                if (!popup || !content) return;
                const styles = getComputedStyle(popup);
                const padding = parseFloat(styles.paddingTop) + parseFloat(styles.paddingBottom);
                const height = Math.ceil(content.scrollHeight + padding + 2);
                if (Math.abs(height - lastHeight) < 4) return;
                lastHeight = height;
                void invoke("fit_jl_lookup_window", { height }).catch(() => {});
            });
        };
        const observer = new ResizeObserver(report);
        const mutation = new MutationObserver(() => {
            const content = root.querySelector(".dict-popup-content");
            if (content) observer.observe(content);
            report();
        });
        mutation.observe(root, { childList: true, subtree: true });
        report();
        return () => {
            window.cancelAnimationFrame(frame);
            observer.disconnect();
            mutation.disconnect();
        };
    }, []);

    const append = useCallback((data: LookupData) => setStack((previous) => [...previous, data]), []);
    const replace = useCallback((data: LookupData) => setStack([data]), []);
    const replaceAt = useCallback((index: number, data: LookupData) => setStack((previous) => [...previous.slice(0, index + 1), data]), []);
    const slice = useCallback((index: number) => setStack((previous) => previous.slice(0, index + 1)), []);

    return (
        <main className="jl-popup-root" ref={rootRef}>
            <button
                type="button"
                className="jl-popup-close"
                onClick={() => void invoke("hide_jl_lookup_window")}
                aria-label={language === "en" ? "Close lookup" : "Закрыть словарь"}
                title={language === "en" ? "Close lookup" : "Закрыть словарь"}
            >
                ×
            </button>
            <div className="jl-popup-content">
                {stack.length === 0 && (
                    <div className="jl-popup-empty">
                        {loadError || (language === "en" ? "Loading lookup..." : "Загружаю словарную статью...")}
                    </div>
                )}
                <Lookuper
                    stack={stack}
                    onAppend={append}
                    onReplace={replace}
                    onReplaceAt={replaceAt}
                    onSlice={slice}
                    settings={popupSettings}
                    ankiDeck={settings.ankiDeck}
                    screenshotSource={{ kind: "internal" }}
                />
            </div>
        </main>
    );
}

createRoot(document.getElementById("root")!).render(<JlPopup />);
