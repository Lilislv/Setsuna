import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
    getDecks,
    getModels,
    getModelFields,
    clearAnkiMetaCache,
    getAnkiBackend,
    getAnkiDroidStatus,
    requestAnkiDroidPermission,
    invokeAnki,
} from "../../utils/anki";
import { AppSettings } from "../SettingsModal";

interface SettingsAnkiProps {
    settings: AppSettings;
    updateSetting: <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => void;
    updateMultipleSettings?: (newValues: Partial<AppSettings>) => void;
    highlightedSection: string | null;
    isOpen: boolean;
}

type AnkiConnectConfigResult = {
    path: string;
    changed: boolean;
    requiresAnkiRestart: boolean;
    origins: string[];
};

const labels = {
    ru: {
        connected: "подключено",
        disconnected: "не найдено",
        connecting: "Ищу Anki...",
        ready: "Готово к добавлению карточек",
        connect: "Подключить автоматически",
        openAnki: "Открыть Anki",
        addonTitle: "Нужен аддон AnkiConnect",
        addonHint: "В Anki откройте Инструменты → Дополнения → Установить по коду, вставьте код и перезапустите Anki.",
        addonPage: "Страница аддона",
        copyCode: "Скопировать код",
        copied: "Код скопирован",
        connectionFailed: "Setsuna не видит AnkiConnect. Проверьте, что Anki запущен и перезапущен после установки аддона.",
        refresh: "Обновить подключение",
        retry: "Проверить снова",
        connectHint: "Убедитесь, что Anki запущен и установлен аддон AnkiConnect (код 2055492159).",
        cardSettings: "Настройки карточки",
        deck: "Колода:",
        model: "Модель:",
        cardFormat: "Формат карточки",
        cardFormatHint: "По умолчанию используется безопасный пресет Lapis/Lapis++++. Ручные поля нужны только если карточка настроена необычно.",
        lapisPreset: "Пресет Lapis++++",
        showFields: "Открыть ручные настройки",
        hideFields: "Скрыть поля",
        activeModel: "Активная модель",
        modelHint: "Для Lapis/Lapis++++ поля выставляются автоматически. Если карточка добавляется неправильно, открой ручные настройки и проверь поля.",
        notSelected: "не выбрана",
        none: "-- пусто --",
        fields: {
            Word: "Слово",
            Reading: "Чтение",
            Meaning: "Перевод",
            Sentence: "Предложение",
            SentenceFurigana: "Фуригана предложения",
            Dict: "Словарь",
            Audio: "Аудио",
            Pitch: "Питч-акцент",
            Freq: "Частотность",
            Screenshot: "Скриншот",
        } as Record<string, string>,
        screenshots: "Скриншоты и кнопки",
        normalButton: "Показывать обычную кнопку добавления (+)",
        screenshotButton: "Показывать кнопку добавления со скриншотом (+ camera)",
        gameProcess: "Процессы игры для авто-скриншота:",
        processHint: "Можно выбрать несколько процессов. При добавлении карточки Setsuna попробует снять активное совпадающее окно, иначе самое крупное подходящее окно.",
        findGame: "Найти окно",
        processSearch: "Поиск по имени или пути процесса...",
        processPath: "Путь",
        pid: "PID",
        activeWindow: "активно",
        recentWindow: "недавно",
        windowTitle: "Окно",
        windowSize: "Размер",
        activeSources: "активных",
        testScreenshot: "Тест скрина",
        testScreenshotNoProcess: "Сначала выберите активный процесс для скриншотов.",
        testScreenshotError: "Не удалось сделать тестовый скриншот:\n",
        testScreenshotEmpty: "Скриншот не вернулся. Проверьте, что окно видно и не свернуто.",
        closePreview: "Закрыть",
        remoteAgent: "LAN capture-agent",
        startAgent: "Запустить агент",
        stopAgent: "Остановить",
        agentRunning: "Агент запущен",
        agentHint: "Запустите Setsuna на устройстве с VN и включите агент. На другом устройстве Setsuna сможет подключиться по URL и токену.",
        agentStartError: "Не удалось запустить capture-agent:\n",
        loading: "Загрузка...",
        duplicateCheck: "Проверка дублей (цветовая индикация)",
        newCard: "Новая:",
        otherDeck: "Уже есть (другая колода):",
        sameDeck: "Уже есть (эта колода):",
        allowOther: "Разрешить добавлять дубликаты из других колод",
        allowSame: "Разрешить добавлять дубликаты из этой же колоды",
    },
    en: {
        connected: "connected",
        disconnected: "not found",
        connecting: "Looking for Anki...",
        ready: "Ready to add cards",
        connect: "Connect automatically",
        openAnki: "Open Anki",
        addonTitle: "AnkiConnect add-on is required",
        addonHint: "In Anki, open Tools → Add-ons → Get Add-ons, paste the code, then restart Anki.",
        addonPage: "Add-on page",
        copyCode: "Copy code",
        copied: "Code copied",
        connectionFailed: "Setsuna cannot reach AnkiConnect. Make sure Anki is running and was restarted after installing the add-on.",
        refresh: "Refresh connection",
        retry: "Check again",
        connectHint: "Make sure Anki is running and the AnkiConnect add-on is installed (code 2055492159).",
        cardSettings: "Card settings",
        deck: "Deck:",
        model: "Model:",
        cardFormat: "Card format",
        cardFormatHint: "The safe Lapis/Lapis++++ preset is used by default. Manual fields are only needed for custom note types.",
        lapisPreset: "Lapis++++ preset",
        showFields: "Open manual settings",
        hideFields: "Hide fields",
        activeModel: "Active model",
        modelHint: "For Lapis/Lapis++++ fields are filled automatically. If cards are added incorrectly, open manual settings and check the fields.",
        notSelected: "not selected",
        none: "-- none --",
        fields: {
            Word: "Word",
            Reading: "Reading",
            Meaning: "Meaning",
            Sentence: "Sentence",
            SentenceFurigana: "Sentence furigana",
            Dict: "Dictionary",
            Audio: "Audio",
            Pitch: "Pitch accent",
            Freq: "Frequency",
            Screenshot: "Screenshot",
        } as Record<string, string>,
        screenshots: "Screenshots and buttons",
        normalButton: "Show normal add button (+)",
        screenshotButton: "Show screenshot add button (+ camera)",
        gameProcess: "Game processes for automatic screenshots:",
        processHint: "You can select several processes. When adding a card, Setsuna will try to capture the active matching window, otherwise the largest matching window.",
        findGame: "Find window",
        processSearch: "Search by process name or path...",
        processPath: "Path",
        pid: "PID",
        activeWindow: "active",
        recentWindow: "recent",
        windowTitle: "Window",
        windowSize: "Size",
        activeSources: "active",
        testScreenshot: "Test screenshot",
        testScreenshotNoProcess: "Select an active screenshot process first.",
        testScreenshotError: "Test screenshot failed:\n",
        testScreenshotEmpty: "No screenshot was returned. Make sure the window is visible and not minimized.",
        closePreview: "Close",
        remoteAgent: "LAN capture agent",
        startAgent: "Start agent",
        stopAgent: "Stop",
        agentRunning: "Agent running",
        agentHint: "Run Setsuna on the VN device and start the agent. Another Setsuna instance can connect by URL and token.",
        agentStartError: "Failed to start capture agent:\n",
        loading: "Loading...",
        duplicateCheck: "Duplicate check colors",
        newCard: "New:",
        otherDeck: "Already exists (other deck):",
        sameDeck: "Already exists (same deck):",
        allowOther: "Allow adding duplicates from other decks",
        allowSame: "Allow adding duplicates from the same deck",
    },
};

export default function SettingsAnki({ settings, updateSetting, updateMultipleSettings, highlightedSection, isOpen }: SettingsAnkiProps) {
    const t = labels[settings.appLanguage === "en" ? "en" : "ru"];
    const [ankiDecks, setAnkiDecks] = useState<string[]>([]);
    const [ankiModels, setAnkiModels] = useState<string[]>([]);
    const [ankiFields, setAnkiFields] = useState<string[]>([]);
    const [ankiConnected, setAnkiConnected] = useState(false);
    const [isConnecting, setIsConnecting] = useState(false);
    const [connectionError, setConnectionError] = useState("");
    const [ankiSetupMessage, setAnkiSetupMessage] = useState("");
    const [addonCodeCopied, setAddonCodeCopied] = useState(false);
    const [ankiBackend, setAnkiBackend] = useState<"ankiconnect" | "ankidroid">("ankiconnect");
    const [ankiDroidStatus, setAnkiDroidStatus] = useState<{
        available: boolean;
        packageName: string | null;
        permissionGranted: boolean;
        specVersion: number;
    } | null>(null);
    const [runningProcesses, setRunningProcesses] = useState<any[]>([]);
    const [isProcessMenuOpen, setIsProcessMenuOpen] = useState(false);
    const [processSearch, setProcessSearch] = useState("");
    const [showAdvancedFields, setShowAdvancedFields] = useState(false);
    const [isTestingScreenshot, setIsTestingScreenshot] = useState(false);
    const [screenshotPreview, setScreenshotPreview] = useState<string | null>(null);

    const loadAnkiData = async (): Promise<boolean> => {
        setIsConnecting(true);
        setConnectionError("");
        const backend = getAnkiBackend();
        setAnkiBackend(backend);
        if (backend === "ankidroid") {
            setAnkiDroidStatus(await getAnkiDroidStatus().catch(() => null));
        } else {
            setAnkiDroidStatus(null);
        }

        try {
            if (backend === "ankiconnect") await invokeAnki("version");
            clearAnkiMetaCache();
            const [decks, models] = await Promise.all([getDecks(true), getModels(true)]);
            const safeDecks = Array.isArray(decks) ? decks : [];
            const safeModels = Array.isArray(models) ? models : [];
            setAnkiDecks(safeDecks);
            setAnkiModels(safeModels);

            const preferredDeck = settings.ankiDeck && safeDecks.includes(settings.ankiDeck)
                ? settings.ankiDeck
                : safeDecks[0] || "";
            const preferredModel = settings.ankiModel && safeModels.includes(settings.ankiModel)
                ? settings.ankiModel
                : safeModels.find((model) => /lapis/i.test(model)) || safeModels[0] || "";
            const patch: Partial<AppSettings> = {};
            if (preferredDeck && preferredDeck !== settings.ankiDeck) patch.ankiDeck = preferredDeck;
            if (preferredModel && preferredModel !== settings.ankiModel) patch.ankiModel = preferredModel;
            if (settings.ankiDeckMode === "contextual" && !settings.ankiGlobalDeck && preferredDeck) {
                patch.ankiGlobalDeck = preferredDeck;
            }
            if (Object.keys(patch).length > 0) {
                if (updateMultipleSettings) updateMultipleSettings(patch);
                else Object.entries(patch).forEach(([key, value]) => updateSetting(key as keyof AppSettings, value as any));
            }

            if (preferredModel) {
                const fields = await getModelFields(preferredModel, true);
                setAnkiFields(fields);
            }
            setAnkiConnected(true);
            return true;
        } catch (error) {
            setAnkiConnected(false);
            setAnkiDecks([]);
            setAnkiModels([]);
            setConnectionError(error instanceof Error && error.name !== "AbortError" ? error.message : t.connectionFailed);
            return false;
        } finally {
            setIsConnecting(false);
        }
    };

    useEffect(() => { if (isOpen) loadAnkiData(); }, [isOpen]);
    useEffect(() => { if (settings.ankiModel && isOpen) getModelFields(settings.ankiModel).then(setAnkiFields); }, [settings.ankiModel, isOpen]);

    const requestAndroidAnkiPermission = async () => {
        await requestAnkiDroidPermission();
        await loadAnkiData();
    };

    const launchAnkiAndConnect = async () => {
        setConnectionError("");
        setAnkiSetupMessage("");
        let configResult: AnkiConnectConfigResult | null = null;
        let configError = "";
        try {
            try {
                configResult = await invoke<AnkiConnectConfigResult>("configure_ankiconnect");
            } catch (error) {
                configError = String(error);
            }
            await invoke("launch_anki");
            let serviceReady = false;
            for (let attempt = 0; attempt < 20; attempt += 1) {
                await new Promise((resolve) => window.setTimeout(resolve, attempt === 0 ? 1200 : 1000));
                try {
                    await invokeAnki("version");
                    serviceReady = true;
                    break;
                } catch {
                    // Anki can take a while to load the profile and start AnkiConnect.
                }
            }
            if (!serviceReady) {
                throw new Error(settings.appLanguage === "en"
                    ? "Anki started, but AnkiConnect did not open port 8765 within 20 seconds. Check that add-on 2055492159 is enabled, then restart Anki."
                    : "Anki запущен, но AnkiConnect не открыл порт 8765 за 20 секунд. Проверьте, что аддон 2055492159 включён, затем перезапустите Anki.");
            }
            const connected = await loadAnkiData();
            if (connected) {
                setAnkiSetupMessage(settings.appLanguage === "en"
                    ? "AnkiConnect is configured and ready."
                    : "AnkiConnect настроен и готов к работе.");
            } else if (configResult?.requiresAnkiRestart) {
                setAnkiSetupMessage(settings.appLanguage === "en"
                    ? "Setsuna fixed the AnkiConnect config. Fully close and reopen Anki once, then check the connection again."
                    : "Setsuna исправила конфиг AnkiConnect. Полностью закройте и снова откройте Anki один раз, затем повторите проверку.");
            } else if (configError) {
                setConnectionError((current) => `${current || t.connectionFailed}\n${configError}`);
            }
        } catch (error) {
            setConnectionError(String(error));
        }
    };

    const copyAddonCode = async () => {
        try {
            await writeText("2055492159");
        } catch {
            await navigator.clipboard.writeText("2055492159");
        }
        setAddonCodeCopied(true);
        window.setTimeout(() => setAddonCodeCopied(false), 1800);
    };

    const normalizeFieldName = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, "");
    const findField = (...candidates: string[]) => {
        const normalizedCandidates = candidates.map(normalizeFieldName);
        return ankiFields.find((field) => normalizedCandidates.includes(normalizeFieldName(field))) || "none";
    };

    const applyLapisPreset = (force = true) => {
        if (ankiFields.length === 0) return;
        const preset: Partial<AppSettings> = {
            ankiFieldWord: findField("Expression"),
            ankiFieldReading: findField("ExpressionFurigana", "Reading", "Furigana"),
            ankiFieldMeaning: findField("MainDefinition", "Definition", "Meaning"),
            ankiFieldSentence: findField("Sentence"),
            ankiFieldSentenceFurigana: findField("SentenceFurigana", "Sentence Furigana", "SelectionFurigana"),
            ankiFieldDict: findField("Dictionary", "Source"),
            ankiFieldAudio: findField("ExpressionAudio", "Audio"),
            ankiFieldPitch: findField("PitchPosition", "Pitch", "PitchAccent"),
            ankiFieldFreq: findField("Frequency", "Freq"),
            ankiFieldScreenshot: findField("DefinitionPicture", "Picture", "Screenshot", "Image"),
        };

        if (!force) {
            const configured = Boolean(settings.ankiFieldWord && settings.ankiFieldWord !== "none" && settings.ankiFieldMeaning && settings.ankiFieldMeaning !== "none");
            if (configured) return;
        }

        if (updateMultipleSettings) updateMultipleSettings(preset);
        else Object.entries(preset).forEach(([key, value]) => updateSetting(key as keyof AppSettings, value as any));
    };

    useEffect(() => {
        if (!isOpen || ankiFields.length === 0 || !/lapis/i.test(settings.ankiModel || "")) return;
        applyLapisPreset(false);
    }, [isOpen, ankiFields.join("|"), settings.ankiModel]);

    const fetchProcesses = async () => {
        setIsProcessMenuOpen(true);
        try {
            const [windows, processes] = await Promise.all([
                invoke<any[]>("get_capture_windows").catch(() => []),
                invoke<any[]>("get_running_processes").catch(() => []),
            ]);
            const byKey = new Map<string, any>();

            (Array.isArray(windows) ? windows : []).forEach((window) => {
                const key = window.path || `${window.process_name || window.name}-${window.pid || window.id || ""}`;
                byKey.set(key, window);
            });

            (Array.isArray(processes) ? processes : []).forEach((proc) => {
                const key = proc.path || `${proc.name}-${proc.pid || ""}`;
                if (!byKey.has(key)) {
                    byKey.set(key, {
                        ...proc,
                        process_name: proc.name,
                        title: proc.path,
                        width: 0,
                        height: 0,
                        processOnly: true,
                    });
                }
            });

            setRunningProcesses(Array.from(byKey.values()));
        } catch (e) {
            console.error("Process loading error", e);
            setRunningProcesses([]);
        }
    };

    const addProcess = (proc: any) => {
        const procName = typeof proc === "string" ? proc : proc?.name;
        const procIcon = typeof proc === "string" ? undefined : proc?.icon;
        const procPath = typeof proc === "string" ? "" : proc?.path || "";
        const procPid = typeof proc === "string" ? undefined : proc?.pid;
        if (!procName) return;
        const current = settings.hookProcesses || [];
        const procKey = procPath || procName;
        if (!current.find((p) => (p.path || p.name) === procKey)) {
            updateSetting("hookProcesses", [...current, { name: procName, path: procPath, pid: procPid, active: true, icon: procIcon }]);
        }
        setIsProcessMenuOpen(false);
        setProcessSearch("");
    };

    const activeScreenshotProcesses = () =>
        (settings.hookProcesses || [])
            .filter((p) => p.active)
            .map((p) => ({ name: p.name, path: p.path || "" }));

    const testScreenshot = async () => {
        const processes = activeScreenshotProcesses();
        if (processes.length === 0) {
            alert(t.testScreenshotNoProcess);
            return;
        }

        setIsTestingScreenshot(true);
        try {
            const b64 = await invoke<string | null>("take_smart_screenshot", { processes });
            if (!b64) {
                alert(t.testScreenshotEmpty);
                return;
            }
            setScreenshotPreview(b64);
        } catch (e) {
            alert(t.testScreenshotError + String(e));
        } finally {
            setIsTestingScreenshot(false);
        }
    };

    const getAvatarColor = (name: string) => {
        let hash = 0;
        for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
        return `hsl(${Math.abs(hash % 360)}, 65%, 45%)`;
    };

    if (!isOpen) return null;

    return (
        <div className="tab-content-anim">
            <div className="modern-card" style={{ background: "var(--bg-panel)", border: `1px solid ${ankiConnected ? "#4CAF50" : isConnecting ? "var(--accent-blue)" : "var(--border-main)"}` }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 16, flexWrap: "wrap" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
                        <span style={{ width: 10, height: 10, flex: "0 0 10px", borderRadius: "50%", background: ankiConnected ? "#4CAF50" : isConnecting ? "var(--accent-blue)" : "#777" }} />
                        <div style={{ minWidth: 0 }}>
                            <div style={{ color: "var(--text-main)", fontWeight: 800 }}>
                                {ankiBackend === "ankidroid" ? "AnkiDroid" : "AnkiConnect"}
                            </div>
                            <div style={{ marginTop: 3, color: ankiConnected ? "#69cf83" : "var(--text-muted)", fontSize: 12 }}>
                                {isConnecting ? t.connecting : ankiConnected ? t.ready : t.connectionFailed}
                            </div>
                        </div>
                    </div>
                    <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                        {ankiBackend === "ankidroid" && ankiDroidStatus && !ankiDroidStatus.permissionGranted && (
                            <button onClick={requestAndroidAnkiPermission} className="btn-primary" style={{ padding: "8px 12px", fontSize: 12 }}>
                                Allow AnkiDroid
                            </button>
                        )}
                        {ankiBackend === "ankiconnect" && !ankiConnected && (
                            <button type="button" onClick={launchAnkiAndConnect} disabled={isConnecting} style={{ padding: "8px 12px", borderRadius: 6, border: "1px solid var(--border-main)", background: "var(--bg-side)", color: "var(--text-main)", cursor: isConnecting ? "default" : "pointer", opacity: isConnecting ? 0.6 : 1 }}>
                                {t.openAnki}
                            </button>
                        )}
                        <button type="button" onClick={ankiConnected ? () => loadAnkiData() : launchAnkiAndConnect} disabled={isConnecting} className="btn-primary" style={{ padding: "8px 14px", fontSize: 12, opacity: isConnecting ? 0.65 : 1 }}>
                            {isConnecting ? t.connecting : ankiConnected ? t.refresh : t.connect}
                        </button>
                    </div>
                </div>

                {connectionError && !ankiConnected && (
                    <div style={{ marginTop: 12, color: "#ff8b8b", fontSize: 12, overflowWrap: "anywhere", whiteSpace: "pre-line" }}>{connectionError}</div>
                )}

                {ankiSetupMessage && (
                    <div style={{ marginTop: 12, color: ankiConnected ? "#69cf83" : "#e9bd65", fontSize: 12, lineHeight: 1.55 }}>{ankiSetupMessage}</div>
                )}

                {ankiBackend === "ankidroid" && ankiDroidStatus && (
                    <div style={{ marginTop: 10, color: "var(--text-muted)", fontSize: 12 }}>
                        AnkiDroid installed: {ankiDroidStatus.available ? "yes" : "no"} · permission: {ankiDroidStatus.permissionGranted ? "allowed" : "not allowed"}
                    </div>
                )}

                {ankiBackend === "ankiconnect" && !ankiConnected && !isConnecting && (
                    <div style={{ marginTop: 18, paddingTop: 16, borderTop: "1px solid var(--border-main)" }}>
                        <div style={{ color: "var(--text-main)", fontWeight: 750 }}>{t.addonTitle}</div>
                        <div style={{ color: "var(--text-muted)", fontSize: 12, lineHeight: 1.55, marginTop: 6 }}>{t.addonHint}</div>
                        <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 12, flexWrap: "wrap" }}>
                            <code style={{ minWidth: 118, padding: "8px 10px", borderRadius: 5, background: "var(--bg-side)", color: "var(--text-main)", fontSize: 14, textAlign: "center" }}>2055492159</code>
                            <button type="button" onClick={copyAddonCode} style={{ padding: "8px 11px", borderRadius: 6, border: "1px solid var(--border-main)", background: "var(--bg-side)", color: "var(--text-main)", cursor: "pointer" }}>
                                {addonCodeCopied ? t.copied : t.copyCode}
                            </button>
                            <button type="button" onClick={() => openUrl("https://ankiweb.net/shared/info/2055492159")} style={{ padding: "8px 11px", borderRadius: 6, border: "1px solid var(--border-main)", background: "transparent", color: "var(--text-muted)", cursor: "pointer" }}>
                                {t.addonPage}
                            </button>
                        </div>
                    </div>
                )}
            </div>

            {ankiConnected && (
                <>
                    <div id="anki-cards" className={`modern-card ${highlightedSection === "anki-cards" ? "card-highlighted" : ""}`} style={{ background: "var(--bg-panel)", border: "1px solid var(--border-main)" }}>
                        <div className="card-label" style={{ color: "var(--text-main)" }}>{t.cardSettings}</div>
                        <div style={{ display: "flex", gap: "15px", marginBottom: "20px" }}>
                            <div style={{ flex: 1 }}><div style={{ fontSize: "12px", color: "var(--text-muted)", marginBottom: "6px" }}>{t.deck}</div><select className="modern-select" value={settings.ankiDeck} onChange={(e) => updateSetting("ankiDeck", e.target.value)}>{ankiDecks.map((d) => <option key={d} value={d}>{d}</option>)}</select></div>
                            <div style={{ flex: 1 }}><div style={{ fontSize: "12px", color: "var(--text-muted)", marginBottom: "6px" }}>{t.model}</div><select className="modern-select" value={settings.ankiModel} onChange={(e) => updateSetting("ankiModel", e.target.value)}>{ankiModels.map((m) => <option key={m} value={m}>{m}</option>)}</select></div>
                        </div>

                        <div style={{ borderTop: "1px solid var(--border-main)", paddingTop: "15px", marginBottom: "18px" }}>
                            <div className="card-label" style={{ margin: 0, color: "var(--text-main)" }}>
                                {settings.appLanguage === "en" ? "Deck routing" : "Куда добавлять карточки"}
                            </div>
                            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "8px", marginTop: "10px" }}>
                                <button
                                    type="button"
                                    onClick={() => updateSetting("ankiDeckMode", "shared")}
                                    style={{ padding: "10px 12px", borderRadius: 6, cursor: "pointer", textAlign: "left", border: `1px solid ${(settings.ankiDeckMode || "shared") === "shared" ? "var(--accent-blue)" : "var(--border-main)"}`, background: (settings.ankiDeckMode || "shared") === "shared" ? "var(--hover-bg)" : "var(--bg-side)", color: "var(--text-main)" }}
                                >
                                    <b>{settings.appLanguage === "en" ? "One deck everywhere" : "Одна колода для всего"}</b>
                                    <span style={{ display: "block", marginTop: 4, color: "var(--text-muted)", fontSize: 12 }}>
                                        {settings.appLanguage === "en" ? "Internal and global lookup use the main deck." : "Внутренний и глобальный лукап используют основную колоду."}
                                    </span>
                                </button>
                                <button
                                    type="button"
                                    onClick={() => updateSetting("ankiDeckMode", "contextual")}
                                    style={{ padding: "10px 12px", borderRadius: 6, cursor: "pointer", textAlign: "left", border: `1px solid ${settings.ankiDeckMode === "contextual" ? "var(--accent-blue)" : "var(--border-main)"}`, background: settings.ankiDeckMode === "contextual" ? "var(--hover-bg)" : "var(--bg-side)", color: "var(--text-main)" }}
                                >
                                    <b>{settings.appLanguage === "en" ? "Decks by context" : "Колоды по контексту"}</b>
                                    <span style={{ display: "block", marginTop: 4, color: "var(--text-muted)", fontSize: 12 }}>
                                        {settings.appLanguage === "en" ? "Choose a deck for global lookup and individual tabs." : "Можно выбрать колоду для глобального лукапа и отдельных вкладок."}
                                    </span>
                                </button>
                            </div>
                            {settings.ankiDeckMode === "contextual" && (
                                <label style={{ display: "block", marginTop: 12 }}>
                                    <span style={{ display: "block", marginBottom: 6, color: "var(--text-muted)", fontSize: 12 }}>
                                        {settings.appLanguage === "en" ? "Default deck for global lookup" : "Колода для глобального лукапа"}
                                    </span>
                                    <select className="modern-select" value={settings.ankiGlobalDeck || settings.ankiDeck} onChange={(event) => updateSetting("ankiGlobalDeck", event.target.value)}>
                                        {ankiDecks.map((deck) => <option key={deck} value={deck}>{deck}</option>)}
                                    </select>
                                </label>
                            )}
                        </div>

                        <div style={{ borderTop: "1px solid var(--border-main)", paddingTop: "15px", display: "flex", justifyContent: "space-between", alignItems: "center", gap: "12px" }}>
                            <div>
                                <div className="card-label" style={{ margin: 0, color: "var(--text-main)" }}>{t.cardFormat}</div>
                                <div style={{ color: "var(--text-muted)", fontSize: "12px", marginTop: "6px" }}>{t.cardFormatHint}</div>
                            </div>
                            <div style={{ display: "flex", gap: "8px", flexShrink: 0 }}>
                                <button onClick={() => applyLapisPreset(true)} style={{ background: "var(--bg-side)", color: "var(--text-main)", border: "1px solid var(--border-main)", padding: "6px 12px", borderRadius: "6px", cursor: "pointer", fontSize: "12px" }}>{t.lapisPreset}</button>
                                <button onClick={() => setShowAdvancedFields((v) => !v)} style={{ background: "transparent", color: showAdvancedFields ? "var(--accent-blue)" : "var(--text-muted)", border: "1px solid var(--border-main)", padding: "6px 12px", borderRadius: "6px", cursor: "pointer", fontSize: "12px" }}>{showAdvancedFields ? t.hideFields : t.showFields}</button>
                            </div>
                        </div>

                        {!showAdvancedFields && <div style={{ marginTop: "14px", padding: "12px", borderRadius: "8px", background: "var(--bg-side)", color: "var(--text-muted)", fontSize: "12px", lineHeight: 1.5 }}>{t.activeModel}: <b style={{ color: "var(--text-main)" }}>{settings.ankiModel || t.notSelected}</b>. {t.modelHint}</div>}

                        {showAdvancedFields && (
                            <div style={{ marginTop: "15px", display: "grid", gridTemplateColumns: "1fr 1fr", gap: "15px" }}>
                                {["Word", "Reading", "Meaning", "Sentence", "SentenceFurigana", "Dict", "Audio", "Pitch", "Freq", "Screenshot"].map((type) => {
                                    const settingKey = `ankiField${type}` as keyof AppSettings;
                                    return (
                                        <div key={type} style={{ display: "flex", alignItems: "center" }}>
                                            <div style={{ width: "110px", color: "var(--text-muted)", fontSize: "12px" }}>{t.fields[type]}:</div>
                                            <select className="modern-select" style={{ flex: 1, marginTop: 0 }} value={(settings[settingKey] as string) || "none"} onChange={(e) => updateSetting(settingKey, e.target.value)}>
                                                <option value="none">{t.none}</option>
                                                {ankiFields.map((field) => <option key={field} value={field}>{field}</option>)}
                                            </select>
                                        </div>
                                    );
                                })}
                            </div>
                        )}
                    </div>

                    <div id="anki-hooks" className={`modern-card ${highlightedSection === "anki-hooks" ? "card-highlighted" : ""}`} style={{ background: "var(--bg-panel)", border: "1px solid var(--border-main)" }}>
                        <div className="card-label" style={{ color: "var(--text-main)" }}>{t.screenshots}</div>
                        <div style={{ marginBottom: "15px", display: "flex", flexDirection: "column", gap: "10px" }}>
                            <label className="checkbox-label"><input type="checkbox" checked={settings.ankiShowButtonNormal ?? true} onChange={(e) => updateSetting("ankiShowButtonNormal", e.target.checked)} /> {t.normalButton}</label>
                            <label className="checkbox-label"><input type="checkbox" checked={settings.ankiShowButtonScreenshot ?? true} onChange={(e) => updateSetting("ankiShowButtonScreenshot", e.target.checked)} /> {t.screenshotButton}</label>
                        </div>

                        <div style={{ color: "var(--text-muted)", fontSize: "12px", marginBottom: "10px", borderTop: "1px solid var(--border-main)", paddingTop: "15px" }}>{t.gameProcess}</div>
                        <div style={{ display: "flex", gap: "10px", position: "relative", marginBottom: "15px" }}>
                            <div style={{ flex: 1, color: "var(--text-muted)", fontSize: "13px", display: "flex", alignItems: "center" }}>{t.processHint}</div>
                            <button onClick={fetchProcesses} className="btn-primary" style={{ padding: "8px 16px" }}>{t.findGame}</button>

                            {isProcessMenuOpen && (
                                <div style={{ position: "absolute", top: "100%", left: 0, right: 0, marginTop: "8px", background: "var(--bg-panel)", border: "1px solid var(--accent-blue)", borderRadius: "8px", zIndex: 100, boxShadow: "0 10px 25px rgba(0,0,0,0.5)", overflow: "hidden", display: "flex", flexDirection: "column" }}>
                                    <div style={{ padding: "10px", borderBottom: "1px solid var(--border-main)", display: "flex", gap: "10px", background: "var(--bg-main)" }}>
                                        <input autoFocus type="text" className="modern-input" placeholder={t.processSearch} value={processSearch} onChange={(e) => setProcessSearch(e.target.value)} style={{ flex: 1, padding: "6px 10px" }} />
                                        <button onClick={() => { setIsProcessMenuOpen(false); setProcessSearch(""); }} style={{ background: "transparent", border: "none", color: "var(--text-muted)", cursor: "pointer" }}>x</button>
                                    </div>
                                    <div className="tiny-scroll" style={{ maxHeight: "250px", overflowY: "auto" }}>
                                        {runningProcesses.length === 0 ? (
                                            <div style={{ padding: "15px", textAlign: "center", color: "var(--text-muted)", fontSize: "13px" }}>{t.loading}</div>
                                        ) : (
                                            runningProcesses
                                                .filter((p: any) => {
                                                    const procName = typeof p === "string" ? p : p?.process_name || p?.name || "";
                                                    const procPath = typeof p === "string" ? "" : p?.path || "";
                                                    const title = typeof p === "string" ? "" : p?.title || "";
                                                    const appName = typeof p === "string" ? "" : p?.app_name || "";
                                                    const query = processSearch.toLowerCase();
                                                    return `${procName} ${procPath} ${title} ${appName}`.toLowerCase().includes(query);
                                                })
                                                .map((p: any) => {
                                                    const procName = typeof p === "string" ? p : p.process_name || p.name;
                                                    const procIcon = typeof p === "string" ? undefined : p.icon;
                                                    const procPath = typeof p === "string" ? "" : p.path || "";
                                                    const procPid = typeof p === "string" ? undefined : p.pid;
                                                    const winTitle = typeof p === "string" ? "" : p.title || "";
                                                    const hasWindow = Boolean(p.width || p.height);
                                                    const winSize = typeof p === "string" || !hasWindow ? "" : `${p.width || 0}x${p.height || 0}`;
                                                    const primaryLabel = hasWindow && winTitle ? winTitle : procName;
                                                    const procKey = `${procPath || procName}-${typeof p === "string" ? "" : p.id || ""}`;
                                                    return (
                                                        <div key={procKey} onClick={() => addProcess({ name: procName, icon: procIcon, path: procPath, pid: procPid })} style={{ padding: "10px 15px", cursor: "pointer", borderBottom: "1px solid var(--border-main)", fontSize: "13px", color: "var(--text-main)", transition: "0.1s", display: "flex", alignItems: "center", gap: "10px" }} onMouseOver={(e) => e.currentTarget.style.background = "var(--hover-bg)"} onMouseOut={(e) => e.currentTarget.style.background = "transparent"}>
                                                            {procIcon ? <img src={`data:image/png;base64,${procIcon}`} style={{ width: "24px", height: "24px" }} alt="" /> : <div style={{ width: "24px", height: "24px", background: getAvatarColor(procName), borderRadius: "4px", display: "flex", alignItems: "center", justifyContent: "center", fontWeight: "bold", color: "#fff", fontSize: "12px" }}>{procName.charAt(0).toUpperCase()}</div>}
                                                            <div style={{ minWidth: 0, flex: 1 }}>
                                                                <div style={{ display: "flex", gap: "8px", alignItems: "baseline", flexWrap: "wrap" }}>
                                                                    <span style={{ fontWeight: 600 }}>{primaryLabel}</span>
                                                                    {procPid ? <span style={{ color: "var(--text-muted)", fontSize: "11px" }}>{t.pid} {procPid}</span> : null}
                                                                    {p.is_focused ? <span style={{ color: "#4CAF50", fontSize: "11px" }}>{t.activeWindow}</span> : null}
                                                                    {p.is_recent && !p.is_focused ? <span style={{ color: "var(--accent-blue)", fontSize: "11px" }}>{t.recentWindow}</span> : null}
                                                                    {winSize ? <span style={{ color: "var(--text-muted)", fontSize: "11px" }}>{winSize}</span> : null}
                                                                </div>
                                                                {hasWindow && winTitle && winTitle !== procName ? <div title={procName} style={{ color: "var(--text-main)", fontSize: "12px", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", marginTop: "2px" }}>{procName}</div> : null}
                                                                {procPath ? <div title={procPath} style={{ color: "var(--text-muted)", fontSize: "11px", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", marginTop: "2px" }}>{procPath}</div> : null}
                                                            </div>
                                                        </div>
                                                    );
                                                })
                                        )}
                                    </div>
                                </div>
                            )}
                        </div>

                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "10px", gap: "10px" }}>
                            <div style={{ color: "var(--text-muted)", fontSize: "12px" }}>{settings.hookProcesses?.filter((p) => p.active).length || 0} {t.activeSources}</div>
                            <button onClick={testScreenshot} disabled={isTestingScreenshot} className="btn-primary" style={{ padding: "6px 12px", fontSize: "12px", opacity: isTestingScreenshot ? 0.7 : 1 }}>
                                {isTestingScreenshot ? "..." : t.testScreenshot}
                            </button>
                        </div>

                        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: "10px" }}>
                            {(settings.hookProcesses || []).map((proc, idx) => (
                                <div key={proc.path || proc.name} style={{ display: "flex", alignItems: "center", background: "var(--bg-side)", padding: "10px", borderRadius: "6px", border: "1px solid var(--border-main)" }}>
                                    <input type="checkbox" checked={proc.active} onChange={(e) => { const newProcs = [...settings.hookProcesses]; newProcs[idx].active = e.target.checked; updateSetting("hookProcesses", newProcs); }} style={{ accentColor: "var(--accent-blue)", width: "16px", height: "16px", cursor: "pointer" }} />
                                    <div style={{ display: "flex", alignItems: "center", gap: "10px", flex: 1, marginLeft: "10px", minWidth: 0 }}>
                                        {proc.icon ? <img src={`data:image/png;base64,${proc.icon}`} style={{ width: "24px", height: "24px", flexShrink: 0 }} alt="" /> : <div style={{ width: "24px", height: "24px", background: getAvatarColor(proc.name), borderRadius: "4px", display: "flex", alignItems: "center", justifyContent: "center", color: "#fff", fontWeight: "bold", fontSize: "12px", flexShrink: 0 }}>{proc.name.charAt(0).toUpperCase()}</div>}
                                        <div style={{ minWidth: 0, flex: 1 }}>
                                            <div style={{ color: proc.active ? "var(--text-main)" : "var(--text-muted)", fontSize: "13px", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", fontWeight: 600 }} title={proc.name}>{proc.name}</div>
                                            {proc.path ? <div style={{ color: "var(--text-muted)", fontSize: "11px", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", marginTop: "2px" }} title={proc.path}>{proc.path}</div> : null}
                                        </div>
                                    </div>
                                    <button onClick={() => updateSetting("hookProcesses", settings.hookProcesses.filter((_, i) => i !== idx))} style={{ background: "rgba(255, 68, 68, 0.1)", color: "#ff4444", border: "1px solid rgba(255, 68, 68, 0.3)", borderRadius: "4px", padding: "4px 8px", cursor: "pointer", flexShrink: 0 }}>x</button>
                                </div>
                            ))}
                        </div>

                    </div>

                    {screenshotPreview && (
                        <div className="modern-card" style={{ background: "var(--bg-panel)", border: "1px solid var(--accent-blue)" }}>
                            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "10px" }}>
                                <div className="card-label" style={{ color: "var(--text-main)", margin: 0 }}>{t.testScreenshot}</div>
                                <button onClick={() => setScreenshotPreview(null)} style={{ background: "transparent", color: "var(--text-muted)", border: "1px solid var(--border-main)", borderRadius: "4px", padding: "4px 8px", cursor: "pointer" }}>{t.closePreview}</button>
                            </div>
                            <img src={`data:image/jpeg;base64,${screenshotPreview}`} alt="" style={{ width: "100%", maxHeight: "320px", objectFit: "contain", borderRadius: "6px", background: "#000", border: "1px solid var(--border-main)" }} />
                        </div>
                    )}

                    <div className="modern-card" style={{ background: "var(--bg-panel)", border: "1px solid var(--border-main)" }}>
                        <div className="card-label" style={{ color: "var(--text-main)" }}>{t.duplicateCheck}</div>
                        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "10px", marginBottom: "15px" }}>
                            <div><div style={{ fontSize: "11px", color: "var(--text-muted)", marginBottom: "4px" }}>{t.newCard}</div><input type="color" value={settings.ankiColorNew || "#4CAF50"} onChange={(e) => updateSetting("ankiColorNew", e.target.value)} style={{ width: "100%", height: "30px", border: "none", cursor: "pointer", background: "transparent" }} /></div>
                            <div><div style={{ fontSize: "11px", color: "var(--text-muted)", marginBottom: "4px" }}>{t.otherDeck}</div><input type="color" value={settings.ankiColorOther || "#4fa6ff"} onChange={(e) => updateSetting("ankiColorOther", e.target.value)} style={{ width: "100%", height: "30px", border: "none", cursor: "pointer", background: "transparent" }} /></div>
                            <div><div style={{ fontSize: "11px", color: "var(--text-muted)", marginBottom: "4px" }}>{t.sameDeck}</div><input type="color" value={settings.ankiColorSame || "#ff4444"} onChange={(e) => updateSetting("ankiColorSame", e.target.value)} style={{ width: "100%", height: "30px", border: "none", cursor: "pointer", background: "transparent" }} /></div>
                        </div>
                        <label className="checkbox-label" style={{ marginBottom: "10px" }}><input type="checkbox" checked={settings.ankiAllowDuplicatesOther ?? true} onChange={(e) => updateSetting("ankiAllowDuplicatesOther", e.target.checked)} /> {t.allowOther}</label>
                        <label className="checkbox-label"><input type="checkbox" checked={settings.ankiAllowDuplicatesSame ?? false} onChange={(e) => updateSetting("ankiAllowDuplicatesSame", e.target.checked)} /> {t.allowSame}</label>
                    </div>
                </>
            )}
        </div>
    );
}
