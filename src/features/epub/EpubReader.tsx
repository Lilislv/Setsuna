import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent, type WheelEvent as ReactWheelEvent } from "react";
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

const VIRTUALIZE_THRESHOLD = 160;
const PROGRESS_THROTTLE_MS = 350;
const PAGE_GAP_PX = 48;

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
    const lastProgressSentRef = useRef(0);
    const restoringRef = useRef(false);
    const [tocOpen, setTocOpen] = useState(false);
    const [pageInfo, setPageInfo] = useState({ current: 1, total: 1 });
    const [surfaceWidth, setSurfaceWidth] = useState(760);

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
    const epubTheme = settings.epubTheme || "app";
    const showImages = settings.epubShowImages ?? true;
    const chapters = bookMeta?.chapters || [];
    const chapterIndex = chapter?.index ?? tab.epub?.chapterIndex ?? 0;
    const chapterCount = chapters.length || tab.epub?.chapterCount || 1;
    const paragraphs = chapter?.paragraphs || [];

    const useVirtualizedScroll = !isVertical && !isPaged && paragraphs.length > VIRTUALIZE_THRESHOLD;

    const rowVirtualizer = useVirtualizer({
        count: useVirtualizedScroll ? paragraphs.length : 0,
        getScrollElement: () => surfaceRef.current,
        estimateSize: () => Math.max(48, (settings.epubFontSize ?? 26) * (settings.epubLineHeight ?? 2.05) + (settings.epubParagraphSpacing ?? 22)),
        overscan: 10,
    });

    useEffect(() => {
        const el = surfaceRef.current;
        if (!el) return;
        const measure = () => {
            const pad = settings.epubPagePadding ?? 34;
            const inner = Math.max(240, el.clientWidth - pad * 2);
            const maxWidth = settings.epubMaxWidth ?? 880;
            setSurfaceWidth(Math.min(inner, maxWidth));
        };
        measure();
        const observer = new ResizeObserver(measure);
        observer.observe(el);
        return () => observer.disconnect();
    }, [settings.epubPagePadding, settings.epubMaxWidth, isPaged, isVertical]);

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
        if (isPaged) {
            const max = Math.max(0, el.scrollWidth - el.clientWidth);
            const current = Math.max(0, el.scrollLeft);
            const fraction = max > 0 ? clamp01(current / max) : 1;
            const step = Math.max(1, surfaceWidth + PAGE_GAP_PX);
            const totalPages = Math.max(1, Math.round((el.scrollWidth + PAGE_GAP_PX) / step));
            const currentPage = Math.min(totalPages, Math.max(1, Math.round(current / step) + 1));
            return { fraction, currentPage, totalPages, max, step };
        }
        const max = Math.max(0, el.scrollHeight - el.clientHeight);
        const current = Math.max(0, el.scrollTop);
        const fraction = max > 0 ? clamp01(current / max) : 1;
        return { fraction, currentPage: 1, totalPages: 1, max, step: Math.max(1, el.clientHeight) };
    }, [isVertical, isPaged, surfaceWidth]);

    const countVisibleParagraphs = useCallback((el: HTMLDivElement) => {
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
                : isPaged
                    ? box.left <= rect.right + 40
                    : box.top <= rect.bottom + 20;
            if (isReached && idx > maxPassed) {
                maxPassed = idx;
            }
        });
        if (maxPassed >= 0) {
            onCountParagraphs(chapter.index, paragraphs, maxPassed);
        }
    }, [chapter, paragraphs, isVertical, isPaged, onCountParagraphs]);

    // Restore chapter offset or jump to anchor fragment when chapter finishes loading
    useLayoutEffect(() => {
        const el = surfaceRef.current;
        if (!el || !chapter || loading) return;

        restoringRef.current = true;
        const timer = window.setTimeout(() => {
            if (pendingFragment) {
                const safeId = pendingFragment.replace(/["\\]/g, "\\$&");
                const target = el.querySelector<HTMLElement>(`[id="${safeId}"], [data-anchor-ids~="${safeId}"]`);
                if (target) {
                    target.scrollIntoView({ block: "start", inline: "nearest" });
                }
                onFragmentHandled();
            } else {
                const savedOffset = chapter.index === (tab.epub?.chapterIndex ?? 0)
                    ? clamp01(tab.epub?.chapterOffset || 0)
                    : 0;
                if (isVertical) {
                    const max = Math.max(0, el.scrollWidth - el.clientWidth);
                    el.scrollLeft = -max * savedOffset;
                } else if (isPaged) {
                    const max = Math.max(0, el.scrollWidth - el.clientWidth);
                    el.scrollLeft = max * savedOffset;
                } else {
                    const max = Math.max(0, el.scrollHeight - el.clientHeight);
                    el.scrollTop = max * savedOffset;
                }
            }
            const metrics = getScrollMetrics(el);
            setPageInfo({ current: metrics.currentPage, total: metrics.totalPages });
            countVisibleParagraphs(el);
            restoringRef.current = false;
        }, 40);

        return () => {
            window.clearTimeout(timer);
            restoringRef.current = false;
        };
    }, [chapter?.index, chapter?.href, loading, isVertical, isPaged, pendingFragment]);

    const handleScroll = useCallback(() => {
        const el = surfaceRef.current;
        if (!el || !chapter) return;
        const metrics = getScrollMetrics(el);
        setPageInfo({ current: metrics.currentPage, total: metrics.totalPages });
        if (restoringRef.current) return;

        onReadingActivity();
        countVisibleParagraphs(el);

        const now = Date.now();
        if (now - lastProgressSentRef.current < PROGRESS_THROTTLE_MS) return;
        lastProgressSentRef.current = now;

        const bookProgress = computeBookProgress(chapter.index, chapterCount, metrics.fraction);
        onProgressChange(chapter.index, metrics.fraction, bookProgress);
    }, [chapter, chapterCount, getScrollMetrics, onReadingActivity, countVisibleParagraphs, onProgressChange]);

    const turnPage = useCallback((direction: 1 | -1) => {
        const el = surfaceRef.current;
        if (!el || !chapter) return;
        onReadingActivity();

        const metrics = getScrollMetrics(el);
        const atEnd = direction === 1 && metrics.fraction >= 0.99;
        const atStart = direction === -1 && metrics.fraction <= 0.01;

        if (atEnd) {
            if (chapter.index + 1 < chapterCount) {
                onSelectChapter(chapter.index + 1);
            }
            return;
        }
        if (atStart) {
            if (chapter.index > 0) {
                onSelectChapter(chapter.index - 1);
            }
            return;
        }

        if (isVertical) {
            const delta = metrics.step * direction;
            el.scrollTo({ left: el.scrollLeft - delta, behavior: "smooth" });
        } else if (isPaged) {
            const delta = metrics.step * direction;
            el.scrollTo({ left: el.scrollLeft + delta, behavior: "smooth" });
        } else {
            const delta = Math.max(120, el.clientHeight * 0.85) * direction;
            el.scrollTo({ top: el.scrollTop + delta, behavior: "smooth" });
        }
    }, [chapter, chapterCount, getScrollMetrics, isVertical, isPaged, onReadingActivity, onSelectChapter]);

    const handleWheel = useCallback((event: ReactWheelEvent<HTMLDivElement>) => {
        const el = surfaceRef.current;
        if (!el) return;
        if (isVertical) {
            if (Math.abs(event.deltaY) > Math.abs(event.deltaX)) {
                event.preventDefault();
                el.scrollLeft -= event.deltaY;
            }
        } else if (isPaged) {
            if (Math.abs(event.deltaY) > Math.abs(event.deltaX)) {
                event.preventDefault();
                el.scrollLeft += event.deltaY;
            }
        }
    }, [isVertical, isPaged]);

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
                // Vertical-rl reads right-to-left: ArrowLeft advances forward
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
            onSelectChapter(resolved.chapterIndex, resolved.fragment);
        }
    }, [chapters, onSelectChapter]);

    const handleMobileTokenTap = useCallback(
        (paragraphIndex: number) =>
            (token: string, sentence: string, cursor: number, boundaries?: number[], lemma?: string) => {
                onReadingActivity();
                const el = surfaceRef.current?.querySelector<HTMLElement>(
                    `[data-paragraph-index="${paragraphIndex}"]`,
                );
                if (el) {
                    // Keep the tapped line/column visible above the 58vh mobile lookup sheet
                    el.scrollIntoView({
                        block: isVertical ? "nearest" : "start",
                        inline: isVertical ? "center" : "nearest",
                        behavior: "smooth",
                    });
                }
                return onLookupToken?.(token, sentence, cursor, boundaries, lemma);
            },
        [isVertical, onLookupToken, onReadingActivity],
    );

    const surfaceStyle = useMemo<CSSProperties>(() => {
        const style: Record<string, string | number> = {
            "--epub-font-size": `${settings.epubFontSize ?? 26}px`,
            "--epub-font-family": settings.epubFontFamily || settings.fontFamily || "var(--txt-font-family)",
            "--epub-line-height": settings.epubLineHeight ?? 2.05,
            "--epub-paragraph-gap": `${settings.epubParagraphSpacing ?? 22}px`,
            "--epub-page-padding": `${isMobile ? Math.min(20, settings.epubPagePadding ?? 20) : (settings.epubPagePadding ?? 34)}px`,
            "--epub-max-width": `${settings.epubMaxWidth ?? 880}px`,
            "--epub-image-max-width": `${settings.epubImageMaxWidth ?? 720}px`,
            "--epub-page-col-width": `${surfaceWidth}px`,
            "--epub-page-gap": `${PAGE_GAP_PX}px`,
        };
        return style as CSSProperties;
    }, [
        settings.epubFontSize,
        settings.epubFontFamily,
        settings.fontFamily,
        settings.epubLineHeight,
        settings.epubParagraphSpacing,
        settings.epubPagePadding,
        settings.epubMaxWidth,
        settings.epubImageMaxWidth,
        isMobile,
        surfaceWidth,
    ]);

    const renderParagraph = useCallback((p: EpubParagraph) => {
        if (p.kind === "separator") {
            return <hr key={p.index} className="epub-separator" data-paragraph-index={p.index} />;
        }

        if (p.kind === "image") {
            if (!showImages || !p.imageSrc) return null;
            return (
                <figure
                    key={p.index}
                    id={p.id || undefined}
                    data-paragraph-index={p.index}
                    data-anchor-ids={p.anchorIds.join(" ") || undefined}
                    className="epub-image-block"
                >
                    <img src={p.imageSrc} alt={p.imageAlt || ""} loading="lazy" />
                </figure>
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

        // Desktop: render sanitized allow-list HTML directly inside `.text-line`
        // so hoverScan.ts handles Shift+hover, ruby skipping, Selection highlight, and Anki sentence extraction.
        return (
            <div
                key={p.index}
                id={p.id || undefined}
                data-paragraph-index={p.index}
                data-anchor-ids={p.anchorIds.join(" ") || undefined}
                className={blockClass}
                dangerouslySetInnerHTML={{ __html: p.html }}
            />
        );
    }, [showImages, isMobile, onLookupToken, settings.furiganaMode, handleMobileTokenTap]);

    const currentProgressPct = Math.round(clamp01(tab.epub?.progress || 0) * 100);
    const activeBookOrientationValue: EpubOrientationSetting =
        tab.epub?.orientation || settings.epubTextOrientation || "auto";

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
                            onChange={(event) => onChangeBookOrientation(event.target.value as EpubOrientationSetting)}
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
                        onWheel={handleWheel}
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
                                {paragraphs.map((p) => renderParagraph(p))}
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
                                            onSelectChapter(item.index);
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
                        onClick={() => onSelectChapter(Math.max(0, chapterIndex - 1))}
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
                    {(isPaged || isVertical) && pageInfo.total > 1 && (
                        <span>· {t("epub.pageOf", { current: pageInfo.current, total: pageInfo.total })}</span>
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
                        onClick={() => onSelectChapter(Math.min(chapterCount - 1, chapterIndex + 1))}
                    >
                        »
                    </button>
                </div>
            </div>
        </div>
    );
}
