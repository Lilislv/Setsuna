import {
    memo,
    useCallback,
    useEffect,
    useLayoutEffect,
    useMemo,
    useRef,
    useState,
    type CSSProperties,
    type MouseEvent as ReactMouseEvent,
    type TouchEvent as ReactTouchEvent,
} from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { AppSettings } from "../../components/SettingsModal";
import type { EpubBookmark, Tab } from "../../utils/constants";
import { getTranslator } from "../../utils/i18n";
import { TokenizedLine } from "../../components/TextContainer";
import { IconBookTab, IconClose, IconImport, IconSearch } from "../../components/Icons";
import FontPicker from "../../components/FontPicker";
import { getDay, useDailyStatsVersion } from "../../utils/dailyStats";
import { searchEpubBook } from "./epubApi";
import EpubGalleryModal from "./EpubGalleryModal";
import EpubGlassSelect from "./EpubGlassSelect";
import EpubQuoteModal from "./EpubQuoteModal";
import { buildEpubFontPresets } from "./epubFonts";
import { applyParagraphHighlights } from "./epubHighlightDom";
import {
    clamp01,
    computeWeightedBookProgress,
    resolveEpubHrefTarget,
    resolveEpubOrientation,
    type EpubBlurImagesMode,
    type EpubBookMeta,
    type EpubBookNote,
    type EpubChapterContent,
    type EpubFuriganaMode,
    type EpubHighlight,
    type EpubHighlightColor,
    type EpubOrientationSetting,
    type EpubParagraph,
    type EpubReadingPoint,
    type EpubSearchHit,
    type EpubTextIndentMode,
} from "./epubModel";
import {
    computeChapterParagraphDelta,
    evaluateGoalProgress,
    loadEpubGoals,
    type EpubReadingGoals,
} from "./epubTracker";

type LookupMatch = { start: number; length: number };
type LookupTokenHandler = (
    token: string,
    sentence: string,
    cursor: number,
    boundaries?: number[],
    lemma?: string,
) => LookupMatch | null | void | Promise<LookupMatch | null | void>;

interface EpubReaderProps {
    tab: Tab;
    bookMeta: EpubBookMeta | null;
    chapter: EpubChapterContent | null;
    loading: boolean;
    error: string | null;
    settings: AppSettings;
    isMobile: boolean;
    lookupOpen?: boolean;
    escMenuOpen?: boolean;
    pendingFragment: string | null;
    pendingParagraphIndex: number | null;
    onFragmentHandled: () => void;
    onSelectChapter: (chapterIndex: number, fragment?: string, paragraphIndex?: number) => void;
    onProgressChange: (chapterIndex: number, chapterOffset: number, bookProgress: number) => void;
    onChangeBookOrientation: (orientation: EpubOrientationSetting) => void;
    onChangeBookBookmarks?: (bookmarks: EpubBookmark[]) => void;
    onChangeBookHighlights?: (highlights: EpubHighlight[]) => void;
    onChangeBookNotes?: (notes: EpubBookNote[]) => void;
    onChangeReadingPoint?: (point: EpubReadingPoint | null) => void;
    onRecordReadingStats?: (deltaChars: number, deltaSeconds: number) => void;
    onOpenStats?: () => void;
    coverDataUrl?: string | null;
    goals?: EpubReadingGoals;
    onUpdateSettings?: (patch: Partial<AppSettings>) => void;
    onLookupToken?: LookupTokenHandler;
    onBackToLibrary: () => void;
    onOpenFile: () => void;
    onOverlayStateChange?: (open: boolean) => void;
    closeOverlaySignal?: number;
    immersive?: boolean;
    onToggleImmersive?: () => void;
}

type PageRange = { start: number; end: number };
type EpubThemeOption = NonNullable<AppSettings["epubTheme"]>;
type EpubQuickThemeLabelKey =
    | "epub.themeApp"
    | "epub.themeDark"
    | "epub.themePaper"
    | "epub.themeSepia"
    | "epub.themeBlack";

const VIRTUALIZE_THRESHOLD = 160;
const PROGRESS_THROTTLE_MS = 350;
const WHEEL_PAGE_COOLDOWN_MS = 220;
const SPREAD_STORAGE_KEY = "setsuna-epub-spread";
const SPREAD_MIN_WIDTH = 1020;
const SPREAD_GAP = 57;
const CHROME_TOP_ZONE_PX = 76;
const CHROME_BOTTOM_ZONE_PX = 70;
const CHROME_HIDE_DELAY_MS = 320;
const EDGE_CLICK_RATIO = 0.12;
const EDGE_CLICK_MAX_PX = 130;

const QUICK_THEMES: Array<{ value: EpubThemeOption; labelKey: EpubQuickThemeLabelKey; swatch: string; fg: string }> = [
    { value: "app", labelKey: "epub.themeApp", swatch: "linear-gradient(135deg, #242933 50%, #f5f3ef 50%)", fg: "#ffffff" },
    { value: "dark", labelKey: "epub.themeDark", swatch: "#16191f", fg: "#e6e8ec" },
    { value: "paper", labelKey: "epub.themePaper", swatch: "#faf8f4", fg: "#1f2328" },
    { value: "sepia", labelKey: "epub.themeSepia", swatch: "#f4ecd8", fg: "#2b2419" },
    { value: "ttu-black", labelKey: "epub.themeBlack", swatch: "#000000", fg: "#e8eaed" },
];

const readStoredSpreadPreference = (): boolean => {
    try {
        const raw = localStorage.getItem(SPREAD_STORAGE_KEY);
        if (raw === "false") return false;
        return true;
    } catch {
        return true;
    }
};

const IconBookmarkSvg = () => (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
    </svg>
);

/**
 * Memoized desktop paragraph block.
 * React 19 unconditionally reassigns `domElement.innerHTML` whenever
 * `dangerouslySetInnerHTML` receives a fresh `{ __html }` object, which wipes
 * active text selections mid-drag and disconnects hover-scanned text nodes.
 * Memoizing both the component and the `{ __html }` object keeps DOM text
 * nodes completely untouched across parent re-renders.
 */
const EpubHtmlParagraph = memo(function EpubHtmlParagraph({
    index,
    id,
    anchorIds,
    className,
    html,
}: {
    index: number;
    id?: string;
    anchorIds?: string;
    className: string;
    html: string;
}) {
    const markup = useMemo(() => ({ __html: html }), [html]);
    return (
        <div
            id={id}
            data-paragraph-index={index}
            data-anchor-ids={anchorIds}
            className={className}
            dangerouslySetInnerHTML={markup}
        />
    );
});

const EpubImageBlock = memo(function EpubImageBlock({
    index,
    id,
    anchorIds,
    src,
    alt,
    blurred,
    revealLabel,
    onToggleReveal,
}: {
    index: number;
    id?: string;
    anchorIds?: string;
    src: string;
    alt: string;
    blurred?: boolean;
    revealLabel?: string;
    onToggleReveal?: (index: number) => void;
}) {
    return (
        <figure
            id={id}
            data-paragraph-index={index}
            data-anchor-ids={anchorIds}
            className={`epub-image-block${blurred ? " is-blurred" : ""}`}
            onClick={onToggleReveal ? (event) => {
                if (blurred) {
                    event.stopPropagation();
                    onToggleReveal(index);
                }
            } : undefined}
        >
            <img src={src} alt={alt} loading="lazy" />
            {blurred && revealLabel && (
                <button
                    type="button"
                    className="epub-image-reveal-pill"
                    onClick={(event) => {
                        event.stopPropagation();
                        onToggleReveal?.(index);
                    }}
                >
                    {revealLabel}
                </button>
            )}
        </figure>
    );
});

export default function EpubReader({
    tab,
    bookMeta,
    chapter,
    loading,
    error,
    settings,
    isMobile,
    lookupOpen = false,
    escMenuOpen = false,
    pendingFragment,
    pendingParagraphIndex,
    onFragmentHandled,
    onSelectChapter,
    onProgressChange,
    onChangeBookOrientation,
    onChangeBookBookmarks,
    onChangeBookHighlights,
    onChangeBookNotes,
    onChangeReadingPoint,
    onRecordReadingStats,
    onOpenStats,
    coverDataUrl,
    goals: externalGoals,
    onUpdateSettings,
    onLookupToken,
    onBackToLibrary,
    onOpenFile,
    onOverlayStateChange,
    closeOverlaySignal = 0,
    immersive = false,
    onToggleImmersive,
}: EpubReaderProps) {
    const language = settings.appLanguage || "ru";
    const t = getTranslator(language);
    const stageRef = useRef<HTMLDivElement>(null);
    const surfaceRef = useRef<HTMLDivElement>(null);
    const measurerRef = useRef<HTMLDivElement>(null);
    const searchInputRef = useRef<HTMLInputElement>(null);
    const lastProgressSentRef = useRef(0);
    const lastWheelPageRef = useRef(0);
    const restoringRef = useRef(false);
    const topHideTimerRef = useRef<number | null>(null);
    const bottomHideTimerRef = useRef<number | null>(null);
    const highlightTimerRef = useRef<number | null>(null);
    const swipeStartRef = useRef<{ x: number; y: number; at: number } | null>(null);
    const pageTurnDirRef = useRef<1 | -1 | 0>(0);
    const anchorParagraphRef = useRef<{ chapterIdx: number; paragraphIdx: number }>({ chapterIdx: -1, paragraphIdx: 0 });
    const callbacksRef = useRef({
        onFragmentHandled,
        onSelectChapter,
        onProgressChange,
        onLookupToken,
    });
    callbacksRef.current = {
        onFragmentHandled,
        onSelectChapter,
        onProgressChange,
        onLookupToken,
    };

    const [tocOpen, setTocOpen] = useState(false);
    const [drawerTab, setDrawerTab] = useState<"toc" | "bookmarks" | "notes">("toc");
    const [appearanceOpen, setAppearanceOpen] = useState(false);
    const [searchOpen, setSearchOpen] = useState(false);
    const [galleryOpen, setGalleryOpen] = useState(false);
    const [quoteModalText, setQuoteModalText] = useState<string | null>(null);
    const [zenMode, setZenMode] = useState(false);
    const [settingReadingPoint, setSettingReadingPoint] = useState(false);
    const [positionFrozen, setPositionFrozen] = useState(false);
    const [trackingPaused, setTrackingPaused] = useState(false);
    const [autoscrollActive, setAutoscrollActive] = useState(false);
    const [selectionPill, setSelectionPill] = useState<{ x: number; y: number; text: string; paragraphIndex: number } | null>(null);
    const [noteTitleInput, setNoteTitleInput] = useState("");
    const [noteBodyInput, setNoteBodyInput] = useState("");
    const [editingHighlightId, setEditingHighlightId] = useState<string | null>(null);
    const [editingHighlightNote, setEditingHighlightNote] = useState("");
    const [searchQuery, setSearchQuery] = useState("");
    const [searchHits, setSearchHits] = useState<EpubSearchHit[]>([]);
    const [searching, setSearching] = useState(false);
    const [bookmarkLabelInput, setBookmarkLabelInput] = useState("");
    const [editingBookmarkId, setEditingBookmarkId] = useState<string | null>(null);
    const [editingBookmarkLabel, setEditingBookmarkLabel] = useState("");
    const [revealedImages, setRevealedImages] = useState<Record<number, boolean>>({});
    const [highlightedParagraph, setHighlightedParagraph] = useState<number | null>(null);
    const [topHover, setTopHover] = useState(false);
    const [bottomHover, setBottomHover] = useState(false);
    const [edgeHover, setEdgeHover] = useState<"left" | "right" | null>(null);
    const [lookupKeyHeld, setLookupKeyHeld] = useState(false);
    const lastPointerPosRef = useRef<{ x: number; y: number } | null>(null);
    const [spreadEnabled, setSpreadEnabled] = useState<boolean>(readStoredSpreadPreference);
    const [pageRanges, setPageRanges] = useState<PageRange[]>([{ start: 0, end: 0 }]);
    const [currentPageIdx, setCurrentPageIdx] = useState(0);
    const [verticalPageInfo, setVerticalPageInfo] = useState({ current: 1, total: 1 });
    const [surfaceSize, setSurfaceSize] = useState({ width: 800, height: 600 });

    const bookPath = tab.epub?.path || "";
    const bookmarks = useMemo(() => tab.epub?.bookmarks || [], [tab.epub?.bookmarks]);
    const highlights = useMemo(() => tab.epub?.highlights || [], [tab.epub?.highlights]);
    const notes = useMemo(() => tab.epub?.notes || [], [tab.epub?.notes]);
    const readingPoint = tab.epub?.readingPoint || null;
    const statsVersion = useDailyStatsVersion();
    const activeGoals = useMemo(() => externalGoals || loadEpubGoals(), [externalGoals, statsVersion]);
    const lastActivityAtRef = useRef(Date.now());
    const pendingSecondsRef = useRef(0);
    const lastTrackedParaRef = useRef<{ chapterIdx: number; paragraphIdx: number } | null>(null);
    const positionFrozenRef = useRef(false);
    positionFrozenRef.current = positionFrozen;
    const onRecordStatsRef = useRef(onRecordReadingStats);
    onRecordStatsRef.current = onRecordReadingStats;

    useEffect(() => () => {
        if (topHideTimerRef.current !== null) window.clearTimeout(topHideTimerRef.current);
        if (bottomHideTimerRef.current !== null) window.clearTimeout(bottomHideTimerRef.current);
        if (highlightTimerRef.current !== null) window.clearTimeout(highlightTimerRef.current);
    }, []);

    // Reset per-chapter revealed image overrides when switching chapters
    useEffect(() => {
        setRevealedImages({});
    }, [tab.id, chapter?.index]);

    // Debounced full-book search
    useEffect(() => {
        if (!searchOpen || !bookPath) return;
        const trimmed = searchQuery.trim();
        if (!trimmed) {
            setSearchHits([]);
            setSearching(false);
            return;
        }
        let cancelled = false;
        setSearching(true);
        const timer = window.setTimeout(() => {
            void searchEpubBook(bookPath, trimmed)
                .then((hits) => {
                    if (!cancelled) setSearchHits(hits);
                })
                .catch(() => {
                    if (!cancelled) setSearchHits([]);
                })
                .finally(() => {
                    if (!cancelled) setSearching(false);
                });
        }, 220);
        return () => {
            cancelled = true;
            window.clearTimeout(timer);
        };
    }, [searchOpen, bookPath, searchQuery]);

    const flashParagraphHighlight = useCallback((paragraphIdx: number) => {
        setHighlightedParagraph(paragraphIdx);
        if (highlightTimerRef.current !== null) {
            window.clearTimeout(highlightTimerRef.current);
        }
        highlightTimerRef.current = window.setTimeout(() => {
            highlightTimerRef.current = null;
            setHighlightedParagraph(null);
        }, 2200);
    }, []);

    const bookLanguage = tab.epub?.language || bookMeta?.language || "en";
    const bookDefaultVertical = tab.epub?.defaultVertical ?? bookMeta?.defaultVertical ?? false;
    const isJapaneseBook = bookLanguage === "ja";
    const resolvedOrientation = resolveEpubOrientation(
        bookLanguage,
        settings.epubTextOrientation,
        bookDefaultVertical,
        tab.epub?.orientation,
    );
    const isVertical = resolvedOrientation === "vertical";
    const readingMode = settings.epubReadingMode || "paged";
    const isPaged = readingMode === "paged";
    const isHorizontalPaged = !isVertical && isPaged;
    const canUseSpread = !isMobile && isHorizontalPaged && surfaceSize.width >= SPREAD_MIN_WIDTH;
    const useTwoPageSpread = canUseSpread && spreadEnabled;
    const epubTheme = settings.epubTheme || "app";
    const showImages = settings.epubShowImages ?? true;
    const blurImagesMode: EpubBlurImagesMode =
        settings.epubBlurImagesMode
        || (settings.epubBlurImages ? "all" : "off");
    const furiganaMode: EpubFuriganaMode = settings.epubFuriganaMode || "show";
    const justifyText = settings.epubJustify ?? false;
    const prettyWrap = settings.epubPrettyWrap ?? true;
    const verticalGrid = settings.epubVerticalGrid ?? false;
    const textIndent: EpubTextIndentMode = settings.epubTextIndent || "auto";
    const autoscrollSpeed = settings.epubAutoscrollSpeed ?? 38;
    const chapters = useMemo(() => bookMeta?.chapters || [], [bookMeta?.chapters]);
    const chapterIndex = chapter?.index ?? tab.epub?.chapterIndex ?? 0;
    const chapterCount = chapters.length || tab.epub?.chapterCount || 1;
    const paragraphs = useMemo(() => chapter?.paragraphs || [], [chapter?.paragraphs]);

    // Front-matter cutoff for "after-toc" spoiler-safe blur mode
    const blurCutoffChapterIndex = useMemo(() => {
        if (blurImagesMode !== "after-toc") return -1;
        let tocIdx = -1;
        for (let i = 0; i < Math.min(chapters.length, 8); i++) {
            const label = `${chapters[i]?.title || ""} ${chapters[i]?.href || ""}`.toLowerCase();
            if (/toc|contents|nav|cover|titlepage|front|目次|表紙|口絵/.test(label)) {
                tocIdx = i;
            }
        }
        return tocIdx >= 0 ? tocIdx : Math.min(1, Math.max(0, chapters.length - 1));
    }, [blurImagesMode, chapters]);

    const blurActiveInChapter = blurImagesMode === "all"
        || (blurImagesMode === "after-toc" && chapterIndex > blurCutoffChapterIndex);

    const chapterHighlightsMap = useMemo(() => {
        const map = new Map<number, EpubHighlight[]>();
        for (const hl of highlights) {
            if (hl.chapterIndex !== chapterIndex) continue;
            const list = map.get(hl.paragraphIndex);
            if (list) list.push(hl);
            else map.set(hl.paragraphIndex, [hl]);
        }
        return map;
    }, [highlights, chapterIndex]);

    const todayTotals = useMemo(() => getDay().total, [statsVersion]);
    const goalSummary = useMemo(
        () => evaluateGoalProgress(todayTotals.chars, todayTotals.seconds, activeGoals, trackingPaused || positionFrozen),
        [todayTotals.chars, todayTotals.seconds, activeGoals, trackingPaused, positionFrozen],
    );

    const computeAccurateProgress = useCallback((chIdx: number, fraction: number) => {
        return computeWeightedBookProgress(chIdx, chapters, fraction);
    }, [chapters]);

    const fontSize = settings.epubFontSize ?? 21;
    const lineHeight = settings.epubLineHeight ?? 1.65;
    const maxWidth = settings.epubMaxWidth ?? 1040;
    const effectivePadding = isMobile
        ? Math.min(18, settings.epubPagePadding ?? 18)
        : (settings.epubPagePadding ?? 24);
    const paragraphGap = settings.epubParagraphSpacing ?? 14;
    const topClearance = isMobile ? (immersive ? 12 : 60) : 24;
    const bottomClearance = isMobile ? (immersive ? 12 : 62) : 28;

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

        if (!suppressChrome && insideStage && (isPaged || isVertical) && !nearTop && !nearBottom && !tocOpen && !appearanceOpen && !searchOpen) {
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
    }, [topHover, bottomHover, isPaged, isVertical, tocOpen, appearanceOpen, searchOpen, edgeHover]);

    // When lookup mode ends, immediately restore chrome if pointer is resting in a trigger zone
    useEffect(() => {
        if (isMobile) {
            if (!lookupOpen) {
                if (stageRef.current) stageRef.current.scrollTop = 0;
                window.scrollTo(0, 0);
                const active = document.activeElement as HTMLElement | null;
                if (active && active.classList.contains("lookup-word")) {
                    active.blur();
                }
            }
            return;
        }
        if (lookupActive || escMenuOpen) return;
        const pos = lastPointerPosRef.current;
        if (pos) {
            evaluateHoverZones(pos.x, pos.y, false);
        }
    }, [isMobile, lookupOpen, lookupActive, escMenuOpen, evaluateHoverZones]);

    useEffect(() => {
        onOverlayStateChange?.(tocOpen || searchOpen || appearanceOpen || galleryOpen || Boolean(quoteModalText));
    }, [tocOpen, searchOpen, appearanceOpen, galleryOpen, quoteModalText, onOverlayStateChange]);

    useEffect(() => {
        if (!closeOverlaySignal) return;
        setTocOpen(false);
        setSearchOpen(false);
        setAppearanceOpen(false);
        setGalleryOpen(false);
        setQuoteModalText(null);
        setSelectionPill(null);
        setSettingReadingPoint(false);
    }, [closeOverlaySignal]);

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

    const topChromeVisible = !zenMode && !lookupActive && !escMenuOpen && ((isMobile && !immersive) || topHover || tocOpen || appearanceOpen || searchOpen);
    const bottomChromeVisible = !zenMode && !lookupActive && !escMenuOpen && ((isMobile && !immersive) || bottomHover || autoscrollActive || positionFrozen);

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
        if (!chapter || loading || trackingPaused || positionFrozen || escMenuOpen || galleryOpen || Boolean(quoteModalText)) {
            return;
        }
        const idleLimitMs = Math.max(15, activeGoals.idlePauseSeconds || 60) * 1000;
        const interval = window.setInterval(() => {
            if (document.hidden) return;
            const idleMs = Date.now() - lastActivityAtRef.current;
            if (!lookupOpen && idleMs > idleLimitMs) {
                return;
            }
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
    }, [chapter?.index, loading, trackingPaused, positionFrozen, escMenuOpen, galleryOpen, quoteModalText, lookupOpen, activeGoals.idlePauseSeconds]);

    // Continuous scroll Autoscroll loop (auto-pauses on lookup / modals / Zen off unaffected)
    useEffect(() => {
        if (!autoscrollActive || isPaged || !chapter || loading) return;
        if (lookupActive || escMenuOpen || tocOpen || appearanceOpen || searchOpen || galleryOpen || Boolean(quoteModalText)) {
            return;
        }
        let rafId = 0;
        let lastTime = performance.now();
        const tick = (now: number) => {
            const dt = Math.min(0.1, (now - lastTime) / 1000);
            lastTime = now;
            const el = surfaceRef.current;
            if (el) {
                const px = autoscrollSpeed * dt;
                if (isVertical) {
                    const max = Math.max(0, el.scrollWidth - el.clientWidth);
                    if (Math.abs(el.scrollLeft) >= max - 1) {
                        setAutoscrollActive(false);
                        return;
                    }
                    el.scrollLeft -= px;
                } else {
                    const max = Math.max(0, el.scrollHeight - el.clientHeight);
                    if (el.scrollTop >= max - 1) {
                        setAutoscrollActive(false);
                        return;
                    }
                    el.scrollTop += px;
                }
                lastActivityAtRef.current = Date.now();
            }
            rafId = requestAnimationFrame(tick);
        };
        rafId = requestAnimationFrame(tick);
        return () => cancelAnimationFrame(rafId);
    }, [autoscrollActive, isPaged, isVertical, autoscrollSpeed, chapter, loading, lookupActive, escMenuOpen, tocOpen, appearanceOpen, searchOpen, galleryOpen, quoteModalText]);

    // Reset autoscroll if user switches to paged mode
    useEffect(() => {
        if (isPaged && autoscrollActive) {
            setAutoscrollActive(false);
        }
    }, [isPaged, autoscrollActive]);

    // Reset tracked paragraph baseline when book or chapter changes
    useEffect(() => {
        lastTrackedParaRef.current = chapter ? { chapterIdx: chapter.index, paragraphIdx: 0 } : null;
    }, [tab.id, chapter?.index]);

    const setSpreadPreference = useCallback((next: boolean) => {
        setSpreadEnabled(next);
        try {
            localStorage.setItem(SPREAD_STORAGE_KEY, next ? "true" : "false");
        } catch {}
    }, []);

    const useVirtualizedScroll = !isVertical && !isPaged && paragraphs.length > VIRTUALIZE_THRESHOLD;

    const rowVirtualizer = useVirtualizer({
        count: useVirtualizedScroll ? paragraphs.length : 0,
        getScrollElement: () => surfaceRef.current,
        estimateSize: () => Math.max(44, fontSize * lineHeight + paragraphGap),
        overscan: 10,
    });

    // Track surface dimensions via ResizeObserver
    useEffect(() => {
        const el = surfaceRef.current;
        if (!el) return;
        const measure = () => {
            const width = Math.max(240, Math.round(el.clientWidth));
            const height = Math.max(200, Math.round(el.clientHeight));
            setSurfaceSize((prev) => (prev.width === width && prev.height === height ? prev : { width, height }));
        };
        measure();
        const observer = new ResizeObserver(measure);
        observer.observe(el);
        return () => observer.disconnect();
    }, [chapter?.index, loading, isVertical, isPaged]);

    // Measure discrete horizontal pages in the hidden clone so visible DOM never clips or peeks
    useLayoutEffect(() => {
        if (!isHorizontalPaged || !chapter || loading) return;
        if (paragraphs.length === 0) {
            setPageRanges([{ start: 0, end: 0 }]);
            setCurrentPageIdx(0);
            return;
        }
        const measurer = measurerRef.current;
        if (!measurer) {
            setPageRanges([{ start: 0, end: paragraphs.length }]);
            return;
        }

        const usableHeight = Math.max(180, surfaceSize.height - topClearance - bottomClearance - 20);
        const childNodes = measurer.querySelectorAll<HTMLElement>("[data-paragraph-index]");
        const heights = new Map<number, number>();
        childNodes.forEach((node) => {
            const idx = Number(node.dataset.paragraphIndex);
            if (Number.isInteger(idx)) {
                heights.set(idx, Math.ceil(node.getBoundingClientRect().height));
            }
        });

        const nextRanges: PageRange[] = [];
        let pageStart = 0;
        let usedHeight = 0;

        for (let i = 0; i < paragraphs.length; i += 1) {
            const p = paragraphs[i];
            if (p.kind === "image" && (!showImages || !p.imageSrc)) continue;
            const blockH = heights.get(i) ?? Math.max(36, fontSize * lineHeight);
            const needed = usedHeight === 0 ? blockH : blockH + paragraphGap;

            if (usedHeight > 0 && usedHeight + needed > usableHeight) {
                nextRanges.push({ start: pageStart, end: i });
                pageStart = i;
                usedHeight = blockH;
            } else {
                usedHeight += needed;
            }
        }
        if (pageStart < paragraphs.length) {
            nextRanges.push({ start: pageStart, end: paragraphs.length });
        }
        if (nextRanges.length === 0) {
            nextRanges.push({ start: 0, end: paragraphs.length });
        }

        setPageRanges(nextRanges);
        // Keep the user anchored on the exact same paragraph when toggling immersive chrome or resizing.
        if (anchorParagraphRef.current.chapterIdx === chapter.index && nextRanges.length > 0) {
            const targetP = anchorParagraphRef.current.paragraphIdx;
            const foundIdx = nextRanges.findIndex((r) => targetP >= r.start && targetP < r.end);
            if (foundIdx >= 0) {
                pageTurnDirRef.current = 0;
                setCurrentPageIdx(foundIdx);
            }
        }
    }, [
        isHorizontalPaged,
        useTwoPageSpread,
        chapter,
        loading,
        paragraphs,
        surfaceSize.width,
        surfaceSize.height,
        topClearance,
        bottomClearance,
        effectivePadding,
        paragraphGap,
        showImages,
        fontSize,
        lineHeight,
        maxWidth,
        settings.epubFontFamily,
        settings.fontFamily,
        settings.epubImageMaxWidth,
    ]);

    const activePageIdx = Math.min(Math.max(0, pageRanges.length - 1), Math.max(0, currentPageIdx));
    const spreadStartIdx = useTwoPageSpread ? activePageIdx - (activePageIdx % 2) : activePageIdx;
    const leftPageRange = pageRanges[spreadStartIdx] || { start: 0, end: paragraphs.length };
    if (chapter && !loading) {
        anchorParagraphRef.current = { chapterIdx: chapter.index, paragraphIdx: leftPageRange.start };
    }
    const rightPageRange = useTwoPageSpread ? (pageRanges[spreadStartIdx + 1] ?? null) : null;
    const visibleParagraphs = useMemo(() => {
        if (!isHorizontalPaged) return paragraphs;
        return paragraphs.slice(leftPageRange.start, leftPageRange.end);
    }, [isHorizontalPaged, paragraphs, leftPageRange.start, leftPageRange.end]);
    const rightVisibleParagraphs = useMemo(() => {
        if (!isHorizontalPaged || !rightPageRange) return [];
        return paragraphs.slice(rightPageRange.start, rightPageRange.end);
    }, [isHorizontalPaged, paragraphs, rightPageRange?.start, rightPageRange?.end]);

    // Reset scroll to top on page changes in horizontal paged mode
    useEffect(() => {
        if (!isHorizontalPaged || !chapter || loading) return;
        if (surfaceRef.current) {
            surfaceRef.current.scrollTop = 0;
        }
    }, [isHorizontalPaged, chapter, loading, leftPageRange.start, leftPageRange.end, rightPageRange?.end]);

    const getScrollMetrics = useCallback((el: HTMLDivElement) => {
        if (isVertical) {
            const max = Math.max(0, el.scrollWidth - el.clientWidth);
            const current = Math.abs(el.scrollLeft);
            const fraction = max > 0 ? clamp01(current / max) : 1;
            const colStep = Math.max(18, fontSize * lineHeight);
            const usableW = Math.max(colStep, el.clientWidth - effectivePadding * 2);
            const step = Math.max(colStep, Math.floor(usableW / colStep) * colStep);
            const totalPages = Math.max(1, Math.ceil(max / step) + 1);
            const currentPage = Math.min(totalPages, Math.max(1, Math.round(current / step) + 1));
            return { fraction, currentPage, totalPages, max, step };
        }
        const max = Math.max(0, el.scrollHeight - el.clientHeight);
        const current = Math.max(0, el.scrollTop);
        const fraction = max > 0 ? clamp01(current / max) : 1;
        return { fraction, currentPage: 1, totalPages: 1, max, step: Math.max(1, el.clientHeight) };
    }, [isVertical, fontSize, lineHeight, effectivePadding]);

    const jumpToParagraphInCurrentChapter = useCallback((targetParagraphIdx: number) => {
        if (isHorizontalPaged) {
            const foundPage = pageRanges.findIndex(
                (r) => targetParagraphIdx >= r.start && targetParagraphIdx < r.end,
            );
            if (foundPage >= 0) {
                setCurrentPageIdx(foundPage);
                const total = Math.max(1, pageRanges.length);
                const reachedPage = useTwoPageSpread ? Math.min(total - 1, foundPage + 1) : foundPage;
                const fraction = total <= 1 ? 1 : clamp01(reachedPage / (total - 1));
                if (!positionFrozenRef.current) {
                    const bookProgress = computeAccurateProgress(chapterIndex, fraction);
                    callbacksRef.current.onProgressChange(chapterIndex, fraction, bookProgress);
                }
            }
            flashParagraphHighlight(targetParagraphIdx);
            return;
        }

        if (useVirtualizedScroll) {
            rowVirtualizer.scrollToIndex(targetParagraphIdx, { align: "start" });
            flashParagraphHighlight(targetParagraphIdx);
            return;
        }

        const el = surfaceRef.current;
        const node = el?.querySelector<HTMLElement>(`[data-paragraph-index="${targetParagraphIdx}"]`);
        if (node) {
            node.scrollIntoView({
                block: isVertical ? "nearest" : "start",
                inline: isVertical ? "center" : "nearest",
                behavior: "smooth",
            });
        }
        flashParagraphHighlight(targetParagraphIdx);
    }, [
        isHorizontalPaged,
        pageRanges,
        useTwoPageSpread,
        chapterIndex,
        chapterCount,
        useVirtualizedScroll,
        rowVirtualizer,
        isVertical,
        flashParagraphHighlight,
    ]);

    const jumpToLocation = useCallback((targetChapterIdx: number, targetParagraphIdx: number) => {
        if (chapter && targetChapterIdx === chapter.index) {
            jumpToParagraphInCurrentChapter(targetParagraphIdx);
            return;
        }
        callbacksRef.current.onSelectChapter(targetChapterIdx, undefined, targetParagraphIdx);
    }, [chapter, jumpToParagraphInCurrentChapter]);

    // Restore chapter offset or jump to anchor fragment / target paragraph when chapter finishes loading
    const restoredChapterKeyRef = useRef<string>("");
    useEffect(() => {
        if (!chapter || loading) return;

        if (pendingParagraphIndex !== null) {
            const clampedParagraph = Math.min(Math.max(0, paragraphs.length - 1), Math.max(0, pendingParagraphIndex));
            if (isHorizontalPaged) {
                const foundPage = pageRanges.findIndex(
                    (r) => clampedParagraph >= r.start && clampedParagraph < r.end,
                );
                if (foundPage >= 0) {
                    setCurrentPageIdx(foundPage);
                    restoredChapterKeyRef.current = `${tab.id}:${chapter.index}:${pageRanges.length}`;
                }
                flashParagraphHighlight(clampedParagraph);
                callbacksRef.current.onFragmentHandled();
                return;
            }
            const timer = window.setTimeout(() => {
                jumpToParagraphInCurrentChapter(clampedParagraph);
                callbacksRef.current.onFragmentHandled();
            }, 50);
            return () => window.clearTimeout(timer);
        }

        if (isHorizontalPaged) {
            if (pendingFragment) {
                const targetParagraphIdx = paragraphs.findIndex(
                    (p) => p.id === pendingFragment || p.anchorIds.includes(pendingFragment),
                );
                if (targetParagraphIdx >= 0) {
                    const foundPage = pageRanges.findIndex(
                        (r) => targetParagraphIdx >= r.start && targetParagraphIdx < r.end,
                    );
                    if (foundPage >= 0) setCurrentPageIdx(foundPage);
                }
                callbacksRef.current.onFragmentHandled();
                return;
            }
            const chapterKey = `${tab.id}:${chapter.index}:${pageRanges.length}`;
            if (restoredChapterKeyRef.current === chapterKey) return;
            restoredChapterKeyRef.current = chapterKey;
            const savedOffset = chapter.index === (tab.epub?.chapterIndex ?? 0)
                ? clamp01(tab.epub?.chapterOffset || 0)
                : 0;
            const targetPage = pageRanges.length <= 1 ? 0 : Math.round(savedOffset * (pageRanges.length - 1));
            setCurrentPageIdx(targetPage);
            return;
        }

        const el = surfaceRef.current;
        if (!el) return;
        restoringRef.current = true;
        const timer = window.setTimeout(() => {
            if (pendingFragment) {
                const safeId = pendingFragment.replace(/["\\]/g, "\\$&");
                const target = el.querySelector<HTMLElement>(`[id="${safeId}"], [data-anchor-ids~="${safeId}"]`);
                if (target) {
                    target.scrollIntoView({ block: "start", inline: "nearest" });
                }
                callbacksRef.current.onFragmentHandled();
            } else {
                const savedOffset = chapter.index === (tab.epub?.chapterIndex ?? 0)
                    ? clamp01(tab.epub?.chapterOffset || 0)
                    : 0;
                if (isVertical) {
                    const max = Math.max(0, el.scrollWidth - el.clientWidth);
                    el.scrollLeft = -max * savedOffset;
                } else {
                    const max = Math.max(0, el.scrollHeight - el.clientHeight);
                    el.scrollTop = max * savedOffset;
                }
            }
            const metrics = getScrollMetrics(el);
            setVerticalPageInfo((prev) =>
                prev.current === metrics.currentPage && prev.total === metrics.totalPages
                    ? prev
                    : { current: metrics.currentPage, total: metrics.totalPages },
            );
            restoringRef.current = false;
        }, 40);

        return () => {
            window.clearTimeout(timer);
            restoringRef.current = false;
        };
    }, [
        tab.id,
        chapter?.index,
        chapter?.href,
        loading,
        isVertical,
        isHorizontalPaged,
        pendingFragment,
        pendingParagraphIndex,
        pageRanges,
        paragraphs,
        getScrollMetrics,
        jumpToParagraphInCurrentChapter,
        flashParagraphHighlight,
    ]);

    const handleScroll = useCallback(() => {
        if (isHorizontalPaged) return;
        const el = surfaceRef.current;
        if (!el || !chapter) return;
        const metrics = getScrollMetrics(el);
        setVerticalPageInfo((prev) =>
            prev.current === metrics.currentPage && prev.total === metrics.totalPages
                ? prev
                : { current: metrics.currentPage, total: metrics.totalPages },
        );
        if (restoringRef.current) return;
        lastActivityAtRef.current = Date.now();

        const now = Date.now();
        if (now - lastProgressSentRef.current < PROGRESS_THROTTLE_MS) return;
        lastProgressSentRef.current = now;

        if (!positionFrozenRef.current) {
            const bookProgress = computeAccurateProgress(chapter.index, metrics.fraction);
            callbacksRef.current.onProgressChange(chapter.index, metrics.fraction, bookProgress);

            if (!trackingPaused && paragraphs.length > 0) {
                const approxPara = Math.min(paragraphs.length - 1, Math.floor(metrics.fraction * paragraphs.length));
                const prev = lastTrackedParaRef.current;
                if (prev && prev.chapterIdx === chapter.index && approxPara > prev.paragraphIdx) {
                    const delta = computeChapterParagraphDelta(
                        paragraphs,
                        prev.paragraphIdx,
                        approxPara,
                        activeGoals.skipThresholdChars,
                    );
                    if (delta !== null && delta > 0) {
                        onRecordStatsRef.current?.(delta, 0);
                    }
                    lastTrackedParaRef.current = { chapterIdx: chapter.index, paragraphIdx: approxPara };
                } else {
                    lastTrackedParaRef.current = { chapterIdx: chapter.index, paragraphIdx: approxPara };
                }
            }
        }
    }, [isHorizontalPaged, chapter, computeAccurateProgress, getScrollMetrics, trackingPaused, paragraphs, activeGoals.skipThresholdChars]);

    const goToHorizontalPage = useCallback((nextIdx: number) => {
        if (!chapter) return;
        const total = Math.max(1, pageRanges.length);
        const clamped = Math.min(total - 1, Math.max(0, nextIdx));
        setCurrentPageIdx(clamped);
        lastActivityAtRef.current = Date.now();
        const reachedPage = useTwoPageSpread ? Math.min(total - 1, clamped + 1) : clamped;
        const fraction = total <= 1 ? 1 : clamp01(reachedPage / (total - 1));
        if (!positionFrozenRef.current) {
            const bookProgress = computeAccurateProgress(chapter.index, fraction);
            callbacksRef.current.onProgressChange(chapter.index, fraction, bookProgress);

            if (!trackingPaused && pageRanges[reachedPage]) {
                const endPara = Math.max(0, pageRanges[reachedPage].end - 1);
                const prev = lastTrackedParaRef.current;
                if (prev && prev.chapterIdx === chapter.index && endPara > prev.paragraphIdx) {
                    const delta = computeChapterParagraphDelta(
                        paragraphs,
                        prev.paragraphIdx,
                        endPara,
                        activeGoals.skipThresholdChars,
                    );
                    if (delta !== null && delta > 0) {
                        onRecordStatsRef.current?.(delta, 0);
                    }
                    lastTrackedParaRef.current = { chapterIdx: chapter.index, paragraphIdx: endPara };
                } else {
                    lastTrackedParaRef.current = { chapterIdx: chapter.index, paragraphIdx: endPara };
                }
            }
        }
    }, [chapter, pageRanges, useTwoPageSpread, computeAccurateProgress, trackingPaused, paragraphs, activeGoals.skipThresholdChars]);

    const turnPage = useCallback((direction: 1 | -1) => {
        if (!chapter) return;
        pageTurnDirRef.current = direction;

        if (isHorizontalPaged) {
            const pageStep = useTwoPageSpread ? 2 : 1;
            const nextIdx = spreadStartIdx + direction * pageStep;
            if (nextIdx >= pageRanges.length) {
                if (chapter.index + 1 < chapterCount) {
                    callbacksRef.current.onSelectChapter(chapter.index + 1);
                }
                return;
            }
            if (nextIdx < 0) {
                if (chapter.index > 0) {
                    callbacksRef.current.onSelectChapter(chapter.index - 1);
                }
                return;
            }
            goToHorizontalPage(nextIdx);
            return;
        }

        const el = surfaceRef.current;
        if (!el) return;
        const metrics = getScrollMetrics(el);
        const atEnd = direction === 1 && metrics.fraction >= 0.99;
        const atStart = direction === -1 && metrics.fraction <= 0.01;

        if (atEnd) {
            if (chapter.index + 1 < chapterCount) {
                callbacksRef.current.onSelectChapter(chapter.index + 1);
            }
            return;
        }
        if (atStart) {
            if (chapter.index > 0) {
                callbacksRef.current.onSelectChapter(chapter.index - 1);
            }
            return;
        }

        if (isVertical) {
            const delta = metrics.step * direction;
            el.scrollTo({ left: el.scrollLeft - delta, behavior: "smooth" });
        } else {
            const delta = Math.max(120, el.clientHeight * 0.85) * direction;
            el.scrollTo({ top: el.scrollTop + delta, behavior: "smooth" });
        }
    }, [chapter, chapterCount, isHorizontalPaged, useTwoPageSpread, spreadStartIdx, pageRanges.length, goToHorizontalPage, getScrollMetrics, isVertical]);

    const getCurrentVisibleParagraph = useCallback((): EpubParagraph | null => {
        if (paragraphs.length === 0) return null;
        if (isHorizontalPaged) {
            return paragraphs.slice(leftPageRange.start, leftPageRange.end).find((p) => p.text.trim().length > 0)
                || paragraphs[leftPageRange.start]
                || paragraphs[0];
        }
        const el = surfaceRef.current;
        if (!el) return paragraphs[0];
        const rect = el.getBoundingClientRect();
        const nodes = el.querySelectorAll<HTMLElement>("[data-paragraph-index]");
        for (const node of nodes) {
            const box = node.getBoundingClientRect();
            const inView = isVertical
                ? box.left <= rect.right && box.right >= rect.left
                : box.bottom >= rect.top + 16 && box.top <= rect.bottom;
            if (!inView) continue;
            const idx = Number(node.dataset.paragraphIndex);
            const found = paragraphs.find((p) => p.index === idx);
            if (found && found.text.trim()) return found;
        }
        return paragraphs[0];
    }, [paragraphs, isHorizontalPaged, leftPageRange.start, leftPageRange.end, isVertical]);

    const handleAddBookmark = useCallback(() => {
        if (!chapter || !onChangeBookBookmarks) return;
        const target = getCurrentVisibleParagraph();
        const paragraphIndex = target?.index ?? 0;
        const rawExcerpt = (target?.text || chapter.title || "").replace(/\s+/g, " ").trim();
        const excerpt = rawExcerpt.length > 90 ? `${rawExcerpt.slice(0, 90)}…` : rawExcerpt;
        const chapterTitle = chapter.title || t("epub.chapterOf", { current: chapter.index + 1, total: chapterCount });
        const customLabel = bookmarkLabelInput.trim();
        const nextBookmark: EpubBookmark = {
            id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
            label: customLabel || chapterTitle,
            chapterIndex: chapter.index,
            chapterTitle,
            paragraphIndex,
            excerpt,
            createdAt: Date.now(),
        };
        onChangeBookBookmarks([nextBookmark, ...bookmarks]);
        setBookmarkLabelInput("");
    }, [chapter, onChangeBookBookmarks, getCurrentVisibleParagraph, t, chapterCount, bookmarkLabelInput, bookmarks]);

    const handleRenameBookmark = useCallback((id: string) => {
        if (!onChangeBookBookmarks) return;
        const nextLabel = editingBookmarkLabel.trim();
        if (nextLabel) {
            onChangeBookBookmarks(
                bookmarks.map((item) => (item.id === id ? { ...item, label: nextLabel } : item)),
            );
        }
        setEditingBookmarkId(null);
        setEditingBookmarkLabel("");
    }, [onChangeBookBookmarks, editingBookmarkLabel, bookmarks]);

    const handleDeleteBookmark = useCallback((id: string) => {
        if (!onChangeBookBookmarks) return;
        onChangeBookBookmarks(bookmarks.filter((item) => item.id !== id));
    }, [onChangeBookBookmarks, bookmarks]);

    const handleSaveReadingPoint = useCallback((targetParagraph?: EpubParagraph | null) => {
        if (!chapter || !onChangeReadingPoint) return;
        const target = targetParagraph ?? getCurrentVisibleParagraph();
        const paragraphIndex = target?.index ?? 0;
        const rawExcerpt = (target?.text || chapter.title || "").replace(/\s+/g, " ").trim();
        const excerpt = rawExcerpt.length > 90 ? `${rawExcerpt.slice(0, 90)}…` : rawExcerpt;
        const chapterTitle = chapter.title || t("epub.chapterOf", { current: chapter.index + 1, total: chapterCount });
        onChangeReadingPoint({
            chapterIndex: chapter.index,
            paragraphIndex,
            chapterTitle,
            excerpt,
            savedAt: Date.now(),
        });
        const fraction = paragraphs.length <= 1 ? 0 : clamp01(paragraphIndex / (paragraphs.length - 1));
        const bookProgress = computeAccurateProgress(chapter.index, fraction);
        callbacksRef.current.onProgressChange(chapter.index, fraction, bookProgress);
        flashParagraphHighlight(paragraphIndex);
        setSettingReadingPoint(false);
    }, [chapter, onChangeReadingPoint, getCurrentVisibleParagraph, t, chapterCount, paragraphs.length, computeAccurateProgress, flashParagraphHighlight]);

    const handleAddHighlight = useCallback((color: EpubHighlightColor, openNote = false) => {
        if (!chapter || !selectionPill || !onChangeBookHighlights) return;
        const chapterTitle = chapter.title || t("epub.chapterOf", { current: chapter.index + 1, total: chapterCount });
        const nextHl: EpubHighlight = {
            id: `hl-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
            chapterIndex: chapter.index,
            chapterTitle,
            paragraphIndex: selectionPill.paragraphIndex,
            text: selectionPill.text,
            color,
            createdAt: Date.now(),
        };
        onChangeBookHighlights([nextHl, ...highlights]);
        setSelectionPill(null);
        window.getSelection()?.removeAllRanges();
        if (openNote) {
            setEditingHighlightId(nextHl.id);
            setEditingHighlightNote("");
            setDrawerTab("notes");
            setTocOpen(true);
        }
    }, [chapter, selectionPill, onChangeBookHighlights, t, chapterCount, highlights]);

    const handleSaveHighlightNote = useCallback((id: string) => {
        if (!onChangeBookHighlights) return;
        const noteText = editingHighlightNote.trim();
        onChangeBookHighlights(
            highlights.map((hl) => (hl.id === id ? { ...hl, note: noteText || undefined } : hl)),
        );
        setEditingHighlightId(null);
        setEditingHighlightNote("");
    }, [onChangeBookHighlights, editingHighlightNote, highlights]);

    const handleDeleteHighlight = useCallback((id: string) => {
        if (!onChangeBookHighlights) return;
        onChangeBookHighlights(highlights.filter((hl) => hl.id !== id));
    }, [onChangeBookHighlights, highlights]);

    const handleAddBookNote = useCallback(() => {
        if (!onChangeBookNotes) return;
        const body = noteBodyInput.trim();
        const title = noteTitleInput.trim();
        if (!body && !title) return;
        const target = getCurrentVisibleParagraph();
        const chapterTitle = chapter
            ? (chapter.title || t("epub.chapterOf", { current: chapter.index + 1, total: chapterCount }))
            : undefined;
        const now = Date.now();
        const nextNote: EpubBookNote = {
            id: `note-${now}-${Math.random().toString(36).slice(2, 7)}`,
            title: title || chapterTitle || t("epub.notes"),
            body,
            chapterIndex: chapter?.index,
            chapterTitle,
            paragraphIndex: target?.index,
            createdAt: now,
            updatedAt: now,
        };
        onChangeBookNotes([nextNote, ...notes]);
        setNoteTitleInput("");
        setNoteBodyInput("");
    }, [onChangeBookNotes, noteBodyInput, noteTitleInput, getCurrentVisibleParagraph, chapter, t, chapterCount, notes]);

    const handleDeleteBookNote = useCallback((id: string) => {
        if (!onChangeBookNotes) return;
        onChangeBookNotes(notes.filter((n) => n.id !== id));
    }, [onChangeBookNotes, notes]);

    const handleSurfaceMouseUp = useCallback(() => {
        if (!onChangeBookHighlights || settingReadingPoint) return;
        const sel = window.getSelection();
        if (!sel || sel.isCollapsed) {
            setSelectionPill(null);
            return;
        }
        const selectedText = sel.toString().trim();
        if (!selectedText || selectedText.length > 800) {
            setSelectionPill(null);
            return;
        }
        const range = sel.rangeCount > 0 ? sel.getRangeAt(0) : null;
        const anchorEl = range?.commonAncestorContainer instanceof Element
            ? range.commonAncestorContainer
            : range?.commonAncestorContainer?.parentElement;
        const paraEl = anchorEl?.closest<HTMLElement>("[data-paragraph-index]");
        const stage = stageRef.current;
        if (!paraEl || !stage || !surfaceRef.current?.contains(paraEl)) {
            setSelectionPill(null);
            return;
        }
        const paragraphIndex = Number(paraEl.dataset.paragraphIndex);
        if (!Number.isFinite(paragraphIndex)) return;
        const selRect = range!.getBoundingClientRect();
        const stageRect = stage.getBoundingClientRect();
        const x = Math.min(stageRect.width - 140, Math.max(140, selRect.left + selRect.width / 2 - stageRect.left));
        const y = Math.max(54, selRect.top - stageRect.top - 12);
        setSelectionPill({ x, y, text: selectedText, paragraphIndex });
    }, [onChangeBookHighlights, settingReadingPoint]);

    useEffect(() => {
        const el = surfaceRef.current;
        if (!el) return;
        const onWheel = (event: WheelEvent) => {
            if (isVertical) {
                if (Math.abs(event.deltaY) > Math.abs(event.deltaX)) {
                    event.preventDefault();
                    el.scrollLeft -= event.deltaY;
                }
                return;
            }
            if (isHorizontalPaged) {
                const canScrollDown = el.scrollTop + el.clientHeight < el.scrollHeight - 2;
                const canScrollUp = el.scrollTop > 2;
                if ((event.deltaY > 0 && canScrollDown) || (event.deltaY < 0 && canScrollUp)) {
                    return;
                }
                if (Math.abs(event.deltaY) >= 8) {
                    event.preventDefault();
                    const now = Date.now();
                    if (now - lastWheelPageRef.current < WHEEL_PAGE_COOLDOWN_MS) return;
                    lastWheelPageRef.current = now;
                    turnPage(event.deltaY > 0 ? 1 : -1);
                }
            }
        };
        el.addEventListener("wheel", onWheel, { passive: false });
        return () => el.removeEventListener("wheel", onWheel);
    }, [isVertical, isHorizontalPaged, turnPage, chapter?.index, loading]);

    // Ctrl+F opens in-book search; arrows / PageUp / PageDown / Space turn pages
    useEffect(() => {
        const onKeyDown = (event: KeyboardEvent) => {
            const isCtrl = event.ctrlKey || event.metaKey;
            const keyLower = event.key.toLowerCase();
            if (isCtrl && !event.altKey && (event.code === "KeyF" || keyLower === "f" || keyLower === "а")) {
                event.preventDefault();
                event.stopPropagation();
                setTocOpen(false);
                setAppearanceOpen(false);
                setSearchOpen(true);
                window.setTimeout(() => searchInputRef.current?.focus(), 40);
                return;
            }

            if (event.ctrlKey || event.metaKey || event.altKey) return;
            const target = event.target as HTMLElement | null;
            if (event.key === "Escape" && (tocOpen || appearanceOpen || searchOpen || settingReadingPoint || selectionPill)) {
                if (document.querySelector(".font-picker-overlay")) return;
                event.preventDefault();
                setTocOpen(false);
                setAppearanceOpen(false);
                setSearchOpen(false);
                setSettingReadingPoint(false);
                setSelectionPill(null);
                return;
            }
            if (target && ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)) return;
            if (tocOpen || appearanceOpen || searchOpen || escMenuOpen || galleryOpen || Boolean(quoteModalText)) return;

            if (event.code === "KeyZ" && !event.shiftKey) {
                event.preventDefault();
                setZenMode((prev) => !prev);
                return;
            }
            if (event.code === "KeyT" && !event.shiftKey && onChangeReadingPoint) {
                event.preventDefault();
                setSettingReadingPoint((prev) => !prev);
                return;
            }
            if (event.code === "KeyO" && !event.shiftKey && onChangeReadingPoint) {
                event.preventDefault();
                handleSaveReadingPoint();
                return;
            }
            if (event.code === "KeyR" && !event.shiftKey && readingPoint) {
                event.preventDefault();
                jumpToLocation(readingPoint.chapterIndex, readingPoint.paragraphIndex);
                return;
            }
            if (event.code === "KeyE" && !event.shiftKey) {
                event.preventDefault();
                setPositionFrozen((prev) => !prev);
                return;
            }
            if (event.code === "KeyP" && !event.shiftKey) {
                event.preventDefault();
                setTrackingPaused((prev) => !prev);
                return;
            }
            if (event.code === "KeyB" && onChangeBookBookmarks) {
                event.preventDefault();
                if (event.shiftKey) {
                    handleAddBookmark();
                } else {
                    setDrawerTab("bookmarks");
                    setTocOpen(true);
                }
                return;
            }
            if (!isPaged) {
                if (event.code === "KeyS" && !event.shiftKey) {
                    event.preventDefault();
                    setAutoscrollActive((prev) => !prev);
                    return;
                }
                if (event.code === "KeyA" && !event.shiftKey && onUpdateSettings) {
                    event.preventDefault();
                    onUpdateSettings({ epubAutoscrollSpeed: Math.max(10, autoscrollSpeed - 8) });
                    return;
                }
                if (event.code === "KeyD" && !event.shiftKey && onUpdateSettings) {
                    event.preventDefault();
                    onUpdateSettings({ epubAutoscrollSpeed: Math.min(200, autoscrollSpeed + 8) });
                    return;
                }
            }

            if (event.key === "ArrowLeft") {
                event.preventDefault();
                turnPage(isVertical ? 1 : -1);
            } else if (event.key === "ArrowRight") {
                event.preventDefault();
                turnPage(isVertical ? -1 : 1);
            } else if (event.key === "PageDown" || (event.key === " " && !event.shiftKey)) {
                if (isPaged || isVertical) {
                    event.preventDefault();
                    turnPage(1);
                }
            } else if (event.key === "PageUp" || (event.key === " " && event.shiftKey)) {
                if (isPaged || isVertical) {
                    event.preventDefault();
                    turnPage(-1);
                }
            }
        };
        window.addEventListener("keydown", onKeyDown, { capture: true });
        return () => window.removeEventListener("keydown", onKeyDown, { capture: true });
    }, [
        isVertical,
        isPaged,
        tocOpen,
        appearanceOpen,
        searchOpen,
        escMenuOpen,
        galleryOpen,
        quoteModalText,
        settingReadingPoint,
        selectionPill,
        onChangeReadingPoint,
        handleSaveReadingPoint,
        readingPoint,
        jumpToLocation,
        onChangeBookBookmarks,
        handleAddBookmark,
        onUpdateSettings,
        autoscrollSpeed,
        turnPage,
    ]);

    // Internal EPUB link clicks + edge-click page turning + mobile empty-area tap to toggle full-screen reading
    const handleContentClick = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
        const hadOpenPopover = appearanceOpen || searchOpen;
        if (appearanceOpen) setAppearanceOpen(false);
        if (searchOpen) setSearchOpen(false);
        if (selectionPill) setSelectionPill(null);

        const target = event.target as HTMLElement | null;

        if (settingReadingPoint) {
            const paraNode = target?.closest<HTMLElement>("[data-paragraph-index]");
            if (paraNode) {
                const idx = Number(paraNode.dataset.paragraphIndex);
                const found = paragraphs.find((p) => p.index === idx);
                if (found) {
                    event.preventDefault();
                    event.stopPropagation();
                    handleSaveReadingPoint(found);
                    return;
                }
            }
        }
        const link = target?.closest<HTMLAnchorElement>("a[data-epub-href]");
        if (link) {
            event.preventDefault();
            const rawHref = link.getAttribute("data-epub-href") || "";
            const resolved = resolveEpubHrefTarget(rawHref, chapters);
            if (resolved) {
                callbacksRef.current.onSelectChapter(resolved.chapterIndex, resolved.fragment);
            }
            return;
        }

        if (
            !event.shiftKey
            && !event.ctrlKey
            && !event.altKey
            && !event.metaKey
            && !target?.closest("a, button, input, select, .lookup-word, figure.epub-image-block.is-blurred")
        ) {
            const sel = window.getSelection();
            if (sel && !sel.isCollapsed && sel.toString().trim().length > 0) return;

            const surface = surfaceRef.current;
            if (!surface) return;
            const rect = surface.getBoundingClientRect();
            const relX = event.clientX - rect.left;
            const edgePx = Math.min(EDGE_CLICK_MAX_PX, rect.width * EDGE_CLICK_RATIO);
            if ((isPaged || isVertical) && relX <= edgePx) {
                turnPage(isVertical ? 1 : -1);
                return;
            }
            if ((isPaged || isVertical) && relX >= rect.width - edgePx) {
                turnPage(isVertical ? -1 : 1);
                return;
            }
            if (isMobile && !hadOpenPopover && !tocOpen && !lookupOpen) {
                onToggleImmersive?.();
            }
        }
    }, [chapters, appearanceOpen, searchOpen, tocOpen, lookupOpen, isMobile, isPaged, isVertical, turnPage, onToggleImmersive, selectionPill, settingReadingPoint, paragraphs, handleSaveReadingPoint]);

    const isSwipePaged = isHorizontalPaged || (isVertical && isPaged);

    const handleSurfaceTouchStart = useCallback((event: ReactTouchEvent<HTMLDivElement>) => {
        if (!isMobile || !isSwipePaged || event.touches.length !== 1) {
            swipeStartRef.current = null;
            return;
        }
        const touch = event.touches[0];
        swipeStartRef.current = { x: touch.clientX, y: touch.clientY, at: Date.now() };
    }, [isMobile, isSwipePaged]);

    const handleSurfaceTouchEnd = useCallback((event: ReactTouchEvent<HTMLDivElement>) => {
        const start = swipeStartRef.current;
        swipeStartRef.current = null;
        if (!start || !isMobile || !isSwipePaged || event.changedTouches.length !== 1) return;
        const touch = event.changedTouches[0];
        const dx = touch.clientX - start.x;
        const dy = touch.clientY - start.y;
        if (Date.now() - start.at > 650) return;
        if (Math.abs(dx) >= 48 && Math.abs(dx) > Math.abs(dy) * 1.35) {
            if (isVertical) {
                // Japanese RTL: swipe right turns forward (next page), swipe left turns back
                turnPage(dx > 0 ? 1 : -1);
            } else {
                turnPage(dx < 0 ? 1 : -1);
            }
        }
    }, [isMobile, isSwipePaged, isVertical, turnPage]);

    const handleMobileTokenTap = useCallback(
        (paragraphIndex: number) =>
            (token: string, sentence: string, cursor: number, boundaries?: number[], lemma?: string) => {
                if (!isPaged) {
                    const el = surfaceRef.current?.querySelector<HTMLElement>(
                        `[data-paragraph-index="${paragraphIndex}"]`,
                    );
                    if (el) {
                        el.scrollIntoView({
                            block: isVertical ? "nearest" : "start",
                            inline: isVertical ? "center" : "nearest",
                            behavior: "smooth",
                        });
                    }
                }
                return callbacksRef.current.onLookupToken?.(token, sentence, cursor, boundaries, lemma);
            },
        [isVertical, isPaged],
    );

    const toggleImageReveal = useCallback((paragraphIdx: number) => {
        setRevealedImages((prev) => ({ ...prev, [paragraphIdx]: !prev[paragraphIdx] }));
    }, []);

    const spreadContainerMaxWidth = Math.min(
        Math.max(640, surfaceSize.width - effectivePadding * 2),
        Math.max(1220, Math.round(maxWidth * 1.38)),
    );

    const surfaceStyle = useMemo<CSSProperties>(() => {
        const style: Record<string, string | number> = {
            "--epub-font-size": `${fontSize}px`,
            "--epub-font-family": settings.epubFontFamily || settings.fontFamily || "var(--txt-font-family)",
            "--epub-line-height": lineHeight,
            "--epub-paragraph-gap": `${paragraphGap}px`,
            "--epub-page-padding": `${effectivePadding}px`,
            "--epub-top-clearance": `${topClearance}px`,
            "--epub-bottom-clearance": `${bottomClearance}px`,
            "--epub-max-width": `${useTwoPageSpread ? spreadContainerMaxWidth : maxWidth}px`,
            "--epub-image-max-width": `${settings.epubImageMaxWidth ?? 720}px`,
        };
        return style as CSSProperties;
    }, [
        fontSize,
        settings.epubFontFamily,
        settings.fontFamily,
        lineHeight,
        paragraphGap,
        effectivePadding,
        topClearance,
        bottomClearance,
        useTwoPageSpread,
        spreadContainerMaxWidth,
        maxWidth,
        settings.epubImageMaxWidth,
    ]);

    const measurerWidth = useTwoPageSpread
        ? Math.max(280, Math.floor((spreadContainerMaxWidth - SPREAD_GAP) / 2))
        : Math.min(Math.max(240, surfaceSize.width - effectivePadding * 2), maxWidth);

    const revealImageLabel = t("epub.revealImage");

    const renderParagraph = useCallback((p: EpubParagraph) => {
        if (p.kind === "separator") {
            return <hr key={p.index} className="epub-separator" data-paragraph-index={p.index} />;
        }

        if (p.kind === "image") {
            if (!showImages || !p.imageSrc) return null;
            const isBlurred = blurActiveInChapter && !revealedImages[p.index];
            return (
                <EpubImageBlock
                    key={p.index}
                    index={p.index}
                    id={p.id || undefined}
                    anchorIds={p.anchorIds.join(" ") || undefined}
                    src={p.imageSrc}
                    alt={p.imageAlt || ""}
                    blurred={isBlurred}
                    revealLabel={revealImageLabel}
                    onToggleReveal={blurActiveInChapter ? toggleImageReveal : undefined}
                />
            );
        }

        const isHighlighted = highlightedParagraph === p.index;
        const isPinnedPoint = readingPoint !== null
            && readingPoint.chapterIndex === chapterIndex
            && readingPoint.paragraphIndex === p.index;
        const blockClass = `text-line epub-block epub-block-${p.kind}${isHighlighted ? " is-highlighted" : ""}${isPinnedPoint ? " is-reading-point" : ""}${settingReadingPoint ? " is-pick-point" : ""}`;
        const paraHighlights = chapterHighlightsMap.get(p.index);
        const renderedHtml = paraHighlights && paraHighlights.length > 0
            ? applyParagraphHighlights(p.html, paraHighlights)
            : p.html;

        if (isMobile && onLookupToken) {
            return (
                <div
                    key={p.index}
                    id={p.id || undefined}
                    data-paragraph-index={p.index}
                    data-anchor-ids={p.anchorIds.join(" ") || undefined}
                    className={blockClass}
                >
                    <TokenizedLine
                        text={p.text}
                        searchQuery=""
                        furiganaMode={settings.furiganaMode || "none"}
                        onLookupToken={handleMobileTokenTap(p.index)}
                    />
                </div>
            );
        }

        return (
            <EpubHtmlParagraph
                key={p.index}
                index={p.index}
                id={p.id || undefined}
                anchorIds={p.anchorIds.join(" ") || undefined}
                className={blockClass}
                html={renderedHtml}
            />
        );
    }, [
        showImages,
        blurActiveInChapter,
        revealedImages,
        revealImageLabel,
        toggleImageReveal,
        highlightedParagraph,
        readingPoint,
        chapterIndex,
        settingReadingPoint,
        chapterHighlightsMap,
        isMobile,
        onLookupToken,
        settings.furiganaMode,
        handleMobileTokenTap,
    ]);

    const currentProgressPct = Math.round(clamp01(tab.epub?.progress || 0) * 100);
    const activeBookOrientationValue: EpubOrientationSetting =
        tab.epub?.orientation || settings.epubTextOrientation || "auto";
    const totalDisplayedPages = isHorizontalPaged ? Math.max(1, pageRanges.length) : verticalPageInfo.total;
    const displayedPageLabel = isHorizontalPaged
        ? (rightPageRange
            ? `${spreadStartIdx + 1}–${spreadStartIdx + 2}`
            : String(spreadStartIdx + 1))
        : String(verticalPageInfo.current);

    return (
        <div className="epub-reader-shell">
            <div
                ref={stageRef}
                className="epub-reader-stage"
                onMouseMove={handleStageMouseMove}
                onMouseLeave={handleStageMouseLeave}
            >
                <div
                    className={`epub-floating-top${isMobile ? " is-mobile" : ""}${topChromeVisible ? " is-visible" : " is-hidden"}`}
                    onFocus={() => setTopHover(true)}
                >
                    <div className="epub-glass-pill epub-glass-pill-main" onClick={(event) => event.stopPropagation()}>
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
                            className={`epub-glass-btn${tocOpen && drawerTab === "toc" ? " is-active" : ""}`}
                            onClick={() => {
                                setAppearanceOpen(false);
                                setSearchOpen(false);
                                if (tocOpen && drawerTab === "toc") {
                                    setTocOpen(false);
                                } else {
                                    setDrawerTab("toc");
                                    setTocOpen(true);
                                }
                            }}
                            disabled={chapters.length === 0}
                            title={t("epub.toc")}
                        >
                            <IconBookTab /> {!isMobile && <span>{t("epub.toc")}</span>}
                        </button>
                        <span className="epub-pill-divider" aria-hidden="true" />
                        <div className="epub-toolbar-title">
                            <span className="epub-toolbar-book">{tab.epub?.title || bookMeta?.title || tab.name}</span>
                            <span className="epub-toolbar-chapter">
                                {chapter?.title || t("epub.chapterOf", { current: chapterIndex + 1, total: chapterCount })}
                            </span>
                        </div>
                    </div>

                    <div className="epub-glass-pill epub-glass-pill-tools" onClick={(event) => event.stopPropagation()}>
                        <span className="epub-badge" title={isJapaneseBook ? t("epub.languageJa") : t("epub.languageEn")}>
                            {isJapaneseBook ? "JA" : "EN"}
                        </span>
                        {isJapaneseBook ? (
                            <EpubGlassSelect
                                className="epub-orientation-glass-select"
                                align="right"
                                ariaLabel={t("epub.orientationAuto")}
                                value={activeBookOrientationValue}
                                onChange={(next) => onChangeBookOrientation(next as EpubOrientationSetting)}
                                options={[
                                    { value: "auto", label: t("epub.orientationAuto") },
                                    { value: "horizontal", label: t("epub.orientationHorizontal") },
                                    { value: "vertical", label: t("epub.orientationVertical") },
                                ]}
                            />
                        ) : !isMobile ? (
                            <span className="epub-orientation-locked" title={t("epub.orientationLockedEn")}>
                                {t("epub.orientationHorizontal")}
                            </span>
                        ) : null}

                        <button
                            type="button"
                            className={`epub-glass-btn epub-glass-circle${searchOpen ? " is-active" : ""}`}
                            title={`${t("epub.searchBook")} (Ctrl+F)`}
                            aria-label={t("epub.searchBook")}
                            onClick={() => {
                                setTocOpen(false);
                                setAppearanceOpen(false);
                                setSearchOpen((prev) => {
                                    const next = !prev;
                                    if (next) window.setTimeout(() => searchInputRef.current?.focus(), 40);
                                    return next;
                                });
                            }}
                        >
                            <IconSearch />
                        </button>

                        {onChangeBookBookmarks && (
                            <button
                                type="button"
                                className={`epub-glass-btn epub-glass-circle${tocOpen && drawerTab === "bookmarks" ? " is-active" : ""}`}
                                title={`${t("epub.bookmarks")} (B)`}
                                aria-label={t("epub.bookmarks")}
                                onClick={() => {
                                    setAppearanceOpen(false);
                                    setSearchOpen(false);
                                    if (tocOpen && drawerTab === "bookmarks") {
                                        setTocOpen(false);
                                    } else {
                                        setDrawerTab("bookmarks");
                                        setTocOpen(true);
                                    }
                                }}
                            >
                                <IconBookmarkSvg />
                            </button>
                        )}

                        {(onChangeBookHighlights || onChangeBookNotes) && (
                            <button
                                type="button"
                                className={`epub-glass-btn epub-glass-circle${tocOpen && drawerTab === "notes" ? " is-active" : ""}`}
                                title={t("epub.notes")}
                                aria-label={t("epub.notes")}
                                onClick={() => {
                                    setAppearanceOpen(false);
                                    setSearchOpen(false);
                                    if (tocOpen && drawerTab === "notes") {
                                        setTocOpen(false);
                                    } else {
                                        setDrawerTab("notes");
                                        setTocOpen(true);
                                    }
                                }}
                            >
                                ✎
                            </button>
                        )}

                        {bookPath && (
                            <button
                                type="button"
                                className={`epub-glass-btn epub-glass-circle${galleryOpen ? " is-active" : ""}`}
                                title={t("epub.gallery")}
                                aria-label={t("epub.gallery")}
                                onClick={() => {
                                    setTocOpen(false);
                                    setAppearanceOpen(false);
                                    setSearchOpen(false);
                                    setGalleryOpen(true);
                                }}
                            >
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                                    <rect x="3" y="3" width="18" height="18" rx="2" />
                                    <circle cx="8.5" cy="8.5" r="1.5" />
                                    <path d="M21 15l-5-5L5 21" />
                                </svg>
                            </button>
                        )}

                        {!isMobile && onChangeReadingPoint && (
                            <button
                                type="button"
                                className={`epub-glass-btn epub-glass-circle${settingReadingPoint ? " is-active" : ""}`}
                                title={t("epub.readingPoint")}
                                aria-label={t("epub.readingPoint")}
                                onClick={() => setSettingReadingPoint((prev) => !prev)}
                            >
                                ⌖
                            </button>
                        )}

                        {!isMobile && (
                            <button
                                type="button"
                                className={`epub-glass-btn epub-glass-circle${zenMode ? " is-active" : ""}`}
                                title={t("epub.zenMode")}
                                aria-label={t("epub.zenMode")}
                                onClick={() => setZenMode((prev) => !prev)}
                            >
                                ⛶
                            </button>
                        )}

                        {onUpdateSettings && (
                            <button
                                type="button"
                                className={`epub-glass-btn epub-aa-btn${appearanceOpen ? " is-active" : ""}`}
                                aria-expanded={appearanceOpen}
                                title={t("epub.appearance")}
                                onClick={() => {
                                    setTocOpen(false);
                                    setSearchOpen(false);
                                    setAppearanceOpen((prev) => !prev);
                                }}
                            >
                                Aa
                            </button>
                        )}
                    </div>
                </div>

                {searchOpen && (
                    <div
                        className={`epub-search-popover${isMobile ? " is-mobile" : ""}`}
                        role="dialog"
                        aria-label={t("epub.searchBook")}
                        onClick={(event) => event.stopPropagation()}
                    >
                        <div className="epub-search-input-row">
                            <span className="epub-library-search-icon" aria-hidden="true"><IconSearch /></span>
                            <input
                                ref={searchInputRef}
                                type="search"
                                className="epub-search-input"
                                value={searchQuery}
                                onChange={(event) => setSearchQuery(event.target.value)}
                                placeholder={t("epub.searchPlaceholder")}
                                aria-label={t("epub.searchPlaceholder")}
                            />
                            <button
                                type="button"
                                className="epub-glass-btn epub-glass-circle"
                                aria-label={t("common.close")}
                                onClick={() => setSearchOpen(false)}
                            >
                                <IconClose />
                            </button>
                        </div>

                        <div className="epub-search-status">
                            {searching
                                ? t("epub.searchSearching")
                                : searchQuery.trim()
                                    ? (searchHits.length > 0
                                        ? t("epub.searchHits", { count: searchHits.length })
                                        : t("epub.searchNoResults"))
                                    : null}
                        </div>

                        {searchHits.length > 0 && (
                            <div className="epub-search-results">
                                {searchHits.map((hit, idx) => (
                                    <button
                                        key={`${hit.chapterIndex}-${hit.paragraphIndex}-${idx}`}
                                        type="button"
                                        className="epub-search-hit"
                                        onClick={() => {
                                            jumpToLocation(hit.chapterIndex, hit.paragraphIndex);
                                            if (isMobile) setSearchOpen(false);
                                        }}
                                    >
                                        <span className="epub-search-hit-ch">
                                            {hit.chapterTitle || t("epub.chapterOf", { current: hit.chapterIndex + 1, total: chapterCount })}
                                        </span>
                                        <span className="epub-search-hit-snippet">{hit.snippet}</span>
                                    </button>
                                ))}
                            </div>
                        )}
                    </div>
                )}

                {appearanceOpen && onUpdateSettings && (
                    <div
                        className={`epub-appearance-popover${isMobile ? " is-mobile" : ""}`}
                        role="dialog"
                        aria-label={t("epub.appearance")}
                        onClick={(event) => event.stopPropagation()}
                    >
                        <div className="epub-pop-head">
                            <span>{t("epub.appearance")}</span>
                            <button
                                type="button"
                                className="epub-pop-reset"
                                onClick={() => onUpdateSettings({
                                    epubFontSize: 21,
                                    epubLineHeight: 1.65,
                                    epubParagraphSpacing: 14,
                                    epubPagePadding: 24,
                                    epubMaxWidth: 1040,
                                })}
                            >
                                {t("epub.resetTypography")}
                            </button>
                        </div>

                        <div className="epub-pop-row">
                            <span className="epub-pop-label">{t("epub.readingMode")}</span>
                            <div className="epub-segmented">
                                <button
                                    type="button"
                                    className={`epub-seg-btn${readingMode === "paged" ? " is-active" : ""}`}
                                    onClick={() => onUpdateSettings({ epubReadingMode: "paged" })}
                                >
                                    {t("epub.modePaged")}
                                </button>
                                <button
                                    type="button"
                                    className={`epub-seg-btn${readingMode === "scroll" ? " is-active" : ""}`}
                                    onClick={() => onUpdateSettings({ epubReadingMode: "scroll" })}
                                >
                                    {t("epub.modeScroll")}
                                </button>
                            </div>
                        </div>

                        {canUseSpread && (
                            <div className="epub-pop-row">
                                <span className="epub-pop-label">{t("epub.pageLayout")}</span>
                                <div className="epub-segmented">
                                    <button
                                        type="button"
                                        className={`epub-seg-btn${!spreadEnabled ? " is-active" : ""}`}
                                        onClick={() => setSpreadPreference(false)}
                                    >
                                        {t("epub.singlePage")}
                                    </button>
                                    <button
                                        type="button"
                                        className={`epub-seg-btn${spreadEnabled ? " is-active" : ""}`}
                                        onClick={() => setSpreadPreference(true)}
                                    >
                                        {t("epub.twoPageSpread")}
                                    </button>
                                </div>
                            </div>
                        )}

                        <div className="epub-pop-font-row">
                            <FontPicker
                                english={language === "en"}
                                title={language === "en" ? "Reader font" : "Шрифт текста"}
                                value={settings.epubFontFamily || settings.fontFamily}
                                onChange={(value) => onUpdateSettings({ epubFontFamily: value })}
                                defaultFilter={isJapaneseBook ? "japanese" : "latin"}
                                showLatinFilter
                                sampleText="あの日見た花の名前を、僕達はまだ知らない。"
                                latinSampleText="Down the rabbit-hole went Alice, never once considering how to get out again."
                                presets={buildEpubFontPresets({
                                    serif: t("wizard.font.serif"),
                                    sans: t("wizard.font.sans"),
                                    yu: t("wizard.font.yu"),
                                    meiryo: t("wizard.font.meiryo"),
                                    english: language === "en",
                                })}
                                customFont={(settings.customFontData || settings.customFontPath) && settings.customFontFamily
                                    ? {
                                        value: `'${settings.customFontFamily}', sans-serif`,
                                        label: settings.customFontName || (language === "en" ? "Custom font" : "Свой шрифт"),
                                        hint: language === "en" ? "Font file" : "Файл шрифта",
                                    }
                                    : null}
                            />
                        </div>

                        <div className="epub-pop-slider-group">
                            <div className="epub-pop-slider-head">
                                <span className="epub-pop-label">{t("epub.fontSize")}</span>
                                <div className="epub-stepper">
                                    <button
                                        type="button"
                                        className="epub-step-btn"
                                        onClick={() => onUpdateSettings({ epubFontSize: Math.max(14, fontSize - 1) })}
                                    >
                                        A−
                                    </button>
                                    <span className="epub-pop-val">{fontSize}px</span>
                                    <button
                                        type="button"
                                        className="epub-step-btn"
                                        onClick={() => onUpdateSettings({ epubFontSize: Math.min(44, fontSize + 1) })}
                                    >
                                        A+
                                    </button>
                                </div>
                            </div>
                            <input
                                type="range"
                                min={14}
                                max={44}
                                step={1}
                                value={fontSize}
                                onChange={(event) => onUpdateSettings({ epubFontSize: Number(event.target.value) })}
                            />
                        </div>

                        <div className="epub-pop-slider-group">
                            <div className="epub-pop-slider-head">
                                <span className="epub-pop-label">{t("epub.lineHeight")}</span>
                                <span className="epub-pop-val">{lineHeight.toFixed(2)}</span>
                            </div>
                            <input
                                type="range"
                                min={1.2}
                                max={2.4}
                                step={0.05}
                                value={lineHeight}
                                onChange={(event) => onUpdateSettings({ epubLineHeight: Number(event.target.value) })}
                            />
                        </div>

                        {!isMobile && !isVertical && (
                            <div className="epub-pop-slider-group">
                                <div className="epub-pop-slider-head">
                                    <span className="epub-pop-label">{t("epub.columnWidth")}</span>
                                    <span className="epub-pop-val">{maxWidth}px</span>
                                </div>
                                <input
                                    type="range"
                                    min={560}
                                    max={1400}
                                    step={20}
                                    value={maxWidth}
                                    onChange={(event) => onUpdateSettings({ epubMaxWidth: Number(event.target.value) })}
                                />
                            </div>
                        )}

                        <div className="epub-pop-slider-group">
                            <div className="epub-pop-slider-head">
                                <span className="epub-pop-label">{t("epub.paragraphSpacing")}</span>
                                <span className="epub-pop-val">{paragraphGap}px</span>
                            </div>
                            <input
                                type="range"
                                min={0}
                                max={40}
                                step={2}
                                value={paragraphGap}
                                onChange={(event) => onUpdateSettings({ epubParagraphSpacing: Number(event.target.value) })}
                            />
                        </div>

                        <div className="epub-pop-slider-group">
                            <div className="epub-pop-slider-head">
                                <span className="epub-pop-label">{t("epub.pagePadding")}</span>
                                <span className="epub-pop-val">{effectivePadding}px</span>
                            </div>
                            <input
                                type="range"
                                min={8}
                                max={80}
                                step={4}
                                value={effectivePadding}
                                onChange={(event) => onUpdateSettings({ epubPagePadding: Number(event.target.value) })}
                            />
                        </div>

                        {isJapaneseBook && (
                            <div className="epub-pop-row">
                                <span className="epub-pop-label">{t("epub.furigana")}</span>
                                <div className="epub-segmented">
                                    {(["show", "hover", "hide"] as const).map((mode) => (
                                        <button
                                            key={mode}
                                            type="button"
                                            className={`epub-seg-btn${furiganaMode === mode ? " is-active" : ""}`}
                                            onClick={() => onUpdateSettings({ epubFuriganaMode: mode })}
                                        >
                                            {mode === "show" ? t("epub.furiganaShow")
                                                : mode === "hover" ? t("epub.furiganaHover")
                                                    : t("epub.furiganaHide")}
                                        </button>
                                    ))}
                                </div>
                            </div>
                        )}

                        <div className="epub-pop-row">
                            <span className="epub-pop-label">{t("epub.blurMode")}</span>
                            <div className="epub-segmented">
                                {(["off", "after-toc", "all"] as const).map((mode) => (
                                    <button
                                        key={mode}
                                        type="button"
                                        className={`epub-seg-btn${blurImagesMode === mode ? " is-active" : ""}`}
                                        onClick={() => onUpdateSettings({
                                            epubBlurImagesMode: mode,
                                            epubBlurImages: mode !== "off",
                                        })}
                                    >
                                        {mode === "off" ? t("epub.blurOff")
                                            : mode === "after-toc" ? t("epub.blurAfterToc")
                                                : t("epub.blurAll")}
                                    </button>
                                ))}
                            </div>
                        </div>

                        <div className="epub-pop-row">
                            <span className="epub-pop-label">{t("epub.textIndent")}</span>
                            <div className="epub-segmented">
                                {(["auto", "none", "indent"] as const).map((mode) => (
                                    <button
                                        key={mode}
                                        type="button"
                                        className={`epub-seg-btn${textIndent === mode ? " is-active" : ""}`}
                                        onClick={() => onUpdateSettings({ epubTextIndent: mode })}
                                    >
                                        {mode === "auto" ? t("epub.indentAuto")
                                            : mode === "none" ? t("epub.indentNone")
                                                : t("epub.indentEm")}
                                    </button>
                                ))}
                            </div>
                        </div>

                        <label className="epub-pop-row epub-pop-check-row">
                            <span className="epub-pop-label">{t("epub.justify")}</span>
                            <input
                                type="checkbox"
                                checked={justifyText}
                                onChange={(event) => onUpdateSettings({ epubJustify: event.target.checked })}
                            />
                        </label>

                        <label className="epub-pop-row epub-pop-check-row">
                            <span className="epub-pop-label">{t("epub.prettyWrap")}</span>
                            <input
                                type="checkbox"
                                checked={prettyWrap}
                                onChange={(event) => onUpdateSettings({ epubPrettyWrap: event.target.checked })}
                            />
                        </label>

                        {isJapaneseBook && isVertical && (
                            <label className="epub-pop-row epub-pop-check-row">
                                <span className="epub-pop-label">{t("epub.verticalGrid")}</span>
                                <input
                                    type="checkbox"
                                    checked={verticalGrid}
                                    onChange={(event) => onUpdateSettings({ epubVerticalGrid: event.target.checked })}
                                />
                            </label>
                        )}

                        {!isPaged && (
                            <div className="epub-pop-slider-group">
                                <div className="epub-pop-slider-head">
                                    <span className="epub-pop-label">{t("epub.autoscrollSpeed")}</span>
                                    <span className="epub-pop-val">{autoscrollSpeed} px/s</span>
                                </div>
                                <input
                                    type="range"
                                    min={10}
                                    max={200}
                                    step={4}
                                    value={autoscrollSpeed}
                                    onChange={(event) => onUpdateSettings({ epubAutoscrollSpeed: Number(event.target.value) })}
                                />
                            </div>
                        )}

                        <div className="epub-pop-row epub-pop-themes-row">
                            <span className="epub-pop-label">{t("epub.theme")}</span>
                            <div className="epub-theme-swatches">
                                {QUICK_THEMES.map((item) => (
                                    <button
                                        key={item.value}
                                        type="button"
                                        className={`epub-theme-swatch${epubTheme === item.value ? " is-active" : ""}`}
                                        style={{ background: item.swatch, color: item.fg }}
                                        title={t(item.labelKey)}
                                        aria-label={t(item.labelKey)}
                                        onClick={() => onUpdateSettings({ epubTheme: item.value })}
                                    >
                                        A
                                    </button>
                                ))}
                            </div>
                        </div>
                    </div>
                )}

                {!isMobile && (isPaged || isVertical) && (
                    <>
                        <div className={`epub-edge-hint epub-edge-hint-left${edgeHover === "left" && !lookupActive && !escMenuOpen ? " is-visible" : ""}`} aria-hidden="true">
                            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                                <polyline points="15 18 9 12 15 6" />
                            </svg>
                        </div>
                        <div className={`epub-edge-hint epub-edge-hint-right${edgeHover === "right" && !lookupActive && !escMenuOpen ? " is-visible" : ""}`} aria-hidden="true">
                            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                                <polyline points="9 18 15 12 9 6" />
                            </svg>
                        </div>
                    </>
                )}

                {isHorizontalPaged && chapter && !loading && (
                    <div className="epub-measurer-host" aria-hidden="true">
                        <div
                            ref={measurerRef}
                            aria-hidden="true"
                            className="epub-page-measurer"
                            style={{
                                ...surfaceStyle,
                                width: `${measurerWidth}px`,
                            }}
                        >
                            {paragraphs.map((p) => {
                                if (p.kind === "separator") {
                                    return <hr key={p.index} data-paragraph-index={p.index} className="epub-separator" />;
                                }
                                if (p.kind === "image") {
                                    if (!showImages || !p.imageSrc) return null;
                                    return (
                                        <figure key={p.index} data-paragraph-index={p.index} className="epub-image-block">
                                            <img src={p.imageSrc} alt="" />
                                        </figure>
                                    );
                                }
                                return (
                                    <EpubHtmlParagraph
                                        key={p.index}
                                        index={p.index}
                                        className={`epub-block epub-block-${p.kind}`}
                                        html={p.html}
                                    />
                                );
                            })}
                        </div>
                    </div>
                )}

                {error ? (
                    <div className="epub-status-overlay">
                        <strong>{t("epub.loadError", { error })}</strong>
                        <button type="button" className="btn-primary" onClick={onOpenFile}>
                            <IconImport /> {t("epub.openFile")}
                        </button>
                    </div>
                ) : loading && !chapter ? (
                    <div className="epub-status-overlay">
                        <span>{t("epub.loadingChapter")}</span>
                    </div>
                ) : (
                    <div
                        ref={surfaceRef}
                        className="epub-reader-surface"
                        data-app-theme={settings.theme || "dark"}
                        data-epub-theme={epubTheme}
                        data-epub-orientation={resolvedOrientation}
                        data-epub-mode={isPaged ? "paged" : "scroll"}
                        data-epub-spread={useTwoPageSpread ? "true" : "false"}
                        data-epub-furigana={furiganaMode}
                        data-epub-justify={justifyText ? "true" : "false"}
                        data-epub-pretty-wrap={prettyWrap ? "true" : "false"}
                        data-epub-vertical-grid={verticalGrid ? "true" : "false"}
                        data-epub-indent={textIndent}
                        style={surfaceStyle}
                        onScroll={handleScroll}
                        onClick={handleContentClick}
                        onMouseUp={handleSurfaceMouseUp}
                        onTouchStart={handleSurfaceTouchStart}
                        onTouchEnd={handleSurfaceTouchEnd}
                    >
                        {useVirtualizedScroll ? (
                            <div
                                className="epub-content-flow"
                                style={{
                                    position: "relative",
                                    height: `${rowVirtualizer.getTotalSize()}px`,
                                }}
                            >
                                {rowVirtualizer.getVirtualItems().map((virtualRow) => {
                                    const p = paragraphs[virtualRow.index];
                                    if (!p) return null;
                                    return (
                                        <div
                                            key={p.index}
                                            data-index={virtualRow.index}
                                            ref={rowVirtualizer.measureElement}
                                            style={{
                                                position: "absolute",
                                                top: 0,
                                                left: 0,
                                                width: "100%",
                                                transform: `translateY(${virtualRow.start}px)`,
                                            }}
                                        >
                                            {renderParagraph(p)}
                                        </div>
                                    );
                                })}
                            </div>
                        ) : useTwoPageSpread ? (
                            <div
                                key={`${chapter?.index ?? 0}:${spreadStartIdx}`}
                                className={`epub-content-flow epub-spread-flow${pageTurnDirRef.current === 1 ? " is-turn-next" : pageTurnDirRef.current === -1 ? " is-turn-prev" : ""}`}
                            >
                                <div className="epub-spread-page">
                                    {visibleParagraphs.map((p) => renderParagraph(p))}
                                </div>
                                <div className="epub-spread-spine" aria-hidden="true" />
                                <div className="epub-spread-page">
                                    {rightVisibleParagraphs.map((p) => renderParagraph(p))}
                                </div>
                            </div>
                        ) : (
                            <div
                                key={isHorizontalPaged ? `${chapter?.index ?? 0}:${spreadStartIdx}` : `scroll:${chapter?.index ?? 0}`}
                                className={`epub-content-flow${isHorizontalPaged ? (pageTurnDirRef.current === 1 ? " is-turn-next" : pageTurnDirRef.current === -1 ? " is-turn-prev" : "") : ""}`}
                            >
                                {visibleParagraphs.map((p) => renderParagraph(p))}
                            </div>
                        )}
                    </div>
                )}

                {settingReadingPoint && (
                    <div className="epub-point-banner" onClick={(e) => e.stopPropagation()}>
                        <span>⌖ {t("epub.readingPointHint")}</span>
                        <button type="button" className="epub-glass-btn" onClick={() => setSettingReadingPoint(false)}>
                            {t("common.close")}
                        </button>
                    </div>
                )}

                {selectionPill && (
                    <div
                        className="epub-selection-pill"
                        style={{ left: `${selectionPill.x}px`, top: `${selectionPill.y}px` }}
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={(e) => e.stopPropagation()}
                    >
                        {(["amber", "emerald", "sky", "rose"] as const).map((color) => (
                            <button
                                key={color}
                                type="button"
                                className={`epub-hl-dot epub-hl-dot-${color}`}
                                title={t("epub.highlights")}
                                onClick={() => handleAddHighlight(color, false)}
                            />
                        ))}
                        <span className="epub-pill-divider" aria-hidden="true" />
                        <button
                            type="button"
                            className="epub-glass-btn"
                            onClick={() => handleAddHighlight("amber", true)}
                        >
                            {t("epub.notes")}
                        </button>
                        <button
                            type="button"
                            className="epub-glass-btn"
                            onClick={() => {
                                setQuoteModalText(selectionPill.text);
                                setSelectionPill(null);
                                window.getSelection()?.removeAllRanges();
                            }}
                        >
                            {t("epub.quoteImage")}
                        </button>
                    </div>
                )}

                {tocOpen && (
                    <div className="epub-toc-backdrop" onClick={() => setTocOpen(false)}>
                        <aside className="epub-toc-drawer" onClick={(event) => event.stopPropagation()}>
                            <div className="epub-toc-head">
                                <div className="epub-segmented">
                                    <button
                                        type="button"
                                        className={`epub-seg-btn${drawerTab === "toc" ? " is-active" : ""}`}
                                        onClick={() => setDrawerTab("toc")}
                                    >
                                        {t("epub.toc")}
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
                                    {(onChangeBookHighlights || onChangeBookNotes) && (
                                        <button
                                            type="button"
                                            className={`epub-seg-btn${drawerTab === "notes" ? " is-active" : ""}`}
                                            onClick={() => setDrawerTab("notes")}
                                        >
                                            {t("epub.notes")}{(highlights.length + notes.length) > 0 ? ` (${highlights.length + notes.length})` : ""}
                                        </button>
                                    )}
                                </div>
                                <button
                                    type="button"
                                    className="epub-glass-btn epub-glass-circle"
                                    aria-label={t("common.close")}
                                    onClick={() => setTocOpen(false)}
                                >
                                    <IconClose />
                                </button>
                            </div>

                            {drawerTab === "toc" ? (
                                <div className="epub-toc-list">
                                    {chapters.map((item) => (
                                        <button
                                            key={item.id || item.index}
                                            type="button"
                                            className={`epub-toc-item${item.index === chapterIndex ? " is-active" : ""}`}
                                            onClick={() => {
                                                setTocOpen(false);
                                                callbacksRef.current.onSelectChapter(item.index);
                                            }}
                                        >
                                            <span className="epub-toc-num">{item.index + 1}.</span>
                                            <span>{item.title || item.href}</span>
                                        </button>
                                    ))}
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
                                                                setTocOpen(false);
                                                                jumpToLocation(bm.chapterIndex, bm.paragraphIndex);
                                                            }}
                                                        >
                                                            <span className="epub-bookmark-title">{bm.label}</span>
                                                            <span className="epub-bookmark-meta">
                                                                {bm.chapterTitle || t("epub.chapterOf", { current: bm.chapterIndex + 1, total: chapterCount })}
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

                                    {highlights.length === 0 && notes.length === 0 ? (
                                        <div className="epub-bookmarks-empty">{t("epub.noNotes")}</div>
                                    ) : (
                                        <div className="epub-toc-list">
                                            {highlights.map((hl) => (
                                                <div key={hl.id} className={`epub-bookmark-card epub-hl-card epub-hl-card-${hl.color}`}>
                                                    <button
                                                        type="button"
                                                        className="epub-bookmark-jump"
                                                        onClick={() => {
                                                            setTocOpen(false);
                                                            jumpToLocation(hl.chapterIndex, hl.paragraphIndex);
                                                        }}
                                                    >
                                                        <span className="epub-hl-card-quote">“{hl.text}”</span>
                                                        <span className="epub-bookmark-meta">
                                                            {hl.chapterTitle || t("epub.chapterOf", { current: hl.chapterIndex + 1, total: chapterCount })}
                                                        </span>
                                                        {hl.note && editingHighlightId !== hl.id && (
                                                            <span className="epub-bookmark-excerpt">{hl.note}</span>
                                                        )}
                                                    </button>
                                                    {editingHighlightId === hl.id && (
                                                        <form
                                                            className="epub-bookmark-rename-form"
                                                            onSubmit={(e) => {
                                                                e.preventDefault();
                                                                handleSaveHighlightNote(hl.id);
                                                            }}
                                                        >
                                                            <input
                                                                type="text"
                                                                className="epub-bookmark-input"
                                                                autoFocus
                                                                value={editingHighlightNote}
                                                                onChange={(e) => setEditingHighlightNote(e.target.value)}
                                                                onBlur={() => handleSaveHighlightNote(hl.id)}
                                                                placeholder={t("epub.noteBodyPlaceholder")}
                                                            />
                                                        </form>
                                                    )}
                                                    <div className="epub-bookmark-actions">
                                                        <button
                                                            type="button"
                                                            className="epub-glass-btn epub-bookmark-act-btn"
                                                            title={t("epub.quoteImage")}
                                                            onClick={() => {
                                                                setTocOpen(false);
                                                                setQuoteModalText(hl.text);
                                                            }}
                                                        >
                                                            ⎙
                                                        </button>
                                                        <button
                                                            type="button"
                                                            className="epub-glass-btn epub-bookmark-act-btn"
                                                            title={t("epub.notes")}
                                                            onClick={() => {
                                                                setEditingHighlightId(hl.id);
                                                                setEditingHighlightNote(hl.note || "");
                                                            }}
                                                        >
                                                            ✎
                                                        </button>
                                                        <button
                                                            type="button"
                                                            className="epub-glass-btn epub-bookmark-act-btn is-danger"
                                                            title={t("common.close")}
                                                            onClick={() => handleDeleteHighlight(hl.id)}
                                                        >
                                                            <IconClose />
                                                        </button>
                                                    </div>
                                                </div>
                                            ))}

                                            {notes.map((note) => (
                                                <div key={note.id} className="epub-bookmark-card">
                                                    <button
                                                        type="button"
                                                        className="epub-bookmark-jump"
                                                        onClick={() => {
                                                            if (typeof note.chapterIndex === "number") {
                                                                setTocOpen(false);
                                                                jumpToLocation(note.chapterIndex, note.paragraphIndex ?? 0);
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

                <div
                    className={`epub-floating-bottom${isMobile ? " is-mobile" : ""}${bottomChromeVisible ? " is-visible" : " is-hidden"}`}
                    onFocus={() => setBottomHover(true)}
                    onClick={(event) => event.stopPropagation()}
                >
                    <div className="epub-glass-pill epub-nav-capsule">
                        <button
                            type="button"
                            className="epub-glass-btn epub-glass-circle"
                            disabled={chapterIndex <= 0}
                            title={t("epub.prevChapter")}
                            onClick={() => {
                                pageTurnDirRef.current = -1;
                                callbacksRef.current.onSelectChapter(Math.max(0, chapterIndex - 1));
                            }}
                        >
                            «
                        </button>
                        {(isPaged || isVertical) && (
                            <button
                                type="button"
                                className="epub-glass-btn epub-glass-circle"
                                title={isVertical ? t("epub.nextPage") : t("epub.prevPage")}
                                onClick={() => turnPage(isVertical ? 1 : -1)}
                            >
                                ‹
                            </button>
                        )}

                        <div className="epub-nav-meta">
                            <div className="epub-nav-meta-text">
                                <span>{t("epub.chapterOf", { current: chapterIndex + 1, total: chapterCount })}</span>
                                {(isPaged || isVertical) && totalDisplayedPages > 1 && (
                                    <span>· {t("epub.pageOf", { current: displayedPageLabel, total: totalDisplayedPages })}</span>
                                )}
                                <span className="epub-nav-pct">{t("epub.progress", { percent: currentProgressPct })}</span>
                            </div>
                            <div className="epub-nav-progress-track" aria-hidden="true">
                                <div className="epub-nav-progress-fill" style={{ width: `${currentProgressPct}%` }} />
                            </div>
                        </div>

                        {(isPaged || isVertical) && (
                            <button
                                type="button"
                                className="epub-glass-btn epub-glass-circle"
                                title={isVertical ? t("epub.prevPage") : t("epub.nextPage")}
                                onClick={() => turnPage(isVertical ? -1 : 1)}
                            >
                                ›
                            </button>
                        )}
                        <button
                            type="button"
                            className="epub-glass-btn epub-glass-circle"
                            disabled={chapterIndex + 1 >= chapterCount}
                            title={t("epub.nextChapter")}
                            onClick={() => {
                                pageTurnDirRef.current = 1;
                                callbacksRef.current.onSelectChapter(Math.min(chapterCount - 1, chapterIndex + 1));
                            }}
                        >
                            »
                        </button>

                        {!isPaged && (
                            <>
                                <span className="epub-pill-divider" aria-hidden="true" />
                                <button
                                    type="button"
                                    className={`epub-glass-btn${autoscrollActive ? " is-active" : ""}`}
                                    title={`${t("epub.autoscroll")} (S / A / D)`}
                                    onClick={() => setAutoscrollActive((prev) => !prev)}
                                >
                                    {autoscrollActive ? "⏸" : "▶"} {!isMobile && <span>{autoscrollSpeed}</span>}
                                </button>
                            </>
                        )}

                        {readingPoint && (
                            <button
                                type="button"
                                className="epub-glass-btn epub-glass-circle"
                                title={t("epub.returnToPoint")}
                                onClick={() => jumpToLocation(readingPoint.chapterIndex, readingPoint.paragraphIndex)}
                            >
                                ↩
                            </button>
                        )}

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

                {/* Unobtrusive Goal Progress Light when bottom chrome is hidden */}
                {!zenMode && !bottomChromeVisible && !lookupActive && !escMenuOpen && activeGoals.enabled && onOpenStats && (
                    <button
                        type="button"
                        className="epub-goal-corner-dot"
                        title={`${t("epub.statsTitle")} · ${Math.round(goalSummary.overallPct * 100)}%`}
                        aria-label={t("epub.statsTitle")}
                        onClick={(e) => {
                            e.stopPropagation();
                            onOpenStats();
                        }}
                    >
                        <span className={`epub-goal-dot is-${goalSummary.status}`} />
                    </button>
                )}

                <EpubGalleryModal
                    open={galleryOpen}
                    bookPath={bookPath}
                    bookTitle={tab.epub?.title || bookMeta?.title || tab.name}
                    language={language}
                    onClose={() => setGalleryOpen(false)}
                    onJumpToImage={(chIdx, paraIdx) => jumpToLocation(chIdx, paraIdx)}
                />

                <EpubQuoteModal
                    open={Boolean(quoteModalText)}
                    quote={quoteModalText || ""}
                    bookTitle={tab.epub?.title || bookMeta?.title || tab.name}
                    author={tab.epub?.author || bookMeta?.author || undefined}
                    chapterTitle={chapter?.title || undefined}
                    coverDataUrl={coverDataUrl}
                    fontFamily={settings.epubFontFamily || settings.fontFamily || "serif"}
                    initialTheme={epubTheme === "paper" || epubTheme === "ttu-light" ? "paper"
                        : epubTheme === "sepia" || epubTheme === "ttu-ecru" ? "sepia"
                            : epubTheme === "ttu-black" ? "black"
                                : "dark"}
                    language={language}
                    onClose={() => setQuoteModalText(null)}
                />
            </div>
        </div>
    );
}
