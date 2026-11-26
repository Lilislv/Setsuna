import { appVersionLabel } from "../utils/appVersion";
import { useEffect, useState, type ReactNode } from "react";
import { IconBookTab, IconPlayerTab, IconSettings, IconTextTab, IconWifi } from "./Icons";
import { ANIME_PLAYER_AVAILABLE, EPUB_READER_AVAILABLE, YATSU_READER_AVAILABLE } from "../utils/featureFlags";
import ModeIntro from "../features/onboarding/ModeIntro";
import type { OnboardingMode } from "../features/onboarding/onboardingStore";
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
    isBeta?: boolean;
};

export default function HomeScreen({ language, onTextHooker, onEpub, onPlayer, onAnki, onSettings, wsConnected }: HomeScreenProps) {
    useEffect(() => {
        const state = window.history.state as Record<string, unknown> | null;
        if (state?.setsunaMobileWorkspace) {
            window.history.back();
        }
    }, []);
    const isEn = language === "en";
    const [helpMode, setHelpMode] = useState<OnboardingMode | null>(null);
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
            title: isEn ? "Reader" : "Читалка",
            category: YATSU_READER_AVAILABLE
                ? (isEn ? "Yatsu Reader · Setsuna dictionaries" : "Yatsu Reader · словари Setsuna")
                : (isEn ? "Books, manga & light novels" : "Книги, манга и ранобэ"),
            status: YATSU_READER_AVAILABLE
                ? (isEn ? "Preview" : "Первая версия")
                : EPUB_READER_AVAILABLE
                    ? (isEn ? "Beta" : "Бета")
                    : (isEn ? "Coming soon" : "Скоро"),
            action: onEpub,
            icon: <IconBookTab />,
            disabled: !EPUB_READER_AVAILABLE,
            isBeta: !YATSU_READER_AVAILABLE && EPUB_READER_AVAILABLE,
        },
        {
            id: "player",
            title: isEn ? "Video Player" : "Видео-плеер",
            category: isEn ? "Video and subtitles" : "Видео и субтитры",
            status: ANIME_PLAYER_AVAILABLE
                ? (isEn ? "Beta" : "Бета")
                : (isEn ? "Coming soon" : "Скоро"),
            action: onPlayer,
            icon: <IconPlayerTab />,
            disabled: !ANIME_PLAYER_AVAILABLE,
            isBeta: ANIME_PLAYER_AVAILABLE,
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
                        <div key={item.id} className="home-mode-slot">
                        <button
                            type="button"
                            className={`home-mode home-mode-${item.id}`}
                            style={{ ['--i' as any]: index }}
                            onClick={item.action}
                            disabled={item.disabled}
                            title={item.disabled ? (isEn ? "Coming soon" : "Скоро") : item.title}
                        >
                            <span className="home-mode-topline">
                                <span className="home-mode-number">0{index + 1}</span>
                                <span className={`home-mode-status${item.disabled ? " home-mode-status-soon" : item.isBeta ? " home-mode-status-beta" : ""}`}>
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
                        <button
                            type="button"
                            className="home-mode-help"
                            onClick={() => setHelpMode(item.id === "text" ? "texthooker" : item.id)}
                            title={isEn ? `What is ${item.title}?` : `Что такое «${item.title}»?`}
                            aria-label={isEn ? `What is ${item.title}?` : `Что такое «${item.title}»?`}
                        >
                            ?
                        </button>
                        </div>
                    ))}
                </div>

                {helpMode && <ModeIntro mode={helpMode} language={language} onClose={() => setHelpMode(null)} />}

                <footer className="home-menu-footer">
                    <span>{isEn ? "One library. Three ways to read." : "Одна библиотека. Три режима чтения."}</span>
                    <span className="home-menu-version">Setsuna {appVersionLabel()}{import.meta.env.VITE_PRIVATE_READER === '1' ? (isEn ? ' · Local' : ' · Локальная') : ''}</span>
                </footer>
            </div>
        </section>
    );
}
