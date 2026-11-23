import type { EpubParagraph } from "./epubModel";

export interface EpubReadingGoals {
    enabled: boolean;
    dailyChars: number;
    dailyMinutes: number;
    targetCharsPerHour: number;
    skipThresholdChars: number;
    idlePauseSeconds: number;
}

export const DEFAULT_EPUB_GOALS: EpubReadingGoals = {
    enabled: true,
    dailyChars: 5000,
    dailyMinutes: 30,
    targetCharsPerHour: 10000,
    skipThresholdChars: 2700,
    idlePauseSeconds: 60,
};

const GOALS_STORAGE_KEY = "setsuna-epub-goals";

export function loadEpubGoals(): EpubReadingGoals {
    try {
        const raw = localStorage.getItem(GOALS_STORAGE_KEY);
        if (!raw) return { ...DEFAULT_EPUB_GOALS };
        const parsed = JSON.parse(raw);
        return {
            ...DEFAULT_EPUB_GOALS,
            ...(parsed && typeof parsed === "object" ? parsed : {}),
        };
    } catch {
        return { ...DEFAULT_EPUB_GOALS };
    }
}

export function saveEpubGoals(goals: EpubReadingGoals): void {
    try {
        localStorage.setItem(GOALS_STORAGE_KEY, JSON.stringify(goals));
    } catch {
        // Ignore storage errors
    }
}

export function countNonWhitespaceChars(text: string): number {
    let count = 0;
    for (const ch of text) {
        if (!/\s/.test(ch)) count += 1;
    }
    return count;
}

/**
 * Computes character delta when advancing from `fromParagraphIndex` to `toParagraphIndex`
 * within the same chapter. Returns `null` if the jump exceeds `skipThresholdChars`
 * (e.g. ToC jump or scrub) so reading speed and character totals are never inflated.
 */
export function computeChapterParagraphDelta(
    paragraphs: readonly Pick<EpubParagraph, "index" | "text">[],
    fromParagraphIndex: number,
    toParagraphIndex: number,
    skipThresholdChars = DEFAULT_EPUB_GOALS.skipThresholdChars,
): number | null {
    if (toParagraphIndex <= fromParagraphIndex) return 0;
    let total = 0;
    for (const p of paragraphs) {
        if (p.index > fromParagraphIndex && p.index <= toParagraphIndex) {
            total += countNonWhitespaceChars(p.text);
            if (total > skipThresholdChars) {
                return null;
            }
        }
    }
    return total;
}

export type GoalLightStatus = "off" | "behind" | "mid" | "done";

export interface GoalProgressSummary {
    status: GoalLightStatus;
    charsPct: number;
    timePct: number;
    overallPct: number;
    charsPerHour: number;
}

export function evaluateGoalProgress(
    todayChars: number,
    todaySeconds: number,
    goals: EpubReadingGoals,
    paused: boolean,
): GoalProgressSummary {
    const charsPct = goals.dailyChars > 0 ? Math.min(1, todayChars / goals.dailyChars) : 0;
    const timePct = goals.dailyMinutes > 0 ? Math.min(1, todaySeconds / (goals.dailyMinutes * 60)) : 0;
    const overallPct = Math.max(charsPct, timePct);
    const charsPerHour = todaySeconds >= 10 ? Math.round((todayChars * 3600) / todaySeconds) : 0;

    if (!goals.enabled || paused) {
        return { status: "off", charsPct, timePct, overallPct, charsPerHour };
    }
    if (overallPct >= 1) {
        return { status: "done", charsPct, timePct, overallPct, charsPerHour };
    }
    if (overallPct >= 0.45) {
        return { status: "mid", charsPct, timePct, overallPct, charsPerHour };
    }
    return { status: "behind", charsPct, timePct, overallPct, charsPerHour };
}

export function computeReadingStreak(
    days: readonly { key: string; chars: number; seconds: number }[],
    minChars = 50,
    minSeconds = 60,
): { current: number; best: number } {
    let best = 0;
    let run = 0;
    const activeFlags = days.map((d) => d.chars >= minChars || d.seconds >= minSeconds);

    for (const active of activeFlags) {
        if (active) {
            run += 1;
            if (run > best) best = run;
        } else {
            run = 0;
        }
    }

    // Current streak counts backwards from today (or yesterday if today hasn't started yet)
    let current = 0;
    let idx = activeFlags.length - 1;
    if (idx >= 0 && !activeFlags[idx]) {
        idx -= 1;
    }
    while (idx >= 0 && activeFlags[idx]) {
        current += 1;
        idx -= 1;
    }

    return { current, best };
}
