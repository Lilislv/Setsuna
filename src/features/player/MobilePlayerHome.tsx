import { useMemo } from "react";
import { IconHome, IconSettings } from "../../components/Icons";
import { readProgress } from "./libraryModel";
import { episodeLabel } from "./localMedia";
import { formatClock } from "./model";
import { recentMobileMedia } from "./mobileMedia";
import { cleanReleaseTitle } from "./posterModel";

// Phone home of the video player: same look as the desktop library, built around the
// system file picker (Android gives no folder paths to scan).
export function MobilePlayerHome({
    en,
    current,
    error,
    deckName,
    onOpenFiles,
    onResume,
    onOpenUrl,
    onDeck,
    onSettings,
    onHome,
}: {
    en: boolean;
    current?: { title: string; episode: string };
    error?: string;
    deckName?: string;
    onOpenFiles: () => void;
    onResume?: () => void;
    onOpenUrl: () => void;
    onDeck?: () => void;
    onSettings?: () => void;
    onHome?: () => void;
}) {
    const t = (english: string, russian: string) => (en ? english : russian);
    const recent = useMemo(() => recentMobileMedia(readProgress()), []);
    return (
        <main className="spm-home">
            <header className="spm-top">
                {onHome && (
                    <button type="button" className="spm-icon" onClick={onHome} aria-label={t("Home screen", "Главный экран")}>
                        <IconHome />
                    </button>
                )}
                <div className="spm-title">
                    <h1>{t("Video Player", "Видео-плеер")}</h1>
                    <span className="sp-beta-pill">{t("Beta", "Бета")}</span>
                </div>
                {onSettings && (
                    <button type="button" className="spm-icon" onClick={onSettings} aria-label={t("Player settings", "Настройки плеера")}>
                        <IconSettings />
                    </button>
                )}
            </header>

            {current && onResume && (
                <button type="button" className="spm-resume" onClick={onResume}>
                    <span className="spm-resume-play" aria-hidden="true">
                        <svg viewBox="0 0 20 20" width="20" height="20" fill="currentColor">
                            <path d="M6 4.2a.9.9 0 0 1 1.37-.77l8.6 5.3a.9.9 0 0 1 0 1.54l-8.6 5.3A.9.9 0 0 1 6 14.8V4.2Z" />
                        </svg>
                    </span>
                    <span className="spm-resume-text">
                        <small>{t("Continue watching", "Продолжить просмотр")}</small>
                        <strong>{current.title}</strong>
                        <span>{current.episode}</span>
                    </span>
                </button>
            )}

            <section className="spm-open">
                <button type="button" className="spm-open-main" onClick={onOpenFiles}>
                    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <rect x="3" y="5" width="18" height="14" rx="3" />
                        <path d="m10 9.5 4.5 2.5-4.5 2.5z" fill="currentColor" stroke="none" />
                    </svg>
                    {t("Open video", "Открыть видео")}
                </button>
                <p>
                    {t(
                        "Pick episodes together with their subtitle files — subtitles are matched by name automatically.",
                        "Выбери серии вместе с файлами субтитров — субтитры подберутся по имени автоматически.",
                    )}
                </p>
                <div className="spm-chips">
                    <button type="button" onClick={onOpenUrl}>{t("Open URL", "По ссылке")}</button>
                    {onDeck && (
                        <button type="button" onClick={onDeck}>
                            {t("Deck", "Колода")}: <b>{deckName || "Anki"}</b>
                        </button>
                    )}
                </div>
                {error && <p className="spm-error" role="alert">{error}</p>}
            </section>

            {recent.length > 0 && (
                <section className="spm-recent">
                    <div className="spm-section-head">
                        <h2>{t("Recently watched", "Недавно смотрели")}</h2>
                        <small>{t("Pick the file again to resume", "Выбери файл снова — продолжится с места")}</small>
                    </div>
                    {recent.map((item) => {
                        const title = cleanReleaseTitle(item.name, true).title || item.name;
                        const pct = item.duration > 0 ? Math.min(100, (item.time / item.duration) * 100) : 0;
                        return (
                            <button key={item.key} type="button" className="spm-recent-item" onClick={onOpenFiles}>
                                <span className="spm-recent-name">
                                    <strong>{title}</strong>
                                    <small>{episodeLabel(item.name, 0, en)}</small>
                                </span>
                                <span className="spm-recent-meta">
                                    {item.completed
                                        ? t("Watched", "Просмотрено")
                                        : item.duration > 0
                                          ? `${formatClock(item.time)} / ${formatClock(item.duration)}`
                                          : formatClock(item.time)}
                                </span>
                                <span className="spm-progress" aria-hidden="true">
                                    <span style={{ width: `${item.completed ? 100 : pct}%` }} />
                                </span>
                            </button>
                        );
                    })}
                </section>
            )}
        </main>
    );
}
