import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { CoachStep } from "./guides";
import { markTipsSeen } from "./onboardingStore";
import TipDetail from "./TipDetail";
import { tipDetail } from "./tipDetails";
import "./onboarding.css";

/** Other components (the auto-hiding reader island) stay visible while a tour runs. */
export const COACH_ACTIVE_EVENT = "setsuna:coach-active";

const GAP = 12;
const CARD_WIDTH = 324;
const MARGIN = 12;

type Placement = {
    ring: { left: number; top: number; width: number; height: number };
    card: { left: number; top: number };
    arrowLeft: number;
    /** below / above: card next to the element with an arrow; inside: big panels, card in its corner. */
    side: "below" | "above" | "inside";
};

const hasSize = (element: Element) => {
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
};

const OPEN_MODAL_SELECTOR =
    "dialog[open], .app-menu-backdrop.is-open, .settings-overlay:not(.is-preview), .modal-overlay, .deck-picker-backdrop";

/**
 * Another window lies over the element ("Continue reading?", Esc menu, a modal): a tip must
 * not point at a button the user can't see. Elements that ignore the pointer
 * (auto-hidden reader chrome) can't be tested by hit-test and count as visible once modal
 * occlusion is ruled out.
 */
const isCovered = (element: HTMLElement): boolean => {
    const openModals = Array.from(document.querySelectorAll<HTMLElement>(OPEN_MODAL_SELECTOR));
    if (openModals.length > 0 && !openModals.some((modal) => modal.contains(element))) {
        return true;
    }
    if (getComputedStyle(element).pointerEvents === "none") return false;
    const rect = element.getBoundingClientRect();
    const clip = visibleClip(element);
    const top = Math.max(rect.top, clip.top);
    const bottom = Math.min(rect.bottom, clip.bottom);
    const left = Math.max(rect.left, clip.left);
    const right = Math.min(rect.right, clip.right);
    if (bottom <= top || right <= left) return false; // off screen: scrolled into view later
    const hit = document.elementsFromPoint((left + right) / 2, (top + bottom) / 2)
        .find((node) => !node.closest(".onb-coach-layer, .onb-backdrop"));
    return Boolean(hit) && !element.contains(hit!);
};

const usable = (element: HTMLElement | null): element is HTMLElement => Boolean(element && hasSize(element) && !isCovered(element));

/** The element a step points at. `pick: "last"` takes the last match on screen (the newest line). */
export const resolveTarget = (step: Pick<CoachStep, "target" | "pick">): HTMLElement | null => {
    if (step.pick !== "last") {
        return Array.from(document.querySelectorAll<HTMLElement>(step.target)).find(usable) || null;
    }
    const all = Array.from(document.querySelectorAll<HTMLElement>(step.target)).filter(usable);
    const onScreen = all.filter((element) => {
        const rect = element.getBoundingClientRect();
        return rect.top >= 0 && rect.bottom <= window.innerHeight;
    });
    return onScreen[onScreen.length - 1] || all[all.length - 1] || null;
};

type Box = { top: number; bottom: number; left: number; right: number };

/**
 * The part of the screen where the element can actually be seen: the viewport
 * cut by every scrolling or clipping parent (the settings content scrolls inside
 * its window, so the viewport alone let the ring spill over the window's header).
 */
export const visibleClip = (element: Element): Box => {
    const clip: Box = { top: 0, bottom: window.innerHeight, left: 0, right: window.innerWidth };
    for (let parent = element.parentElement; parent && parent !== document.body; parent = parent.parentElement) {
        const style = getComputedStyle(parent);
        if (!/(auto|scroll|hidden|clip)/.test(style.overflowY + style.overflowX)) continue;
        const rect = parent.getBoundingClientRect();
        clip.top = Math.max(clip.top, rect.top);
        clip.bottom = Math.min(clip.bottom, rect.bottom);
        clip.left = Math.max(clip.left, rect.left);
        clip.right = Math.min(clip.right, rect.right);
    }
    return clip;
};

const place = (rect: DOMRect, clip: Box, cardHeight: number): Placement => {
    const pad = 4;
    const visibleTop = Math.max(rect.top, clip.top);
    const visibleBottom = Math.max(visibleTop, Math.min(rect.bottom, clip.bottom));
    const visibleLeft = Math.max(rect.left, clip.left);
    const visibleRight = Math.max(visibleLeft, Math.min(rect.right, clip.right));
    const ring = { left: visibleLeft - pad, top: visibleTop - pad, width: visibleRight - visibleLeft + pad * 2, height: visibleBottom - visibleTop + pad * 2 };
    const width = Math.min(CARD_WIDTH, window.innerWidth - MARGIN * 2);
    const centerX = (visibleLeft + visibleRight) / 2;
    const fitsBelow = visibleBottom + GAP + cardHeight <= window.innerHeight - MARGIN;
    const fitsAbove = visibleTop - GAP - cardHeight >= MARGIN;
    // A panel that fills most of its scroll area (a settings card): a tip next to
    // it would cover the neighbouring card, so it goes inside the top-right corner.
    const big = visibleBottom - visibleTop > (clip.bottom - clip.top) * 0.45
        && visibleRight - visibleLeft > (clip.right - clip.left) * 0.6;
    if (big || (!fitsBelow && !fitsAbove)) {
        // A settings card or a whole panel: the tip sits in its top-right corner.
        const left = Math.min(Math.max(visibleRight - width - 16, MARGIN), window.innerWidth - width - MARGIN);
        return { ring, card: { left, top: Math.max(MARGIN, visibleTop + 14) }, arrowLeft: width / 2, side: "inside" };
    }
    const left = Math.min(Math.max(centerX - width / 2, MARGIN), window.innerWidth - width - MARGIN);
    const side = fitsBelow ? "below" : "above";
    const top = side === "below" ? ring.top + ring.height + GAP : ring.top - GAP - cardHeight;
    return {
        ring,
        card: { left, top: Math.max(MARGIN, Math.min(top, window.innerHeight - cardHeight - MARGIN)) },
        arrowLeft: Math.min(Math.max(centerX - left, 18), width - 18),
        side,
    };
};

type CoachmarksProps = {
    steps: CoachStep[];
    language: string;
    onDone: () => void;
};

/**
 * Tips anchored to buttons with an arrow (variant A). Steps whose button is not
 * on screen are skipped; every step shown or skipped is remembered as seen.
 */
export default function Coachmarks({ steps, language, onDone }: CoachmarksProps) {
    const isEn = language === "en";
    const [index, setIndex] = useState(0);
    const [placement, setPlacement] = useState<Placement | null>(null);
    const cardRef = useRef<HTMLDivElement>(null);
    const [detailOpen, setDetailOpen] = useState(false);
    const [portalTarget, setPortalTarget] = useState<Element>(() => document.body);
    const step = steps[index];
    const detail = step ? tipDetail(step.id, language) : null;
    useEffect(() => setDetailOpen(false), [index]);

    useEffect(() => {
        window.dispatchEvent(new CustomEvent(COACH_ACTIVE_EVENT, { detail: true }));
        // onboarding.css keeps auto-hiding reader and player chrome visible meanwhile.
        document.body.classList.add("onb-touring");
        return () => {
            document.body.classList.remove("onb-touring");
            window.dispatchEvent(new CustomEvent(COACH_ACTIVE_EVENT, { detail: false }));
        };
    }, []);

    const finish = (seenAll: boolean) => {
        markTipsSeen(seenAll ? steps.map((item) => item.id) : steps.slice(0, index + 1).map((item) => item.id));
        onDone();
    };
    const next = () => {
        markTipsSeen([step.id]);
        // The next button may have disappeared since the tour started.
        let nextIndex = index + 1;
        while (nextIndex < steps.length && !resolveTarget(steps[nextIndex])) nextIndex += 1;
        if (nextIndex >= steps.length) finish(true);
        else setIndex(nextIndex);
    };
    const back = () => {
        let previous = index - 1;
        while (previous >= 0 && !resolveTarget(steps[previous])) previous -= 1;
        if (previous >= 0) setIndex(previous);
    };

    // Follow the button: the island slides in, panels can be dragged, windows resize.
    useLayoutEffect(() => {
        if (!step) return;
        let frame = 0;
        let last = "";
        let missing = 0;
        // Settings cards can be below the fold: bring the element into view first.
        const first = resolveTarget(step);
        if (first) {
            const rect = first.getBoundingClientRect();
            const clip = visibleClip(first);
            if (rect.top < clip.top || rect.bottom > clip.bottom) {
                // Tall panels show their top (the heading the tip talks about).
                first.scrollIntoView({ block: rect.height > (clip.bottom - clip.top) * 0.8 ? "start" : "nearest", behavior: "smooth" });
            }
        }
        const update = () => {
            const target = resolveTarget(step);
            if (target) {
                const nextPortal = target.closest("dialog[open]") || document.body;
                setPortalTarget((prev) => (prev === nextPortal ? prev : nextPortal));
                const rect = target.getBoundingClientRect();
                const cardHeight = cardRef.current?.offsetHeight || 140;
                const clip = visibleClip(target);
                const key = `${rect.left}|${rect.top}|${rect.width}|${rect.height}|${cardHeight}|${clip.top}|${clip.bottom}|${clip.left}|${clip.right}`;
                if (key !== last) {
                    last = key;
                    setPlacement(place(rect, clip, cardHeight));
                }
                missing = 0;
            } else {
                const openModals = Array.from(document.querySelectorAll<HTMLElement>(OPEN_MODAL_SELECTOR));
                const hasUnrelatedModal = openModals.length > 0 && !steps.some((item) => resolveTarget(item));
                if (hasUnrelatedModal || ++missing > 45) {
                    // An unrelated modal opened over this surface, or the element went away:
                    // move on to a tip still on screen, or stop and show the rest later.
                    const nextIndex = hasUnrelatedModal ? -1 : steps.findIndex((item, position) => position > index && resolveTarget(item));
                    if (nextIndex >= 0) setIndex(nextIndex);
                    else onDone();
                    return;
                }
            }
            frame = window.requestAnimationFrame(update);
        };
        update();
        return () => window.cancelAnimationFrame(frame);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [step]);

    useEffect(() => {
        const onKey = (event: KeyboardEvent) => {
            if (detailOpen) return;
            if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                event.stopImmediatePropagation();
                finish(true);
            } else if (event.key === "Enter" || event.key === "ArrowRight") {
                event.preventDefault();
                event.stopPropagation();
                event.stopImmediatePropagation();
                next();
            } else if (event.key === "ArrowLeft") {
                event.preventDefault();
                event.stopPropagation();
                event.stopImmediatePropagation();
                back();
            }
        };
        window.addEventListener("keydown", onKey, true);
        return () => window.removeEventListener("keydown", onKey, true);
    });

    if (!step) return null;

    return createPortal(
        <div className="onb-coach-layer" aria-live="polite">
            {placement && !detailOpen && <div className="onb-coach-ring" style={placement.ring} />}
            {!detailOpen && <div
                ref={cardRef}
                key={step.id}
                className={`onb-coach-card${placement ? ` is-${placement.side}` : ""}`}
                role="dialog"
                aria-label={step.title}
                style={placement
                    ? { left: placement.card.left, top: placement.card.top, width: Math.min(CARD_WIDTH, window.innerWidth - MARGIN * 2), ["--arrow-left" as any]: `${placement.arrowLeft}px` }
                    : { visibility: "hidden" }}
            >
                <div className="onb-coach-head">
                    <div className="onb-coach-title">{step.title}</div>
                    <span className="onb-coach-count">{isEn ? `${index + 1} / ${steps.length}` : `${index + 1} из ${steps.length}`}</span>
                </div>
                <div className="onb-coach-body">{step.body}</div>
                {detail && (
                    <button type="button" className="onb-coach-more" onClick={() => setDetailOpen(true)}>
                        {isEn ? "More" : "Подробнее"} →
                    </button>
                )}
                <div className="onb-coach-actions">
                    <button type="button" className="onb-btn" onClick={() => finish(true)}>{isEn ? "Skip" : "Пропустить"}</button>
                    <div className="onb-coach-nav">
                        {index > 0 && <button type="button" className="onb-btn" onClick={back}>{isEn ? "Back" : "Назад"}</button>}
                        <button type="button" className="onb-btn is-primary" onClick={next} autoFocus>
                            {index + 1 >= steps.length ? (isEn ? "Done" : "Готово") : (isEn ? "Next" : "Дальше")}
                        </button>
                    </div>
                </div>
            </div>}
            {detailOpen && detail && (
                <TipDetail title={step.title} paragraphs={detail} language={language} portalTarget={portalTarget} onClose={() => setDetailOpen(false)} />
            )}
        </div>,
        portalTarget.isConnected ? portalTarget : document.body,
    );
}
