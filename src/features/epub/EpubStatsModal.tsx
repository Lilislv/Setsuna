import { useEffect, useMemo, useState } from "react";
import { IconClose } from "../../components/Icons";
import type { Tab } from "../../utils/constants";
import { getDay, getRecentDays, useDailyStatsVersion } from "../../utils/dailyStats";
import { getTranslator, type AppLanguage } from "../../utils/i18n";
import {
    computeReadingStreak,
    evaluateGoalProgress,
    loadEpubGoals,
    saveEpubGoals,
    type EpubReadingGoals,
} from "./epubTracker";

interface EpubStatsModalProps {
    open: boolean;
    books: Tab[];
    language: AppLanguage;
    isMobile: boolean;
    onClose: () => void;
    onGoalsChange?: (goals: EpubReadingGoals) => void;
}

function formatDuration(seconds: number, isEn: boolean): string {
    const mins = Math.floor(seconds / 60);
    const hrs = Math.floor(mins / 60);
    const remMins = mins % 60;
    if (hrs > 0) {
        return isEn ? `${hrs}h ${remMins}m` : `${hrs}ч ${remMins}м`;
    }
    return isEn ? `${mins}m` : `${mins}м`;
}

export default function EpubStatsModal({
    open,
    books,
    language,
    isMobile,
    onClose,
    onGoalsChange,
}: EpubStatsModalProps) {
    const t = getTranslator(language);
    const isEn = language === "en";
    const statsVersion = useDailyStatsVersion();
    const [goals, setGoals] = useState<EpubReadingGoals>(() => loadEpubGoals());

    useEffect(() => {
        if (!open) return;
        setGoals(loadEpubGoals());
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                onClose();
            }
        };
        window.addEventListener("keydown", onKeyDown, true);
        return () => window.removeEventListener("keydown", onKeyDown, true);
    }, [open, onClose]);

    const updateGoals = (patch: Partial<EpubReadingGoals>) => {
        setGoals((prev) => {
            const next = { ...prev, ...patch };
            saveEpubGoals(next);
            onGoalsChange?.(next);
            return next;
        });
    };

    const heatmapDays = useMemo(() => {
        const count = isMobile ? 56 : 112;
        return getRecentDays(count).map((d) => ({
            key: d.key,
            date: d.date,
            chars: d.record.total.chars,
            seconds: d.record.total.seconds,
        }));
    }, [isMobile, statsVersion, open]);

    const today = useMemo(() => getDay().total, [statsVersion, open]);
    const summary = useMemo(
        () => evaluateGoalProgress(today.chars, today.seconds, goals, false),
        [today.chars, today.seconds, goals],
    );
    const streak = useMemo(() => computeReadingStreak(heatmapDays), [heatmapDays]);

    const maxDayChars = useMemo(() => {
        let max = Math.max(1000, goals.dailyChars);
        for (const d of heatmapDays) {
            if (d.chars > max) max = d.chars;
        }
        return max;
    }, [heatmapDays, goals.dailyChars]);

    const epubBooks = useMemo(
        () => books
            .filter((b) => b.mode === "epub" && !b.archived)
            .sort((a, b) => (b.stats?.chars || 0) - (a.stats?.chars || 0) || (b.epub?.progress || 0) - (a.epub?.progress || 0)),
        [books],
    );

    if (!open) return null;

    const heatLevel = (chars: number, seconds: number) => {
        if (chars <= 0 && seconds < 30) return 0;
        const ratio = chars / maxDayChars;
        if (ratio >= 0.75) return 4;
        if (ratio >= 0.4) return 3;
        if (ratio >= 0.15) return 2;
        return 1;
    };

    return (
        <div className="epub-modal-backdrop" onClick={onClose}>
            <div className="epub-modal-card epub-stats-modal" onClick={(e) => e.stopPropagation()}>
                <div className="epub-modal-head">
                    <strong>{t("epub.statsTitle")}</strong>
                    <button type="button" className="epub-glass-btn epub-glass-circle" aria-label={t("common.close")} onClick={onClose}>
                        <IconClose />
                    </button>
                </div>

                {/* Today's KPI cards */}
                <div className="epub-stats-kpis">
                    <div className="epub-stats-kpi">
                        <span className="epub-stats-kpi-label">{t("epub.todayChars")}</span>
                        <strong className="epub-stats-kpi-val">{today.chars.toLocaleString()}</strong>
                        <div className="epub-stats-bar">
                            <div className="epub-stats-bar-fill" style={{ width: `${Math.round(summary.charsPct * 100)}%` }} />
                        </div>
                        <span className="epub-stats-kpi-sub">
                            {Math.round(summary.charsPct * 100)}% / {goals.dailyChars.toLocaleString()}
                        </span>
                    </div>
                    <div className="epub-stats-kpi">
                        <span className="epub-stats-kpi-label">{t("epub.todayTime")}</span>
                        <strong className="epub-stats-kpi-val">{formatDuration(today.seconds, isEn)}</strong>
                        <div className="epub-stats-bar">
                            <div className="epub-stats-bar-fill is-time" style={{ width: `${Math.round(summary.timePct * 100)}%` }} />
                        </div>
                        <span className="epub-stats-kpi-sub">
                            {Math.round(summary.timePct * 100)}% / {goals.dailyMinutes}{isEn ? "m" : "м"}
                        </span>
                    </div>
                    <div className="epub-stats-kpi">
                        <span className="epub-stats-kpi-label">{t("epub.readingSpeed")}</span>
                        <strong className="epub-stats-kpi-val">
                            {summary.charsPerHour > 0 ? summary.charsPerHour.toLocaleString() : "—"}
                        </strong>
                        <span className="epub-stats-kpi-sub">{isEn ? "chars / hr" : "симв. / ч"}</span>
                    </div>
                    <div className="epub-stats-kpi">
                        <span className="epub-stats-kpi-label">{t("epub.streakCurrent")}</span>
                        <strong className="epub-stats-kpi-val">{streak.current} {t("epub.days")}</strong>
                        <span className="epub-stats-kpi-sub">
                            {t("epub.streakBest")}: {streak.best} {t("epub.days")}
                        </span>
                    </div>
                </div>

                {/* Activity heatmap */}
                <div className="epub-stats-section">
                    <div className="epub-stats-section-head">
                        <span>{t("epub.activityHeatmap")}</span>
                        <span className="epub-stats-legend">
                            <span>{isEn ? "Less" : "Меньше"}</span>
                            {[0, 1, 2, 3, 4].map((lv) => (
                                <span key={lv} className={`epub-heat-cell lv-${lv}`} />
                            ))}
                            <span>{isEn ? "More" : "Больше"}</span>
                        </span>
                    </div>
                    <div className="epub-heatmap-grid">
                        {heatmapDays.map((day) => (
                            <div
                                key={day.key}
                                className={`epub-heat-cell lv-${heatLevel(day.chars, day.seconds)}`}
                                title={`${day.key}: ${day.chars.toLocaleString()} ${t("epub.charsShort")} · ${formatDuration(day.seconds, isEn)}`}
                            />
                        ))}
                    </div>
                </div>

                {/* Daily goals editor */}
                <div className="epub-stats-section">
                    <div className="epub-stats-section-head">
                        <span>{t("epub.goalsHeading")}</span>
                        <label className="epub-goal-enable-toggle">
                            <input
                                type="checkbox"
                                checked={goals.enabled}
                                onChange={(e) => updateGoals({ enabled: e.target.checked })}
                            />
                            <span>{isEn ? "Goal indicator" : "Индикатор цели"}</span>
                        </label>
                    </div>
                    <div className="epub-goals-inputs">
                        <label className="epub-edit-field">
                            <span>{t("epub.goalChars")}</span>
                            <input
                                type="number"
                                min={100}
                                step={500}
                                className="epub-bookmark-input"
                                value={goals.dailyChars}
                                onChange={(e) => updateGoals({ dailyChars: Math.max(100, Number(e.target.value) || 0) })}
                            />
                        </label>
                        <label className="epub-edit-field">
                            <span>{t("epub.goalMinutes")}</span>
                            <input
                                type="number"
                                min={5}
                                step={5}
                                className="epub-bookmark-input"
                                value={goals.dailyMinutes}
                                onChange={(e) => updateGoals({ dailyMinutes: Math.max(5, Number(e.target.value) || 0) })}
                            />
                        </label>
                        <label className="epub-edit-field">
                            <span>{t("epub.goalSkipThreshold")}</span>
                            <input
                                type="number"
                                min={500}
                                step={200}
                                className="epub-bookmark-input"
                                value={goals.skipThresholdChars}
                                onChange={(e) => updateGoals({ skipThresholdChars: Math.max(500, Number(e.target.value) || 2700) })}
                            />
                        </label>
                    </div>
                </div>

                {/* Per-book breakdown */}
                {epubBooks.length > 0 && (
                    <div className="epub-stats-section">
                        <div className="epub-stats-section-head">
                            <span>{t("epub.library")}</span>
                        </div>
                        <div className="epub-stats-books-list">
                            {epubBooks.slice(0, 12).map((book) => {
                                const pct = Math.round(Math.min(1, Math.max(0, book.epub?.progress || 0)) * 100);
                                const readChars = book.stats?.chars || 0;
                                const readTime = book.stats?.time || 0;
                                const speed = readTime >= 30 ? Math.round((readChars * 3600) / readTime) : 0;
                                return (
                                    <div key={book.id} className="epub-stats-book-row">
                                        <span className="epub-stats-book-name" title={book.epub?.title || book.name}>
                                            {book.epub?.title || book.name}
                                        </span>
                                        <span className="epub-stats-book-meta">{pct}%</span>
                                        <span className="epub-stats-book-meta">{readChars.toLocaleString()} {t("epub.charsShort")}</span>
                                        <span className="epub-stats-book-meta">{formatDuration(readTime, isEn)}</span>
                                        <span className="epub-stats-book-meta">{speed > 0 ? `${speed.toLocaleString()}/h` : "—"}</span>
                                    </div>
                                );
                            })}
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}
