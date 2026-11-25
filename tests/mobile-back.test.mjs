import test from "node:test";
import assert from "node:assert/strict";
import {
    dispatchMobileBack,
    MOBILE_BACK_PRIORITY,
    registerMobileBackHandler,
    resetMobileBackHandlersForTest,
} from "../src/utils/mobileBack.ts";
import { resolveEpubViewModeAfterChange } from "../src/features/epub/epubLibraryModel.ts";

test("dispatchMobileBack honors priority, LIFO order, fallthrough, and peels one layer per gesture", () => {
    resetMobileBackHandlersForTest();
    const events = [];

    const unWorkspace = registerMobileBackHandler(MOBILE_BACK_PRIORITY.WORKSPACE, () => {
        events.push("workspace");
    });
    const unSubview = registerMobileBackHandler(MOBILE_BACK_PRIORITY.SUBVIEW, () => {
        events.push("subview");
    });
    const unOverlay = registerMobileBackHandler(MOBILE_BACK_PRIORITY.READER_OVERLAY, () => {
        events.push("overlay");
    });
    const unModalFirst = registerMobileBackHandler(MOBILE_BACK_PRIORITY.MODAL, () => {
        events.push("modal-1");
    });
    const unModalSecond = registerMobileBackHandler(MOBILE_BACK_PRIORITY.MODAL, () => {
        events.push("modal-2");
    });
    const unPopupPass = registerMobileBackHandler(MOBILE_BACK_PRIORITY.POPUP + 1, () => {
        events.push("popup-noop");
        return false;
    });
    const unPopup = registerMobileBackHandler(MOBILE_BACK_PRIORITY.POPUP, () => {
        events.push("popup");
    });

    assert.equal(dispatchMobileBack(), true);
    assert.deepEqual(events, ["popup-noop", "popup"]);
    unPopup();
    unPopupPass();

    assert.equal(dispatchMobileBack(), true);
    assert.deepEqual(events, ["popup-noop", "popup", "modal-2"]);
    unModalSecond();

    assert.equal(dispatchMobileBack(), true);
    assert.deepEqual(events, ["popup-noop", "popup", "modal-2", "modal-1"]);
    unModalFirst();

    assert.equal(dispatchMobileBack(), true);
    assert.deepEqual(events, ["popup-noop", "popup", "modal-2", "modal-1", "overlay"]);
    unOverlay();

    assert.equal(dispatchMobileBack(), true);
    assert.deepEqual(events, ["popup-noop", "popup", "modal-2", "modal-1", "overlay", "subview"]);
    unSubview();

    assert.equal(dispatchMobileBack(), true);
    assert.deepEqual(events, ["popup-noop", "popup", "modal-2", "modal-1", "overlay", "subview", "workspace"]);
    unWorkspace();

    assert.equal(dispatchMobileBack(), false);
});

test("mobile Back walks realistic multi-step screens cleanly without skipping or exiting early", () => {
    resetMobileBackHandlersForTest();

    // Flow 1: Reader overlay -> Reader -> Library -> Home -> Exit
    let screen = "reader";
    let overlayOpen = true;
    const unWorkspace1 = registerMobileBackHandler(MOBILE_BACK_PRIORITY.WORKSPACE, () => {
        if (screen === "home") return false;
        screen = "home";
    });
    const unReader1 = registerMobileBackHandler(MOBILE_BACK_PRIORITY.SUBVIEW, () => {
        if (screen !== "reader") return false;
        screen = "library";
    });
    const unOverlay1 = registerMobileBackHandler(MOBILE_BACK_PRIORITY.READER_OVERLAY, () => {
        if (!overlayOpen) return false;
        overlayOpen = false;
    });

    assert.equal(dispatchMobileBack(), true);
    assert.equal(overlayOpen, false);
    assert.equal(screen, "reader");

    assert.equal(dispatchMobileBack(), true);
    assert.equal(screen, "library");

    assert.equal(dispatchMobileBack(), true);
    assert.equal(screen, "home");

    assert.equal(dispatchMobileBack(), false);
    unOverlay1();
    unReader1();
    unWorkspace1();

    // Flow 2: CatalogPicker Step 2 -> Step 1 -> Close -> Library -> Home
    resetMobileBackHandlersForTest();
    let libScreen = "library";
    let catalogOpen = true;
    let catalogStep = 2;
    const unHub = registerMobileBackHandler(MOBILE_BACK_PRIORITY.WORKSPACE, () => {
        if (libScreen === "home") return false;
        libScreen = "home";
    });
    const unCatStep1 = registerMobileBackHandler(MOBILE_BACK_PRIORITY.MODAL, () => {
        if (!catalogOpen || catalogStep !== 1) return false;
        catalogOpen = false;
    });
    const unCatStep2 = registerMobileBackHandler(MOBILE_BACK_PRIORITY.MODAL + 5, () => {
        if (!catalogOpen || catalogStep !== 2) return false;
        catalogStep = 1;
    });

    assert.equal(dispatchMobileBack(), true);
    assert.equal(catalogOpen, true);
    assert.equal(catalogStep, 1);

    assert.equal(dispatchMobileBack(), true);
    assert.equal(catalogOpen, false);
    assert.equal(libScreen, "library");

    assert.equal(dispatchMobileBack(), true);
    assert.equal(libScreen, "home");

    assert.equal(dispatchMobileBack(), false);
    unCatStep2();
    unCatStep1();
    unHub();

    // Flow 3: Context menu + selectMode + focused series folder
    resetMobileBackHandlersForTest();
    let ctxMenu = true;
    let selectMode = true;
    let focusedGroup = "houseki";
    registerMobileBackHandler(MOBILE_BACK_PRIORITY.SUBVIEW, () => {
        if (!focusedGroup) return false;
        focusedGroup = "";
    });
    registerMobileBackHandler(MOBILE_BACK_PRIORITY.SUBVIEW + 2, () => {
        if (!selectMode) return false;
        selectMode = false;
    });
    registerMobileBackHandler(MOBILE_BACK_PRIORITY.POPUP, () => {
        if (!ctxMenu) return false;
        ctxMenu = false;
    });

    assert.equal(dispatchMobileBack(), true);
    assert.equal(ctxMenu, false);
    assert.equal(selectMode, true);
    assert.equal(focusedGroup, "houseki");

    assert.equal(dispatchMobileBack(), true);
    assert.equal(selectMode, false);
    assert.equal(focusedGroup, "houseki");

    assert.equal(dispatchMobileBack(), true);
    assert.equal(focusedGroup, "");
    assert.equal(dispatchMobileBack(), false);

    // Flow 4: Mobile Settings sub-page -> Settings home -> Close
    resetMobileBackHandlersForTest();
    let settingsOpen = true;
    let settingsHome = false;
    registerMobileBackHandler(MOBILE_BACK_PRIORITY.MODAL, () => {
        if (!settingsOpen) return false;
        if (!settingsHome) {
            settingsHome = true;
            return;
        }
        settingsOpen = false;
    });

    assert.equal(dispatchMobileBack(), true);
    assert.equal(settingsOpen, true);
    assert.equal(settingsHome, true);
    assert.equal(dispatchMobileBack(), true);
    assert.equal(settingsOpen, false);
    assert.equal(dispatchMobileBack(), false);
    resetMobileBackHandlersForTest();
});

test("resolveEpubViewModeAfterChange prevents opening a fallback book when deleting titles", () => {
    // Deleting active book while in library stays in library
    assert.equal(
        resolveEpubViewModeAfterChange({
            currentViewMode: "library",
            prevActiveTabId: 10,
            nextActiveTabId: 20,
            prevBookIds: new Set([10, 20]),
            nextBookIds: new Set([20]),
            hasCatalogPrompt: false,
        }),
        "library",
    );

    // Deleting active book while in reader returns to library (never redirects to fallback book)
    assert.equal(
        resolveEpubViewModeAfterChange({
            currentViewMode: "reader",
            prevActiveTabId: 10,
            nextActiveTabId: 20,
            prevBookIds: new Set([10, 20]),
            nextBookIds: new Set([20]),
            hasCatalogPrompt: false,
        }),
        "library",
    );

    // Deleting a non-active book while in library stays in library even if activeTabId shifts
    assert.equal(
        resolveEpubViewModeAfterChange({
            currentViewMode: "library",
            prevActiveTabId: 10,
            nextActiveTabId: 30,
            prevBookIds: new Set([10, 20, 30]),
            nextBookIds: new Set([10, 30]),
            hasCatalogPrompt: false,
        }),
        "library",
    );

    // Deleting a non-active book while reading another book keeps reading the active book
    assert.equal(
        resolveEpubViewModeAfterChange({
            currentViewMode: "reader",
            prevActiveTabId: 10,
            nextActiveTabId: 10,
            prevBookIds: new Set([10, 20]),
            nextBookIds: new Set([10]),
            hasCatalogPrompt: false,
        }),
        "reader",
    );

    // Deleting the last book returns to library
    assert.equal(
        resolveEpubViewModeAfterChange({
            currentViewMode: "reader",
            prevActiveTabId: 10,
            nextActiveTabId: null,
            prevBookIds: new Set([10]),
            nextBookIds: new Set([]),
            hasCatalogPrompt: false,
        }),
        "library",
    );

    // Importing a book with catalogPrompt keeps library open
    assert.equal(
        resolveEpubViewModeAfterChange({
            currentViewMode: "library",
            prevActiveTabId: 10,
            nextActiveTabId: 30,
            prevBookIds: new Set([10]),
            nextBookIds: new Set([10, 30]),
            hasCatalogPrompt: true,
        }),
        "library",
    );

    // Selecting or importing without catalogPrompt opens reader
    assert.equal(
        resolveEpubViewModeAfterChange({
            currentViewMode: "library",
            prevActiveTabId: 10,
            nextActiveTabId: 30,
            prevBookIds: new Set([10]),
            nextBookIds: new Set([10, 30]),
            hasCatalogPrompt: false,
        }),
        "reader",
    );
});
