import type { ReactNode } from "react";
import { IconBookTab, IconPlayerTab, IconSettings, IconTextTab, IconWifi } from "./Icons";
import { ANIME_PLAYER_AVAILABLE, EPUB_READER_AVAILABLE } from "../utils/featureFlags";
import "./HomeScreen.css";

type HomeScreenProps = {
    language: "ru" | "en";
    onTextHooker: () => void;
    onEpub: () => void;
    onPlayer: () => void;
    onAnki: () => void;
    onSettings: () => void;
    wsConnected: boolean;
};

type ModeItem = {
    id: "text" | "epub" | "player";
    title: string;
    category: string;
    status: string;
    action: () => void;
    icon: ReactNode;
    disabled?: boolean;
};

export default function HomeScreen({ language, onTextHooker, onEpub, onPlayer, onAnki, onSettings, wsConnected }: HomeScreenProps) {
    const isEn = language === "en";
    const items: ModeItem[] = [
        {
            id: "text",
            title: "TextHooker",
            category: isEn ? "Visual novels and live text" : "Визуальные новеллы и живой текст",
            status: wsConnected ? (isEn ? "Hook connected" : "Хук подключён") : (isEn ? "Ready" : "Готов"),
            action: onTextHooker,
            icon: <IconTextTab />,
        },
        {
            id: "epub",
            title: isEn ? "EPUB Reader" : "EPUB-ридер",
            category: isEn ? "Books and light novels" : "Книги и ранобэ",
            status: EPUB_READER_AVAILABLE
                ? (isEn ? "Workspace" : "Рабочее пространство")
                : (isEn ? "Coming soon" : "Скоро"),
            action: onEpub,
            icon: <IconBookTab />,
            disabled: !EPUB_READER_AVAILABLE,
        },
        {
            id: "player",
            title: isEn ? "Anime Player" : "Аниме-плеер",
            category: isEn ? "Video and subtitles" : "Видео и субтитры",
            status: ANIME_PLAYER_AVAILABLE
                ? (isEn ? "Workspace" : "Рабочее пространство")
                : (isEn ? "Coming soon" : "Скоро"),
            action: onPlayer,
            icon: <IconPlayerTab />,
            disabled: !ANIME_PLAYER_AVAILABLE,
        },
    ];

    return (
        <section className="home-menu" aria-labelledby="home-menu-title">
            <div className="home-menu-inner">
                <header className="home-menu-header">
                    <div>
                        <div className="home-menu-brand">Setsuna</div>
                        <h1 id="home-menu-title">{isEn ? "Choose a mode" : "Выберите режим"}</h1>
                    </div>
                    <div className="home-menu-actions">
                        <button type="button" className="home-menu-anki" onClick={onAnki}>Anki</button>
                        <button
                            type="button"
                            className="home-menu-settings"
                            onClick={onSettings}
                            title={isEn ? "Settings" : "Настройки"}
                            aria-label={isEn ? "Open settings" : "Открыть настройки"}
                        >
                            <IconSettings />
                        </button>
                    </div>
                </header>

                <div className="home-mode-grid">
                    {items.map((item, index) => (
                        <button
                            key={item.id}
                            type="button"
                            className={`home-mode home-mode-${item.id}`}
                            onClick={item.action}
                            disabled={item.disabled}
                            title={item.disabled ? (isEn ? "Coming soon" : "Скоро") : item.title}
                        >
                            <span className="home-mode-topline">
                                <span className="home-mode-number">0{index + 1}</span>
                                <span className={`home-mode-status ${item.disabled ? "home-mode-status-soon" : ""}`}>
                                    {item.id === "text" && wsConnected ? <IconWifi connected /> : null}
                                    {item.status}
                                </span>
                            </span>
                            <span className="home-mode-icon" aria-hidden="true">{item.icon}</span>
                            <span className="home-mode-copy">
                                <strong>{item.title}</strong>
                                <span>{item.category}</span>
                            </span>
                            <span className="home-mode-open" aria-hidden="true">→</span>
                        </button>
                    ))}
                </div>

                <footer className="home-menu-footer">
                    <span>{isEn ? "One library. Three ways to read." : "Одна библиотека. Три режима чтения."}</span>
                    <span className="home-menu-version">Setsuna 0.5</span>
                </footer>
            </div>
        </section>
    );
}
