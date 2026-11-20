import { useCallback, useEffect, useRef, useState } from "react";
import { ensureSetsunaAnkiSetup, ensureSetsunaNoteType, getModelFields, invokeAnki, recommendAnkiFieldSettings } from "../utils/anki";
import type { AppSettings } from "./SettingsModal";
import FontPicker from "./FontPicker";
import { getTranslator, type AppLanguage } from "../utils/i18n";
import { usePresence } from "../utils/presence";
import "./SetupWizard.css";

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

type StepId = "look" | "dictionaries" | "anki" | "done";
/** idle: not tried yet; waiting: Anki not reachable, retrying in the background. */
type AnkiState = "idle" | "checking" | "connected" | "waiting" | "blocked";

const STEPS: StepId[] = ["look", "dictionaries", "anki", "done"];
const ANKI_CONNECT_ADDON_ID = "2055492159";
const ANKI_RETRY_MS = 2500;

// AnkiConnect config that allows Setsuna's requests; only needed when a user
// restricted webCorsOriginList and AnkiConnect answers 403.
const ANKI_CONNECT_CONFIG = JSON.stringify({
    apiKey: null,
    apiLogPath: null,
    ignoreOriginList: [],
    webBindAddress: "127.0.0.1",
    webBindPort: 8765,
    webCorsOriginList: ["http://localhost", "http://tauri.localhost", "tauri://localhost"],
}, null, 2);

const FONT_PRESETS = (t: ReturnType<typeof getTranslator>) => [
    { value: "'Noto Serif JP', 'Yu Mincho', 'YuMincho', 'Hiragino Mincho ProN', 'BIZ UDPMincho', 'Meiryo', serif", label: t("wizard.font.serif") },
    { value: "'Noto Sans JP', 'Yu Gothic UI', 'Yu Gothic', 'Meiryo', 'BIZ UDPGothic', sans-serif", label: t("wizard.font.sans") },
    { value: "'Yu Gothic UI', 'Yu Gothic', 'Meiryo', sans-serif", label: t("wizard.font.yu") },
    { value: "'Meiryo', 'Yu Gothic UI', sans-serif", label: t("wizard.font.meiryo") },
];

function Segmented<T extends string>({ value, options, onChange }: { value: T; options: { value: T; label: string }[]; onChange: (value: T) => void }) {
    return (
        <div className="sw-segmented" role="radiogroup">
            {options.map((option) => (
                <button
                    key={option.value}
                    type="button"
                    role="radio"
                    aria-checked={value === option.value}
                    className={value === option.value ? "is-active" : ""}
                    onClick={() => onChange(option.value)}
                >
                    {option.label}
                </button>
            ))}
        </div>
    );
}

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
    const isEn = language === "en";
    const L = (en: string, ru: string) => (isEn ? en : ru);
    const t = getTranslator(language);
    const presence = usePresence(isOpen, 220);

    const [step, setStep] = useState<StepId>("look");
    const [direction, setDirection] = useState<1 | -1>(1);
    const [ankiState, setAnkiState] = useState<AnkiState>("idle");
    const [decks, setDecks] = useState<string[]>([]);
    const [models, setModels] = useState<string[]>([]);
    const [model, setModel] = useState(ankiModel || "");
    const [deck, setDeck] = useState(ankiDeck || "");
    const [copied, setCopied] = useState<"code" | "config" | null>(null);
    const retryTimer = useRef(0);
    const checkingRef = useRef(false);

    const index = STEPS.indexOf(step);
    const hasDictionaries = installedDictionariesCount > 0;

    useEffect(() => {
        if (!isOpen) return;
        setStep("look");
        setDirection(1);
    }, [isOpen]);

    useEffect(() => { setDeck(ankiDeck || ""); }, [ankiDeck]);

    const patch = (value: Partial<AppSettings>) => onSettingsPatch?.(value);

    const chooseDeck = (next: string) => {
        setDeck(next);
        onAnkiDeckChange?.(next);
    };

    /** One attempt: reach AnkiConnect, then load decks and make sure a note type is set. */
    const connectAnki = useCallback(async (quiet: boolean) => {
        if (checkingRef.current) return;
        checkingRef.current = true;
        if (!quiet) setAnkiState("checking");
        try {
            await invokeAnki("version");
            const setup = await ensureSetsunaAnkiSetup();
            const list = Array.isArray(setup.decks) ? setup.decks : [];
            setDecks(list);
            const preferred = deck && list.includes(deck)
                ? deck
                : ankiDeck && list.includes(ankiDeck) ? ankiDeck : (setup.defaultDeck || list[0] || "");
            if (preferred) chooseDeck(preferred);
            // The wizard starts everyone on Setsuna's own card format
            // (created in Anki if it is missing); another type can be picked below.
            const noteType = await ensureSetsunaNoteType();
            setModels(noteType.models);
            if (noteType.model) {
                setModel(noteType.model);
                patch({ ankiDeck: preferred, ankiModel: noteType.model, ...recommendAnkiFieldSettings(noteType.fields) });
            }
            setAnkiState("connected");
        } catch (error) {
            const message = String((error as Error)?.message || error);
            setAnkiState(/\b403\b|forbidden|origin/i.test(message) ? "blocked" : "waiting");
        } finally {
            checkingRef.current = false;
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [deck, ankiDeck, ankiModel]);

    // On the Anki step, try right away and keep retrying quietly until Anki
    // answers: installing the add-on and restarting Anki connects by itself.
    useEffect(() => {
        if (!isOpen || step !== "anki" || ankiState === "connected" || ankiState === "blocked") return;
        if (ankiState === "idle") {
            void connectAnki(false);
            return;
        }
        if (ankiState !== "waiting") return;
        // An interval, not a timeout: a failed retry leaves the state at
        // "waiting", which would not re-run this effect.
        retryTimer.current = window.setInterval(() => void connectAnki(true), ANKI_RETRY_MS);
        return () => window.clearInterval(retryTimer.current);
    }, [isOpen, step, ankiState, connectAnki]);

    const chooseModel = async (next: string) => {
        setModel(next);
        const fields = await getModelFields(next, true).catch(() => [] as string[]);
        patch({ ankiModel: next, ...recommendAnkiFieldSettings(fields) });
    };

    const copy = async (text: string, what: "code" | "config") => {
        try {
            await navigator.clipboard.writeText(text);
            setCopied(what);
            window.setTimeout(() => setCopied(null), 2000);
        } catch {
            setCopied(null);
        }
    };

    const goTo = (next: StepId) => {
        setDirection(STEPS.indexOf(next) >= index ? 1 : -1);
        setStep(next);
    };

    if (!presence.mounted) return null;

    const theme = settings?.theme || "dark";
    const fontSize = settings?.fontSize || 26;
    const fontFamily = settings?.fontFamily || FONT_PRESETS(t)[0].value;
    const stepTitles: Record<StepId, string> = {
        look: L("Look", "Внешний вид"),
        dictionaries: L("Dictionaries", "Словари"),
        anki: "Anki",
        done: L("Done", "Готово"),
    };

    return (
        <div className={`sw-overlay${presence.closing ? " is-closing" : ""}`}>
            <div className="sw-panel" role="dialog" aria-modal="true" aria-label={L("Setsuna setup", "Настройка Setsuna")}>
                <header className="sw-head">
                    <div className="sw-progress" aria-label={L(`Step ${index + 1} of 4`, `Шаг ${index + 1} из 4`)}>
                        {STEPS.map((id, i) => (
                            <button
                                key={id}
                                type="button"
                                className={`sw-dot${i === index ? " is-active" : ""}${i < index ? " is-done" : ""}`}
                                onClick={() => goTo(id)}
                                title={stepTitles[id]}
                            >
                                <span>{i < index ? "✓" : i + 1}</span>
                                <em>{stepTitles[id]}</em>
                            </button>
                        ))}
                    </div>
                    <button type="button" className="sw-close" onClick={onClose} aria-label={t("common.close")}>×</button>
                </header>

                <section key={step} className={`sw-body${direction < 0 ? " is-back" : ""}`}>
                    {step === "look" && (
                        <>
                            <div className="sw-title">
                                <p className="sw-eyebrow">SETSUNA</p>
                                <h2>{L("Welcome! Let's set things up", "Привет! Давай всё настроим")}</h2>
                                <p>{L("Three short steps. Everything can be changed later in Settings.", "Три коротких шага. Всё можно поменять потом в настройках.")}</p>
                            </div>

                            <div className="sw-card sw-rows">
                                <div className="sw-row">
                                    <span>{L("Language", "Язык")}</span>
                                    <Segmented
                                        value={language}
                                        options={[{ value: "ru", label: "Русский" }, { value: "en", label: "English" }]}
                                        onChange={(value) => patch({ appLanguage: value as AppSettings["appLanguage"] })}
                                    />
                                </div>
                                <div className="sw-row">
                                    <span>{L("Theme", "Тема")}</span>
                                    <Segmented
                                        value={theme}
                                        options={[
                                            { value: "dark", label: t("wizard.theme.dark") },
                                            { value: "amoled", label: "AMOLED" },
                                            { value: "light", label: t("wizard.theme.light") },
                                        ]}
                                        onChange={(value) => patch({ theme: value as AppSettings["theme"] })}
                                    />
                                </div>
                                <div className="sw-row">
                                    <span>{L("Text font", "Шрифт текста")}</span>
                                    <FontPicker
                                        english={isEn}
                                        title={L("Text font", "Шрифт текста")}
                                        value={fontFamily}
                                        presets={FONT_PRESETS(t)}
                                        onChange={(value) => patch({ fontFamily: value })}
                                    />
                                </div>
                                <div className="sw-row">
                                    <span>{L("Text size", "Размер текста")}</span>
                                    <div className="sw-range">
                                        <input
                                            type="range"
                                            min={16}
                                            max={56}
                                            value={fontSize}
                                            onChange={(event) => patch({ fontSize: Number(event.target.value) })}
                                        />
                                        <b>{fontSize}px</b>
                                    </div>
                                </div>
                            </div>

                            <div className="sw-preview" style={{ fontFamily: `var(--txt-font-family, ${fontFamily})`, fontSize: "var(--txt-font-size, 26px)" }}>
                                {t("wizard.design.previewText")}
                            </div>
                        </>
                    )}

                    {step === "dictionaries" && (
                        <>
                            <div className="sw-title">
                                <h2>{L("Dictionaries", "Словари")}</h2>
                                <p>{L(
                                    "Setsuna uses Yomitan dictionaries. The fastest way is to import the ones you already have in Yomitan.",
                                    "Setsuna использует словари Yomitan. Быстрее всего — перенести те, что уже стоят у тебя в Yomitan.",
                                )}</p>
                            </div>

                            <div className={`sw-status${hasDictionaries ? " is-ok" : ""}`}>
                                <span className="sw-status-icon">{hasDictionaries ? "✓" : "字"}</span>
                                <div>
                                    <strong>{hasDictionaries
                                        ? L(`${installedDictionariesCount} dictionaries installed`, `Установлено словарей: ${installedDictionariesCount}`)
                                        : L("No dictionaries yet", "Словарей пока нет")}</strong>
                                    <small>{hasDictionaries
                                        ? L("You can add more any time in Settings → Dictionaries.", "Добавить ещё можно в любой момент: Настройки → Словари.")
                                        : L("Without a dictionary, lookups have nothing to show.", "Без словаря лукапу нечего показывать.")}</small>
                                </div>
                            </div>

                            <div className="sw-guide">
                                <figure className="sw-card">
                                    <figcaption><b>1</b>{L("Open Yomitan settings", "Открой настройки Yomitan")}</figcaption>
                                    <img src="/setup/yomitan-step-1.gif" alt="" />
                                </figure>
                                <figure className="sw-card">
                                    <figcaption><b>2</b>{L("Go to the Backup tab", "Перейди во вкладку Backup")}</figcaption>
                                    <img src="/setup/yomitan-step-2.gif" alt="" />
                                </figure>
                                <figure className="sw-card">
                                    <figcaption>
                                        <b>3</b>
                                        <span>
                                            {L("Export settings and dictionaries", "Экспортируй настройки и словари")}
                                            <small>{t("wizard.yomitan.step3Text")}</small>
                                        </span>
                                    </figcaption>
                                    <img src="/setup/yomitan-step-3.gif" alt="" />
                                </figure>
                                <div className="sw-card sw-guide-final">
                                    <figcaption>
                                        <b>4</b>
                                        <span>
                                            {L("Bring the files into Setsuna", "Закинь файлы в Setsuna")}
                                            <small>{t("wizard.yomitan.step4Text")}</small>
                                        </span>
                                    </figcaption>
                                    <button type="button" className="sw-btn primary" onClick={onImportYomitan}>
                                        {L("Import from Yomitan", "Импортировать из Yomitan")}
                                    </button>
                                </div>
                            </div>
                        </>
                    )}

                    {step === "anki" && (
                        <>
                            <div className="sw-title">
                                <h2>{L("Connect Anki", "Подключи Anki")}</h2>
                                <p>{L(
                                    "Cards are added with one click from the lookup. Setsuna talks to Anki through the AnkiConnect add-on.",
                                    "Карточки добавляются одним кликом прямо из лукапа. Setsuna общается с Anki через дополнение AnkiConnect.",
                                )}</p>
                            </div>

                            {ankiState === "connected" ? (
                                <>
                                    <div className="sw-status is-ok">
                                        <span className="sw-status-icon">✓</span>
                                        <div>
                                            <strong>{L("Anki is connected", "Anki подключена")}</strong>
                                            <small>{L("Pick the deck new cards should go to.", "Выбери колоду, куда будут добавляться карточки.")}</small>
                                        </div>
                                    </div>
                                    <div className="sw-card sw-rows">
                                        <div className="sw-row">
                                            <span>{L("Deck", "Колода")}</span>
                                            <select className="sw-select" value={deck} onChange={(event) => chooseDeck(event.target.value)}>
                                                {decks.map((name) => <option key={name} value={name}>{name}</option>)}
                                            </select>
                                        </div>
                                        <div className="sw-row">
                                            <span>{L("Note type", "Тип карточек")}</span>
                                            <select className="sw-select" value={model} onChange={(event) => void chooseModel(event.target.value)}>
                                                {models.map((name) => (
                                                    <option key={name} value={name}>
                                                        {name === "Setsuna Japanese" ? L(`${name} (default)`, `${name} (по умолчанию)`) : name}
                                                    </option>
                                                ))}
                                            </select>
                                        </div>
                                    </div>
                                </>
                            ) : ankiState === "blocked" ? (
                                <div className="sw-card sw-steps">
                                    <div className="sw-status is-warn">
                                        <span className="sw-status-icon">!</span>
                                        <div>
                                            <strong>{L("AnkiConnect refused the connection", "AnkiConnect отклонил подключение")}</strong>
                                            <small>{L("Its settings only allow other apps. Replace them with this config:", "В его настройках разрешены только другие приложения. Замени их этим конфигом:")}</small>
                                        </div>
                                    </div>
                                    <ol>
                                        <li>{L("Anki → Tools → Add-ons → AnkiConnect → Config.", "Anki → Инструменты → Дополнения → AnkiConnect → Настройки.")}</li>
                                        <li>{L("Paste the config, press OK and restart Anki.", "Вставь конфиг, нажми OK и перезапусти Anki.")}</li>
                                    </ol>
                                    <div className="sw-actions">
                                        <button type="button" className="sw-btn primary" onClick={() => void copy(ANKI_CONNECT_CONFIG, "config")}>
                                            {copied === "config" ? L("Copied ✓", "Скопировано ✓") : L("Copy config", "Скопировать конфиг")}
                                        </button>
                                        <button type="button" className="sw-btn" onClick={() => setAnkiState("idle")}>
                                            {L("Try again", "Проверить снова")}
                                        </button>
                                    </div>
                                </div>
                            ) : (
                                <div className="sw-card sw-steps">
                                    <div className="sw-status is-wait">
                                        <span className="sw-status-icon"><i className="sw-spinner" /></span>
                                        <div>
                                            <strong>{ankiState === "checking" || ankiState === "idle"
                                                ? L("Looking for Anki…", "Ищем Anki…")
                                                : L("Waiting for Anki", "Ждём Anki")}</strong>
                                            <small>{L("It connects by itself as soon as Anki with AnkiConnect is running.", "Подключится само, как только будет запущена Anki с AnkiConnect.")}</small>
                                        </div>
                                    </div>
                                    <ol>
                                        <li>{L("Open Anki.", "Открой Anki.")}</li>
                                        <li>
                                            {L("No AnkiConnect yet? Tools → Add-ons → Get Add-ons, paste the code and restart Anki:", "Нет AnkiConnect? Инструменты → Дополнения → Получить дополнения, вставь код и перезапусти Anki:")}
                                            <button type="button" className="sw-code" onClick={() => void copy(ANKI_CONNECT_ADDON_ID, "code")}>
                                                {ANKI_CONNECT_ADDON_ID}
                                                <span>{copied === "code" ? L("copied ✓", "скопировано ✓") : L("copy", "копировать")}</span>
                                            </button>
                                        </li>
                                    </ol>
                                </div>
                            )}
                        </>
                    )}

                    {step === "done" && (
                        <>
                            <div className="sw-title">
                                <h2>{L("All set", "Готово")}</h2>
                                <p>{L("Hook a game or paste text, then click any word to look it up.", "Подключи игру или вставь текст и нажимай на любое слово, чтобы его посмотреть.")}</p>
                            </div>
                            <div className="sw-card sw-summary">
                                <button type="button" className={hasDictionaries ? "is-ok" : ""} onClick={() => goTo("dictionaries")}>
                                    <span>{hasDictionaries ? "✓" : "·"}</span>
                                    {hasDictionaries
                                        ? L(`Dictionaries: ${installedDictionariesCount}`, `Словари: ${installedDictionariesCount}`)
                                        : L("No dictionaries — lookups will be empty", "Словарей нет — лукап будет пустым")}
                                </button>
                                <button type="button" className={ankiState === "connected" ? "is-ok" : ""} onClick={() => goTo("anki")}>
                                    <span>{ankiState === "connected" ? "✓" : "·"}</span>
                                    {ankiState === "connected"
                                        ? L(`Anki: deck “${deck}”`, `Anki: колода «${deck}»`)
                                        : L("Anki not connected — can be done later", "Anki не подключена — можно позже")}
                                </button>
                            </div>
                        </>
                    )}
                </section>

                <footer className="sw-foot">
                    {index > 0
                        ? <button type="button" className="sw-btn ghost" onClick={() => goTo(STEPS[index - 1])}>{t("common.back")}</button>
                        : <span />}
                    {step === "anki" && ankiState !== "connected" ? (
                        <button type="button" className="sw-btn" onClick={() => goTo("done")}>{L("Skip for now", "Пропустить")}</button>
                    ) : step === "done" ? (
                        <button type="button" className="sw-btn primary" onClick={onClose}>{L("Start reading", "Начать читать")}</button>
                    ) : (
                        <button type="button" className="sw-btn primary" onClick={() => goTo(STEPS[index + 1])}>{t("common.next")}</button>
                    )}
                </footer>
            </div>
        </div>
    );
}
