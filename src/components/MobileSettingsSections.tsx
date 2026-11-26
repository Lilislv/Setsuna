import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { appVersionLabel } from "../utils/appVersion";
import SettingsMangaOcr from "../features/manga/SettingsMangaOcr";
import type { AppSettings, TextReplacement } from "./SettingsModal";

type DiscoveredWs = {
    name: string;
    url: string;
    host: string;
    port: number;
    path: string;
    isLocal: boolean;
};

type SettingUpdater = (key: string, value: any) => void;

export function MobileWsDiscoveryBlock({
    isEn,
    extraHosts,
    onConnectUrl,
    onAddUrls,
    isKnownUrl,
}: {
    isEn: boolean;
    extraHosts: string[];
    /** Add the address to the list (if new) and connect it. */
    onConnectUrl: (url: string, name?: string) => void;
    /** Add addresses to the list without connecting; existing entries stay as they are. */
    onAddUrls?: (items: { url: string; name: string }[]) => void;
    isKnownUrl?: (url: string) => boolean;
}) {
    const [scanning, setScanning] = useState(false);
    const [status, setStatus] = useState("");
    const [found, setFound] = useState<DiscoveredWs[]>([]);

    const scanNetwork = async () => {
        setScanning(true);
        setFound([]);
        setStatus(isEn ? "Scanning Wi-Fi network..." : "Сканирую локальную сеть Wi-Fi...");
        try {
            const items = await invoke<DiscoveredWs[]>("discover_websocket_sources", {
                extraHosts,
                scanLan: true,
            });
            const list = Array.isArray(items) ? items : [];
            setFound(list);
            setStatus(
                list.length > 0
                    ? isEn
                        ? `Found sources: ${list.length}`
                        : `Найдено источников: ${list.length}`
                    : isEn
                      ? "Nothing found on Wi-Fi. Make sure Textractor / LunaTranslator WebSocket is running."
                      : "Ничего не найдено в сети Wi-Fi. Убедись, что WebSocket в Textractor / LunaTranslator запущен.",
            );
        } catch (err) {
            setStatus(err instanceof Error ? err.message : String(err));
        } finally {
            setScanning(false);
        }
    };

    return (
        <div className="mobile-settings-section">
            <div className="mobile-section-title">{isEn ? "Auto-find on Wi-Fi" : "Авто-поиск в сети"}</div>
            <button type="button" className="mobile-action" data-coach="m-source-find" disabled={scanning} onClick={() => void scanNetwork()}>
                {scanning
                    ? isEn
                        ? "Scanning…"
                        : "Сканирую…"
                    : isEn
                      ? "Auto-find on Wi-Fi"
                      : "Найти в локальной сети"}
            </button>
            {status && <div className="mobile-drive-status">{status}</div>}
            {found.length > 0 && (
                <div className="m-ws-found-list">
                    {found.map((item) => {
                        const known = isKnownUrl?.(item.url) ?? false;
                        const label = `${item.name} · ${item.isLocal ? (isEn ? "this phone" : "этот телефон") : item.host}`;
                        return (
                            <div key={item.url} className="m-ws-found-row">
                                <div className="m-ws-found-info">
                                    <strong>{item.name}</strong>
                                    <small>{item.url}</small>
                                    {known && <small className="m-ws-found-known">{isEn ? "Already in your list" : "Уже в списке"}</small>}
                                </div>
                                <div className="m-ws-found-actions">
                                    {!known && onAddUrls && (
                                        <button type="button" className="mobile-action m-ws-found-btn" onClick={() => onAddUrls([{ url: item.url, name: label }])}>
                                            {isEn ? "Add" : "Добавить"}
                                        </button>
                                    )}
                                    <button type="button" className="mobile-action primary m-ws-found-btn" onClick={() => onConnectUrl(item.url, label)}>
                                        {isEn ? "Connect" : "Подключить"}
                                    </button>
                                </div>
                            </div>
                        );
                    })}
                    {onAddUrls && found.filter((item) => !isKnownUrl?.(item.url)).length > 1 && (
                        <button
                            type="button"
                            className="mobile-action"
                            onClick={() => onAddUrls(found
                                .filter((item) => !isKnownUrl?.(item.url))
                                .map((item) => ({ url: item.url, name: `${item.name} · ${item.isLocal ? (isEn ? "this phone" : "этот телефон") : item.host}` })))}
                        >
                            {isEn ? "Add all to the list" : "Добавить все в список"}
                        </button>
                    )}
                </div>
            )}
        </div>
    );
}

export function MobileAppearanceAndTextSettings({
    settings,
    isEn,
    updateSetting,
}: {
    settings: AppSettings;
    isEn: boolean;
    updateSetting: SettingUpdater;
}) {
    const [newPattern, setNewPattern] = useState("");
    const [newReplacement, setNewReplacement] = useState("");
    const [newIsRegex, setNewIsRegex] = useState(false);

    const replacements: TextReplacement[] = Array.isArray(settings.replacements) ? settings.replacements : [];

    const addRule = () => {
        if (!newPattern) return;
        const next: TextReplacement[] = [
            ...replacements,
            {
                id: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
                active: true,
                pattern: newPattern,
                replacement: newReplacement,
                isRegex: newIsRegex,
            },
        ];
        updateSetting("replacements", next);
        setNewPattern("");
        setNewReplacement("");
        setNewIsRegex(false);
    };

    const toggleRule = (id: string) => {
        updateSetting(
            "replacements",
            replacements.map((rule) => (rule.id === id ? { ...rule, active: !rule.active } : rule)),
        );
    };

    const deleteRule = (id: string) => {
        updateSetting(
            "replacements",
            replacements.filter((rule) => rule.id !== id),
        );
    };

    return (
        <>
            <div className="mobile-settings-section">
                <div className="mobile-section-title">{isEn ? "Appearance" : "Интерфейс и текст"}</div>
                <label className="mobile-setting-row">
                    <span>{isEn ? "Theme" : "Тема"}</span>
                    <select value={settings.theme || "dark"} onChange={(e) => updateSetting("theme", e.target.value)}>
                        <option value="dark">{isEn ? "Dark" : "Тёмная"}</option>
                        <option value="light">{isEn ? "Light" : "Светлая"}</option>
                        <option value="amoled">AMOLED</option>
                    </select>
                </label>
                <label className="mobile-setting-row">
                    <span>{isEn ? "Language" : "Язык"}</span>
                    <select value={settings.appLanguage || "ru"} onChange={(e) => updateSetting("appLanguage", e.target.value)}>
                        <option value="ru">Русский</option>
                        <option value="en">English</option>
                    </select>
                </label>
                <div className="mobile-settings-note">
                    <strong style={{ color: "#f59e0b", marginRight: 6 }}>{isEn ? "ALPHA" : "АЛЬФА"}</strong>
                    {isEn
                        ? "Primary target learning language: Japanese. English as a target learning language is early alpha."
                        : "Основной язык изучения: японский. Поддержка английского как целевого языка изучения — ранняя альфа."}
                </div>
                <label className="mobile-setting-row mobile-setting-range">
                    <span>
                        {isEn ? "Font size" : "Размер текста"} <b>{settings.fontSize || 26}px</b>
                    </span>
                    <input
                        type="range"
                        min="18"
                        max="36"
                        value={settings.fontSize || 26}
                        onChange={(e) => updateSetting("fontSize", Number(e.target.value))}
                    />
                </label>
                <label className="mobile-setting-row">
                    <span>{isEn ? "Furigana" : "Фуригана"}</span>
                    <select
                        value={settings.furiganaMode === "auto" ? "auto" : "none"}
                        onChange={(e) => updateSetting("furiganaMode", e.target.value)}
                    >
                        <option value="none">{isEn ? "Off" : "Выкл"}</option>
                        <option value="auto">{isEn ? "Auto" : "Авто"}</option>
                    </select>
                </label>
                <label className="mobile-setting-row">
                    <span>{isEn ? "Text direction" : "Направление текста"}</span>
                    <select
                        value={settings.textOrientation || "horizontal"}
                        onChange={(e) => updateSetting("textOrientation", e.target.value)}
                    >
                        <option value="horizontal">{isEn ? "Horizontal" : "Горизонтально"}</option>
                        <option value="vertical">{isEn ? "Vertical right-to-left" : "Вертикально справа налево"}</option>
                    </select>
                </label>
                <label className="mobile-setting-row mobile-setting-range">
                    <span>
                        {isEn ? "Autoscroll position" : "Позиция автоскролла"} <b>{settings.autoScrollOffset ?? 80}%</b>
                    </span>
                    <input
                        type="range"
                        min="0"
                        max="240"
                        step="5"
                        value={settings.autoScrollOffset ?? 80}
                        onChange={(e) => updateSetting("autoScrollOffset", Number(e.target.value))}
                    />
                </label>
            </div>

            <div className="mobile-settings-section">
                <div className="mobile-section-title">{isEn ? "Timer and speed" : "Таймер и статистика"}</div>
                <label className="mobile-setting-row">
                    <span>{isEn ? "Speed metric" : "Метрика скорости"}</span>
                    <select value={settings.speedMetric || "chars"} onChange={(e) => updateSetting("speedMetric", e.target.value)}>
                        <option value="chars">{isEn ? "Characters" : "Символы"}</option>
                        <option value="words">{isEn ? "Words" : "Слова"}</option>
                        <option value="sentences">{isEn ? "Sentences" : "Предложения"}</option>
                    </select>
                </label>
                <label className="mobile-setting-row">
                    <span>{isEn ? "Timeframe" : "Интервал"}</span>
                    <select
                        value={settings.speedTimeframe || "minute"}
                        onChange={(e) => updateSetting("speedTimeframe", e.target.value)}
                    >
                        <option value="minute">{isEn ? "Per minute" : "В минуту"}</option>
                        <option value="hour">{isEn ? "Per hour" : "В час"}</option>
                    </select>
                </label>
                <label className="mobile-setting-row">
                    <span>{isEn ? "Auto-pause on idle" : "Автопауза при бездействии"}</span>
                    <input
                        type="checkbox"
                        checked={settings.autoPauseOnIdle ?? false}
                        onChange={(e) => updateSetting("autoPauseOnIdle", e.target.checked)}
                    />
                </label>
                {settings.autoPauseOnIdle && (
                    <label className="mobile-setting-row mobile-setting-range">
                        <span>
                            {isEn ? "Idle minutes" : "Минут бездействия"} <b>{settings.autoPauseIdleMinutes ?? 5}</b>
                        </span>
                        <input
                            type="range"
                            min="1"
                            max="15"
                            value={Math.min(15, Math.max(1, settings.autoPauseIdleMinutes ?? 5))}
                            onChange={(e) => updateSetting("autoPauseIdleMinutes", Number(e.target.value))}
                        />
                    </label>
                )}
            </div>

            <div className="mobile-settings-section">
                <div className="mobile-section-title">{isEn ? "Text cleaner & filters" : "Фильтры и чистка текста"}</div>
                <label className="mobile-setting-row">
                    <span>{isEn ? "Clean hooked text" : "Чистить HTML / теги"}</span>
                    <input
                        type="checkbox"
                        checked={settings.enableTextCleaner !== false}
                        onChange={(e) => updateSetting("enableTextCleaner", e.target.checked)}
                    />
                </label>
                <label className="mobile-setting-row">
                    <span>{isEn ? "Remove spaces" : "Убирать пробелы"}</span>
                    <input
                        type="checkbox"
                        checked={settings.removeWhitespace ?? false}
                        onChange={(e) => updateSetting("removeWhitespace", e.target.checked)}
                    />
                </label>
                <label className="mobile-setting-row">
                    <span>{isEn ? "Japanese lines only" : "Только строки с японским"}</span>
                    <input
                        type="checkbox"
                        checked={settings.requireJapanese ?? false}
                        onChange={(e) => updateSetting("requireJapanese", e.target.checked)}
                    />
                </label>
                <label className="mobile-setting-row">
                    <span>{isEn ? "Ignore consecutive duplicates" : "Игнорировать дубликаты подряд"}</span>
                    <input
                        type="checkbox"
                        checked={settings.ignoreDuplicates ?? true}
                        onChange={(e) => updateSetting("ignoreDuplicates", e.target.checked)}
                    />
                </label>

                <div className="mobile-section-title">{isEn ? "Text replacements" : "Правила автозамены"}</div>
                {replacements.length === 0 ? (
                    <div className="mobile-settings-note">
                        {isEn ? "No replacement rules yet." : "Правил автозамены пока нет."}
                    </div>
                ) : (
                    <div className="m-repl-list">
                        {replacements.map((rule) => (
                            <div key={rule.id} className="m-repl-row">
                                <input
                                    type="checkbox"
                                    checked={rule.active}
                                    onChange={() => toggleRule(rule.id)}
                                    aria-label={rule.pattern || "Rule"}
                                />
                                <div className="m-repl-text">
                                    <code>{rule.pattern || (isEn ? "(empty)" : "(пусто)")}</code>
                                    <span>→</span>
                                    <code>{rule.replacement || "∅"}</code>
                                </div>
                                {rule.isRegex && <span className="m-repl-badge">Re</span>}
                                <button
                                    type="button"
                                    className="m-repl-del"
                                    onClick={() => deleteRule(rule.id)}
                                    aria-label={isEn ? "Delete rule" : "Удалить правило"}
                                >
                                    ×
                                </button>
                            </div>
                        ))}
                    </div>
                )}
                <div className="m-repl-add">
                    <input
                        type="text"
                        value={newPattern}
                        onChange={(e) => setNewPattern(e.target.value)}
                        placeholder={isEn ? "Find…" : "Найти…"}
                    />
                    <input
                        type="text"
                        value={newReplacement}
                        onChange={(e) => setNewReplacement(e.target.value)}
                        placeholder={isEn ? "Replace with…" : "Заменить на…"}
                    />
                    <div className="m-repl-add-actions">
                        <label className="m-repl-regex-check">
                            <input
                                type="checkbox"
                                checked={newIsRegex}
                                onChange={(e) => setNewIsRegex(e.target.checked)}
                            />
                            <span>Regex</span>
                        </label>
                        <button type="button" className="mobile-action primary" disabled={!newPattern} onClick={addRule}>
                            {isEn ? "Add rule" : "Добавить"}
                        </button>
                    </div>
                </div>
            </div>
        </>
    );
}

export function MobileLookupAppearanceSettings({
    settings,
    isEn,
    updateSetting,
}: {
    settings: AppSettings;
    isEn: boolean;
    updateSetting: SettingUpdater;
}) {
    return (
        <div className="mobile-settings-section">
            <div className="mobile-section-title">{isEn ? "Lookup appearance" : "Вид окна словаря"}</div>
            <label className="mobile-setting-row mobile-setting-range">
                <span>
                    {isEn ? "Definition font size" : "Размер текста"} <b>{settings.lookupFontSize || 15}px</b>
                </span>
                <input
                    type="range"
                    min="12"
                    max="24"
                    value={settings.lookupFontSize || 15}
                    onChange={(e) => updateSetting("lookupFontSize", Number(e.target.value))}
                />
            </label>
            <label className="mobile-setting-row mobile-setting-range">
                <span>
                    {isEn ? "Tag size" : "Размер тегов"} <b>{settings.lookupTagFontSize || 11}px</b>
                </span>
                <input
                    type="range"
                    min="10"
                    max="18"
                    value={settings.lookupTagFontSize || 11}
                    onChange={(e) => updateSetting("lookupTagFontSize", Number(e.target.value))}
                />
            </label>
            <label className="mobile-setting-row">
                <span>{isEn ? "Show grammar and tags" : "Показывать грамматику и теги"}</span>
                <input
                    type="checkbox"
                    checked={settings.lookupShowTags ?? true}
                    onChange={(e) => updateSetting("lookupShowTags", e.target.checked)}
                />
            </label>
            <label className="mobile-setting-row">
                <span>{isEn ? "Show audio button" : "Показывать кнопку аудио"}</span>
                <input
                    type="checkbox"
                    checked={settings.lookupShowAudio ?? true}
                    onChange={(e) => updateSetting("lookupShowAudio", e.target.checked)}
                />
            </label>
            <label className="mobile-setting-row">
                <span>{isEn ? "Auto-play audio on lookup" : "Авто-озвучка при поиске"}</span>
                <input
                    type="checkbox"
                    checked={settings.autoPlayAudio ?? false}
                    onChange={(e) => updateSetting("autoPlayAudio", e.target.checked)}
                />
            </label>
        </div>
    );
}

export function MobileAnkiExtendedSettings({
    settings,
    isEn,
    ankiFields,
    updateSetting,
}: {
    settings: AppSettings;
    isEn: boolean;
    ankiFields: string[];
    updateSetting: SettingUpdater;
}) {
    const fieldSelect = (label: string, key: keyof AppSettings) => (
        <label key={String(key)} className="mobile-setting-row">
            <span>{label}</span>
            <select value={(settings[key] as string) || "none"} onChange={(e) => updateSetting(String(key), e.target.value)}>
                <option value="none">{isEn ? "None" : "Не задано"}</option>
                {ankiFields.map((field) => (
                    <option key={field} value={field}>
                        {field}
                    </option>
                ))}
            </select>
        </label>
    );

    return (
        <>
            <div className="mobile-section-title">{isEn ? "Deck mode & extra fields" : "Режим колод и доп. поля"}</div>
            <label className="mobile-setting-row">
                <span>{isEn ? "Deck mode" : "Выбор колоды"}</span>
                <select value={settings.ankiDeckMode || "shared"} onChange={(e) => updateSetting("ankiDeckMode", e.target.value)}>
                    <option value="shared">{isEn ? "One deck everywhere" : "Одна колода для всего"}</option>
                    <option value="contextual">{isEn ? "Per window / book" : "Своя для каждого окна"}</option>
                </select>
            </label>
            {fieldSelect(isEn ? "Reading field" : "Поле чтения", "ankiFieldReading")}
            {fieldSelect(isEn ? "Sentence furigana field" : "Поле примера с фуриганой", "ankiFieldSentenceFurigana")}
            {fieldSelect(isEn ? "Dictionary field" : "Поле словаря", "ankiFieldDict")}
            {fieldSelect(isEn ? "Audio field" : "Поле аудио", "ankiFieldAudio")}
            {fieldSelect(isEn ? "Pitch accent field" : "Поле питча", "ankiFieldPitch")}
            {fieldSelect(isEn ? "Frequency field" : "Поле частоты", "ankiFieldFreq")}

            <div className="mobile-section-title">{isEn ? "Anki buttons & duplicates" : "Кнопки и дубликаты"}</div>
            <label className="mobile-setting-row">
                <span>{isEn ? "Show regular “+ Anki” button" : "Кнопка обычного добавления"}</span>
                <input
                    type="checkbox"
                    checked={settings.ankiShowButtonNormal ?? true}
                    onChange={(e) => updateSetting("ankiShowButtonNormal", e.target.checked)}
                />
            </label>
            <label className="mobile-setting-row">
                <span>{isEn ? "Show “+ Screenshot” button" : "Кнопка со скриншотом"}</span>
                <input
                    type="checkbox"
                    checked={settings.ankiShowButtonScreenshot ?? true}
                    onChange={(e) => updateSetting("ankiShowButtonScreenshot", e.target.checked)}
                />
            </label>
            <label className="mobile-setting-row">
                <span>{isEn ? "Allow duplicates in other decks" : "Разрешить дубли из других колод"}</span>
                <input
                    type="checkbox"
                    checked={settings.ankiAllowDuplicatesOther ?? true}
                    onChange={(e) => updateSetting("ankiAllowDuplicatesOther", e.target.checked)}
                />
            </label>
            <label className="mobile-setting-row">
                <span>{isEn ? "Allow duplicates in same deck" : "Разрешить дубли в этой же колоде"}</span>
                <input
                    type="checkbox"
                    checked={settings.ankiAllowDuplicatesSame ?? false}
                    onChange={(e) => updateSetting("ankiAllowDuplicatesSame", e.target.checked)}
                />
            </label>
            <div className="mobile-color-row">
                <label>
                    <span>{isEn ? "New" : "Новое"}</span>
                    <input
                        type="color"
                        value={settings.ankiColorNew || "#4CAF50"}
                        onChange={(e) => updateSetting("ankiColorNew", e.target.value)}
                    />
                </label>
                <label>
                    <span>{isEn ? "Other deck" : "Другая колода"}</span>
                    <input
                        type="color"
                        value={settings.ankiColorOther || "#4fa6ff"}
                        onChange={(e) => updateSetting("ankiColorOther", e.target.value)}
                    />
                </label>
                <label>
                    <span>{isEn ? "Same deck" : "Эта колода"}</span>
                    <input
                        type="color"
                        value={settings.ankiColorSame || "#ff4444"}
                        onChange={(e) => updateSetting("ankiColorSame", e.target.value)}
                    />
                </label>
            </div>
        </>
    );
}

export function MobileReaderSettings({
    settings,
    isEn,
    updateSetting,
}: {
    settings: AppSettings;
    isEn: boolean;
    updateSetting: SettingUpdater;
}) {
    const blurMode = settings.epubBlurImagesMode || (settings.epubBlurImages ? "all" : "off");

    return (
        <>
            <div className="mobile-settings-section">
                <div className="mobile-section-title">{isEn ? "Book reader (EPUB)" : "Читалка книг (EPUB)"}</div>
                <label className="mobile-setting-row">
                    <span>{isEn ? "Theme" : "Тема"}</span>
                    <select value={settings.epubTheme || "app"} onChange={(e) => updateSetting("epubTheme", e.target.value)}>
                        <option value="app">{isEn ? "Use app theme" : "Как в приложении"}</option>
                        <option value="dark">{isEn ? "Dark" : "Тёмная"}</option>
                        <option value="paper">{isEn ? "Paper" : "Бумага"}</option>
                        <option value="sepia">{isEn ? "Sepia" : "Сепия"}</option>
                        <option value="ttu-light">Ttu Light</option>
                        <option value="ttu-ecru">Ttu Ecru</option>
                        <option value="ttu-water">Ttu Water</option>
                        <option value="ttu-gray">Ttu Gray</option>
                        <option value="ttu-dark">Ttu Dark</option>
                        <option value="ttu-black">Ttu Black</option>
                    </select>
                </label>
                <label className="mobile-setting-row">
                    <span>{isEn ? "Reading mode" : "Режим чтения"}</span>
                    <select
                        value={settings.epubReadingMode || "paged"}
                        onChange={(e) => updateSetting("epubReadingMode", e.target.value)}
                    >
                        <option value="paged">{isEn ? "Pages" : "Страницы"}</option>
                        <option value="scroll">{isEn ? "Continuous scroll" : "Непрерывный скролл"}</option>
                    </select>
                </label>
                <label className="mobile-setting-row">
                    <span>{isEn ? "Text direction" : "Направление текста"}</span>
                    <select
                        value={settings.epubTextOrientation || "auto"}
                        onChange={(e) => updateSetting("epubTextOrientation", e.target.value)}
                    >
                        <option value="auto">{isEn ? "Auto" : "Авто"}</option>
                        <option value="horizontal">{isEn ? "Horizontal" : "Горизонтально"}</option>
                        <option value="vertical">{isEn ? "Vertical" : "Вертикально"}</option>
                    </select>
                </label>
                <label className="mobile-setting-row">
                    <span>{isEn ? "Furigana" : "Фуригана"}</span>
                    <select
                        value={settings.epubFuriganaMode || "show"}
                        onChange={(e) => updateSetting("epubFuriganaMode", e.target.value)}
                    >
                        <option value="show">{isEn ? "Show" : "Показать"}</option>
                        <option value="hover">{isEn ? "On tap/hover" : "По нажатию"}</option>
                        <option value="hide">{isEn ? "Hide" : "Скрыть"}</option>
                    </select>
                </label>
                <label className="mobile-setting-row">
                    <span>{isEn ? "Show EPUB images" : "Показывать картинки из EPUB"}</span>
                    <input
                        type="checkbox"
                        checked={settings.epubShowImages ?? true}
                        onChange={(e) => updateSetting("epubShowImages", e.target.checked)}
                    />
                </label>
                <label className="mobile-setting-row">
                    <span>{isEn ? "Blur illustrations" : "Блюр иллюстраций"}</span>
                    <select
                        value={blurMode}
                        onChange={(e) => {
                            const next = e.target.value as "off" | "after-toc" | "all";
                            updateSetting("epubBlurImagesMode", next);
                            updateSetting("epubBlurImages", next !== "off");
                        }}
                    >
                        <option value="off">{isEn ? "Off" : "Выкл"}</option>
                        <option value="after-toc">{isEn ? "After ToC" : "После оглавления"}</option>
                        <option value="all">{isEn ? "All" : "Все"}</option>
                    </select>
                </label>
                <label className="mobile-setting-row">
                    <span>{isEn ? "Volume key paging" : "Листание кнопками громкости"}</span>
                    <input
                        type="checkbox"
                        checked={settings.epubVolumeKeyPaging ?? true}
                        onChange={(e) => updateSetting("epubVolumeKeyPaging", e.target.checked)}
                    />
                </label>
                <label className="mobile-setting-row">
                    <span>{isEn ? "E-Ink mode" : "Режим E-Ink"}</span>
                    <input
                        type="checkbox"
                        checked={settings.epubEinkMode ?? false}
                        onChange={(e) => updateSetting("epubEinkMode", e.target.checked)}
                    />
                </label>
                <label className="mobile-setting-row mobile-setting-range">
                    <span>
                        {isEn ? "Autoscroll speed" : "Скорость автоскролла"} <b>{settings.epubAutoscrollSpeed ?? 38} px/s</b>
                    </span>
                    <input
                        type="range"
                        min="10"
                        max="200"
                        step="2"
                        value={settings.epubAutoscrollSpeed ?? 38}
                        onChange={(e) => updateSetting("epubAutoscrollSpeed", Number(e.target.value))}
                    />
                </label>
                <label className="mobile-setting-row">
                    <span>{isEn ? "Auto-sync via Google Drive" : "Автосинхронизация с Google Drive"}</span>
                    <input
                        type="checkbox"
                        checked={settings.epubAutoSync ?? true}
                        onChange={(e) => updateSetting("epubAutoSync", e.target.checked)}
                    />
                </label>
                <label className="mobile-setting-row">
                    <span>{isEn ? "Upload .epub files to Drive" : "Загружать .epub книги в Drive"}</span>
                    <input
                        type="checkbox"
                        checked={settings.epubSyncUploadFiles ?? true}
                        onChange={(e) => updateSetting("epubSyncUploadFiles", e.target.checked)}
                    />
                </label>
            </div>

            <div className="mobile-settings-section">
                <div className="mobile-section-title">{isEn ? "Manga OCR" : "Распознавание манги (OCR)"}</div>
                <SettingsMangaOcr language={isEn ? "en" : "ru"} isMobile={true} />
            </div>
        </>
    );
}

export function MobilePlayerSettings({
    settings,
    isEn,
    ankiDecks,
    updateSetting,
}: {
    settings: AppSettings;
    isEn: boolean;
    ankiDecks: string[];
    updateSetting: SettingUpdater;
}) {
    const resumeMode = settings.playerAutoPauseResumeMode ?? "manual";

    return (
        <>
            <div className="mobile-settings-section">
                <div className="mobile-section-title">{isEn ? "Mining & Anki" : "Майнинг и Anki"}</div>
                <label className="mobile-setting-row">
                    <span>{isEn ? "Player Anki deck" : "Колода Anki для плеера"}</span>
                    <select
                        value={settings.playerAnkiDeck || ""}
                        onChange={(e) => updateSetting("playerAnkiDeck", e.target.value || undefined)}
                    >
                        <option value="">
                            {isEn
                                ? `Default (${settings.ankiDeck || "not selected"})`
                                : `Как по умолчанию (${settings.ankiDeck || "не выбрано"})`}
                        </option>
                        {ankiDecks.map((deck) => (
                            <option key={deck} value={deck}>
                                {deck}
                            </option>
                        ))}
                    </select>
                </label>
                <label className="mobile-setting-row">
                    <span>{isEn ? "Attachment format" : "Формат клипа"}</span>
                    <select
                        value={settings.playerCardFormat ?? "video"}
                        onChange={(e) => updateSetting("playerCardFormat", e.target.value)}
                    >
                        <option value="video">{isEn ? "Video with audio" : "Видео со звуком"}</option>
                        <option value="audio">{isEn ? "Audio only" : "Только аудио"}</option>
                    </select>
                </label>
                {(settings.playerCardFormat ?? "video") === "video" && (
                    <label className="mobile-setting-row">
                        <span>{isEn ? "Video quality" : "Качество видеоклипа"}</span>
                        <select
                            value={settings.playerVideoQuality ?? "balanced"}
                            onChange={(e) => updateSetting("playerVideoQuality", e.target.value)}
                        >
                            <option value="tiny">{isEn ? "Tiny (480p)" : "Минимальное (480p)"}</option>
                            <option value="compact">{isEn ? "Compact (640p)" : "Компактное (640p)"}</option>
                            <option value="balanced">{isEn ? "Balanced (720p)" : "Оптимальное (720p)"}</option>
                            <option value="high">{isEn ? "High (960p)" : "Высокое (960p)"}</option>
                        </select>
                    </label>
                )}
                <label className="mobile-setting-row">
                    <span>{isEn ? "Attach scene clip to Anki" : "Прикладывать клип к карточке Anki"}</span>
                    <input
                        type="checkbox"
                        checked={settings.playerMiningUseClipForAnki ?? true}
                        onChange={(e) => updateSetting("playerMiningUseClipForAnki", e.target.checked)}
                    />
                </label>
                <label className="mobile-setting-row">
                    <span>{isEn ? "Replay mined segment" : "Повторять отрезок после майнинга"}</span>
                    <input
                        type="checkbox"
                        checked={settings.playerMiningReplayOnMine ?? true}
                        onChange={(e) => updateSetting("playerMiningReplayOnMine", e.target.checked)}
                    />
                </label>
                <label className="mobile-setting-row mobile-setting-range">
                    <span>
                        {isEn ? "Clip pad before" : "Запас до реплики"} <b>{(settings.playerClipPadStart ?? 0.5).toFixed(1)}s</b>
                    </span>
                    <input
                        type="range"
                        min="0"
                        max="5"
                        step="0.1"
                        value={settings.playerClipPadStart ?? 0.5}
                        onChange={(e) => updateSetting("playerClipPadStart", Number(e.target.value))}
                    />
                </label>
                <label className="mobile-setting-row mobile-setting-range">
                    <span>
                        {isEn ? "Clip pad after" : "Запас после реплики"} <b>{(settings.playerClipPadEnd ?? 0.5).toFixed(1)}s</b>
                    </span>
                    <input
                        type="range"
                        min="0"
                        max="5"
                        step="0.1"
                        value={settings.playerClipPadEnd ?? 0.5}
                        onChange={(e) => updateSetting("playerClipPadEnd", Number(e.target.value))}
                    />
                </label>
            </div>

            <div className="mobile-settings-section">
                <div className="mobile-section-title">{isEn ? "Playback & subtitles" : "Воспроизведение и субтитры"}</div>
                <label className="mobile-setting-row mobile-setting-range">
                    <span>
                        {isEn ? "Seek step" : "Шаг перемотки"} <b>{settings.playerRewindSeconds ?? 2}s</b>
                    </span>
                    <input
                        type="range"
                        min="0.5"
                        max="15"
                        step="0.5"
                        value={settings.playerRewindSeconds ?? 2}
                        onChange={(e) => updateSetting("playerRewindSeconds", Number(e.target.value))}
                    />
                </label>
                <label className="mobile-setting-row mobile-setting-range">
                    <span>
                        {isEn ? "Subtitle offset step" : "Шаг сдвига субтитров"} <b>{(settings.playerSubtitleStep ?? 0.1).toFixed(2)}s</b>
                    </span>
                    <input
                        type="range"
                        min="0.05"
                        max="1"
                        step="0.05"
                        value={settings.playerSubtitleStep ?? 0.1}
                        onChange={(e) => updateSetting("playerSubtitleStep", Number(e.target.value))}
                    />
                </label>
                <label className="mobile-setting-row">
                    <span>{isEn ? "Subtitle visibility" : "Видимость субтитров"}</span>
                    <select
                        value={settings.playerSubsVisibility ?? "always"}
                        onChange={(e) => updateSetting("playerSubsVisibility", e.target.value)}
                    >
                        <option value="always">{isEn ? "Always visible" : "Всегда"}</option>
                        <option value="paused">{isEn ? "Only when paused" : "Только на паузе"}</option>
                        <option value="repeat">{isEn ? "On pause or replay" : "На паузе или повторе"}</option>
                    </select>
                </label>
                <label className="mobile-setting-row">
                    <span>{isEn ? "Blur translation" : "Размывать перевод"}</span>
                    <input
                        type="checkbox"
                        checked={settings.playerBlurTranslation ?? false}
                        onChange={(e) => updateSetting("playerBlurTranslation", e.target.checked)}
                    />
                </label>
                <label className="mobile-setting-row">
                    <span>{isEn ? "Auto-pause resume" : "После автопаузы"}</span>
                    <select
                        value={resumeMode}
                        onChange={(e) => updateSetting("playerAutoPauseResumeMode", e.target.value)}
                    >
                        <option value="manual">{isEn ? "Manual" : "Вручную"}</option>
                        <option value="fixed">{isEn ? "Fixed delay" : "Фикс. задержка"}</option>
                        <option value="dynamic">{isEn ? "By subtitle length" : "По длине реплики"}</option>
                    </select>
                </label>
                {resumeMode === "fixed" && (
                    <label className="mobile-setting-row mobile-setting-range">
                        <span>
                            {isEn ? "Auto-resume delay" : "Задержка продолжения"} <b>{(settings.playerAutoPauseFixedSec ?? 2.5).toFixed(2)}s</b>
                        </span>
                        <input
                            type="range"
                            min="0.5"
                            max="15"
                            step="0.25"
                            value={settings.playerAutoPauseFixedSec ?? 2.5}
                            onChange={(e) => updateSetting("playerAutoPauseFixedSec", Number(e.target.value))}
                        />
                    </label>
                )}
                {resumeMode === "dynamic" && (
                    <label className="mobile-setting-row mobile-setting-range">
                        <span>
                            {isEn ? "ms per character" : "мс на символ"} <b>{settings.playerAutoPauseCharMs ?? 160}ms</b>
                        </span>
                        <input
                            type="range"
                            min="50"
                            max="500"
                            step="10"
                            value={settings.playerAutoPauseCharMs ?? 160}
                            onChange={(e) => updateSetting("playerAutoPauseCharMs", Number(e.target.value))}
                        />
                    </label>
                )}
                <label className="mobile-setting-row mobile-setting-range">
                    <span>
                        {isEn ? "Min gap to skip" : "Мин. пауза для пропуска"} <b>{(settings.playerSkipMinGap ?? 1.5).toFixed(1)}s</b>
                    </span>
                    <input
                        type="range"
                        min="0.3"
                        max="15"
                        step="0.1"
                        value={settings.playerSkipMinGap ?? 1.5}
                        onChange={(e) => updateSetting("playerSkipMinGap", Number(e.target.value))}
                    />
                </label>
                <label className="mobile-setting-row mobile-setting-range">
                    <span>
                        {isEn ? "Subtitle font" : "Шрифт субтитров"} <b>{settings.playerSubFontSize ?? 26}px</b>
                    </span>
                    <input
                        type="range"
                        min="16"
                        max="44"
                        step="1"
                        value={settings.playerSubFontSize ?? 26}
                        onChange={(e) => updateSetting("playerSubFontSize", Number(e.target.value))}
                    />
                </label>
                <label className="mobile-setting-row mobile-setting-range">
                    <span>
                        {isEn ? "Bottom offset" : "Отступ снизу"} <b>{settings.playerSubBottomOffset ?? 22}px</b>
                    </span>
                    <input
                        type="range"
                        min="0"
                        max="160"
                        step="2"
                        value={settings.playerSubBottomOffset ?? 22}
                        onChange={(e) => updateSetting("playerSubBottomOffset", Number(e.target.value))}
                    />
                </label>
                <label className="mobile-setting-row mobile-setting-range">
                    <span>
                        {isEn ? "Backdrop opacity" : "Фон субтитров"} <b>{settings.playerSubBgOpacity ?? 76}%</b>
                    </span>
                    <input
                        type="range"
                        min="0"
                        max="100"
                        step="2"
                        value={settings.playerSubBgOpacity ?? 76}
                        onChange={(e) => updateSetting("playerSubBgOpacity", Number(e.target.value))}
                    />
                </label>
                <label className="mobile-setting-row">
                    <span>{isEn ? "Regex filter" : "Regex-фильтр"}</span>
                    <input
                        type="text"
                        placeholder="\[[^\]]*\]"
                        value={settings.playerSubtitleRegexFilter ?? ""}
                        onChange={(e) => updateSetting("playerSubtitleRegexFilter", e.target.value)}
                    />
                </label>
            </div>
        </>
    );
}

export function MobileUpdatesSettings({
    settings,
    isEn,
    updateSetting,
    onCheckForUpdates,
    updateChecking = false,
}: {
    settings: AppSettings;
    isEn: boolean;
    updateSetting: SettingUpdater;
    onCheckForUpdates?: (manual?: boolean) => Promise<void>;
    updateChecking?: boolean;
}) {
    return (
        <div className="mobile-settings-section">
            <div className="mobile-section-title">{isEn ? "App version & updates" : "Версия и обновления"}</div>
            <div className="mobile-setting-row">
                <span>{isEn ? "Current version" : "Текущая версия"}</span>
                <b>{appVersionLabel()}</b>
            </div>
            <label className="mobile-setting-row">
                <span>{isEn ? "Check for updates on startup" : "Проверять обновления при запуске"}</span>
                <input
                    type="checkbox"
                    checked={settings.updateAutoCheck ?? true}
                    onChange={(e) => updateSetting("updateAutoCheck", e.target.checked)}
                />
            </label>
            <button
                type="button"
                className="mobile-action primary"
                disabled={updateChecking || !onCheckForUpdates}
                onClick={() => void onCheckForUpdates?.(true)}
            >
                {updateChecking
                    ? isEn
                        ? "Checking…"
                        : "Проверяю…"
                    : isEn
                      ? "Check for updates"
                      : "Проверить обновления"}
            </button>
        </div>
    );
}
