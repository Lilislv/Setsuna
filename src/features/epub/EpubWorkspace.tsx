import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import type { AppSettings } from "../../components/SettingsModal";
import type { EpubBookmark, Tab } from "../../utils/constants";
import { getTranslator } from "../../utils/i18n";
import "../../components/WorkspaceShell.css";
import { IconBookTab, IconHome, IconImport, IconSettings } from "../../components/Icons";
import "../../components/AppMenu.css";
import EpubLibrary, { type EpubBookMetaPatch } from "./EpubLibrary";
import EpubReader from "./EpubReader";
import EpubStatsModal from "./EpubStatsModal";
import { loadEpubChapter, loadEpubCover, openEpubBook } from "./epubApi";
import { compactCoverDataUrl, getInitialCoverSnapshot, hasCachedCover, setMemoryCover } from "./epubCoverCache";
import {
    computeWeightedBookProgress,
    isPdfBookPath,
    type EpubBookMeta,
    type EpubBookNote,
    type EpubChapterContent,
    type EpubHighlight,
    type EpubOrientationSetting,
    type EpubReadingPoint,
} from "./epubModel";
import { loadEpubGoals, type EpubReadingGoals } from "./epubTracker";
import type { EpubPortableBackup } from "./epubBackup";
import type { EpubSyncStatus } from "./useEpubSync";
import { resolveBookSeries, resolveEpubViewModeAfterChange } from "./epubLibraryModel";
import { MOBILE_BACK_PRIORITY, useMobileBackHandler } from "../../utils/mobileBack";
import MangaReader from "../manga/MangaReader";
import CatalogPickerModal from "../manga/CatalogPickerModal";
import { loadMangaCover, openMangaVolume, type MangaExportResult } from "../manga/mangaApi";
import { isMangaTabData, type MangaMeta } from "../manga/mangaModel";
import "./epub.css";

const PdfReader = lazy(() => import("./PdfReader"));

const MAX_CACHED_CHAPTERS = 12;
const ESC_MENU_CLOSE_MS = 180;
let lastEpubViewMode: "library" | "reader" | null = null;

type LookupMatch = { start: number; length: number };
type LookupTokenHandler = (
    token: string,
    sentence: string,
    cursor: number,
    boundaries?: number[],
    lemma?: string,
) => LookupMatch | null | void | Promise<LookupMatch | null | void>;

interface EpubWorkspaceProps {
    books: Tab[];
    activeBookTab: Tab | null;
    settings: AppSettings;
    isMobile: boolean;
    standaloneMobile?: boolean;
    lookupOpen?: boolean;
    onCloseLookup?: () => void;
    escMenuBlocked?: boolean;
    onHome: () => void;
    onSettings: () => void;
    onOpenFile: () => void;
    onImportFolder?: () => void;
    onImportBackup?: (backup: EpubPortableBackup) => { updatedBooks: number; retainedBooks: number };
    onSelectBook: (tabId: number) => void;
    onRemoveBook: (tabId: number) => void;
    onRemoveBooks?: (tabIds: number[]) => void;
    onPatchBooks?: (tabIds: number[], patch: EpubBookMetaPatch) => void;
    onUpdateBookMeta: (tabId: number, meta: EpubBookMeta) => void;
    onUpdateMangaMeta?: (tabId: number, meta: MangaMeta) => void;
    onMangaScreenshot?: (dataUrl: string | null) => void;
    onProgressChange: (tabId: number, chapterIndex: number, chapterOffset: number, bookProgress: number) => void;
    onChangeBookOrientation: (tabId: number, orientation: EpubOrientationSetting) => void;
    onChangeBookBookmarks?: (tabId: number, bookmarks: EpubBookmark[]) => void;
    onChangeBookHighlights?: (tabId: number, highlights: EpubHighlight[]) => void;
    onChangeBookNotes?: (tabId: number, notes: EpubBookNote[]) => void;
    onChangeReadingPoint?: (tabId: number, point: EpubReadingPoint | null) => void;
    onRecordReadingStats?: (tabId: number, deltaChars: number, deltaSeconds: number) => void;
    onResetStats?: () => void;
    onUpdateSettings?: (patch: Partial<AppSettings>) => void;
    onLookupToken?: LookupTokenHandler;
    resumePromptBookId?: number | null;
    onDismissResumePrompt?: () => void;
    catalogPrompt?: { tabIds: number[]; sourceHint?: string; totalFound?: number } | null;
    onDismissCatalogPrompt?: () => void;
    syncStatus?: EpubSyncStatus;
    lastSyncedAt?: number | null;
    syncError?: string | null;
    downloadingBookId?: number | null;
    onSyncNow?: () => void;
    onConvertMangaToCbz?: (tabId: number) => Promise<MangaExportResult | null>;
    onOpenCloudSettings?: () => void;
}

export default function EpubWorkspace({
    books,
    activeBookTab,
    settings,
    isMobile,
    standaloneMobile = true,
    lookupOpen = false,
    onCloseLookup,
    escMenuBlocked = false,
    onHome,
    onSettings,
    onOpenFile,
    onImportFolder,
    onImportBackup,
    onSelectBook,
    onRemoveBook,
    onRemoveBooks,
    onPatchBooks,
    onUpdateBookMeta,
    onUpdateMangaMeta,
    onMangaScreenshot,
    onProgressChange,
    onChangeBookOrientation,
    onChangeBookBookmarks,
    onChangeBookHighlights,
    onChangeBookNotes,
    onChangeReadingPoint,
    onRecordReadingStats,
    onResetStats,
    onUpdateSettings,
    onLookupToken,
    resumePromptBookId = null,
    onDismissResumePrompt,
    catalogPrompt = null,
    onDismissCatalogPrompt,
    syncStatus = "idle",
    lastSyncedAt = null,
    syncError = null,
    downloadingBookId = null,
    onSyncNow,
    onConvertMangaToCbz,
    onOpenCloudSettings,
}: EpubWorkspaceProps) {
    const language = settings.appLanguage || "ru";
    const isEn = language === "en";
    const t = getTranslator(language);

    const [viewMode, setViewMode] = useState<"library" | "reader">(() => {
        if (resumePromptBookId || catalogPrompt || activeBookTab?.epub?.cloudOnly) return "library";
        if (lastEpubViewMode === "library") return "library";
        if (lastEpubViewMode === "reader" && activeBookTab) return "reader";
        return activeBookTab ? "reader" : "library";
    });

    useEffect(() => {
        if (catalogPrompt) {
            setViewMode("library");
        }
    }, [catalogPrompt]);
    const [bookMeta, setBookMeta] = useState<EpubBookMeta | null>(null);
    const [mangaMeta, setMangaMeta] = useState<MangaMeta | null>(null);
    const [chapter, setChapter] = useState<EpubChapterContent | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [pendingFragment, setPendingFragment] = useState<string | null>(null);
    const [pendingParagraphIndex, setPendingParagraphIndex] = useState<number | null>(null);

    // Full-window Esc menu matching TextHooker's AppMenu behavior and animations
    const [escMenuOpen, setEscMenuOpen] = useState(false);
    const [readerOverlayOpen, setReaderOverlayOpen] = useState(false);
    const [closeOverlaySignal, setCloseOverlaySignal] = useState(0);
    const [mobileImmersive, setMobileImmersive] = useState(false);
    const [statsOpen, setStatsOpen] = useState(false);
    const [readingGoals, setReadingGoals] = useState<EpubReadingGoals>(() => loadEpubGoals());
    const [readerCatalogBookId, setReaderCatalogBookId] = useState<number | null>(null);
    const [escMenuMounted, setEscMenuMounted] = useState(false);
    const [escMenuVisible, setEscMenuVisible] = useState(false);
    const [escMenuEntering, setEscMenuEntering] = useState(false);
    const escMenuPanelRef = useRef<HTMLDivElement>(null);
    const pendingMenuActionRef = useRef<(() => void) | null>(null);

    const [coversByPath, setCoversByPath] = useState<Record<string, string | null>>(() => getInitialCoverSnapshot());

    const metaCacheRef = useRef<Map<string, EpubBookMeta>>(new Map());
    const mangaMetaCacheRef = useRef<Map<string, MangaMeta>>(new Map());
    const chapterCacheRef = useRef<Map<string, EpubChapterContent>>(new Map());
    const loadGenerationRef = useRef(0);

    const bookPath = activeBookTab?.epub?.path || "";
    const activeIsManga = isMangaTabData(activeBookTab?.epub);
    const activeTabId = activeBookTab?.id ?? null;

    useEffect(() => {
        lastEpubViewMode = viewMode;
        if (viewMode !== "reader") {
            setMobileImmersive(false);
        }
    }, [viewMode]);

    const pendingCloudOpenIdRef = useRef<number | null>(null);
    const pendingCloudStartedRef = useRef(false);

    // Switch into reader view automatically when a new book tab becomes active,
    // except when any book was just removed/deleted (stay in or return to the
    // library instead of opening a fallback book).
    const prevActiveTabIdRef = useRef<number | null>(activeTabId);
    const prevBookIdsRef = useRef<Set<number>>(new Set(books.map((b) => b.id)));
    useEffect(() => {
        const nextBookIds = new Set(books.map((b) => b.id));
        const prevId = prevActiveTabIdRef.current;
        const prevBookIds = prevBookIdsRef.current;
        const waitingForSelection = pendingCloudOpenIdRef.current !== null
            && (activeTabId !== pendingCloudOpenIdRef.current || !bookPath || activeBookTab?.epub?.cloudOnly);
        setViewMode((cur) => waitingForSelection ? "library" :
            resolveEpubViewModeAfterChange({
                currentViewMode: cur,
                prevActiveTabId: prevId,
                nextActiveTabId: activeTabId,
                prevBookIds,
                nextBookIds,
                hasCatalogPrompt: Boolean(catalogPrompt),
            }),
        );
        prevActiveTabIdRef.current = activeTabId;
        prevBookIdsRef.current = nextBookIds;
    }, [activeTabId, bookPath, activeBookTab?.epub?.cloudOnly, books, catalogPrompt]);

    // Esc menu enter/exit animation lifecycle (identical to AppMenu.tsx)
    useEffect(() => {
        if (escMenuOpen) {
            setEscMenuMounted(true);
            setEscMenuEntering(true);
            const frame = requestAnimationFrame(() => setEscMenuVisible(true));
            const settle = window.setTimeout(() => setEscMenuEntering(false), 900);
            return () => {
                cancelAnimationFrame(frame);
                window.clearTimeout(settle);
            };
        }
        setEscMenuVisible(false);
        const timer = window.setTimeout(() => {
            setEscMenuMounted(false);
            const action = pendingMenuActionRef.current;
            pendingMenuActionRef.current = null;
            action?.();
        }, ESC_MENU_CLOSE_MS);
        return () => window.clearTimeout(timer);
    }, [escMenuOpen]);

    useEffect(() => {
        if (!escMenuVisible) return;
        const panel = escMenuPanelRef.current;
        (panel?.querySelector<HTMLElement>(".app-menu-tab.is-active") || panel)?.focus({ preventScroll: false });
        panel?.querySelector(".app-menu-tab.is-active")?.scrollIntoView({ block: "nearest" });
    }, [escMenuVisible]);

    // Esc key handler matching ReaderChrome.tsx priority
    useEffect(() => {
        if (isMobile) return;
        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key !== "Escape" || event.repeat || event.defaultPrevented) return;
            const target = event.target;
            const inField = target instanceof Element && target.closest('input, textarea, select, [contenteditable="true"]');
            if (escMenuOpen) {
                if (inField) return;
                event.preventDefault();
                setEscMenuOpen(false);
                return;
            }
            if (inField) return;
            if (lookupOpen) {
                event.preventDefault();
                onCloseLookup?.();
                return;
            }
            if (escMenuBlocked || document.querySelector(".modal-overlay, .settings-window")) return;
            event.preventDefault();
            setEscMenuOpen(true);
        };
        window.addEventListener("keydown", handleKeyDown);
        return () => window.removeEventListener("keydown", handleKeyDown);
    }, [isMobile, escMenuOpen, lookupOpen, onCloseLookup, escMenuBlocked]);

    const runEscMenuAction = useCallback((action: () => void) => {
        pendingMenuActionRef.current = action;
        setEscMenuOpen(false);
    }, []);

    // Android hardware/gesture Back button: peel one UI layer at a time.
    useMobileBackHandler(isMobile && statsOpen, MOBILE_BACK_PRIORITY.MODAL, () => {
        setStatsOpen(false);
    });
    useMobileBackHandler(
        isMobile && readerOverlayOpen,
        MOBILE_BACK_PRIORITY.READER_OVERLAY - 1,
        () => {
            setCloseOverlaySignal((n) => n + 1);
        },
    );
    useMobileBackHandler(
        isMobile && viewMode === "reader",
        MOBILE_BACK_PRIORITY.SUBVIEW,
        () => {
            setViewMode("library");
        },
    );
    useMobileBackHandler(
        isMobile && standaloneMobile,
        MOBILE_BACK_PRIORITY.WORKSPACE,
        () => {
            onHome();
        },
    );

    // Sync any newly cached covers from importEpubPath into state immediately
    useEffect(() => {
        const snap = getInitialCoverSnapshot();
        setCoversByPath((prev) => {
            let changed = false;
            const next = { ...prev };
            for (const tab of books) {
                const p = tab.epub?.path;
                if (p && p in snap && !(p in next)) {
                    next[p] = snap[p];
                    changed = true;
                }
            }
            return changed ? next : prev;
        });
    }, [books]);

    // Phase 1: Instant parallel cover loading (never blocked by full-book metadata scans)
    useEffect(() => {
        if (viewMode !== "library") return;
        const missingCovers: Array<{ path: string; isManga: boolean }> = [];
        const seen = new Set<string>();
        for (const tab of books) {
            if (tab.archived || !tab.epub?.path) continue;
            const path = tab.epub.path;
            if (seen.has(path) || hasCachedCover(path)) continue;
            seen.add(path);
            missingCovers.push({ path, isManga: isMangaTabData(tab.epub) });
        }

        if (missingCovers.length === 0) return;
        let cancelled = false;

        void (async () => {
            const CONCURRENCY = 6;
            let cursor = 0;
            const worker = async () => {
                while (!cancelled) {
                    const idx = cursor++;
                    if (idx >= missingCovers.length) return;
                    const item = missingCovers[idx];
                    const cover = item.isManga
                        ? await loadMangaCover(item.path).catch(() => null)
                        : await loadEpubCover(item.path).catch(() => null);
                    setMemoryCover(item.path, cover);
                    if (!cancelled) {
                        setCoversByPath((prev) => (prev[item.path] === cover ? prev : { ...prev, [item.path]: cover }));
                    }
                }
            };
            await Promise.all(
                Array.from({ length: Math.min(CONCURRENCY, missingCovers.length) }, () => worker()),
            );
        })();

        return () => {
            cancelled = true;
        };
    }, [viewMode, books]);

    // Phase 2: Background metadata backfill (author/series/totalChars) without blocking covers
    useEffect(() => {
        if (viewMode !== "library") return;
        const targets = books
            .filter((tab) => !tab.archived && tab.epub?.path && !isMangaTabData(tab.epub))
            .filter((tab) => (tab.epub!.author === undefined || tab.epub!.totalChars === undefined) && !metaCacheRef.current.has(tab.epub!.path!));

        if (targets.length === 0) return;
        let cancelled = false;

        void (async () => {
            for (const tab of targets) {
                if (cancelled) return;
                const path = tab.epub!.path!;
                if (metaCacheRef.current.has(path)) continue;
                const meta = await openEpubBook(path).catch(() => null);
                if (meta) {
                    metaCacheRef.current.set(path, meta);
                    if (meta.cover && !hasCachedCover(path)) {
                        setMemoryCover(path, meta.cover);
                        if (!cancelled) {
                            setCoversByPath((prev) => ({ ...prev, [path]: meta.cover }));
                        }
                    }
                    if (!cancelled) {
                        onUpdateBookMeta(tab.id, meta);
                    }
                }
            }
        })();

        return () => {
            cancelled = true;
        };
    }, [viewMode, books, onUpdateBookMeta]);

    const rememberChapter = useCallback((key: string, content: EpubChapterContent) => {
        const cache = chapterCacheRef.current;
        if (cache.has(key)) cache.delete(key);
        cache.set(key, content);
        while (cache.size > MAX_CACHED_CHAPTERS) {
            const oldestKey = cache.keys().next().value;
            if (!oldestKey) break;
            cache.delete(oldestKey);
        }
    }, []);

    const fetchChapter = useCallback(async (path: string, index: number, generation: number) => {
        const cacheKey = `${path}::${index}`;
        const cached = chapterCacheRef.current.get(cacheKey);
        if (cached) {
            setChapter(cached);
            setLoading(false);
            setError(null);
            return;
        }
        setLoading(true);
        setError(null);
        try {
            const loaded = await loadEpubChapter(path, index);
            if (loadGenerationRef.current !== generation) return;
            rememberChapter(cacheKey, loaded);
            setChapter(loaded);
        } catch (err) {
            if (loadGenerationRef.current !== generation) return;
            setError(String(err));
        } finally {
            if (loadGenerationRef.current === generation) {
                setLoading(false);
            }
        }
    }, [rememberChapter]);

    // Load book or manga metadata whenever active item changes
    useEffect(() => {
        if (viewMode !== "reader" || !activeBookTab || !bookPath || isPdfBookPath(bookPath)) {
            setBookMeta(null);
            setMangaMeta(null);
            setChapter(null);
            setError(null);
            setLoading(false);
            return;
        }

        const generation = ++loadGenerationRef.current;

        if (activeIsManga) {
            setBookMeta(null);
            setChapter(null);
            const loadManga = async () => {
                setLoading(true);
                setError(null);
                try {
                    let meta = mangaMetaCacheRef.current.get(bookPath);
                    if (!meta) {
                        meta = await openMangaVolume(bookPath);
                        if (loadGenerationRef.current !== generation) return;
                        mangaMetaCacheRef.current.set(bookPath, meta);
                        if (meta.cover && !hasCachedCover(bookPath)) {
                            setMemoryCover(bookPath, meta.cover);
                            setCoversByPath((prev) => ({ ...prev, [bookPath]: meta!.cover ?? null }));
                        }
                        onUpdateMangaMeta?.(activeBookTab.id, meta);
                    }
                    setMangaMeta(meta);
                } catch (err) {
                    if (loadGenerationRef.current !== generation) return;
                    setError(String(err));
                } finally {
                    if (loadGenerationRef.current === generation) {
                        setLoading(false);
                    }
                }
            };
            void loadManga();
            return;
        }

        setMangaMeta(null);
        const savedChapterIndex = Math.max(0, activeBookTab.epub?.chapterIndex ?? 0);

        const loadBook = async () => {
            setLoading(true);
            setError(null);
            try {
                let meta = metaCacheRef.current.get(bookPath);
                if (!meta) {
                    meta = await openEpubBook(bookPath);
                    if (loadGenerationRef.current !== generation) return;
                    metaCacheRef.current.set(bookPath, meta);
                    if (meta.cover !== undefined) {
                        setMemoryCover(bookPath, meta.cover ?? null);
                        setCoversByPath((prev) => ({ ...prev, [bookPath]: meta!.cover ?? null }));
                    }
                    onUpdateBookMeta(activeBookTab.id, meta);
                }
                setBookMeta(meta);
                const clampedIndex = Math.min(Math.max(0, meta.chapters.length - 1), savedChapterIndex);
                await fetchChapter(bookPath, clampedIndex, generation);
            } catch (err) {
                if (loadGenerationRef.current !== generation) return;
                setError(String(err));
                setLoading(false);
            }
        };

        void loadBook();
    }, [viewMode, activeBookTab?.id, activeIsManga, bookPath, fetchChapter, onUpdateBookMeta, onUpdateMangaMeta]);

    const handleSelectChapter = useCallback((nextIndex: number, fragment?: string, paragraphIndex?: number) => {
        if (!activeBookTab || !bookPath || !bookMeta) return;
        const clamped = Math.min(Math.max(0, bookMeta.chapters.length - 1), Math.max(0, nextIndex));
        const generation = ++loadGenerationRef.current;
        setPendingFragment(fragment || null);
        setPendingParagraphIndex(typeof paragraphIndex === "number" ? paragraphIndex : null);
        const bookProgress = computeWeightedBookProgress(clamped, bookMeta.chapters, 0);
        onProgressChange(activeBookTab.id, clamped, 0, bookProgress);
        void fetchChapter(bookPath, clamped, generation);
    }, [activeBookTab, bookPath, bookMeta, fetchChapter, onProgressChange]);

    const handleSelectBook = useCallback((tabId: number) => {
        const target = books.find((b) => b.id === tabId);
        if (!target?.epub || target.archived) return;
        if (target.epub.cloudOnly) {
            if (!target.epub.driveFileId) return;
            setViewMode("library");
            pendingCloudOpenIdRef.current = tabId;
            pendingCloudStartedRef.current = downloadingBookId === tabId;
            onSelectBook(tabId);
            return;
        }
        if (!target.epub.path) return;
        pendingCloudOpenIdRef.current = null;
        pendingCloudStartedRef.current = false;
        onSelectBook(tabId);
        setViewMode("reader");
    }, [books, downloadingBookId, onSelectBook]);

    useEffect(() => {
        const pendingId = pendingCloudOpenIdRef.current;
        if (pendingId === null) return;
        if (downloadingBookId === pendingId) {
            pendingCloudStartedRef.current = true;
            return;
        }
        const target = books.find((b) => b.id === pendingId);
        if (!target) {
            pendingCloudOpenIdRef.current = null;
            pendingCloudStartedRef.current = false;
            return;
        }
        if (!target.epub?.cloudOnly && target.epub?.path && activeTabId === pendingId) {
            pendingCloudOpenIdRef.current = null;
            pendingCloudStartedRef.current = false;
            setViewMode("reader");
        } else if (target.epub?.cloudOnly && pendingCloudStartedRef.current && downloadingBookId === null) {
            // Download finished with an error — stay in library rather than opening an old book
            pendingCloudOpenIdRef.current = null;
            pendingCloudStartedRef.current = false;
        }
    }, [activeTabId, books, downloadingBookId]);

    const handleWorkspaceConvertToCbz = useCallback(async (tabId: number): Promise<MangaExportResult | null> => {
        if (!onConvertMangaToCbz) return null;
        const target = books.find((b) => b.id === tabId);
        if (target?.epub?.path) {
            mangaMetaCacheRef.current.delete(target.epub.path);
        }
        const res = await onConvertMangaToCbz(tabId);
        if (res?.outputPath) {
            mangaMetaCacheRef.current.delete(res.outputPath);
        }
        return res;
    }, [onConvertMangaToCbz, books]);

    const handleWorkspaceUpdateMangaMeta = useCallback((tabId: number, meta: MangaMeta) => {
        const target = books.find((b) => b.id === tabId);
        if (target?.epub?.path) {
            mangaMetaCacheRef.current.set(target.epub.path, meta);
        }
        onUpdateMangaMeta?.(tabId, meta);
    }, [books, onUpdateMangaMeta]);

    const visibleBooks = books.filter((tab) => !tab.archived);
    const activeBookTitle = viewMode === "reader" && activeBookTab
        ? (activeBookTab.epub?.title || bookMeta?.title || activeBookTab.name)
        : t("epub.library");
    const activeBookSubtitle = viewMode === "reader" && activeBookTab
        ? (() => {
            const curSpineIdx = chapter?.index ?? activeBookTab.epub?.chapterIndex ?? 0;
            const toc = bookMeta?.toc;
            let tocLabel: string | undefined;
            if (toc && toc.length > 0) {
                let best = 0;
                for (let i = 0; i < toc.length; i++) {
                    if (toc[i].chapterIndex <= curSpineIdx) best = i;
                }
                tocLabel = toc[best]?.title || t("epub.chapterOf", { current: best + 1, total: toc.length });
            }
            return [
                activeBookTab.epub?.author || bookMeta?.author,
                tocLabel || chapter?.title || t("epub.chapterOf", {
                    current: curSpineIdx + 1,
                    total: activeBookTab.epub?.tocCount || bookMeta?.chapters.length || activeBookTab.epub?.chapterCount || 1,
                }),
                `${Math.round(Math.min(1, Math.max(0, activeBookTab.epub?.progress || 0)) * 100)}%`,
            ].filter(Boolean).join(" · ");
        })()
        : t("epub.booksCount", { count: visibleBooks.length });

    const escMenuElement = !isMobile && escMenuMounted ? (
        <div
            className={`app-menu-backdrop${escMenuVisible ? " is-open" : ""}${escMenuVisible && escMenuEntering ? " is-entering" : ""}`}
            onMouseDown={(event) => {
                if (event.target === event.currentTarget) setEscMenuOpen(false);
            }}
            role="presentation"
        >
            <div
                ref={escMenuPanelRef}
                tabIndex={-1}
                className="app-menu"
                role="dialog"
                aria-modal="true"
                aria-labelledby="epub-esc-menu-title"
                onClick={(event) => event.stopPropagation()}
            >
                <header className="app-menu-heading">
                    <div className="app-menu-heading-text">
                        <p className="app-menu-brand">SETSUNA</p>
                        <h1 id="epub-esc-menu-title">{activeBookTitle}</h1>
                        {activeBookSubtitle && <p className="app-menu-subtitle">{activeBookSubtitle}</p>}
                    </div>
                    <button
                        type="button"
                        className="app-menu-close"
                        onClick={() => setEscMenuOpen(false)}
                        aria-label={isEn ? "Close menu" : "Закрыть меню"}
                    >
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
                            <path d="M6 6l12 12M18 6 6 18" />
                        </svg>
                    </button>
                </header>

                <div className="app-menu-body">
                    <section className="app-menu-column app-menu-tabs-column" aria-label={t("epub.library")}>
                        <div className="app-menu-section-head">
                            <span className="app-menu-section-label">
                                {t("epub.library")} <span className="app-menu-count">{visibleBooks.length}</span>
                            </span>
                            <div className="app-menu-section-actions">
                                <button
                                    type="button"
                                    className="app-menu-icon-button"
                                    onClick={() => runEscMenuAction(onOpenFile)}
                                    title={t("epub.openFile")}
                                    aria-label={t("epub.openFile")}
                                >
                                    +
                                </button>
                            </div>
                        </div>

                        <div className="app-menu-tabs" role="listbox" aria-label={t("epub.library")}>
                            {visibleBooks.map((book, index) => {
                                const isActive = viewMode === "reader" && book.id === activeTabId;
                                const progress = Math.round(Math.min(1, Math.max(0, book.epub?.progress || 0)) * 100);
                                const lang = book.epub?.language === "ja" ? "JA" : "EN";
                                return (
                                    <div
                                        key={book.id}
                                        role="option"
                                        aria-selected={isActive}
                                        tabIndex={0}
                                        style={{ ["--i" as string]: index }}
                                        className={`app-menu-tab${isActive ? " is-active" : ""}`}
                                        onClick={() => runEscMenuAction(() => handleSelectBook(book.id))}
                                        onKeyDown={(event) => {
                                            if (event.key === "Enter" || event.key === " ") {
                                                event.preventDefault();
                                                runEscMenuAction(() => handleSelectBook(book.id));
                                            }
                                        }}
                                    >
                                        <span className="epub-badge" style={{ height: 20, padding: "0 7px", fontSize: 10 }}>{lang}</span>
                                        <span className="app-menu-tab-name">{book.epub?.title || book.name}</span>
                                        <span className="app-menu-tab-meta">{progress}%</span>
                                    </div>
                                );
                            })}
                        </div>
                    </section>

                    <section className="app-menu-column">
                        <div className="app-menu-section-head">
                            <span className="app-menu-section-label">{isEn ? "Actions" : "Действия"}</span>
                        </div>
                        <div className="app-menu-grid">
                            <button
                                type="button"
                                className="app-menu-tile"
                                style={{ ["--i" as string]: 0 }}
                                onClick={() => runEscMenuAction(() => setViewMode("library"))}
                            >
                                <span className="app-menu-tile-icon"><IconBookTab /></span>
                                <span className="app-menu-tile-text">
                                    <strong>{t("epub.library")}</strong>
                                    <small>{t("epub.booksCount", { count: visibleBooks.length })}</small>
                                </span>
                            </button>

                            <button
                                type="button"
                                className="app-menu-tile"
                                style={{ ["--i" as string]: 1 }}
                                onClick={() => runEscMenuAction(onOpenFile)}
                            >
                                <span className="app-menu-tile-icon"><IconImport /></span>
                                <span className="app-menu-tile-text">
                                    <strong>{t("epub.openFile")}</strong>
                                    <small>.epub · .fb2 · .pdf · .docx · .mobi · .txt · .md · .cbz · .mokuro</small>
                                </span>
                            </button>

                            <button
                                type="button"
                                className="app-menu-tile"
                                style={{ ["--i" as string]: 2 }}
                                onClick={() => runEscMenuAction(onSettings)}
                            >
                                <span className="app-menu-tile-icon"><IconSettings /></span>
                                <span className="app-menu-tile-text">
                                    <strong>{t("workspace.settings")}</strong>
                                    <small>{t("epub.title")}</small>
                                </span>
                            </button>
                        </div>
                    </section>
                </div>

                <footer className="app-menu-footer">
                    <div className="app-menu-footer-actions">
                        <button type="button" className="is-home" onClick={() => runEscMenuAction(onHome)}>
                            <IconHome /> {isEn ? "Home screen" : "Главный экран"}
                        </button>
                    </div>
                    <p className="app-menu-hint">
                        <kbd>Esc</kbd> {isEn ? "back to reading" : "вернуться к чтению"}
                    </p>
                </footer>
            </div>
        </div>
    ) : null;

    const resumeBook = resumePromptBookId
        ? books.find((b) => b.id === resumePromptBookId && !b.archived) || null
        : null;

    const resumeCover = (resumeBook?.epub?.path && coversByPath[resumeBook.epub.path]) || resumeBook?.epub?.coverThumb;

    useMobileBackHandler(isMobile && Boolean(resumeBook), MOBILE_BACK_PRIORITY.MODAL, () => {
        onDismissResumePrompt?.();
    });

    useEffect(() => {
        if (!resumeBook) return;
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                onDismissResumePrompt?.();
            } else if (event.key === "Enter") {
                event.preventDefault();
                event.stopPropagation();
                onDismissResumePrompt?.();
                handleSelectBook(resumeBook.id);
            }
        };
        window.addEventListener("keydown", onKeyDown, true);
        return () => window.removeEventListener("keydown", onKeyDown, true);
    }, [resumeBook, onDismissResumePrompt, handleSelectBook]);

    const content = (
        <div className={`epub-workspace${isMobile ? " is-mobile" : ""}`}>
            {viewMode === "reader" && activeBookTab && isPdfBookPath(activeBookTab.epub?.path) ? (
                <Suspense
                    fallback={
                        <div className="pdf-reader-shell">
                            <div className="pdf-status-card">{isEn ? "Loading PDF reader…" : "Загрузка PDF-ридера…"}</div>
                        </div>
                    }
                >
                    <PdfReader
                        tab={activeBookTab}
                        settings={settings}
                        isMobile={isMobile}
                        lookupOpen={lookupOpen}
                        escMenuOpen={escMenuOpen}
                        onBackToLibrary={() => setViewMode("library")}
                        onUpdateBookMeta={onUpdateBookMeta}
                        onProgressChange={(pageIdx, offset, progress) =>
                            onProgressChange(activeBookTab.id, pageIdx, offset, progress)
                        }
                        onRecordReadingStats={(deltaChars, deltaSeconds) =>
                            onRecordReadingStats?.(activeBookTab.id, deltaChars, deltaSeconds)
                        }
                        onLookupToken={onLookupToken}
                        onOverlayStateChange={setReaderOverlayOpen}
                        closeOverlaySignal={closeOverlaySignal}
                    />
                </Suspense>
            ) : viewMode === "reader" && activeBookTab ? (
                activeIsManga ? (
                    mangaMeta ? (
                        <MangaReader
                            tab={activeBookTab}
                            tabId={activeBookTab.id}
                            mangaPath={bookPath}
                            meta={mangaMeta}
                            initialPage={Math.max(0, activeBookTab.epub?.chapterIndex ?? 0)}
                            settings={settings}
                            language={language}
                            isMobile={isMobile}
                            lookupOpen={lookupOpen}
                            escMenuOpen={escMenuOpen}
                            goals={readingGoals}
                            onBackToLibrary={() => setViewMode("library")}
                            onMetaUpdated={(updated) => {
                                mangaMetaCacheRef.current.set(bookPath, updated);
                                setMangaMeta(updated);
                                onUpdateMangaMeta?.(activeBookTab.id, updated);
                            }}
                            onProgressChange={(pageIdx, progress) =>
                                onProgressChange(activeBookTab.id, pageIdx, 0, progress)
                            }
                            onChangeBookBookmarks={onChangeBookBookmarks
                                ? (bookmarks) => onChangeBookBookmarks(activeBookTab.id, bookmarks)
                                : undefined}
                            onChangeBookNotes={onChangeBookNotes
                                ? (notes) => onChangeBookNotes(activeBookTab.id, notes)
                                : undefined}
                            onRecordReadingStats={(deltaChars, deltaSeconds) =>
                                onRecordReadingStats?.(activeBookTab.id, deltaChars, deltaSeconds)
                            }
                            onOpenStats={() => setStatsOpen(true)}
                            onLookupToken={onLookupToken}
                            onAnkiScreenshot={onMangaScreenshot}
                            onCloseLookup={onCloseLookup}
                            onMobileImmersiveChange={setMobileImmersive}
                            onOverlayStateChange={setReaderOverlayOpen}
                            closeOverlaySignal={closeOverlaySignal}
                            onOpenCatalogPicker={() => setReaderCatalogBookId(activeBookTab.id)}
                            onConvertMangaToCbz={onConvertMangaToCbz ? () => handleWorkspaceConvertToCbz(activeBookTab.id) : undefined}
                        />
                    ) : (
                        <div className="mode-empty-state">
                            <strong>{error ? (isEn ? "Failed to open manga" : "Не удалось открыть мангу") : (isEn ? "Loading manga…" : "Загрузка манги…")}</strong>
                            {error && <span>{error}</span>}
                            <button type="button" className="epub-glass-btn" onClick={() => setViewMode("library")} style={{ marginTop: 8 }}>
                                {t("epub.library")}
                            </button>
                        </div>
                    )
                ) : (
                <EpubReader
                    tab={activeBookTab}
                    bookMeta={bookMeta}
                    chapter={chapter}
                    loading={loading}
                    error={error}
                    settings={settings}
                    isMobile={isMobile}
                    lookupOpen={lookupOpen}
                    escMenuOpen={escMenuOpen}
                    pendingFragment={pendingFragment}
                    pendingParagraphIndex={pendingParagraphIndex}
                    onFragmentHandled={() => {
                        setPendingFragment(null);
                        setPendingParagraphIndex(null);
                    }}
                    onSelectChapter={handleSelectChapter}
                    onProgressChange={(chapterIdx, offset, progress) =>
                        onProgressChange(activeBookTab.id, chapterIdx, offset, progress)
                    }
                    onChangeBookOrientation={(orientation) =>
                        onChangeBookOrientation(activeBookTab.id, orientation)
                    }
                    onChangeBookBookmarks={(bookmarks) =>
                        onChangeBookBookmarks?.(activeBookTab.id, bookmarks)
                    }
                    onChangeBookHighlights={(highlights) =>
                        onChangeBookHighlights?.(activeBookTab.id, highlights)
                    }
                    onChangeBookNotes={(notes) =>
                        onChangeBookNotes?.(activeBookTab.id, notes)
                    }
                    onChangeReadingPoint={(point) =>
                        onChangeReadingPoint?.(activeBookTab.id, point)
                    }
                    onRecordReadingStats={(deltaChars, deltaSeconds) =>
                        onRecordReadingStats?.(activeBookTab.id, deltaChars, deltaSeconds)
                    }
                    onOpenStats={() => setStatsOpen(true)}
                    coverDataUrl={activeBookTab.epub?.path ? (coversByPath[activeBookTab.epub.path] ?? bookMeta?.cover ?? null) : (bookMeta?.cover ?? null)}
                    goals={readingGoals}
                    onUpdateSettings={onUpdateSettings}
                    onLookupToken={onLookupToken}
                    onBackToLibrary={() => setViewMode("library")}
                    onOpenFile={onOpenFile}
                    onOverlayStateChange={setReaderOverlayOpen}
                    closeOverlaySignal={closeOverlaySignal}
                    immersive={isMobile && mobileImmersive}
                    onToggleImmersive={() => setMobileImmersive((prev) => !prev)}
                />
                )
            ) : (
                <EpubLibrary
                    books={books}
                    coversByPath={coversByPath}
                    language={language}
                    isMobile={isMobile}
                    onOpenFile={onOpenFile}
                    onImportFolder={onImportFolder}
                    onImportBackup={onImportBackup}
                    onSelectBook={handleSelectBook}
                    onRemoveBook={onRemoveBook}
                    onRemoveBooks={onRemoveBooks}
                    onPatchBooks={onPatchBooks}
                    onCoverUpdated={(path, cover) => {
                        setMemoryCover(path, cover);
                        setCoversByPath((prev) => ({ ...prev, [path]: cover }));
                        const matched = books.find((b) => b.epub?.path === path);
                        if (matched && cover) {
                            void compactCoverDataUrl(cover).then((thumb) => {
                                if (thumb) onPatchBooks?.([matched.id], { coverThumb: thumb });
                            });
                        }
                    }}
                    onOpenStats={() => setStatsOpen(true)}
                    syncStatus={syncStatus}
                    lastSyncedAt={lastSyncedAt}
                    syncError={syncError}
                    downloadingBookId={downloadingBookId}
                    onSyncNow={onSyncNow}
                    onUpdateMangaMeta={onUpdateMangaMeta ? handleWorkspaceUpdateMangaMeta : undefined}
                    onConvertMangaToCbz={onConvertMangaToCbz ? handleWorkspaceConvertToCbz : undefined}
                    onOpenCloudSettings={onOpenCloudSettings}
                />
            )}
            {escMenuElement}
            {resumeBook && (
                <div className="epub-modal-backdrop" onClick={() => onDismissResumePrompt?.()}>
                    <div className="epub-modal-card epub-resume-modal" onClick={(e) => e.stopPropagation()}>
                        <div className="epub-resume-body">
                            <div className="epub-resume-cover-wrap">
                                {resumeCover ? (
                                    <img
                                        src={resumeCover}
                                        alt={resumeBook.epub?.title || resumeBook.name}
                                        className="epub-resume-cover"
                                    />
                                ) : (
                                    <div className="epub-resume-cover-fallback">
                                        <IconBookTab />
                                    </div>
                                )}
                            </div>
                            <div className="epub-resume-info">
                                <span className="epub-resume-kicker">{t("epub.resumePromptTitle")}</span>
                                <h3 className="epub-resume-title">{resumeBook.epub?.title || resumeBook.name}</h3>
                                {resumeBook.epub?.author && (
                                    <span className="epub-resume-author">{resumeBook.epub.author}</span>
                                )}
                                <div className="epub-resume-progress">
                                    <div className="epub-progress-track">
                                        <div
                                            className="epub-progress-fill"
                                            style={{ width: `${Math.round(Math.min(1, Math.max(0, resumeBook.epub?.progress || 0)) * 100)}%` }}
                                        />
                                    </div>
                                    <span className="epub-resume-pct">
                                        {Math.round(Math.min(1, Math.max(0, resumeBook.epub?.progress || 0)) * 100)}%
                                    </span>
                                </div>
                            </div>
                        </div>
                        <div className="epub-resume-actions">
                            <button
                                type="button"
                                className="epub-glass-btn epub-lib-action-btn"
                                onClick={() => onDismissResumePrompt?.()}
                            >
                                {t("epub.resumeLibrary")}
                            </button>
                            <button
                                type="button"
                                className="btn-primary epub-resume-continue-btn"
                                onClick={() => {
                                    onDismissResumePrompt?.();
                                    handleSelectBook(resumeBook.id);
                                }}
                            >
                                {t("epub.resumeContinue")} «{resumeBook.epub?.title || resumeBook.name}»
                            </button>
                        </div>
                    </div>
                </div>
            )}
            <EpubStatsModal
                open={statsOpen}
                books={books}
                language={language}
                isMobile={isMobile}
                onClose={() => setStatsOpen(false)}
                onGoalsChange={setReadingGoals}
                onResetStats={onResetStats}
            />
            {(() => {
                const readerBook = readerCatalogBookId !== null
                    ? books.find((b) => b.id === readerCatalogBookId) || null
                    : null;
                const promptBooks = !readerBook && catalogPrompt?.tabIds.length
                    ? catalogPrompt.tabIds
                        .map((id) => books.find((b) => b.id === id))
                        .filter((b): b is Tab => Boolean(b))
                    : [];
                const targetBook = readerBook || promptBooks[0] || null;
                if (!targetBook) return null;

                const promptIdSet = new Set(promptBooks.map((b) => b.id));
                const targetSeries = targetBook.epub?.series || resolveBookSeries(targetBook, books);
                const siblingBooks = books.filter((other) => {
                    if (other.id === targetBook.id || other.archived) return false;
                    if (promptIdSet.has(other.id)) return true;
                    const otherSeries = other.epub?.series || resolveBookSeries(other, books);
                    return Boolean(targetSeries && otherSeries && targetSeries.trim().toLowerCase() === otherSeries.trim().toLowerCase());
                });

                const isImportPrompt = !readerBook && promptBooks.length > 0;
                const importBanner = isImportPrompt
                    ? (promptBooks.length > 1
                        ? (isEn
                            ? `Imported ${promptBooks.length} volumes. Pick a title and cover for the series, or skip.`
                            : `Импортировано томов: ${promptBooks.length}. Подбери название и обложку для серии или пропусти этот шаг.`)
                        : (isEn
                            ? "Imported! Pick a cleaner title and cover from AniList / MAL, or skip."
                            : "Добавлено! Можно сразу подобрать название и обложку с AniList / MAL или пропустить."))
                    : undefined;

                return (
                    <CatalogPickerModal
                        key={targetBook.id}
                        book={targetBook}
                        siblingBooks={siblingBooks}
                        language={language}
                        initialQueryHint={isImportPrompt ? catalogPrompt?.sourceHint : undefined}
                        importBanner={importBanner}
                        skipLabel={isImportPrompt ? (isEn ? "Skip" : "Пропустить") : undefined}
                        onClose={() => {
                            if (readerBook) setReaderCatalogBookId(null);
                            else onDismissCatalogPrompt?.();
                        }}
                        onApply={(updates, fallbackCover) => {
                            const updatedCovers: Record<string, string> = {};
                            for (const u of updates) {
                                onPatchBooks?.([u.tabId], u.patch);
                                const cov = u.coverDataUrl ?? fallbackCover;
                                const updatedPath = books.find((b) => b.id === u.tabId)?.epub?.path;
                                if (cov && updatedPath) {
                                    setMemoryCover(updatedPath, cov);
                                    updatedCovers[updatedPath] = cov;
                                }
                                if (cov) {
                                    void compactCoverDataUrl(cov).then((thumb) => {
                                        if (thumb) onPatchBooks?.([u.tabId], { coverThumb: thumb });
                                    });
                                }
                            }
                            if (updates.length === 0 && fallbackCover && targetBook.epub?.path) {
                                setMemoryCover(targetBook.epub.path, fallbackCover);
                                updatedCovers[targetBook.epub.path] = fallbackCover;
                                void compactCoverDataUrl(fallbackCover).then((thumb) => {
                                    if (thumb) onPatchBooks?.([targetBook.id], { coverThumb: thumb });
                                });
                            }
                            if (Object.keys(updatedCovers).length > 0) {
                                setCoversByPath((prev) => ({ ...prev, ...updatedCovers }));
                            }
                        }}
                    />
                );
            })()}
        </div>
    );

    if (isMobile) {
        if (!standaloneMobile) {
            return content;
        }
        const islandTitle = viewMode === "reader" && activeBookTab
            ? (activeBookTab.epub?.title || activeBookTab.name)
            : t("epub.title");
        const islandMeta = viewMode === "reader" && activeBookTab
            ? `${Math.round(Math.min(1, Math.max(0, activeBookTab.epub?.progress || 0)) * 100)}%`
            : String(visibleBooks.length);

        const isImmersiveShell = viewMode === "reader" && mobileImmersive;
        const isReaderView = viewMode === "reader" && Boolean(activeBookTab);

        return (
            <div className={`m-shell epub-mobile-shell${isReaderView ? " is-reading-mode" : ""}${isImmersiveShell ? " is-immersive" : ""}`}>
                <header className="m-island-row">
                    <button
                        type="button"
                        className="m-source"
                        onClick={onHome}
                        aria-label="Setsuna Hub"
                        title="Setsuna Hub"
                    >
                        <IconHome />
                    </button>
                    <button
                        type="button"
                        className="m-island"
                        onClick={() => setViewMode((prev) => (prev === "reader" ? "library" : activeBookTab ? "reader" : "library"))}
                    >
                        <span className="m-dot" style={{ ["--dot" as string]: "#67c587" }} aria-hidden="true" />
                        <span className="m-island-name">{islandTitle}</span>
                        <span className="m-island-meta">{islandMeta}</span>
                    </button>
                </header>

                <main className="m-main">{content}</main>

                <nav className="m-dock" aria-label={t("epub.title")}>
                    <button
                        type="button"
                        className={`m-dock-btn${viewMode === "library" ? " is-active" : ""}`}
                        onClick={() => setViewMode("library")}
                        aria-label={t("epub.library")}
                    >
                        <IconBookTab />
                    </button>
                    <button
                        type="button"
                        className="m-dock-btn"
                        onClick={onOpenFile}
                        aria-label={t("epub.openFile")}
                    >
                        <IconImport />
                    </button>
                    <button
                        type="button"
                        className="m-dock-btn"
                        onClick={onSettings}
                        aria-label={t("workspace.settings")}
                    >
                        <IconSettings />
                    </button>
                </nav>
            </div>
        );
    }

    return (
        <section className="workspace-shell workspace-shell-reader">
            <div className="workspace-shell-content">{content}</div>
        </section>
    );
}
