import React, { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getDecks } from "../utils/anki";

type SetupWizardProps = {
    isOpen: boolean;
    onClose: () => void;
    onImportYomitan?: () => void;
    installedDictionariesCount?: number;
    ankiDeck?: string;
    ankiModel?: string;
    onAnkiDeckChange?: (deck: string) => void;
};

type AnkiStatus = "idle" | "checking" | "connected" | "failed" | "needs_config";

const ANKI_CONNECT_ADDON_ID = "2055492159";

const cardStyle: React.CSSProperties = {
    border: "1px solid var(--border-color, #333)",
    background: "var(--bg-secondary, #1b1b1b)",
    borderRadius: 14,
    padding: 16,
};

const buttonStyle: React.CSSProperties = {
    border: "1px solid var(--border-color, #444)",
    borderRadius: 10,
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
    borderRadius: 12,
    padding: 12,
    lineHeight: 1.55,
};

const codeStyle: React.CSSProperties = {
    display: "block",
    background: "rgba(0,0,0,0.35)",
    border: "1px solid rgba(255,255,255,0.08)",
    borderRadius: 10,
    padding: 12,
    whiteSpace: "pre-wrap",
    overflowX: "auto",
    color: "var(--text-main, #eee)",
    fontSize: 13,
};

const inputStyle: React.CSSProperties = {
    width: "100%",
    borderRadius: 10,
    border: "1px solid rgba(255,255,255,0.12)",
    background: "rgba(0,0,0,0.35)",
    color: "var(--text-main, #eee)",
    padding: "10px 12px",
    fontWeight: 700,
    boxSizing: "border-box",
};

const guideImageStyle: React.CSSProperties = {
    width: "100%",
    maxHeight: 280,
    objectFit: "contain",
    borderRadius: 12,
    border: "1px solid rgba(255,255,255,0.08)",
    background: "#111",
};

const steps = [
    { id: "yomitan", title: "Словари из Yomitan" },
    { id: "anki", title: "AnkiConnect" },
    { id: "finish", title: "Готово" },
] as const;

type StepId = (typeof steps)[number]["id"];

const getRequiredAnkiCorsOrigins = () => {
    const origins = ["tauri://localhost"];

    const currentOrigin =
        typeof window !== "undefined" && window.location?.origin
            ? window.location.origin
            : "";

    const isDevOrigin =
        currentOrigin.startsWith("http://localhost") ||
        currentOrigin.startsWith("http://127.0.0.1");

    if (isDevOrigin && currentOrigin !== "null") {
        origins.push(currentOrigin);
    }

    return origins;
};

const DEFAULT_ANKI_CONNECT_CONFIG = {
    apiKey: null,
    apiLogPath: null,
    ignoreOriginList: [],
    webBindAddress: "127.0.0.1",
    webBindPort: 8765,
    webCorsOriginList: getRequiredAnkiCorsOrigins(),
};

const formatConfig = (config: unknown) => JSON.stringify(config, null, 2);

const mergeAnkiConnectConfig = (rawConfig: string) => {
    const parsed = rawConfig.trim() ? JSON.parse(rawConfig) : {};

    const currentCors = Array.isArray(parsed.webCorsOriginList)
        ? parsed.webCorsOriginList
        : [];

    const next = {
        ...parsed,
        webBindAddress: parsed.webBindAddress ?? "127.0.0.1",
        webBindPort: parsed.webBindPort ?? 8765,
        webCorsOriginList: Array.from(
            new Set([...currentCors, ...getRequiredAnkiCorsOrigins()])
        ),
    };

    if (!("apiKey" in next)) next.apiKey = null;
    if (!("apiLogPath" in next)) next.apiLogPath = null;
    if (!Array.isArray(next.ignoreOriginList)) next.ignoreOriginList = [];

    return formatConfig(next);
};

const AnkiConfigBlock = () => {
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
            setError("Config не похож на валидный JSON. Проверь кавычки, запятые и скобки.");
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
            <b>Config AnkiConnect / Конфиг AnkiConnect</b>

            <div style={{ marginTop: 10, lineHeight: 1.65 }}>
                <b>RU:</b> Если проверка подключения не прошла, скопируй текущий config AnkiConnect,
                вставь его ниже и нажми <b>Сгенерировать новый config</b>. Приложение добавит
                только нужные строки и не удалит старые разрешённые источники.
                <br />
                <b>EN:</b> If the connection test failed, copy your current AnkiConnect config,
                paste it below, and press <b>Generate new config</b>. The app will add only the
                required origins and keep your existing allowed origins.
            </div>

            <div style={{ marginTop: 12, lineHeight: 1.65 }}>
                <b>RU путь:</b> Anki → Инструменты → Дополнения → AnkiConnect → Конфигурация
                <br />
                <b>EN path:</b> Anki → Tools → Add-ons → AnkiConnect → Config
            </div>

            <textarea
                value={configInput}
                onChange={(e) => setConfigInput(e.target.value)}
                placeholder="Вставь сюда текущий config AnkiConnect. Если не знаешь что вставлять — оставь пустым и нажми кнопку ниже."
                style={{
                    width: "100%",
                    minHeight: 150,
                    marginTop: 12,
                    borderRadius: 10,
                    border: "1px solid rgba(255,255,255,0.12)",
                    background: "rgba(0,0,0,0.35)",
                    color: "var(--text-main, #eee)",
                    padding: 12,
                    fontFamily: "Consolas, monospace",
                    fontSize: 13,
                    resize: "vertical",
                    boxSizing: "border-box",
                }}
            />

            <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginTop: 10 }}>
                <button type="button" style={primaryButtonStyle} onClick={generateConfig}>
                    Сгенерировать новый config
                </button>

                <button type="button" style={buttonStyle} onClick={useDefaultConfig}>
                    Пустой базовый config
                </button>
            </div>

            {error && (
                <div style={{ marginTop: 10, color: "#ff7b7b", fontWeight: 800 }}>
                    {error}
                </div>
            )}

            <div style={{ marginTop: 16, color: "var(--text-muted, #aaa)" }}>
                Новый config:
            </div>

            <pre style={codeStyle}>{configOutput}</pre>

            <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap", marginTop: 10 }}>
                <button type="button" style={primaryButtonStyle} onClick={copyConfig}>
                    Скопировать новый config
                </button>

                {copied && (
                    <span style={{ color: "#8EF0B3", fontWeight: 800 }}>
                        Скопировано
                    </span>
                )}
            </div>

            <div style={{ marginTop: 12, color: "var(--text-muted, #aaa)", lineHeight: 1.6 }}>
                <b>RU:</b> После вставки config нажми OK/Save и полностью перезапусти Anki.
                <br />
                <b>EN:</b> After pasting the config, press OK/Save and fully restart Anki.
            </div>
        </div>
    );
};

const StatusBadge = ({ ok, text }: { ok: boolean; text: string }) => {
    return (
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
};

export default function SetupWizard({
    isOpen,
    onClose,
    onImportYomitan,
    installedDictionariesCount = 0,
    ankiDeck,
    ankiModel,
    onAnkiDeckChange,
}: SetupWizardProps) {
    const [step, setStep] = useState<StepId>("yomitan");
    const [ankiStatus, setAnkiStatus] = useState<AnkiStatus>("idle");
    const [ankiDecks, setAnkiDecks] = useState<string[]>([]);
    const [selectedAnkiDeck, setSelectedAnkiDeck] = useState(ankiDeck || "");
    const [isLoadingDecks, setIsLoadingDecks] = useState(false);
    const [deckError, setDeckError] = useState("");

    const currentIndex = steps.findIndex((item) => item.id === step);
    const hasDictionaries = installedDictionariesCount > 0;

    const ankiStatusText = useMemo(() => {
        if (ankiStatus === "checking") return "Проверяем AnkiConnect...";
        if (ankiStatus === "connected") return "AnkiConnect подключён";
        if (ankiStatus === "needs_config") return "Нужно поправить config AnkiConnect";
        if (ankiStatus === "failed") return "AnkiConnect не найден";
        return "Проверка ещё не запускалась";
    }, [ankiStatus]);

    useEffect(() => {
        if (!isOpen) return;
        setStep("yomitan");
    }, [isOpen]);

    useEffect(() => {
        setSelectedAnkiDeck(ankiDeck || "");
    }, [ankiDeck]);

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
                    (selectedAnkiDeck && safeDecks.includes(selectedAnkiDeck))
                        ? selectedAnkiDeck
                        : (ankiDeck && safeDecks.includes(ankiDeck))
                            ? ankiDeck
                            : safeDecks[0];

                applyDeck(preferred);
            } else {
                setDeckError("В Anki не найдено ни одной колоды.");
            }
        } catch (e) {
            setAnkiDecks([]);
            setDeckError("Не удалось загрузить список колод из Anki.");
        } finally {
            setIsLoadingDecks(false);
        }
    };

    const checkAnki = async () => {
        setAnkiStatus("checking");
        setDeckError("");

        try {
            const response = await fetch("http://127.0.0.1:8765", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    action: "version",
                    version: 6,
                }),
            });

            if (!response.ok) {
                throw new Error(`HTTP ${response.status}`);
            }

            const data = await response.json();
            if (data?.error) {
                throw new Error(data.error);
            }

            setAnkiStatus("connected");
            await loadAnkiDecks();
        } catch {
            try {
                await invoke("anki_check");
                setAnkiStatus("connected");
                await loadAnkiDecks();
            } catch {
                setAnkiStatus("needs_config");
            }
        }
    };

    const next = () => {
        const nextIndex = Math.min(currentIndex + 1, steps.length - 1);
        setStep(steps[nextIndex].id);
    };

    const prev = () => {
        const prevIndex = Math.max(currentIndex - 1, 0);
        setStep(steps[prevIndex].id);
    };

    if (!isOpen) return null;

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
                    borderRadius: 18,
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
                        <div style={{ fontSize: 22, fontWeight: 800 }}>Мастер настройки Setsuna</div>
                        <div style={{ color: "var(--text-muted, #aaa)", marginTop: 4 }}>
                            Словари, AnkiConnect и первый запуск
                        </div>
                    </div>

                    <button type="button" style={buttonStyle} onClick={onClose}>
                        Закрыть
                    </button>
                </header>

                <main
                    style={{
                        minHeight: 0,
                        display: "grid",
                        gridTemplateColumns: "220px 1fr",
                    }}
                >
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
                                        padding: "12px 12px",
                                        marginBottom: 8,
                                        borderRadius: 12,
                                        border: active
                                            ? "1px solid var(--accent, #4ea1ff)"
                                            : "1px solid transparent",
                                        background: active
                                            ? "rgba(78,161,255,.13)"
                                            : "transparent",
                                        color: active
                                            ? "var(--accent, #4ea1ff)"
                                            : "var(--text-main, #eee)",
                                        cursor: "pointer",
                                        fontWeight: active ? 800 : 600,
                                    }}
                                >
                                    <span style={{ opacity: 0.75, marginRight: 8 }}>
                                        {done ? "✓" : index + 1}
                                    </span>
                                    {item.title}
                                </button>
                            );
                        })}

                        <div style={{ marginTop: 18, display: "grid", gap: 10 }}>
                            <StatusBadge
                                ok={hasDictionaries}
                                text={hasDictionaries ? `Словарей: ${installedDictionariesCount}` : "Словарей нет"}
                            />
                            <StatusBadge
                                ok={ankiStatus === "connected"}
                                text={ankiStatusText}
                            />
                            {selectedAnkiDeck && (
                                <StatusBadge
                                    ok={true}
                                    text={`Дека: ${selectedAnkiDeck}`}
                                />
                            )}
                        </div>
                    </aside>

                    <section
                        style={{
                            overflow: "auto",
                            padding: 22,
                        }}
                    >
                        {step === "yomitan" && (
                            <div style={{ display: "grid", gap: 16 }}>
                                <h2 style={{ margin: 0 }}>📚 Импорт словарей и настроек из Yomitan</h2>

                                <div style={warningStyle}>
                                    <b>Не распаковывай файлы вручную.</b>
                                    <div>
                                        Нужно экспортировать два файла из Yomitan и закинуть их в приложение:
                                    </div>
                                    <pre style={codeStyle}>{`yomitan-settings.json
yomitan-dictionaries.json`}</pre>
                                </div>

                                <div style={{ display: "grid", gap: 14 }}>
                                    <div style={cardStyle}>
                                        <h3 style={{ marginTop: 0 }}>Шаг 1. Открой настройки Yomitan</h3>
                                        <img src="/setup/yomitan-step-1.gif" alt="Открыть настройки Yomitan" style={guideImageStyle} />
                                    </div>

                                    <div style={cardStyle}>
                                        <h3 style={{ marginTop: 0 }}>Шаг 2. Перейди во вкладку Backup</h3>
                                        <img src="/setup/yomitan-step-2.gif" alt="Вкладка Backup в Yomitan" style={guideImageStyle} />
                                    </div>

                                    <div style={cardStyle}>
                                        <h3 style={{ marginTop: 0 }}>Шаг 3. Экспортируй настройки и словари</h3>
                                        <p style={{ color: "var(--text-muted, #aaa)" }}>
                                            Нажми <b>Export Settings</b>, затем <b>Export Dictionary Collection</b>.
                                            Экспорт словарей может занять время — это нормально.
                                        </p>
                                        <img src="/setup/yomitan-step-3.gif" alt="Export Settings и Export Dictionary Collection" style={guideImageStyle} />
                                    </div>

                                    <div style={cardStyle}>
                                        <h3 style={{ marginTop: 0 }}>Шаг 4. Закинь файлы в Setsuna</h3>
                                        <p style={{ color: "var(--text-muted, #aaa)" }}>
                                            Перетащи оба файла в окно приложения или нажми кнопку импорта.
                                        </p>

                                        <button type="button" style={primaryButtonStyle} onClick={onImportYomitan}>
                                            Импортировать файлы Yomitan
                                        </button>
                                    </div>
                                </div>
                            </div>
                        )}

                        {step === "anki" && (
                            <div style={{ display: "grid", gap: 16 }}>
                                <h2 style={{ margin: 0 }}>🧠 Подключение AnkiConnect</h2>

                                <div style={cardStyle}>
                                    <h3 style={{ marginTop: 0 }}>Что нужно сделать</h3>
                                    <ol style={{ lineHeight: 1.7 }}>
                                        <li>Открой Anki.</li>
                                        <li>
                                            Установи аддон AnkiConnect через ID:
                                            <pre style={codeStyle}>{ANKI_CONNECT_ADDON_ID}</pre>
                                        </li>
                                        <li>Перезапусти Anki.</li>
                                        <li>Нажми кнопку проверки ниже.</li>
                                    </ol>

                                    <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 14 }}>
                                        <button type="button" style={primaryButtonStyle} onClick={checkAnki}>
                                            Проверить подключение
                                        </button>

                                        {ankiStatus === "connected" && (
                                            <button type="button" style={buttonStyle} onClick={loadAnkiDecks}>
                                                Обновить список дек
                                            </button>
                                        )}
                                    </div>

                                    <div style={{ marginTop: 14 }}>
                                        <StatusBadge ok={ankiStatus === "connected"} text={ankiStatusText} />
                                    </div>

                                    {ankiStatus === "idle" && (
                                        <div style={{ marginTop: 10, color: "var(--text-muted, #aaa)" }}>
                                            Сначала нажми проверку. Если всё подключится, config AnkiConnect менять не понадобится.
                                        </div>
                                    )}

                                    {ankiStatus === "connected" && (
                                        <div style={{ marginTop: 16 }}>
                                            <div style={{ fontWeight: 800, marginBottom: 8 }}>
                                                Выбор колоды Anki
                                            </div>

                                            <select
                                                value={selectedAnkiDeck}
                                                onChange={(e) => applyDeck(e.target.value)}
                                                style={inputStyle}
                                            >
                                                {isLoadingDecks && (
                                                    <option value={selectedAnkiDeck || ""}>
                                                        Загрузка колод...
                                                    </option>
                                                )}

                                                {!isLoadingDecks && ankiDecks.length === 0 && (
                                                    <option value="">
                                                        Колоды не найдены
                                                    </option>
                                                )}

                                                {ankiDecks.map((deck) => (
                                                    <option key={deck} value={deck}>
                                                        {deck}
                                                    </option>
                                                ))}
                                            </select>

                                            {deckError && (
                                                <div style={{ marginTop: 8, color: "#ff7b7b", fontWeight: 700 }}>
                                                    {deckError}
                                                </div>
                                            )}

                                            <div style={{ marginTop: 8, color: "var(--text-muted, #aaa)", lineHeight: 1.55 }}>
                                                Карточки будут добавляться в выбранную колоду. Это можно поменять позже в настройках Anki.
                                            </div>
                                        </div>
                                    )}

                                    {ankiStatus === "connected" && (
                                        <div style={{ marginTop: 10, color: "var(--text-muted, #aaa)" }}>
                                            Config AnkiConnect менять не нужно.
                                        </div>
                                    )}
                                </div>

                                <div style={cardStyle}>
                                    <h3 style={{ marginTop: 0 }}>Рекомендуемый формат карточек</h3>
                                    <p style={{ color: "var(--text-muted, #aaa)", lineHeight: 1.6 }}>
                                        Для Setsuna лучше использовать Lapis / Lapis++++ preset.
                                        Поля должны быть примерно такими:
                                    </p>

                                    <pre style={codeStyle}>{`Expression           → чистое слово
ExpressionFurigana   → слово с Lapis-фуриганой
ExpressionReading    → чтение, если поле есть
MainDefinition       → перевод / определение
Sentence             → предложение
ExpressionAudio      → аудио
DefinitionPicture    → скриншот
Frequency            → частотность
PitchPosition        → pitch accent`}</pre>

                                    <div style={{ color: "var(--text-muted, #aaa)" }}>
                                        Текущая колода: <b>{selectedAnkiDeck || ankiDeck || "не выбрана"}</b>
                                        <br />
                                        Текущая модель: <b>{ankiModel || "не выбрана"}</b>
                                    </div>
                                </div>

                                {(ankiStatus === "needs_config" || ankiStatus === "failed") && (
                                    <AnkiConfigBlock />
                                )}
                            </div>
                        )}

                        {step === "finish" && (
                            <div style={{ display: "grid", gap: 16 }}>
                                <h2 style={{ margin: 0 }}>🚀 Готово</h2>

                                <div style={cardStyle}>
                                    <h3 style={{ marginTop: 0 }}>Проверка</h3>
                                    <div style={{ display: "grid", gap: 10 }}>
                                        <StatusBadge
                                            ok={hasDictionaries}
                                            text={hasDictionaries ? `Словари установлены: ${installedDictionariesCount}` : "Словари пока не установлены"}
                                        />
                                        <StatusBadge
                                            ok={ankiStatus === "connected"}
                                            text={ankiStatus === "connected" ? "AnkiConnect работает" : "AnkiConnect можно настроить позже"}
                                        />
                                        <StatusBadge
                                            ok={!!selectedAnkiDeck}
                                            text={selectedAnkiDeck ? `Колода Anki: ${selectedAnkiDeck}` : "Колода Anki не выбрана"}
                                        />
                                    </div>
                                </div>

                                <div style={warningStyle}>
                                    Если словарей ещё нет — lookup не будет нормально работать.
                                    Anki можно настроить позже, но словари лучше поставить сразу.
                                </div>

                                <button type="button" style={primaryButtonStyle} onClick={onClose}>
                                    Начать пользоваться
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
                        Назад
                    </button>

                    <div style={{ color: "var(--text-muted, #aaa)", fontSize: 13 }}>
                        Шаг {currentIndex + 1} из {steps.length}
                    </div>

                    {step !== "finish" ? (
                        <button type="button" style={primaryButtonStyle} onClick={next}>
                            Далее
                        </button>
                    ) : (
                        <button type="button" style={primaryButtonStyle} onClick={onClose}>
                            Закрыть
                        </button>
                    )}
                </footer>
            </div>
        </div>
    );
}
