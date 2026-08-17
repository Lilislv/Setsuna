import React, { useEffect, useMemo, useState } from "react";
import { getDecks, invokeAnki } from "../utils/anki";
import type { AppSettings } from "./SettingsModal";
import { getTranslator, type AppLanguage } from "../utils/i18n";

type SetupWizardProps = {
    isOpen: boolean;
    onClose: () => void;
    onImportYomitan?: () => void;
    installedDictionariesCount?: number;
    ankiDeck?: string;
    ankiModel?: string;
    settings?: AppSettings;
    onSettingsPatch?: (patch: Partial<AppSettings>) => void;
    onAnkiDeckChange?: (deck: string) => void;
};

type AnkiStatus = "idle" | "checking" | "connected" | "failed" | "needs_config";
type StepId = "design" | "yomitan" | "anki" | "finish";

const ANKI_CONNECT_ADDON_ID = "2055492159";

const cardStyle: React.CSSProperties = {
    border: "1px solid var(--border-color, #333)",
    background: "var(--bg-secondary, #1b1b1b)",
    borderRadius: 8,
    padding: 16,
};

const buttonStyle: React.CSSProperties = {
    border: "1px solid var(--border-color, #444)",
    borderRadius: 8,
    padding: "9px 14px",
    background: "var(--button-bg, #242424)",
    color: "var(--text-main, #eee)",
    cursor: "pointer",
    fontWeight: 700,
};

const primaryButtonStyle: React.CSSProperties = {
    ...buttonStyle,
    borderColor: "var(--accent, #4ea1ff)",
    background: "var(--accent-bg, rgba(78, 161, 255, 0.14))",
    color: "var(--accent, #4ea1ff)",
};

const warningStyle: React.CSSProperties = {
    border: "1px solid rgba(255, 198, 92, 0.35)",
    background: "rgba(255, 198, 92, 0.08)",
    color: "var(--text-main, #eee)",
    borderRadius: 8,
    padding: 12,
    lineHeight: 1.55,
};

const codeStyle: React.CSSProperties = {
    display: "block",
    background: "rgba(0,0,0,0.35)",
    border: "1px solid rgba(255,255,255,0.08)",
    borderRadius: 8,
    padding: 12,
    whiteSpace: "pre-wrap",
    overflowX: "auto",
    color: "var(--text-main, #eee)",
    fontSize: 13,
};

const inputStyle: React.CSSProperties = {
    width: "100%",
    borderRadius: 8,
    border: "1px solid var(--border-main, rgba(255,255,255,0.12))",
    background: "var(--bg-main, rgba(0,0,0,0.35))",
    color: "var(--text-main, #eee)",
    padding: "10px 12px",
    fontWeight: 700,
    boxSizing: "border-box",
};

const guideImageStyle: React.CSSProperties = {
    width: "100%",
    maxHeight: 280,
    objectFit: "contain",
    borderRadius: 8,
    border: "1px solid rgba(255,255,255,0.08)",
    background: "#111",
};

const DEFAULT_ANKI_CONNECT_CONFIG = {
    apiKey: null,
    apiLogPath: null,
    ignoreOriginList: [],
    webBindAddress: "127.0.0.1",
    webBindPort: 8765,
    webCorsOriginList: [
        "http://localhost",
        "http://tauri.localhost",
        "tauri://localhost",
        "http://127.0.0.1:1420",
        "http://localhost:1420",
    ],
};

const getRequiredAnkiCorsOrigins = () => {
    const origins = [
        "http://localhost",
        "http://tauri.localhost",
        "tauri://localhost",
        "http://127.0.0.1:1420",
        "http://localhost:1420",
    ];
    const currentOrigin = typeof window !== "undefined" && window.location?.origin ? window.location.origin : "";
    const isDevOrigin = currentOrigin.startsWith("http://localhost") || currentOrigin.startsWith("http://127.0.0.1");

    if (isDevOrigin && currentOrigin !== "null") origins.push(currentOrigin);
    return origins;
};

const formatConfig = (config: unknown) => JSON.stringify(config, null, 2);

const mergeAnkiConnectConfig = (rawConfig: string) => {
    const parsed = rawConfig.trim() ? JSON.parse(rawConfig) : {};
    const currentCors = Array.isArray(parsed.webCorsOriginList)
        ? parsed.webCorsOriginList.filter((origin: unknown) => origin !== "*")
        : [];

    const next = {
        ...parsed,
        webBindAddress: parsed.webBindAddress ?? "127.0.0.1",
        webBindPort: parsed.webBindPort ?? 8765,
        webCorsOriginList: Array.from(new Set([...currentCors, ...getRequiredAnkiCorsOrigins()])),
    };

    if (!("apiKey" in next)) next.apiKey = null;
    if (!("apiLogPath" in next)) next.apiLogPath = null;
    if (!Array.isArray(next.ignoreOriginList)) next.ignoreOriginList = [];

    return formatConfig(next);
};

const StatusBadge = ({ ok, text }: { ok: boolean; text: string }) => (
    <span
        style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 8,
            border: `1px solid ${ok ? "rgba(80,220,120,.45)" : "rgba(255,90,90,.45)"}`,
            color: ok ? "#65d982" : "#ff7b7b",
            background: ok ? "rgba(80,220,120,.10)" : "rgba(255,90,90,.10)",
            padding: "6px 10px",
            borderRadius: 999,
            fontSize: 13,
            fontWeight: 700,
        }}
    >
        <span>●</span>
        {text}
    </span>
);

const AnkiConfigBlock = ({ language }: { language: AppLanguage }) => {
    const t = getTranslator(language);
    const [configInput, setConfigInput] = useState("");
    const [configOutput, setConfigOutput] = useState(formatConfig(DEFAULT_ANKI_CONNECT_CONFIG));
    const [error, setError] = useState("");
    const [copied, setCopied] = useState(false);

    const generateConfig = () => {
        try {
            setError("");
            setCopied(false);
            setConfigOutput(mergeAnkiConnectConfig(configInput));
        } catch {
            setError(t("wizard.config.error"));
        }
    };

    const useDefaultConfig = () => {
        setError("");
        setCopied(false);
        setConfigInput("");
        setConfigOutput(formatConfig(DEFAULT_ANKI_CONNECT_CONFIG));
    };

    const copyConfig = async () => {
        try {
            await navigator.clipboard.writeText(configOutput);
            setCopied(true);
            setTimeout(() => setCopied(false), 2200);
        } catch {
            setCopied(false);
        }
    };

    return (
        <div style={warningStyle}>
            <b>{t("wizard.config.title")}</b>

            <textarea
                value={configInput}
                onChange={(e) => setConfigInput(e.target.value)}
                placeholder={t("wizard.config.placeholder")}
                style={{ ...inputStyle, minHeight: 150, marginTop: 12, fontFamily: "Consolas, monospace", resize: "vertical" }}
            />

            <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginTop: 10 }}>
                <button type="button" style={primaryButtonStyle} onClick={generateConfig}>
                    {t("wizard.config.generate")}
                </button>
                <button type="button" style={buttonStyle} onClick={useDefaultConfig}>
                    {t("wizard.config.default")}
                </button>
            </div>

            {error && <div style={{ marginTop: 10, color: "#ff7b7b", fontWeight: 800 }}>{error}</div>}

            <div style={{ marginTop: 16, color: "var(--text-muted, #aaa)" }}>{t("wizard.config.newConfig")}</div>
            <pre style={codeStyle}>{configOutput}</pre>

            <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap", marginTop: 10 }}>
                <button type="button" style={primaryButtonStyle} onClick={copyConfig}>
                    {t("wizard.config.copy")}
                </button>
                {copied && <span style={{ color: "#8EF0B3", fontWeight: 800 }}>{t("wizard.config.copied")}</span>}
            </div>
        </div>
    );
};

export default function SetupWizard({
    isOpen,
    onClose,
    onImportYomitan,
    installedDictionariesCount = 0,
    ankiDeck,
    ankiModel,
    settings,
    onSettingsPatch,
    onAnkiDeckChange,
}: SetupWizardProps) {
    const language = (settings?.appLanguage || "ru") as AppLanguage;
    const t = getTranslator(language);
    const steps = useMemo(
        () => [
            { id: "design" as const, title: t("wizard.step.design") },
            { id: "yomitan" as const, title: t("wizard.step.yomitan") },
            { id: "anki" as const, title: t("wizard.step.anki") },
            { id: "finish" as const, title: t("wizard.step.finish") },
        ],
        [t]
    );

    const [step, setStep] = useState<StepId>("design");
    const [ankiStatus, setAnkiStatus] = useState<AnkiStatus>("idle");
    const [ankiDecks, setAnkiDecks] = useState<string[]>([]);
    const [selectedAnkiDeck, setSelectedAnkiDeck] = useState(ankiDeck || "");
    const [isLoadingDecks, setIsLoadingDecks] = useState(false);
    const [deckError, setDeckError] = useState("");

    const currentIndex = steps.findIndex((item) => item.id === step);
    const hasDictionaries = installedDictionariesCount > 0;

    const ankiStatusText = useMemo(() => {
        if (ankiStatus === "checking") return t("wizard.anki.status.checking");
        if (ankiStatus === "connected") return t("wizard.anki.status.connected");
        if (ankiStatus === "needs_config") return t("wizard.anki.status.needsConfig");
        if (ankiStatus === "failed") return t("wizard.anki.status.failed");
        return t("wizard.anki.status.idle");
    }, [ankiStatus, t]);

    useEffect(() => {
        if (!isOpen) return;
        setStep("design");
    }, [isOpen]);

    useEffect(() => {
        setSelectedAnkiDeck(ankiDeck || "");
    }, [ankiDeck]);

    const updateSetting = <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => {
        onSettingsPatch?.({ [key]: value } as Partial<AppSettings>);
    };

    const applyDeck = (deck: string) => {
        setSelectedAnkiDeck(deck);
        onAnkiDeckChange?.(deck);
    };

    const loadAnkiDecks = async () => {
        setIsLoadingDecks(true);
        setDeckError("");

        try {
            const decks = await getDecks(true);
            const safeDecks = Array.isArray(decks) ? decks : [];

            setAnkiDecks(safeDecks);

            if (safeDecks.length > 0) {
                const preferred =
                    selectedAnkiDeck && safeDecks.includes(selectedAnkiDeck)
                        ? selectedAnkiDeck
                        : ankiDeck && safeDecks.includes(ankiDeck)
                          ? ankiDeck
                          : safeDecks[0];

                applyDeck(preferred);
            } else {
                setDeckError(t("wizard.anki.noDecksError"));
            }
        } catch {
            setAnkiDecks([]);
            setDeckError(t("wizard.anki.loadDecksError"));
        } finally {
            setIsLoadingDecks(false);
        }
    };

    const checkAnki = async () => {
        setAnkiStatus("checking");
        setDeckError("");

        try {
            await invokeAnki("version");
            setAnkiStatus("connected");
            await loadAnkiDecks();
        } catch {
            setAnkiStatus("failed");
        }
    };

    const next = () => setStep(steps[Math.min(currentIndex + 1, steps.length - 1)].id);
    const prev = () => setStep(steps[Math.max(currentIndex - 1, 0)].id);

    if (!isOpen) return null;

    const fontSize = settings?.fontSize || 26;
    const fontFamily = settings?.fontFamily || "'Noto Serif JP', 'Yu Gothic', sans-serif";
    const theme = settings?.theme || "dark";
    const panelPosition = settings?.panelPosition || "bottom";
    const furiganaMode = settings?.furiganaMode || "none";

    return (
        <div
            style={{
                position: "fixed",
                inset: 0,
                zIndex: 15000,
                background: "rgba(0,0,0,0.62)",
                backdropFilter: "blur(6px)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                padding: 24,
            }}
        >
            <div
                style={{
                    width: "min(1040px, 96vw)",
                    maxHeight: "92vh",
                    overflow: "hidden",
                    borderRadius: 12,
                    border: "1px solid var(--border-color, #333)",
                    background: "var(--bg-main, #151515)",
                    color: "var(--text-main, #eee)",
                    boxShadow: "0 24px 80px rgba(0,0,0,.55)",
                    display: "grid",
                    gridTemplateRows: "auto 1fr auto",
                }}
            >
                <header
                    style={{
                        padding: "18px 22px",
                        borderBottom: "1px solid var(--border-color, #333)",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        gap: 16,
                    }}
                >
                    <div>
                        <div style={{ fontSize: 22, fontWeight: 800 }}>{t("wizard.title")}</div>
                        <div style={{ color: "var(--text-muted, #aaa)", marginTop: 4 }}>{t("wizard.subtitle")}</div>
                    </div>

                    <button type="button" style={buttonStyle} onClick={onClose}>
                        {t("common.close")}
                    </button>
                </header>

                <main style={{ minHeight: 0, display: "grid", gridTemplateColumns: "220px 1fr" }}>
                    <aside
                        style={{
                            borderRight: "1px solid var(--border-color, #333)",
                            padding: 16,
                            background: "rgba(255,255,255,0.02)",
                        }}
                    >
                        {steps.map((item, index) => {
                            const active = item.id === step;
                            const done = index < currentIndex;

                            return (
                                <button
                                    key={item.id}
                                    type="button"
                                    onClick={() => setStep(item.id)}
                                    style={{
                                        width: "100%",
                                        textAlign: "left",
                                        padding: "12px",
                                        marginBottom: 8,
                                        borderRadius: 8,
                                        border: active ? "1px solid var(--accent, #4ea1ff)" : "1px solid transparent",
                                        background: active ? "rgba(78,161,255,.13)" : "transparent",
                                        color: active ? "var(--accent, #4ea1ff)" : "var(--text-main, #eee)",
                                        cursor: "pointer",
                                        fontWeight: active ? 800 : 600,
                                    }}
                                >
                                    <span style={{ opacity: 0.75, marginRight: 8 }}>{done ? "✓" : index + 1}</span>
                                    {item.title}
                                </button>
                            );
                        })}

                        <div style={{ marginTop: 18, display: "grid", gap: 10 }}>
                            <StatusBadge
                                ok={hasDictionaries}
                                text={
                                    hasDictionaries
                                        ? t("wizard.status.dictionariesReady", { count: installedDictionariesCount })
                                        : t("wizard.status.dictionariesMissing")
                                }
                            />
                            <StatusBadge ok={ankiStatus === "connected"} text={ankiStatusText} />
                            {selectedAnkiDeck && (
                                <StatusBadge ok={true} text={t("wizard.status.deck", { deck: selectedAnkiDeck })} />
                            )}
                        </div>
                    </aside>

                    <section style={{ overflow: "auto", padding: 22 }}>
                        {step === "design" && (
                            <div style={{ display: "grid", gap: 16 }}>
                                <div>
                                    <h2 style={{ margin: 0 }}>{t("wizard.design.title")}</h2>
                                    <p style={{ color: "var(--text-muted)", lineHeight: 1.6 }}>{t("wizard.design.subtitle")}</p>
                                </div>

                                <div style={{ ...cardStyle, display: "grid", gap: 14 }}>
                                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
                                        <label>
                                            <div style={{ color: "var(--text-muted)", fontSize: 12, marginBottom: 6 }}>
                                                {t("wizard.design.language")}
                                            </div>
                                            <select
                                                style={inputStyle}
                                                value={language}
                                                onChange={(e) => updateSetting("appLanguage", e.target.value as AppSettings["appLanguage"])}
                                            >
                                                <option value="ru">{t("wizard.language.ru")}</option>
                                                <option value="en">{t("wizard.language.en")}</option>
                                            </select>
                                        </label>

                                        <label>
                                            <div style={{ color: "var(--text-muted)", fontSize: 12, marginBottom: 6 }}>
                                                {t("wizard.design.theme")}
                                            </div>
                                            <select
                                                style={inputStyle}
                                                value={theme}
                                                onChange={(e) => updateSetting("theme", e.target.value as AppSettings["theme"])}
                                            >
                                                <option value="dark">{t("wizard.theme.dark")}</option>
                                                <option value="light">{t("wizard.theme.light")}</option>
                                                <option value="amoled">{t("wizard.theme.amoled")}</option>
                                            </select>
                                        </label>
                                    </div>

                                    <label>
                                        <div style={{ color: "var(--text-muted)", fontSize: 12, marginBottom: 6 }}>
                                            {t("wizard.design.font")}
                                        </div>
                                        <select
                                            style={inputStyle}
                                            value={fontFamily}
                                            onChange={(e) => updateSetting("fontFamily", e.target.value)}
                                        >
                                            <option value="'Noto Serif JP', serif">{t("wizard.font.serif")}</option>
                                            <option value="'Noto Sans JP', sans-serif">{t("wizard.font.sans")}</option>
                                            <option value="'Yu Gothic', sans-serif">{t("wizard.font.yu")}</option>
                                            <option value="'Meiryo', sans-serif">{t("wizard.font.meiryo")}</option>
                                        </select>
                                    </label>

                                    <label>
                                        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
                                            <span style={{ color: "var(--text-muted)", fontSize: 12 }}>
                                                {t("wizard.design.fontSize")}
                                            </span>
                                            <b>{fontSize}px</b>
                                        </div>
                                        <input
                                            type="range"
                                            min="12"
                                            max="64"
                                            value={fontSize}
                                            onChange={(e) => updateSetting("fontSize", Number(e.target.value))}
                                            style={{ width: "100%" }}
                                        />
                                    </label>

                                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
                                        <label>
                                            <div style={{ color: "var(--text-muted)", fontSize: 12, marginBottom: 6 }}>
                                                {t("wizard.design.statsPosition")}
                                            </div>
                                            <select
                                                style={inputStyle}
                                                value={panelPosition}
                                                onChange={(e) => updateSetting("panelPosition", e.target.value as AppSettings["panelPosition"])}
                                            >
                                                <option value="bottom">{t("wizard.stats.bottom")}</option>
                                                <option value="top-right">{t("wizard.stats.topRight")}</option>
                                            </select>
                                        </label>

                                        <label>
                                            <div style={{ color: "var(--text-muted)", fontSize: 12, marginBottom: 6 }}>
                                                {t("wizard.design.furigana")}
                                            </div>
                                            <select
                                                style={inputStyle}
                                                value={furiganaMode}
                                                onChange={(e) => updateSetting("furiganaMode", e.target.value as AppSettings["furiganaMode"])}
                                            >
                                                <option value="none">{t("wizard.furigana.none")}</option>
                                                <option value="auto">{t("wizard.furigana.auto")}</option>
                                            </select>
                                        </label>
                                    </div>
                                </div>

                                <div style={cardStyle}>
                                    <div style={{ color: "var(--text-muted)", fontSize: 12, marginBottom: 10 }}>
                                        {t("wizard.design.preview")}
                                    </div>
                                    <div style={{ fontFamily, fontSize, lineHeight: 1.9 }}>{t("wizard.design.previewText")}</div>
                                    <div style={{ color: "var(--text-muted)", marginTop: 10, fontSize: 13 }}>
                                        {t("wizard.design.previewHint")}
                                    </div>
                                </div>
                            </div>
                        )}

                        {step === "yomitan" && (
                            <div style={{ display: "grid", gap: 16 }}>
                                <h2 style={{ margin: 0 }}>{t("wizard.yomitan.title")}</h2>

                                <div style={warningStyle}>
                                    <b>{t("wizard.yomitan.warningTitle")}</b>
                                    <div>{t("wizard.yomitan.warningText")}</div>
                                    <pre style={codeStyle}>{`yomitan-settings.json
yomitan-dictionaries.json`}</pre>
                                </div>

                                <div style={{ display: "grid", gap: 14 }}>
                                    <div style={cardStyle}>
                                        <h3 style={{ marginTop: 0 }}>{t("wizard.yomitan.step1")}</h3>
                                        <img src="/setup/yomitan-step-1.gif" alt="" style={guideImageStyle} />
                                    </div>
                                    <div style={cardStyle}>
                                        <h3 style={{ marginTop: 0 }}>{t("wizard.yomitan.step2")}</h3>
                                        <img src="/setup/yomitan-step-2.gif" alt="" style={guideImageStyle} />
                                    </div>
                                    <div style={cardStyle}>
                                        <h3 style={{ marginTop: 0 }}>{t("wizard.yomitan.step3")}</h3>
                                        <p style={{ color: "var(--text-muted, #aaa)" }}>{t("wizard.yomitan.step3Text")}</p>
                                        <img src="/setup/yomitan-step-3.gif" alt="" style={guideImageStyle} />
                                    </div>
                                    <div style={cardStyle}>
                                        <h3 style={{ marginTop: 0 }}>{t("wizard.yomitan.step4")}</h3>
                                        <p style={{ color: "var(--text-muted, #aaa)" }}>{t("wizard.yomitan.step4Text")}</p>
                                        <button type="button" style={primaryButtonStyle} onClick={onImportYomitan}>
                                            {t("wizard.yomitan.import")}
                                        </button>
                                    </div>
                                </div>
                            </div>
                        )}

                        {step === "anki" && (
                            <div style={{ display: "grid", gap: 16 }}>
                                <h2 style={{ margin: 0 }}>{t("wizard.anki.title")}</h2>

                                <div style={cardStyle}>
                                    <h3 style={{ marginTop: 0 }}>{t("wizard.anki.todo")}</h3>
                                    <ol style={{ lineHeight: 1.7 }}>
                                        <li>{t("wizard.anki.todo1")}</li>
                                        <li>
                                            {t("wizard.anki.todo2")}
                                            <pre style={codeStyle}>{ANKI_CONNECT_ADDON_ID}</pre>
                                        </li>
                                        <li>{t("wizard.anki.todo3")}</li>
                                        <li>{t("wizard.anki.todo4")}</li>
                                    </ol>

                                    <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 14 }}>
                                        <button type="button" style={primaryButtonStyle} onClick={checkAnki}>
                                            {t("wizard.anki.check")}
                                        </button>
                                        {ankiStatus === "connected" && (
                                            <button type="button" style={buttonStyle} onClick={loadAnkiDecks}>
                                                {t("wizard.anki.refreshDecks")}
                                            </button>
                                        )}
                                    </div>

                                    <div style={{ marginTop: 14 }}>
                                        <StatusBadge ok={ankiStatus === "connected"} text={ankiStatusText} />
                                    </div>

                                    {ankiStatus === "idle" && (
                                        <div style={{ marginTop: 10, color: "var(--text-muted, #aaa)" }}>
                                            {t("wizard.anki.idleHint")}
                                        </div>
                                    )}

                                    {ankiStatus === "connected" && (
                                        <div style={{ marginTop: 16 }}>
                                            <div style={{ fontWeight: 800, marginBottom: 8 }}>{t("wizard.anki.deck")}</div>
                                            <select value={selectedAnkiDeck} onChange={(e) => applyDeck(e.target.value)} style={inputStyle}>
                                                {isLoadingDecks && <option value={selectedAnkiDeck || ""}>{t("wizard.anki.loadingDecks")}</option>}
                                                {!isLoadingDecks && ankiDecks.length === 0 && <option value="">{t("wizard.anki.noDecks")}</option>}
                                                {ankiDecks.map((deck) => (
                                                    <option key={deck} value={deck}>
                                                        {deck}
                                                    </option>
                                                ))}
                                            </select>

                                            {deckError && <div style={{ marginTop: 8, color: "#ff7b7b", fontWeight: 700 }}>{deckError}</div>}
                                            <div style={{ marginTop: 8, color: "var(--text-muted, #aaa)", lineHeight: 1.55 }}>
                                                {t("wizard.anki.deckHint")}
                                            </div>
                                            <div style={{ marginTop: 10, color: "var(--text-muted, #aaa)" }}>
                                                {t("wizard.anki.configNotNeeded")}
                                            </div>
                                        </div>
                                    )}
                                </div>

                                <div style={cardStyle}>
                                    <h3 style={{ marginTop: 0 }}>{t("wizard.anki.cardFormat")}</h3>
                                    <p style={{ color: "var(--text-muted, #aaa)", lineHeight: 1.6 }}>
                                        {t("wizard.anki.cardFormatText")}
                                    </p>
                                    <pre style={codeStyle}>{`Expression           -> word
ExpressionFurigana   -> word with Lapis furigana
ExpressionReading    -> reading
MainDefinition       -> definition
Sentence             -> sentence
ExpressionAudio      -> audio
DefinitionPicture    -> screenshot
Frequency            -> frequency
PitchPosition        -> pitch accent`}</pre>
                                    <div style={{ color: "var(--text-muted, #aaa)" }}>
                                        {t("wizard.anki.currentDeck")}: <b>{selectedAnkiDeck || ankiDeck || t("wizard.anki.notSelected")}</b>
                                        <br />
                                        {t("wizard.anki.currentModel")}: <b>{ankiModel || t("wizard.anki.notSelected")}</b>
                                    </div>
                                </div>

                                {(ankiStatus === "needs_config" || ankiStatus === "failed") && <AnkiConfigBlock language={language} />}
                            </div>
                        )}

                        {step === "finish" && (
                            <div style={{ display: "grid", gap: 16 }}>
                                <h2 style={{ margin: 0 }}>{t("wizard.finish.title")}</h2>
                                <div style={cardStyle}>
                                    <h3 style={{ marginTop: 0 }}>{t("wizard.finish.check")}</h3>
                                    <div style={{ display: "grid", gap: 10 }}>
                                        <StatusBadge
                                            ok={hasDictionaries}
                                            text={
                                                hasDictionaries
                                                    ? t("wizard.finish.dictsReady", { count: installedDictionariesCount })
                                                    : t("wizard.finish.dictsMissing")
                                            }
                                        />
                                        <StatusBadge
                                            ok={ankiStatus === "connected"}
                                            text={ankiStatus === "connected" ? t("wizard.finish.ankiReady") : t("wizard.finish.ankiLater")}
                                        />
                                        <StatusBadge
                                            ok={!!selectedAnkiDeck}
                                            text={
                                                selectedAnkiDeck
                                                    ? t("wizard.finish.deckReady", { deck: selectedAnkiDeck })
                                                    : t("wizard.finish.deckMissing")
                                            }
                                        />
                                    </div>
                                </div>

                                <div style={warningStyle}>{t("wizard.finish.warning")}</div>
                                <button type="button" style={primaryButtonStyle} onClick={onClose}>
                                    {t("wizard.startUsing")}
                                </button>
                            </div>
                        )}
                    </section>
                </main>

                <footer
                    style={{
                        padding: "14px 22px",
                        borderTop: "1px solid var(--border-color, #333)",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        gap: 12,
                    }}
                >
                    <button type="button" style={buttonStyle} onClick={prev} disabled={currentIndex === 0}>
                        {t("common.back")}
                    </button>

                    <div style={{ color: "var(--text-muted, #aaa)", fontSize: 13 }}>
                        {t("wizard.progress", { current: currentIndex + 1, total: steps.length })}
                    </div>

                    {step !== "finish" ? (
                        <button type="button" style={primaryButtonStyle} onClick={next}>
                            {t("common.next")}
                        </button>
                    ) : (
                        <button type="button" style={primaryButtonStyle} onClick={onClose}>
                            {t("common.close")}
                        </button>
                    )}
                </footer>
            </div>
        </div>
    );
}
