/**
 * Pure state machine & geometry helpers for Telegram-style elastic overscroll /
 * pull-to-switch-chapter transitions in EPUB scroll mode (horizontal-tb & vertical-rl,
 * both Desktop wheel/trackpad and Android touch pull).
 */

export type ScrollChapterDirection = 1 | -1;

export interface ScrollEdgeSnapshot {
    isVertical: boolean;
    scrollTop: number;
    scrollHeight: number;
    clientHeight: number;
    scrollLeft: number;
    scrollWidth: number;
    clientWidth: number;
}

export interface ScrollEdgeFlags {
    atStart: boolean;
    atEnd: boolean;
    /** True when the entire chapter fits inside the viewport with no internal scroll range */
    fitsInViewport: boolean;
}

export interface OverscrollState {
    direction: ScrollChapterDirection | 0;
    /** Raw accumulated pull distance (px) */
    distance: number;
    /** Normalized progress 0..1.5 (1.0 = armed / ready to switch) */
    progress: number;
    /** True once progress >= 1.0 (Telegram ring turns solid / arrow flips) */
    armed: boolean;
    /** Damped visual rubber-band offset in pixels */
    rubberPx: number;
    /** Source gesture kind */
    source: "wheel" | "touch" | "none";
}

export const IDLE_OVERSCROLL_STATE: OverscrollState = {
    direction: 0,
    distance: 0,
    progress: 0,
    armed: false,
    rubberPx: 0,
    source: "none",
};

export const WHEEL_TRIGGER_PX = 260;
export const TOUCH_ARM_PX = 88;
export const TOUCH_AUTO_TRIGGER_PX = 136;
export const EDGE_TOLERANCE_PX = 3;

export function detectScrollEdges(s: ScrollEdgeSnapshot): ScrollEdgeFlags {
    if (s.isVertical) {
        const max = Math.max(0, s.scrollWidth - s.clientWidth);
        if (max <= EDGE_TOLERANCE_PX) {
            return { atStart: true, atEnd: true, fitsInViewport: true };
        }
        const current = Math.abs(s.scrollLeft);
        return {
            atStart: current <= EDGE_TOLERANCE_PX,
            atEnd: current >= max - EDGE_TOLERANCE_PX,
            fitsInViewport: false,
        };
    }

    const max = Math.max(0, s.scrollHeight - s.clientHeight);
    if (max <= EDGE_TOLERANCE_PX) {
        return { atStart: true, atEnd: true, fitsInViewport: true };
    }
    const current = Math.max(0, s.scrollTop);
    return {
        atStart: current <= EDGE_TOLERANCE_PX,
        atEnd: current >= max - EDGE_TOLERANCE_PX,
        fitsInViewport: false,
    };
}

/**
 * Logarithmic rubber-band damping (iOS / Telegram feel): moves smoothly up to maxStretch.
 */
export function computeRubberBandPx(distance: number, maxStretch = 44): number {
    const abs = Math.max(0, distance);
    if (abs <= 0) return 0;
    return Math.round(maxStretch * (1 - Math.exp(-abs / 110)) * 10) / 10;
}

/**
 * Advances desktop wheel/trackpad overscroll accumulation.
 * Returns updated state + `trigger: 1 | -1 | 0` when threshold is reached automatically.
 */
export function advanceWheelOverscroll(
    prev: OverscrollState,
    deltaPx: number,
    edges: ScrollEdgeFlags,
    canGoPrev: boolean,
    canGoNext: boolean,
): { state: OverscrollState; trigger: ScrollChapterDirection | 0 } {
    if (!Number.isFinite(deltaPx) || Math.abs(deltaPx) < 1) {
        return { state: prev, trigger: 0 };
    }

    const dir: ScrollChapterDirection = deltaPx > 0 ? 1 : -1;
    const allowed = dir === 1 ? (edges.atEnd && canGoNext) : (edges.atStart && canGoPrev);

    if (!allowed) {
        if (prev.direction !== 0) {
            return { state: IDLE_OVERSCROLL_STATE, trigger: 0 };
        }
        return { state: prev, trigger: 0 };
    }

    // Clamp single-notch wheel spikes so a single fast tick shows visual feedback
    // while 2-3 notches or a smooth trackpad swipe seamlessly completes the transition.
    const step = Math.min(110, Math.abs(deltaPx));
    const nextDist = prev.direction === dir ? prev.distance + step : step;
    const progress = Math.min(1.2, nextDist / WHEEL_TRIGGER_PX);
    const armed = progress >= 1;
    const rubberPx = computeRubberBandPx(nextDist, 38);

    if (armed) {
        return {
            state: {
                direction: dir,
                distance: nextDist,
                progress: 1,
                armed: true,
                rubberPx,
                source: "wheel",
            },
            trigger: dir,
        };
    }

    return {
        state: {
            direction: dir,
            distance: nextDist,
            progress,
            armed: false,
            rubberPx,
            source: "wheel",
        },
        trigger: 0,
    };
}

/**
 * Computes touch pull state during an active Android/touch finger drag at a chapter boundary.
 * - Horizontal-tb (`isVertical = false`): pulling finger UP (`deltaPrimary < 0`) at bottom -> next (`+1`);
 *   pulling finger DOWN (`deltaPrimary > 0`) at top -> prev (`-1`).
 * - Vertical-rl (`isVertical = true`): pulling finger RIGHT (`deltaPrimary > 0`) at left end -> next (`+1`);
 *   pulling finger LEFT (`deltaPrimary < 0`) at right start -> prev (`-1`).
 */
export function computeTouchPullState(
    deltaPrimary: number,
    isVertical: boolean,
    edges: ScrollEdgeFlags,
    canGoPrev: boolean,
    canGoNext: boolean,
): { state: OverscrollState; autoTrigger: ScrollChapterDirection | 0 } {
    if (!Number.isFinite(deltaPrimary) || Math.abs(deltaPrimary) < 6) {
        return { state: IDLE_OVERSCROLL_STATE, autoTrigger: 0 };
    }

    const dir: ScrollChapterDirection = isVertical
        ? (deltaPrimary > 0 ? 1 : -1)
        : (deltaPrimary < 0 ? 1 : -1);

    const allowed = dir === 1 ? (edges.atEnd && canGoNext) : (edges.atStart && canGoPrev);
    if (!allowed) {
        return { state: IDLE_OVERSCROLL_STATE, autoTrigger: 0 };
    }

    const dist = Math.max(0, Math.abs(deltaPrimary) - 6);
    const progress = Math.min(1.5, dist / TOUCH_ARM_PX);
    const armed = dist >= TOUCH_ARM_PX;
    const rubberPx = computeRubberBandPx(dist, 46);
    const autoTrigger: ScrollChapterDirection | 0 = dist >= TOUCH_AUTO_TRIGGER_PX ? dir : 0;

    return {
        state: {
            direction: dir,
            distance: dist,
            progress,
            armed,
            rubberPx,
            source: "touch",
        },
        autoTrigger,
    };
}
