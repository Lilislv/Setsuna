import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as pdfjsLib from "pdfjs-dist";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import type { PDFDocumentProxy, RenderTask } from "pdfjs-dist/types/src/display/api";
import type { AppSettings } from "../../components/SettingsModal";
import type { Tab } from "../../utils/constants";
import { getTranslator } from "../../utils/i18n";
import { TokenizedLine } from "../../components/TextContainer";
import { IconClose, IconSearch } from "../../components/Icons";
import { readBookBinary } from "./epubApi";
import { setMemoryCover } from "./epubCoverCache";
import type { EpubBookMeta } from "./epubModel";
import {
    buildPdfLookupTarget,
    buildPdfSearchSnippet,
    groupPdfTextItemsIntoLines,
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

export interface PdfReaderProps {
    tab: Tab;
    settings: AppSettings;
    isMobile: boolean;
    lookupOpen?: boolean;
    escMenuOpen?: boolean;
    onBackToLibrary: () => void;
    onUpdateBookMeta: (tabId: number, meta: EpubBookMeta) => void;
    onProgressChange: (pageIndex: number, offset: number, progress: number) => void;
    onRecordReadingStats?: (deltaChars: number, deltaSeconds: number) => void;
    onLookupToken?: LookupTokenHandler;
    onOverlayStateChange?: (open: boolean) => void;
    closeOverlaySignal?: number;
}

const ZOOM_STEPS = [0.6, 0.75, 0.9, 1.0, 1.15, 1.3, 1.5, 1.75, 2.0, 2.5];

export default function PdfReader({
    tab,
    settings,
    isMobile,
    escMenuOpen = false,
    onBackToLibrary,
    onUpdateBookMeta,
    onProgressChange,
    onRecordReadingStats,
    onLookupToken,
    onOverlayStateChange,
    closeOverlaySignal = 0,
}: PdfReaderProps) {
    const language = settings.appLanguage || "ru";
    const isEn = language === "en";
    const t = getTranslator(language);

    const bookPath = tab.epub?.path || "";
    const initialPage = Math.max(1, (tab.epub?.chapterIndex ?? 0) + 1);

    const [pdfDoc, setPdfDoc] = useState<PDFDocumentProxy | null>(null);
    const [numPages, setNumPages] = useState(0);
    const [pageNumber, setPageNumber] = useState(initialPage);
    const [pageInput, setPageInput] = useState(String(initialPage));
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    const [viewMode, setViewMode] = useState<"page" | "text">("page");
    const [zoomMode, setZoomMode] = useState<"fit" | "custom">("fit");
    const [scale, setScale] = useState(1.0);
    const [nightFilter, setNightFilter] = useState(false);

    const [pageLines, setPageLines] = useState<PdfTextLine[]>([]);
    const [pageSize, setPageSize] = useState<{ width: number; height: number }>({ width: 0, height: 0 });
    const [outline, setOutline] = useState<PdfOutlineEntry[]>([]);
    const [tocOpen, setTocOpen] = useState(false);
    const [searchOpen, setSearchOpen] = useState(false);
    const [searchQuery, setSearchQuery] = useState("");
    const [searchHits, setSearchHits] = useState<PdfSearchHit[]>([]);
    const [searching, setSearching] = useState(false);

    const viewportWrapRef = useRef<HTMLDivElement>(null);
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const renderTaskRef = useRef<RenderTask | null>(null);
    const countedPagesRef = useRef<Set<number>>(new Set());
    const swipeStartRef = useRef<{ x: number; y: number; at: number } | null>(null);
    const searchGenRef = useRef(0);
    const onProgressRef = useRef(onProgressChange);
    onProgressRef.current = onProgressChange;
    const onUpdateMetaRef = useRef(onUpdateBookMeta);
    onUpdateMetaRef.current = onUpdateBookMeta;
    const onRecordStatsRef = useRef(onRecordReadingStats);
    onRecordStatsRef.current = onRecordReadingStats;

    const epubTheme = settings.epubTheme || "app";
    const pdfThemeClass = `epub-theme-${epubTheme}`;

    useEffect(() => {
        onOverlayStateChange?.(tocOpen || searchOpen);
    }, [tocOpen, searchOpen, onOverlayStateChange]);

    useEffect(() => {
        if (closeOverlaySignal > 0) {
            setTocOpen(false);
            setSearchOpen(false);
        }
    }, [closeOverlaySignal]);

    // Load PDF document binary from Tauri backend
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
                const clamped = Math.min(Math.max(1, initialPage), doc.numPages);
                setPageNumber(clamped);
                setPageInput(String(clamped));
                setLoading(false);

                // Extract PDF metadata, outline & generate Page-1 cover thumbnail asynchronously
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

                // Resolve outline items to 1-based page numbers
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
                                pageNumber: Math.min(Math.max(1, pageNo), doc.numPages),
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

                // Generate a lightweight Page-1 cover thumbnail for the Library
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
        const clamped = Math.min(Math.max(1, pageNumber), numPages);
        setPageInput(String(clamped));
        const progress = numPages === 1 ? 1 : (clamped - 1) / (numPages - 1);
        onProgressRef.current(clamped - 1, 0, Math.min(1, Math.max(0, progress)));
    }, [pageNumber, numPages]);

    // Render current PDF page onto HiDPI canvas + extract interactive text lines
    useEffect(() => {
        if (!pdfDoc || numPages <= 0) return;
        let cancelled = false;

        void (async () => {
            try {
                const page = await pdfDoc.getPage(Math.min(Math.max(1, pageNumber), numPages));
                if (cancelled) return;

                const unscaledVp = page.getViewport({ scale: 1 });
                let effectiveScale = scale;
                if (zoomMode === "fit" && viewportWrapRef.current) {
                    const pad = isMobile ? 16 : 56;
                    const availW = Math.max(240, viewportWrapRef.current.clientWidth - pad);
                    effectiveScale = Math.min(2.2, Math.max(0.5, availW / unscaledVp.width));
                }

                const vp = page.getViewport({ scale: effectiveScale });
                setPageSize({ width: vp.width, height: vp.height });

                // Extract text content for both overlay lookup and Text/Reflow mode
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
                const lines = groupPdfTextItemsIntoLines(rawItems, vp.transform);
                setPageLines(lines);

                // Honest monotonic per-page char stats (counted once per page per session)
                if (!countedPagesRef.current.has(pageNumber)) {
                    countedPagesRef.current.add(pageNumber);
                    const pageChars = lines.reduce(
                        (acc, line) => acc + line.text.replace(/\s+/g, "").length,
                        0,
                    );
                    if (pageChars > 0) {
                        onRecordStatsRef.current?.(pageChars, 0);
                    }
                }

                // Render canvas when in Page View
                if (viewMode === "page" && canvasRef.current) {
                    if (renderTaskRef.current) {
                        try {
                            renderTaskRef.current.cancel();
                        } catch {
                            // Ignore cancellation race
                        }
                    }
                    const canvas = canvasRef.current;
                    const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
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
            } catch (err) {
                if (!cancelled) {
                    setError(String(err));
                }
            }
        })();

        return () => {
            cancelled = true;
            if (renderTaskRef.current) {
                try {
                    renderTaskRef.current.cancel();
                } catch {
                    // Ignore
                }
            }
        };
    }, [pdfDoc, numPages, pageNumber, scale, zoomMode, viewMode, isMobile]);

    // Reading time tracker (ticks every 15s while visible)
    useEffect(() => {
        if (!pdfDoc) return;
        const timer = window.setInterval(() => {
            if (document.visibilityState === "visible") {
                onRecordStatsRef.current?.(0, 15);
            }
        }, 15_000);
        return () => window.clearInterval(timer);
    }, [pdfDoc]);

    const goToPage = useCallback((next: number) => {
        if (numPages <= 0) return;
        const clamped = Math.min(Math.max(1, Math.floor(next)), numPages);
        setPageNumber(clamped);
        viewportWrapRef.current?.scrollTo({ top: 0, behavior: "instant" as ScrollBehavior });
    }, [numPages]);

    const handleZoomDelta = useCallback((delta: 1 | -1) => {
        setZoomMode("custom");
        setScale((prev) => {
            const nextStep = delta > 0
                ? ZOOM_STEPS.find((z) => z > prev + 0.02) ?? ZOOM_STEPS[ZOOM_STEPS.length - 1]
                : [...ZOOM_STEPS].reverse().find((z) => z < prev - 0.02) ?? ZOOM_STEPS[0];
            return nextStep;
        });
    }, []);

    // Keyboard navigation
    useEffect(() => {
        if (isMobile) return;
        const onKeyDown = (event: KeyboardEvent) => {
            if (escMenuOpen || event.defaultPrevented) return;
            const target = event.target;
            if (target instanceof Element && target.closest('input, textarea, select, [contenteditable="true"]')) {
                return;
            }
            if (event.key === "ArrowRight" || event.key === "PageDown") {
                event.preventDefault();
                goToPage(pageNumber + 1);
            } else if (event.key === "ArrowLeft" || event.key === "PageUp") {
                event.preventDefault();
                goToPage(pageNumber - 1);
            } else if (event.key === "+" || event.key === "=") {
                event.preventDefault();
                handleZoomDelta(1);
            } else if (event.key === "-") {
                event.preventDefault();
                handleZoomDelta(-1);
            } else if (event.key === "0") {
                event.preventDefault();
                setZoomMode("fit");
            }
        };
        window.addEventListener("keydown", onKeyDown);
        return () => window.removeEventListener("keydown", onKeyDown);
    }, [isMobile, escMenuOpen, pageNumber, goToPage, handleZoomDelta]);

    // Full-document PDF text search
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

    const handleSpanLookup = useCallback((
        event: React.MouseEvent<HTMLSpanElement>,
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
        const ratio = rect.width > 0 ? (event.clientX - rect.left) / rect.width : 0;
        const target = buildPdfLookupTarget(line.text, span, ratio);
        if (target) {
            void onLookupToken(target.token, target.sentence, target.cursor);
        }
    }, [onLookupToken]);

    const progressPct = useMemo(() => {
        if (numPages <= 0) return 0;
        return Math.round((pageNumber / numPages) * 100);
    }, [pageNumber, numPages]);

    const effectiveZoomLabel = zoomMode === "fit"
        ? (isEn ? "Fit" : "Авто")
        : `${Math.round(scale * 100)}%`;

    return (
        <div className={`pdf-reader-shell ${pdfThemeClass}${isMobile ? " is-mobile" : ""}`}>
            {/* Floating glass top toolbar */}
            <div className={`epub-floating-top pdf-floating-top${isMobile ? " is-mobile" : ""}`}>
                <div className="epub-glass-pill epub-glass-pill-main">
                    <button
                        type="button"
                        className="epub-glass-circle"
                        onClick={onBackToLibrary}
                        title={t("epub.library")}
                        aria-label={t("epub.library")}
                    >
                        ←
                    </button>
                    <button
                        type="button"
                        className={`epub-glass-circle${tocOpen ? " is-active" : ""}`}
                        onClick={() => { setTocOpen((v) => !v); setSearchOpen(false); }}
                        title={t("epub.toc")}
                        aria-label={t("epub.toc")}
                    >
                        ☰
                    </button>
                    <span className="epub-toolbar-title">{tab.epub?.title || tab.name}</span>
                    <span className="epub-badge">PDF</span>
                </div>

                <div className="epub-glass-pill epub-glass-pill-tools">
                    <button
                        type="button"
                        className={`epub-glass-circle${searchOpen ? " is-active" : ""}`}
                        onClick={() => { setSearchOpen((v) => !v); setTocOpen(false); }}
                        title={isEn ? "Search PDF" : "Поиск по PDF"}
                        aria-label={isEn ? "Search PDF" : "Поиск по PDF"}
                    >
                        <IconSearch />
                    </button>

                    <button
                        type="button"
                        className={`epub-aa-btn${viewMode === "text" ? " is-active" : ""}`}
                        onClick={() => setViewMode((m) => (m === "page" ? "text" : "page"))}
                        title={isEn ? "Toggle Page / Reflow Text view" : "Переключить Страница / Только текст"}
                    >
                        {viewMode === "page" ? (isEn ? "Text" : "Текст") : (isEn ? "Page" : "Стр.")}
                    </button>

                    {viewMode === "page" && (
                        <>
                            <button
                                type="button"
                                className="epub-glass-circle"
                                onClick={() => handleZoomDelta(-1)}
                                title={isEn ? "Zoom out" : "Уменьшить"}
                            >
                                −
                            </button>
                            <button
                                type="button"
                                className="epub-aa-btn"
                                onClick={() => setZoomMode("fit")}
                                title={isEn ? "Fit to width" : "По ширине"}
                            >
                                {effectiveZoomLabel}
                            </button>
                            <button
                                type="button"
                                className="epub-glass-circle"
                                onClick={() => handleZoomDelta(1)}
                                title={isEn ? "Zoom in" : "Увеличить"}
                            >
                                +
                            </button>
                            <button
                                type="button"
                                className={`epub-glass-circle${nightFilter ? " is-active" : ""}`}
                                onClick={() => setNightFilter((v) => !v)}
                                title={isEn ? "Invert colors for dark reading" : "Ночной режим (инверсия PDF)"}
                            >
                                ◐
                            </button>
                        </>
                    )}
                </div>
            </div>

            {/* Outline / ToC Drawer */}
            {tocOpen && (
                <div className="pdf-drawer-backdrop" onClick={() => setTocOpen(false)}>
                    <aside className="pdf-drawer" onClick={(e) => e.stopPropagation()}>
                        <header className="pdf-drawer-head">
                            <strong>{t("epub.toc")}</strong>
                            <button type="button" className="epub-glass-circle" onClick={() => setTocOpen(false)}>
                                <IconClose />
                            </button>
                        </header>
                        <div className="pdf-drawer-body">
                            {outline.length === 0 ? (
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
                            <button type="button" className="epub-glass-circle" onClick={() => setSearchOpen(false)}>
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
                onTouchStart={(e) => {
                    if (e.touches.length !== 1) return;
                    swipeStartRef.current = {
                        x: e.touches[0].clientX,
                        y: e.touches[0].clientY,
                        at: Date.now(),
                    };
                }}
                onTouchEnd={(e) => {
                    const start = swipeStartRef.current;
                    swipeStartRef.current = null;
                    if (!start || e.changedTouches.length !== 1) return;
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

                {!loading && !error && viewMode === "page" && (
                    <div
                        className={`pdf-page-stage${nightFilter ? " is-night-invert" : ""}`}
                        style={{
                            width: pageSize.width > 0 ? `${pageSize.width}px` : undefined,
                            height: pageSize.height > 0 ? `${pageSize.height}px` : undefined,
                        }}
                    >
                        <canvas ref={canvasRef} className="pdf-page-canvas" />
                        <div className="pdf-text-layer" aria-label="PDF text layer">
                            {pageLines.map((line, lineIdx) =>
                                line.spans.map((span, spanIdx) => (
                                    <span
                                        key={`${lineIdx}-${spanIdx}`}
                                        className="pdf-text-span"
                                        style={{
                                            left: `${span.left}px`,
                                            top: `${span.top}px`,
                                            width: `${span.width}px`,
                                            height: `${span.height}px`,
                                            fontSize: `${Math.max(8, span.height * 0.85)}px`,
                                        }}
                                        onClick={(e) => handleSpanLookup(e, line, spanIdx)}
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
                    </div>
                )}

                {!loading && !error && viewMode === "text" && (
                    <div
                        className="pdf-reflow-surface"
                        style={{
                            fontSize: `${settings.epubFontSize || 20}px`,
                            lineHeight: settings.epubLineHeight || 1.65,
                            fontFamily: settings.epubFontFamily,
                            maxWidth: `${settings.epubMaxWidth || 860}px`,
                        }}
                    >
                        {pageLines.length === 0 ? (
                            <p className="pdf-drawer-empty">
                                {isEn
                                    ? "No embedded text layer found on this page (scanned image PDF)."
                                    : "На этой странице нет текстового слоя (похоже на скан-PDF)."}
                            </p>
                        ) : (
                            pageLines.map((line, idx) => (
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

            {/* Floating bottom navigation capsule */}
            {numPages > 0 && (
                <div className={`epub-floating-bottom pdf-floating-bottom${isMobile ? " is-mobile" : ""}`}>
                    <div className="epub-nav-capsule">
                        <button
                            type="button"
                            className="epub-glass-circle"
                            disabled={pageNumber <= 1}
                            onClick={() => goToPage(pageNumber - 1)}
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
                                    if (Number.isFinite(parsed) && parsed !== pageNumber) {
                                        goToPage(parsed);
                                    } else {
                                        setPageInput(String(pageNumber));
                                    }
                                }}
                                aria-label={isEn ? "Page number" : "Номер страницы"}
                            />
                            <span className="pdf-page-total">/ {numPages} · {progressPct}%</span>
                        </form>
                        <button
                            type="button"
                            className="epub-glass-circle"
                            disabled={pageNumber >= numPages}
                            onClick={() => goToPage(pageNumber + 1)}
                            title={t("epub.nextPage")}
                        >
                            »
                        </button>
                    </div>
                </div>
            )}
        </div>
    );
}
