import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent } from "react";
import type { EpubBookData, Tab } from "../../utils/constants";
import { getTranslator, type AppLanguage } from "../../utils/i18n";
import { IconBookTab, IconClose, IconImport, IconSearch } from "../../components/Icons";
import EpubGlassSelect, { type EpubGlassOption } from "./EpubGlassSelect";
import {
    buildLibraryGroups,
    compareBooks,
    compareNaturalStrings,
    DEFAULT_LIBRARY_PREFS,
    loadCustomShelves,
    loadLibraryPrefs,
    resolveBookSeries,
    resolveBookStatus,
    saveCustomShelves,
    saveLibraryPrefs,
    saveRetainedBookData,
    type EpubLibraryPrefs,
    type LibraryBookSort,
    type LibraryGroupBy,
    type LibraryGroupSort,
    type LibraryStatusFilter,
} from "./epubLibraryModel";
import {
    buildPortableEpubBackup,
    parsePortableEpubBackup,
    type EpubPortableBackup,
} from "./epubBackup";
import { loadEpubGoals } from "./epubTracker";
import { exportDailyStatsSnapshot } from "../../utils/dailyStats";

import type { EpubSyncStatus } from "./useEpubSync";

const UNKNOWN_AUTHOR_KEY = "__unknown__";

export type EpubBookMetaPatch = Partial<
    Pick<EpubBookData, "series" | "seriesPosition" | "tags" | "shelves" | "manualStatus" | "coverBlurred">
>;

interface EpubLibraryProps {
    books: Tab[];
    coversByPath: Record<string, string | null>;
    language: AppLanguage;
    isMobile: boolean;
    onOpenFile: () => void;
    onImportFolder?: () => void;
    onImportBackup?: (backup: EpubPortableBackup) => { updatedBooks: number; retainedBooks: number };
    onSelectBook: (tabId: number) => void;
    onRemoveBook: (tabId: number) => void;
    onRemoveBooks?: (tabIds: number[]) => void;
    onPatchBooks?: (tabIds: number[], patch: EpubBookMetaPatch) => void;
    onOpenStats?: () => void;
    syncStatus?: EpubSyncStatus;
    lastSyncedAt?: number | null;
    syncError?: string | null;
    downloadingBookId?: number | null;
    onSyncNow?: () => void;
    onOpenCloudSettings?: () => void;
}

function formatCompactChars(count: number): string {
    if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
    if (count >= 1000) return `${Math.round(count / 1000)}k`;
    return String(count);
}

export default function EpubLibrary({
    books,
    coversByPath,
    language,
    isMobile,
    onOpenFile,
    onImportFolder,
    onImportBackup,
    onSelectBook,
    onRemoveBook,
    onRemoveBooks,
    onPatchBooks,
    onOpenStats,
    syncStatus = "idle",
    lastSyncedAt = null,
    syncError = null,
    downloadingBookId = null,
    onSyncNow,
    onOpenCloudSettings,
}: EpubLibraryProps) {
    const t = getTranslator(language);
    const isEn = language === "en";

    const [prefs, setPrefs] = useState<EpubLibraryPrefs>(() => loadLibraryPrefs());
    const [query, setQuery] = useState("");
    const [authorFilter, setAuthorFilter] = useState<string>("all");
    const [tagFilter, setTagFilter] = useState<string>("all");
    const [shelfFilter, setShelfFilter] = useState<string>("all");
    const [customShelves, setCustomShelves] = useState<string[]>(() => loadCustomShelves());
    const [addingShelf, setAddingShelf] = useState(false);
    const [newShelfName, setNewShelfName] = useState("");
    const [backupNotice, setBackupNotice] = useState<string | null>(null);
    const backupInputRef = useRef<HTMLInputElement>(null);
    const [focusedGroupKey, setFocusedGroupKey] = useState<string | null>(null);
    const [displayOpen, setDisplayOpen] = useState(false);

    // Multi-select mode
    const [selectMode, setSelectMode] = useState(false);
    const [selectedIds, setSelectedIds] = useState<Set<number>>(() => new Set());
    const lastSelectedIdRef = useRef<number | null>(null);

    // Inline bulk/single metadata editor modal
    const [editingBook, setEditingBook] = useState<Tab | null>(null);
    const [editSeries, setEditSeries] = useState("");
    const [editPosition, setEditPosition] = useState("");
    const [editTags, setEditTags] = useState("");
    const [editShelves, setEditShelves] = useState<string[]>([]);
    const [editStatus, setEditStatus] = useState<"auto" | "unread" | "reading" | "completed">("auto");
    const [editBlurCover, setEditBlurCover] = useState(false);

    // Bulk prompt drawer ("series" | "tags" | "shelves" | null)
    const [bulkPromptMode, setBulkPromptMode] = useState<"series" | "tags" | "shelves" | null>(null);
    const [bulkInputValue, setBulkInputValue] = useState("");

    const updatePrefs = useCallback((patch: Partial<EpubLibraryPrefs>) => {
        setPrefs((prev) => {
            const next = { ...prev, ...patch };
            saveLibraryPrefs(next);
            return next;
        });
    }, []);

    const activeBooks = useMemo(
        () => books.filter((tab) => !tab.archived),
        [books],
    );

    const statusCounts = useMemo(() => {
        const counts = { all: activeBooks.length, reading: 0, unread: 0, completed: 0 };
        for (const book of activeBooks) {
            counts[resolveBookStatus(book)] += 1;
        }
        return counts;
    }, [activeBooks]);

    const { authors, hasUnknownAuthor, allTags, allShelves, shelfCounts } = useMemo(() => {
        const authorSet = new Set<string>();
        const tagSet = new Set<string>();
        const shelfSet = new Set<string>(customShelves);
        const sCounts: Record<string, number> = {};
        let unknown = false;
        for (const book of activeBooks) {
            const author = book.epub?.author?.trim();
            if (author) authorSet.add(author);
            else unknown = true;
            for (const tag of book.epub?.tags || []) {
                const clean = tag.trim();
                if (clean) tagSet.add(clean);
            }
            for (const shelf of book.epub?.shelves || []) {
                const clean = shelf.trim();
                if (clean) {
                    shelfSet.add(clean);
                    sCounts[clean] = (sCounts[clean] || 0) + 1;
                }
            }
        }
        return {
            authors: Array.from(authorSet).sort((a, b) => compareNaturalStrings(a, b, language)),
            hasUnknownAuthor: unknown,
            allTags: Array.from(tagSet).sort((a, b) => compareNaturalStrings(a, b, language)),
            allShelves: Array.from(shelfSet),
            shelfCounts: sCounts,
        };
    }, [activeBooks, customShelves, language]);

    const handleAddCustomShelf = useCallback((rawName: string) => {
        const clean = rawName.trim();
        if (!clean) return;
        setCustomShelves((prev) => {
            if (prev.includes(clean)) return prev;
            const next = [...prev, clean];
            saveCustomShelves(next);
            return next;
        });
        setNewShelfName("");
        setAddingShelf(false);
    }, []);

    const handleDeleteCustomShelf = useCallback((shelfName: string) => {
        setCustomShelves((prev) => {
            const next = prev.filter((s) => s !== shelfName);
            saveCustomShelves(next);
            return next;
        });
        if (shelfFilter === shelfName) setShelfFilter("all");
        if (onPatchBooks) {
            for (const book of activeBooks) {
                const current = book.epub?.shelves || [];
                if (current.includes(shelfName)) {
                    onPatchBooks([book.id], { shelves: current.filter((s) => s !== shelfName) });
                }
            }
        }
    }, [shelfFilter, onPatchBooks, activeBooks]);

    const handleExportBackup = useCallback(() => {
        const payload = buildPortableEpubBackup(
            books,
            allShelves,
            loadEpubGoals(),
            exportDailyStatsSnapshot(),
        );
        const json = JSON.stringify(payload, null, 2);
        const blob = new Blob([json], { type: "application/json;charset=utf-8" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        const stamp = new Date().toISOString().slice(0, 10);
        a.href = url;
        a.download = `setsuna-epub-backup-${stamp}.json`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        window.setTimeout(() => URL.revokeObjectURL(url), 1500);
        setBackupNotice(t("epub.backupExported", { count: payload.books.length }));
    }, [books, allShelves, t]);

    const handleImportBackupFile = useCallback(async (file: File | null) => {
        if (!file || !onImportBackup) return;
        try {
            const text = await file.text();
            const parsed = parsePortableEpubBackup(text);
            const result = onImportBackup(parsed);
            setCustomShelves(loadCustomShelves());
            setBackupNotice(
                t("epub.backupImported", {
                    updated: result.updatedBooks,
                    retained: result.retainedBooks,
                }),
            );
        } catch (err) {
            setBackupNotice(t("epub.backupError", { error: String(err) }));
        }
    }, [onImportBackup, t]);

    const filteredBooks = useMemo(() => {
        const q = query.trim().toLowerCase();
        const list = activeBooks.filter((book) => {
            if (prefs.statusFilter !== "all" && resolveBookStatus(book) !== prefs.statusFilter) {
                return false;
            }
            if (shelfFilter !== "all" && !(book.epub?.shelves || []).includes(shelfFilter)) {
                return false;
            }
            const bookLang = book.epub?.language === "ja" ? "ja" : "en";
            if (prefs.langFilter !== "all" && bookLang !== prefs.langFilter) return false;

            const author = book.epub?.author?.trim() || "";
            if (authorFilter === UNKNOWN_AUTHOR_KEY) {
                if (author) return false;
            } else if (authorFilter !== "all" && author !== authorFilter) {
                return false;
            }

            const tags = book.epub?.tags || [];
            if (tagFilter !== "all" && !tags.includes(tagFilter)) {
                return false;
            }

            if (q) {
                const title = (book.epub?.title || book.name || "").toLowerCase();
                const series = resolveBookSeries(book, activeBooks).toLowerCase();
                const tagStr = tags.join(" ").toLowerCase();
                const shelfStr = (book.epub?.shelves || []).join(" ").toLowerCase();
                if (!title.includes(q) && !author.toLowerCase().includes(q) && !series.includes(q) && !tagStr.includes(q) && !shelfStr.includes(q)) {
                    return false;
                }
            }
            return true;
        });

        return [...list].sort((a, b) =>
            compareBooks(a, b, prefs.sortBy, prefs.sortDir, language, activeBooks, false),
        );
    }, [activeBooks, query, prefs.statusFilter, prefs.langFilter, prefs.sortBy, prefs.sortDir, shelfFilter, authorFilter, tagFilter, language]);

    const groups = useMemo(() => {
        if (prefs.groupBy === "none") return [];
        return buildLibraryGroups(filteredBooks, activeBooks, prefs, language, {
            noSeries: t("epub.noSeries"),
            noAuthor: t("epub.unknownAuthor"),
        });
    }, [filteredBooks, activeBooks, prefs, language, t]);

    const focusedGroup = useMemo(() => {
        if (!focusedGroupKey || prefs.groupBy === "none") return null;
        return groups.find((g) => g.key === focusedGroupKey) || null;
    }, [focusedGroupKey, groups, prefs.groupBy]);

    // Flat ordered list of currently visible books (used for Shift+Click range select and Ctrl+A)
    const visibleOrderedBooks = useMemo(() => {
        if (prefs.groupBy === "none") return filteredBooks;
        if (focusedGroup) return focusedGroup.books;
        return groups.flatMap((g) => g.books);
    }, [prefs.groupBy, filteredBooks, focusedGroup, groups]);

    // Prune selection when visible books change
    useEffect(() => {
        if (selectedIds.size === 0) return;
        const visibleSet = new Set(visibleOrderedBooks.map((b) => b.id));
        let changed = false;
        const next = new Set<number>();
        selectedIds.forEach((id) => {
            if (visibleSet.has(id)) next.add(id);
            else changed = true;
        });
        if (changed) setSelectedIds(next);
    }, [visibleOrderedBooks, selectedIds]);

    // Keyboard shortcuts in Select Mode: Ctrl+A select all visible, Esc exits select mode
    useEffect(() => {
        if (!selectMode && !displayOpen && !editingBook) return;
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.target instanceof Element && event.target.closest("input, textarea, select")) {
                if (event.key === "Escape" && editingBook) {
                    event.preventDefault();
                    setEditingBook(null);
                }
                return;
            }
            if (event.key === "Escape") {
                if (editingBook) {
                    event.preventDefault();
                    setEditingBook(null);
                } else if (displayOpen) {
                    event.preventDefault();
                    setDisplayOpen(false);
                } else if (selectMode) {
                    event.preventDefault();
                    setSelectMode(false);
                    setSelectedIds(new Set());
                    setBulkPromptMode(null);
                }
            } else if (selectMode && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "a") {
                event.preventDefault();
                setSelectedIds(new Set(visibleOrderedBooks.map((b) => b.id)));
            }
        };
        window.addEventListener("keydown", onKeyDown);
        return () => window.removeEventListener("keydown", onKeyDown);
    }, [selectMode, displayOpen, editingBook, visibleOrderedBooks]);

    const toggleBookSelection = useCallback((bookId: number, shiftKey: boolean) => {
        setSelectedIds((prev) => {
            const next = new Set(prev);
            if (shiftKey && lastSelectedIdRef.current !== null) {
                const startIdx = visibleOrderedBooks.findIndex((b) => b.id === lastSelectedIdRef.current);
                const endIdx = visibleOrderedBooks.findIndex((b) => b.id === bookId);
                if (startIdx !== -1 && endIdx !== -1) {
                    const [lo, hi] = startIdx < endIdx ? [startIdx, endIdx] : [endIdx, startIdx];
                    for (let i = lo; i <= hi; i++) {
                        next.add(visibleOrderedBooks[i].id);
                    }
                    lastSelectedIdRef.current = bookId;
                    return next;
                }
            }
            if (next.has(bookId)) next.delete(bookId);
            else next.add(bookId);
            lastSelectedIdRef.current = bookId;
            return next;
        });
    }, [visibleOrderedBooks]);

    const handleSafeRemoveSingle = useCallback((book: Tab) => {
        if (prefs.keepDataOnDelete) {
            saveRetainedBookData(book);
        }
        onRemoveBook(book.id);
    }, [prefs.keepDataOnDelete, onRemoveBook]);

    const handleBulkDelete = useCallback(() => {
        const ids = Array.from(selectedIds);
        if (ids.length === 0) return;
        if (prefs.keepDataOnDelete) {
            for (const id of ids) {
                const found = activeBooks.find((b) => b.id === id);
                if (found) saveRetainedBookData(found);
            }
        }
        if (onRemoveBooks) {
            onRemoveBooks(ids);
        } else {
            ids.forEach((id) => onRemoveBook(id));
        }
        setSelectedIds(new Set());
        setSelectMode(false);
        setBulkPromptMode(null);
    }, [selectedIds, prefs.keepDataOnDelete, activeBooks, onRemoveBooks, onRemoveBook]);

    const applyBulkPatch = useCallback((patch: EpubBookMetaPatch) => {
        const ids = Array.from(selectedIds);
        if (ids.length === 0 || !onPatchBooks) return;
        onPatchBooks(ids, patch);
    }, [selectedIds, onPatchBooks]);

    const openEditModal = useCallback((book: Tab) => {
        setEditingBook(book);
        setEditSeries(book.epub?.series || resolveBookSeries(book, activeBooks) || "");
        setEditPosition(
            typeof book.epub?.seriesPosition === "number" && Number.isFinite(book.epub.seriesPosition)
                ? String(book.epub.seriesPosition)
                : "",
        );
        setEditTags((book.epub?.tags || []).join(", "));
        setEditShelves(book.epub?.shelves ? [...book.epub.shelves] : []);
        setEditStatus(book.epub?.manualStatus || "auto");
        setEditBlurCover(Boolean(book.epub?.coverBlurred));
    }, [activeBooks]);

    const saveEditModal = useCallback(() => {
        if (!editingBook || !onPatchBooks) {
            setEditingBook(null);
            return;
        }
        const parsedPos = editPosition.trim() === "" ? null : Number(editPosition.trim().replace(",", "."));
        const parsedTags = editTags
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean);
        onPatchBooks([editingBook.id], {
            series: editSeries.trim() || undefined,
            seriesPosition: parsedPos !== null && Number.isFinite(parsedPos) ? parsedPos : null,
            tags: parsedTags,
            shelves: editShelves,
            manualStatus: editStatus === "auto" ? undefined : editStatus,
            coverBlurred: editBlurCover,
        });
        setEditingBook(null);
    }, [editingBook, onPatchBooks, editSeries, editPosition, editTags, editShelves, editStatus, editBlurCover]);

    const handleCardClick = useCallback((book: Tab, event: ReactMouseEvent) => {
        if (selectMode || event.shiftKey || event.ctrlKey || event.metaKey) {
            event.preventDefault();
            if (!selectMode) setSelectMode(true);
            toggleBookSelection(book.id, event.shiftKey);
            return;
        }
        onSelectBook(book.id);
    }, [selectMode, toggleBookSelection, onSelectBook]);

    const gridStyle = useMemo(() => ({
        ["--epub-card-min" as string]: `${isMobile ? Math.min(160, prefs.cardSize) : prefs.cardSize}px`,
    }) as CSSProperties, [prefs.cardSize, isMobile]);

    const renderBookCard = (book: Tab, cardIdx: number) => {
        const progress = Math.round(Math.min(1, Math.max(0, book.epub?.progress || 0)) * 100);
        const bookLang = book.epub?.language === "ja" ? "JA" : "EN";
        const chaptersCount = book.epub?.chapterCount || 0;
        const totalChars = book.epub?.totalChars || 0;
        const title = book.epub?.title || book.name;
        const author = book.epub?.author?.trim() || "";
        const series = resolveBookSeries(book, activeBooks);
        const tags = book.epub?.tags || [];
        const status = resolveBookStatus(book);
        const coverSrc = book.epub?.path ? coversByPath[book.epub.path] : null;
        const isSelected = selectedIds.has(book.id);
        const isCoverBlurred = Boolean(book.epub?.coverBlurred);
        const isCloudOnly = Boolean(book.epub?.cloudOnly);
        const isDownloading = downloadingBookId === book.id;

        return (
            <div
                key={book.id}
                className={`epub-book-card${isSelected ? " is-selected" : ""}${selectMode ? " is-selectable" : ""}${isCloudOnly ? " is-cloud-only" : ""}`}
                style={{ ["--i" as string]: Math.min(cardIdx, 20) }}
                role="button"
                tabIndex={0}
                title={isCloudOnly ? t("epub.cloudDownloadHint") : undefined}
                onClick={(event) => handleCardClick(book, event)}
                onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        if (selectMode) toggleBookSelection(book.id, event.shiftKey);
                        else onSelectBook(book.id);
                    }
                }}
            >
                <div className={`epub-book-cover-wrap${prefs.coverFit === "contain" ? " is-contain" : ""}`}>
                    {coverSrc ? (
                        <img
                            className={`epub-book-cover-img${isCoverBlurred ? " is-blurred" : ""}`}
                            src={coverSrc}
                            alt={title}
                            loading={cardIdx < 16 ? "eager" : "lazy"}
                            decoding="sync"
                        />
                    ) : (
                        <div className="epub-book-cover-fallback" aria-hidden="true">
                            <span className="epub-cover-fallback-icon"><IconBookTab /></span>
                            <span className="epub-cover-fallback-title">{title}</span>
                        </div>
                    )}
                    {isDownloading && (
                        <div className="epub-cover-downloading">
                            <span>{t("epub.cloudDownloading")}</span>
                        </div>
                    )}
                    <div className="epub-book-cover-overlay">
                        <div className="epub-cover-left-badges">
                            {selectMode ? (
                                <span className={`epub-select-check${isSelected ? " is-checked" : ""}`} aria-hidden="true">
                                    {isSelected ? "✓" : ""}
                                </span>
                            ) : (
                                <span className="epub-badge epub-badge-glass">{bookLang}</span>
                            )}
                            {isCloudOnly && (
                                <span className="epub-badge epub-badge-cloud" title={t("epub.cloudDownloadHint")}>☁</span>
                            )}
                            {status === "completed" && (
                                <span className="epub-badge epub-badge-done" title={t("epub.statusCompleted")}>✓</span>
                            )}
                        </div>
                        {!selectMode && (
                            <div className="epub-cover-right-actions">
                                {onPatchBooks && (
                                    <button
                                        type="button"
                                        className="epub-cover-edit-btn"
                                        title={t("epub.editMeta")}
                                        aria-label={t("epub.editMeta")}
                                        onClick={(event) => {
                                            event.stopPropagation();
                                            openEditModal(book);
                                        }}
                                    >
                                        ✎
                                    </button>
                                )}
                                <button
                                    type="button"
                                    className="epub-cover-remove-btn"
                                    title={t("epub.removeBook")}
                                    aria-label={t("epub.removeBook")}
                                    onClick={(event) => {
                                        event.stopPropagation();
                                        handleSafeRemoveSingle(book);
                                    }}
                                >
                                    <IconClose />
                                </button>
                            </div>
                        )}
                    </div>
                </div>

                <div className="epub-book-card-body">
                    <div className="epub-book-card-title" title={title}>{title}</div>
                    {prefs.showSeries && series && (
                        <div className="epub-book-series-tag" title={series}>
                            {series}
                            {typeof book.epub?.seriesPosition === "number" ? ` #${book.epub.seriesPosition}` : ""}
                        </div>
                    )}
                    {prefs.showAuthor && author && (
                        <div className="epub-book-card-author" title={author}>{author}</div>
                    )}
                    {prefs.showTags && tags.length > 0 && (
                        <div className="epub-book-tags">
                            {tags.slice(0, 3).map((tag) => (
                                <span key={tag} className="epub-book-tag-chip">{tag}</span>
                            ))}
                        </div>
                    )}
                    {prefs.showProgress && (
                        <div className="epub-progress-track">
                            <div className="epub-progress-fill" style={{ width: `${progress}%` }} />
                        </div>
                    )}
                    <div className="epub-book-card-meta">
                        <span>{prefs.showProgress ? `${progress}%` : (chaptersCount > 0 ? t("epub.chaptersCount", { count: chaptersCount }) : "")}</span>
                        {prefs.showChars && totalChars > 0 ? (
                            <span>{formatCompactChars(totalChars)} {t("epub.charsShort")}</span>
                        ) : chaptersCount > 0 ? (
                            <span>{t("epub.chaptersCount", { count: chaptersCount })}</span>
                        ) : null}
                    </div>
                </div>
            </div>
        );
    };

    if (activeBooks.length === 0) {
        if (isMobile) {
            return (
                <div className="m-empty">
                    <div className="m-empty-icon"><IconBookTab /></div>
                    <strong>{t("epub.emptyTitle")}</strong>
                    <span>{t("epub.emptyHint")}</span>
                    <div className="m-empty-actions">
                        <button type="button" className="m-pill-button primary" onClick={onOpenFile}>
                            {t("epub.openFile")}
                        </button>
                    </div>
                </div>
            );
        }

        return (
            <div className="mode-empty-state">
                <span className="mode-empty-icon"><IconBookTab /></span>
                <strong>{t("epub.emptyTitle")}</strong>
                <span>{t("epub.emptyHint")}</span>
                <button type="button" className="btn-primary" onClick={onOpenFile} style={{ marginTop: 8 }}>
                    <IconImport /> {t("epub.openFile")}
                </button>
            </div>
        );
    }

    return (
        <div className={`epub-library${isMobile ? " is-mobile" : ""}`} onClick={() => { if (displayOpen) setDisplayOpen(false); }}>
            <div className="epub-library-head">
                <div className="epub-library-title-group">
                    <h2 className="epub-library-title">{t("epub.library")}</h2>
                    <span className="epub-library-count">
                        {t("epub.booksCount", { count: filteredBooks.length })}
                    </span>
                </div>
                <div className="epub-library-head-actions">
                    {onSyncNow && (
                        <button
                            type="button"
                            className={`epub-glass-btn epub-lib-action-btn epub-sync-btn is-${syncStatus}`}
                            disabled={syncStatus === "syncing"}
                            title={
                                syncError
                                    ? syncError
                                    : syncStatus === "disconnected"
                                        ? t("epub.syncConnectDrive")
                                        : lastSyncedAt
                                            ? `${t("epub.synced")}: ${new Date(lastSyncedAt).toLocaleTimeString()}`
                                            : t("epub.syncNow")
                            }
                            onClick={() => {
                                if (syncStatus === "disconnected" && onOpenCloudSettings) {
                                    onOpenCloudSettings();
                                } else {
                                    onSyncNow();
                                }
                            }}
                        >
                            {syncStatus === "syncing"
                                ? `↻ ${t("epub.syncing")}`
                                : syncStatus === "disconnected"
                                    ? `☁ ${t("epub.syncConnectDrive")}`
                                    : syncStatus === "synced"
                                        ? `☁ ✓`
                                        : syncStatus === "error"
                                            ? `☁ !`
                                            : `☁ ${t("epub.syncNow")}`}
                        </button>
                    )}
                    {onOpenStats && (
                        <button
                            type="button"
                            className="epub-glass-btn epub-lib-action-btn"
                            onClick={onOpenStats}
                            title={t("epub.statsTitle")}
                        >
                            {t("epub.statsTitle")}
                        </button>
                    )}
                    <button
                        type="button"
                        className={`epub-glass-btn epub-lib-action-btn${selectMode ? " is-active" : ""}`}
                        onClick={() => {
                            setSelectMode((prev) => {
                                if (prev) {
                                    setSelectedIds(new Set());
                                    setBulkPromptMode(null);
                                }
                                return !prev;
                            });
                        }}
                    >
                        {selectMode ? t("epub.selectDone") : t("epub.selectMode")}
                    </button>
                    <div className="epub-display-anchor" onClick={(e) => e.stopPropagation()}>
                        <button
                            type="button"
                            className={`epub-glass-btn epub-lib-action-btn${displayOpen ? " is-active" : ""}`}
                            onClick={() => setDisplayOpen((prev) => !prev)}
                            title={t("epub.displaySettings")}
                        >
                            {isEn ? "View" : "Вид"}
                        </button>
                        {displayOpen && (
                            <div className="epub-display-popover" role="dialog" aria-label={t("epub.displaySettings")}>
                                <div className="epub-pop-head">
                                    <span>{t("epub.displaySettings")}</span>
                                    <button
                                        type="button"
                                        className="epub-pop-reset"
                                        onClick={() => updatePrefs({
                                            cardSize: DEFAULT_LIBRARY_PREFS.cardSize,
                                            coverFit: DEFAULT_LIBRARY_PREFS.coverFit,
                                            showAuthor: true,
                                            showSeries: false,
                                            showTags: true,
                                            showChars: false,
                                            showProgress: true,
                                        })}
                                    >
                                        {t("epub.resetTypography")}
                                    </button>
                                </div>

                                <div className="epub-pop-slider-group">
                                    <div className="epub-pop-slider-head">
                                        <span className="epub-pop-label">{t("epub.cardSize")}</span>
                                        <span className="epub-pop-val">{prefs.cardSize}px</span>
                                    </div>
                                    <input
                                        type="range"
                                        min={130}
                                        max={260}
                                        step={4}
                                        value={prefs.cardSize}
                                        onChange={(e) => updatePrefs({ cardSize: Number(e.target.value) })}
                                    />
                                </div>

                                <div className="epub-pop-row">
                                    <span className="epub-pop-label">{t("epub.coverFit")}</span>
                                    <div className="epub-segmented">
                                        <button
                                            type="button"
                                            className={`epub-seg-btn${prefs.coverFit === "cover" ? " is-active" : ""}`}
                                            onClick={() => updatePrefs({ coverFit: "cover" })}
                                        >
                                            {t("epub.coverFitFill")}
                                        </button>
                                        <button
                                            type="button"
                                            className={`epub-seg-btn${prefs.coverFit === "contain" ? " is-active" : ""}`}
                                            onClick={() => updatePrefs({ coverFit: "contain" })}
                                        >
                                            {t("epub.coverFitContain")}
                                        </button>
                                    </div>
                                </div>

                                <div className="epub-display-checks">
                                    <span className="epub-pop-label">{t("epub.cardFields")}</span>
                                    <div className="epub-display-chips">
                                        {([
                                            ["showAuthor", t("epub.fieldAuthor")],
                                            ["showSeries", t("epub.fieldSeries")],
                                            ["showTags", t("epub.fieldTags")],
                                            ["showChars", t("epub.fieldChars")],
                                            ["showProgress", t("epub.fieldProgress")],
                                        ] as const).map(([field, label]) => (
                                            <button
                                                key={field}
                                                type="button"
                                                className={`epub-chip-toggle${prefs[field] ? " is-active" : ""}`}
                                                onClick={() => updatePrefs({ [field]: !prefs[field] })}
                                            >
                                                {label}
                                            </button>
                                        ))}
                                    </div>
                                </div>

                                <label className="epub-pop-row epub-pop-check-row">
                                    <span className="epub-pop-label">{t("epub.keepDataOnDelete")}</span>
                                    <input
                                        type="checkbox"
                                        checked={prefs.keepDataOnDelete}
                                        onChange={(e) => updatePrefs({ keepDataOnDelete: e.target.checked })}
                                    />
                                </label>

                                <div className="epub-backup-section">
                                    <span className="epub-pop-label">{t("epub.backupTitle")}</span>
                                    <div className="epub-backup-actions">
                                        <button
                                            type="button"
                                            className="epub-glass-btn"
                                            onClick={handleExportBackup}
                                        >
                                            {t("epub.backupExport")}
                                        </button>
                                        {onImportBackup && (
                                            <>
                                                <button
                                                    type="button"
                                                    className="epub-glass-btn"
                                                    onClick={() => backupInputRef.current?.click()}
                                                >
                                                    {t("epub.backupImport")}
                                                </button>
                                                <input
                                                    ref={backupInputRef}
                                                    type="file"
                                                    accept=".json,application/json"
                                                    style={{ display: "none" }}
                                                    onChange={(e) => {
                                                        const file = e.target.files?.[0] || null;
                                                        e.target.value = "";
                                                        void handleImportBackupFile(file);
                                                    }}
                                                />
                                            </>
                                        )}
                                    </div>
                                    {backupNotice && (
                                        <div className="epub-backup-notice">{backupNotice}</div>
                                    )}
                                </div>
                            </div>
                        )}
                    </div>
                    {onImportFolder && !isMobile && (
                        <button
                            type="button"
                            className="epub-glass-btn epub-lib-action-btn"
                            onClick={onImportFolder}
                            title={t("epub.importFolderHint")}
                        >
                            {t("epub.importFolder")}
                        </button>
                    )}
                    <button
                        type="button"
                        className={isMobile ? "m-pill-button primary" : "btn-primary"}
                        onClick={onOpenFile}
                    >
                        <IconImport /> {t("epub.openFile")}
                    </button>
                </div>
            </div>

            {/* Reading status shelves + custom shelves */}
            <div className="epub-library-shelves">
                <div className="epub-segmented epub-shelf-tabs" role="tablist">
                    {([
                        ["all", t("epub.statusAll"), statusCounts.all],
                        ["reading", t("epub.statusReading"), statusCounts.reading],
                        ["unread", t("epub.statusUnread"), statusCounts.unread],
                        ["completed", t("epub.statusCompleted"), statusCounts.completed],
                    ] as Array<[LibraryStatusFilter, string, number]>).map(([statusKey, label, count]) => (
                        <button
                            key={statusKey}
                            type="button"
                            role="tab"
                            aria-selected={prefs.statusFilter === statusKey}
                            className={`epub-seg-btn${prefs.statusFilter === statusKey ? " is-active" : ""}`}
                            onClick={() => {
                                updatePrefs({ statusFilter: statusKey });
                                setFocusedGroupKey(null);
                            }}
                        >
                            {label} <span className="epub-shelf-count">{count}</span>
                        </button>
                    ))}
                </div>

                <div className="epub-custom-shelves-row">
                    {allShelves.map((shelf) => (
                        <div key={shelf} className={`epub-custom-shelf-chip${shelfFilter === shelf ? " is-active" : ""}`}>
                            <button
                                type="button"
                                className="epub-custom-shelf-btn"
                                onClick={() => {
                                    setShelfFilter((prev) => (prev === shelf ? "all" : shelf));
                                    setFocusedGroupKey(null);
                                }}
                            >
                                {shelf} <span className="epub-shelf-count">{shelfCounts[shelf] || 0}</span>
                            </button>
                            <button
                                type="button"
                                className="epub-custom-shelf-del"
                                title={t("epub.deleteShelf")}
                                aria-label={t("epub.deleteShelf")}
                                onClick={() => handleDeleteCustomShelf(shelf)}
                            >
                                ×
                            </button>
                        </div>
                    ))}
                    {addingShelf ? (
                        <form
                            className="epub-new-shelf-form"
                            onSubmit={(e) => {
                                e.preventDefault();
                                handleAddCustomShelf(newShelfName);
                            }}
                        >
                            <input
                                type="text"
                                className="epub-new-shelf-input"
                                autoFocus
                                value={newShelfName}
                                onChange={(e) => setNewShelfName(e.target.value)}
                                placeholder={t("epub.shelfPlaceholder")}
                                onKeyDown={(e) => {
                                    if (e.key === "Escape") {
                                        setAddingShelf(false);
                                        setNewShelfName("");
                                    }
                                }}
                            />
                            <button type="submit" className="epub-glass-btn">+</button>
                            <button
                                type="button"
                                className="epub-glass-btn"
                                onClick={() => {
                                    setAddingShelf(false);
                                    setNewShelfName("");
                                }}
                            >
                                ×
                            </button>
                        </form>
                    ) : (
                        <button
                            type="button"
                            className="epub-chip-toggle epub-add-shelf-btn"
                            onClick={() => setAddingShelf(true)}
                        >
                            + {t("epub.addShelf")}
                        </button>
                    )}
                </div>
            </div>

            <div className="epub-library-filters">
                <div className="epub-library-search-wrap">
                    <span className="epub-library-search-icon" aria-hidden="true"><IconSearch /></span>
                    <input
                        type="search"
                        className="epub-library-search"
                        value={query}
                        onChange={(event) => setQuery(event.target.value)}
                        placeholder={t("epub.searchLibrary")}
                        aria-label={t("epub.searchLibrary")}
                    />
                </div>

                <div className="epub-library-filter-controls">
                    <div className="epub-segmented" role="group" aria-label={t("epub.allLanguages")}>
                        {(["all", "ja", "en"] as const).map((code) => (
                            <button
                                key={code}
                                type="button"
                                className={`epub-seg-btn${prefs.langFilter === code ? " is-active" : ""}`}
                                onClick={() => updatePrefs({ langFilter: code })}
                            >
                                {code === "all" ? t("epub.allLanguages") : code.toUpperCase()}
                            </button>
                        ))}
                    </div>

                    <EpubGlassSelect
                        ariaLabel={t("epub.groupSeries")}
                        value={prefs.groupBy}
                        onChange={(next) => {
                            updatePrefs({ groupBy: next as LibraryGroupBy });
                            setFocusedGroupKey(null);
                        }}
                        options={[
                            { value: "none", label: t("epub.groupNone") },
                            { value: "series", label: t("epub.groupSeries") },
                            { value: "author", label: t("epub.groupAuthor") },
                        ]}
                    />

                    {prefs.groupBy !== "none" && !focusedGroup && (
                        <div className="epub-sort-pair">
                            <EpubGlassSelect
                                ariaLabel={t("epub.groupSortAlpha")}
                                value={prefs.groupSortBy}
                                onChange={(next) => updatePrefs({ groupSortBy: next as LibraryGroupSort })}
                                options={[
                                    { value: "alpha", label: t("epub.groupSortAlpha") },
                                    { value: "recent", label: t("epub.groupSortRecent") },
                                    { value: "progress", label: t("epub.groupSortProgress") },
                                    { value: "count", label: t("epub.groupSortCount") },
                                ]}
                            />
                            <button
                                type="button"
                                className="epub-glass-btn epub-sort-dir-btn"
                                title={prefs.groupSortDir === "asc" ? "A → Z" : "Z → A"}
                                onClick={() => updatePrefs({ groupSortDir: prefs.groupSortDir === "asc" ? "desc" : "asc" })}
                            >
                                {prefs.groupSortDir === "asc" ? "↑" : "↓"}
                            </button>
                        </div>
                    )}

                    <EpubGlassSelect
                        ariaLabel={t("epub.allAuthors")}
                        value={authorFilter}
                        onChange={(next) => setAuthorFilter(next)}
                        options={[
                            { value: "all", label: t("epub.allAuthors") },
                            ...authors.map((author): EpubGlassOption => ({ value: author, label: author })),
                            ...(hasUnknownAuthor && authors.length > 0
                                ? [{ value: UNKNOWN_AUTHOR_KEY, label: t("epub.unknownAuthor") }]
                                : []),
                        ]}
                    />

                    {allTags.length > 0 && (
                        <EpubGlassSelect
                            ariaLabel={t("epub.allTags")}
                            value={tagFilter}
                            onChange={(next) => setTagFilter(next)}
                            options={[
                                { value: "all", label: t("epub.allTags") },
                                ...allTags.map((tag): EpubGlassOption => ({ value: tag, label: `#${tag}` })),
                            ]}
                        />
                    )}

                    <div className="epub-sort-pair">
                        <EpubGlassSelect
                            ariaLabel={t("epub.sortRecent")}
                            align="right"
                            value={prefs.sortBy}
                            onChange={(next) => {
                                const sortKey = next as LibraryBookSort;
                                const defaultDir = (sortKey === "title" || sortKey === "author" || sortKey === "series") ? "asc" : "desc";
                                updatePrefs({ sortBy: sortKey, sortDir: defaultDir });
                            }}
                            options={[
                                { value: "recent", label: t("epub.sortRecent") },
                                { value: "added", label: t("epub.sortAdded") },
                                { value: "title", label: t("epub.sortTitle") },
                                { value: "author", label: t("epub.sortAuthor") },
                                { value: "series", label: t("epub.sortSeries") },
                                { value: "characters", label: t("epub.sortChars") },
                                { value: "progress", label: t("epub.sortProgress") },
                            ]}
                        />
                        <button
                            type="button"
                            className="epub-glass-btn epub-sort-dir-btn"
                            title={prefs.sortDir === "asc" ? (isEn ? "Ascending" : "По возрастанию") : (isEn ? "Descending" : "По убыванию")}
                            onClick={() => updatePrefs({ sortDir: prefs.sortDir === "asc" ? "desc" : "asc" })}
                        >
                            {prefs.sortDir === "asc" ? "↑" : "↓"}
                        </button>
                    </div>
                </div>
            </div>

            {focusedGroup && (
                <div className="epub-group-breadcrumb">
                    <button type="button" className="epub-glass-btn" onClick={() => setFocusedGroupKey(null)}>
                        ← {prefs.groupBy === "series" ? t("epub.groupSeries") : t("epub.groupAuthor")}
                    </button>
                    <strong>{focusedGroup.label}</strong>
                    <span className="epub-group-meta-pill">
                        {t("epub.booksCount", { count: focusedGroup.books.length })} · {Math.round(focusedGroup.aggregateProgress * 100)}%
                    </span>
                </div>
            )}

            {filteredBooks.length === 0 ? (
                <div className="epub-library-empty-filter">
                    <span>{t("epub.noMatches")}</span>
                </div>
            ) : prefs.groupBy === "none" ? (
                <div className="epub-library-grid" style={gridStyle}>
                    {filteredBooks.map((book, idx) => renderBookCard(book, idx))}
                </div>
            ) : focusedGroup ? (
                <div className="epub-library-grid" style={gridStyle}>
                    {focusedGroup.books.map((book, idx) => renderBookCard(book, idx))}
                </div>
            ) : (
                <div className="epub-library-groups">
                    {groups.map((group) => {
                        const groupPct = Math.round(group.aggregateProgress * 100);
                        return (
                            <section key={group.key} className="epub-group-section">
                                <div className="epub-group-header">
                                    <button
                                        type="button"
                                        className="epub-group-title-btn"
                                        onClick={() => setFocusedGroupKey(group.key)}
                                    >
                                        <span className="epub-group-title">{group.label}</span>
                                        <span className="epub-group-count">{group.books.length}</span>
                                    </button>
                                    <div className="epub-group-progress-wrap">
                                        <div className="epub-group-progress-bar">
                                            <div className="epub-group-progress-fill" style={{ width: `${groupPct}%` }} />
                                        </div>
                                        <span className="epub-group-pct">{groupPct}%</span>
                                    </div>
                                </div>
                                <div className="epub-library-grid" style={gridStyle}>
                                    {group.books.map((book, idx) => renderBookCard(book, idx))}
                                </div>
                            </section>
                        );
                    })}
                </div>
            )}

            {/* Floating bulk action bar in Select Mode */}
            {selectMode && (
                <div className="epub-bulk-bar" role="toolbar">
                    <div className="epub-bulk-left">
                        <strong>{t("epub.selectedCount", { count: selectedIds.size })}</strong>
                        <button
                            type="button"
                            className="epub-glass-btn"
                            onClick={() => setSelectedIds(new Set(visibleOrderedBooks.map((b) => b.id)))}
                        >
                            {t("epub.selectAll")}
                        </button>
                    </div>
                    {selectedIds.size > 0 && (
                        <div className="epub-bulk-actions">
                            {onPatchBooks && (
                                <>
                                    <button
                                        type="button"
                                        className="epub-glass-btn"
                                        onClick={() => {
                                            setBulkPromptMode("series");
                                            setBulkInputValue("");
                                        }}
                                    >
                                        {t("epub.bulkSeries")}
                                    </button>
                                    <button
                                        type="button"
                                        className="epub-glass-btn"
                                        onClick={() => {
                                            setBulkPromptMode("tags");
                                            setBulkInputValue("");
                                        }}
                                    >
                                        {t("epub.bulkTags")}
                                    </button>
                                    <button
                                        type="button"
                                        className="epub-glass-btn"
                                        onClick={() => {
                                            setBulkPromptMode("shelves");
                                            setBulkInputValue("");
                                        }}
                                    >
                                        {t("epub.shelvesLabel")}
                                    </button>
                                    <button
                                        type="button"
                                        className="epub-glass-btn"
                                        onClick={() => applyBulkPatch({ manualStatus: "completed" })}
                                    >
                                        {t("epub.bulkComplete")}
                                    </button>
                                    <button
                                        type="button"
                                        className="epub-glass-btn"
                                        onClick={() => applyBulkPatch({ manualStatus: "unread" })}
                                    >
                                        {t("epub.bulkUnread")}
                                    </button>
                                    <button
                                        type="button"
                                        className="epub-glass-btn"
                                        onClick={() => {
                                            const anyUnblurred = Array.from(selectedIds).some((id) => {
                                                const b = activeBooks.find((x) => x.id === id);
                                                return !b?.epub?.coverBlurred;
                                            });
                                            applyBulkPatch({ coverBlurred: anyUnblurred });
                                        }}
                                    >
                                        {t("epub.bulkBlurCover")}
                                    </button>
                                </>
                            )}
                            <button
                                type="button"
                                className="epub-glass-btn is-danger"
                                onClick={handleBulkDelete}
                            >
                                {t("epub.bulkDelete")}
                            </button>
                        </div>
                    )}
                </div>
            )}

            {/* Inline bulk series/tags prompt */}
            {bulkPromptMode && (
                <div className="epub-modal-backdrop" onClick={() => setBulkPromptMode(null)}>
                    <form
                        className="epub-modal-card epub-edit-meta-modal"
                        onClick={(e) => e.stopPropagation()}
                        onSubmit={(e) => {
                            e.preventDefault();
                            if (bulkPromptMode === "series") {
                                applyBulkPatch({ series: bulkInputValue.trim() || undefined });
                            } else if (bulkPromptMode === "shelves") {
                                const shelves = bulkInputValue.split(",").map((s) => s.trim()).filter(Boolean);
                                if (shelves.length > 0) {
                                    setCustomShelves((prev) => {
                                        const merged = Array.from(new Set([...prev, ...shelves]));
                                        saveCustomShelves(merged);
                                        return merged;
                                    });
                                }
                                applyBulkPatch({ shelves });
                            } else {
                                const tags = bulkInputValue.split(",").map((s) => s.trim()).filter(Boolean);
                                applyBulkPatch({ tags });
                            }
                            setBulkPromptMode(null);
                        }}
                    >
                        <div className="epub-modal-head">
                            <strong>
                                {bulkPromptMode === "series"
                                    ? t("epub.seriesLabel")
                                    : bulkPromptMode === "shelves"
                                        ? t("epub.shelvesLabel")
                                        : t("epub.tagsLabel")}
                            </strong>
                            <button type="button" className="epub-glass-btn epub-glass-circle" onClick={() => setBulkPromptMode(null)}>
                                <IconClose />
                            </button>
                        </div>
                        <input
                            type="text"
                            className="epub-bookmark-input"
                            autoFocus
                            value={bulkInputValue}
                            onChange={(e) => setBulkInputValue(e.target.value)}
                            placeholder={
                                bulkPromptMode === "series"
                                    ? t("epub.seriesLabel")
                                    : bulkPromptMode === "shelves"
                                        ? t("epub.shelfPlaceholder")
                                        : t("epub.tagsLabel")
                            }
                        />
                        <div className="epub-modal-foot">
                            <button type="button" className="epub-glass-btn" onClick={() => setBulkPromptMode(null)}>
                                {t("common.close")}
                            </button>
                            <button type="submit" className="btn-primary">
                                {isEn ? "Apply" : "Применить"}
                            </button>
                        </div>
                    </form>
                </div>
            )}

            {/* Single-book metadata editor modal */}
            {editingBook && (
                <div className="epub-modal-backdrop" onClick={() => setEditingBook(null)}>
                    <form
                        className="epub-modal-card epub-edit-meta-modal"
                        onClick={(e) => e.stopPropagation()}
                        onSubmit={(e) => {
                            e.preventDefault();
                            saveEditModal();
                        }}
                    >
                        <div className="epub-modal-head">
                            <strong>{t("epub.editMeta")}</strong>
                            <button type="button" className="epub-glass-btn epub-glass-circle" onClick={() => setEditingBook(null)}>
                                <IconClose />
                            </button>
                        </div>
                        <div className="epub-edit-meta-title">{editingBook.epub?.title || editingBook.name}</div>
                        <label className="epub-edit-field">
                            <span>{t("epub.seriesLabel")}</span>
                            <input
                                type="text"
                                className="epub-bookmark-input"
                                value={editSeries}
                                onChange={(e) => setEditSeries(e.target.value)}
                            />
                        </label>
                        <label className="epub-edit-field">
                            <span>{t("epub.volumePosLabel")}</span>
                            <input
                                type="number"
                                step="any"
                                className="epub-bookmark-input"
                                value={editPosition}
                                onChange={(e) => setEditPosition(e.target.value)}
                                placeholder="1, 2, 3..."
                            />
                        </label>
                        <label className="epub-edit-field">
                            <span>{t("epub.tagsLabel")}</span>
                            <input
                                type="text"
                                className="epub-bookmark-input"
                                value={editTags}
                                onChange={(e) => setEditTags(e.target.value)}
                                placeholder="isekai, ln, ..."
                            />
                        </label>
                        {allShelves.length > 0 && (
                            <div className="epub-edit-field">
                                <span>{t("epub.shelvesLabel")}</span>
                                <div className="epub-display-chips">
                                    {allShelves.map((shelf) => {
                                        const active = editShelves.includes(shelf);
                                        return (
                                            <button
                                                key={shelf}
                                                type="button"
                                                className={`epub-chip-toggle${active ? " is-active" : ""}`}
                                                onClick={() => {
                                                    setEditShelves((prev) =>
                                                        prev.includes(shelf)
                                                            ? prev.filter((s) => s !== shelf)
                                                            : [...prev, shelf],
                                                    );
                                                }}
                                            >
                                                {shelf}
                                            </button>
                                        );
                                    })}
                                </div>
                            </div>
                        )}
                        <div className="epub-edit-field">
                            <span>{isEn ? "Reading status" : "Статус чтения"}</span>
                            <div className="epub-segmented">
                                {([
                                    ["auto", t("epub.indentAuto")],
                                    ["unread", t("epub.statusUnread")],
                                    ["reading", t("epub.statusReading")],
                                    ["completed", t("epub.statusCompleted")],
                                ] as const).map(([val, label]) => (
                                    <button
                                        key={val}
                                        type="button"
                                        className={`epub-seg-btn${editStatus === val ? " is-active" : ""}`}
                                        onClick={() => setEditStatus(val)}
                                    >
                                        {label}
                                    </button>
                                ))}
                            </div>
                        </div>
                        <label className="epub-pop-row epub-pop-check-row">
                            <span className="epub-pop-label">{t("epub.bulkBlurCover")}</span>
                            <input
                                type="checkbox"
                                checked={editBlurCover}
                                onChange={(e) => setEditBlurCover(e.target.checked)}
                            />
                        </label>
                        <div className="epub-modal-foot">
                            <button type="button" className="epub-glass-btn" onClick={() => setEditingBook(null)}>
                                {t("common.close")}
                            </button>
                            <button type="submit" className="btn-primary">
                                {isEn ? "Save" : "Сохранить"}
                            </button>
                        </div>
                    </form>
                </div>
            )}
        </div>
    );
}
