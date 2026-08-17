import { useMemo } from "react";
import type { AppSettings } from "../SettingsModal";
import type { Tab } from "../../utils/constants";
import { formatDiscordMode, formatDiscordStats } from "../../utils/appRuntime";
import "./SettingsDiscord.css";

interface SettingsDiscordProps {
    settings: AppSettings;
    tabs: Tab[];
    updateSetting: <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => void;
}

type DiscordBooleanSetting =
    | "discordShowTab"
    | "discordShowTimer"
    | "discordShowStats"
    | "discordShowPaused"
    | "discordShowProgress"
    | "discordShowButtons";

const activityLabels = {
    ru: { playing: "Играет", watching: "Смотрит", listening: "Слушает", competing: "Соревнуется" },
    en: { playing: "Playing", watching: "Watching", listening: "Listening", competing: "Competing" },
};

export default function SettingsDiscord({ settings, tabs, updateSetting }: SettingsDiscordProps) {
    const isEn = settings.appLanguage === "en";
    const previewTab = useMemo(() => tabs.find((tab) => !tab.archived), [tabs]);
    const previewMode = formatDiscordMode(previewTab?.mode || "text", settings);
    const tabName = previewTab?.name || (isEn ? "Example tab" : "Пример вкладки");
    const stats = previewTab ? formatDiscordStats(previewTab, settings) : (isEn ? "12,450 chars / 138 words" : "12 450 симв. / 138 слов");
    const activityType = settings.discordTextActivityType || "playing";
    const activityLabel = activityLabels[isEn ? "en" : "ru"][activityType];

    const option = (key: DiscordBooleanSetting, title: string, description: string) => (
        <div className="discord-option" key={key}>
            <span>
                <strong>{title}</strong>
                <small>{description}</small>
            </span>
            <button
                type="button"
                className={`discord-switch${settings[key] ? " is-on" : ""}`}
                role="switch"
                aria-checked={Boolean(settings[key])}
                aria-label={title}
                onClick={() => updateSetting(key, !settings[key])}
            >
                <span />
            </button>
        </div>
    );

    return (
        <div className="discord-settings">
            <section className="discord-settings-main">
                <header className="discord-settings-header">
                    <div>
                        <span className="discord-eyebrow">Discord</span>
                        <h2>Rich Presence</h2>
                        <p>{isEn ? "Show what you are reading without exposing the text itself." : "Показывает процесс чтения, не раскрывая сам текст."}</p>
                    </div>
                    <div className="discord-master-toggle">
                        <button
                            type="button"
                            className={`discord-switch discord-switch-master${settings.discordEnabled ? " is-on" : ""}`}
                            role="switch"
                            aria-checked={settings.discordEnabled ?? false}
                            aria-label={isEn ? "Discord Rich Presence" : "Активность Discord"}
                            onClick={() => updateSetting("discordEnabled", !settings.discordEnabled)}
                        >
                            <span />
                        </button>
                        <strong>{settings.discordEnabled ? (isEn ? "Enabled" : "Включено") : (isEn ? "Disabled" : "Выключено")}</strong>
                    </div>
                </header>

                <div className="discord-option-list">
                    {option("discordShowTab", isEn ? "Tab name" : "Название вкладки", isEn ? "Adds the current title to activity details." : "Добавляет название текущего окна в активность.")}
                    {option("discordShowTimer", isEn ? "Session timer" : "Таймер сессии", isEn ? "Shows how long Setsuna has been active." : "Показывает длительность текущей сессии.")}
                    {option("discordShowStats", isEn ? "Reading statistics" : "Статистика чтения", isEn ? "Characters, words and reading progress." : "Символы, слова и прогресс чтения.")}
                </div>

                <div className="discord-fields">
                    <label>
                        <span>{isEn ? "Activity type" : "Тип активности"}</span>
                        <select className="modern-select" value={activityType} onChange={(event) => updateSetting("discordTextActivityType", event.target.value as AppSettings["discordTextActivityType"])}>
                            <option value="playing">{isEn ? "Playing" : "Играет"}</option>
                            <option value="watching">{isEn ? "Watching" : "Смотрит"}</option>
                            <option value="listening">{isEn ? "Listening" : "Слушает"}</option>
                            <option value="competing">{isEn ? "Competing" : "Соревнуется"}</option>
                        </select>
                    </label>
                    <label>
                        <span>{isEn ? "TextHooker status" : "Статус TextHooker"}</span>
                        <select className="modern-select" value={settings.discordTextStatus || "reading"} onChange={(event) => updateSetting("discordTextStatus", event.target.value as AppSettings["discordTextStatus"])}>
                            <option value="reading">{isEn ? "Reading hooked text" : "Читает через хукер"}</option>
                            <option value="playing">{isEn ? "Playing a visual novel" : "Играет в визуальную новеллу"}</option>
                            <option value="watching">{isEn ? "Watching a visual novel" : "Смотрит визуальную новеллу"}</option>
                            <option value="mining">{isEn ? "Mining Japanese lines" : "Майнит японские строки"}</option>
                            <option value="custom">{isEn ? "Custom" : "Свой текст"}</option>
                        </select>
                    </label>
                </div>

                {settings.discordTextStatus === "custom" && (
                    <label className="discord-custom-status">
                        <span>{isEn ? "Custom status" : "Свой статус"}</span>
                        <input className="modern-input" value={settings.discordCustomTextStatus || ""} maxLength={120} onChange={(event) => updateSetting("discordCustomTextStatus", event.target.value)} />
                    </label>
                )}

                <details className="discord-advanced">
                    <summary>{isEn ? "Advanced settings" : "Дополнительные настройки"}</summary>
                    <div className="discord-option-list compact">
                        {option("discordShowPaused", isEn ? "Paused state" : "Состояние паузы", isEn ? "Marks the session as paused." : "Отмечает приостановленную сессию.")}
                        {option("discordShowProgress", isEn ? "Book progress" : "Прогресс книги", isEn ? "Shows EPUB completion percentage." : "Показывает процент прочитанного EPUB.")}
                        {option("discordShowButtons", isEn ? "Profile buttons" : "Кнопки активности", isEn ? "Displays configured links in the activity." : "Показывает настроенные ссылки в активности.")}
                    </div>
                    <label className="discord-client-id">
                        <span>Discord Application ID</span>
                        <input className="modern-input" value={settings.discordClientId || ""} onChange={(event) => updateSetting("discordClientId", event.target.value)} />
                    </label>
                </details>
            </section>

            <aside className="discord-preview-column">
                <div className="discord-preview-title">
                    <span>{isEn ? "Live preview" : "Предпросмотр"}</span>
                    <small>{isEn ? "Approximate Discord appearance" : "Примерный вид в Discord"}</small>
                </div>
                <div className={`discord-activity-preview${settings.discordEnabled ? "" : " disabled"}`}>
                    <div className="discord-activity-label">
                        {isEn ? `${activityLabel.toUpperCase()} SETSUNA` : `${activityLabel.toUpperCase()} В SETSUNA`}
                    </div>
                    <div className="discord-activity-body">
                        <div className="discord-activity-art">
                            <img src="/setsuna-logo.png" alt="Setsuna" />
                            <span />
                        </div>
                        <div className="discord-activity-copy">
                            <strong>Setsuna</strong>
                            <span>{previewMode}{settings.discordShowTab ? `: ${tabName}` : ""}</span>
                            {settings.discordShowStats && <span>{stats}</span>}
                            {settings.discordShowTimer && <span className="discord-elapsed">01:24:36 {isEn ? "elapsed" : "прошло"}</span>}
                        </div>
                    </div>
                    {settings.discordShowButtons && (
                        <div className="discord-preview-buttons">
                            <button type="button">{settings.discordButtonLabel || "Setsuna"}</button>
                            {settings.discordSecondButtonLabel && <button type="button">{settings.discordSecondButtonLabel}</button>}
                        </div>
                    )}
                    {!settings.discordEnabled && <div className="discord-preview-off">{isEn ? "Rich Presence is disabled" : "Rich Presence выключен"}</div>}
                </div>
                <p className="discord-tray-note">{isEn ? "Activity automatically disappears while Setsuna is in the tray." : "Когда Setsuna уходит в трей, активность автоматически скрывается."}</p>
            </aside>
        </div>
    );
}
