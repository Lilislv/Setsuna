import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import Lookuper, { type LookupData } from "./components/Lookuper";
import type { AppSettings } from "./components/SettingsModal";
import "./App.css";
import "./jl-popup.css";

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

    const append = useCallback((data: LookupData) => setStack((previous) => [...previous, data]), []);
    const replace = useCallback((data: LookupData) => setStack([data]), []);
    const replaceAt = useCallback((index: number, data: LookupData) => setStack((previous) => [...previous.slice(0, index + 1), data]), []);
    const slice = useCallback((index: number) => setStack((previous) => previous.slice(0, index + 1)), []);

    return (
        <main className="jl-popup-root">
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
