import { useCallback, useEffect, useRef, useState } from "react";
import type { AppSettings } from "../../components/SettingsModal";
import type { Tab } from "../../utils/constants";
import { getTranslator } from "../../utils/i18n";
import WorkspaceShell from "../../components/WorkspaceShell";
import StatsPanel from "../../components/StatsPanel";
import { IconBookTab, IconHome, IconImport, IconSettings } from "../../components/Icons";
import EpubLibrary from "./EpubLibrary";
import EpubReader from "./EpubReader";
import { loadEpubChapter, openEpubBook } from "./epubApi";
import type {
    EpubBookMeta,
    EpubChapterContent,
    EpubOrientationSetting,
    EpubParagraph,
} from "./epubModel";
import { resolveEpubOrientation } from "./epubModel";
import "./epub.css";

const MAX_CACHED_CHAPTERS = 12;

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
    isPaused: boolean;
    onTogglePause: () => void;
    onHome: () => void;
    onSettings: () => void;
    onOpenFile: () => void;
    onSelectBook: (tabId: number) => void;
    onRemoveBook: (tabId: number) => void;
    onUpdateBookMeta: (tabId: number, meta: EpubBookMeta) => void;
    onProgressChange: (tabId: number, chapterIndex: number, chapterOffset: number, bookProgress: number) => void;
    onCountParagraphs: (tabId: number, chapterIndex: number, paragraphs: EpubParagraph[], upToIndex: number) => void;
    onChangeBookOrientation: (tabId: number, orientation: EpubOrientationSetting) => void;
    onUpdateSettings?: (patch: Partial<AppSettings>) => void;
    onReadingActivity: () => void;
    onLookupToken?: LookupTokenHandler;
}

export default function EpubWorkspace({
    books,
    activeBookTab,
    settings,
    isMobile,
    standaloneMobile = true,
    isPaused,
    onTogglePause,
    onHome,
    onSettings,
    onOpenFile,
    onSelectBook,
    onRemoveBook,
    onUpdateBookMeta,
    onProgressChange,
    onCountParagraphs,
    onChangeBookOrientation,
    onUpdateSettings,
    onReadingActivity,
    onLookupToken,
}: EpubWorkspaceProps) {
    const language = settings.appLanguage || "ru";
    const t = getTranslator(language);

    const [viewMode, setViewMode] = useState<"library" | "reader">(activeBookTab ? "reader" : "library");
    const [bookMeta, setBookMeta] = useState<EpubBookMeta | null>(null);
    const [chapter, setChapter] = useState<EpubChapterContent | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [pendingFragment, setPendingFragment] = useState<string | null>(null);

    const metaCacheRef = useRef<Map<string, EpubBookMeta>>(new Map());
    const chapterCacheRef = useRef<Map<string, EpubChapterContent>>(new Map());
    const loadGenerationRef = useRef(0);

    const bookPath = activeBookTab?.epub?.path || "";
    const activeTabId = activeBookTab?.id ?? null;

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

    const handleSelectChapter = useCallback((nextIndex: number, fragment?: string) => {
        if (!activeBookTab || !bookPath || !bookMeta) return;
        const clamped = Math.min(Math.max(0, bookMeta.chapters.length - 1), Math.max(0, nextIndex));
        const generation = ++loadGenerationRef.current;
        setPendingFragment(fragment || null);
        onReadingActivity();
        const bookProgress = bookMeta.chapters.length > 0 ? clamped / bookMeta.chapters.length : 0;
        onProgressChange(activeBookTab.id, clamped, 0, bookProgress);
        void fetchChapter(bookPath, clamped, generation);
    }, [activeBookTab, bookPath, bookMeta, fetchChapter, onProgressChange, onReadingActivity]);

    const handleSelectBook = useCallback((tabId: number) => {
        onSelectBook(tabId);
        setViewMode("reader");
    }, [onSelectBook]);

    const resolvedOrientation = activeBookTab
        ? resolveEpubOrientation(
            activeBookTab.epub?.language || bookMeta?.language,
            settings.epubTextOrientation,
            activeBookTab.epub?.defaultVertical ?? bookMeta?.defaultVertical,
            activeBookTab.epub?.orientation,
        )
        : "horizontal";

    const content = (
        <div className={`epub-workspace${isMobile ? " is-mobile" : ""}`}>
            {viewMode === "reader" && activeBookTab ? (
                <>
                    <EpubReader
                        tab={activeBookTab}
                        bookMeta={bookMeta}
                        chapter={chapter}
                        loading={loading}
                        error={error}
                        settings={settings}
                        isMobile={isMobile}
                        pendingFragment={pendingFragment}
                        onFragmentHandled={() => setPendingFragment(null)}
                        onSelectChapter={handleSelectChapter}
                        onProgressChange={(chapterIdx, offset, progress) =>
                            onProgressChange(activeBookTab.id, chapterIdx, offset, progress)
                        }
                        onCountParagraphs={(chapterIdx, paragraphs, upToIndex) =>
                            onCountParagraphs(activeBookTab.id, chapterIdx, paragraphs, upToIndex)
                        }
                        onReadingActivity={onReadingActivity}
                        onChangeBookOrientation={(orientation) =>
                            onChangeBookOrientation(activeBookTab.id, orientation)
                        }
                        onUpdateSettings={onUpdateSettings}
                        onLookupToken={onLookupToken}
                        onBackToLibrary={() => setViewMode("library")}
                        onOpenFile={onOpenFile}
                    />
                    {!isMobile && (
                        <StatsPanel
                            stats={activeBookTab.stats}
                            speedSamples={activeBookTab.speedSamples}
                            isPaused={isPaused}
                            onTogglePause={onTogglePause}
                            position={settings.panelPosition}
                            speedMetric={settings.speedMetric}
                            speedTimeframe={settings.speedTimeframe}
                            language={language}
                            textOrientation={resolvedOrientation}
                            tabId={activeBookTab.id}
                            tabName={activeBookTab.epub?.title || activeBookTab.name}
                        />
                    )}
                </>
            ) : (
                <EpubLibrary
                    books={books}
                    language={language}
                    isMobile={isMobile}
                    onOpenFile={onOpenFile}
                    onSelectBook={handleSelectBook}
                    onRemoveBook={onRemoveBook}
                />
            )}
        </div>
    );

    if (isMobile) {
        if (!standaloneMobile) {
            return content;
        }
        const totalSeconds = activeBookTab?.stats?.time || 0;
        const mins = Math.floor(totalSeconds / 60);
        const secs = totalSeconds % 60;
        const timerLabel = `${mins}:${secs < 10 ? "0" : ""}${secs}`;
        const islandTitle = viewMode === "reader" && activeBookTab
            ? (activeBookTab.epub?.title || activeBookTab.name)
            : t("epub.title");
        const islandMeta = viewMode === "reader" && activeBookTab
            ? `${Math.round(Math.min(1, Math.max(0, activeBookTab.epub?.progress || 0)) * 100)}%`
            : String(books.filter((tab) => !tab.archived).length);

        return (
            <div className="m-shell">
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
                        <span className="m-dot" style={{ ["--dot" as string]: "#d6a84f" }} aria-hidden="true" />
                        <span className="m-island-name">{islandTitle}</span>
                        <span className="m-island-meta">{islandMeta}</span>
                    </button>
                </header>

                <main className="m-main">{content}</main>

                <nav className="m-dock" aria-label={t("epub.title")}>
                    <button
                        type="button"
                        className={`m-dock-timer${isPaused ? "" : " is-running"}`}
                        onClick={onTogglePause}
                        aria-label={isPaused ? t("stats.start") : t("stats.pause")}
                    >
                        <span aria-hidden="true">{isPaused ? "▶" : "Ⅱ"}</span>
                        {timerLabel}
                    </button>
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
        <WorkspaceShell
            title={t("epub.title")}
            icon={<IconBookTab />}
            accent="reader"
            language={language}
            onHome={onHome}
            onSettings={onSettings}
        >
            {content}
        </WorkspaceShell>
    );
}
