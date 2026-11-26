import { useEffect, useRef, useState } from "react";
import Coachmarks, { resolveTarget } from "./Coachmarks";
import type { CoachStep } from "./guides";
import { ONBOARDING_RESET_EVENT, tipSeen } from "./onboardingStore";

// Only one tour on screen at a time: a menu opened over the reader waits for
// the reader's tour to finish and the other way round.
let running = false;

/** Sent by a "?" button: show every tip of that surface again. */
export const COACH_REPLAY_EVENT = "setsuna:coach-replay";
export const replayTips = (surface: string) =>
    window.dispatchEvent(new CustomEvent(COACH_REPLAY_EVENT, { detail: surface }));

type CoachTourProps = {
    /** All tips of this surface; the tour shows those not seen yet whose element is on screen. */
    steps: CoachStep[];
    language: string;
    /** The surface is open (menu, settings section, mode). */
    active: boolean;
    /** Wait for the surface's open animation before measuring buttons. */
    delayMs?: number;
    /** Keep looking while active: screens inside a mode (a book, a manga volume) appear later. */
    watch?: boolean;
    /** Name the "?" button of this surface sends to replay its tips. */
    surface?: string;
};

/**
 * Unseen tips whose element is on screen, in reading order (clustered by row center Y
 * within 28 px, then strictly left to right inside each row), so the tip walks along
 * the screen smoothly without jumping back and forth.
 */
const pendingSteps = (steps: CoachStep[], includeSeen = false) => {
    const items = steps
        .map((step, index) => ({ step, index, element: !includeSeen && tipSeen(step.id) ? null : resolveTarget(step) }))
        .filter((item): item is { step: CoachStep; index: number; element: HTMLElement } => Boolean(item.element))
        .map((item) => {
            const rect = item.element.getBoundingClientRect();
            return { ...item, rect, midY: (rect.top + rect.bottom) / 2 };
        })
        .sort((a, b) => a.midY - b.midY || a.rect.left - b.rect.left || a.index - b.index);

    const rows: Array<{ anchorY: number; entries: typeof items }> = [];
    for (const item of items) {
        const lastRow = rows[rows.length - 1];
        if (lastRow && Math.abs(item.midY - lastRow.anchorY) <= 28) {
            lastRow.entries.push(item);
        } else {
            rows.push({ anchorY: item.midY, entries: [item] });
        }
    }
    return rows.flatMap((row) =>
        row.entries
            .sort((a, b) => a.rect.left - b.rect.left || a.index - b.index)
            .map((item) => item.step),
    );
};

/** Runs the first-time tips for one surface of the app (a mode, the Esc menu, a settings section). */
export default function CoachTour({ steps, language, active, delayMs = 700, watch = false, surface }: CoachTourProps) {
    const [shown, setShown] = useState<CoachStep[] | null>(null);
    const [resetCount, setResetCount] = useState(0);
    const [replayCount, setReplayCount] = useState(0);
    const key = steps.map((step) => step.id).join("|");
    const stepsRef = useRef(steps);
    stepsRef.current = steps;

    // "?" on this screen: every tip whose button is on screen, seen or not.
    useEffect(() => {
        if (!surface || !active) return;
        const onReplay = (event: Event) => {
            if ((event as CustomEvent<string>).detail !== surface) return;
            const all = pendingSteps(stepsRef.current, true);
            if (all.length === 0) return;
            running = true;
            setReplayCount((count) => count + 1);
            setShown(all);
        };
        window.addEventListener(COACH_REPLAY_EVENT, onReplay);
        return () => window.removeEventListener(COACH_REPLAY_EVENT, onReplay);
    }, [surface, active]);

    useEffect(() => {
        const onReset = () => setResetCount((count) => count + 1);
        window.addEventListener(ONBOARDING_RESET_EVENT, onReset);
        return () => window.removeEventListener(ONBOARDING_RESET_EVENT, onReset);
    }, []);

    useEffect(() => {
        if (!active) {
            setShown(null);
            return;
        }
        if (!steps.some((step) => !tipSeen(step.id))) return;
        let timer = 0;
        const tryStart = (attempt: number) => {
            const again = () => { timer = window.setTimeout(() => tryStart(attempt + 1), watch ? 1500 : 500); };
            if (running) {
                // Another tour is open; look again shortly.
                if (watch || attempt < 40) again();
                return;
            }
            const pending = pendingSteps(steps);
            if (pending.length === 0) {
                if (watch && steps.some((step) => !tipSeen(step.id))) again();
                return;
            }
            running = true;
            setShown(pending);
        };
        if (!shown) timer = window.setTimeout(() => tryStart(0), delayMs);
        return () => window.clearTimeout(timer);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [active, key, resetCount, delayMs, watch, shown === null]);

    useEffect(() => {
        if (!shown) return;
        running = true;
        return () => { running = false; };
    }, [shown]);

    if (!shown || !active) return null;
    return <Coachmarks key={replayCount} steps={shown} language={language} onDone={() => setShown(null)} />;
}
