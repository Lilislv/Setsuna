import { useCallback, useEffect, useRef, useState } from "react";
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
import { getInitialCoverSnapshot, hasCachedCover, setMemoryCover } from "./epubCoverCache";
import type {
    EpubBookMeta,
    EpubBookNote,
    EpubChapterContent,
    EpubHighlight,
    EpubOrientationSetting,
    EpubReadingPoint,
} from "./epubModel";
import { loadEpubGoals, type EpubReadingGoals } from "./epubTracker";
import "./epub.css";

const MAX_CACHED_CHAPTERS = 12;
const ESC_MENU_CLOSE_MS = 180;

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
    onSelectBook: (tabId: number) => void;
    onRemoveBook: (tabId: number) => void;
    onRemoveBooks?: (tabIds: number[]) => void;
    onPatchBooks?: (tabIds: number[], patch: EpubBookMetaPatch) => void;
    onUpdateBookMeta: (tabId: number, meta: EpubBookMeta) => void;
    onProgressChange: (tabId: number, chapterIndex: number, chapterOffset: number, bookProgress: number) => void;
    onChangeBookOrientation: (tabId: number, orientation: EpubOrientationSetting) => void;
    onChangeBookBookmarks?: (tabId: number, bookmarks: EpubBookmark[]) => void;
    onChangeBookHighlights?: (tabId: number, highlights: EpubHighlight[]) => void;
    onChangeBookNotes?: (tabId: number, notes: EpubBookNote[]) => void;
    onChangeReadingPoint?: (tabId: number, point: EpubReadingPoint | null) => void;
    onRecordReadingStats?: (tabId: number, deltaChars: number, deltaSeconds: number) => void;
    onUpdateSettings?: (patch: Partial<AppSettings>) => void;
    onLookupToken?: LookupTokenHandler;
    resumePromptBookId?: number | null;
    onDismissResumePrompt?: () => void;
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
    onSelectBook,
    onRemoveBook,
    onRemoveBooks,
    onPatchBooks,
    onUpdateBookMeta,
    onProgressChange,
    onChangeBookOrientation,
    onChangeBookBookmarks,
    onChangeBookHighlights,
    onChangeBookNotes,
    onChangeReadingPoint,
    onRecordReadingStats,
    onUpdateSettings,
    onLookupToken,
    resumePromptBookId = null,
    onDismissResumePrompt,
}: EpubWorkspaceProps) {
    const language = settings.appLanguage || "ru";
    const isEn = language === "en";
    const t = getTranslator(language);

    const [viewMode, setViewMode] = useState<"library" | "reader">(
        resumePromptBookId ? "library" : (activeBookTab ? "reader" : "library"),
    );
    const [bookMeta, setBookMeta] = useState<EpubBookMeta | null>(null);
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
    const [escMenuMounted, setEscMenuMounted] = useState(false);
    const [escMenuVisible, setEscMenuVisible] = useState(false);
    const [escMenuEntering, setEscMenuEntering] = useState(false);
    const escMenuPanelRef = useRef<HTMLDivElement>(null);
    const pendingMenuActionRef = useRef<(() => void) | null>(null);

    const [coversByPath, setCoversByPath] = useState<Record<string, string | null>>(() => getInitialCoverSnapshot());

    const metaCacheRef = useRef<Map<string, EpubBookMeta>>(new Map());
    const chapterCacheRef = useRef<Map<string, EpubChapterContent>>(new Map());
    const loadGenerationRef = useRef(0);

    const bookPath = activeBookTab?.epub?.path || "";
    const activeTabId = activeBookTab?.id ?? null;

    useEffect(() => {
        if (viewMode !== "reader") {
            setMobileImmersive(false);
        }
    }, [viewMode]);

    // Switch into reader view automatically when a new book tab becomes active
    const prevActiveTabIdRef = useRef<number | null>(activeTabId);
    useEffect(() => {
        if (activeTabId !== null && activeTabId !== prevActiveTabIdRef.current) {
            setViewMode("reader");
        } else if (activeTabId === null) {
            setViewMode("library");
        }
        prevActiveTabIdRef.current = activeTabId;
    }, [activeTabId]);

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

    // Android hardware/gesture Back button: close active sheets/drawers first, then return to Home menu.
    const mobileBackRef = useRef({
        lookupOpen,
        readerOverlayOpen,
        onCloseLookup,
        onHome,
    });
    mobileBackRef.current = {
        lookupOpen,
        readerOverlayOpen,
        onCloseLookup,
        onHome,
    };

    useEffect(() => {
        if (!isMobile || !standaloneMobile) return;
        const pushWorkspaceGuard = () => {
            const state = window.history.state as Record<string, unknown> | null;
            if (!state?.setsunaMobileWorkspace) {
                window.history.pushState({ ...(state || {}), setsunaMobileWorkspace: "epub" }, "", window.location.href);
            }
        };
        pushWorkspaceGuard();

        const handlePopState = () => {
            const current = mobileBackRef.current;
            const fontPickerClose = document.querySelector<HTMLButtonElement>(".font-picker-overlay .font-picker-close");
            if (fontPickerClose) {
                fontPickerClose.click();
                pushWorkspaceGuard();
                return;
            }
            if (current.lookupOpen) {
                current.onCloseLookup?.();
                pushWorkspaceGuard();
                return;
            }
            if (current.readerOverlayOpen) {
                setCloseOverlaySignal((n) => n + 1);
                pushWorkspaceGuard();
                return;
            }
            current.onHome();
        };

        window.addEventListener("popstate", handlePopState);
        return () => window.removeEventListener("popstate", handlePopState);
    }, [isMobile, standaloneMobile]);

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
        const missingCoverPaths: string[] = [];
        const seen = new Set<string>();
        for (const tab of books) {
            if (tab.archived || !tab.epub?.path) continue;
            const path = tab.epub.path;
            if (seen.has(path) || hasCachedCover(path)) continue;
            seen.add(path);
            missingCoverPaths.push(path);
        }

        if (missingCoverPaths.length === 0) return;
        let cancelled = false;

        void (async () => {
            const CONCURRENCY = 6;
            let cursor = 0;
            const worker = async () => {
                while (!cancelled) {
                    const idx = cursor++;
                    if (idx >= missingCoverPaths.length) return;
                    const path = missingCoverPaths[idx];
                    const cover = await loadEpubCover(path).catch(() => null);
                    setMemoryCover(path, cover);
                    if (!cancelled) {
                        setCoversByPath((prev) => (prev[path] === cover ? prev : { ...prev, [path]: cover }));
                    }
                }
            };
            await Promise.all(
                Array.from({ length: Math.min(CONCURRENCY, missingCoverPaths.length) }, () => worker()),
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
            .filter((tab) => !tab.archived && tab.epub?.path)
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

    // Load book metadata + initial/saved chapter whenever active book changes
    useEffect(() => {
        if (viewMode !== "reader" || !activeBookTab || !bookPath) {
            setBookMeta(null);
            setChapter(null);
            setError(null);
            return;
        }

        const generation = ++loadGenerationRef.current;
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
    }, [viewMode, activeBookTab?.id, bookPath, fetchChapter, onUpdateBookMeta]);

    const handleSelectChapter = useCallback((nextIndex: number, fragment?: string, paragraphIndex?: number) => {
        if (!activeBookTab || !bookPath || !bookMeta) return;
        const clamped = Math.min(Math.max(0, bookMeta.chapters.length - 1), Math.max(0, nextIndex));
        const generation = ++loadGenerationRef.current;
        setPendingFragment(fragment || null);
        setPendingParagraphIndex(typeof paragraphIndex === "number" ? paragraphIndex : null);
        const bookProgress = bookMeta.chapters.length > 0 ? clamped / bookMeta.chapters.length : 0;
        onProgressChange(activeBookTab.id, clamped, 0, bookProgress);
        void fetchChapter(bookPath, clamped, generation);
    }, [activeBookTab, bookPath, bookMeta, fetchChapter, onProgressChange]);

    const handleSelectBook = useCallback((tabId: number) => {
        onSelectBook(tabId);
        setViewMode("reader");
    }, [onSelectBook]);

    const visibleBooks = books.filter((tab) => !tab.archived);
    const activeBookTitle = viewMode === "reader" && activeBookTab
        ? (activeBookTab.epub?.title || bookMeta?.title || activeBookTab.name)
        : t("epub.library");
    const activeBookSubtitle = viewMode === "reader" && activeBookTab
        ? [
            activeBookTab.epub?.author || bookMeta?.author,
            chapter?.title || t("epub.chapterOf", {
                current: (chapter?.index ?? activeBookTab.epub?.chapterIndex ?? 0) + 1,
                total: bookMeta?.chapters.length || activeBookTab.epub?.chapterCount || 1,
            }),
            `${Math.round(Math.min(1, Math.max(0, activeBookTab.epub?.progress || 0)) * 100)}%`,
        ].filter(Boolean).join(" · ")
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
                                    <small>.epub · .txt · .htmlz</small>
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
            {viewMode === "reader" && activeBookTab ? (
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
            ) : (
                <EpubLibrary
                    books={books}
                    coversByPath={coversByPath}
                    language={language}
                    isMobile={isMobile}
                    onOpenFile={onOpenFile}
                    onSelectBook={handleSelectBook}
                    onRemoveBook={onRemoveBook}
                    onRemoveBooks={onRemoveBooks}
                    onPatchBooks={onPatchBooks}
                    onOpenStats={() => setStatsOpen(true)}
                />
            )}
            {escMenuElement}
            {resumeBook && (
                <div className="epub-modal-backdrop" onClick={() => onDismissResumePrompt?.()}>
                    <div className="epub-modal-card epub-resume-modal" onClick={(e) => e.stopPropagation()}>
                        <div className="epub-resume-body">
                            <div className="epub-resume-cover-wrap">
                                {resumeBook.epub?.path && coversByPath[resumeBook.epub.path] ? (
                                    <img
                                        src={coversByPath[resumeBook.epub.path]!}
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
            />
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

        return (
            <div className={`m-shell epub-mobile-shell${isImmersiveShell ? " is-immersive" : ""}`}>
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
