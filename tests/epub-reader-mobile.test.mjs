import { test } from "node:test";
import assert from "node:assert/strict";
import {
    advanceWheelOverscroll,
    computeRubberBandPx,
    computeTouchPullState,
    detectScrollEdges,
    IDLE_OVERSCROLL_STATE,
    TOUCH_ARM_PX,
    TOUCH_AUTO_TRIGGER_PX,
} from "../src/features/epub/epubScrollBoundary.ts";
import {
    buildPdfLookupTarget,
    clampPdfPage,
    computePdfFitScale,
    computePinchScale,
    groupPdfTextItemsIntoLines,
} from "../src/features/epub/pdfModel.ts";
import {
    dispatchMobileBack,
    MOBILE_BACK_PRIORITY,
    registerMobileBackHandler,
    resetMobileBackHandlersForTest,
} from "../src/utils/mobileBack.ts";

test("detectScrollEdges handles horizontal-tb and vertical-rl RTL scroll boundaries", () => {
    // Horizontal scroll: top, middle, bottom, and short chapter fitting viewport
    assert.deepEqual(
        detectScrollEdges({
            isVertical: false,
            scrollTop: 0,
            scrollHeight: 1500,
            clientHeight: 600,
            scrollLeft: 0,
            scrollWidth: 800,
            clientWidth: 800,
        }),
        { atStart: true, atEnd: false, fitsInViewport: false },
    );

    assert.deepEqual(
        detectScrollEdges({
            isVertical: false,
            scrollTop: 450,
            scrollHeight: 1500,
            clientHeight: 600,
            scrollLeft: 0,
            scrollWidth: 800,
            clientWidth: 800,
        }),
        { atStart: false, atEnd: false, fitsInViewport: false },
    );

    assert.deepEqual(
        detectScrollEdges({
            isVertical: false,
            scrollTop: 899,
            scrollHeight: 1500,
            clientHeight: 600,
            scrollLeft: 0,
            scrollWidth: 800,
            clientWidth: 800,
        }),
        { atStart: false, atEnd: true, fitsInViewport: false },
    );

    assert.deepEqual(
        detectScrollEdges({
            isVertical: false,
            scrollTop: 0,
            scrollHeight: 500,
            clientHeight: 600,
            scrollLeft: 0,
            scrollWidth: 800,
            clientWidth: 800,
        }),
        { atStart: true, atEnd: true, fitsInViewport: true },
    );

    // Vertical-rl RTL scroll: scrollLeft starts at 0 (right edge) and becomes negative toward left end
    assert.deepEqual(
        detectScrollEdges({
            isVertical: true,
            scrollTop: 0,
            scrollHeight: 600,
            clientHeight: 600,
            scrollLeft: 0,
            scrollWidth: 2200,
            clientWidth: 800,
        }),
        { atStart: true, atEnd: false, fitsInViewport: false },
    );

    assert.deepEqual(
        detectScrollEdges({
            isVertical: true,
            scrollTop: 0,
            scrollHeight: 600,
            clientHeight: 600,
            scrollLeft: -1399,
            scrollWidth: 2200,
            clientWidth: 800,
        }),
        { atStart: false, atEnd: true, fitsInViewport: false },
    );
});

test("advanceWheelOverscroll accumulates progressively, blocks invalid edges, and auto-triggers chapter switch", () => {
    const endEdges = { atStart: false, atEnd: true, fitsInViewport: false };
    const startEdges = { atStart: true, atEnd: false, fitsInViewport: false };

    // Single large wheel notch is clamped to 110px -> shows Telegram ring without accidental instant jump
    const step1 = advanceWheelOverscroll(IDLE_OVERSCROLL_STATE, 300, endEdges, true, true);
    assert.equal(step1.trigger, 0);
    assert.equal(step1.state.direction, 1);
    assert.equal(step1.state.armed, false);
    assert.ok(step1.state.progress > 0 && step1.state.progress < 1);
    assert.ok(step1.state.rubberPx > 0);

    // Scrolling back up away from bottom resets overscroll immediately
    const reversed = advanceWheelOverscroll(step1.state, -80, endEdges, true, true);
    assert.equal(reversed.trigger, 0);
    assert.deepEqual(reversed.state, IDLE_OVERSCROLL_STATE);

    // Continued downward push reaches threshold and automatically triggers +1 chapter transition
    const step2 = advanceWheelOverscroll(step1.state, 100, endEdges, true, true);
    assert.equal(step2.trigger, 0);
    const step3 = advanceWheelOverscroll(step2.state, 100, endEdges, true, true);
    assert.equal(step3.trigger, 1);
    assert.equal(step3.state.armed, true);

    // Scrolling up at chapter start auto-triggers -1 chapter
    const p1 = advanceWheelOverscroll(IDLE_OVERSCROLL_STATE, -100, startEdges, true, true);
    const p2 = advanceWheelOverscroll(p1.state, -100, startEdges, true, true);
    const p3 = advanceWheelOverscroll(p2.state, -100, startEdges, true, true);
    assert.equal(p3.trigger, -1);

    // Blocked when at the very first or very last chapter of the book
    const blockedNext = advanceWheelOverscroll(IDLE_OVERSCROLL_STATE, 200, endEdges, true, false);
    assert.deepEqual(blockedNext.state, IDLE_OVERSCROLL_STATE);
    assert.equal(blockedNext.trigger, 0);
});

test("computeTouchPullState supports Android horizontal-tb and vertical-rl RTL pull gestures", () => {
    const endEdges = { atStart: false, atEnd: true, fitsInViewport: false };
    const startEdges = { atStart: true, atEnd: false, fitsInViewport: false };

    // Horizontal-tb: pull finger UP (negative dy) at bottom -> next chapter (+1)
    const partial = computeTouchPullState(-50, false, endEdges, true, true);
    assert.equal(partial.state.direction, 1);
    assert.equal(partial.state.armed, false);
    assert.equal(partial.autoTrigger, 0);

    const armed = computeTouchPullState(-(TOUCH_ARM_PX + 10), false, endEdges, true, true);
    assert.equal(armed.state.direction, 1);
    assert.equal(armed.state.armed, true);
    assert.equal(armed.autoTrigger, 0);

    // Deep pull past TOUCH_AUTO_TRIGGER_PX switches automatically without needing finger lift
    const autoNext = computeTouchPullState(-(TOUCH_AUTO_TRIGGER_PX + 12), false, endEdges, true, true);
    assert.equal(autoNext.autoTrigger, 1);
    assert.ok(computeRubberBandPx(500, 46) <= 46);

    // Pull finger DOWN (positive dy) at top -> previous chapter (-1)
    const prevArmed = computeTouchPullState(TOUCH_ARM_PX + 12, false, startEdges, true, true);
    assert.equal(prevArmed.state.direction, -1);
    assert.equal(prevArmed.state.armed, true);

    // Vertical-rl RTL: pull finger RIGHT (+dx) at left end -> next (+1), pull LEFT (-dx) at right start -> prev (-1)
    const rtlNext = computeTouchPullState(TOUCH_ARM_PX + 15, true, endEdges, true, true);
    assert.equal(rtlNext.state.direction, 1);
    assert.equal(rtlNext.state.armed, true);

    const rtlPrev = computeTouchPullState(-(TOUCH_ARM_PX + 15), true, startEdges, true, true);
    assert.equal(rtlPrev.state.direction, -1);
    assert.equal(rtlPrev.state.armed, true);
});

test("pdfModel detects vertical Japanese PDF columns RTL and handles fit/pinch math", () => {
    const vpTransform = [1, 0, 0, -1, 0, 800];
    // Two vertical Japanese columns: right column at x=420 ("吾輩"), left column at x=360 ("は猫")
    const verticalItems = [
        { str: "吾", transform: [16, 0, 0, 16, 420, 720], width: 16, height: 16 },
        { str: "輩", transform: [16, 0, 0, 16, 420, 700], width: 16, height: 16 },
        { str: "は", transform: [16, 0, 0, 16, 360, 720], width: 16, height: 16 },
        { str: "猫", transform: [16, 0, 0, 16, 360, 700], width: 16, height: 16 },
    ];
    const lines = groupPdfTextItemsIntoLines(verticalItems, vpTransform);
    assert.equal(lines.length, 2);
    assert.equal(lines[0].isVertical, true);
    assert.equal(lines[0].text, "吾輩");
    assert.equal(lines[1].text, "は猫");

    const target = buildPdfLookupTarget(lines[0].text, lines[0].spans[1], 0.5);
    assert.equal(target?.token, "輩");
    assert.equal(target?.cursor, 1);

    // Fit calculations with rotation
    const fitW = computePdfFitScale(600, 900, 900, 700, "fit-width", 1, 0);
    assert.ok(Math.abs(fitW - 1.5) < 1e-6);

    const fitPageRot = computePdfFitScale(600, 900, 900, 700, "fit-page", 1, 90);
    // At 90deg swapped page is 900x600 -> min(900/900, 700/600) = 1.0
    assert.ok(Math.abs(fitPageRot - 1.0) < 1e-6);

    assert.equal(computePinchScale(100, 150, 1.0), 1.5);
    assert.equal(computePinchScale(100, 500, 1.0), 3.0);
    assert.equal(computePinchScale(100, 10, 1.0), 0.5);
    assert.equal(clampPdfPage(99, 12), 12);
    assert.equal(clampPdfPage(-4, 12), 1);
});

test("PDF reader Android Back stack peels selectionPill -> appearance -> search -> toc -> reader -> library -> home", () => {
    resetMobileBackHandlersForTest();
    let screen = "reader";
    let selectionPill = true;
    let appearance = true;
    let search = true;
    let toc = true;

    registerMobileBackHandler(MOBILE_BACK_PRIORITY.WORKSPACE, () => {
        if (screen === "home") return false;
        screen = "home";
    });
    registerMobileBackHandler(MOBILE_BACK_PRIORITY.SUBVIEW, () => {
        if (screen !== "reader") return false;
        screen = "library";
    });
    registerMobileBackHandler(MOBILE_BACK_PRIORITY.READER_OVERLAY, () => {
        if (selectionPill) { selectionPill = false; return; }
        if (appearance) { appearance = false; return; }
        if (search) { search = false; return; }
        if (toc) { toc = false; return; }
        return false;
    });

    assert.equal(dispatchMobileBack(), true);
    assert.equal(selectionPill, false);
    assert.equal(appearance, true);

    assert.equal(dispatchMobileBack(), true);
    assert.equal(appearance, false);
    assert.equal(search, true);

    assert.equal(dispatchMobileBack(), true);
    assert.equal(search, false);
    assert.equal(toc, true);

    assert.equal(dispatchMobileBack(), true);
    assert.equal(toc, false);
    assert.equal(screen, "reader");

    assert.equal(dispatchMobileBack(), true);
    assert.equal(screen, "library");

    assert.equal(dispatchMobileBack(), true);
    assert.equal(screen, "home");

    assert.equal(dispatchMobileBack(), false);
    resetMobileBackHandlersForTest();
});
