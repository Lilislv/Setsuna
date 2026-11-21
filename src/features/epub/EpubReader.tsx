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
} from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { AppSettings } from "../../components/SettingsModal";
import type { Tab } from "../../utils/constants";
import { getTranslator } from "../../utils/i18n";
import { TokenizedLine } from "../../components/TextContainer";
import { IconBookTab, IconClose, IconImport } from "../../components/Icons";
import {
    clamp01,
    computeBookProgress,
    resolveEpubHrefTarget,
    resolveEpubOrientation,
    type EpubBookMeta,
    type EpubChapterContent,
    type EpubOrientationSetting,
    type EpubParagraph,
} from "./epubModel";

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
    pendingFragment: string | null;
    onFragmentHandled: () => void;
    onSelectChapter: (chapterIndex: number, fragment?: string) => void;
    onProgressChange: (chapterIndex: number, chapterOffset: number, bookProgress: number) => void;
    onChangeBookOrientation: (orientation: EpubOrientationSetting) => void;
    onUpdateSettings?: (patch: Partial<AppSettings>) => void;
    onLookupToken?: LookupTokenHandler;
    onBackToLibrary: () => void;
    onOpenFile: () => void;
}

type PageRange = { start: number; end: number };
type EpubThemeOption = NonNullable<AppSettings["epubTheme"]>;

const VIRTUALIZE_THRESHOLD = 160;
const PROGRESS_THROTTLE_MS = 350;
const WHEEL_PAGE_COOLDOWN_MS = 220;
const SPREAD_STORAGE_KEY = "setsuna-epub-spread";
const SPREAD_MIN_WIDTH = 1020;
const SPREAD_GAP = 57;
const CHROME_TOP_ZONE_PX = 76;
const CHROME_BOTTOM_ZONE_PX = 70;
const CHROME_HIDE_DELAY_MS = 320;

type EpubQuickThemeLabelKey =
    | "epub.themeApp"
    | "epub.themeDark"
    | "epub.themePaper"
    | "epub.themeSepia"
    | "epub.themeBlack";

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
}: {
    index: number;
    id?: string;
    anchorIds?: string;
    src: string;
    alt: string;
}) {
    return (
        <figure
            id={id}
            data-paragraph-index={index}
            data-anchor-ids={anchorIds}
            className="epub-image-block"
        >
            <img src={src} alt={alt} loading="lazy" />
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
    pendingFragment,
    onFragmentHandled,
    onSelectChapter,
    onProgressChange,
    onChangeBookOrientation,
    onUpdateSettings,
    onLookupToken,
    onBackToLibrary,
    onOpenFile,
}: EpubReaderProps) {
    const language = settings.appLanguage || "ru";
    const t = getTranslator(language);
    const stageRef = useRef<HTMLDivElement>(null);
    const surfaceRef = useRef<HTMLDivElement>(null);
    const measurerRef = useRef<HTMLDivElement>(null);
    const lastProgressSentRef = useRef(0);
    const lastWheelPageRef = useRef(0);
    const restoringRef = useRef(false);
    const topHideTimerRef = useRef<number | null>(null);
    const bottomHideTimerRef = useRef<number | null>(null);
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
    const [appearanceOpen, setAppearanceOpen] = useState(false);
    const [topHover, setTopHover] = useState(false);
    const [bottomHover, setBottomHover] = useState(false);
    const [spreadEnabled, setSpreadEnabled] = useState<boolean>(readStoredSpreadPreference);
    const [pageRanges, setPageRanges] = useState<PageRange[]>([{ start: 0, end: 0 }]);
    const [currentPageIdx, setCurrentPageIdx] = useState(0);
    const [verticalPageInfo, setVerticalPageInfo] = useState({ current: 1, total: 1 });
    const [surfaceSize, setSurfaceSize] = useState({ width: 800, height: 600 });

    useEffect(() => () => {
        if (topHideTimerRef.current !== null) window.clearTimeout(topHideTimerRef.current);
        if (bottomHideTimerRef.current !== null) window.clearTimeout(bottomHideTimerRef.current);
    }, []);

    const handleStageMouseMove = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
        if (isMobile) return;
        const stage = stageRef.current;
        if (!stage) return;
        const rect = stage.getBoundingClientRect();
        const relY = event.clientY - rect.top;
        const nearTop = relY <= CHROME_TOP_ZONE_PX;
        const nearBottom = relY >= rect.height - CHROME_BOTTOM_ZONE_PX;

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
    }, [isMobile, topHover, bottomHover]);

    const handleStageMouseLeave = useCallback(() => {
        if (isMobile) return;
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

    const topChromeVisible = isMobile || topHover || tocOpen || appearanceOpen;
    const bottomChromeVisible = isMobile || bottomHover;

    const setSpreadPreference = useCallback((next: boolean) => {
        setSpreadEnabled(next);
        try {
            localStorage.setItem(SPREAD_STORAGE_KEY, next ? "true" : "false");
        } catch {}
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
    const chapters = useMemo(() => bookMeta?.chapters || [], [bookMeta?.chapters]);
    const chapterIndex = chapter?.index ?? tab.epub?.chapterIndex ?? 0;
    const chapterCount = chapters.length || tab.epub?.chapterCount || 1;
    const paragraphs = useMemo(() => chapter?.paragraphs || [], [chapter?.paragraphs]);

    const fontSize = settings.epubFontSize ?? 21;
    const lineHeight = settings.epubLineHeight ?? 1.65;
    const maxWidth = settings.epubMaxWidth ?? 1040;
    const effectivePadding = isMobile
        ? Math.min(18, settings.epubPagePadding ?? 18)
        : (settings.epubPagePadding ?? 24);
    const paragraphGap = settings.epubParagraphSpacing ?? 14;
    const topClearance = isMobile ? 54 : 24;
    const bottomClearance = isMobile ? 52 : 28;

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
            const step = Math.max(1, el.clientWidth);
            const totalPages = Math.max(1, Math.ceil(el.scrollWidth / step));
            const currentPage = Math.min(totalPages, Math.max(1, Math.round(current / step) + 1));
            return { fraction, currentPage, totalPages, max, step };
        }
        const max = Math.max(0, el.scrollHeight - el.clientHeight);
        const current = Math.max(0, el.scrollTop);
        const fraction = max > 0 ? clamp01(current / max) : 1;
        return { fraction, currentPage: 1, totalPages: 1, max, step: Math.max(1, el.clientHeight) };
    }, [isVertical]);

    // Restore chapter offset or jump to anchor fragment when chapter finishes loading
    const restoredChapterKeyRef = useRef<string>("");
    useEffect(() => {
        if (!chapter || loading) return;

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
        pageRanges,
        paragraphs,
        getScrollMetrics,
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

        const now = Date.now();
        if (now - lastProgressSentRef.current < PROGRESS_THROTTLE_MS) return;
        lastProgressSentRef.current = now;

        const bookProgress = computeBookProgress(chapter.index, chapterCount, metrics.fraction);
        callbacksRef.current.onProgressChange(chapter.index, metrics.fraction, bookProgress);
    }, [isHorizontalPaged, chapter, chapterCount, getScrollMetrics]);

    const goToHorizontalPage = useCallback((nextIdx: number) => {
        if (!chapter) return;
        const total = Math.max(1, pageRanges.length);
        const clamped = Math.min(total - 1, Math.max(0, nextIdx));
        setCurrentPageIdx(clamped);
        const reachedPage = useTwoPageSpread ? Math.min(total - 1, clamped + 1) : clamped;
        const fraction = total <= 1 ? 1 : clamp01(reachedPage / (total - 1));
        const bookProgress = computeBookProgress(chapter.index, chapterCount, fraction);
        callbacksRef.current.onProgressChange(chapter.index, fraction, bookProgress);
    }, [chapter, chapterCount, pageRanges.length, useTwoPageSpread]);

    const turnPage = useCallback((direction: 1 | -1) => {
        if (!chapter) return;

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

    useEffect(() => {
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.ctrlKey || event.metaKey || event.altKey) return;
            const target = event.target as HTMLElement | null;
            if (target && ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)) return;
            if (tocOpen || appearanceOpen) {
                if (event.key === "Escape") {
                    setTocOpen(false);
                    setAppearanceOpen(false);
                }
                return;
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
        window.addEventListener("keydown", onKeyDown);
        return () => window.removeEventListener("keydown", onKeyDown);
    }, [isVertical, isPaged, tocOpen, appearanceOpen, turnPage]);

    // Internal EPUB link clicks (`data-epub-href`) without globally stopping propagation
    const handleContentClick = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
        if (appearanceOpen) {
            setAppearanceOpen(false);
        }
        const target = event.target as HTMLElement | null;
        const link = target?.closest<HTMLAnchorElement>("a[data-epub-href]");
        if (!link) return;
        event.preventDefault();
        const rawHref = link.getAttribute("data-epub-href") || "";
        const resolved = resolveEpubHrefTarget(rawHref, chapters);
        if (resolved) {
            callbacksRef.current.onSelectChapter(resolved.chapterIndex, resolved.fragment);
        }
    }, [chapters, appearanceOpen]);

    const handleMobileTokenTap = useCallback(
        (paragraphIndex: number) =>
            (token: string, sentence: string, cursor: number, boundaries?: number[], lemma?: string) => {
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
                return callbacksRef.current.onLookupToken?.(token, sentence, cursor, boundaries, lemma);
            },
        [isVertical],
    );

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

    const renderParagraph = useCallback((p: EpubParagraph) => {
        if (p.kind === "separator") {
            return <hr key={p.index} className="epub-separator" data-paragraph-index={p.index} />;
        }

        if (p.kind === "image") {
            if (!showImages || !p.imageSrc) return null;
            return (
                <EpubImageBlock
                    key={p.index}
                    index={p.index}
                    id={p.id || undefined}
                    anchorIds={p.anchorIds.join(" ") || undefined}
                    src={p.imageSrc}
                    alt={p.imageAlt || ""}
                />
            );
        }

        const blockClass = `text-line epub-block epub-block-${p.kind}`;

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
                html={p.html}
            />
        );
    }, [showImages, isMobile, onLookupToken, settings.furiganaMode, handleMobileTokenTap]);

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
                            className={`epub-glass-btn${tocOpen ? " is-active" : ""}`}
                            onClick={() => {
                                setAppearanceOpen(false);
                                setTocOpen((prev) => !prev);
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
                            <select
                                className="epub-orientation-select"
                                aria-label={t("epub.orientationAuto")}
                                value={activeBookOrientationValue}
                                onChange={(event) => {
                                    onChangeBookOrientation(event.target.value as EpubOrientationSetting);
                                    event.currentTarget.blur();
                                }}
                            >
                                <option value="auto">{t("epub.orientationAuto")}</option>
                                <option value="horizontal">{t("epub.orientationHorizontal")}</option>
                                <option value="vertical">{t("epub.orientationVertical")}</option>
                            </select>
                        ) : !isMobile ? (
                            <span className="epub-orientation-locked" title={t("epub.orientationLockedEn")}>
                                {t("epub.orientationHorizontal")}
                            </span>
                        ) : null}
                        {onUpdateSettings && (
                            <button
                                type="button"
                                className={`epub-glass-btn epub-aa-btn${appearanceOpen ? " is-active" : ""}`}
                                aria-expanded={appearanceOpen}
                                title={t("epub.appearance")}
                                onClick={() => {
                                    setTocOpen(false);
                                    setAppearanceOpen((prev) => !prev);
                                }}
                            >
                                Aa
                            </button>
                        )}
                    </div>
                </div>

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

                {isHorizontalPaged && chapter && !loading && (
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
                        style={surfaceStyle}
                        onScroll={handleScroll}
                        onClick={handleContentClick}
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
                            <div className="epub-content-flow epub-spread-flow">
                                <div className="epub-spread-page">
                                    {visibleParagraphs.map((p) => renderParagraph(p))}
                                </div>
                                <div className="epub-spread-spine" aria-hidden="true" />
                                <div className="epub-spread-page">
                                    {rightVisibleParagraphs.map((p) => renderParagraph(p))}
                                </div>
                            </div>
                        ) : (
                            <div className="epub-content-flow">
                                {visibleParagraphs.map((p) => renderParagraph(p))}
                            </div>
                        )}
                    </div>
                )}

                {tocOpen && (
                    <div className="epub-toc-backdrop" onClick={() => setTocOpen(false)}>
                        <aside className="epub-toc-drawer" onClick={(event) => event.stopPropagation()}>
                            <div className="epub-toc-head">
                                <span>{t("epub.toc")}</span>
                                <button
                                    type="button"
                                    className="epub-glass-btn epub-glass-circle"
                                    aria-label={t("common.close")}
                                    onClick={() => setTocOpen(false)}
                                >
                                    <IconClose />
                                </button>
                            </div>
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
                            onClick={() => callbacksRef.current.onSelectChapter(Math.max(0, chapterIndex - 1))}
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
                            onClick={() => callbacksRef.current.onSelectChapter(Math.min(chapterCount - 1, chapterIndex + 1))}
                        >
                            »
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
}
