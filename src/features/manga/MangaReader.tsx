import {
    useCallback,
    useEffect,
    useMemo,
    useRef,
    useState,
    type CSSProperties,
    type MouseEvent as ReactMouseEvent,
    type PointerEvent as ReactPointerEvent,
    type TouchEvent as ReactTouchEvent,
    type WheelEvent as ReactWheelEvent,
} from "react";
import { listen } from "@tauri-apps/api/event";
import { open, save } from "@tauri-apps/plugin-dialog";
import { TokenizedLine } from "../../components/TextContainer";
import type { AppSettings } from "../../components/SettingsModal";
import { IconBookTab, IconClose, IconSearch, IconSettings } from "../../components/Icons";
import type { EpubBookmark, Tab } from "../../utils/constants";
import { getDay, sumDayForTabs, useDailyStatsVersion } from "../../utils/dailyStats";
import { getTranslator, type AppLanguage } from "../../utils/i18n";
import { setMobileVolumePagingEnabled } from "../../utils/mobileFiles";
import { MOBILE_BACK_PRIORITY, useMobileBackHandler } from "../../utils/mobileBack";
import type { EpubBookNote } from "../epub/epubModel";
import { evaluateGoalProgress, loadEpubGoals, type EpubReadingGoals } from "../epub/epubTracker";
import {
    attachMokuroOverlay,
    checkMokuroStatus,
    exportMangaMobileCbz,
    loadMangaOverrides,
    loadMangaPage,
    runMokuroOnVolume,
    saveMangaOverride,
    type MangaExportResult,
} from "./mangaApi";
import {
    applyBlockTextOverrides,
    buildSpreadPairs,
    computeBubbleCropRect,
    computeBubbleLineHeight,
    computeFittedBubbleFontPx,
    DEFAULT_MANGA_PREFS,
    detectBubbleParagraphGaps,
    findSpreadIndexForPage,
    joinMokuroLines,
    loadMangaPrefs,
    prepareBubbleDisplayLines,
    saveMangaPrefs,
    type MangaBgTheme,
    type MangaCropMode,
    type MangaMeta,
    type MangaMokuroStatus,
    type MangaOverlayMode,
    type MangaPagePayload,
    type MangaReaderPrefs,
    type MangaSpreadMode,
    type MokuroBlock,
} from "./mangaModel";
import {
    detectAndroidPageBlocksMlKit,
    getAndroidMangaOcrStatus,
    hasAndroidMangaOcrBridge,
    loadMangaOcrPrefs,
    normalizeOcrServerUrl,
    recognizeMangaCrop,
} from "./mangaOcr";
import "./manga.css";

const MAX_CACHED_PAGES = 18;
const CHROME_TOP_ZONE_PX = 76;
const CHROME_BOTTOM_ZONE_PX = 70;
const CHROME_HIDE_DELAY_MS = 320;
const EDGE_CLICK_RATIO = 0.12;
const EDGE_CLICK_MAX_PX = 130;
const WHEEL_PAGE_COOLDOWN_MS = 220;

const BG_THEME_OPTIONS: Array<{
    value: MangaBgTheme;
    swatch: string;
    fg: string;
    labelRu: string;
    labelEn: string;
}> = [
    { value: "dark", swatch: "#0e1014", fg: "#eef1f5", labelRu: "Тёмная", labelEn: "Dark" },
    { value: "black", swatch: "#000000", fg: "#eef1f5", labelRu: "Чёрная OLED", labelEn: "Black" },
    { value: "gray", swatch: "#1f242d", fg: "#eef1f5", labelRu: "Серая", labelEn: "Gray" },
    { value: "paper", swatch: "#ede9e0", fg: "#1f2328", labelRu: "Светлая", labelEn: "Light" },
];

type LookupMatch = { start: number; length: number };
type LookupTokenHandler = (
    token: string,
    sentence: string,
    cursor: number,
    boundaries?: number[],
    lemma?: string,
) => LookupMatch | null | void | Promise<LookupMatch | null | void>;

interface MangaReaderProps {
    tab?: Tab;
    tabId: number;
    mangaPath: string;
    meta: MangaMeta;
    initialPage: number;
    settings: AppSettings;
    language: AppLanguage;
    isMobile: boolean;
    lookupOpen?: boolean;
    escMenuOpen?: boolean;
    goals?: EpubReadingGoals;
    onBackToLibrary: () => void;
    onMetaUpdated: (meta: MangaMeta) => void;
    onProgressChange: (pageIndex: number, progress: number) => void;
    onChangeBookBookmarks?: (bookmarks: EpubBookmark[]) => void;
    onChangeBookNotes?: (notes: EpubBookNote[]) => void;
    onRecordReadingStats?: (deltaChars: number, deltaSeconds: number) => void;
    onOpenStats?: () => void;
    onLookupToken?: LookupTokenHandler;
    onAnkiScreenshot?: (dataUrl: string | null) => void;
    onCloseLookup?: () => void;
    onMobileImmersiveChange?: (immersive: boolean) => void;
    onOverlayStateChange?: (open: boolean) => void;
    closeOverlaySignal?: number;
    onOpenCatalogPicker?: () => void;
    onConvertMangaToCbz?: () => Promise<MangaExportResult | null>;
}

const IconBookmarkSvg = () => (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
    </svg>
);

async function renderMangaCropDataUrl(
    imageSrc: string,
    box: [number, number, number, number] | null,
    cropMode: MangaCropMode,
): Promise<string | null> {
    if (!imageSrc) return null;
    return new Promise((resolve) => {
        const img = new Image();
        img.onload = () => {
            try {
                const natW = img.naturalWidth || 1;
                const natH = img.naturalHeight || 1;
                const rect = cropMode === "bubble" && box
                    ? computeBubbleCropRect(box, natW, natH)
                    : { x: 0, y: 0, width: natW, height: natH };
                const maxSide = 1400;
                const scale = Math.min(1, maxSide / Math.max(rect.width, rect.height));
                const outW = Math.max(1, Math.round(rect.width * scale));
                const outH = Math.max(1, Math.round(rect.height * scale));
                const canvas = document.createElement("canvas");
                canvas.width = outW;
                canvas.height = outH;
                const ctx = canvas.getContext("2d");
                if (!ctx) {
                    resolve(null);
                    return;
                }
                ctx.drawImage(img, rect.x, rect.y, rect.width, rect.height, 0, 0, outW, outH);
                resolve(canvas.toDataURL("image/jpeg", 0.86));
            } catch {
                resolve(null);
            }
        };
        img.onerror = () => resolve(null);
        img.src = imageSrc;
    });
}

async function cropExactRegionBase64(
    imageSrc: string,
    box: [number, number, number, number],
    maxSide = 768,
): Promise<string | null> {
    if (!imageSrc) return null;
    return new Promise((resolve) => {
        const img = new Image();
        img.onload = () => {
            try {
                const natW = img.naturalWidth || 1;
                const natH = img.naturalHeight || 1;
                const x1 = Math.max(0, Math.min(natW - 1, Math.floor(box[0])));
                const y1 = Math.max(0, Math.min(natH - 1, Math.floor(box[1])));
                const x2 = Math.max(x1 + 1, Math.min(natW, Math.ceil(box[2])));
                const y2 = Math.max(y1 + 1, Math.min(natH, Math.ceil(box[3])));
                const rw = Math.max(1, x2 - x1);
                const rh = Math.max(1, y2 - y1);
                const scale = Math.min(1, maxSide / Math.max(rw, rh));
                const outW = Math.max(1, Math.round(rw * scale));
                const outH = Math.max(1, Math.round(rh * scale));
                const canvas = document.createElement("canvas");
                canvas.width = outW;
                canvas.height = outH;
                const ctx = canvas.getContext("2d");
                if (!ctx) {
                    resolve(null);
                    return;
                }
                ctx.fillStyle = "#ffffff";
                ctx.fillRect(0, 0, outW, outH);
                ctx.drawImage(img, x1, y1, rw, rh, 0, 0, outW, outH);
                const dataUrl = canvas.toDataURL("image/jpeg", 0.92);
                const comma = dataUrl.indexOf(",");
                resolve(comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl);
            } catch {
                resolve(null);
            }
        };
        img.onerror = () => resolve(null);
        img.src = imageSrc;
    });
}

async function imageToScaledBase64(
    imageSrc: string,
    maxSide = 1600,
): Promise<{ base64: string; scaleX: number; scaleY: number } | null> {
    if (!imageSrc) return null;
    return new Promise((resolve) => {
        const img = new Image();
        img.onload = () => {
            try {
                const natW = img.naturalWidth || 1;
                const natH = img.naturalHeight || 1;
                const scale = Math.min(1, maxSide / Math.max(natW, natH));
                const outW = Math.max(1, Math.round(natW * scale));
                const outH = Math.max(1, Math.round(natH * scale));
                const canvas = document.createElement("canvas");
                canvas.width = outW;
                canvas.height = outH;
                const ctx = canvas.getContext("2d");
                if (!ctx) {
                    resolve(null);
                    return;
                }
                ctx.drawImage(img, 0, 0, outW, outH);
                const dataUrl = canvas.toDataURL("image/jpeg", 0.9);
                const comma = dataUrl.indexOf(",");
                resolve({
                    base64: comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl,
                    scaleX: natW / outW,
                    scaleY: natH / outH,
                });
            } catch {
                resolve(null);
            }
        };
        img.onerror = () => resolve(null);
        img.src = imageSrc;
    });
}

function formatOcrEngineLabel(engine: string, device: string | null | undefined, isEn: boolean): string {
    if (engine === "pc-local" || engine === "remote-pc") {
        return device === "cuda" ? (isEn ? "PC ⚡ GPU" : "ПК ⚡ GPU") : (isEn ? "PC OCR" : "ПК OCR");
    }
    if (engine === "onnx") return "ONNX INT8";
    if (engine === "mlkit") return "ML Kit";
    return engine;
}

function clearMangaOverlaySelection() {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) return;
    const anchor = sel.anchorNode;
    const el = anchor instanceof Element ? anchor : anchor?.parentElement;
    if (el?.closest(".manga-overlay-layer")) {
        sel.removeAllRanges();
    }
}

export default function MangaReader({
    tab,
    tabId,
    mangaPath,
    meta,
    initialPage,
    settings,
    language,
    isMobile,
    lookupOpen = false,
    escMenuOpen = false,
    goals: externalGoals,
    onBackToLibrary,
    onMetaUpdated,
    onProgressChange,
    onChangeBookBookmarks,
    onChangeBookNotes,
    onRecordReadingStats,
    onOpenStats,
    onLookupToken,
    onAnkiScreenshot,
    onCloseLookup,
    onMobileImmersiveChange,
    onOverlayStateChange,
    closeOverlaySignal = 0,
    onOpenCatalogPicker,
    onConvertMangaToCbz,
}: MangaReaderProps) {
    const isEn = language === "en";
    const t = getTranslator(language);
    const displayTitle = (tab?.epub?.title || tab?.name || meta.title || "Manga").trim();
    const bookmarks = useMemo(() => tab?.epub?.bookmarks || [], [tab?.epub?.bookmarks]);
    const notes = useMemo(() => tab?.epub?.notes || [], [tab?.epub?.notes]);

    const [prefs, setPrefs] = useState<MangaReaderPrefs>(() => {
        const loaded = loadMangaPrefs();
        return isMobile && loaded.spreadMode === "spread"
            ? { ...loaded, spreadMode: "single" }
            : loaded;
    });
    const [currentPage, setCurrentPage] = useState(() =>
        Math.max(0, Math.min(Math.max(0, meta.pageCount - 1), initialPage)),
    );
    const [zoom, setZoom] = useState(1);

    // EPUB-parity UI panels & auto-hiding LiquidGlass chrome
    const [controlsOpen, setControlsOpen] = useState(false);
    const [drawerOpen, setDrawerOpen] = useState(false);
    const [drawerTab, setDrawerTab] = useState<"pages" | "bookmarks" | "notes">("pages");
    const [mokuroModalOpen, setMokuroModalOpen] = useState(false);
    const [chromeVisible, setChromeVisible] = useState(true);
    const [topHover, setTopHover] = useState(false);
    const [bottomHover, setBottomHover] = useState(false);
    const [edgeHover, setEdgeHover] = useState<"left" | "right" | null>(null);
    const [zenMode, setZenMode] = useState(false);
    const [positionFrozen, setPositionFrozen] = useState(false);
    const [trackingPaused, setTrackingPaused] = useState(false);
    const [lookupKeyHeld, setLookupKeyHeld] = useState(false);
    const [pageJumpEditing, setPageJumpEditing] = useState(false);
    const [pageJumpInput, setPageJumpInput] = useState("");
    const [bookmarkLabelInput, setBookmarkLabelInput] = useState("");
    const [editingBookmarkId, setEditingBookmarkId] = useState<string | null>(null);
    const [editingBookmarkLabel, setEditingBookmarkLabel] = useState("");
    const [noteTitleInput, setNoteTitleInput] = useState("");
    const [noteBodyInput, setNoteBodyInput] = useState("");

    const [pagesByIndex, setPagesByIndex] = useState<Record<number, MangaPagePayload>>({});
    const [pageErrors, setPageErrors] = useState<Record<number, string>>({});
    const [cacheEpoch, setCacheEpoch] = useState(0);
    const [overrides, setOverrides] = useState<Record<number, Record<number, string>>>({});
    const [activeBubble, setActiveBubble] = useState<{ pageIndex: number; blockIndex: number } | null>(null);
    const [editingBubble, setEditingBubble] = useState<{
        pageIndex: number;
        blockIndex: number;
        text: string;
    } | null>(null);

    // Mokuro CLI integration (Desktop)
    const [mokuroStatus, setMokuroStatus] = useState<MangaMokuroStatus | null>(null);
    const [mokuroRunning, setMokuroRunning] = useState(false);
    const [mokuroProgress, setMokuroProgress] = useState<{
        stage: string;
        device: "cuda" | "cpu" | null;
        current: number | null;
        total: number | null;
        percent: number | null;
        eta: string | null;
        line: string;
    } | null>(null);
    const [mokuroError, setMokuroError] = useState<string | null>(null);
    const [convertingCbz, setConvertingCbz] = useState(false);
    const [exportingCbz, setExportingCbz] = useState(false);
    const [exportStatus, setExportStatus] = useState<{ ok: boolean; message: string } | null>(null);

    // Interactive on-demand OCR crop tool & ML Kit mobile auto-scan
    const [cropToolActive, setCropToolActive] = useState(false);
    const [cropDrag, setCropDrag] = useState<{
        pageIndex: number;
        startX: number;
        startY: number;
        curX: number;
        curY: number;
    } | null>(null);
    const [ocrBusy, setOcrBusy] = useState<string | null>(null);
    const [ocrError, setOcrError] = useState<string | null>(null);
    const [ocrResult, setOcrResult] = useState<{
        pageIndex: number;
        box: [number, number, number, number];
        text: string;
        engine: string;
        device?: string | null;
        elapsedMs: number;
    } | null>(null);
    const [sessionBlocksByPage, setSessionBlocksByPage] = useState<Record<number, MokuroBlock[]>>({});
    const [mobileOcrReady, setMobileOcrReady] = useState<{
        onnxReady: boolean;
        onnxDownloading: boolean;
        hasRemote: boolean;
    } | null>(null);

    const stageRef = useRef<HTMLDivElement>(null);
    const viewportRef = useRef<HTMLDivElement>(null);
    const pageListRef = useRef<HTMLDivElement>(null);
    const topHideTimerRef = useRef<number | null>(null);
    const bottomHideTimerRef = useRef<number | null>(null);
    const lastPointerPosRef = useRef<{ x: number; y: number } | null>(null);
    const pageCacheRef = useRef<Map<number, MangaPagePayload>>(new Map());
    const loadingSetRef = useRef<Set<number>>(new Set());
    const cacheGenerationRef = useRef(0);
    const retryTimersRef = useRef<Map<number, number>>(new Map());
    const visiblePagesRef = useRef<number[]>([]);
    const highWaterPageRef = useRef<number>(initialPage);
    const pageEnteredAtRef = useRef<number>(Date.now());
    const lastActivityAtRef = useRef<number>(Date.now());
    const pendingSecondsRef = useRef(0);
    const positionFrozenRef = useRef(false);
    positionFrozenRef.current = positionFrozen;
    const onRecordStatsRef = useRef(onRecordReadingStats);
    onRecordStatsRef.current = onRecordReadingStats;
    const touchStartRef = useRef<{ x: number; y: number; time: number } | null>(null);
    const lastWheelPageRef = useRef(0);
    const scrubbingRef = useRef(false);

    const statsVersion = useDailyStatsVersion();
    const activeGoals = useMemo(() => externalGoals || loadEpubGoals(), [externalGoals, statsVersion]);
    const todayTotals = useMemo(
        () => sumDayForTabs(getDay(), new Set([String(tabId)])),
        [statsVersion, tabId],
    );
    const goalSummary = useMemo(
        () => evaluateGoalProgress(todayTotals.chars, todayTotals.seconds, activeGoals, trackingPaused || positionFrozen),
        [todayTotals.chars, todayTotals.seconds, activeGoals, trackingPaused, positionFrozen],
    );

    const resetPageCache = useCallback(() => {
        cacheGenerationRef.current += 1;
        for (const timer of retryTimersRef.current.values()) {
            window.clearTimeout(timer);
        }
        retryTimersRef.current.clear();
        pageCacheRef.current.clear();
        loadingSetRef.current.clear();
        setPagesByIndex({});
        setPageErrors({});
        setCacheEpoch((n) => n + 1);
    }, []);

    useEffect(() => () => {
        if (topHideTimerRef.current !== null) window.clearTimeout(topHideTimerRef.current);
        if (bottomHideTimerRef.current !== null) window.clearTimeout(bottomHideTimerRef.current);
        cacheGenerationRef.current += 1;
        for (const timer of retryTimersRef.current.values()) {
            window.clearTimeout(timer);
        }
        retryTimersRef.current.clear();
    }, []);

    // Once the dictionary popup closes, drop the pinned bubble.
    const prevLookupOpenRef = useRef(lookupOpen);
    useEffect(() => {
        if (prevLookupOpenRef.current && !lookupOpen) {
            setActiveBubble(null);
            clearMangaOverlaySelection();
        }
        prevLookupOpenRef.current = lookupOpen;
    }, [lookupOpen]);

    const updatePrefs = useCallback((patch: Partial<MangaReaderPrefs>) => {
        setPrefs((prev) => {
            const next = { ...prev, ...patch };
            saveMangaPrefs(next);
            return next;
        });
    }, []);

    // Reset caches when switching volume
    useEffect(() => {
        resetPageCache();
        const clamped = Math.max(0, Math.min(Math.max(0, meta.pageCount - 1), initialPage));
        setCurrentPage(clamped);
        highWaterPageRef.current = clamped;
        pageEnteredAtRef.current = Date.now();
        setActiveBubble(null);
        setEditingBubble(null);
        setSessionBlocksByPage({});
        setOcrResult(null);
        setOcrError(null);
        setCropToolActive(false);
        setPageJumpEditing(false);
        setZoom(1);
        clearMangaOverlaySelection();
        void loadMangaOverrides(mangaPath).then(setOverrides).catch(() => setOverrides({}));
    }, [tabId, mangaPath, resetPageCache]);

    useEffect(() => {
        setExportStatus(null);
    }, [tabId]);

    useEffect(() => {
        clearMangaOverlaySelection();
    }, [currentPage]);

    // Refresh page cache when mokuro overlay gets newly attached/generated
    const mokuroKey = `${meta.hasMokuro}|${meta.mokuroPath || ""}`;
    useEffect(() => {
        resetPageCache();
    }, [mokuroKey, resetPageCache]);

    // Sync mobile immersive bar visibility
    useEffect(() => {
        onMobileImmersiveChange?.(isMobile && !chromeVisible);
        return () => onMobileImmersiveChange?.(false);
    }, [isMobile, chromeVisible, onMobileImmersiveChange]);

    // Report overlays to Workspace (for Android Back handling)
    useEffect(() => {
        onOverlayStateChange?.(drawerOpen || controlsOpen || mokuroModalOpen || Boolean(editingBubble));
    }, [drawerOpen, controlsOpen, mokuroModalOpen, editingBubble, onOverlayStateChange]);

    useEffect(() => {
        if (!closeOverlaySignal) return;
        setDrawerOpen(false);
        setControlsOpen(false);
        if (!mokuroRunning) setMokuroModalOpen(false);
        setEditingBubble(null);
        setCropToolActive(false);
    }, [closeOverlaySignal, mokuroRunning]);

    useMobileBackHandler(
        isMobile
            && (Boolean(editingBubble)
                || (mokuroModalOpen && !mokuroRunning)
                || cropToolActive
                || Boolean(ocrResult)
                || pageJumpEditing
                || controlsOpen
                || drawerOpen),
        MOBILE_BACK_PRIORITY.READER_OVERLAY,
        () => {
            if (editingBubble) {
                setEditingBubble(null);
                return;
            }
            if (mokuroModalOpen && !mokuroRunning) {
                setMokuroModalOpen(false);
                return;
            }
            if (cropToolActive) {
                setCropToolActive(false);
                return;
            }
            if (ocrResult) {
                setOcrResult(null);
                return;
            }
            if (pageJumpEditing) {
                setPageJumpEditing(false);
                return;
            }
            if (controlsOpen) {
                setControlsOpen(false);
                return;
            }
            if (drawerOpen) {
                setDrawerOpen(false);
                return;
            }
            return false;
        },
    );

    // Android hardware volume-key paging
    useEffect(() => {
        if (!isMobile || settings.epubVolumeKeyPaging === false) return;
        setMobileVolumePagingEnabled(true);
        return () => setMobileVolumePagingEnabled(false);
    }, [isMobile, settings.epubVolumeKeyPaging]);

    // Track lookup hotkey state (e.g. Shift) so floating bars stay completely hidden during lookup
    useEffect(() => {
        if (isMobile) return;
        const hotkey = String(settings.lookupHotkey || "Shift");
        if (hotkey === "__disabled__") {
            setLookupKeyHeld(false);
            return;
        }
        const parts = hotkey.split("+").map((p) => p.trim()).filter(Boolean);
        const needShift = parts.some((p) => /^shift$/i.test(p));
        const needCtrl = parts.some((p) => /^(ctrl|control)$/i.test(p));
        const needAlt = parts.some((p) => /^alt$/i.test(p));
        const trigger = parts.find((p) => !/^(ctrl|control|alt|shift)$/i.test(p)) || "";
        const norm = (c: string) => c.toLowerCase().replace(/^key/, "").replace(/^digit/, "");
        let triggerDown = false;

        const isActiveFor = (ev: KeyboardEvent) =>
            ev.shiftKey === needShift
            && ev.ctrlKey === needCtrl
            && ev.altKey === needAlt
            && (!trigger || triggerDown);

        const onKeyDown = (ev: KeyboardEvent) => {
            if (trigger && norm(ev.code) === norm(trigger)) triggerDown = true;
            if (isActiveFor(ev)) setLookupKeyHeld(true);
        };
        const onKeyUp = (ev: KeyboardEvent) => {
            if (trigger && norm(ev.code) === norm(trigger)) triggerDown = false;
            if (!isActiveFor(ev)) setLookupKeyHeld(false);
        };
        const onBlur = () => {
            triggerDown = false;
            setLookupKeyHeld(false);
        };

        window.addEventListener("keydown", onKeyDown, { capture: true });
        window.addEventListener("keyup", onKeyUp, { capture: true });
        window.addEventListener("blur", onBlur);
        return () => {
            window.removeEventListener("keydown", onKeyDown, { capture: true });
            window.removeEventListener("keyup", onKeyUp, { capture: true });
            window.removeEventListener("blur", onBlur);
        };
    }, [isMobile, settings.lookupHotkey]);

    const lookupActive = Boolean(lookupOpen) || lookupKeyHeld;

    const evaluateHoverZones = useCallback((clientX: number, clientY: number, suppressChrome: boolean) => {
        const stage = stageRef.current;
        if (!stage) return;
        const rect = stage.getBoundingClientRect();
        const relY = clientY - rect.top;
        const relX = clientX - rect.left;
        const insideStage = relX >= 0 && relX <= rect.width && relY >= 0 && relY <= rect.height;
        const nearTop = insideStage && relY <= CHROME_TOP_ZONE_PX;
        const nearBottom = insideStage && relY >= rect.height - CHROME_BOTTOM_ZONE_PX;

        if (nearTop) {
            if (topHideTimerRef.current !== null) {
                window.clearTimeout(topHideTimerRef.current);
                topHideTimerRef.current = null;
            }
            setTopHover(true);
        } else if (topHover && topHideTimerRef.current === null) {
            topHideTimerRef.current = window.setTimeout(() => {
                topHideTimerRef.current = null;
                setTopHover(false);
            }, CHROME_HIDE_DELAY_MS);
        }

        if (nearBottom) {
            if (bottomHideTimerRef.current !== null) {
                window.clearTimeout(bottomHideTimerRef.current);
                bottomHideTimerRef.current = null;
            }
            setBottomHover(true);
        } else if (bottomHover && bottomHideTimerRef.current === null) {
            bottomHideTimerRef.current = window.setTimeout(() => {
                bottomHideTimerRef.current = null;
                setBottomHover(false);
            }, CHROME_HIDE_DELAY_MS);
        }

        if (
            !suppressChrome
            && insideStage
            && prefs.spreadMode !== "webtoon"
            && !nearTop
            && !nearBottom
            && !drawerOpen
            && !controlsOpen
            && !cropToolActive
        ) {
            const edgePx = Math.min(EDGE_CLICK_MAX_PX, rect.width * EDGE_CLICK_RATIO);
            if (relX <= edgePx) {
                setEdgeHover((prev) => (prev === "left" ? prev : "left"));
            } else if (relX >= rect.width - edgePx) {
                setEdgeHover((prev) => (prev === "right" ? prev : "right"));
            } else if (edgeHover !== null) {
                setEdgeHover(null);
            }
        } else if (edgeHover !== null) {
            setEdgeHover(null);
        }
    }, [topHover, bottomHover, prefs.spreadMode, drawerOpen, controlsOpen, cropToolActive, edgeHover]);

    useEffect(() => {
        if (isMobile || lookupActive || escMenuOpen) return;
        const pos = lastPointerPosRef.current;
        if (pos) {
            evaluateHoverZones(pos.x, pos.y, false);
        }
    }, [isMobile, lookupActive, escMenuOpen, evaluateHoverZones]);

    const handleStageMouseMove = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
        if (isMobile) return;
        lastPointerPosRef.current = { x: event.clientX, y: event.clientY };
        const hotkey = String(settings.lookupHotkey || "Shift");
        const parts = hotkey.split("+").map((p) => p.trim()).filter(Boolean);
        const modLookup = hotkey !== "__disabled__"
            && !parts.some((p) => !/^(ctrl|control|alt|shift)$/i.test(p))
            && event.shiftKey === parts.some((p) => /^shift$/i.test(p))
            && event.ctrlKey === parts.some((p) => /^(ctrl|control)$/i.test(p))
            && event.altKey === parts.some((p) => /^alt$/i.test(p));
        if (modLookup !== lookupKeyHeld && !parts.some((p) => !/^(ctrl|control|alt|shift)$/i.test(p))) {
            setLookupKeyHeld(modLookup);
        }
        evaluateHoverZones(event.clientX, event.clientY, Boolean(lookupOpen) || modLookup || escMenuOpen);
    }, [isMobile, settings.lookupHotkey, lookupKeyHeld, lookupOpen, escMenuOpen, evaluateHoverZones]);

    const handleStageMouseLeave = useCallback(() => {
        if (isMobile) return;
        lastPointerPosRef.current = null;
        setEdgeHover(null);
        if (topHideTimerRef.current !== null) window.clearTimeout(topHideTimerRef.current);
        if (bottomHideTimerRef.current !== null) window.clearTimeout(bottomHideTimerRef.current);
        topHideTimerRef.current = window.setTimeout(() => {
            topHideTimerRef.current = null;
            setTopHover(false);
        }, CHROME_HIDE_DELAY_MS);
        bottomHideTimerRef.current = window.setTimeout(() => {
            bottomHideTimerRef.current = null;
            setBottomHover(false);
        }, CHROME_HIDE_DELAY_MS);
    }, [isMobile]);

    const topChromeVisible =
        !zenMode
        && !lookupActive
        && !escMenuOpen
        && ((isMobile && chromeVisible) || topHover || drawerOpen || controlsOpen || cropToolActive);
    const bottomChromeVisible =
        !zenMode
        && !lookupActive
        && !escMenuOpen
        && ((isMobile && chromeVisible) || bottomHover || pageJumpEditing || positionFrozen);

    // Smart reading timer with lookup-aware idle auto-pause
    useEffect(() => {
        const markActive = () => {
            lastActivityAtRef.current = Date.now();
        };
        window.addEventListener("pointerdown", markActive, { passive: true });
        window.addEventListener("keydown", markActive, { passive: true });
        window.addEventListener("wheel", markActive, { passive: true });
        return () => {
            window.removeEventListener("pointerdown", markActive);
            window.removeEventListener("keydown", markActive);
            window.removeEventListener("wheel", markActive);
        };
    }, []);

    useEffect(() => {
        if (lookupOpen) {
            lastActivityAtRef.current = Date.now();
        }
    }, [lookupOpen]);

    useEffect(() => {
        if (trackingPaused || positionFrozen || escMenuOpen || mokuroModalOpen || Boolean(editingBubble)) {
            return;
        }
        const idleLimitMs = Math.max(15, activeGoals.idlePauseSeconds || 60) * 1000;
        const interval = window.setInterval(() => {
            if (document.hidden) return;
            const idleMs = Date.now() - lastActivityAtRef.current;
            if (!lookupOpen && idleMs > idleLimitMs) return;
            pendingSecondsRef.current += 1;
            if (pendingSecondsRef.current >= 5) {
                const secs = pendingSecondsRef.current;
                pendingSecondsRef.current = 0;
                onRecordStatsRef.current?.(0, secs);
            }
        }, 1000);
        return () => {
            window.clearInterval(interval);
            if (pendingSecondsRef.current > 0) {
                const secs = pendingSecondsRef.current;
                pendingSecondsRef.current = 0;
                onRecordStatsRef.current?.(0, secs);
            }
        };
    }, [trackingPaused, positionFrozen, escMenuOpen, mokuroModalOpen, editingBubble, lookupOpen, activeGoals.idlePauseSeconds]);

    const spreadPairs = useMemo(
        () => buildSpreadPairs(meta.pageCount, isMobile && prefs.spreadMode === "spread" ? "single" : prefs.spreadMode, prefs.coverOffset),
        [meta.pageCount, prefs.spreadMode, prefs.coverOffset, isMobile],
    );

    const currentSpreadIdx = useMemo(
        () => findSpreadIndexForPage(spreadPairs, currentPage),
        [spreadPairs, currentPage],
    );

    const visiblePages = useMemo(() => {
        if (prefs.spreadMode === "webtoon") {
            const start = Math.max(0, currentPage - 1);
            const end = Math.min(meta.pageCount - 1, currentPage + 4);
            const list: number[] = [];
            for (let i = start; i <= end; i += 1) list.push(i);
            return list;
        }
        return spreadPairs[currentSpreadIdx] || [0];
    }, [prefs.spreadMode, spreadPairs, currentSpreadIdx, currentPage, meta.pageCount]);

    visiblePagesRef.current = visiblePages;

    const ensurePageLoaded = useCallback((pageIdx: number, retryAttempt = 0) => {
        if (pageIdx < 0 || pageIdx >= meta.pageCount) return;
        const cached = pageCacheRef.current.get(pageIdx);
        if (cached) {
            setPagesByIndex((prev) => (prev[pageIdx] === cached ? prev : { ...prev, [pageIdx]: cached }));
            return;
        }
        if (loadingSetRef.current.has(pageIdx)) return;

        const pendingRetry = retryTimersRef.current.get(pageIdx);
        if (pendingRetry !== undefined) {
            window.clearTimeout(pendingRetry);
            retryTimersRef.current.delete(pageIdx);
        }

        const gen = cacheGenerationRef.current;
        loadingSetRef.current.add(pageIdx);
        setPageErrors((prev) => {
            if (!(pageIdx in prev)) return prev;
            const next = { ...prev };
            delete next[pageIdx];
            return next;
        });

        void loadMangaPage(mangaPath, pageIdx)
            .then((payload) => {
                if (cacheGenerationRef.current !== gen) return;
                pageCacheRef.current.set(pageIdx, payload);
                const evicted: number[] = [];
                while (pageCacheRef.current.size > MAX_CACHED_PAGES) {
                    const oldest = pageCacheRef.current.keys().next().value;
                    if (typeof oldest === "number" && !visiblePagesRef.current.includes(oldest)) {
                        pageCacheRef.current.delete(oldest);
                        evicted.push(oldest);
                    } else {
                        break;
                    }
                }
                setPagesByIndex((prev) => {
                    const next = { ...prev, [pageIdx]: payload };
                    for (const key of evicted) delete next[key];
                    return next;
                });
                setPageErrors((prev) => {
                    if (!(pageIdx in prev)) return prev;
                    const next = { ...prev };
                    delete next[pageIdx];
                    return next;
                });
            })
            .catch((err) => {
                if (cacheGenerationRef.current !== gen) return;
                if (retryAttempt < 2 && visiblePagesRef.current.includes(pageIdx)) {
                    const delay = retryAttempt === 0 ? 250 : 650;
                    const timer = window.setTimeout(() => {
                        retryTimersRef.current.delete(pageIdx);
                        if (cacheGenerationRef.current === gen) {
                            ensurePageLoaded(pageIdx, retryAttempt + 1);
                        }
                    }, delay);
                    retryTimersRef.current.set(pageIdx, timer);
                    return;
                }
                if (visiblePagesRef.current.includes(pageIdx) || retryAttempt >= 2) {
                    setPageErrors((prev) => ({ ...prev, [pageIdx]: String(err) }));
                }
            })
            .finally(() => {
                if (cacheGenerationRef.current === gen) {
                    loadingSetRef.current.delete(pageIdx);
                }
            });
    }, [mangaPath, meta.pageCount]);

    // Load visible pages immediately, then prefetch neighbors after brief settle
    useEffect(() => {
        for (const idx of visiblePages) {
            ensurePageLoaded(idx);
        }
        const maxVisible = visiblePages[visiblePages.length - 1] ?? currentPage;
        const minVisible = visiblePages[0] ?? currentPage;
        const prefetchTargets = [maxVisible + 1, maxVisible + 2];
        if (minVisible > 0) prefetchTargets.push(minVisible - 1);

        const timer = window.setTimeout(() => {
            for (const idx of prefetchTargets) {
                if (!visiblePagesRef.current.includes(idx)) {
                    ensurePageLoaded(idx);
                }
            }
        }, 60);
        return () => window.clearTimeout(timer);
    }, [visiblePages, currentPage, cacheEpoch, ensurePageLoaded]);

    // Self-heal if visible page state is ever evicted or reset while remaining on the same page
    useEffect(() => {
        for (const idx of visiblePages) {
            if (!pagesByIndex[idx] && !pageErrors[idx]) {
                ensurePageLoaded(idx);
            }
        }
    }, [visiblePages, pagesByIndex, pageErrors, cacheEpoch, ensurePageLoaded]);

    // Report progress & monotonic reading stats
    useEffect(() => {
        const maxPage = Math.max(1, meta.pageCount - 1);
        const progress = meta.pageCount <= 1 ? 1 : Math.max(0, Math.min(1, currentPage / maxPage));
        lastActivityAtRef.current = Date.now();
        if (!positionFrozenRef.current) {
            onProgressChange(currentPage, progress);
        }

        if (!positionFrozenRef.current && !trackingPaused && currentPage > highWaterPageRef.current && onRecordReadingStats) {
            const elapsedSec = Math.max(1, Math.min(120, Math.round((Date.now() - pageEnteredAtRef.current) / 1000)));
            let deltaChars = 0;
            for (let p = highWaterPageRef.current; p < currentPage; p += 1) {
                deltaChars += meta.pages[p]?.charCount || 0;
            }
            highWaterPageRef.current = currentPage;
            if (deltaChars > 0 || elapsedSec >= 2) {
                onRecordReadingStats(deltaChars, elapsedSec);
            }
        }
        pageEnteredAtRef.current = Date.now();
    }, [currentPage, meta.pageCount, meta.pages, onProgressChange, onRecordReadingStats, trackingPaused]);

    // Scroll active page card into view when drawer opens on Pages tab
    useEffect(() => {
        if (!drawerOpen || drawerTab !== "pages") return;
        const timer = window.setTimeout(() => {
            pageListRef.current?.querySelector(".epub-toc-item.is-active")?.scrollIntoView({ block: "nearest" });
        }, 40);
        return () => window.clearTimeout(timer);
    }, [drawerOpen, drawerTab]);

    const jumpToPage = useCallback((pageIdx: number) => {
        setActiveBubble(null);
        setEditingBubble(null);
        setCurrentPage(Math.max(0, Math.min(Math.max(0, meta.pageCount - 1), pageIdx)));
    }, [meta.pageCount]);

    const goNext = useCallback(() => {
        setActiveBubble(null);
        setEditingBubble(null);
        if (prefs.spreadMode === "webtoon") {
            setCurrentPage((p) => Math.min(meta.pageCount - 1, p + 1));
            return;
        }
        const nextIdx = Math.min(spreadPairs.length - 1, currentSpreadIdx + 1);
        const target = spreadPairs[nextIdx]?.[0];
        if (typeof target === "number") setCurrentPage(target);
    }, [prefs.spreadMode, meta.pageCount, spreadPairs, currentSpreadIdx]);

    const goPrev = useCallback(() => {
        setActiveBubble(null);
        setEditingBubble(null);
        if (prefs.spreadMode === "webtoon") {
            setCurrentPage((p) => Math.max(0, p - 1));
            return;
        }
        const prevIdx = Math.max(0, currentSpreadIdx - 1);
        const target = spreadPairs[prevIdx]?.[0];
        if (typeof target === "number") setCurrentPage(target);
    }, [prefs.spreadMode, spreadPairs, currentSpreadIdx]);

    const getCurrentPageExcerpt = useCallback((): string => {
        const payload = pagesByIndex[currentPage];
        if (!payload) return "";
        const effective = applyBlockTextOverrides(payload.blocks, overrides[currentPage]);
        const joined = effective.map((b) => joinMokuroLines(b.lines)).filter(Boolean).join(" ").trim();
        return joined.length > 90 ? `${joined.slice(0, 90)}…` : joined;
    }, [pagesByIndex, currentPage, overrides]);

    const handleAddBookmark = useCallback(() => {
        if (!onChangeBookBookmarks) return;
        const customLabel = bookmarkLabelInput.trim();
        const pageLabel = isEn ? `Page ${currentPage + 1}` : `Стр. ${currentPage + 1}`;
        const nextBookmark: EpubBookmark = {
            id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
            label: customLabel || pageLabel,
            chapterIndex: currentPage,
            chapterTitle: pageLabel,
            paragraphIndex: 0,
            excerpt: getCurrentPageExcerpt(),
            createdAt: Date.now(),
        };
        onChangeBookBookmarks([nextBookmark, ...bookmarks]);
        setBookmarkLabelInput("");
    }, [onChangeBookBookmarks, bookmarkLabelInput, isEn, currentPage, getCurrentPageExcerpt, bookmarks]);

    const handleRenameBookmark = useCallback((id: string) => {
        if (!onChangeBookBookmarks) return;
        const nextLabel = editingBookmarkLabel.trim();
        if (nextLabel) {
            onChangeBookBookmarks(bookmarks.map((item) => (item.id === id ? { ...item, label: nextLabel } : item)));
        }
        setEditingBookmarkId(null);
        setEditingBookmarkLabel("");
    }, [onChangeBookBookmarks, editingBookmarkLabel, bookmarks]);

    const handleDeleteBookmark = useCallback((id: string) => {
        if (!onChangeBookBookmarks) return;
        onChangeBookBookmarks(bookmarks.filter((item) => item.id !== id));
    }, [onChangeBookBookmarks, bookmarks]);

    const handleAddBookNote = useCallback(() => {
        if (!onChangeBookNotes) return;
        const body = noteBodyInput.trim();
        const title = noteTitleInput.trim();
        if (!body && !title) return;
        const pageLabel = isEn ? `Page ${currentPage + 1}` : `Стр. ${currentPage + 1}`;
        const now = Date.now();
        const nextNote: EpubBookNote = {
            id: `note-${now}-${Math.random().toString(36).slice(2, 7)}`,
            title: title || pageLabel,
            body,
            chapterIndex: currentPage,
            chapterTitle: pageLabel,
            paragraphIndex: 0,
            createdAt: now,
            updatedAt: now,
        };
        onChangeBookNotes([nextNote, ...notes]);
        setNoteTitleInput("");
        setNoteBodyInput("");
    }, [onChangeBookNotes, noteBodyInput, noteTitleInput, isEn, currentPage, notes]);

    const handleDeleteBookNote = useCallback((id: string) => {
        if (!onChangeBookNotes) return;
        onChangeBookNotes(notes.filter((n) => n.id !== id));
    }, [onChangeBookNotes, notes]);

    // Listen for Android volume keys
    useEffect(() => {
        if (!isMobile || settings.epubVolumeKeyPaging === false) return;
        const onVolKey = (ev: Event) => {
            const dir = (ev as CustomEvent<string>).detail;
            if (dir === "next") goNext();
            else if (dir === "prev") goPrev();
        };
        window.addEventListener("setsuna-volume-key", onVolKey);
        return () => window.removeEventListener("setsuna-volume-key", onVolKey);
    }, [isMobile, settings.epubVolumeKeyPaging, goNext, goPrev]);

    // Keyboard navigation & shortcuts (harmonized with EpubReader)
    useEffect(() => {
        const onKeyDown = (event: KeyboardEvent) => {
            if (editingBubble) return;
            const target = event.target as HTMLElement | null;
            if (target && ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)) return;

            if (event.key === "Escape") {
                if (cropToolActive) {
                    event.preventDefault();
                    setCropToolActive(false);
                } else if (controlsOpen || drawerOpen) {
                    event.preventDefault();
                    setControlsOpen(false);
                    setDrawerOpen(false);
                } else if (ocrResult || ocrError) {
                    event.preventDefault();
                    setOcrResult(null);
                    setOcrError(null);
                }
                return;
            }
            if (escMenuOpen || mokuroModalOpen) return;

            if (event.key === "ArrowLeft") {
                event.preventDefault();
                if (prefs.rtl) goNext();
                else goPrev();
            } else if (event.key === "ArrowRight") {
                event.preventDefault();
                if (prefs.rtl) goPrev();
                else goNext();
            } else if (event.key === " " || event.key === "PageDown") {
                event.preventDefault();
                goNext();
            } else if (event.key === "PageUp") {
                event.preventDefault();
                goPrev();
            } else if (event.key === "Home") {
                event.preventDefault();
                jumpToPage(0);
            } else if (event.key === "End") {
                event.preventDefault();
                jumpToPage(Math.max(0, meta.pageCount - 1));
            } else if (!event.ctrlKey && !event.metaKey && !event.altKey) {
                if (event.code === "KeyO") {
                    const order: MangaOverlayMode[] = ["hover", "outline", "readable"];
                    const next = order[(order.indexOf(prefs.overlayMode) + 1) % order.length];
                    updatePrefs({ overlayMode: next });
                } else if (event.code === "KeyD" && !isMobile) {
                    updatePrefs({ spreadMode: prefs.spreadMode === "spread" ? "single" : "spread" });
                } else if (event.code === "KeyC") {
                    updatePrefs({ coverOffset: !prefs.coverOffset });
                } else if (event.code === "KeyS") {
                    setCropToolActive((v) => !v);
                } else if (event.code === "KeyZ") {
                    event.preventDefault();
                    setZenMode((prev) => !prev);
                } else if (event.code === "KeyE") {
                    event.preventDefault();
                    setPositionFrozen((prev) => !prev);
                } else if (event.code === "KeyP") {
                    event.preventDefault();
                    setTrackingPaused((prev) => !prev);
                } else if (event.code === "KeyB" && onChangeBookBookmarks) {
                    event.preventDefault();
                    if (event.shiftKey) {
                        handleAddBookmark();
                    } else {
                        setControlsOpen(false);
                        setDrawerTab("bookmarks");
                        setDrawerOpen(true);
                    }
                } else if (event.key === "=" || event.key === "+") {
                    setZoom((z) => Math.min(3, Number((z + 0.15).toFixed(2))));
                } else if (event.key === "-") {
                    setZoom((z) => Math.max(0.5, Number((z - 0.15).toFixed(2))));
                } else if (event.key === "0") {
                    setZoom(1);
                }
            }
        };
        window.addEventListener("keydown", onKeyDown);
        return () => window.removeEventListener("keydown", onKeyDown);
    }, [
        editingBubble,
        cropToolActive,
        controlsOpen,
        drawerOpen,
        ocrResult,
        ocrError,
        escMenuOpen,
        mokuroModalOpen,
        prefs.rtl,
        prefs.overlayMode,
        prefs.spreadMode,
        prefs.coverOffset,
        isMobile,
        meta.pageCount,
        goNext,
        goPrev,
        jumpToPage,
        updatePrefs,
        onChangeBookBookmarks,
        handleAddBookmark,
    ]);

    // Check mokuro CLI availability when opening the OCR modal
    useEffect(() => {
        if (!mokuroModalOpen) {
            setExportStatus(null);
            return;
        }
        if (!isMobile) {
            void checkMokuroStatus().then(setMokuroStatus).catch(() => {});
        } else {
            const p = loadMangaOcrPrefs();
            const hasRemote = normalizeOcrServerUrl(p.remoteUrl).length > 0;
            void getAndroidMangaOcrStatus()
                .then((st) =>
                    setMobileOcrReady({
                        onnxReady: st.onnxReady,
                        onnxDownloading: st.onnxDownloading,
                        hasRemote,
                    }),
                )
                .catch(() => setMobileOcrReady({ onnxReady: false, onnxDownloading: false, hasRemote }));
        }
    }, [mokuroModalOpen, isMobile]);

    // Listen to mokuro CLI progress events
    useEffect(() => {
        if (isMobile) return;
        let unlisten: (() => void) | null = null;
        void listen<{
            path: string;
            status?: string;
            stage?: string;
            device?: "cuda" | "cpu" | null;
            current?: number | null;
            total?: number | null;
            percent?: number | null;
            eta?: string | null;
            line?: string;
        }>("manga_mokuro_progress", (event) => {
            const p = event.payload;
            if (!p || p.path !== mangaPath) return;
            setMokuroProgress((prev) => ({
                stage: p.stage || prev?.stage || "running",
                device: p.device ?? prev?.device ?? null,
                current: typeof p.current === "number" ? p.current : (prev?.current ?? null),
                total: typeof p.total === "number" ? p.total : (prev?.total ?? null),
                percent: typeof p.percent === "number" ? p.percent : (prev?.percent ?? null),
                eta: p.eta ?? prev?.eta ?? null,
                line: p.line || prev?.line || "",
            }));
        }).then((fn) => {
            unlisten = fn;
        });
        return () => {
            unlisten?.();
        };
    }, [mangaPath, isMobile]);

    const prepareAnkiPanelCrop = useCallback(
        (page: MangaPagePayload, block: MokuroBlock) => {
            if (!onAnkiScreenshot) return;
            void renderMangaCropDataUrl(page.imageSrc, block.box, prefs.cropMode).then((dataUrl) => {
                if (dataUrl) onAnkiScreenshot(dataUrl);
            });
        },
        [onAnkiScreenshot, prefs.cropMode],
    );

    useEffect(() => {
        return () => {
            onAnkiScreenshot?.(null);
        };
    }, [onAnkiScreenshot]);

    const handleAttachMokuroFile = useCallback(async () => {
        try {
            const selected = await open({
                multiple: false,
                directory: false,
                filters: [{ name: "Mokuro OCR (.mokuro)", extensions: ["mokuro", "gz"] }],
            });
            const mpath = typeof selected === "string" ? selected.trim() : "";
            if (!mpath) return;
            setMokuroError(null);
            const updated = await attachMokuroOverlay(mangaPath, mpath);
            onMetaUpdated(updated);
            setMokuroModalOpen(false);
        } catch (error) {
            setMokuroError(String(error));
        }
    }, [mangaPath, onMetaUpdated]);

    const handleRunMokuroCli = useCallback(async () => {
        if (mokuroRunning) return;
        setMokuroRunning(true);
        setMokuroError(null);
        setMokuroProgress({
            stage: "starting",
            device: null,
            current: null,
            total: meta.pageCount,
            percent: null,
            eta: null,
            line: "",
        });
        try {
            const updated = await runMokuroOnVolume(mangaPath);
            onMetaUpdated(updated);
            setMokuroModalOpen(false);
        } catch (error) {
            setMokuroError(String(error));
        } finally {
            setMokuroRunning(false);
        }
    }, [mokuroRunning, mangaPath, meta.pageCount, onMetaUpdated]);

    const handleConvertInPlaceCbz = useCallback(async () => {
        if (!onConvertMangaToCbz || convertingCbz || exportingCbz) return;
        setConvertingCbz(true);
        setExportStatus(null);
        try {
            const res = await onConvertMangaToCbz();
            if (!res) {
                setExportStatus({
                    ok: false,
                    message: isEn
                        ? "Could not resolve manga path for conversion."
                        : "Не удалось определить путь к файлу манги.",
                });
                return;
            }
            const mb = (res.bytes / (1024 * 1024)).toFixed(1);
            setExportStatus({
                ok: true,
                message: isEn
                    ? `Converted in place to .cbz (${res.pageCount} p., ${mb} MB)${res.hasMokuro ? " · .mokuro embedded" : ""} · ready for Drive sync.`
                    : `Преобразовано в CBZ на ПК (${res.pageCount} стр., ${mb} МБ)${res.hasMokuro ? " · .mokuro встроен" : ""} · готово к синхронизации на телефон.`,
            });
        } catch (error) {
            setExportStatus({
                ok: false,
                message: String(error),
            });
        } finally {
            setConvertingCbz(false);
        }
    }, [onConvertMangaToCbz, convertingCbz, exportingCbz, isEn]);

    const handleExportMobileCbz = useCallback(async () => {
        if (exportingCbz) return;
        try {
            const safeTitle = (displayTitle || "manga").replace(/[\\/:*?"<>|]/g, "_").trim() || "manga";
            const outputPath = await save({
                defaultPath: `${safeTitle}.cbz`,
                filters: [{ name: "Comic Book Archive (.cbz)", extensions: ["cbz"] }],
            });
            const target = typeof outputPath === "string" ? outputPath.trim() : "";
            if (!target) return;
            setExportingCbz(true);
            setExportStatus(null);
            const res = await exportMangaMobileCbz(mangaPath, target);
            const mb = (res.bytes / (1024 * 1024)).toFixed(1);
            setExportStatus({
                ok: true,
                message: isEn
                    ? `Packed ${res.pageCount} pages (${mb} MB)${res.hasMokuro ? " with .mokuro OCR embedded" : " (images only)"}.`
                    : `Упаковано ${res.pageCount} стр. (${mb} МБ)${res.hasMokuro ? " · слой .mokuro встроен" : " · только картинки"}.`,
            });
        } catch (error) {
            setExportStatus({
                ok: false,
                message: String(error),
            });
        } finally {
            setExportingCbz(false);
        }
    }, [exportingCbz, displayTitle, mangaPath, isEn]);

    const handleRunBubbleCropOcr = useCallback(
        async (page: MangaPagePayload, box: [number, number, number, number]) => {
            setCropToolActive(false);
            setOcrError(null);
            setOcrResult(null);
            setOcrBusy(isEn ? "Recognizing bubble…" : "Распознавание бабла…");
            prepareAnkiPanelCrop(page, {
                box,
                vertical: (box[3] - box[1]) > (box[2] - box[0]) * 1.1,
                fontSize: 32,
                lines: [],
            });
            try {
                const base64 = await cropExactRegionBase64(page.imageSrc, box, 768);
                if (!base64) throw new Error(isEn ? "Failed to crop image region." : "Не удалось вырезать область.");
                const res = await recognizeMangaCrop(base64, loadMangaOcrPrefs(), isMobile);
                setOcrResult({
                    pageIndex: page.index,
                    box,
                    text: res.text.trim(),
                    engine: res.engine,
                    device: res.device,
                    elapsedMs: res.elapsedMs,
                });
            } catch (error) {
                setOcrError(error instanceof Error ? error.message : String(error));
            } finally {
                setOcrBusy(null);
            }
        },
        [isEn, isMobile, prepareAnkiPanelCrop],
    );

    const handleAutoScanPage = useCallback(async () => {
        const page = pagesByIndex[currentPage];
        if (!page || !hasAndroidMangaOcrBridge()) return;
        setMokuroModalOpen(false);
        setOcrError(null);
        setOcrResult(null);
        setOcrBusy(isEn ? "Scanning page with ML Kit…" : "Поиск баблов на странице (ML Kit)…");
        try {
            const scaled = await imageToScaledBase64(page.imageSrc, 1600);
            if (!scaled) throw new Error("Failed to prepare page image.");
            const detected = await detectAndroidPageBlocksMlKit(scaled.base64);
            if (!detected.blocks || detected.blocks.length === 0) {
                setOcrError(isEn ? "No Japanese text detected on this page." : "Текст на этой странице не найден.");
                return;
            }
            const ocrPrefs = loadMangaOcrPrefs();
            const status = await getAndroidMangaOcrStatus().catch(() => ({
                onnxReady: false,
                onnxDownloading: false,
                onnxSizeBytes: 0,
                mlkitReady: true,
            }));
            const canRefine = ocrPrefs.autoRefineMlKitWithOnnx &&
                (status.onnxReady || normalizeOcrServerUrl(ocrPrefs.remoteUrl).length > 0 || ocrPrefs.mobileEngine === "remote" || ocrPrefs.mobileEngine === "onnx");

            const capped = detected.blocks.slice(0, 24);
            const built: MokuroBlock[] = [];
            for (let i = 0; i < capped.length; i += 1) {
                const blk = capped[i];
                const natBox: [number, number, number, number] = [
                    Math.round(blk.box[0] * scaled.scaleX),
                    Math.round(blk.box[1] * scaled.scaleY),
                    Math.round(blk.box[2] * scaled.scaleX),
                    Math.round(blk.box[3] * scaled.scaleY),
                ];
                let text = blk.text;
                if (canRefine) {
                    setOcrBusy(
                        isEn
                            ? `Refining bubble ${i + 1} / ${capped.length}…`
                            : `Уточнение бабла ${i + 1} / ${capped.length}…`,
                    );
                    const cropB64 = await cropExactRegionBase64(page.imageSrc, natBox, 512);
                    if (cropB64) {
                        const refined = await recognizeMangaCrop(cropB64, ocrPrefs, true).catch(() => null);
                        if (refined?.text?.trim()) text = refined.text.trim();
                    }
                }
                const bw = Math.max(12, natBox[2] - natBox[0]);
                const bh = Math.max(12, natBox[3] - natBox[1]);
                built.push({
                    box: natBox,
                    vertical: blk.vertical,
                    fontSize: Math.max(20, Math.min(48, Math.round((blk.vertical ? bw : bh) * 0.48))),
                    lines: [text],
                });
            }
            setSessionBlocksByPage((prev) => ({
                ...prev,
                [currentPage]: built,
            }));
        } catch (error) {
            setOcrError(error instanceof Error ? error.message : String(error));
        } finally {
            setOcrBusy(null);
        }
    }, [pagesByIndex, currentPage, isEn]);

    const handlePinOcrResultAsBubble = useCallback(() => {
        if (!ocrResult || !ocrResult.text.trim()) return;
        const { pageIndex, box, text } = ocrResult;
        const bw = Math.max(12, box[2] - box[0]);
        const bh = Math.max(12, box[3] - box[1]);
        const vertical = bh > bw * 1.1;
        const newBlock: MokuroBlock = {
            box,
            vertical,
            fontSize: Math.max(22, Math.min(48, Math.round((vertical ? bw : bh) * 0.48))),
            lines: text.split(/\r?\n/).map((s) => s.trim()).filter(Boolean),
        };
        setSessionBlocksByPage((prev) => ({
            ...prev,
            [pageIndex]: [...(prev[pageIndex] || []), newBlock],
        }));
        setOcrResult(null);
    }, [ocrResult]);

    const handleSaveBubbleEdit = useCallback(async () => {
        if (!editingBubble) return;
        const { pageIndex, blockIndex, text } = editingBubble;
        if (pageIndex < 0) {
            setOcrResult((prev) => (prev ? { ...prev, text } : prev));
            setEditingBubble(null);
            return;
        }
        const payload = pagesByIndex[pageIndex];
        const baseCount = payload?.blocks?.length ?? 0;
        if (blockIndex >= baseCount) {
            const localIdx = blockIndex - baseCount;
            setSessionBlocksByPage((prev) => {
                const arr = [...(prev[pageIndex] || [])];
                if (arr[localIdx]) {
                    const lines = text.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
                    arr[localIdx] = { ...arr[localIdx], lines: lines.length > 0 ? lines : [text] };
                }
                return { ...prev, [pageIndex]: arr };
            });
            setEditingBubble(null);
            return;
        }
        try {
            await saveMangaOverride(mangaPath, pageIndex, blockIndex, text);
            setOverrides((prev) => {
                const pageMap = { ...(prev[pageIndex] || {}) };
                if (text.trim()) pageMap[blockIndex] = text.trim();
                else delete pageMap[blockIndex];
                return { ...prev, [pageIndex]: pageMap };
            });
            setEditingBubble(null);
        } catch {
            // Keep open on error
        }
    }, [editingBubble, mangaPath, pagesByIndex]);

    const handleWheel = useCallback((event: ReactWheelEvent<HTMLDivElement>) => {
        if (event.ctrlKey) {
            event.preventDefault();
            const delta = event.deltaY < 0 ? 0.12 : -0.12;
            setZoom((z) => Math.max(0.5, Math.min(3, Number((z + delta).toFixed(2)))));
            return;
        }
        if (prefs.spreadMode === "webtoon" || zoom > 1.02) return;
        const vp = viewportRef.current;
        if (vp && vp.scrollHeight > vp.clientHeight + 4) return;
        if (Math.abs(event.deltaY) >= 8) {
            const now = Date.now();
            if (now - lastWheelPageRef.current < WHEEL_PAGE_COOLDOWN_MS) return;
            lastWheelPageRef.current = now;
            if (event.deltaY > 0) goNext();
            else goPrev();
        }
    }, [prefs.spreadMode, zoom, goNext, goPrev]);

    const handleTouchStart = useCallback((event: ReactTouchEvent<HTMLDivElement>) => {
        if (event.touches.length !== 1) return;
        const touch = event.touches[0];
        touchStartRef.current = { x: touch.clientX, y: touch.clientY, time: Date.now() };
    }, []);

    const handleTouchEnd = useCallback((event: ReactTouchEvent<HTMLDivElement>) => {
        const start = touchStartRef.current;
        touchStartRef.current = null;
        if (!start || event.changedTouches.length !== 1 || zoom > 1.05 || prefs.spreadMode === "webtoon") return;
        const touch = event.changedTouches[0];
        const dx = touch.clientX - start.x;
        const dy = touch.clientY - start.y;
        const dt = Date.now() - start.time;
        if (dt < 450 && Math.abs(dx) > 48 && Math.abs(dx) > Math.abs(dy) * 1.35) {
            if (dx > 0) {
                if (prefs.rtl) goNext();
                else goPrev();
            } else {
                if (prefs.rtl) goPrev();
                else goNext();
            }
        }
    }, [zoom, prefs.spreadMode, prefs.rtl, goNext, goPrev]);

    const handleStageClick = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
        const target = event.target as HTMLElement | null;
        if (target?.closest(".manga-bubble, .manga-bubble-edit-btn, .epub-glass-pill, .epub-appearance-popover, .epub-toc-drawer, .manga-modal, .manga-ocr-result-bar, button, input, textarea")) {
            return;
        }
        setActiveBubble(null);
        clearMangaOverlaySelection();
        if (lookupOpen) {
            onCloseLookup?.();
            return;
        }
        if (controlsOpen || drawerOpen) {
            setControlsOpen(false);
            setDrawerOpen(false);
            return;
        }
        if (pageJumpEditing) {
            setPageJumpEditing(false);
            return;
        }
        if (prefs.spreadMode === "webtoon") {
            if (isMobile) setChromeVisible((v) => !v);
            return;
        }
        const rect = event.currentTarget.getBoundingClientRect();
        const relX = (event.clientX - rect.left) / Math.max(1, rect.width);
        if (relX < 0.28) {
            if (prefs.rtl) goNext();
            else goPrev();
        } else if (relX > 0.72) {
            if (prefs.rtl) goPrev();
            else goNext();
        } else if (isMobile) {
            setChromeVisible((v) => !v);
        }
    }, [lookupOpen, onCloseLookup, controlsOpen, drawerOpen, pageJumpEditing, prefs.spreadMode, prefs.rtl, isMobile, goNext, goPrev]);

    const scrubToClientX = useCallback((el: HTMLDivElement, clientX: number) => {
        const rect = el.getBoundingClientRect();
        const rawRatio = Math.max(0, Math.min(1, (clientX - rect.left) / Math.max(1, rect.width)));
        const logicalRatio = prefs.rtl ? 1 - rawRatio : rawRatio;
        const target = Math.round(logicalRatio * Math.max(0, meta.pageCount - 1));
        jumpToPage(target);
    }, [prefs.rtl, meta.pageCount, jumpToPage]);

    const handleScrubPointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
        event.stopPropagation();
        scrubbingRef.current = true;
        event.currentTarget.setPointerCapture(event.pointerId);
        scrubToClientX(event.currentTarget, event.clientX);
    }, [scrubToClientX]);

    const handleScrubPointerMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
        if (!scrubbingRef.current) return;
        scrubToClientX(event.currentTarget, event.clientX);
    }, [scrubToClientX]);

    const handleScrubPointerUp = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
        if (!scrubbingRef.current) return;
        scrubbingRef.current = false;
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            event.currentTarget.releasePointerCapture(event.pointerId);
        }
    }, []);

    const orderedDisplayPages = useMemo(() => {
        if (prefs.spreadMode === "spread" && prefs.rtl && visiblePages.length === 2) {
            return [visiblePages[1], visiblePages[0]];
        }
        return visiblePages;
    }, [prefs.spreadMode, prefs.rtl, visiblePages]);

    const pct = meta.pageCount <= 1 ? 100 : Math.round((currentPage / (meta.pageCount - 1)) * 100);
    const pageSpanLabel = prefs.spreadMode === "spread" && visiblePages.length === 2
        ? `${visiblePages[0] + 1}–${visiblePages[1] + 1}`
        : `${currentPage + 1}`;
    const hasLeftAction = prefs.rtl ? currentPage < meta.pageCount - 1 : currentPage > 0;
    const hasRightAction = prefs.rtl ? currentPage > 0 : currentPage < meta.pageCount - 1;

    const renderPageCard = (pageIdx: number) => {
        const payload = pagesByIndex[pageIdx];
        if (!payload) {
            const pageErr = pageErrors[pageIdx];
            return (
                <div key={pageIdx} className="manga-page-placeholder">
                    <span>
                        {pageErr
                            ? (isEn ? `Failed to load page ${pageIdx + 1}` : `Не удалось загрузить стр. ${pageIdx + 1}`)
                            : (isEn ? `Loading page ${pageIdx + 1}…` : `Загрузка стр. ${pageIdx + 1}…`)}
                    </span>
                    {pageErr && (
                        <button
                            type="button"
                            className="epub-glass-btn"
                            style={{ marginTop: 8 }}
                            onClick={() => {
                                setPageErrors((prev) => {
                                    const next = { ...prev };
                                    delete next[pageIdx];
                                    return next;
                                });
                                ensurePageLoaded(pageIdx, 0);
                            }}
                        >
                            {isEn ? "Retry" : "Повторить"}
                        </button>
                    )}
                </div>
            );
        }

        const effectiveBlocks = applyBlockTextOverrides(payload.blocks, overrides[pageIdx]);
        const extraBlocks = sessionBlocksByPage[pageIdx] || [];
        const renderBlocks = extraBlocks.length > 0 ? [...effectiveBlocks, ...extraBlocks] : effectiveBlocks;
        const natW = payload.width || 1000;
        const natH = payload.height || 1400;
        const activeCrop = cropDrag && cropDrag.pageIndex === pageIdx ? cropDrag : null;

        return (
            <div
                key={pageIdx}
                className={`manga-page-frame fit-${prefs.fitMode}${prefs.dimBackground ? " is-dimmed" : ""}`}
                style={{
                    aspectRatio: `${natW} / ${natH}`,
                    ...(zoom !== 1 ? { transform: `scale(${zoom})`, transformOrigin: "center top" } : {}),
                }}
            >
                <img
                    src={payload.imageSrc}
                    alt={`Page ${pageIdx + 1}`}
                    className="manga-page-img"
                    draggable={false}
                />
                {renderBlocks.length > 0 && (
                    <div
                        className={`manga-overlay-layer mode-${prefs.overlayMode}`}
                        style={{ ["--manga-font-scale" as string]: String(prefs.fontScale) } as CSSProperties}
                    >
                        {renderBlocks.map((block, bIdx) => {
                            const [x1, y1, x2, y2] = block.box;
                            const leftPct = (x1 / natW) * 100;
                            const topPct = (y1 / natH) * 100;
                            const widthPct = Math.max(1.5, ((x2 - x1) / natW) * 100);
                            const heightPct = Math.max(1.5, ((y2 - y1) / natH) * 100);
                            const sentence = joinMokuroLines(block.lines);
                            const displayLines = prepareBubbleDisplayLines(block.lines);
                            const paraGaps = detectBubbleParagraphGaps(block);
                            const isActive =
                                activeBubble?.pageIndex === pageIdx && activeBubble?.blockIndex === bIdx;
                            const fittedBasePx = computeFittedBubbleFontPx(block);
                            const fittedPx = fittedBasePx * prefs.fontScale;
                            const relFontCqw = Math.max(0.35, Math.min(12, (fittedPx / natW) * 100));
                            const baseLineHeight = computeBubbleLineHeight(block, fittedBasePx);
                            const effectiveLineHeight = Math.max(
                                1.2,
                                Number((baseLineHeight / Math.max(1, prefs.fontScale)).toFixed(2)),
                            );

                            return (
                                <div
                                    key={bIdx}
                                    className={`manga-bubble${block.vertical ? " is-vertical" : " is-horizontal"}${isActive ? " is-active" : ""}`}
                                    style={{
                                        left: `${leftPct}%`,
                                        top: `${topPct}%`,
                                        width: `${widthPct}%`,
                                        height: `${heightPct}%`,
                                        ["--bubble-w" as string]: `${widthPct}%`,
                                        ["--bubble-h" as string]: `${heightPct}%`,
                                        fontSize: `${relFontCqw}cqw`,
                                        lineHeight: String(effectiveLineHeight),
                                    }}
                                    onMouseEnter={() => {
                                        if (!isMobile) setActiveBubble({ pageIndex: pageIdx, blockIndex: bIdx });
                                        prepareAnkiPanelCrop(payload, block);
                                    }}
                                    onMouseLeave={() => {
                                        if (isMobile || lookupOpen) return;
                                        clearMangaOverlaySelection();
                                        setActiveBubble((prev) =>
                                            prev?.pageIndex === pageIdx && prev?.blockIndex === bIdx ? null : prev,
                                        );
                                    }}
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        setActiveBubble({ pageIndex: pageIdx, blockIndex: bIdx });
                                        prepareAnkiPanelCrop(payload, block);
                                    }}
                                >
                                    <div className="manga-bubble-text text-line">
                                        {displayLines.map((line, lineIdx) => (
                                            <p
                                                key={lineIdx}
                                                className={`manga-bubble-line${paraGaps[lineIdx] ? " has-para-gap" : ""}`}
                                            >
                                                <TokenizedLine
                                                    text={line.appendSpace ? `${line.text} ` : line.text}
                                                    searchQuery=""
                                                    furiganaMode="none"
                                                    onLookupToken={onLookupToken
                                                        ? (token, _lineSent, cursor, boundaries, lemma) => {
                                                            prepareAnkiPanelCrop(payload, block);
                                                            return onLookupToken(
                                                                token,
                                                                sentence,
                                                                line.offset + cursor,
                                                                boundaries?.map((b) => b + line.offset),
                                                                lemma,
                                                            );
                                                        }
                                                        : undefined}
                                                />
                                            </p>
                                        ))}
                                    </div>
                                    {isActive && (
                                        <button
                                            type="button"
                                            className="manga-bubble-edit-btn"
                                            title={isEn ? "Fix OCR text" : "Исправить опечатку OCR"}
                                            onClick={(e) => {
                                                e.stopPropagation();
                                                setEditingBubble({
                                                    pageIndex: pageIdx,
                                                    blockIndex: bIdx,
                                                    text: displayLines.map((l) => l.text).join("\n") || sentence,
                                                });
                                            }}
                                        >
                                            ✎
                                        </button>
                                    )}
                                </div>
                            );
                        })}
                    </div>
                )}
                {cropToolActive && (
                    <div
                        className="manga-crop-overlay"
                        onClick={(e) => e.stopPropagation()}
                        onPointerDown={(e) => {
                            e.stopPropagation();
                            e.currentTarget.setPointerCapture(e.pointerId);
                            const rect = e.currentTarget.getBoundingClientRect();
                            const relX = Math.max(0, Math.min(1, (e.clientX - rect.left) / Math.max(1, rect.width)));
                            const relY = Math.max(0, Math.min(1, (e.clientY - rect.top) / Math.max(1, rect.height)));
                            setCropDrag({ pageIndex: pageIdx, startX: relX, startY: relY, curX: relX, curY: relY });
                        }}
                        onPointerMove={(e) => {
                            if (!cropDrag || cropDrag.pageIndex !== pageIdx) return;
                            const rect = e.currentTarget.getBoundingClientRect();
                            const relX = Math.max(0, Math.min(1, (e.clientX - rect.left) / Math.max(1, rect.width)));
                            const relY = Math.max(0, Math.min(1, (e.clientY - rect.top) / Math.max(1, rect.height)));
                            setCropDrag((prev) => (prev ? { ...prev, curX: relX, curY: relY } : null));
                        }}
                        onPointerUp={(e) => {
                            e.stopPropagation();
                            if (e.currentTarget.hasPointerCapture(e.pointerId)) {
                                e.currentTarget.releasePointerCapture(e.pointerId);
                            }
                            const drag = cropDrag;
                            setCropDrag(null);
                            if (!drag || drag.pageIndex !== pageIdx) return;
                            const minX = Math.min(drag.startX, drag.curX);
                            const maxX = Math.max(drag.startX, drag.curX);
                            const minY = Math.min(drag.startY, drag.curY);
                            const maxY = Math.max(drag.startY, drag.curY);
                            if (maxX - minX < 0.015 || maxY - minY < 0.015) return;
                            const box: [number, number, number, number] = [
                                Math.round(minX * natW),
                                Math.round(minY * natH),
                                Math.round(maxX * natW),
                                Math.round(maxY * natH),
                            ];
                            void handleRunBubbleCropOcr(payload, box);
                        }}
                        onPointerCancel={() => setCropDrag(null)}
                    >
                        {activeCrop ? (
                            <div
                                className="manga-crop-rect"
                                style={{
                                    left: `${Math.min(activeCrop.startX, activeCrop.curX) * 100}%`,
                                    top: `${Math.min(activeCrop.startY, activeCrop.curY) * 100}%`,
                                    width: `${Math.abs(activeCrop.curX - activeCrop.startX) * 100}%`,
                                    height: `${Math.abs(activeCrop.curY - activeCrop.startY) * 100}%`,
                                }}
                            />
                        ) : (
                            <div className="manga-crop-hint">
                                {isEn ? "Drag over any speech bubble to OCR" : "Обведи любой бабл для распознавания"}
                            </div>
                        )}
                    </div>
                )}
            </div>
        );
    };

    const showEdgeChevrons =
        !isMobile
        && !zenMode
        && !lookupActive
        && !escMenuOpen
        && prefs.spreadMode !== "webtoon"
        && !drawerOpen
        && !controlsOpen
        && !cropToolActive;

    return (
        <div
            className={`epub-reader-shell manga-reader-shell${isMobile ? " is-mobile" : ""}`}
            data-manga-bg={prefs.bgTheme || "dark"}
        >
            <div
                ref={stageRef}
                className="epub-reader-stage manga-reader-stage"
                onMouseMove={handleStageMouseMove}
                onMouseLeave={handleStageMouseLeave}
            >
                {/* Floating LiquidGlass Top Islands (auto-hide on desktop until hover) */}
                <div
                    className={`epub-floating-top${isMobile ? " is-mobile" : ""}${topChromeVisible ? " is-visible" : " is-hidden"}`}
                    onFocus={() => setTopHover(true)}
                >
                    <div className="epub-glass-pill epub-glass-pill-main" onClick={(e) => e.stopPropagation()}>
                        <button
                            type="button"
                            className="epub-glass-btn"
                            onClick={onBackToLibrary}
                            title={t("epub.backToLibrary")}
                        >
                            ← {!isMobile && <span>{t("epub.backToLibrary")}</span>}
                        </button>
                        <button
                            type="button"
                            className={`epub-glass-btn${drawerOpen && drawerTab === "pages" ? " is-active" : ""}`}
                            onClick={() => {
                                setControlsOpen(false);
                                if (drawerOpen && drawerTab === "pages") {
                                    setDrawerOpen(false);
                                } else {
                                    setDrawerTab("pages");
                                    setDrawerOpen(true);
                                }
                            }}
                            title={isEn ? "Pages" : "Страницы"}
                        >
                            <IconBookTab /> {!isMobile && <span>{isEn ? "Pages" : "Страницы"}</span>}
                        </button>
                        <span className="epub-pill-divider" aria-hidden="true" />
                        <div className="epub-toolbar-title">
                            <span className="epub-toolbar-book" title={displayTitle}>{displayTitle}</span>
                            <span className="epub-toolbar-chapter">
                                {isEn ? `Page ${pageSpanLabel} of ${meta.pageCount}` : `Стр. ${pageSpanLabel} из ${meta.pageCount}`} · {pct}%
                                {meta.totalChars > 0 ? ` · ${meta.totalChars.toLocaleString(isEn ? "en-US" : "ru-RU")} ${isEn ? "ch." : "зн."}` : ""}
                            </span>
                        </div>
                        <button
                            type="button"
                            className={`manga-badge-btn${meta.hasMokuro ? " is-mokuro" : " is-raw"}`}
                            onClick={() => setMokuroModalOpen(true)}
                            title={meta.hasMokuro
                                ? (isEn ? "Mokuro OCR active (click to manage)" : "Слой Mokuro активен (нажми для управления)")
                                : (isEn ? "No .mokuro OCR yet — click to run or attach" : "Нет .mokuro — нажми, чтобы распознать или прикрепить")}
                        >
                            {meta.hasMokuro ? "MOKURO" : "+ OCR"}
                        </button>
                    </div>

                    <div className="epub-glass-pill epub-glass-pill-tools" onClick={(e) => e.stopPropagation()}>
                        <button
                            type="button"
                            className={`epub-glass-btn epub-glass-circle${cropToolActive ? " is-active" : ""}`}
                            onClick={() => setCropToolActive((v) => !v)}
                            title={isEn ? "Select bubble area to OCR (S)" : "Обвести бабл для OCR (S)"}
                            aria-label={isEn ? "Crop bubble OCR" : "Обвести бабл OCR"}
                        >
                            ✂
                        </button>

                        {onChangeBookBookmarks && (
                            <button
                                type="button"
                                className={`epub-glass-btn epub-glass-circle${drawerOpen && drawerTab === "bookmarks" ? " is-active" : ""}`}
                                title={`${t("epub.bookmarks")} (B)`}
                                aria-label={t("epub.bookmarks")}
                                onClick={() => {
                                    setControlsOpen(false);
                                    if (drawerOpen && drawerTab === "bookmarks") {
                                        setDrawerOpen(false);
                                    } else {
                                        setDrawerTab("bookmarks");
                                        setDrawerOpen(true);
                                    }
                                }}
                            >
                                <IconBookmarkSvg />
                            </button>
                        )}

                        {onChangeBookNotes && (
                            <button
                                type="button"
                                className={`epub-glass-btn epub-glass-circle${drawerOpen && drawerTab === "notes" ? " is-active" : ""}`}
                                title={t("epub.notes")}
                                aria-label={t("epub.notes")}
                                onClick={() => {
                                    setControlsOpen(false);
                                    if (drawerOpen && drawerTab === "notes") {
                                        setDrawerOpen(false);
                                    } else {
                                        setDrawerTab("notes");
                                        setDrawerOpen(true);
                                    }
                                }}
                            >
                                ✎
                            </button>
                        )}

                        {onOpenCatalogPicker && (
                            <button
                                type="button"
                                className="epub-glass-btn epub-glass-circle"
                                title={isEn ? "Find title & cover" : "Найти название и обложку"}
                                aria-label={isEn ? "Find title & cover" : "Найти название и обложку"}
                                onClick={() => {
                                    setControlsOpen(false);
                                    onOpenCatalogPicker();
                                }}
                            >
                                <IconSearch />
                            </button>
                        )}

                        {!isMobile && (
                            <button
                                type="button"
                                className={`epub-glass-btn epub-glass-circle${zenMode ? " is-active" : ""}`}
                                title={`${t("epub.zenMode")} (Z)`}
                                aria-label={t("epub.zenMode")}
                                onClick={() => setZenMode((prev) => !prev)}
                            >
                                ⛶
                            </button>
                        )}

                        <button
                            type="button"
                            className={`epub-glass-btn epub-aa-btn${controlsOpen ? " is-active" : ""}`}
                            aria-expanded={controlsOpen}
                            title={isEn ? "Reader appearance & layout" : "Настройки читалки"}
                            onClick={() => {
                                setDrawerOpen(false);
                                setControlsOpen((v) => !v);
                            }}
                        >
                            {isMobile ? <IconSettings /> : "Aa"}
                        </button>
                    </div>
                </div>

                {/* LiquidGlass Appearance & Settings Popover */}
                {controlsOpen && (
                    <div
                        className={`epub-appearance-popover manga-appearance-popover${isMobile ? " is-mobile" : ""}`}
                        role="dialog"
                        aria-label={isEn ? "Manga appearance" : "Внешний вид"}
                        onClick={(e) => e.stopPropagation()}
                    >
                        <div className="epub-pop-head">
                            <span>{t("epub.appearance")}</span>
                            <button
                                type="button"
                                className="epub-pop-reset"
                                onClick={() => {
                                    updatePrefs({
                                        ...DEFAULT_MANGA_PREFS,
                                        spreadMode: isMobile ? "single" : DEFAULT_MANGA_PREFS.spreadMode,
                                    });
                                    setZoom(1);
                                }}
                            >
                                {t("epub.resetTypography")}
                            </button>
                        </div>

                        <div className="epub-pop-row">
                            <span className="epub-pop-label">{isEn ? "Pages" : "Страницы"}</span>
                            <div className="epub-segmented">
                                {([
                                    ["single", isEn ? "1p" : "1 стр"],
                                    ...(!isMobile ? [["spread", isEn ? "2p" : "2 стр"] as const] : []),
                                    ["webtoon", isEn ? "Strip" : "Лента"],
                                ] as Array<[MangaSpreadMode, string]>).map(([mode, label]) => (
                                    <button
                                        key={mode}
                                        type="button"
                                        className={`epub-seg-btn${prefs.spreadMode === mode ? " is-active" : ""}`}
                                        onClick={() => updatePrefs({ spreadMode: mode })}
                                    >
                                        {label}
                                    </button>
                                ))}
                            </div>
                        </div>

                        <div className="epub-pop-row">
                            <span className="epub-pop-label">{isEn ? "Direction" : "Направление"}</span>
                            <div className="epub-segmented">
                                <button
                                    type="button"
                                    className={`epub-seg-btn${prefs.rtl ? " is-active" : ""}`}
                                    onClick={() => updatePrefs({ rtl: true })}
                                >
                                    RTL ←
                                </button>
                                <button
                                    type="button"
                                    className={`epub-seg-btn${!prefs.rtl ? " is-active" : ""}`}
                                    onClick={() => updatePrefs({ rtl: false })}
                                >
                                    LTR →
                                </button>
                            </div>
                        </div>

                        <div className="epub-pop-row">
                            <span className="epub-pop-label">{isEn ? "Fit" : "Вписывание"}</span>
                            <div className="epub-segmented">
                                {(["height", "width", "original"] as const).map((mode) => (
                                    <button
                                        key={mode}
                                        type="button"
                                        className={`epub-seg-btn${prefs.fitMode === mode ? " is-active" : ""}`}
                                        onClick={() => updatePrefs({ fitMode: mode })}
                                    >
                                        {mode === "height"
                                            ? (isEn ? "Height" : "Высота")
                                            : mode === "width"
                                                ? (isEn ? "Width" : "Ширина")
                                                : "1:1"}
                                    </button>
                                ))}
                            </div>
                        </div>

                        <div className="epub-pop-row">
                            <span className="epub-pop-label">{isEn ? "Zoom" : "Масштаб"}</span>
                            <div className="epub-stepper">
                                <button
                                    type="button"
                                    className="epub-step-btn"
                                    onClick={() => setZoom((z) => Math.max(0.5, Number((z - 0.15).toFixed(2))))}
                                >
                                    −
                                </button>
                                <button
                                    type="button"
                                    className="epub-step-btn"
                                    onClick={() => setZoom(1)}
                                >
                                    {Math.round(zoom * 100)}%
                                </button>
                                <button
                                    type="button"
                                    className="epub-step-btn"
                                    onClick={() => setZoom((z) => Math.min(3, Number((z + 0.15).toFixed(2))))}
                                >
                                    +
                                </button>
                            </div>
                        </div>

                        <div className="epub-pop-row">
                            <span className="epub-pop-label">{isEn ? "OCR layer (O)" : "Слой OCR (O)"}</span>
                            <div className="epub-segmented">
                                {([
                                    ["hover", isEn ? "Hover" : "Скрыт"],
                                    ["outline", isEn ? "Boxes" : "Рамки"],
                                    ["readable", isEn ? "Text" : "Текст"],
                                ] as Array<[MangaOverlayMode, string]>).map(([mode, label]) => (
                                    <button
                                        key={mode}
                                        type="button"
                                        className={`epub-seg-btn${prefs.overlayMode === mode ? " is-active" : ""}`}
                                        onClick={() => updatePrefs({ overlayMode: mode })}
                                    >
                                        {label}
                                    </button>
                                ))}
                            </div>
                        </div>

                        <div className="epub-pop-slider-group">
                            <div className="epub-pop-slider-head">
                                <span className="epub-pop-label">{isEn ? "OCR font scale" : "Размер шрифта OCR"}</span>
                                <span className="epub-pop-val">{Math.round(prefs.fontScale * 100)}%</span>
                            </div>
                            <input
                                type="range"
                                min={0.75}
                                max={1.6}
                                step={0.05}
                                value={prefs.fontScale}
                                onChange={(e) => updatePrefs({ fontScale: Number(e.target.value) })}
                            />
                        </div>

                        <div className="epub-pop-row">
                            <span className="epub-pop-label">{isEn ? "Anki picture" : "Картинка в Anki"}</span>
                            <div className="epub-segmented">
                                <button
                                    type="button"
                                    className={`epub-seg-btn${prefs.cropMode === "bubble" ? " is-active" : ""}`}
                                    onClick={() => updatePrefs({ cropMode: "bubble" })}
                                >
                                    {isEn ? "Panel crop" : "Кроп кадра"}
                                </button>
                                <button
                                    type="button"
                                    className={`epub-seg-btn${prefs.cropMode === "full" ? " is-active" : ""}`}
                                    onClick={() => updatePrefs({ cropMode: "full" })}
                                >
                                    {isEn ? "Full page" : "Вся стр."}
                                </button>
                            </div>
                        </div>

                        {!isMobile && prefs.spreadMode === "spread" && (
                            <label className="epub-pop-row epub-pop-check-row">
                                <span className="epub-pop-label">{isEn ? "Single cover page in spread (C)" : "Отдельная обложка в развороте (C)"}</span>
                                <input
                                    type="checkbox"
                                    checked={prefs.coverOffset}
                                    onChange={(e) => updatePrefs({ coverOffset: e.target.checked })}
                                />
                            </label>
                        )}

                        <label className="epub-pop-row epub-pop-check-row">
                            <span className="epub-pop-label">{isEn ? "Dim bright white pages" : "Приглушить яркость белых страниц"}</span>
                            <input
                                type="checkbox"
                                checked={prefs.dimBackground}
                                onChange={(e) => updatePrefs({ dimBackground: e.target.checked })}
                            />
                        </label>

                        <div className="epub-pop-row epub-pop-themes-row">
                            <span className="epub-pop-label">{t("epub.theme")}</span>
                            <div className="epub-theme-swatches">
                                {BG_THEME_OPTIONS.map((item) => (
                                    <button
                                        key={item.value}
                                        type="button"
                                        className={`epub-theme-swatch${(prefs.bgTheme || "dark") === item.value ? " is-active" : ""}`}
                                        style={{ background: item.swatch, color: item.fg }}
                                        title={isEn ? item.labelEn : item.labelRu}
                                        aria-label={isEn ? item.labelEn : item.labelRu}
                                        onClick={() => updatePrefs({ bgTheme: item.value })}
                                    >
                                        A
                                    </button>
                                ))}
                            </div>
                        </div>

                        <div className="manga-pop-footer-btns">
                            <button
                                type="button"
                                className="btn-primary"
                                style={{ width: "100%", borderRadius: 12, height: 34 }}
                                onClick={() => {
                                    setControlsOpen(false);
                                    setMokuroModalOpen(true);
                                }}
                            >
                                {meta.hasMokuro
                                    ? (isEn ? "Manage .mokuro OCR" : "Управление .mokuro OCR")
                                    : (isEn ? "Add / Generate .mokuro OCR" : "Создать / прикрепить .mokuro")}
                            </button>
                            {!isMobile && onConvertMangaToCbz && (
                                <button
                                    type="button"
                                    className="epub-glass-btn manga-pop-sub-btn"
                                    disabled={convertingCbz || exportingCbz}
                                    onClick={() => {
                                        setControlsOpen(false);
                                        setMokuroModalOpen(true);
                                        void handleConvertInPlaceCbz();
                                    }}
                                >
                                    {convertingCbz
                                        ? (isEn ? "Converting to CBZ…" : "Преобразование в CBZ…")
                                        : (isEn ? "Convert to CBZ (PC & Sync)" : "Преобразовать в CBZ (ПК + синхр.)")}
                                </button>
                            )}
                            {!isMobile && !onConvertMangaToCbz && (
                                <button
                                    type="button"
                                    className="epub-glass-btn manga-pop-sub-btn"
                                    disabled={exportingCbz}
                                    onClick={() => {
                                        setControlsOpen(false);
                                        void handleExportMobileCbz();
                                    }}
                                >
                                    {exportingCbz
                                        ? (isEn ? "Packing .cbz…" : "Упаковка .cbz…")
                                        : (isEn ? "Pack .cbz for Phone" : "Упаковать для телефона (.cbz)")}
                                </button>
                            )}
                            {onOpenCatalogPicker && (
                                <button
                                    type="button"
                                    className="epub-glass-btn manga-pop-sub-btn"
                                    onClick={() => {
                                        setControlsOpen(false);
                                        onOpenCatalogPicker();
                                    }}
                                >
                                    {isEn ? "Find title & cover (AniList / MAL)" : "Подобрать название и обложку"}
                                </button>
                            )}
                        </div>
                    </div>
                )}

                {/* Edge-turn Chevrons matching EpubReader */}
                {showEdgeChevrons && (
                    <>
                        <div className={`epub-edge-hint epub-edge-hint-left${edgeHover === "left" ? " is-visible" : ""}`} aria-hidden="true">
                            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                                <polyline points="15 18 9 12 15 6" />
                            </svg>
                        </div>
                        <div className={`epub-edge-hint epub-edge-hint-right${edgeHover === "right" ? " is-visible" : ""}`} aria-hidden="true">
                            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                                <polyline points="9 18 15 12 9 6" />
                            </svg>
                        </div>
                    </>
                )}

                {/* Main page viewport */}
                <div
                    ref={viewportRef}
                    className={`manga-viewport mode-${prefs.spreadMode}`}
                    onWheel={handleWheel}
                    onTouchStart={handleTouchStart}
                    onTouchEnd={handleTouchEnd}
                    onClick={handleStageClick}
                >
                    <div className={`manga-spread-stage mode-${prefs.spreadMode}`}>
                        {orderedDisplayPages.map((idx) => renderPageCard(idx))}
                    </div>
                </div>

                {/* Left LiquidGlass Navigation / Bookmarks / Notes Drawer */}
                {drawerOpen && (
                    <div className="epub-toc-backdrop" onClick={() => setDrawerOpen(false)}>
                        <aside className="epub-toc-drawer" onClick={(event) => event.stopPropagation()}>
                            <div className="epub-toc-head">
                                <div className="epub-segmented">
                                    <button
                                        type="button"
                                        className={`epub-seg-btn${drawerTab === "pages" ? " is-active" : ""}`}
                                        onClick={() => setDrawerTab("pages")}
                                    >
                                        {isEn ? "Pages" : "Страницы"} ({meta.pageCount})
                                    </button>
                                    {onChangeBookBookmarks && (
                                        <button
                                            type="button"
                                            className={`epub-seg-btn${drawerTab === "bookmarks" ? " is-active" : ""}`}
                                            onClick={() => setDrawerTab("bookmarks")}
                                        >
                                            {t("epub.bookmarks")}{bookmarks.length > 0 ? ` (${bookmarks.length})` : ""}
                                        </button>
                                    )}
                                    {onChangeBookNotes && (
                                        <button
                                            type="button"
                                            className={`epub-seg-btn${drawerTab === "notes" ? " is-active" : ""}`}
                                            onClick={() => setDrawerTab("notes")}
                                        >
                                            {t("epub.notes")}{notes.length > 0 ? ` (${notes.length})` : ""}
                                        </button>
                                    )}
                                </div>
                                <button
                                    type="button"
                                    className="epub-glass-btn epub-glass-circle"
                                    aria-label={t("common.close")}
                                    onClick={() => setDrawerOpen(false)}
                                >
                                    <IconClose />
                                </button>
                            </div>

                            {drawerTab === "pages" ? (
                                <div className="epub-bookmarks-pane">
                                    <form
                                        className="manga-drawer-jump-form"
                                        onSubmit={(e) => {
                                            e.preventDefault();
                                            const n = Number.parseInt(pageJumpInput, 10);
                                            if (Number.isFinite(n) && n >= 1) {
                                                jumpToPage(n - 1);
                                                setPageJumpInput("");
                                                setDrawerOpen(false);
                                            }
                                        }}
                                    >
                                        <input
                                            type="number"
                                            min={1}
                                            max={Math.max(1, meta.pageCount)}
                                            className="epub-bookmark-input"
                                            value={pageJumpInput}
                                            onChange={(e) => setPageJumpInput(e.target.value)}
                                            placeholder={isEn ? `Go to page (1–${meta.pageCount})…` : `Перейти к стр. (1–${meta.pageCount})…`}
                                        />
                                        <button type="submit" className="btn-primary manga-drawer-jump-btn">
                                            {isEn ? "Go" : "Перейти"}
                                        </button>
                                    </form>
                                    <div ref={pageListRef} className="epub-toc-list">
                                        {meta.pages.map((p, idx) => {
                                            const isActive = visiblePages.includes(idx);
                                            const fileLabel = p.name.split(/[\\/]/).pop() || "";
                                            return (
                                                <button
                                                    key={idx}
                                                    type="button"
                                                    className={`epub-toc-item epub-toc-card${isActive ? " is-active" : ""}`}
                                                    onClick={() => {
                                                        jumpToPage(idx);
                                                        setDrawerOpen(false);
                                                    }}
                                                >
                                                    <div className="epub-toc-card-main">
                                                        <span className="epub-toc-card-title">
                                                            {isEn ? `Page ${idx + 1}` : `Страница ${idx + 1}`}
                                                        </span>
                                                        {fileLabel && (
                                                            <span className="epub-toc-card-sub">{fileLabel}</span>
                                                        )}
                                                    </div>
                                                    {p.blockCount > 0 && (
                                                        <span className="epub-toc-card-pct">
                                                            {p.charCount} {isEn ? "ch" : "зн"}
                                                        </span>
                                                    )}
                                                </button>
                                            );
                                        })}
                                    </div>
                                </div>
                            ) : drawerTab === "bookmarks" ? (
                                <div className="epub-bookmarks-pane">
                                    <form
                                        className="epub-bookmark-add-form"
                                        onSubmit={(event) => {
                                            event.preventDefault();
                                            handleAddBookmark();
                                        }}
                                    >
                                        <input
                                            type="text"
                                            className="epub-bookmark-input"
                                            value={bookmarkLabelInput}
                                            onChange={(event) => setBookmarkLabelInput(event.target.value)}
                                            placeholder={t("epub.bookmarkPlaceholder")}
                                        />
                                        <button type="submit" className="btn-primary epub-bookmark-add-btn">
                                            {t("epub.addBookmark")}
                                        </button>
                                    </form>

                                    {bookmarks.length === 0 ? (
                                        <div className="epub-bookmarks-empty">{t("epub.noBookmarks")}</div>
                                    ) : (
                                        <div className="epub-toc-list">
                                            {bookmarks.map((bm) => (
                                                <div key={bm.id} className="epub-bookmark-card">
                                                    {editingBookmarkId === bm.id ? (
                                                        <form
                                                            className="epub-bookmark-rename-form"
                                                            onSubmit={(event) => {
                                                                event.preventDefault();
                                                                handleRenameBookmark(bm.id);
                                                            }}
                                                        >
                                                            <input
                                                                type="text"
                                                                className="epub-bookmark-input"
                                                                autoFocus
                                                                value={editingBookmarkLabel}
                                                                onChange={(event) => setEditingBookmarkLabel(event.target.value)}
                                                                onBlur={() => handleRenameBookmark(bm.id)}
                                                            />
                                                        </form>
                                                    ) : (
                                                        <button
                                                            type="button"
                                                            className="epub-bookmark-jump"
                                                            onClick={() => {
                                                                setDrawerOpen(false);
                                                                jumpToPage(bm.chapterIndex);
                                                            }}
                                                        >
                                                            <span className="epub-bookmark-title">{bm.label}</span>
                                                            <span className="epub-bookmark-meta">
                                                                {bm.chapterTitle || (isEn ? `Page ${bm.chapterIndex + 1}` : `Стр. ${bm.chapterIndex + 1}`)}
                                                            </span>
                                                            {bm.excerpt && (
                                                                <span className="epub-bookmark-excerpt">{bm.excerpt}</span>
                                                            )}
                                                        </button>
                                                    )}
                                                    <div className="epub-bookmark-actions">
                                                        <button
                                                            type="button"
                                                            className="epub-glass-btn epub-bookmark-act-btn"
                                                            title={t("epub.renameBookmark")}
                                                            onClick={() => {
                                                                setEditingBookmarkId(bm.id);
                                                                setEditingBookmarkLabel(bm.label);
                                                            }}
                                                        >
                                                            ✎
                                                        </button>
                                                        <button
                                                            type="button"
                                                            className="epub-glass-btn epub-bookmark-act-btn is-danger"
                                                            title={t("epub.deleteBookmark")}
                                                            onClick={() => handleDeleteBookmark(bm.id)}
                                                        >
                                                            <IconClose />
                                                        </button>
                                                    </div>
                                                </div>
                                            ))}
                                        </div>
                                    )}
                                </div>
                            ) : (
                                <div className="epub-bookmarks-pane epub-notes-pane">
                                    {onChangeBookNotes && (
                                        <form
                                            className="epub-note-add-form"
                                            onSubmit={(event) => {
                                                event.preventDefault();
                                                handleAddBookNote();
                                            }}
                                        >
                                            <input
                                                type="text"
                                                className="epub-bookmark-input"
                                                value={noteTitleInput}
                                                onChange={(event) => setNoteTitleInput(event.target.value)}
                                                placeholder={t("epub.noteTitlePlaceholder")}
                                            />
                                            <textarea
                                                className="epub-note-textarea"
                                                rows={2}
                                                value={noteBodyInput}
                                                onChange={(event) => setNoteBodyInput(event.target.value)}
                                                placeholder={t("epub.noteBodyPlaceholder")}
                                            />
                                            <button type="submit" className="btn-primary epub-bookmark-add-btn">
                                                {t("epub.addNote")}
                                            </button>
                                        </form>
                                    )}

                                    {notes.length === 0 ? (
                                        <div className="epub-bookmarks-empty">{t("epub.noNotes")}</div>
                                    ) : (
                                        <div className="epub-toc-list">
                                            {notes.map((note) => (
                                                <div key={note.id} className="epub-bookmark-card">
                                                    <button
                                                        type="button"
                                                        className="epub-bookmark-jump"
                                                        onClick={() => {
                                                            if (typeof note.chapterIndex === "number") {
                                                                setDrawerOpen(false);
                                                                jumpToPage(note.chapterIndex);
                                                            }
                                                        }}
                                                    >
                                                        <span className="epub-bookmark-title">{note.title}</span>
                                                        {note.chapterTitle && (
                                                            <span className="epub-bookmark-meta">{note.chapterTitle}</span>
                                                        )}
                                                        {note.body && (
                                                            <span className="epub-bookmark-excerpt">{note.body}</span>
                                                        )}
                                                    </button>
                                                    <div className="epub-bookmark-actions">
                                                        <button
                                                            type="button"
                                                            className="epub-glass-btn epub-bookmark-act-btn is-danger"
                                                            title={t("common.close")}
                                                            onClick={() => handleDeleteBookNote(note.id)}
                                                        >
                                                            <IconClose />
                                                        </button>
                                                    </div>
                                                </div>
                                            ))}
                                        </div>
                                    )}
                                </div>
                            )}
                        </aside>
                    </div>
                )}

                {/* Floating LiquidGlass Bottom Navigation Capsule (matching EpubReader) */}
                <div
                    className={`epub-floating-bottom${isMobile ? " is-mobile" : ""}${bottomChromeVisible ? " is-visible" : " is-hidden"}`}
                    onFocus={() => setBottomHover(true)}
                    onClick={(event) => event.stopPropagation()}
                >
                    <div className="epub-glass-pill epub-nav-capsule">
                        <button
                            type="button"
                            className="epub-glass-btn epub-glass-circle"
                            disabled={!hasLeftAction}
                            title={prefs.rtl
                                ? (isEn ? "Last page" : "Последняя страница")
                                : (isEn ? "First page" : "Первая страница")}
                            onClick={() => jumpToPage(prefs.rtl ? Math.max(0, meta.pageCount - 1) : 0)}
                        >
                            «
                        </button>
                        <button
                            type="button"
                            className="epub-glass-btn epub-glass-circle"
                            disabled={!hasLeftAction}
                            title={prefs.rtl ? t("epub.nextPage") : t("epub.prevPage")}
                            onClick={prefs.rtl ? goNext : goPrev}
                        >
                            ‹
                        </button>

                        <div className="epub-nav-meta manga-nav-meta">
                            <div className="epub-nav-meta-text">
                                {pageJumpEditing ? (
                                    <form
                                        className="manga-inline-jump-form"
                                        onSubmit={(e) => {
                                            e.preventDefault();
                                            const parsed = Number.parseInt(pageJumpInput, 10);
                                            if (Number.isFinite(parsed) && parsed >= 1) {
                                                jumpToPage(parsed - 1);
                                            }
                                            setPageJumpEditing(false);
                                        }}
                                    >
                                        <input
                                            type="number"
                                            min={1}
                                            max={Math.max(1, meta.pageCount)}
                                            autoFocus
                                            className="manga-page-jump-input"
                                            value={pageJumpInput}
                                            onChange={(e) => setPageJumpInput(e.target.value)}
                                            onBlur={() => setPageJumpEditing(false)}
                                            onKeyDown={(e) => {
                                                if (e.key === "Escape") {
                                                    e.stopPropagation();
                                                    setPageJumpEditing(false);
                                                }
                                            }}
                                        />
                                        <span>/ {meta.pageCount}</span>
                                    </form>
                                ) : (
                                    <button
                                        type="button"
                                        className="manga-nav-page-btn"
                                        title={isEn ? "Click to enter page number" : "Нажми, чтобы ввести номер страницы"}
                                        onClick={() => {
                                            setPageJumpInput(String(currentPage + 1));
                                            setPageJumpEditing(true);
                                        }}
                                    >
                                        {isEn ? `Page ${pageSpanLabel} / ${meta.pageCount}` : `Стр. ${pageSpanLabel} / ${meta.pageCount}`}
                                    </button>
                                )}
                                {!isMobile && meta.totalChars > 0 && (
                                    <span className="epub-nav-chars">
                                        · {meta.totalChars.toLocaleString(isEn ? "en-US" : "ru-RU")} {isEn ? "ch." : "зн."}
                                    </span>
                                )}
                                <span className="epub-nav-pct">{pct}%</span>
                            </div>

                            <div
                                className={`manga-nav-scrubber${prefs.rtl ? " is-rtl" : ""}`}
                                role="slider"
                                aria-label={isEn ? "Page progress" : "Прогресс чтения"}
                                aria-valuemin={1}
                                aria-valuemax={Math.max(1, meta.pageCount)}
                                aria-valuenow={currentPage + 1}
                                onPointerDown={handleScrubPointerDown}
                                onPointerMove={handleScrubPointerMove}
                                onPointerUp={handleScrubPointerUp}
                                onPointerCancel={handleScrubPointerUp}
                            >
                                <div
                                    className="manga-nav-scrubber-fill"
                                    style={{ width: `${pct}%` }}
                                />
                            </div>
                        </div>

                        <button
                            type="button"
                            className="epub-glass-btn epub-glass-circle"
                            disabled={!hasRightAction}
                            title={prefs.rtl ? t("epub.prevPage") : t("epub.nextPage")}
                            onClick={prefs.rtl ? goPrev : goNext}
                        >
                            ›
                        </button>
                        <button
                            type="button"
                            className="epub-glass-btn epub-glass-circle"
                            disabled={!hasRightAction}
                            title={prefs.rtl
                                ? (isEn ? "First page" : "Первая страница")
                                : (isEn ? "Last page" : "Последняя страница")}
                            onClick={() => jumpToPage(prefs.rtl ? 0 : Math.max(0, meta.pageCount - 1))}
                        >
                            »
                        </button>

                        <span className="epub-pill-divider" aria-hidden="true" />

                        <button
                            type="button"
                            className={`epub-glass-btn epub-glass-circle${positionFrozen ? " is-active" : ""}`}
                            title={t("epub.freezePos")}
                            onClick={() => setPositionFrozen((prev) => !prev)}
                        >
                            ❄
                        </button>

                        <button
                            type="button"
                            className={`epub-glass-btn epub-glass-circle${trackingPaused ? " is-active" : ""}`}
                            title={t("epub.pauseTracking")}
                            onClick={() => setTrackingPaused((prev) => !prev)}
                        >
                            {trackingPaused ? "▶" : "⏱"}
                        </button>

                        {onOpenStats && (
                            <button
                                type="button"
                                className="epub-glass-btn epub-goal-pill-btn"
                                title={`${t("epub.statsTitle")} · ${Math.round(goalSummary.overallPct * 100)}%`}
                                onClick={onOpenStats}
                            >
                                <span className={`epub-goal-dot is-${goalSummary.status}`} />
                            </button>
                        )}
                    </div>
                </div>

                {/* Subtle bottom-right page readout & Goal light when bottom chrome is hidden */}
                {!zenMode && !bottomChromeVisible && !lookupActive && !escMenuOpen && (
                    <button
                        type="button"
                        className="epub-corner-status"
                        title={onOpenStats
                            ? `${t("epub.statsTitle")}${activeGoals.enabled ? ` · ${Math.round(goalSummary.overallPct * 100)}%` : ""}`
                            : undefined}
                        aria-label={t("epub.statsTitle")}
                        onClick={(e) => {
                            e.stopPropagation();
                            onOpenStats?.();
                        }}
                    >
                        <span className="epub-corner-progress">
                            {pageSpanLabel} / {meta.pageCount} · {pct}%
                        </span>
                        {activeGoals.enabled && (
                            <span className={`epub-goal-dot is-${goalSummary.status}`} />
                        )}
                    </button>
                )}

                {/* Floating OCR result bar for on-demand bubble crop / ML Kit scan */}
                {(ocrBusy || ocrError || ocrResult) && (
                    <div className="manga-ocr-result-bar" onClick={(e) => e.stopPropagation()}>
                        {ocrBusy ? (
                            <div className="manga-ocr-result-busy">
                                <span className="manga-ocr-spinner" aria-hidden="true" />
                                <span>{ocrBusy}</span>
                            </div>
                        ) : ocrError ? (
                            <div className="manga-ocr-result-row">
                                <span className="manga-mokuro-error">{ocrError}</span>
                                <button
                                    type="button"
                                    className="epub-glass-btn epub-glass-circle"
                                    onClick={() => setOcrError(null)}
                                >
                                    ×
                                </button>
                            </div>
                        ) : ocrResult && (
                            <div className="manga-ocr-result-row">
                                <span className="manga-ocr-engine-pill">
                                    {formatOcrEngineLabel(ocrResult.engine, ocrResult.device, isEn)} · {ocrResult.elapsedMs}ms
                                </span>
                                <div className="manga-ocr-result-text text-line">
                                    {ocrResult.text ? (
                                        <TokenizedLine
                                            text={ocrResult.text}
                                            searchQuery=""
                                            furiganaMode="none"
                                            onLookupToken={onLookupToken}
                                        />
                                    ) : (
                                        <span style={{ opacity: 0.6 }}>
                                            {isEn ? "(no text detected)" : "(текст не найден)"}
                                        </span>
                                    )}
                                </div>
                                <div className="manga-ocr-result-actions">
                                    <button
                                        type="button"
                                        className="epub-glass-btn"
                                        title={isEn ? "Crop another bubble (S)" : "Обвести другой бабл (S)"}
                                        onClick={() => setCropToolActive(true)}
                                    >
                                        ✂
                                    </button>
                                    {ocrResult.text && (
                                        <button
                                            type="button"
                                            className="epub-glass-btn"
                                            title={isEn ? "Pin as bubble on page" : "Закрепить как бабл на странице"}
                                            onClick={handlePinOcrResultAsBubble}
                                        >
                                            + {isEn ? "Bubble" : "Бабл"}
                                        </button>
                                    )}
                                    <button
                                        type="button"
                                        className="epub-glass-btn"
                                        title={isEn ? "Edit OCR text" : "Исправить текст"}
                                        onClick={() =>
                                            setEditingBubble({
                                                pageIndex: -1,
                                                blockIndex: 0,
                                                text: ocrResult.text,
                                            })
                                        }
                                    >
                                        ✎
                                    </button>
                                    <button
                                        type="button"
                                        className="epub-glass-btn epub-glass-circle"
                                        title={isEn ? "Dismiss" : "Закрыть"}
                                        onClick={() => setOcrResult(null)}
                                    >
                                        ×
                                    </button>
                                </div>
                            </div>
                        )}
                    </div>
                )}

                {/* Inline OCR typo editor modal */}
                {editingBubble && (
                    <div className="manga-modal-backdrop" onClick={() => setEditingBubble(null)}>
                        <div className="manga-modal" onClick={(e) => e.stopPropagation()}>
                            <h3>{isEn ? "Fix OCR text in bubble" : "Исправить текст OCR в бабле"}</h3>
                            <textarea
                                className="manga-edit-textarea"
                                rows={4}
                                autoFocus
                                value={editingBubble.text}
                                onChange={(e) => setEditingBubble({ ...editingBubble, text: e.target.value })}
                            />
                            <div className="manga-modal-footer">
                                <button type="button" className="manga-btn" onClick={() => setEditingBubble(null)}>
                                    {isEn ? "Cancel" : "Отмена"}
                                </button>
                                <button type="button" className="manga-primary-btn" onClick={() => void handleSaveBubbleEdit()}>
                                    {isEn ? "Save" : "Сохранить"}
                                </button>
                            </div>
                        </div>
                    </div>
                )}

                {/* Mokuro OCR manager / CLI runner modal */}
                {mokuroModalOpen && (
                    <div className="manga-modal-backdrop" onClick={() => !mokuroRunning && setMokuroModalOpen(false)}>
                        <div className="manga-modal" onClick={(e) => e.stopPropagation()}>
                            <h3>{isEn ? "Mokuro OCR Text Layer" : "Слой текста Mokuro OCR"}</h3>
                            <p className="manga-modal-desc">
                                {mokuroRunning
                                    ? (isEn
                                        ? "Recognizing speech bubbles and Japanese text in this volume. When finished, clickable text overlays will activate automatically."
                                        : "Идёт распознавание баблов и японского текста в этом томе. После завершения кликабельный слой текста подключится автоматически.")
                                    : meta.hasMokuro
                                        ? (isEn
                                            ? `Active .mokuro layer (${meta.totalChars.toLocaleString()} chars across ${meta.pageCount} pages). Hover any speech bubble and hold Shift to look up words.`
                                            : `Слой .mokuro подключён (${meta.totalChars.toLocaleString("ru-RU")} зн. на ${meta.pageCount} стр.). Наведи курсор на бабл с Shift (или тапни на телефоне) для словаря.`)
                                        : (isEn
                                            ? "This manga currently has raw images without a .mokuro overlay. You can attach an existing .mokuro file or generate one right here via mokuro CLI."
                                            : "Сейчас в этом томе только картинки без .mokuro-слоя. Можно прикрепить готовый файл .mokuro или запустить генерацию прямо отсюда через mokuro CLI.")}
                            </p>

                            {!isMobile && (
                                <div className="manga-mokuro-box">
                                    <div className="manga-mokuro-status">
                                        <span>{isEn ? "Format:" : "Формат:"}</span>
                                        <span className={meta.sourceKind === "cbz" ? "is-ok" : "is-warn"}>
                                            {meta.sourceKind === "cbz"
                                                ? (meta.hasMokuro
                                                    ? (meta.mokuroPath?.includes("::")
                                                        ? (isEn ? "✓ CBZ · .mokuro embedded" : "✓ CBZ · .mokuro встроен")
                                                        : (isEn
                                                            ? "CBZ (external .mokuro — click Convert to embed)"
                                                            : "CBZ (внешний .mokuro — нажми «Преобразовать в CBZ» для вшивания)"))
                                                    : (isEn ? "✓ CBZ · ready for Google Drive" : "✓ CBZ · готов к Google Диск"))
                                                : (isEn
                                                    ? "Folder (convert to CBZ to sync to phone)"
                                                    : "Папка (преобразуй в CBZ для синка на телефон)")}
                                        </span>
                                    </div>
                                    <div className="manga-mokuro-status">
                                        <span>mokuro CLI:</span>
                                        {mokuroStatus === null ? (
                                            <span className="is-muted">{isEn ? "Checking…" : "Проверка…"}</span>
                                        ) : mokuroStatus.available ? (
                                            <span className="is-ok">
                                                ✓ {mokuroStatus.command} {mokuroStatus.version ? `(${mokuroStatus.version})` : ""}
                                            </span>
                                        ) : (
                                            <span className="is-warn">
                                                {isEn ? "Not found" : "Не установлен"}
                                            </span>
                                        )}
                                    </div>

                                    {mokuroStatus && !mokuroStatus.available && (
                                        <div className="manga-mokuro-hint">
                                            {isEn ? "Install once in terminal:" : "Установи один раз в терминале:"}
                                            <code>pip install mokuro</code>
                                        </div>
                                    )}

                                    {mokuroRunning && (
                                        <div className="manga-mokuro-progress">
                                            <div className="manga-mokuro-progress-head">
                                                <span>
                                                    {mokuroProgress?.stage === "ocr" && mokuroProgress.current !== null && mokuroProgress.total
                                                        ? (isEn
                                                            ? `Scanning pages: ${mokuroProgress.current} / ${mokuroProgress.total} (${mokuroProgress.percent ?? 0}%)`
                                                            : `Распознавание страниц: ${mokuroProgress.current} / ${mokuroProgress.total} (${mokuroProgress.percent ?? 0}%)`)
                                                        : mokuroProgress?.stage === "model_load"
                                                            ? (isEn ? "Loading manga-ocr neural model…" : "Загрузка нейросети manga-ocr…")
                                                            : mokuroProgress?.stage === "detector_init"
                                                                ? (isEn ? "Initializing speech-bubble detector…" : "Запуск детектора баблов…")
                                                                : mokuroProgress?.stage === "downloading"
                                                                    ? (isEn ? "Downloading OCR weights…" : "Скачивание весов OCR…")
                                                                    : (isEn ? "Starting mokuro…" : "Запуск mokuro…")}
                                                </span>
                                                {mokuroProgress?.device && (
                                                    <span className={`manga-device-pill is-${mokuroProgress.device}`}>
                                                        {mokuroProgress.device === "cuda" ? "⚡ GPU (CUDA)" : "CPU"}
                                                    </span>
                                                )}
                                            </div>
                                            <div className="manga-progress-track">
                                                <div
                                                    className={`manga-progress-fill${mokuroProgress?.percent == null ? " is-indeterminate" : ""}`}
                                                    style={mokuroProgress?.percent != null ? { width: `${mokuroProgress.percent}%` } : undefined}
                                                />
                                            </div>
                                            {mokuroProgress?.eta && (
                                                <div className="manga-mokuro-eta">
                                                    {isEn ? `Estimated time left: ~${mokuroProgress.eta}` : `Осталось примерно: ~${mokuroProgress.eta}`}
                                                </div>
                                            )}
                                        </div>
                                    )}

                                    {(convertingCbz || exportingCbz) && (
                                        <div className="manga-mokuro-progress">
                                            <div className="manga-mokuro-progress-head">
                                                <span>
                                                    {isEn
                                                        ? "Packing volume into CBZ (pages, .mokuro & cover)…"
                                                        : "Преобразование тома в CBZ (страницы, .mokuro и обложка)…"}
                                                </span>
                                            </div>
                                            <div className="manga-progress-track">
                                                <div className="manga-progress-fill is-indeterminate" />
                                            </div>
                                        </div>
                                    )}

                                    {mokuroError && <div className="manga-mokuro-error">{mokuroError}</div>}
                                    {exportStatus && (
                                        <div className={exportStatus.ok ? "manga-export-ok" : "manga-mokuro-error"}>
                                            {exportStatus.message}
                                        </div>
                                    )}
                                </div>
                            )}

                            {isMobile && (
                                <div className="manga-mokuro-box">
                                    <div className="manga-mokuro-status">
                                        <span>{isEn ? "On-device OCR:" : "OCR на телефоне:"}</span>
                                        <span className={mobileOcrReady?.onnxReady ? "is-ok" : "is-muted"}>
                                            {mobileOcrReady?.onnxReady
                                                ? "ML Kit + ONNX INT8"
                                                : mobileOcrReady?.onnxDownloading
                                                    ? (isEn ? "ML Kit · ONNX downloading…" : "ML Kit · ONNX скачивается…")
                                                    : "ML Kit"}
                                            {mobileOcrReady?.hasRemote ? (isEn ? " + PC Wi-Fi" : " + ПК Wi-Fi") : ""}
                                        </span>
                                    </div>
                                    <div className="manga-mokuro-hint">
                                        {isEn
                                            ? "Use ✂ to draw over any bubble, or scan all bubbles on the current page. Configure ONNX INT8 (~117 MB) and PC Wi-Fi GPU in Settings → EPUB & Manga → Manga & OCR."
                                            : "Нажми ✂, чтобы обвести бабл вручную, или найди все баблы на странице через ML Kit. Модель ONNX (~117 МБ) и адрес ПК Wi-Fi настраиваются в Настройках → EPUB → Манга и OCR."}
                                    </div>
                                </div>
                            )}

                            <div className="manga-modal-footer">
                                {isMobile && hasAndroidMangaOcrBridge() && (
                                    <button
                                        type="button"
                                        className="manga-primary-btn"
                                        disabled={Boolean(ocrBusy) || !pagesByIndex[currentPage]}
                                        onClick={() => void handleAutoScanPage()}
                                    >
                                        {isEn ? "Scan page bubbles (ML Kit)" : "Найти баблы на стр. (ML Kit)"}
                                    </button>
                                )}
                                {isMobile && (
                                    <button
                                        type="button"
                                        className="manga-btn"
                                        onClick={() => {
                                            setMokuroModalOpen(false);
                                            setCropToolActive(true);
                                        }}
                                    >
                                        {isEn ? "✂ Crop bubble" : "✂ Обвести бабл"}
                                    </button>
                                )}
                                {!isMobile && onConvertMangaToCbz && (
                                    <button
                                        type="button"
                                        className="manga-btn"
                                        disabled={mokuroRunning || convertingCbz || exportingCbz}
                                        onClick={() => void handleConvertInPlaceCbz()}
                                    >
                                        {convertingCbz
                                            ? (isEn ? "Converting to CBZ…" : "Преобразование в CBZ…")
                                            : (isEn ? "Convert to CBZ (PC & Sync)" : "Преобразовать в CBZ (ПК + синхр.)")}
                                    </button>
                                )}
                                {!isMobile && (
                                    <button
                                        type="button"
                                        className="manga-btn"
                                        disabled={mokuroRunning || convertingCbz || exportingCbz}
                                        onClick={() => void handleExportMobileCbz()}
                                    >
                                        {exportingCbz
                                            ? (isEn ? "Saving .cbz…" : "Сохранение .cbz…")
                                            : (isEn ? "Save copy .cbz…" : "Сохранить копию .cbz…")}
                                    </button>
                                )}
                                {!isMobile && (
                                    <button
                                        type="button"
                                        className="manga-btn"
                                        disabled={mokuroRunning}
                                        onClick={() => void handleAttachMokuroFile()}
                                    >
                                        {isEn ? "Attach .mokuro file" : "Прикрепить .mokuro"}
                                    </button>
                                )}
                                {!isMobile && (
                                    <button
                                        type="button"
                                        className="manga-primary-btn"
                                        disabled={mokuroRunning || !mokuroStatus?.available}
                                        onClick={() => void handleRunMokuroCli()}
                                    >
                                        {mokuroRunning
                                            ? (isEn ? "Running OCR…" : "Распознавание…")
                                            : (isEn ? "Generate .mokuro" : "Распознать том (mokuro)")}
                                    </button>
                                )}
                                <button
                                    type="button"
                                    className="manga-btn"
                                    disabled={mokuroRunning}
                                    onClick={() => setMokuroModalOpen(false)}
                                >
                                    {isEn ? "Close" : "Закрыть"}
                                </button>
                            </div>
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}
