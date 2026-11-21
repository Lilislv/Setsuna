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
    onCountParagraphs: (chapterIndex: number, paragraphs: EpubParagraph[], upToIndex: number) => void;
    onReadingActivity: () => void;
    onChangeBookOrientation: (orientation: EpubOrientationSetting) => void;
    onLookupToken?: LookupTokenHandler;
    onBackToLibrary: () => void;
    onOpenFile: () => void;
}

type PageRange = { start: number; end: number };

const VIRTUALIZE_THRESHOLD = 160;
const PROGRESS_THROTTLE_MS = 350;
const WHEEL_PAGE_COOLDOWN_MS = 220;

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
    onCountParagraphs,
    onReadingActivity,
    onChangeBookOrientation,
    onLookupToken,
    onBackToLibrary,
    onOpenFile,
}: EpubReaderProps) {
    const language = settings.appLanguage || "ru";
    const t = getTranslator(language);
    const surfaceRef = useRef<HTMLDivElement>(null);
    const measurerRef = useRef<HTMLDivElement>(null);
    const lastProgressSentRef = useRef(0);
    const lastWheelPageRef = useRef(0);
    const restoringRef = useRef(false);
    const callbacksRef = useRef({
        onFragmentHandled,
        onSelectChapter,
        onProgressChange,
        onCountParagraphs,
        onReadingActivity,
        onLookupToken,
    });
    callbacksRef.current = {
        onFragmentHandled,
        onSelectChapter,
        onProgressChange,
        onCountParagraphs,
        onReadingActivity,
        onLookupToken,
    };

    const [tocOpen, setTocOpen] = useState(false);
    const [pageRanges, setPageRanges] = useState<PageRange[]>([{ start: 0, end: 0 }]);
    const [currentPageIdx, setCurrentPageIdx] = useState(0);
    const [verticalPageInfo, setVerticalPageInfo] = useState({ current: 1, total: 1 });
    const [surfaceSize, setSurfaceSize] = useState({ width: 800, height: 600 });

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
    const epubTheme = settings.epubTheme || "app";
    const showImages = settings.epubShowImages ?? true;
    const chapters = useMemo(() => bookMeta?.chapters || [], [bookMeta?.chapters]);
    const chapterIndex = chapter?.index ?? tab.epub?.chapterIndex ?? 0;
    const chapterCount = chapters.length || tab.epub?.chapterCount || 1;
    const paragraphs = useMemo(() => chapter?.paragraphs || [], [chapter?.paragraphs]);

    const effectivePadding = isMobile
        ? Math.min(20, settings.epubPagePadding ?? 20)
        : (settings.epubPagePadding ?? 34);
    const paragraphGap = settings.epubParagraphSpacing ?? 22;

    const useVirtualizedScroll = !isVertical && !isPaged && paragraphs.length > VIRTUALIZE_THRESHOLD;

    const rowVirtualizer = useVirtualizer({
        count: useVirtualizedScroll ? paragraphs.length : 0,
        getScrollElement: () => surfaceRef.current,
        estimateSize: () => Math.max(48, (settings.epubFontSize ?? 26) * (settings.epubLineHeight ?? 2.05) + paragraphGap),
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

        const usableHeight = Math.max(160, surfaceSize.height - effectivePadding * 2 - 12);
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
            const blockH = heights.get(i) ?? Math.max(40, (settings.epubFontSize ?? 26) * (settings.epubLineHeight ?? 2.05));
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
        chapter,
        loading,
        paragraphs,
        surfaceSize.width,
        surfaceSize.height,
        effectivePadding,
        paragraphGap,
        showImages,
        settings.epubFontSize,
        settings.epubFontFamily,
        settings.fontFamily,
        settings.epubLineHeight,
        settings.epubMaxWidth,
        settings.epubImageMaxWidth,
    ]);

    const activePageIdx = Math.min(Math.max(0, pageRanges.length - 1), Math.max(0, currentPageIdx));
    const activePageRange = pageRanges[activePageIdx] || { start: 0, end: paragraphs.length };
    const visibleParagraphs = useMemo(() => {
        if (!isHorizontalPaged) return paragraphs;
        return paragraphs.slice(activePageRange.start, activePageRange.end);
    }, [isHorizontalPaged, paragraphs, activePageRange.start, activePageRange.end]);

    // Count paragraphs reached on the current horizontal page
    useEffect(() => {
        if (!isHorizontalPaged || !chapter || loading || paragraphs.length === 0) return;
        const lastVisibleIndex = Math.min(paragraphs.length - 1, Math.max(0, activePageRange.end - 1));
        callbacksRef.current.onCountParagraphs(chapter.index, paragraphs, lastVisibleIndex);
        if (surfaceRef.current) {
            surfaceRef.current.scrollTop = 0;
        }
    }, [isHorizontalPaged, chapter, loading, paragraphs, activePageRange.start, activePageRange.end]);

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

    const countVisibleScrollParagraphs = useCallback((el: HTMLDivElement) => {
        if (!chapter || paragraphs.length === 0) return;
        const rect = el.getBoundingClientRect();
        const nodes = el.querySelectorAll<HTMLElement>("[data-paragraph-index]");
        let maxPassed = -1;
        nodes.forEach((node) => {
            const idx = Number(node.dataset.paragraphIndex);
            if (!Number.isInteger(idx)) return;
            const box = node.getBoundingClientRect();
            const isReached = isVertical
                ? box.left <= rect.right && box.right >= rect.left - 40
                : box.top <= rect.bottom + 20 && box.bottom >= rect.top - 20;
            if (isReached && idx > maxPassed) {
                maxPassed = idx;
            }
        });
        if (maxPassed >= 0) {
            callbacksRef.current.onCountParagraphs(chapter.index, paragraphs, maxPassed);
        }
    }, [chapter, paragraphs, isVertical]);

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
            countVisibleScrollParagraphs(el);
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
        countVisibleScrollParagraphs,
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

        callbacksRef.current.onReadingActivity();
        countVisibleScrollParagraphs(el);

        const now = Date.now();
        if (now - lastProgressSentRef.current < PROGRESS_THROTTLE_MS) return;
        lastProgressSentRef.current = now;

        const bookProgress = computeBookProgress(chapter.index, chapterCount, metrics.fraction);
        callbacksRef.current.onProgressChange(chapter.index, metrics.fraction, bookProgress);
    }, [isHorizontalPaged, chapter, chapterCount, getScrollMetrics, countVisibleScrollParagraphs]);

    const goToHorizontalPage = useCallback((nextIdx: number) => {
        if (!chapter) return;
        const total = Math.max(1, pageRanges.length);
        const clamped = Math.min(total - 1, Math.max(0, nextIdx));
        setCurrentPageIdx(clamped);
        const fraction = total <= 1 ? 1 : clamp01(clamped / (total - 1));
        const bookProgress = computeBookProgress(chapter.index, chapterCount, fraction);
        callbacksRef.current.onProgressChange(chapter.index, fraction, bookProgress);
    }, [chapter, chapterCount, pageRanges.length]);

    const turnPage = useCallback((direction: 1 | -1) => {
        if (!chapter) return;
        callbacksRef.current.onReadingActivity();

        if (isHorizontalPaged) {
            const nextIdx = activePageIdx + direction;
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
    }, [chapter, chapterCount, isHorizontalPaged, activePageIdx, pageRanges.length, goToHorizontalPage, getScrollMetrics, isVertical]);

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
            if (tocOpen) {
                if (event.key === "Escape") {
                    setTocOpen(false);
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
    }, [isVertical, isPaged, tocOpen, turnPage]);

    // Internal EPUB link clicks (`data-epub-href`) without globally stopping propagation
    const handleContentClick = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
        const target = event.target as HTMLElement | null;
        const link = target?.closest<HTMLAnchorElement>("a[data-epub-href]");
        if (!link) return;
        event.preventDefault();
        const rawHref = link.getAttribute("data-epub-href") || "";
        const resolved = resolveEpubHrefTarget(rawHref, chapters);
        if (resolved) {
            callbacksRef.current.onSelectChapter(resolved.chapterIndex, resolved.fragment);
        }
    }, [chapters]);

    const handleMobileTokenTap = useCallback(
        (paragraphIndex: number) =>
            (token: string, sentence: string, cursor: number, boundaries?: number[], lemma?: string) => {
                callbacksRef.current.onReadingActivity();
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

    const surfaceStyle = useMemo<CSSProperties>(() => {
        const style: Record<string, string | number> = {
            "--epub-font-size": `${settings.epubFontSize ?? 26}px`,
            "--epub-font-family": settings.epubFontFamily || settings.fontFamily || "var(--txt-font-family)",
            "--epub-line-height": settings.epubLineHeight ?? 2.05,
            "--epub-paragraph-gap": `${paragraphGap}px`,
            "--epub-page-padding": `${effectivePadding}px`,
            "--epub-max-width": `${settings.epubMaxWidth ?? 880}px`,
            "--epub-image-max-width": `${settings.epubImageMaxWidth ?? 720}px`,
        };
        return style as CSSProperties;
    }, [
        settings.epubFontSize,
        settings.epubFontFamily,
        settings.fontFamily,
        settings.epubLineHeight,
        paragraphGap,
        effectivePadding,
        settings.epubMaxWidth,
        settings.epubImageMaxWidth,
    ]);

    const measurerWidth = Math.min(
        Math.max(240, surfaceSize.width - effectivePadding * 2),
        settings.epubMaxWidth ?? 880,
    );

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
    const displayedPageInfo = isHorizontalPaged
        ? { current: activePageIdx + 1, total: Math.max(1, pageRanges.length) }
        : verticalPageInfo;

    return (
        <div className="epub-reader-shell">
            <div className={`epub-toolbar${isMobile ? " is-mobile" : ""}`}>
                <div className="epub-toolbar-group" style={{ flex: 1 }}>
                    <button type="button" className="epub-icon-btn" onClick={onBackToLibrary}>
                        ← {!isMobile && t("epub.backToLibrary")}
                    </button>
                    <button
                        type="button"
                        className={`epub-icon-btn${tocOpen ? " is-active" : ""}`}
                        onClick={() => setTocOpen((prev) => !prev)}
                        disabled={chapters.length === 0}
                    >
                        <IconBookTab /> {!isMobile && t("epub.toc")}
                    </button>
                    <div className="epub-toolbar-title">
                        <span className="epub-toolbar-book">{tab.epub?.title || bookMeta?.title || tab.name}</span>
                        <span className="epub-toolbar-chapter">
                            {chapter?.title || t("epub.chapterOf", { current: chapterIndex + 1, total: chapterCount })}
                        </span>
                    </div>
                </div>

                <div className="epub-toolbar-group">
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
                        <select
                            className="epub-orientation-select"
                            disabled
                            value="horizontal"
                            title={t("epub.orientationLockedEn")}
                            aria-label={t("epub.orientationLockedEn")}
                        >
                            <option value="horizontal">{t("epub.orientationHorizontal")}</option>
                        </select>
                    ) : null}
                </div>
            </div>

            <div className="epub-reader-stage">
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
                        data-epub-theme={epubTheme}
                        data-epub-orientation={resolvedOrientation}
                        data-epub-mode={isPaged ? "paged" : "scroll"}
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
                                    className="epub-icon-btn"
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
            </div>

            <div className={`epub-footer${isMobile ? " is-mobile" : ""}`}>
                <div className="epub-toolbar-group">
                    <button
                        type="button"
                        className="epub-icon-btn"
                        disabled={chapterIndex <= 0}
                        title={t("epub.prevChapter")}
                        onClick={() => callbacksRef.current.onSelectChapter(Math.max(0, chapterIndex - 1))}
                    >
                        «
                    </button>
                    {(isPaged || isVertical) && (
                        <button
                            type="button"
                            className="epub-icon-btn"
                            title={isVertical ? t("epub.nextPage") : t("epub.prevPage")}
                            onClick={() => turnPage(isVertical ? 1 : -1)}
                        >
                            ‹
                        </button>
                    )}
                </div>

                <div className="epub-footer-center">
                    <span>{t("epub.chapterOf", { current: chapterIndex + 1, total: chapterCount })}</span>
                    {(isPaged || isVertical) && displayedPageInfo.total > 1 && (
                        <span>· {t("epub.pageOf", { current: displayedPageInfo.current, total: displayedPageInfo.total })}</span>
                    )}
                    <span>· {t("epub.progress", { percent: currentProgressPct })}</span>
                </div>

                <div className="epub-toolbar-group">
                    {(isPaged || isVertical) && (
                        <button
                            type="button"
                            className="epub-icon-btn"
                            title={isVertical ? t("epub.prevPage") : t("epub.nextPage")}
                            onClick={() => turnPage(isVertical ? -1 : 1)}
                        >
                            ›
                        </button>
                    )}
                    <button
                        type="button"
                        className="epub-icon-btn"
                        disabled={chapterIndex + 1 >= chapterCount}
                        title={t("epub.nextChapter")}
                        onClick={() => callbacksRef.current.onSelectChapter(Math.min(chapterCount - 1, chapterIndex + 1))}
                    >
                        »
                    </button>
                </div>
            </div>
        </div>
    );
}
