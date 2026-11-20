import { useMemo } from "react";
import type { AppSettings } from "../SettingsModal";
import type { Tab } from "../../utils/constants";
import { buildDiscordActivity } from "../../utils/appRuntime";
import "./SettingsDiscord.css";

interface SettingsDiscordProps {
    settings: AppSettings;
    tabs: Tab[];
    updateSetting: <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => void;
}

type DiscordToggle =
    | "discordShowTab"
    | "discordShowStats"
    | "discordShowSpeed"
    | "discordShowTimer"
    | "discordTitleInMemberList"
    | "discordShowButtons";

const activityVerb = {
    ru: { playing: "Играет в", watching: "Смотрит", listening: "Слушает", competing: "Соревнуется в" },
    en: { playing: "Playing", watching: "Watching", listening: "Listening to", competing: "Competing in" },
};

const formatClock = (seconds: number) => {
    const total = Math.max(0, Math.floor(seconds));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    return `${h > 0 ? `${h}:` : ""}${String(m).padStart(h > 0 ? 2 : 1, "0")}:${String(s).padStart(2, "0")}`;
};

export default function SettingsDiscord({ settings, tabs, updateSetting }: SettingsDiscordProps) {
    const isEn = settings.appLanguage === "en";
    const L = (en: string, ru: string) => (isEn ? en : ru);

    // Preview with the real numbers of the first open tab (or a sample).
    const previewTab = useMemo<Tab>(() => tabs.find((tab) => !tab.archived) || {
        id: 0, name: L("Example novel", "Пример новеллы"), lines: [], stats: { chars: 0, words: 0, sentences: 0, time: 0 },
    } as Tab, [tabs, isEn]);
    const previewStats = previewTab.stats?.chars
        ? previewTab
        : { ...previewTab, stats: { chars: 12480, words: 6200, sentences: 640, time: 4860 } };
    const activity = buildDiscordActivity(previewStats, settings, false);
    const readingTime = previewStats.stats?.time || 0;
    const verb = activityVerb[isEn ? "en" : "ru"][activity.activityType];
    const isOn = (key: DiscordToggle) => settings[key] !== false && (key !== "discordShowButtons" || Boolean(settings[key]));

    const option = (key: DiscordToggle, title: string, description: string) => (
        <div className="discord-option" key={key}>
            <span>
                <strong>{title}</strong>
                <small>{description}</small>
            </span>
            <button
                type="button"
                className={`discord-switch${isOn(key) ? " is-on" : ""}`}
                role="switch"
                aria-checked={isOn(key)}
                aria-label={title}
                onClick={() => updateSetting(key, !isOn(key))}
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
                        <p>{L("Shows what you are reading and the numbers from the stats panel. The text itself is never sent.", "Показывает, что ты читаешь, и цифры из панели статистики. Сам текст никуда не отправляется.")}</p>
                    </div>
                    <div className="discord-master-toggle">
                        <button
                            type="button"
                            className={`discord-switch discord-switch-master${settings.discordEnabled ? " is-on" : ""}`}
                            role="switch"
                            aria-checked={settings.discordEnabled ?? false}
                            aria-label="Discord Rich Presence"
                            onClick={() => updateSetting("discordEnabled", !settings.discordEnabled)}
                        >
                            <span />
                        </button>
                        <strong>{settings.discordEnabled ? L("On", "Включено") : L("Off", "Выключено")}</strong>
                    </div>
                </header>

                <div className="discord-option-list">
                    {option("discordShowTab", L("Title", "Название"), L("The tab name, for example the novel you are reading.", "Название вкладки — например, какую новеллу читаешь."))}
                    {option("discordShowStats", L("Characters read", "Прочитано"), L("Characters read in this tab, as in the stats panel.", "Сколько символов прочитано во вкладке — как в панели статистики."))}
                    {option("discordShowSpeed", L("Reading speed", "Скорость чтения"), L("The same speed and units as the stats panel.", "Та же скорость и единицы, что в панели статистики."))}
                    {option("discordShowTimer", L("Reading time", "Время чтения"), L("Discord always shows a timer. On: the tab's reading time (time since pause while paused). Off: time since Setsuna started.", "Discord всегда показывает таймер. Включено — время чтения вкладки (на паузе — сколько длится пауза). Выключено — время с запуска Setsuna."))}
                    {option("discordTitleInMemberList", L("Title in the member list", "Название в списке участников"), L(`Shows “${verb} ${activity.details}” instead of “${verb} Setsuna”.`, `Показывает «${verb} ${activity.details}» вместо «${verb} Setsuna».`))}
                </div>

                <div className="discord-fields">
                    <label>
                        <span>{L("Activity type", "Тип активности")}</span>
                        <select className="modern-select" value={settings.discordTextActivityType || "playing"} onChange={(event) => updateSetting("discordTextActivityType", event.target.value as AppSettings["discordTextActivityType"])}>
                            <option value="playing">{L("Playing", "Играет")}</option>
                            <option value="watching">{L("Watching", "Смотрит")}</option>
                            <option value="listening">{L("Listening", "Слушает")}</option>
                        </select>
                    </label>
                </div>

                <details className="discord-advanced">
                    <summary>{L("More", "Дополнительно")}</summary>
                    <label className="discord-custom-status">
                        <span>{L("Your own line (optional)", "Своя подпись (необязательно)")}</span>
                        <input
                            className="modern-input"
                            value={settings.discordCustomTextStatus || ""}
                            maxLength={80}
                            placeholder={L("Reading a visual novel", "Читает визуальную новеллу")}
                            onChange={(event) => updateSetting("discordCustomTextStatus", event.target.value)}
                        />
                    </label>
                    <div className="discord-option-list compact">
                        {option("discordShowButtons", L("Link buttons", "Кнопки-ссылки"), L("Adds the configured links under the activity.", "Добавляет настроенные ссылки под активностью."))}
                    </div>
                    <label className="discord-client-id">
                        <span>Discord Application ID</span>
                        <input className="modern-input" value={settings.discordClientId || ""} onChange={(event) => updateSetting("discordClientId", event.target.value)} />
                    </label>
                </details>
            </section>

            <aside className="discord-preview-column">
                <div className="discord-preview-title">
                    <span>{L("Preview", "Предпросмотр")}</span>
                    <small>{L("Exactly what Discord receives", "Ровно то, что уходит в Discord")}</small>
                </div>
                <div className={`discord-activity-preview${settings.discordEnabled ? "" : " disabled"}`}>
                    <div className="discord-activity-label">{`${verb} Setsuna`.toUpperCase()}</div>
                    <div className="discord-activity-body">
                        <div className="discord-activity-art">
                            <img src="/setsuna-logo.png" alt="Setsuna" />
                            <span />
                        </div>
                        <div className="discord-activity-copy">
                            <strong>{activity.details}</strong>
                            <span>{activity.state}</span>
                            <span className="discord-elapsed">
                                {isOn("discordShowTimer")
                                    ? `${formatClock(readingTime)} ${L("elapsed", "прошло")}`
                                    : L("time since Setsuna started", "время с запуска Setsuna")}
                            </span>
                        </div>
                    </div>
                    {settings.discordShowButtons && (
                        <div className="discord-preview-buttons">
                            <button type="button">{settings.discordButtonLabel || "Setsuna"}</button>
                            {settings.discordSecondButtonLabel && <button type="button">{settings.discordSecondButtonLabel}</button>}
                        </div>
                    )}
                    {!settings.discordEnabled && <div className="discord-preview-off">{L("Rich Presence is off", "Rich Presence выключен")}</div>}
                </div>
                <div className="discord-member-preview">
                    <span className="discord-member-avatar" />
                    <span>
                        <strong>{L("You", "Ты")}</strong>
                        <small>{verb} <b>{isOn("discordTitleInMemberList") ? activity.details : "Setsuna"}</b></small>
                    </span>
                </div>
                <p className="discord-tray-note">{L("Updates about every 15 seconds. Hidden while Setsuna is in the tray.", "Обновляется примерно раз в 15 секунд. Скрывается, когда Setsuna в трее.")}</p>
            </aside>
        </div>
    );
}
