import {
    useCallback,
    useEffect,
    useMemo,
    useRef,
    useState,
    type MouseEvent as ReactMouseEvent,
} from "react";
import * as pdfjsLib from "pdfjs-dist";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import type { PDFDocumentProxy, RenderTask } from "pdfjs-dist/types/src/display/api";
import type { AppSettings } from "../../components/SettingsModal";
import type { EpubBookmark, Tab } from "../../utils/constants";
import { getTranslator } from "../../utils/i18n";
import { TokenizedLine } from "../../components/TextContainer";
import { IconClose, IconSearch } from "../../components/Icons";
import { getDay, sumDayForTabs, useDailyStatsVersion } from "../../utils/dailyStats";
import { setMobileVolumePagingEnabled } from "../../utils/mobileFiles";
import { MOBILE_BACK_PRIORITY, useMobileBackHandler } from "../../utils/mobileBack";
import { readBookBinary } from "./epubApi";
import { setMemoryCover } from "./epubCoverCache";
import type { EpubBookMeta, EpubBookNote, EpubReadingPoint } from "./epubModel";
import { evaluateGoalProgress, loadEpubGoals } from "./epubTracker";
import {
    buildPdfLookupTarget,
    buildPdfSearchSnippet,
    clampPdfPage,
    computePdfFitScale,
    computePinchScale,
    groupPdfTextItemsIntoLines,
    type PdfColorTheme,
    type PdfFitMode,
    type PdfLayoutMode,
    type PdfTextItemLike,
    type PdfTextLine,
} from "./pdfModel";
import "./pdf.css";

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

type LookupMatch = { start: number; length: number };
type LookupTokenHandler = (
    token: string,
    sentence: string,
    cursor: number,
    boundaries?: number[],
    lemma?: string,
) => LookupMatch | null | void | Promise<LookupMatch | null | void>;

interface PdfOutlineEntry {
    title: string;
    pageNumber: number;
    depth: number;
}

interface PdfSearchHit {
    pageNumber: number;
    snippet: string;
}

interface PdfPrefs {
    layout: PdfLayoutMode;
    fitMode: PdfFitMode;
    scale: number;
    colorTheme: PdfColorTheme;
    reflowOrientation: "horizontal" | "vertical";
}

export interface PdfReaderProps {
    tab: Tab;
    settings: AppSettings;
    isMobile: boolean;
    lookupOpen?: boolean;
    escMenuOpen?: boolean;
    onBackToLibrary: () => void;
    onUpdateBookMeta: (tabId: number, meta: EpubBookMeta) => void;
    onProgressChange: (pageIndex: number, offset: number, progress: number) => void;
    onChangeBookBookmarks?: (bookmarks: EpubBookmark[]) => void;
    onChangeBookNotes?: (notes: EpubBookNote[]) => void;
    onChangeReadingPoint?: (point: EpubReadingPoint | null) => void;
    onRecordReadingStats?: (deltaChars: number, deltaSeconds: number) => void;
    onOpenStats?: () => void;
    onUpdateSettings?: (patch: Partial<AppSettings>) => void;
    onLookupToken?: LookupTokenHandler;
    onOverlayStateChange?: (open: boolean) => void;
    closeOverlaySignal?: number;
    immersive?: boolean;
    onToggleImmersive?: () => void;
}

const PDF_PREFS_STORAGE_KEY = "setsuna-pdf-prefs-v1";
const ZOOM_STEPS = [0.5, 0.65, 0.8, 0.95, 1.0, 1.15, 1.3, 1.5, 1.75, 2.0, 2.5, 3.0];
const CHROME_TOP_ZONE_PX = 76;
const CHROME_BOTTOM_ZONE_PX = 82;
const CHROME_HIDE_DELAY_MS = 950;
const SPREAD_MIN_WIDTH = 980;

function readPdfPrefs(): PdfPrefs {
    try {
        const raw = localStorage.getItem(PDF_PREFS_STORAGE_KEY);
        if (raw) {
            const p = JSON.parse(raw) as Partial<PdfPrefs>;
            return {
                layout: p.layout === "spread" || p.layout === "scroll" ? p.layout : "paged",
                fitMode: p.fitMode === "fit-page" || p.fitMode === "custom" ? p.fitMode : "fit-width",
                scale: typeof p.scale === "number" && Number.isFinite(p.scale) ? Math.min(3, Math.max(0.5, p.scale)) : 1.0,
                colorTheme: p.colorTheme === "sepia" || p.colorTheme === "dark" || p.colorTheme === "eink" ? p.colorTheme : "original",
                reflowOrientation: p.reflowOrientation === "vertical" ? "vertical" : "horizontal",
            };
        }
    } catch {}
    return {
        layout: "paged",
        fitMode: "fit-width",
        scale: 1.0,
        colorTheme: "original",
        reflowOrientation: "horizontal",
    };
}

interface PdfPageCanvasProps {
    pdfDoc: PDFDocumentProxy;
    pageNumber: number;
    rotation: number;
    fitMode: PdfFitMode;
    customScale: number;
    availWidth: number;
    availHeight: number;
    isMobile: boolean;
    active?: boolean;
    lazy?: boolean;
    scrollRoot?: HTMLElement | null;
    onLookupToken?: LookupTokenHandler;
    onLinesReady?: (pageNumber: number, lines: PdfTextLine[]) => void;
    onVisiblePage?: (pageNumber: number) => void;
}

/**
 * Renders a single PDF page canvas + interactive lookup text overlay.
 * When `lazy` is true (continuous scroll mode), renders only while near the scroll viewport
 * so large textbooks stay lightweight in memory on Android & Desktop.
 */
function PdfPageCanvas({
    pdfDoc,
    pageNumber,
    rotation,
    fitMode,
    customScale,
    availWidth,
    availHeight,
    isMobile,
    lazy = false,
    scrollRoot,
    onLookupToken,
    onLinesReady,
    onVisiblePage,
}: PdfPageCanvasProps) {
    const hostRef = useRef<HTMLDivElement>(null);
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const renderTaskRef = useRef<RenderTask | null>(null);
    const [inView, setInView] = useState(!lazy);
    const [pageSize, setPageSize] = useState<{ width: number; height: number }>({
        width: Math.max(240, Math.min(780, availWidth)),
        height: Math.round(Math.max(240, Math.min(780, availWidth)) * 1.414),
    });
    const [lines, setLines] = useState<PdfTextLine[]>([]);

    const onLinesReadyRef = useRef(onLinesReady);
    onLinesReadyRef.current = onLinesReady;
    const onVisiblePageRef = useRef(onVisiblePage);
    onVisiblePageRef.current = onVisiblePage;

    useEffect(() => {
        if (!lazy || !hostRef.current) {
            setInView(true);
            return;
        }
        const node = hostRef.current;
        const obs = new IntersectionObserver(
            (entries) => {
                for (const entry of entries) {
                    setInView(entry.isIntersecting);
                    if (entry.isIntersecting && entry.intersectionRatio >= 0.45) {
                        onVisiblePageRef.current?.(pageNumber);
                    }
                }
            },
            {
                root: scrollRoot || null,
                rootMargin: "900px 0px",
                threshold: [0, 0.45],
            },
        );
        obs.observe(node);
        return () => obs.disconnect();
    }, [lazy, pageNumber, scrollRoot]);

    useEffect(() => {
        if (!inView) {
            setLines([]);
            const c = canvasRef.current;
            if (c) {
                c.width = 0;
                c.height = 0;
            }
            return;
        }
        let cancelled = false;

        void (async () => {
            try {
                const page = await pdfDoc.getPage(pageNumber);
                if (cancelled) return;
                const totalRot = (page.rotate + rotation) % 360;
                const unscaledVp = page.getViewport({ scale: 1, rotation: totalRot });
                const effectiveScale = computePdfFitScale(
                    unscaledVp.width,
                    unscaledVp.height,
                    availWidth,
                    availHeight,
                    fitMode,
                    customScale,
                    0,
                );
                const vp = page.getViewport({ scale: effectiveScale, rotation: totalRot });
                setPageSize({ width: vp.width, height: vp.height });

                const textContent = await page.getTextContent();
                if (cancelled) return;
                const rawItems: PdfTextItemLike[] = (textContent.items as any[])
                    .filter((item) => item && typeof item.str === "string")
                    .map((item) => ({
                        str: item.str as string,
                        transform: item.transform as number[],
                        width: Number(item.width) || 0,
                        height: Number(item.height) || 0,
                        hasEOL: Boolean(item.hasEOL),
                    }));
                const grouped = groupPdfTextItemsIntoLines(rawItems, vp.transform);
                setLines(grouped);
                onLinesReadyRef.current?.(pageNumber, grouped);

                if (canvasRef.current) {
                    if (renderTaskRef.current) {
                        try {
                            renderTaskRef.current.cancel();
                        } catch {}
                    }
                    const canvas = canvasRef.current;
                    const dpr = Math.min(window.devicePixelRatio || 1, isMobile ? 2.0 : 2.5);
                    canvas.width = Math.max(1, Math.floor(vp.width * dpr));
                    canvas.height = Math.max(1, Math.floor(vp.height * dpr));
                    canvas.style.width = `${vp.width}px`;
                    canvas.style.height = `${vp.height}px`;
                    const ctx = canvas.getContext("2d");
                    if (ctx) {
                        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
                        const renderTask = page.render({ canvasContext: ctx, viewport: vp, canvas });
                        renderTaskRef.current = renderTask;
                        await renderTask.promise.catch((e: unknown) => {
                            if ((e as { name?: string })?.name !== "RenderingCancelledException") {
                                throw e;
                            }
                        });
                    }
                }
            } catch {
                // Handled silently per-page in scroll view
            }
        })();

        return () => {
            cancelled = true;
            if (renderTaskRef.current) {
                try {
                    renderTaskRef.current.cancel();
                } catch {}
            }
        };
    }, [inView, pdfDoc, pageNumber, rotation, fitMode, customScale, availWidth, availHeight, isMobile]);

    const handleSpanLookup = useCallback((
        event: ReactMouseEvent<HTMLSpanElement>,
        line: PdfTextLine,
        spanIndex: number,
    ) => {
        if (!onLookupToken) return;
        const selection = window.getSelection()?.toString().trim();
        if (selection && selection.length > 0 && event.type === "click") {
            void onLookupToken(selection, line.text, Math.max(0, line.text.indexOf(selection)));
            return;
        }
        const span = line.spans[spanIndex];
        if (!span) return;
        const rect = event.currentTarget.getBoundingClientRect();
        const ratio = line.isVertical
            ? (rect.height > 0 ? (event.clientY - rect.top) / rect.height : 0)
            : (rect.width > 0 ? (event.clientX - rect.left) / rect.width : 0);
        const target = buildPdfLookupTarget(line.text, span, ratio);
        if (target) {
            void onLookupToken(target.token, target.sentence, target.cursor);
        }
    }, [onLookupToken]);

    return (
        <div
            ref={hostRef}
            data-pdf-page={pageNumber}
            className="pdf-page-stage"
            style={{
                width: `${pageSize.width}px`,
                height: `${pageSize.height}px`,
            }}
        >
            <canvas ref={canvasRef} className="pdf-page-canvas" />
            {inView && (
                <div className="pdf-text-layer" aria-label={`PDF page ${pageNumber} text layer`}>
                    {lines.map((line, lineIdx) =>
                        line.spans.map((span, spanIdx) => (
                            <span
                                key={`${lineIdx}-${spanIdx}`}
                                className="pdf-text-span"
                                style={{
                                    left: `${span.left}px`,
                                    top: `${span.top}px`,
                                    width: `${span.width}px`,
                                    height: `${span.height}px`,
                                    fontSize: `${Math.max(8, Math.min(span.width, span.height) * 0.85)}px`,
                                }}
                                onClick={(e) => {
                                    e.stopPropagation();
                                    handleSpanLookup(e, line, spanIdx);
                                }}
                                onMouseMove={(e) => {
                                    if (!isMobile && e.shiftKey) {
                                        handleSpanLookup(e, line, spanIdx);
                                    }
                                }}
                            >
                                {span.str}
                            </span>
                        )),
                    )}
                </div>
            )}
        </div>
    );
}

interface PdfThumbnailTileProps {
    pdfDoc: PDFDocumentProxy;
    pageNumber: number;
    active: boolean;
    scrollRoot: HTMLElement | null;
    onSelect: (pageNumber: number) => void;
}

function PdfThumbnailTile({ pdfDoc, pageNumber, active, scrollRoot, onSelect }: PdfThumbnailTileProps) {
    const ref = useRef<HTMLButtonElement>(null);
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const [visible, setVisible] = useState(false);

    useEffect(() => {
        if (!ref.current) return;
        const obs = new IntersectionObserver(
            (entries) => {
                if (entries.some((e) => e.isIntersecting)) {
                    setVisible(true);
                    obs.disconnect();
                }
            },
            { root: scrollRoot || null, rootMargin: "240px 0px" },
        );
        obs.observe(ref.current);
        return () => obs.disconnect();
    }, [scrollRoot]);

    useEffect(() => {
        if (!visible || !canvasRef.current) return;
        let cancelled = false;
        void (async () => {
            try {
                const page = await pdfDoc.getPage(pageNumber);
                if (cancelled || !canvasRef.current) return;
                const base = page.getViewport({ scale: 1 });
                const scale = Math.min(0.45, 132 / Math.max(1, base.width));
                const vp = page.getViewport({ scale });
                const c = canvasRef.current;
                c.width = Math.max(1, Math.round(vp.width));
                c.height = Math.max(1, Math.round(vp.height));
                const ctx = c.getContext("2d");
                if (ctx) {
                    await page.render({ canvasContext: ctx, viewport: vp, canvas: c }).promise;
                }
            } catch {}
        })();
        return () => {
            cancelled = true;
        };
    }, [visible, pdfDoc, pageNumber]);

    return (
        <button
            ref={ref}
            type="button"
            className={`pdf-thumb-tile${active ? " is-active" : ""}`}
            onClick={() => onSelect(pageNumber)}
        >
            <div className="pdf-thumb-frame">
                <canvas ref={canvasRef} className="pdf-thumb-canvas" />
            </div>
            <span className="pdf-thumb-num">{pageNumber}</span>
        </button>
    );
}

export default function PdfReader({
    tab,
    settings,
    isMobile,
    lookupOpen = false,
    escMenuOpen = false,
    onBackToLibrary,
    onUpdateBookMeta,
    onProgressChange,
    onChangeBookBookmarks,
    onChangeBookNotes,
    onChangeReadingPoint,
    onRecordReadingStats,
    onOpenStats,
    onUpdateSettings,
    onLookupToken,
    onOverlayStateChange,
    closeOverlaySignal = 0,
    immersive = false,
    onToggleImmersive,
}: PdfReaderProps) {
    const language = settings.appLanguage || "ru";
    const isEn = language === "en";
    const t = getTranslator(language);

    const bookPath = tab.epub?.path || "";
    const initialPage = Math.max(1, (tab.epub?.chapterIndex ?? 0) + 1);
    const bookmarks = useMemo(() => tab.epub?.bookmarks || [], [tab.epub?.bookmarks]);
    const notes = useMemo(() => tab.epub?.notes || [], [tab.epub?.notes]);
    const readingPoint = tab.epub?.readingPoint || null;
    const statsVersion = useDailyStatsVersion();
    const activeGoals = useMemo(() => loadEpubGoals(), [statsVersion]);
    const todayTotals = useMemo(
        () => sumDayForTabs(getDay(), new Set([String(tab.id)])),
        [statsVersion, tab.id],
    );
    const goalSummary = useMemo(
        () => evaluateGoalProgress(todayTotals.chars, todayTotals.seconds, activeGoals, false),
        [todayTotals.chars, todayTotals.seconds, activeGoals],
    );

    const [prefs, setPrefs] = useState<PdfPrefs>(readPdfPrefs);
    const updatePrefs = useCallback((patch: Partial<PdfPrefs>) => {
        setPrefs((prev) => {
            const next = { ...prev, ...patch };
            try {
                localStorage.setItem(PDF_PREFS_STORAGE_KEY, JSON.stringify(next));
            } catch {}
            return next;
        });
    }, []);

    const [pdfDoc, setPdfDoc] = useState<PDFDocumentProxy | null>(null);
    const [numPages, setNumPages] = useState(0);
    const [pageNumber, setPageNumber] = useState(initialPage);
    const [pageInput, setPageInput] = useState(String(initialPage));
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    const [viewMode, setViewMode] = useState<"page" | "text">("page");
    const [rotation, setRotation] = useState(0);
    const [viewportSize, setViewportSize] = useState({ width: 900, height: 700 });

    const [activePageLines, setActivePageLines] = useState<PdfTextLine[]>([]);
    const [outline, setOutline] = useState<PdfOutlineEntry[]>([]);
    const [tocOpen, setTocOpen] = useState(false);
    const [drawerTab, setDrawerTab] = useState<"toc" | "pages" | "bookmarks" | "notes">("toc");
    const [searchOpen, setSearchOpen] = useState(false);
    const [appearanceOpen, setAppearanceOpen] = useState(false);
    const [zenMode, setZenMode] = useState(false);

    const [searchQuery, setSearchQuery] = useState("");
    const [searchHits, setSearchHits] = useState<PdfSearchHit[]>([]);
    const [searching, setSearching] = useState(false);
    const [bookmarkLabelInput, setBookmarkLabelInput] = useState("");
    const [editingBookmarkId, setEditingBookmarkId] = useState<string | null>(null);
    const [editingBookmarkLabel, setEditingBookmarkLabel] = useState("");
    const [noteTitleInput, setNoteTitleInput] = useState("");
    const [noteBodyInput, setNoteBodyInput] = useState("");
    const [selectionPill, setSelectionPill] = useState<{ x: number; y: number; text: string } | null>(null);

    const [topHover, setTopHover] = useState(false);
    const [bottomHover, setBottomHover] = useState(false);
    const [lookupKeyHeld, setLookupKeyHeld] = useState(false);

    const stageRef = useRef<HTMLDivElement>(null);
    const viewportWrapRef = useRef<HTMLDivElement>(null);
    const drawerBodyRef = useRef<HTMLDivElement>(null);
    const topHideTimerRef = useRef<number | null>(null);
    const bottomHideTimerRef = useRef<number | null>(null);
    const lastPointerPosRef = useRef<{ x: number; y: number } | null>(null);
    const countedPagesRef = useRef<Set<number>>(new Set());
    const swipeStartRef = useRef<{ x: number; y: number; at: number } | null>(null);
    const pinchStartRef = useRef<{ dist: number; scale: number } | null>(null);
    const searchGenRef = useRef(0);
    const scrollTrackingSuppressRef = useRef(0);

    const onProgressRef = useRef(onProgressChange);
    onProgressRef.current = onProgressChange;
    const onUpdateMetaRef = useRef(onUpdateBookMeta);
    onUpdateMetaRef.current = onUpdateBookMeta;
    const onRecordStatsRef = useRef(onRecordReadingStats);
    onRecordStatsRef.current = onRecordReadingStats;

    const epubTheme = settings.epubTheme || "app";
    const volumeKeyPaging = settings.epubVolumeKeyPaging ?? true;
    const useSpread = !isMobile && viewMode === "page" && prefs.layout === "spread" && viewportSize.width >= SPREAD_MIN_WIDTH;
    const useScrollLayout = viewMode === "page" && prefs.layout === "scroll";

    useEffect(() => () => {
        if (topHideTimerRef.current !== null) window.clearTimeout(topHideTimerRef.current);
        if (bottomHideTimerRef.current !== null) window.clearTimeout(bottomHideTimerRef.current);
    }, []);

    // Track viewport container dimensions for responsive Fit Width / Fit Page & Spread
    useEffect(() => {
        const el = viewportWrapRef.current;
        if (!el) return;
        const measure = () => {
            const w = Math.max(260, Math.round(el.clientWidth));
            const h = Math.max(240, Math.round(el.clientHeight));
            setViewportSize((prev) => (prev.width === w && prev.height === h ? prev : { width: w, height: h }));
        };
        measure();
        const obs = new ResizeObserver(measure);
        obs.observe(el);
        return () => obs.disconnect();
    }, [loading, zenMode, immersive]);

    // Track lookup hotkey so floating bars auto-hide cleanly during desktop hover lookup
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
            ev.shiftKey === needShift && ev.ctrlKey === needCtrl && ev.altKey === needAlt && (!trigger || triggerDown);
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
    const topChromeVisible = !zenMode && !lookupActive && !escMenuOpen && ((isMobile && !immersive) || topHover || tocOpen || appearanceOpen || searchOpen);
    const bottomChromeVisible = !zenMode && !lookupActive && !escMenuOpen && ((isMobile && !immersive) || bottomHover);

    useEffect(() => {
        onOverlayStateChange?.(tocOpen || searchOpen || appearanceOpen || Boolean(selectionPill));
    }, [tocOpen, searchOpen, appearanceOpen, selectionPill, onOverlayStateChange]);

    useEffect(() => {
        if (closeOverlaySignal > 0) {
            setTocOpen(false);
            setSearchOpen(false);
            setAppearanceOpen(false);
            setSelectionPill(null);
        }
    }, [closeOverlaySignal]);

    useMobileBackHandler(
        isMobile && (Boolean(selectionPill) || appearanceOpen || searchOpen || tocOpen),
        MOBILE_BACK_PRIORITY.READER_OVERLAY,
        () => {
            if (selectionPill) {
                setSelectionPill(null);
                return;
            }
            if (appearanceOpen) {
                setAppearanceOpen(false);
                return;
            }
            if (searchOpen) {
                setSearchOpen(false);
                return;
            }
            if (tocOpen) {
                setTocOpen(false);
                return;
            }
            return false;
        },
    );

    // Load PDF binary from Tauri backend
    useEffect(() => {
        if (!bookPath) {
            setError(isEn ? "PDF file path is missing." : "Путь к PDF-файлу не найден.");
            setLoading(false);
            return;
        }
        let cancelled = false;
        let loadingTask: ReturnType<typeof pdfjsLib.getDocument> | null = null;
        setLoading(true);
        setError(null);
        setPdfDoc(null);
        setOutline([]);
        countedPagesRef.current = new Set();

        void (async () => {
            try {
                const bytes = await readBookBinary(bookPath);
                if (cancelled) return;
                const task = pdfjsLib.getDocument({
                    data: bytes,
                    useSystemFonts: true,
                });
                loadingTask = task;
                const doc = await task.promise;
                if (cancelled) {
                    void task.destroy();
                    return;
                }
                setPdfDoc(doc);
                setNumPages(doc.numPages);
                const clamped = clampPdfPage(initialPage, doc.numPages);
                setPageNumber(clamped);
                setPageInput(String(clamped));
                setLoading(false);

                const [metaRes, rawOutline] = await Promise.all([
                    doc.getMetadata().catch(() => null),
                    doc.getOutline().catch(() => null),
                ]);
                if (cancelled) return;

                const info = (metaRes?.info || {}) as Record<string, unknown>;
                const pdfTitle = typeof info.Title === "string" && info.Title.trim()
                    ? info.Title.trim()
                    : (tab.epub?.title || tab.name);
                const pdfAuthor = typeof info.Author === "string" && info.Author.trim()
                    ? info.Author.trim()
                    : null;

                const resolvedOutline: PdfOutlineEntry[] = [];
                const walkOutline = async (items: any[] | null | undefined, depth: number) => {
                    if (!items || resolvedOutline.length >= 250) return;
                    for (const item of items) {
                        if (cancelled || resolvedOutline.length >= 250) return;
                        let pageNo = 1;
                        try {
                            let dest = item.dest;
                            if (typeof dest === "string") {
                                dest = await doc.getDestination(dest);
                            }
                            if (Array.isArray(dest) && dest[0]) {
                                const idx = await doc.getPageIndex(dest[0]);
                                pageNo = idx + 1;
                            }
                        } catch {
                            pageNo = 1;
                        }
                        if (item.title) {
                            resolvedOutline.push({
                                title: String(item.title).trim(),
                                pageNumber: clampPdfPage(pageNo, doc.numPages),
                                depth,
                            });
                        }
                        if (Array.isArray(item.items) && item.items.length > 0) {
                            await walkOutline(item.items, depth + 1);
                        }
                    }
                };
                await walkOutline(rawOutline as any[], 0);
                if (!cancelled) {
                    setOutline(resolvedOutline);
                }

                let coverDataUrl: string | null = null;
                try {
                    const p1 = await doc.getPage(1);
                    const baseVp = p1.getViewport({ scale: 1 });
                    const thumbScale = Math.min(1, 320 / Math.max(1, baseVp.width));
                    const thumbVp = p1.getViewport({ scale: thumbScale });
                    const offCanvas = document.createElement("canvas");
                    offCanvas.width = Math.max(1, Math.round(thumbVp.width));
                    offCanvas.height = Math.max(1, Math.round(thumbVp.height));
                    const ctx = offCanvas.getContext("2d");
                    if (ctx) {
                        await p1.render({ canvasContext: ctx, viewport: thumbVp, canvas: offCanvas }).promise;
                        coverDataUrl = offCanvas.toDataURL("image/webp", 0.78);
                        setMemoryCover(bookPath, coverDataUrl);
                    }
                } catch {
                    coverDataUrl = null;
                }

                if (cancelled) return;
                const chapters = Array.from({ length: doc.numPages }, (_, idx) => ({
                    index: idx,
                    id: `pdf-p-${idx + 1}`,
                    href: `page-${idx + 1}.pdf`,
                    title: `${isEn ? "Page" : "Стр."} ${idx + 1}`,
                    charCount: 1,
                }));
                onUpdateMetaRef.current(tab.id, {
                    title: pdfTitle,
                    author: pdfAuthor,
                    series: tab.epub?.series ?? null,
                    seriesPosition: tab.epub?.seriesPosition ?? null,
                    language: tab.epub?.language || "en",
                    metadataLanguage: null,
                    pageProgressionDirection: null,
                    primaryWritingMode: null,
                    cssWritingMode: null,
                    defaultVertical: false,
                    chapters,
                    toc: resolvedOutline.map((o) => ({
                        title: o.title,
                        chapterIndex: o.pageNumber - 1,
                        startChar: o.pageNumber - 1,
                    })),
                    cover: coverDataUrl,
                    totalChars: doc.numPages,
                });
            } catch (err) {
                if (!cancelled) {
                    setError(String(err));
                    setLoading(false);
                }
            }
        })();

        return () => {
            cancelled = true;
            if (loadingTask) {
                void loadingTask.destroy();
            }
        };
    }, [bookPath, tab.id]);

    // Persist reading progress whenever page changes
    useEffect(() => {
        if (numPages <= 0) return;
        const clamped = clampPdfPage(pageNumber, numPages);
        setPageInput(String(clamped));
        const progress = numPages === 1 ? 1 : (clamped - 1) / (numPages - 1);
        onProgressRef.current(clamped - 1, 0, Math.min(1, Math.max(0, progress)));
    }, [pageNumber, numPages]);

    // Extract active page text in Text/Reflow mode (in Page mode PdfPageCanvas does it directly)
    useEffect(() => {
        if (!pdfDoc || numPages <= 0 || viewMode !== "text") return;
        let cancelled = false;
        void (async () => {
            try {
                const page = await pdfDoc.getPage(clampPdfPage(pageNumber, numPages));
                if (cancelled) return;
                const vp = page.getViewport({ scale: 1 });
                const tc = await page.getTextContent();
                if (cancelled) return;
                const rawItems: PdfTextItemLike[] = (tc.items as any[])
                    .filter((item) => item && typeof item.str === "string")
                    .map((item) => ({
                        str: item.str as string,
                        transform: item.transform as number[],
                        width: Number(item.width) || 0,
                        height: Number(item.height) || 0,
                        hasEOL: Boolean(item.hasEOL),
                    }));
                const grouped = groupPdfTextItemsIntoLines(rawItems, vp.transform);
                setActivePageLines(grouped);
            } catch {}
        })();
        return () => {
            cancelled = true;
        };
    }, [pdfDoc, numPages, pageNumber, viewMode]);

    // Reading time tracker
    useEffect(() => {
        if (!pdfDoc) return;
        const timer = window.setInterval(() => {
            if (document.visibilityState === "visible") {
                onRecordStatsRef.current?.(0, 15);
            }
        }, 15_000);
        return () => window.clearInterval(timer);
    }, [pdfDoc]);

    const handleLinesReady = useCallback((pNum: number, lines: PdfTextLine[]) => {
        if (pNum === pageNumber) {
            setActivePageLines(lines);
        }
        if (!countedPagesRef.current.has(pNum)) {
            countedPagesRef.current.add(pNum);
            const chars = lines.reduce((acc, l) => acc + l.text.replace(/\s+/g, "").length, 0);
            if (chars > 0) {
                onRecordStatsRef.current?.(chars, 0);
            }
        }
    }, [pageNumber]);

    const goToPage = useCallback((next: number) => {
        if (numPages <= 0) return;
        const clamped = clampPdfPage(next, numPages);
        setPageNumber(clamped);
        setSelectionPill(null);
        if (useScrollLayout && viewportWrapRef.current) {
            scrollTrackingSuppressRef.current = Date.now() + 500;
            const node = viewportWrapRef.current.querySelector<HTMLElement>(`[data-pdf-page="${clamped}"]`);
            node?.scrollIntoView({ block: "start", behavior: "auto" });
        } else {
            viewportWrapRef.current?.scrollTo({ top: 0, behavior: "auto" });
        }
    }, [numPages, useScrollLayout]);

    const handleZoomDelta = useCallback((delta: 1 | -1) => {
        const cur = prefs.scale;
        const nextStep = delta > 0
            ? ZOOM_STEPS.find((z) => z > cur + 0.03) ?? ZOOM_STEPS[ZOOM_STEPS.length - 1]
            : [...ZOOM_STEPS].reverse().find((z) => z < cur - 0.03) ?? ZOOM_STEPS[0];
        updatePrefs({ fitMode: "custom", scale: nextStep });
    }, [prefs.scale, updatePrefs]);

    // Ctrl+Wheel smooth zoom on Desktop
    useEffect(() => {
        const el = viewportWrapRef.current;
        if (!el || isMobile || viewMode !== "page") return;
        const onWheel = (event: WheelEvent) => {
            if (!event.ctrlKey && !event.metaKey) return;
            event.preventDefault();
            handleZoomDelta(event.deltaY < 0 ? 1 : -1);
        };
        el.addEventListener("wheel", onWheel, { passive: false });
        return () => el.removeEventListener("wheel", onWheel);
    }, [isMobile, viewMode, handleZoomDelta]);

    // Keyboard shortcuts
    useEffect(() => {
        if (isMobile) return;
        const onKeyDown = (event: KeyboardEvent) => {
            if (escMenuOpen || event.defaultPrevented) return;
            const target = event.target;
            if (target instanceof Element && target.closest('input, textarea, select, [contenteditable="true"]')) {
                return;
            }
            const step = useSpread ? 2 : 1;
            if ((event.ctrlKey || event.metaKey) && event.code === "KeyF") {
                event.preventDefault();
                setTocOpen(false);
                setAppearanceOpen(false);
                setSearchOpen(true);
                return;
            }
            if (event.key === "Escape" && (tocOpen || searchOpen || appearanceOpen || selectionPill)) {
                event.preventDefault();
                setTocOpen(false);
                setSearchOpen(false);
                setAppearanceOpen(false);
                setSelectionPill(null);
                return;
            }
            if (event.ctrlKey || event.metaKey || event.altKey) return;
            if (event.key === "ArrowRight" || event.key === "PageDown") {
                if (!useScrollLayout) {
                    event.preventDefault();
                    goToPage(pageNumber + step);
                }
            } else if (event.key === "ArrowLeft" || event.key === "PageUp") {
                if (!useScrollLayout) {
                    event.preventDefault();
                    goToPage(pageNumber - step);
                }
            } else if (event.key === "+" || event.key === "=") {
                event.preventDefault();
                handleZoomDelta(1);
            } else if (event.key === "-") {
                event.preventDefault();
                handleZoomDelta(-1);
            } else if (event.key === "0") {
                event.preventDefault();
                updatePrefs({ fitMode: "fit-width" });
            } else if (event.code === "KeyZ") {
                event.preventDefault();
                setZenMode((v) => !v);
            } else if (event.code === "KeyB" && onChangeBookBookmarks) {
                event.preventDefault();
                setDrawerTab("bookmarks");
                setTocOpen(true);
            } else if (event.code === "KeyR" && readingPoint) {
                event.preventDefault();
                goToPage(readingPoint.chapterIndex + 1);
            } else if (event.code === "KeyO" && onChangeReadingPoint) {
                event.preventDefault();
                const excerpt = activePageLines.slice(0, 2).map((l) => l.text).join(" ").trim().slice(0, 90);
                onChangeReadingPoint({
                    chapterIndex: pageNumber - 1,
                    paragraphIndex: 0,
                    chapterTitle: `${isEn ? "Page" : "Стр."} ${pageNumber}`,
                    excerpt,
                    savedAt: Date.now(),
                });
            }
        };
        window.addEventListener("keydown", onKeyDown);
        return () => window.removeEventListener("keydown", onKeyDown);
    }, [
        isMobile,
        escMenuOpen,
        useSpread,
        useScrollLayout,
        pageNumber,
        goToPage,
        handleZoomDelta,
        updatePrefs,
        tocOpen,
        searchOpen,
        appearanceOpen,
        selectionPill,
        onChangeBookBookmarks,
        readingPoint,
        onChangeReadingPoint,
        activePageLines,
        isEn,
    ]);

    // Android hardware volume-key paging
    useEffect(() => {
        if (!isMobile || useScrollLayout) return;
        const active = volumeKeyPaging && !lookupOpen && !escMenuOpen && !tocOpen && !appearanceOpen && !searchOpen;
        setMobileVolumePagingEnabled(active);
        if (!active) {
            return () => {
                setMobileVolumePagingEnabled(false);
            };
        }
        const onVolumeKey = (event: Event) => {
            const detail = (event as CustomEvent<string>).detail;
            if (detail === "down") goToPage(pageNumber + 1);
            else if (detail === "up") goToPage(pageNumber - 1);
        };
        window.addEventListener("setsuna-volume-key", onVolumeKey);
        return () => {
            window.removeEventListener("setsuna-volume-key", onVolumeKey);
            setMobileVolumePagingEnabled(false);
        };
    }, [isMobile, useScrollLayout, volumeKeyPaging, lookupOpen, escMenuOpen, tocOpen, appearanceOpen, searchOpen, pageNumber, goToPage]);

    // Hover chrome zone logic on Desktop
    const evaluateHoverZones = useCallback((clientX: number, clientY: number) => {
        const stage = stageRef.current;
        if (!stage) return;
        const rect = stage.getBoundingClientRect();
        const relY = clientY - rect.top;
        const relX = clientX - rect.left;
        const inside = relX >= 0 && relX <= rect.width && relY >= 0 && relY <= rect.height;
        const nearTop = inside && relY <= CHROME_TOP_ZONE_PX;
        const nearBottom = inside && relY >= rect.height - CHROME_BOTTOM_ZONE_PX;

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
    }, [topHover, bottomHover]);

    useEffect(() => {
        if (isMobile || lookupActive || escMenuOpen) return;
        const pos = lastPointerPosRef.current;
        if (pos) evaluateHoverZones(pos.x, pos.y);
    }, [isMobile, lookupActive, escMenuOpen, evaluateHoverZones]);

    // Selection floating pill
    const handleViewportMouseUp = useCallback(() => {
        const sel = window.getSelection();
        if (!sel || sel.isCollapsed) {
            setSelectionPill(null);
            return;
        }
        const selectedText = sel.toString().trim();
        if (!selectedText || selectedText.length > 600) {
            setSelectionPill(null);
            return;
        }
        const range = sel.rangeCount > 0 ? sel.getRangeAt(0) : null;
        const stage = stageRef.current;
        if (!range || !stage) return;
        const rect = range.getBoundingClientRect();
        const stageRect = stage.getBoundingClientRect();
        const x = Math.min(stageRect.width - 130, Math.max(130, rect.left + rect.width / 2 - stageRect.left));
        const y = Math.max(64, rect.top - stageRect.top - 12);
        setSelectionPill({ x, y, text: selectedText });
    }, []);

    const handleRunSearch = useCallback(async () => {
        const q = searchQuery.trim().toLowerCase();
        if (!pdfDoc || !q) {
            setSearchHits([]);
            return;
        }
        const gen = ++searchGenRef.current;
        setSearching(true);
        setSearchHits([]);
        const found: PdfSearchHit[] = [];
        try {
            for (let p = 1; p <= pdfDoc.numPages; p++) {
                if (searchGenRef.current !== gen || found.length >= 120) break;
                const page = await pdfDoc.getPage(p);
                const tc = await page.getTextContent();
                const joined = (tc.items as any[])
                    .map((it) => (typeof it?.str === "string" ? it.str : ""))
                    .join(" ")
                    .replace(/\s+/g, " ")
                    .trim();
                const snippet = buildPdfSearchSnippet(joined, q);
                if (snippet) {
                    found.push({ pageNumber: p, snippet });
                    if (found.length <= 20 || found.length % 10 === 0) {
                        setSearchHits([...found]);
                    }
                }
            }
            if (searchGenRef.current === gen) {
                setSearchHits(found);
            }
        } finally {
            if (searchGenRef.current === gen) {
                setSearching(false);
            }
        }
    }, [pdfDoc, searchQuery]);

    const handleAddBookmark = useCallback(() => {
        if (!onChangeBookBookmarks) return;
        const excerpt = activePageLines.slice(0, 2).map((l) => l.text).join(" ").replace(/\s+/g, " ").trim().slice(0, 90);
        const pageLabel = `${isEn ? "Page" : "Стр."} ${pageNumber}`;
        const bm: EpubBookmark = {
            id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
            label: bookmarkLabelInput.trim() || pageLabel,
            chapterIndex: pageNumber - 1,
            chapterTitle: pageLabel,
            paragraphIndex: 0,
            excerpt,
            createdAt: Date.now(),
        };
        onChangeBookBookmarks([bm, ...bookmarks]);
        setBookmarkLabelInput("");
    }, [onChangeBookBookmarks, activePageLines, isEn, pageNumber, bookmarkLabelInput, bookmarks]);

    const handleAddNote = useCallback((prefillBody?: string) => {
        if (!onChangeBookNotes) return;
        const body = (prefillBody ?? noteBodyInput).trim();
        const title = noteTitleInput.trim();
        if (!body && !title) return;
        const now = Date.now();
        const pageLabel = `${isEn ? "Page" : "Стр."} ${pageNumber}`;
        const note: EpubBookNote = {
            id: `note-${now}-${Math.random().toString(36).slice(2, 7)}`,
            title: title || pageLabel,
            body,
            chapterIndex: pageNumber - 1,
            chapterTitle: pageLabel,
            paragraphIndex: 0,
            createdAt: now,
            updatedAt: now,
        };
        onChangeBookNotes([note, ...notes]);
        setNoteTitleInput("");
        if (!prefillBody) setNoteBodyInput("");
    }, [onChangeBookNotes, noteBodyInput, noteTitleInput, isEn, pageNumber, notes]);

    const handleSaveReadingPoint = useCallback(() => {
        if (!onChangeReadingPoint) return;
        const excerpt = activePageLines.slice(0, 2).map((l) => l.text).join(" ").replace(/\s+/g, " ").trim().slice(0, 90);
        onChangeReadingPoint({
            chapterIndex: pageNumber - 1,
            paragraphIndex: 0,
            chapterTitle: `${isEn ? "Page" : "Стр."} ${pageNumber}`,
            excerpt,
            savedAt: Date.now(),
        });
    }, [onChangeReadingPoint, activePageLines, pageNumber, isEn]);

    const progressPct = useMemo(() => {
        if (numPages <= 0) return 0;
        return Math.round((pageNumber / numPages) * 100);
    }, [pageNumber, numPages]);

    const availStageWidth = Math.max(240, viewportSize.width - (isMobile ? 16 : 56));
    const availStageHeight = Math.max(240, viewportSize.height - (isMobile ? 132 : 148));
    const singlePageWidth = useSpread
        ? Math.max(220, Math.floor((availStageWidth - 20) / 2))
        : availStageWidth;

    const effectiveZoomLabel = prefs.fitMode === "fit-width"
        ? (isEn ? "Fit W" : "Шир.")
        : prefs.fitMode === "fit-page"
            ? (isEn ? "Fit P" : "Стр.")
            : `${Math.round(prefs.scale * 100)}%`;

    const allPagesArray = useMemo(() => {
        if (numPages <= 0) return [];
        return Array.from({ length: numPages }, (_, i) => i + 1);
    }, [numPages]);

    const scrollVisiblePageHandler = useCallback((pNum: number) => {
        if (Date.now() < scrollTrackingSuppressRef.current) return;
        setPageNumber((prev) => (prev === pNum ? prev : pNum));
    }, []);

    return (
        <div
            ref={stageRef}
            className={`pdf-reader-shell epub-theme-${epubTheme} pdf-color-${prefs.colorTheme}${isMobile ? " is-mobile" : ""}`}
            onMouseMove={(e) => {
                if (isMobile) return;
                lastPointerPosRef.current = { x: e.clientX, y: e.clientY };
                evaluateHoverZones(e.clientX, e.clientY);
            }}
            onMouseLeave={() => {
                if (isMobile) return;
                lastPointerPosRef.current = null;
                if (topHideTimerRef.current !== null) window.clearTimeout(topHideTimerRef.current);
                if (bottomHideTimerRef.current !== null) window.clearTimeout(bottomHideTimerRef.current);
                topHideTimerRef.current = window.setTimeout(() => { topHideTimerRef.current = null; setTopHover(false); }, CHROME_HIDE_DELAY_MS);
                bottomHideTimerRef.current = window.setTimeout(() => { bottomHideTimerRef.current = null; setBottomHover(false); }, CHROME_HIDE_DELAY_MS);
            }}
        >
            {/* Floating glass top toolbar */}
            <div className={`epub-floating-top pdf-floating-top${isMobile ? " is-mobile" : ""}${topChromeVisible ? " is-visible" : " is-hidden"}`}>
                <div className="epub-glass-pill epub-glass-pill-main" onClick={(e) => e.stopPropagation()}>
                    <button
                        type="button"
                        className="epub-glass-btn epub-glass-circle"
                        onClick={onBackToLibrary}
                        title={t("epub.library")}
                        aria-label={t("epub.library")}
                    >
                        ←
                    </button>
                    <button
                        type="button"
                        className={`epub-glass-btn epub-glass-circle${tocOpen ? " is-active" : ""}`}
                        onClick={() => {
                            setAppearanceOpen(false);
                            setSearchOpen(false);
                            setTocOpen((v) => !v);
                        }}
                        title={t("epub.toc")}
                        aria-label={t("epub.toc")}
                    >
                        ☰
                    </button>
                    <span className="epub-toolbar-title">{tab.epub?.title || tab.name}</span>
                    <span className="epub-badge">PDF</span>
                </div>

                <div className="epub-glass-pill epub-glass-pill-tools" onClick={(e) => e.stopPropagation()}>
                    <button
                        type="button"
                        className={`epub-glass-btn epub-glass-circle${searchOpen ? " is-active" : ""}`}
                        onClick={() => {
                            setTocOpen(false);
                            setAppearanceOpen(false);
                            setSearchOpen((v) => !v);
                        }}
                        title={`${isEn ? "Search PDF" : "Поиск по PDF"} (Ctrl+F)`}
                    >
                        <IconSearch />
                    </button>

                    {onChangeBookBookmarks && (
                        <button
                            type="button"
                            className={`epub-glass-btn epub-glass-circle${tocOpen && drawerTab === "bookmarks" ? " is-active" : ""}`}
                            onClick={() => {
                                setAppearanceOpen(false);
                                setSearchOpen(false);
                                if (tocOpen && drawerTab === "bookmarks") setTocOpen(false);
                                else { setDrawerTab("bookmarks"); setTocOpen(true); }
                            }}
                            title={`${t("epub.bookmarks")} (B)`}
                        >
                            🔖
                        </button>
                    )}

                    {onChangeReadingPoint && (
                        <button
                            type="button"
                            className={`epub-glass-btn epub-glass-circle${readingPoint?.chapterIndex === pageNumber - 1 ? " is-active" : ""}`}
                            onClick={handleSaveReadingPoint}
                            title={`${t("epub.readingPoint")} (O)`}
                        >
                            ⌖
                        </button>
                    )}

                    <button
                        type="button"
                        className={`epub-glass-btn epub-aa-btn${viewMode === "text" ? " is-active" : ""}`}
                        onClick={() => setViewMode((m) => (m === "page" ? "text" : "page"))}
                        title={isEn ? "Toggle Page / Reflow Text view" : "Переключить Страница / Только текст"}
                    >
                        {viewMode === "page" ? (isEn ? "Text" : "Текст") : (isEn ? "Page" : "Стр.")}
                    </button>

                    {viewMode === "page" && !isMobile && (
                        <>
                            <button
                                type="button"
                                className="epub-glass-btn epub-glass-circle"
                                onClick={() => handleZoomDelta(-1)}
                                title={isEn ? "Zoom out" : "Уменьшить"}
                            >
                                −
                            </button>
                            <button
                                type="button"
                                className="epub-glass-btn epub-aa-btn"
                                onClick={() => updatePrefs({ fitMode: prefs.fitMode === "fit-width" ? "fit-page" : "fit-width" })}
                                title={isEn ? "Toggle Fit Width / Fit Page" : "По ширине / По странице"}
                            >
                                {effectiveZoomLabel}
                            </button>
                            <button
                                type="button"
                                className="epub-glass-btn epub-glass-circle"
                                onClick={() => handleZoomDelta(1)}
                                title={isEn ? "Zoom in" : "Увеличить"}
                            >
                                +
                            </button>
                        </>
                    )}

                    {!isMobile && (
                        <button
                            type="button"
                            className={`epub-glass-btn epub-glass-circle${zenMode ? " is-active" : ""}`}
                            onClick={() => setZenMode((v) => !v)}
                            title={`${t("epub.zenMode")} (Z)`}
                        >
                            ⛶
                        </button>
                    )}

                    <button
                        type="button"
                        className={`epub-glass-btn epub-aa-btn${appearanceOpen ? " is-active" : ""}`}
                        onClick={() => {
                            setTocOpen(false);
                            setSearchOpen(false);
                            setAppearanceOpen((v) => !v);
                        }}
                        title={t("epub.appearance")}
                    >
                        Aa
                    </button>
                </div>
            </div>

            {/* Aa Appearance & Layout Popover */}
            {appearanceOpen && (
                <div className={`epub-appearance-popover pdf-appearance-popover${isMobile ? " is-mobile" : ""}`} onClick={(e) => e.stopPropagation()}>
                    <div className="epub-pop-head">
                        <strong>{t("epub.appearance")}</strong>
                        <button type="button" className="epub-glass-btn epub-glass-circle" onClick={() => setAppearanceOpen(false)}>
                            <IconClose />
                        </button>
                    </div>

                    {viewMode === "page" ? (
                        <>
                            <div className="epub-pop-row">
                                <span className="epub-pop-label">{isEn ? "Layout" : "Режим"}</span>
                                <div className="epub-segmented">
                                    {(["paged", "spread", "scroll"] as const)
                                        .filter((m) => !(isMobile && m === "spread"))
                                        .map((mode) => (
                                            <button
                                                key={mode}
                                                type="button"
                                                className={`epub-seg-btn${prefs.layout === mode ? " is-active" : ""}`}
                                                onClick={() => updatePrefs({ layout: mode })}
                                            >
                                                {mode === "paged"
                                                    ? (isEn ? "Page" : "Стр.")
                                                    : mode === "spread"
                                                        ? (isEn ? "Spread" : "Разворот")
                                                        : (isEn ? "Scroll" : "Скролл")}
                                            </button>
                                        ))}
                                </div>
                            </div>

                            <div className="epub-pop-row">
                                <span className="epub-pop-label">{isEn ? "Fit" : "Масштаб"}</span>
                                <div className="epub-segmented">
                                    <button
                                        type="button"
                                        className={`epub-seg-btn${prefs.fitMode === "fit-width" ? " is-active" : ""}`}
                                        onClick={() => updatePrefs({ fitMode: "fit-width" })}
                                    >
                                        {isEn ? "Width" : "Ширина"}
                                    </button>
                                    <button
                                        type="button"
                                        className={`epub-seg-btn${prefs.fitMode === "fit-page" ? " is-active" : ""}`}
                                        onClick={() => updatePrefs({ fitMode: "fit-page" })}
                                    >
                                        {isEn ? "Page" : "Страница"}
                                    </button>
                                </div>
                            </div>

                            <div className="epub-pop-slider-group">
                                <div className="epub-pop-slider-head">
                                    <span className="epub-pop-label">{isEn ? "Zoom" : "Приближение"}</span>
                                    <span className="epub-pop-val">{Math.round(prefs.scale * 100)}%</span>
                                </div>
                                <input
                                    type="range"
                                    min={50}
                                    max={250}
                                    step={5}
                                    value={Math.round(prefs.scale * 100)}
                                    onChange={(e) => updatePrefs({ fitMode: "custom", scale: Number(e.target.value) / 100 })}
                                />
                            </div>

                            <div className="epub-pop-row">
                                <span className="epub-pop-label">{isEn ? "Rotate" : "Поворот"}</span>
                                <div className="epub-segmented">
                                    <button
                                        type="button"
                                        className="epub-seg-btn"
                                        onClick={() => setRotation((r) => (r + 270) % 360)}
                                    >
                                        ↺ 90°
                                    </button>
                                    <button
                                        type="button"
                                        className="epub-seg-btn"
                                        onClick={() => setRotation((r) => (r + 90) % 360)}
                                    >
                                        ↻ 90°
                                    </button>
                                </div>
                            </div>

                            <div className="epub-pop-row epub-pop-themes-row">
                                <span className="epub-pop-label">{t("epub.theme")}</span>
                                <div className="epub-theme-swatches">
                                    {([
                                        { value: "original", swatch: "#ffffff", fg: "#18181b", label: isEn ? "Original" : "Оригинал" },
                                        { value: "sepia", swatch: "#f1e5cb", fg: "#4a3822", label: isEn ? "Sepia" : "Сепия" },
                                        { value: "dark", swatch: "#1a1d24", fg: "#e2e6ef", label: isEn ? "Dark" : "Тёмная" },
                                        { value: "eink", swatch: "#f8f8f8", fg: "#000000", label: "E-Ink" },
                                    ] as const).map((item) => (
                                        <button
                                            key={item.value}
                                            type="button"
                                            className={`epub-theme-swatch${prefs.colorTheme === item.value ? " is-active" : ""}`}
                                            style={{ background: item.swatch, color: item.fg }}
                                            title={item.label}
                                            onClick={() => updatePrefs({ colorTheme: item.value })}
                                        >
                                            A
                                        </button>
                                    ))}
                                </div>
                            </div>
                        </>
                    ) : (
                        <>
                            {onUpdateSettings && (
                                <div className="epub-pop-slider-group">
                                    <div className="epub-pop-slider-head">
                                        <span className="epub-pop-label">{t("epub.fontSize")}</span>
                                        <span className="epub-pop-val">{settings.epubFontSize || 20} px</span>
                                    </div>
                                    <input
                                        type="range"
                                        min={14}
                                        max={34}
                                        step={1}
                                        value={settings.epubFontSize || 20}
                                        onChange={(e) => onUpdateSettings({ epubFontSize: Number(e.target.value) })}
                                    />
                                </div>
                            )}
                            <div className="epub-pop-row">
                                <span className="epub-pop-label">{isEn ? "Direction" : "Направление"}</span>
                                <div className="epub-segmented">
                                    <button
                                        type="button"
                                        className={`epub-seg-btn${prefs.reflowOrientation === "horizontal" ? " is-active" : ""}`}
                                        onClick={() => updatePrefs({ reflowOrientation: "horizontal" })}
                                    >
                                        横 {isEn ? "Horiz" : "Гориз."}
                                    </button>
                                    <button
                                        type="button"
                                        className={`epub-seg-btn${prefs.reflowOrientation === "vertical" ? " is-active" : ""}`}
                                        onClick={() => updatePrefs({ reflowOrientation: "vertical" })}
                                    >
                                        縦 {isEn ? "Vert" : "Верт."}
                                    </button>
                                </div>
                            </div>
                        </>
                    )}

                    {isMobile && onUpdateSettings && (
                        <label className="epub-pop-row epub-pop-check-row">
                            <span className="epub-pop-label">{t("epub.volumeKeyPaging")}</span>
                            <input
                                type="checkbox"
                                checked={volumeKeyPaging}
                                onChange={(e) => onUpdateSettings({ epubVolumeKeyPaging: e.target.checked })}
                            />
                        </label>
                    )}
                </div>
            )}

            {/* 4-Tab Drawer: Outline / Pages / Bookmarks / Notes */}
            {tocOpen && (
                <div className="pdf-drawer-backdrop" onClick={() => setTocOpen(false)}>
                    <aside className="pdf-drawer" onClick={(e) => e.stopPropagation()}>
                        <header className="pdf-drawer-head">
                            <div className="epub-segmented">
                                <button
                                    type="button"
                                    className={`epub-seg-btn${drawerTab === "toc" ? " is-active" : ""}`}
                                    onClick={() => setDrawerTab("toc")}
                                >
                                    {t("epub.toc")}
                                </button>
                                <button
                                    type="button"
                                    className={`epub-seg-btn${drawerTab === "pages" ? " is-active" : ""}`}
                                    onClick={() => setDrawerTab("pages")}
                                >
                                    {isEn ? "Pages" : "Стр."}
                                </button>
                                {onChangeBookBookmarks && (
                                    <button
                                        type="button"
                                        className={`epub-seg-btn${drawerTab === "bookmarks" ? " is-active" : ""}`}
                                        onClick={() => setDrawerTab("bookmarks")}
                                    >
                                        🔖{bookmarks.length > 0 ? ` ${bookmarks.length}` : ""}
                                    </button>
                                )}
                                {onChangeBookNotes && (
                                    <button
                                        type="button"
                                        className={`epub-seg-btn${drawerTab === "notes" ? " is-active" : ""}`}
                                        onClick={() => setDrawerTab("notes")}
                                    >
                                        ✎{notes.length > 0 ? ` ${notes.length}` : ""}
                                    </button>
                                )}
                            </div>
                            <button type="button" className="epub-glass-btn epub-glass-circle" onClick={() => setTocOpen(false)}>
                                <IconClose />
                            </button>
                        </header>

                        <div ref={drawerBodyRef} className="pdf-drawer-body">
                            {drawerTab === "toc" && (
                                outline.length === 0 ? (
                                    <p className="pdf-drawer-empty">
                                        {isEn ? "This PDF has no outline bookmarks." : "У этого PDF нет встроенного оглавления."}
                                    </p>
                                ) : (
                                    outline.map((entry, idx) => (
                                        <button
                                            key={`${entry.pageNumber}-${idx}`}
                                            type="button"
                                            className={`pdf-outline-item${entry.pageNumber === pageNumber ? " is-active" : ""}`}
                                            style={{ paddingLeft: `${12 + Math.min(entry.depth, 4) * 14}px` }}
                                            onClick={() => {
                                                goToPage(entry.pageNumber);
                                                setTocOpen(false);
                                            }}
                                        >
                                            <span className="pdf-outline-title">{entry.title}</span>
                                            <span className="pdf-outline-page">{entry.pageNumber}</span>
                                        </button>
                                    ))
                                )
                            )}

                            {drawerTab === "pages" && pdfDoc && (
                                <div className="pdf-thumb-grid">
                                    {allPagesArray.map((pNum) => (
                                        <PdfThumbnailTile
                                            key={pNum}
                                            pdfDoc={pdfDoc}
                                            pageNumber={pNum}
                                            active={pNum === pageNumber}
                                            scrollRoot={drawerBodyRef.current}
                                            onSelect={(targetPage) => {
                                                goToPage(targetPage);
                                                setTocOpen(false);
                                            }}
                                        />
                                    ))}
                                </div>
                            )}

                            {drawerTab === "bookmarks" && (
                                <div className="epub-bookmarks-pane">
                                    <form
                                        className="epub-bookmark-add-form"
                                        onSubmit={(e) => {
                                            e.preventDefault();
                                            handleAddBookmark();
                                        }}
                                    >
                                        <input
                                            type="text"
                                            className="epub-bookmark-input"
                                            value={bookmarkLabelInput}
                                            onChange={(e) => setBookmarkLabelInput(e.target.value)}
                                            placeholder={t("epub.bookmarkPlaceholder")}
                                        />
                                        <button type="submit" className="btn-primary epub-bookmark-add-btn">
                                            {t("epub.addBookmark")}
                                        </button>
                                    </form>
                                    {bookmarks.length === 0 ? (
                                        <div className="epub-bookmarks-empty">{t("epub.noBookmarks")}</div>
                                    ) : (
                                        bookmarks.map((bm) => (
                                            <div key={bm.id} className="epub-bookmark-card">
                                                {editingBookmarkId === bm.id ? (
                                                    <form
                                                        className="epub-bookmark-rename-form"
                                                        onSubmit={(e) => {
                                                            e.preventDefault();
                                                            const nextLabel = editingBookmarkLabel.trim();
                                                            if (nextLabel && onChangeBookBookmarks) {
                                                                onChangeBookBookmarks(bookmarks.map((x) => (x.id === bm.id ? { ...x, label: nextLabel } : x)));
                                                            }
                                                            setEditingBookmarkId(null);
                                                        }}
                                                    >
                                                        <input
                                                            type="text"
                                                            className="epub-bookmark-input"
                                                            autoFocus
                                                            value={editingBookmarkLabel}
                                                            onChange={(e) => setEditingBookmarkLabel(e.target.value)}
                                                            onBlur={() => setEditingBookmarkId(null)}
                                                        />
                                                    </form>
                                                ) : (
                                                    <button
                                                        type="button"
                                                        className="epub-bookmark-jump"
                                                        onClick={() => {
                                                            goToPage(bm.chapterIndex + 1);
                                                            setTocOpen(false);
                                                        }}
                                                    >
                                                        <span className="epub-bookmark-title">{bm.label}</span>
                                                        <span className="epub-bookmark-meta">
                                                            {bm.chapterTitle || `${isEn ? "Page" : "Стр."} ${bm.chapterIndex + 1}`}
                                                        </span>
                                                        {bm.excerpt && <span className="epub-bookmark-excerpt">{bm.excerpt}</span>}
                                                    </button>
                                                )}
                                                <div className="epub-bookmark-actions">
                                                    <button
                                                        type="button"
                                                        className="epub-glass-btn epub-bookmark-act-btn"
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
                                                        onClick={() => onChangeBookBookmarks?.(bookmarks.filter((x) => x.id !== bm.id))}
                                                    >
                                                        <IconClose />
                                                    </button>
                                                </div>
                                            </div>
                                        ))
                                    )}
                                </div>
                            )}

                            {drawerTab === "notes" && (
                                <div className="epub-bookmarks-pane epub-notes-pane">
                                    <form
                                        className="epub-note-add-form"
                                        onSubmit={(e) => {
                                            e.preventDefault();
                                            handleAddNote();
                                        }}
                                    >
                                        <input
                                            type="text"
                                            className="epub-bookmark-input"
                                            value={noteTitleInput}
                                            onChange={(e) => setNoteTitleInput(e.target.value)}
                                            placeholder={t("epub.noteTitlePlaceholder")}
                                        />
                                        <textarea
                                            className="epub-note-textarea"
                                            rows={2}
                                            value={noteBodyInput}
                                            onChange={(e) => setNoteBodyInput(e.target.value)}
                                            placeholder={t("epub.noteBodyPlaceholder")}
                                        />
                                        <button type="submit" className="btn-primary epub-bookmark-add-btn">
                                            {t("epub.addNote")}
                                        </button>
                                    </form>
                                    {notes.length === 0 ? (
                                        <div className="epub-bookmarks-empty">{t("epub.noNotes")}</div>
                                    ) : (
                                        notes.map((note) => (
                                            <div key={note.id} className="epub-bookmark-card">
                                                <button
                                                    type="button"
                                                    className="epub-bookmark-jump"
                                                    onClick={() => {
                                                        if (typeof note.chapterIndex === "number") {
                                                            goToPage(note.chapterIndex + 1);
                                                            setTocOpen(false);
                                                        }
                                                    }}
                                                >
                                                    <span className="epub-bookmark-title">{note.title}</span>
                                                    {note.chapterTitle && <span className="epub-bookmark-meta">{note.chapterTitle}</span>}
                                                    {note.body && <span className="epub-bookmark-excerpt">{note.body}</span>}
                                                </button>
                                                <div className="epub-bookmark-actions">
                                                    <button
                                                        type="button"
                                                        className="epub-glass-btn epub-bookmark-act-btn is-danger"
                                                        onClick={() => onChangeBookNotes?.(notes.filter((x) => x.id !== note.id))}
                                                    >
                                                        <IconClose />
                                                    </button>
                                                </div>
                                            </div>
                                        ))
                                    )}
                                </div>
                            )}
                        </div>
                    </aside>
                </div>
            )}

            {/* Search Drawer */}
            {searchOpen && (
                <div className="pdf-drawer-backdrop" onClick={() => setSearchOpen(false)}>
                    <aside className="pdf-drawer" onClick={(e) => e.stopPropagation()}>
                        <header className="pdf-drawer-head">
                            <strong>{isEn ? "Search PDF" : "Поиск по PDF"}</strong>
                            <button type="button" className="epub-glass-btn epub-glass-circle" onClick={() => setSearchOpen(false)}>
                                <IconClose />
                            </button>
                        </header>
                        <form
                            className="pdf-search-form"
                            onSubmit={(e) => {
                                e.preventDefault();
                                void handleRunSearch();
                            }}
                        >
                            <input
                                type="text"
                                value={searchQuery}
                                onChange={(e) => setSearchQuery(e.target.value)}
                                placeholder={isEn ? "Search text in PDF..." : "Найти текст в PDF..."}
                                autoFocus
                            />
                            <button type="submit" disabled={searching || !searchQuery.trim()}>
                                {searching ? "…" : (isEn ? "Find" : "Найти")}
                            </button>
                        </form>
                        <div className="pdf-drawer-body">
                            {searchHits.length === 0 && !searching ? (
                                <p className="pdf-drawer-empty">
                                    {searchQuery.trim()
                                        ? (isEn ? "No matches found." : "Совпадений не найдено.")
                                        : (isEn ? "Enter a word or phrase to search." : "Введите слово или фразу для поиска.")}
                                </p>
                            ) : (
                                searchHits.map((hit, idx) => (
                                    <button
                                        key={`${hit.pageNumber}-${idx}`}
                                        type="button"
                                        className="pdf-search-hit"
                                        onClick={() => {
                                            goToPage(hit.pageNumber);
                                            setSearchOpen(false);
                                        }}
                                    >
                                        <span className="pdf-search-hit-page">
                                            {isEn ? `Page ${hit.pageNumber}` : `Стр. ${hit.pageNumber}`}
                                        </span>
                                        <span className="pdf-search-hit-snippet">{hit.snippet}</span>
                                    </button>
                                ))
                            )}
                        </div>
                    </aside>
                </div>
            )}

            {/* Main PDF Viewport */}
            <div
                ref={viewportWrapRef}
                className="pdf-viewport-scroll"
                onMouseUp={handleViewportMouseUp}
                onClick={(e) => {
                    if (appearanceOpen) setAppearanceOpen(false);
                    if (selectionPill) setSelectionPill(null);
                    const sel = window.getSelection();
                    if (sel && !sel.isCollapsed && sel.toString().trim().length > 0) return;

                    const target = e.target as HTMLElement | null;
                    if (target?.closest("button, input, textarea, .pdf-text-span")) return;

                    if (viewMode === "page" && !useScrollLayout && viewportWrapRef.current) {
                        const rect = viewportWrapRef.current.getBoundingClientRect();
                        const relX = e.clientX - rect.left;
                        const edgePx = Math.min(86, rect.width * 0.14);
                        const step = useSpread ? 2 : 1;
                        if (relX <= edgePx) {
                            goToPage(pageNumber - step);
                            return;
                        }
                        if (relX >= rect.width - edgePx) {
                            goToPage(pageNumber + step);
                            return;
                        }
                    }

                    if (isMobile && !tocOpen && !searchOpen && !appearanceOpen && !lookupOpen) {
                        onToggleImmersive?.();
                    }
                }}
                onTouchStart={(e) => {
                    if (e.touches.length === 2 && viewMode === "page") {
                        const dx = e.touches[0].clientX - e.touches[1].clientX;
                        const dy = e.touches[0].clientY - e.touches[1].clientY;
                        pinchStartRef.current = { dist: Math.hypot(dx, dy), scale: prefs.scale };
                        swipeStartRef.current = null;
                        return;
                    }
                    pinchStartRef.current = null;
                    if (e.touches.length === 1 && !useScrollLayout) {
                        swipeStartRef.current = {
                            x: e.touches[0].clientX,
                            y: e.touches[0].clientY,
                            at: Date.now(),
                        };
                    }
                }}
                onTouchMove={(e) => {
                    const pinch = pinchStartRef.current;
                    if (pinch && e.touches.length === 2 && viewMode === "page") {
                        const dx = e.touches[0].clientX - e.touches[1].clientX;
                        const dy = e.touches[0].clientY - e.touches[1].clientY;
                        const dist = Math.hypot(dx, dy);
                        const nextScale = computePinchScale(pinch.dist, dist, pinch.scale);
                        updatePrefs({ fitMode: "custom", scale: nextScale });
                    }
                }}
                onTouchEnd={(e) => {
                    pinchStartRef.current = null;
                    const start = swipeStartRef.current;
                    swipeStartRef.current = null;
                    if (!start || useScrollLayout || e.changedTouches.length !== 1) return;
                    const dx = e.changedTouches[0].clientX - start.x;
                    const dy = e.changedTouches[0].clientY - start.y;
                    if (Date.now() - start.at < 450 && Math.abs(dx) > 64 && Math.abs(dx) > Math.abs(dy) * 1.5) {
                        goToPage(dx < 0 ? pageNumber + 1 : pageNumber - 1);
                    }
                }}
            >
                {loading && (
                    <div className="pdf-status-card">
                        {isEn ? "Loading PDF…" : "Загрузка PDF…"}
                    </div>
                )}

                {error && !loading && (
                    <div className="pdf-status-card is-error">
                        <p>{error}</p>
                        <button type="button" onClick={onBackToLibrary}>
                            {t("epub.library")}
                        </button>
                    </div>
                )}

                {!loading && !error && pdfDoc && viewMode === "page" && useScrollLayout && (
                    <div className="pdf-scroll-stack">
                        {allPagesArray.map((pNum) => (
                            <PdfPageCanvas
                                key={pNum}
                                pdfDoc={pdfDoc}
                                pageNumber={pNum}
                                rotation={rotation}
                                fitMode={prefs.fitMode}
                                customScale={prefs.scale}
                                availWidth={availStageWidth}
                                availHeight={availStageHeight}
                                isMobile={isMobile}
                                lazy
                                scrollRoot={viewportWrapRef.current}
                                onLookupToken={onLookupToken}
                                onLinesReady={handleLinesReady}
                                onVisiblePage={scrollVisiblePageHandler}
                            />
                        ))}
                    </div>
                )}

                {!loading && !error && pdfDoc && viewMode === "page" && !useScrollLayout && (
                    <div className={useSpread ? "pdf-spread-row" : "pdf-single-wrap"}>
                        <PdfPageCanvas
                            pdfDoc={pdfDoc}
                            pageNumber={pageNumber}
                            rotation={rotation}
                            fitMode={prefs.fitMode}
                            customScale={prefs.scale}
                            availWidth={singlePageWidth}
                            availHeight={availStageHeight}
                            isMobile={isMobile}
                            onLookupToken={onLookupToken}
                            onLinesReady={handleLinesReady}
                        />
                        {useSpread && pageNumber + 1 <= numPages && (
                            <PdfPageCanvas
                                pdfDoc={pdfDoc}
                                pageNumber={pageNumber + 1}
                                rotation={rotation}
                                fitMode={prefs.fitMode}
                                customScale={prefs.scale}
                                availWidth={singlePageWidth}
                                availHeight={availStageHeight}
                                isMobile={isMobile}
                                onLookupToken={onLookupToken}
                                onLinesReady={handleLinesReady}
                            />
                        )}
                    </div>
                )}

                {!loading && !error && viewMode === "text" && (
                    <div
                        className={`pdf-reflow-surface${prefs.reflowOrientation === "vertical" ? " is-vertical" : ""}`}
                        style={{
                            fontSize: `${settings.epubFontSize || 20}px`,
                            lineHeight: settings.epubLineHeight || 1.65,
                            fontFamily: settings.epubFontFamily,
                            maxWidth: prefs.reflowOrientation === "vertical" ? "none" : `${settings.epubMaxWidth || 860}px`,
                        }}
                    >
                        {activePageLines.length === 0 ? (
                            <p className="pdf-drawer-empty">
                                {isEn
                                    ? "No embedded text layer found on this page (scanned image PDF)."
                                    : "На этой странице нет текстового слоя (похоже на скан-PDF)."}
                            </p>
                        ) : (
                            activePageLines.map((line, idx) => (
                                <div key={`${pageNumber}-${idx}`} className="pdf-reflow-line">
                                    <TokenizedLine
                                        text={line.text}
                                        searchQuery=""
                                        onLookupToken={onLookupToken}
                                        furiganaMode="off"
                                    />
                                </div>
                            ))
                        )}
                    </div>
                )}
            </div>

            {/* Selection Floating Action Pill */}
            {selectionPill && (
                <div
                    className="epub-selection-pill pdf-selection-pill"
                    style={{ left: `${selectionPill.x}px`, top: `${selectionPill.y}px` }}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={(e) => e.stopPropagation()}
                >
                    {onLookupToken && (
                        <button
                            type="button"
                            className="epub-glass-btn"
                            onClick={() => {
                                void onLookupToken(selectionPill.text, selectionPill.text, 0);
                                setSelectionPill(null);
                            }}
                        >
                            {isEn ? "Lookup" : "Словарь"}
                        </button>
                    )}
                    <button
                        type="button"
                        className="epub-glass-btn"
                        onClick={() => {
                            void navigator.clipboard?.writeText(selectionPill.text).catch(() => {});
                            setSelectionPill(null);
                            window.getSelection()?.removeAllRanges();
                        }}
                    >
                        {isEn ? "Copy" : "Копир."}
                    </button>
                    {onChangeBookNotes && (
                        <button
                            type="button"
                            className="epub-glass-btn"
                            onClick={() => {
                                handleAddNote(selectionPill.text);
                                setSelectionPill(null);
                                window.getSelection()?.removeAllRanges();
                            }}
                        >
                            + {t("epub.notes")}
                        </button>
                    )}
                </div>
            )}

            {/* Floating bottom navigation capsule with interactive scrubber */}
            {numPages > 0 && (
                <div
                    className={`epub-floating-bottom pdf-floating-bottom${isMobile ? " is-mobile" : ""}${bottomChromeVisible ? " is-visible" : " is-hidden"}`}
                    onClick={(e) => e.stopPropagation()}
                >
                    <div className="epub-glass-pill epub-nav-capsule pdf-nav-capsule">
                        <button
                            type="button"
                            className="epub-glass-btn epub-glass-circle"
                            disabled={pageNumber <= 1}
                            onClick={() => goToPage(pageNumber - (useSpread ? 2 : 1))}
                            title={t("epub.prevPage")}
                        >
                            «
                        </button>
                        <form
                            className="pdf-page-jump"
                            onSubmit={(e) => {
                                e.preventDefault();
                                const parsed = Number.parseInt(pageInput, 10);
                                if (Number.isFinite(parsed)) goToPage(parsed);
                            }}
                        >
                            <input
                                type="text"
                                inputMode="numeric"
                                className="pdf-page-input"
                                value={pageInput}
                                onChange={(e) => setPageInput(e.target.value)}
                                onBlur={() => {
                                    const parsed = Number.parseInt(pageInput, 10);
                                    if (Number.isFinite(parsed) && parsed !== pageNumber) goToPage(parsed);
                                    else setPageInput(String(pageNumber));
                                }}
                                aria-label={isEn ? "Page number" : "Номер страницы"}
                            />
                            <span className="pdf-page-total">/ {numPages} · {progressPct}%</span>
                        </form>
                        {!isMobile && numPages > 1 && (
                            <input
                                type="range"
                                className="pdf-scrubber"
                                min={1}
                                max={numPages}
                                value={pageNumber}
                                onChange={(e) => goToPage(Number(e.target.value))}
                                aria-label={isEn ? "Jump to page" : "Переход к странице"}
                            />
                        )}
                        <button
                            type="button"
                            className="epub-glass-btn epub-glass-circle"
                            disabled={pageNumber >= numPages}
                            onClick={() => goToPage(pageNumber + (useSpread ? 2 : 1))}
                            title={t("epub.nextPage")}
                        >
                            »
                        </button>
                        {readingPoint && (
                            <button
                                type="button"
                                className="epub-glass-btn epub-glass-circle"
                                title={t("epub.returnToPoint")}
                                onClick={() => goToPage(readingPoint.chapterIndex + 1)}
                            >
                                ↩
                            </button>
                        )}
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
            )}

            {/* Corner status readout when chrome is hidden */}
            {!zenMode && !bottomChromeVisible && !lookupActive && !escMenuOpen && numPages > 0 && (
                <button
                    type="button"
                    className="epub-corner-status"
                    onClick={(e) => {
                        e.stopPropagation();
                        onOpenStats?.();
                    }}
                >
                    <span className="epub-corner-progress">
                        {pageNumber} / {numPages} · {progressPct}%
                    </span>
                    {activeGoals.enabled && <span className={`epub-goal-dot is-${goalSummary.status}`} />}
                </button>
            )}
        </div>
    );
}
