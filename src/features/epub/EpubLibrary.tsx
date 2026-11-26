import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent } from "react";
import { createPortal } from "react-dom";
import type { EpubBookData, EpubManualStatus, Tab } from "../../utils/constants";
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
import { isMangaTabData, type MangaMeta } from "../manga/mangaModel";
import type { MangaExportResult } from "../manga/mangaApi";
import CatalogPickerModal from "../manga/CatalogPickerModal";
import MangaBatchMokuroModal from "../manga/MangaBatchMokuroModal";
import RemoteMokuroControls from "../manga/RemoteMokuroControls";
import { compactCoverDataUrl } from "./epubCoverCache";
import { MOBILE_BACK_PRIORITY, useMobileBackHandler } from "../../utils/mobileBack";

import type { EpubSyncStatus } from "./useEpubSync";

const UNKNOWN_AUTHOR_KEY = "__unknown__";

export type EpubBookMetaPatch = Partial<
    Pick<EpubBookData, "title" | "author" | "series" | "seriesPosition" | "tags" | "shelves" | "manualStatus" | "coverBlurred" | "coverThumb">
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
    onCoverUpdated?: (path: string, cover: string) => void;
    onOpenStats?: () => void;
    syncStatus?: EpubSyncStatus;
    lastSyncedAt?: number | null;
    syncError?: string | null;
    downloadingBookId?: number | null;
    onSyncNow?: () => void;
    onUpdateMangaMeta?: (tabId: number, meta: MangaMeta) => void;
    onConvertMangaToCbz?: (tabId: number) => Promise<MangaExportResult | null>;
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
    onCoverUpdated,
    onOpenStats,
    syncStatus = "idle",
    lastSyncedAt = null,
    syncError = null,
    downloadingBookId = null,
    onSyncNow,
    onUpdateMangaMeta,
    onConvertMangaToCbz,
    onOpenCloudSettings,
}: EpubLibraryProps) {
    const t = getTranslator(language);
    const isEn = language === "en";

    const [prefs, setPrefs] = useState<EpubLibraryPrefs>(() => loadLibraryPrefs());
    const [query, setQuery] = useState("");
    const [authorFilter, setAuthorFilter] = useState<string>("all");
    const [tagFilter, setTagFilter] = useState<string>("all");
    const [shelfFilter, setShelfFilter] = useState<string>("all");
    const [formatFilter, setFormatFilter] = useState<"all" | "book" | "manga">("all");
    const [customShelves, setCustomShelves] = useState<string[]>(() => loadCustomShelves());
    const [addingShelf, setAddingShelf] = useState(false);
    const [newShelfName, setNewShelfName] = useState("");
    const [backupNotice, setBackupNotice] = useState<string | null>(null);
    const [convertingCbzId, setConvertingCbzId] = useState<number | null>(null);
    const [batchMokuroOpen, setBatchMokuroOpen] = useState(false);
    const [batchMokuroInitialIds, setBatchMokuroInitialIds] = useState<number[] | null>(null);
    const [batchCbzProgress, setBatchCbzProgress] = useState<{ current: number; total: number } | null>(null);
    const backupInputRef = useRef<HTMLInputElement>(null);
    const [focusedGroupKey, setFocusedGroupKey] = useState<string | null>(null);
    const [displayOpen, setDisplayOpen] = useState(false);

    // Multi-select mode
    const [selectMode, setSelectMode] = useState(false);
    const [selectedIds, setSelectedIds] = useState<Set<number>>(() => new Set());
    const lastSelectedIdRef = useRef<number | null>(null);

    // Inline bulk/single metadata editor modal & catalog search modal
    const [editingBook, setEditingBook] = useState<Tab | null>(null);
    const [catalogBook, setCatalogBook] = useState<Tab | null>(null);
    const [editTitle, setEditTitle] = useState("");
    const [editAuthor, setEditAuthor] = useState("");
    const [editSeries, setEditSeries] = useState("");
    const [editPosition, setEditPosition] = useState("");
    const [editTags, setEditTags] = useState("");
    const [editShelves, setEditShelves] = useState<string[]>([]);
    const [editStatus, setEditStatus] = useState<"auto" | EpubManualStatus>("auto");
    const [editBlurCover, setEditBlurCover] = useState(false);

    // Right-click book context menu & direct local cover replacement
    const [ctxMenu, setCtxMenu] = useState<{ bookId: number; x: number; y: number } | null>(null);
    const ctxMenuRef = useRef<HTMLDivElement>(null);
    const coverInputRef = useRef<HTMLInputElement>(null);
    const coverTargetBookRef = useRef<Tab | null>(null);

    useEffect(() => {
        if (!ctxMenu) return;
        const onPointerDown = (event: PointerEvent) => {
            const target = event.target as HTMLElement | null;
            if (target?.closest(".epub-ctx-menu")) return;
            setCtxMenu(null);
        };
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                setCtxMenu(null);
            }
        };
        const onClose = () => setCtxMenu(null);
        const onScroll = (event: Event) => {
            const target = event.target as HTMLElement | null;
            if (target?.closest?.(".epub-ctx-menu")) return;
            setCtxMenu(null);
        };
        window.addEventListener("pointerdown", onPointerDown, true);
        window.addEventListener("keydown", onKeyDown, true);
        window.addEventListener("resize", onClose);
        window.addEventListener("scroll", onScroll, true);
        return () => {
            window.removeEventListener("pointerdown", onPointerDown, true);
            window.removeEventListener("keydown", onKeyDown, true);
            window.removeEventListener("resize", onClose);
            window.removeEventListener("scroll", onScroll, true);
        };
    }, [ctxMenu]);

    useLayoutEffect(() => {
        if (!ctxMenu) return;
        const el = ctxMenuRef.current;
        if (!el) return;
        const w = el.offsetWidth;
        const h = el.offsetHeight;
        const margin = 12;
        const maxX = Math.max(margin, window.innerWidth - w - margin);
        const maxY = Math.max(margin, window.innerHeight - h - margin);
        const clampedX = Math.max(margin, Math.min(maxX, ctxMenu.x));
        const clampedY = Math.max(margin, Math.min(maxY, ctxMenu.y));
        el.style.left = `${clampedX}px`;
        el.style.top = `${clampedY}px`;
    }, [ctxMenu]);

    const handlePickLocalCoverFile = useCallback((file: File | null) => {
        const target = coverTargetBookRef.current;
        coverTargetBookRef.current = null;
        if (!file || !target?.epub?.path || !onCoverUpdated) return;
        if (!/^image\/(jpeg|png|webp)$/i.test(file.type) || file.size > 20 * 1024 * 1024) return;
        const reader = new FileReader();
        reader.onload = () => {
            const src = String(reader.result || "");
            if (src.startsWith("data:") && target.epub?.path) {
                onCoverUpdated(target.epub.path, src);
            }
        };
        reader.readAsDataURL(file);
    }, [onCoverUpdated]);

    // Bulk prompt drawer ("series" | "tags" | "shelves" | null)
    const [bulkPromptMode, setBulkPromptMode] = useState<"series" | "tags" | "shelves" | null>(null);
    const [bulkInputValue, setBulkInputValue] = useState("");

    useMobileBackHandler(isMobile && Boolean(ctxMenu), MOBILE_BACK_PRIORITY.POPUP, () => {
        setCtxMenu(null);
    });
    useMobileBackHandler(isMobile && displayOpen, MOBILE_BACK_PRIORITY.POPUP - 1, () => {
        setDisplayOpen(false);
    });
    useMobileBackHandler(isMobile && Boolean(editingBook), MOBILE_BACK_PRIORITY.MODAL, () => {
        setEditingBook(null);
    });
    useMobileBackHandler(isMobile && Boolean(bulkPromptMode), MOBILE_BACK_PRIORITY.MODAL, () => {
        setBulkPromptMode(null);
    });
    useMobileBackHandler(isMobile && addingShelf, MOBILE_BACK_PRIORITY.MODAL, () => {
        setAddingShelf(false);
    });
    useMobileBackHandler(isMobile && selectMode, MOBILE_BACK_PRIORITY.SUBVIEW + 2, () => {
        setSelectMode(false);
        setSelectedIds(new Set());
    });
    useMobileBackHandler(isMobile && Boolean(focusedGroupKey), MOBILE_BACK_PRIORITY.SUBVIEW, () => {
        setFocusedGroupKey(null);
    });

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

    const localMangaBooks = useMemo(
        () => activeBooks.filter((b) => isMangaTabData(b.epub) && !b.epub?.cloudOnly && Boolean(b.epub?.path)),
        [activeBooks],
    );
    const unprocessedMangaCount = useMemo(
        () => localMangaBooks.filter((b) => !b.epub?.hasMokuro).length,
        [localMangaBooks],
    );
    const selectedMangaBooks = useMemo(
        () => localMangaBooks.filter((b) => selectedIds.has(b.id)),
        [localMangaBooks, selectedIds],
    );

    const statusCounts = useMemo(() => {
        const counts: Record<"all" | EpubManualStatus, number> = {
            all: activeBooks.length,
            reading: 0,
            planned: 0,
            unread: 0,
            "on-hold": 0,
            completed: 0,
            dropped: 0,
        };
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

    const formatCounts = useMemo(() => {
        let manga = 0;
        let book = 0;
        for (const item of activeBooks) {
            if (isMangaTabData(item.epub)) manga += 1;
            else book += 1;
        }
        return { all: activeBooks.length, book, manga };
    }, [activeBooks]);

    const filteredBooks = useMemo(() => {
        const q = query.trim().toLowerCase();
        const list = activeBooks.filter((book) => {
            if (formatFilter === "manga" && !isMangaTabData(book.epub)) return false;
            if (formatFilter === "book" && isMangaTabData(book.epub)) return false;
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
    }, [activeBooks, query, formatFilter, prefs.statusFilter, prefs.langFilter, prefs.sortBy, prefs.sortDir, shelfFilter, authorFilter, tagFilter, language]);

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
            if (batchMokuroOpen || catalogBook) return;
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
    }, [selectMode, displayOpen, editingBook, batchMokuroOpen, catalogBook, visibleOrderedBooks]);

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

    const handleBatchConvertToCbz = useCallback(async (targets: Tab[]) => {
        if (!onConvertMangaToCbz || targets.length === 0 || batchCbzProgress !== null) return;
        let ok = 0;
        let fail = 0;
        for (let i = 0; i < targets.length; i++) {
            setBatchCbzProgress({ current: i + 1, total: targets.length });
            try {
                const res = await onConvertMangaToCbz(targets[i].id);
                if (res) ok += 1;
            } catch {
                fail += 1;
            }
        }
        setBatchCbzProgress(null);
        setBackupNotice(
            isEn
                ? `Converted to CBZ: ${ok} of ${targets.length}${fail > 0 ? ` (${fail} failed)` : ""}.`
                : `Преобразовано в CBZ: ${ok} из ${targets.length}${fail > 0 ? ` (ошибок: ${fail})` : ""}.`,
        );
    }, [onConvertMangaToCbz, batchCbzProgress, isEn]);

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
        setEditTitle(book.epub?.title || book.name || "");
        setEditAuthor(book.epub?.author || "");
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
        const nextTitle = editTitle.trim();
        onPatchBooks([editingBook.id], {
            ...(nextTitle ? { title: nextTitle } : {}),
            author: editAuthor.trim() || undefined,
            series: editSeries.trim() || undefined,
            seriesPosition: parsedPos !== null && Number.isFinite(parsedPos) ? parsedPos : null,
            tags: parsedTags,
            shelves: editShelves,
            manualStatus: editStatus === "auto" ? undefined : editStatus,
            coverBlurred: editBlurCover,
        });
        setEditingBook(null);
    }, [editingBook, onPatchBooks, editTitle, editAuthor, editSeries, editPosition, editTags, editShelves, editStatus, editBlurCover]);

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
        const chaptersCount = book.epub?.tocCount || book.epub?.chapterCount || 0;
        const totalChars = book.epub?.totalChars || 0;
        const title = book.epub?.title || book.name;
        const author = book.epub?.author?.trim() || "";
        const series = resolveBookSeries(book, activeBooks);
        const tags = book.epub?.tags || [];
        const status = resolveBookStatus(book);
        const localCover = book.epub?.path ? coversByPath[book.epub.path] : null;
        const coverSrc = book.epub?.cloudOnly ? book.epub.coverThumb || localCover : localCover || book.epub?.coverThumb;
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
                onContextMenu={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    setCtxMenu({ bookId: book.id, x: event.clientX, y: event.clientY });
                }}
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
                            ) : isMangaTabData(book.epub) ? (
                                <span
                                    className="epub-badge epub-badge-glass"
                                    style={{
                                        background: book.epub?.hasMokuro ? "rgba(56, 189, 128, 0.25)" : "rgba(245, 158, 11, 0.24)",
                                        color: book.epub?.hasMokuro ? "#86efac" : "#fde68a",
                                    }}
                                >
                                    {book.epub?.hasMokuro ? "MOKURO" : (isEn ? "MANGA" : "МАНГА")}
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
                            {status === "planned" && (
                                <span className="epub-badge epub-badge-planned" title={t("epub.statusPlanned")}>
                                    {t("epub.statusPlanned")}
                                </span>
                            )}
                            {status === "on-hold" && (
                                <span className="epub-badge epub-badge-on-hold" title={t("epub.statusOnHold")}>
                                    {t("epub.statusOnHold")}
                                </span>
                            )}
                            {status === "dropped" && (
                                <span className="epub-badge epub-badge-dropped" title={t("epub.statusDropped")}>
                                    {t("epub.statusDropped")}
                                </span>
                            )}
                        </div>
                        {!selectMode && (
                            <div className="epub-cover-right-actions">
                                {onPatchBooks && (
                                    <button
                                        type="button"
                                        className="epub-cover-edit-btn"
                                        title={isEn ? "Find title & cover" : "Найти тайтл и обложку"}
                                        aria-label={isEn ? "Find title & cover" : "Найти тайтл и обложку"}
                                        onClick={(event) => {
                                            event.stopPropagation();
                                            setCatalogBook(book);
                                        }}
                                    >
                                        <IconSearch />
                                    </button>
                                )}
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
                                {isMobile && onPatchBooks && (
                                    <button
                                        type="button"
                                        className="epub-cover-edit-btn"
                                        title={isEn ? "Book menu" : "Меню книги"}
                                        aria-label={isEn ? "Book menu" : "Меню книги"}
                                        onClick={(event) => {
                                            event.stopPropagation();
                                            const rect = event.currentTarget.getBoundingClientRect();
                                            setCtxMenu({ bookId: book.id, x: rect.right - 264, y: rect.bottom + 6 });
                                        }}
                                    >
                                        ⋮
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
                        <span>
                            {prefs.showProgress
                                ? `${progress}%`
                                : isMangaTabData(book.epub) && chaptersCount > 0
                                    ? (isEn ? `${chaptersCount} pp.` : `${chaptersCount} стр.`)
                                    : chaptersCount > 0
                                        ? t("epub.chaptersCount", { count: chaptersCount })
                                        : ""}
                        </span>
                        {prefs.showChars && totalChars > 0 ? (
                            <span>{formatCompactChars(totalChars)} {t("epub.charsShort")}</span>
                        ) : isMangaTabData(book.epub) && chaptersCount > 0 ? (
                            <span>{isEn ? `${chaptersCount} pp.` : `${chaptersCount} стр.`}</span>
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
                    <span className="epub-beta-pill">{isEn ? "Beta" : "Бета"}</span>
                    <span className="epub-library-count">
                        {t("epub.booksCount", { count: filteredBooks.length })}
                    </span>
                </div>
                <div className="epub-library-head-actions">
                    {onSyncNow && (
                        <button
                            type="button"
                            data-coach="lib-sync"
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
                            data-coach="lib-stats"
                            className="epub-glass-btn epub-lib-action-btn"
                            onClick={onOpenStats}
                            title={t("epub.statsTitle")}
                        >
                            {t("epub.statsTitle")}
                        </button>
                    )}
                    {!isMobile && localMangaBooks.length > 0 && (
                        <button
                            type="button"
                            data-coach="lib-mokuro"
                            className="epub-glass-btn epub-lib-action-btn"
                            title={isEn ? "Run batch Mokuro OCR on manga volumes" : "Запустить пакетный прогон Mokuro OCR по томам манги"}
                            onClick={() => {
                                setBatchMokuroInitialIds(null);
                                setBatchMokuroOpen(true);
                            }}
                        >
                            {unprocessedMangaCount > 0
                                ? `Mokuro OCR (${unprocessedMangaCount})`
                                : "Mokuro OCR"}
                        </button>
                    )}
                    <button
                        type="button"
                        data-coach="lib-select"
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
                            data-coach="lib-display"
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
                            data-coach="lib-folder"
                            className="epub-glass-btn epub-lib-action-btn"
                            onClick={onImportFolder}
                            title={t("epub.importFolderHint")}
                        >
                            {t("epub.importFolder")}
                        </button>
                    )}
                    <button
                        type="button"
                        data-coach="lib-open"
                        className={isMobile ? "m-pill-button primary" : "btn-primary"}
                        onClick={onOpenFile}
                    >
                        <IconImport /> {t("epub.openFile")}
                    </button>
                </div>
            </div>

            {syncStatus === "error" && syncError && (
                <div
                    role="alert"
                    style={{
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        gap: 10,
                        padding: "8px 12px",
                        borderRadius: 12,
                        background: "color-mix(in srgb, #e05a5a 14%, transparent)",
                        border: "1px solid color-mix(in srgb, #e05a5a 36%, transparent)",
                        color: "var(--text-main)",
                        fontSize: 12.5,
                    }}
                >
                    <span style={{ minWidth: 0, overflowWrap: "anywhere" }}>☁ Drive: {syncError}</span>
                    {onSyncNow && (
                        <button
                            type="button"
                            className="epub-glass-btn"
                            onClick={onSyncNow}
                        >
                            {isEn ? "Retry" : "Повторить"}
                        </button>
                    )}
                </div>
            )}

            {/* Reading status shelves + format filter + custom shelves */}
            <div className="epub-library-shelves" data-coach="lib-shelves">
                {formatCounts.manga > 0 && (
                    <div className="epub-segmented epub-shelf-tabs" role="tablist" aria-label={isEn ? "Media type" : "Тип"}>
                        {([
                            ["all", isEn ? "All" : "Все", formatCounts.all],
                            ["book", isEn ? "Books" : "Книги", formatCounts.book],
                            ["manga", isEn ? "Manga" : "Манга", formatCounts.manga],
                        ] as Array<["all" | "book" | "manga", string, number]>).map(([key, label, count]) => (
                            <button
                                key={key}
                                type="button"
                                role="tab"
                                aria-selected={formatFilter === key}
                                className={`epub-seg-btn${formatFilter === key ? " is-active" : ""}`}
                                onClick={() => {
                                    setFormatFilter(key);
                                    setFocusedGroupKey(null);
                                }}
                            >
                                {label} <span className="epub-shelf-count">{count}</span>
                            </button>
                        ))}
                    </div>
                )}
                <div className="epub-segmented epub-shelf-tabs" role="tablist" style={{ flexWrap: "wrap" }}>
                    {([
                        ["all", t("epub.statusAll"), statusCounts.all],
                        ["reading", t("epub.statusReading"), statusCounts.reading],
                        ["planned", t("epub.statusPlanned"), statusCounts.planned],
                        ["unread", t("epub.statusUnread"), statusCounts.unread],
                        ["on-hold", t("epub.statusOnHold"), statusCounts["on-hold"]],
                        ["completed", t("epub.statusCompleted"), statusCounts.completed],
                        ["dropped", t("epub.statusDropped"), statusCounts.dropped],
                    ] as Array<[LibraryStatusFilter, string, number]>)
                        .filter(([key, , count]) => key === "all" || key === "reading" || key === "unread" || key === "completed" || count > 0 || prefs.statusFilter === key)
                        .map(([statusKey, label, count]) => (
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
                <div className="epub-library-search-wrap" data-coach="lib-search">
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

                <div className="epub-library-filter-controls" data-coach="lib-filters">
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

            {/* Sticky Bulk Action Bar in Select Mode (placed above grid so it never overlaps bottom cards) */}
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
                        {selectedIds.size > 0 && (
                            <button
                                type="button"
                                className="epub-glass-btn"
                                onClick={() => setSelectedIds(new Set())}
                            >
                                {isEn ? "Clear" : "Снять"}
                            </button>
                        )}
                    </div>
                    {selectedIds.size > 0 && (
                        <div className="epub-bulk-actions">
                            {!isMobile && selectedMangaBooks.length > 0 && (
                                <>
                                    <button
                                        type="button"
                                        className="epub-glass-btn is-accent"
                                        onClick={() => {
                                            setBatchMokuroInitialIds(selectedMangaBooks.map((b) => b.id));
                                            setBatchMokuroOpen(true);
                                        }}
                                    >
                                        ✨ Mokuro OCR ({selectedMangaBooks.length})
                                    </button>
                                    {onConvertMangaToCbz && (
                                        <button
                                            type="button"
                                            className="epub-glass-btn"
                                            disabled={batchCbzProgress !== null}
                                            onClick={() => void handleBatchConvertToCbz([...selectedMangaBooks])}
                                        >
                                            {batchCbzProgress
                                                ? `CBZ ${batchCbzProgress.current}/${batchCbzProgress.total}…`
                                                : `📦 ${isEn ? "To CBZ" : "В CBZ"} (${selectedMangaBooks.length})`}
                                        </button>
                                    )}
                                    <span className="epub-bulk-divider" aria-hidden="true" />
                                </>
                            )}
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
                        {!isMobile && (
                            <button
                                type="button"
                                className="mcp-find-banner-btn"
                                onClick={() => {
                                    const target = editingBook;
                                    setEditingBook(null);
                                    setCatalogBook(target);
                                }}
                            >
                                <IconSearch />
                                {isEn ? "Find title & cover (AniList / MAL)…" : "Найти тайтл и обложку (AniList / MAL)…"}
                            </button>
                        )}
                        <label className="epub-edit-field">
                            <span>{isEn ? "Title" : "Название"}</span>
                            <input
                                type="text"
                                className="epub-bookmark-input"
                                value={editTitle}
                                onChange={(e) => setEditTitle(e.target.value)}
                            />
                        </label>
                        <label className="epub-edit-field">
                            <span>{isEn ? "Author" : "Автор"}</span>
                            <input
                                type="text"
                                className="epub-bookmark-input"
                                value={editAuthor}
                                onChange={(e) => setEditAuthor(e.target.value)}
                            />
                        </label>
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
                            <div className="epub-segmented" style={{ flexWrap: "wrap" }}>
                                {([
                                    ["auto", t("epub.indentAuto")],
                                    ["reading", t("epub.statusReading")],
                                    ["planned", t("epub.statusPlanned")],
                                    ["unread", t("epub.statusUnread")],
                                    ["on-hold", t("epub.statusOnHold")],
                                    ["completed", t("epub.statusCompleted")],
                                    ["dropped", t("epub.statusDropped")],
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
            <input
                ref={coverInputRef}
                type="file"
                accept="image/jpeg,image/png,image/webp"
                hidden
                onChange={(e) => {
                    const file = e.target.files?.[0] || null;
                    e.target.value = "";
                    handlePickLocalCoverFile(file);
                }}
            />
            {ctxMenu && (() => {
                const book = activeBooks.find((b) => b.id === ctxMenu.bookId);
                if (!book) return null;
                const currentStatus = resolveBookStatus(book);
                const progress = Math.round(Math.min(1, Math.max(0, book.epub?.progress || 0)) * 100);
                const bookTitle = book.epub?.title || book.name;
                const statusItems: Array<[EpubManualStatus, string]> = [
                    ["reading", t("epub.statusReading")],
                    ["planned", t("epub.statusPlanned")],
                    ["unread", t("epub.statusUnread")],
                    ["on-hold", t("epub.statusOnHold")],
                    ["completed", t("epub.statusCompleted")],
                    ["dropped", t("epub.statusDropped")],
                ];
                const hasMangaTools = !isMobile && isMangaTabData(book.epub) && !book.epub?.cloudOnly && (Boolean(book.epub?.path) || Boolean(onConvertMangaToCbz));
                const ctxMangaTargets =
                    selectMode && selectedIds.has(book.id) && selectedMangaBooks.length > 1
                        ? selectedMangaBooks
                        : [book];
                const ctxMultiManga = ctxMangaTargets.length > 1;
                return createPortal(
                    <div
                        ref={ctxMenuRef}
                        className="epub-ctx-menu"
                        role="menu"
                        style={{ left: `${ctxMenu.x}px`, top: `${ctxMenu.y}px` }}
                        onClick={(e) => e.stopPropagation()}
                        onContextMenu={(e) => e.preventDefault()}
                    >
                        <div className="epub-ctx-head">
                            <div className="epub-ctx-title" title={bookTitle}>{bookTitle}</div>
                            <div className="epub-ctx-sub">
                                {progress}%{book.epub?.author ? ` · ${book.epub.author}` : ""}
                            </div>
                        </div>

                        <button
                            type="button"
                            className="epub-ctx-item"
                            onClick={() => {
                                setCtxMenu(null);
                                onSelectBook(book.id);
                            }}
                        >
                            <svg className="epub-ctx-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                                <path d="M2 5.5A2.5 2.5 0 0 1 4.5 3H11v17H4.5A2.5 2.5 0 0 0 2 22V5.5z" />
                                <path d="M22 5.5A2.5 2.5 0 0 0 19.5 3H13v17h6.5a2.5 2.5 0 0 1 2.5 2V5.5z" />
                            </svg>
                            <span>{isEn ? "Open" : "Открыть"}</span>
                        </button>

                        {isMobile && isMangaTabData(book.epub) && (
                            <RemoteMokuroControls key={book.id} title={bookTitle} isEn={isEn} />
                        )}
                        {hasMangaTools && (
                            <>
                                <div className="epub-ctx-divider" />
                                {book.epub?.path && (
                                    <button
                                        type="button"
                                        className="epub-ctx-item is-accent"
                                        onClick={() => {
                                            setCtxMenu(null);
                                            setBatchMokuroInitialIds(ctxMangaTargets.map((b) => b.id));
                                            setBatchMokuroOpen(true);
                                        }}
                                    >
                                        <svg className="epub-ctx-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                                            <path d="M12 3l1.9 4.7L18.6 9.6l-4.7 1.9L12 16.2l-1.9-4.7L5.4 9.6l4.7-1.9L12 3z" />
                                            <path d="M19 16l.8 2 .2.1 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8.8-2z" />
                                        </svg>
                                        <span>
                                            {isEn
                                                ? (ctxMultiManga ? `Run Mokuro OCR (${ctxMangaTargets.length})` : "Run Mokuro OCR")
                                                : (ctxMultiManga ? `Запустить Mokuro OCR (${ctxMangaTargets.length})` : "Запустить Mokuro OCR")}
                                        </span>
                                    </button>
                                )}
                                {onConvertMangaToCbz && (
                                    <button
                                        type="button"
                                        className="epub-ctx-item"
                                        disabled={convertingCbzId === book.id || batchCbzProgress !== null}
                                        onClick={() => {
                                            setCtxMenu(null);
                                            if (ctxMultiManga) {
                                                void handleBatchConvertToCbz([...ctxMangaTargets]);
                                                return;
                                            }
                                            setConvertingCbzId(book.id);
                                            void onConvertMangaToCbz(book.id)
                                                .then((res) => {
                                                    if (!res) return;
                                                    const mb = (res.bytes / (1024 * 1024)).toFixed(1);
                                                    setBackupNotice(
                                                        isEn
                                                            ? `Converted "${bookTitle}" to .cbz (${res.pageCount} p., ${mb} MB)${res.hasMokuro ? " · .mokuro embedded" : ""} · ready for Drive sync.`
                                                            : `«${bookTitle}» преобразовано в CBZ (${res.pageCount} стр., ${mb} МБ)${res.hasMokuro ? " · .mokuro встроен" : ""} · синхронизация запущена.`,
                                                    );
                                                })
                                                .catch((err) => {
                                                    setBackupNotice(String(err));
                                                })
                                                .finally(() => {
                                                    setConvertingCbzId((prev) => (prev === book.id ? null : prev));
                                                });
                                        }}
                                    >
                                        <svg className="epub-ctx-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                                            <path d="M21 8l-9-5-9 5v8l9 5 9-5V8z" />
                                            <path d="M3.3 8.2L12 13l8.7-4.8M12 22V13" />
                                        </svg>
                                        <span>
                                            {convertingCbzId === book.id
                                                ? (isEn ? "Converting to CBZ…" : "Преобразование в CBZ…")
                                                : ctxMultiManga
                                                    ? (isEn ? `Convert to CBZ (${ctxMangaTargets.length})` : `Преобразовать в CBZ (${ctxMangaTargets.length})`)
                                                    : (isEn ? "Convert to CBZ" : "Преобразовать в CBZ")}
                                        </span>
                                    </button>
                                )}
                            </>
                        )}

                        <div className="epub-ctx-divider" />

                        {onPatchBooks && (
                            <button
                                type="button"
                                className="epub-ctx-item"
                                onClick={() => {
                                    setCtxMenu(null);
                                    setCatalogBook(book);
                                }}
                            >
                                <svg className="epub-ctx-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                                    <circle cx="11" cy="11" r="7" />
                                    <path d="M20 20l-3.5-3.5" />
                                </svg>
                                <span>{isEn ? "Find title & cover" : "Найти название и обложку"}</span>
                            </button>
                        )}

                        {onCoverUpdated && book.epub?.path && (
                            <button
                                type="button"
                                className="epub-ctx-item"
                                onClick={() => {
                                    coverTargetBookRef.current = book;
                                    setCtxMenu(null);
                                    coverInputRef.current?.click();
                                }}
                            >
                                <svg className="epub-ctx-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                                    <rect x="3" y="4" width="18" height="16" rx="2.5" />
                                    <circle cx="8.5" cy="9.5" r="1.5" />
                                    <path d="M21 15l-4.5-4.5L7 20" />
                                </svg>
                                <span>{isEn ? "Cover from file…" : "Обложка из файла…"}</span>
                            </button>
                        )}

                        {onPatchBooks && (
                            <>
                                <button
                                    type="button"
                                    className="epub-ctx-item"
                                    onClick={() => {
                                        setCtxMenu(null);
                                        openEditModal(book);
                                    }}
                                >
                                    <svg className="epub-ctx-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                                        <path d="M12 20h9" />
                                        <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
                                    </svg>
                                    <span>{t("epub.editMeta")}</span>
                                </button>
                                <button
                                    type="button"
                                    className="epub-ctx-item"
                                    onClick={() => {
                                        onPatchBooks([book.id], { coverBlurred: !book.epub?.coverBlurred });
                                        setCtxMenu(null);
                                    }}
                                >
                                    <svg className="epub-ctx-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                                        <path d="M2 12s3.8-6.5 10-6.5S22 12 22 12s-3.8 6.5-10 6.5S2 12 2 12z" />
                                        <circle cx="12" cy="12" r="2.8" />
                                        {book.epub?.coverBlurred ? null : <path d="M4 4l16 16" />}
                                    </svg>
                                    <span>
                                        {book.epub?.coverBlurred
                                            ? (isEn ? "Unblur cover" : "Показать обложку")
                                            : (isEn ? "Blur cover" : "Скрыть обложку")}
                                    </span>
                                </button>

                                <div className="epub-ctx-divider" />
                                <div className="epub-ctx-section-label">
                                    <span>{isEn ? "Status" : "Статус"}</span>
                                    {book.epub?.manualStatus && (
                                        <button
                                            type="button"
                                            className="epub-ctx-reset-link"
                                            onClick={() => {
                                                onPatchBooks([book.id], { manualStatus: undefined });
                                                setCtxMenu(null);
                                            }}
                                        >
                                            {t("epub.indentAuto")}
                                        </button>
                                    )}
                                </div>
                                <div className="epub-ctx-status-grid">
                                    {statusItems.map(([val, label]) => (
                                        <button
                                            key={val}
                                            type="button"
                                            className={`epub-ctx-status-pill${currentStatus === val ? " is-active" : ""}`}
                                            onClick={() => {
                                                onPatchBooks([book.id], { manualStatus: val });
                                                setCtxMenu(null);
                                            }}
                                        >
                                            <span className={`epub-ctx-dot is-${val}`} />
                                            <span>{label}</span>
                                        </button>
                                    ))}
                                </div>

                                {allShelves.length > 0 && (
                                    <>
                                        <div className="epub-ctx-divider" />
                                        <div className="epub-ctx-section-label">
                                            <span>{t("epub.shelvesLabel")}</span>
                                        </div>
                                        <div className="epub-ctx-shelves">
                                            {allShelves.map((shelf) => {
                                                const currentShelves = book.epub?.shelves || [];
                                                const hasShelf = currentShelves.includes(shelf);
                                                return (
                                                    <button
                                                        key={shelf}
                                                        type="button"
                                                        className={`epub-chip-toggle${hasShelf ? " is-active" : ""}`}
                                                        onClick={() => {
                                                            const nextShelves = hasShelf
                                                                ? currentShelves.filter((s) => s !== shelf)
                                                                : [...currentShelves, shelf];
                                                            onPatchBooks([book.id], { shelves: nextShelves });
                                                        }}
                                                    >
                                                        {shelf}
                                                    </button>
                                                );
                                            })}
                                        </div>
                                    </>
                                )}
                            </>
                        )}

                        <div className="epub-ctx-divider" />
                        <div className="epub-ctx-footer-row">
                            <button
                                type="button"
                                className="epub-ctx-item"
                                onClick={() => {
                                    setCtxMenu(null);
                                    setSelectMode(true);
                                    toggleBookSelection(book.id, false);
                                }}
                            >
                                <svg className="epub-ctx-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                                    <rect x="4" y="4" width="16" height="16" rx="3" />
                                    <path d="M8.5 12.2l2.5 2.5 4.8-5.2" />
                                </svg>
                                <span>{t("epub.selectMode")}</span>
                            </button>
                            <button
                                type="button"
                                className="epub-ctx-item is-danger"
                                onClick={() => {
                                    setCtxMenu(null);
                                    handleSafeRemoveSingle(book);
                                }}
                            >
                                <svg className="epub-ctx-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                                    <path d="M4 7h16" />
                                    <path d="M9 7V4h6v3" />
                                    <path d="M6.5 7l1 13h9l1-13" />
                                </svg>
                                <span>{t("epub.removeBook")}</span>
                            </button>
                        </div>
                    </div>,
                    document.body,
                );
            })()}
            {catalogBook && (
                <CatalogPickerModal
                    book={catalogBook}
                    siblingBooks={activeBooks.filter((other) => {
                        if (other.id === catalogBook.id) return false;
                        const sA = catalogBook.epub?.series || resolveBookSeries(catalogBook, activeBooks);
                        const sB = other.epub?.series || resolveBookSeries(other, activeBooks);
                        return Boolean(sA && sB && sA.trim().toLowerCase() === sB.trim().toLowerCase());
                    })}
                    language={language}
                    onClose={() => setCatalogBook(null)}
                    onApply={(updates, fallbackCover) => {
                        for (const u of updates) {
                            onPatchBooks?.([u.tabId], u.patch);
                            const cov = u.coverDataUrl ?? fallbackCover;
                            const updatedPath = activeBooks.find((b) => b.id === u.tabId)?.epub?.path;
                            if (cov && updatedPath) {
                                onCoverUpdated?.(updatedPath, cov);
                            }
                            if (cov) {
                                void compactCoverDataUrl(cov).then((thumb) => {
                                    if (thumb) onPatchBooks?.([u.tabId], { coverThumb: thumb });
                                });
                            }
                        }
                        if (updates.length === 0 && fallbackCover && catalogBook.epub?.path) {
                            onCoverUpdated?.(catalogBook.epub.path, fallbackCover);
                            void compactCoverDataUrl(fallbackCover).then((thumb) => {
                                if (thumb) onPatchBooks?.([catalogBook.id], { coverThumb: thumb });
                            });
                        }
                    }}
                />
            )}
            {!isMobile && batchMokuroOpen && (
                <MangaBatchMokuroModal
                    books={localMangaBooks}
                    initialSelectedIds={batchMokuroInitialIds ?? undefined}
                    language={language}
                    onUpdateMangaMeta={onUpdateMangaMeta}
                    onConvertMangaToCbz={onConvertMangaToCbz}
                    onSyncNow={onSyncNow}
                    onClose={() => {
                        setBatchMokuroOpen(false);
                        setBatchMokuroInitialIds(null);
                    }}
                />
            )}
        </div>
    );
}
