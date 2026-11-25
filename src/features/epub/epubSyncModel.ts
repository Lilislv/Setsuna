import type { EpubBookmark, EpubManualStatus, Tab, TabStats } from "../../utils/constants";
import type { BookFileExt, EpubBookNote, EpubHighlight, EpubLanguage, EpubOrientationSetting, EpubReadingPoint } from "./epubModel";

export const EPUB_SYNC_FILENAME = "setsuna_epub_sync.json";
export const EPUB_SYNC_SCHEMA_VERSION = 1;

export interface EpubSyncBookEntry {
    bookKey: string;
    title: string;
    author?: string;
    series?: string;
    seriesPosition?: number | null;
    tags?: string[];
    shelves?: string[];
    manualStatus?: EpubManualStatus;
    coverBlurred?: boolean;
    language?: EpubLanguage;
    defaultVertical?: boolean;
    orientation?: EpubOrientationSetting;
    chapterIndex: number;
    chapterOffset: number;
    chapterCount?: number;
    totalChars?: number;
    progress: number;
    lastOpenedAt: number;
    addedAt?: number;
    updatedAt: number;
    readingPoint?: EpubReadingPoint | null;
    bookmarks?: EpubBookmark[];
    highlights?: EpubHighlight[];
    notes?: EpubBookNote[];
    stats?: TabStats;
    driveFileId?: string;
    fileExt?: BookFileExt | "cbz" | "zip" | "mokuro" | "manga-dir";
    format?: "book" | "manga";
    hasMokuro?: boolean;
    fileRevision?: number;
    coverThumb?: string;
}

export interface EpubSyncManifest {
    schemaVersion: number;
    updatedAt: number;
    books: Record<string, EpubSyncBookEntry>;
}

export function emptySyncManifest(): EpubSyncManifest {
    return {
        schemaVersion: EPUB_SYNC_SCHEMA_VERSION,
        updatedAt: 0,
        books: {},
    };
}

export function getBookSyncKey(title: string): string {
    return title.normalize("NFKC").replace(/\s+/g, "").toLowerCase();
}

export function inferFileExtFromPath(path?: string): BookFileExt | "cbz" | "zip" {
    const lower = (path || "").trim().toLowerCase();
    if (lower.endsWith(".fb2.zip")) return "fb2.zip";
    if (lower.endsWith(".fb2")) return "fb2";
    if (lower.endsWith(".txt")) return "txt";
    if (lower.endsWith(".htmlz")) return "htmlz";
    if (lower.endsWith(".html")) return "html";
    if (lower.endsWith(".htm")) return "htm";
    if (lower.endsWith(".xhtml")) return "xhtml";
    if (lower.endsWith(".md") || lower.endsWith(".markdown")) return "md";
    if (lower.endsWith(".docx")) return "docx";
    if (lower.endsWith(".mobi")) return "mobi";
    if (lower.endsWith(".azw3")) return "azw3";
    if (lower.endsWith(".prc")) return "prc";
    if (lower.endsWith(".pdf")) return "pdf";
    if (lower.endsWith(".cbz")) return "cbz";
    if (lower.endsWith(".zip")) return "zip";
    return "epub";
}

export function tabToSyncEntry(tab: Tab): EpubSyncBookEntry | null {
    if (tab.mode !== "epub" || !tab.epub || tab.archived) return null;
    const title = (tab.epub.title || tab.name || "").trim();
    const bookKey = getBookSyncKey(title);
    if (!bookKey) return null;

    const updatedAt = Math.max(
        tab.epub.syncUpdatedAt || 0,
        tab.epub.lastOpenedAt || 0,
        tab.epub.readingPoint?.savedAt || 0,
    );
    const rawThumb = tab.epub.coverThumb;
    const coverThumb =
        typeof rawThumb === "string" && rawThumb.startsWith("data:image/") && rawThumb.length <= 45_000
            ? rawThumb
            : undefined;

    return {
        bookKey,
        title,
        author: tab.epub.author,
        series: tab.epub.series,
        seriesPosition: tab.epub.seriesPosition ?? null,
        tags: tab.epub.tags,
        shelves: tab.epub.shelves,
        manualStatus: tab.epub.manualStatus,
        coverBlurred: tab.epub.coverBlurred,
        language: tab.epub.language,
        defaultVertical: tab.epub.defaultVertical,
        orientation: tab.epub.orientation,
        chapterIndex: tab.epub.chapterIndex || 0,
        chapterOffset: tab.epub.chapterOffset || 0,
        chapterCount: tab.epub.chapterCount,
        totalChars: tab.epub.totalChars,
        progress: tab.epub.progress || 0,
        lastOpenedAt: tab.epub.lastOpenedAt || 0,
        addedAt: tab.epub.addedAt,
        updatedAt,
        readingPoint: tab.epub.readingPoint ?? null,
        bookmarks: tab.epub.bookmarks || [],
        highlights: tab.epub.highlights || [],
        notes: tab.epub.notes || [],
        stats: tab.stats,
        driveFileId: tab.epub.driveFileId,
        fileExt: tab.epub.fileExt || inferFileExtFromPath(tab.epub.path),
        format: tab.epub.format,
        hasMokuro: tab.epub.hasMokuro,
        fileRevision: tab.epub.fileRevision,
        coverThumb,
    };
}

function mergeById<T extends { id: string; createdAt?: number; updatedAt?: number }>(
    localList: readonly T[] | undefined,
    remoteList: readonly T[] | undefined,
): T[] {
    const map = new Map<string, T>();
    for (const item of localList || []) {
        map.set(item.id, item);
    }
    for (const item of remoteList || []) {
        const existing = map.get(item.id);
        if (!existing) {
            map.set(item.id, item);
        } else {
            const existingTs = existing.updatedAt ?? existing.createdAt ?? 0;
            const remoteTs = item.updatedAt ?? item.createdAt ?? 0;
            if (remoteTs >= existingTs) {
                map.set(item.id, item);
            }
        }
    }
    return Array.from(map.values()).sort(
        (a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0),
    );
}

/**
 * Conflict-free merge of two sync records for the same book (e.g. PC vs Android):
 * - Reading position (`chapterIndex`, `chapterOffset`, `progress`, `readingPoint`):
 *   whichever device read more recently (`updatedAt` / `lastOpenedAt`) wins.
 * - Bookmarks, highlights, and notes: union-merged by ID so annotations from both devices are kept.
 * - Reading stats: monotonic max so counts never regress.
 * - Cloud file ID (`driveFileId`): preserved from whichever side uploaded the book.
 */
export function mergeEpubBookEntries(
    local: EpubSyncBookEntry,
    remote: EpubSyncBookEntry,
): { merged: EpubSyncBookEntry; localChanged: boolean; remoteChanged: boolean } {
    const localPosTs = Math.max(local.updatedAt || 0, local.lastOpenedAt || 0);
    const remotePosTs = Math.max(remote.updatedAt || 0, remote.lastOpenedAt || 0);
    const remoteWinsPosition = remotePosTs > localPosTs
        || (remotePosTs === localPosTs && remote.progress > local.progress);

    const posSource = remoteWinsPosition ? remote : local;
    const metaSource = remotePosTs > localPosTs ? remote : local;

    const mergedBookmarks = mergeById(local.bookmarks, remote.bookmarks);
    const mergedHighlights = mergeById(local.highlights, remote.highlights);
    const mergedNotes = mergeById(local.notes, remote.notes);

    const mergedStats: TabStats = {
        chars: Math.max(local.stats?.chars || 0, remote.stats?.chars || 0),
        words: Math.max(local.stats?.words || 0, remote.stats?.words || 0),
        sentences: Math.max(local.stats?.sentences || 0, remote.stats?.sentences || 0),
        time: Math.max(local.stats?.time || 0, remote.stats?.time || 0),
    };

    const mergedReadingPoint = (() => {
        const lp = local.readingPoint;
        const rp = remote.readingPoint;
        if (!lp) return rp ?? null;
        if (!rp) return lp;
        return (rp.savedAt || 0) >= (lp.savedAt || 0) ? rp : lp;
    })();

    const localRev = local.fileRevision || 0;
    const remoteRev = remote.fileRevision || 0;
    const resolvedFileRevision = Math.max(localRev, remoteRev) || undefined;
    const resolvedDriveFileId =
        localRev > remoteRev
            ? local.driveFileId
            : remoteRev > localRev
                ? remote.driveFileId || local.driveFileId
                : local.driveFileId || remote.driveFileId;
    const resolvedFileExt =
        localRev > remoteRev
            ? local.fileExt || remote.fileExt || "epub"
            : remoteRev > localRev
                ? remote.fileExt || local.fileExt || "epub"
                : local.fileExt || remote.fileExt || "epub";
    const resolvedCoverThumb = metaSource.coverThumb || local.coverThumb || remote.coverThumb;

    const merged: EpubSyncBookEntry = {
        bookKey: local.bookKey,
        title: local.title || remote.title,
        author: local.author || remote.author,
        series: metaSource.series ?? local.series ?? remote.series,
        seriesPosition: metaSource.seriesPosition ?? local.seriesPosition ?? remote.seriesPosition ?? null,
        tags: (metaSource.tags && metaSource.tags.length > 0) ? metaSource.tags : (local.tags?.length ? local.tags : remote.tags),
        shelves: metaSource.shelves !== undefined ? metaSource.shelves : (local.shelves?.length ? local.shelves : remote.shelves),
        manualStatus: metaSource.manualStatus ?? local.manualStatus ?? remote.manualStatus,
        coverBlurred: metaSource.coverBlurred ?? local.coverBlurred ?? remote.coverBlurred,
        language: local.language || remote.language,
        defaultVertical: local.defaultVertical ?? remote.defaultVertical,
        orientation: metaSource.orientation || local.orientation || remote.orientation,
        chapterIndex: posSource.chapterIndex,
        chapterOffset: posSource.chapterOffset,
        chapterCount: local.chapterCount || remote.chapterCount,
        totalChars: Math.max(local.totalChars || 0, remote.totalChars || 0) || undefined,
        progress: posSource.progress,
        lastOpenedAt: Math.max(local.lastOpenedAt || 0, remote.lastOpenedAt || 0),
        addedAt: Math.min(local.addedAt || Number.MAX_SAFE_INTEGER, remote.addedAt || Number.MAX_SAFE_INTEGER) === Number.MAX_SAFE_INTEGER
            ? undefined
            : Math.min(local.addedAt || Number.MAX_SAFE_INTEGER, remote.addedAt || Number.MAX_SAFE_INTEGER),
        updatedAt: Math.max(localPosTs, remotePosTs),
        readingPoint: mergedReadingPoint,
        bookmarks: mergedBookmarks,
        highlights: mergedHighlights,
        notes: mergedNotes,
        stats: mergedStats,
        driveFileId: resolvedDriveFileId,
        fileExt: resolvedFileExt,
        format: local.format || remote.format,
        hasMokuro: Boolean(local.hasMokuro || remote.hasMokuro),
        fileRevision: resolvedFileRevision,
        coverThumb: resolvedCoverThumb,
    };

    const sameEntry = (a: EpubSyncBookEntry, b: EpubSyncBookEntry) => (
        a.chapterIndex === b.chapterIndex
        && Math.abs((a.chapterOffset || 0) - (b.chapterOffset || 0)) < 0.0005
        && Math.abs((a.progress || 0) - (b.progress || 0)) < 0.0005
        && (a.lastOpenedAt || 0) === (b.lastOpenedAt || 0)
        && (a.series || "") === (b.series || "")
        && (a.seriesPosition ?? null) === (b.seriesPosition ?? null)
        && (a.manualStatus || "") === (b.manualStatus || "")
        && Boolean(a.coverBlurred) === Boolean(b.coverBlurred)
        && (a.driveFileId || "") === (b.driveFileId || "")
        && (a.fileExt || "") === (b.fileExt || "")
        && (a.format || "") === (b.format || "")
        && Boolean(a.hasMokuro) === Boolean(b.hasMokuro)
        && (a.fileRevision || 0) === (b.fileRevision || 0)
        && (a.coverThumb || "") === (b.coverThumb || "")
        && (a.bookmarks?.length || 0) === (b.bookmarks?.length || 0)
        && (a.highlights?.length || 0) === (b.highlights?.length || 0)
        && (a.notes?.length || 0) === (b.notes?.length || 0)
        && (a.readingPoint?.savedAt || 0) === (b.readingPoint?.savedAt || 0)
        && (a.stats?.chars || 0) === (b.stats?.chars || 0)
        && (a.stats?.time || 0) === (b.stats?.time || 0)
        && JSON.stringify(a.tags || []) === JSON.stringify(b.tags || [])
        && JSON.stringify(a.shelves || []) === JSON.stringify(b.shelves || [])
    );

    return {
        merged,
        localChanged: !sameEntry(local, merged),
        remoteChanged: !sameEntry(remote, merged),
    };
}

export function mergeManifestWithLocalTabs(
    allLocalTabs: readonly Tab[],
    remoteManifest: EpubSyncManifest | null | undefined,
    allocateTabId: () => number,
): {
    nextTabs: Tab[];
    localChanged: boolean;
    mergedManifest: EpubSyncManifest;
    remoteChanged: boolean;
} {
    const remoteBooks = remoteManifest?.books || {};
    const mergedBooks: Record<string, EpubSyncBookEntry> = {};
    const matchedKeys = new Set<string>();
    let localChanged = false;
    let remoteChanged = false;

    const nextTabs = allLocalTabs.map((tab) => {
        const localEntry = tabToSyncEntry(tab);
        if (!localEntry) return tab;

        matchedKeys.add(localEntry.bookKey);
        const remoteEntry = remoteBooks[localEntry.bookKey];
        if (!remoteEntry) {
            mergedBooks[localEntry.bookKey] = localEntry;
            remoteChanged = true;
            return tab;
        }

        const { merged, localChanged: lCh, remoteChanged: rCh } = mergeEpubBookEntries(localEntry, remoteEntry);
        mergedBooks[localEntry.bookKey] = merged;
        if (rCh) remoteChanged = true;
        if (!lCh) return tab;

        const remoteNewerFile =
            Boolean(merged.driveFileId)
            && (merged.fileRevision || 0) > (tab.epub?.fileRevision || 0)
            && merged.driveFileId !== tab.epub?.driveFileId;

        localChanged = true;
        return {
            ...tab,
            readerProgress: merged.progress,
            stats: merged.stats ? { ...tab.stats, ...merged.stats } : tab.stats,
            epub: {
                ...tab.epub!,
                series: merged.series,
                seriesPosition: merged.seriesPosition,
                tags: merged.tags,
                shelves: merged.shelves,
                manualStatus: merged.manualStatus,
                coverBlurred: merged.coverBlurred,
                orientation: merged.orientation,
                chapterIndex: merged.chapterIndex,
                chapterOffset: merged.chapterOffset,
                progress: merged.progress,
                lastOpenedAt: merged.lastOpenedAt,
                syncUpdatedAt: merged.updatedAt,
                readingPoint: merged.readingPoint,
                bookmarks: merged.bookmarks,
                highlights: merged.highlights,
                notes: merged.notes,
                driveFileId: merged.driveFileId,
                fileExt: merged.fileExt,
                format: merged.format ?? tab.epub!.format,
                hasMokuro: merged.hasMokuro ?? tab.epub!.hasMokuro,
                fileRevision: merged.fileRevision ?? tab.epub!.fileRevision,
                coverThumb: merged.coverThumb ?? tab.epub!.coverThumb,
                cloudOnly: remoteNewerFile ? true : tab.epub!.cloudOnly,
                totalChars: merged.totalChars ?? tab.epub!.totalChars,
                chapterCount: tab.epub!.chapterCount || merged.chapterCount,
            },
        };
    });

    // Add remote-only cloud books that have a Drive file available for 1-click download
    for (const [key, remoteEntry] of Object.entries(remoteBooks)) {
        if (matchedKeys.has(key)) continue;
        mergedBooks[key] = remoteEntry;
        if (!remoteEntry.driveFileId) continue;

        localChanged = true;
        const newId = allocateTabId();
        nextTabs.push({
            id: newId,
            name: remoteEntry.title,
            lines: [],
            stats: remoteEntry.stats || { chars: 0, words: 0, sentences: 0, time: 0 },
            status: "reading",
            speedSamples: [],
            mode: "epub",
            readerProgress: remoteEntry.progress || 0,
            epub: {
                title: remoteEntry.title,
                author: remoteEntry.author,
                series: remoteEntry.series,
                seriesPosition: remoteEntry.seriesPosition,
                tags: remoteEntry.tags,
                shelves: remoteEntry.shelves,
                manualStatus: remoteEntry.manualStatus,
                coverBlurred: remoteEntry.coverBlurred,
                language: remoteEntry.language,
                defaultVertical: remoteEntry.defaultVertical,
                orientation: remoteEntry.orientation,
                chapterIndex: remoteEntry.chapterIndex || 0,
                chapterOffset: remoteEntry.chapterOffset || 0,
                chapterCount: remoteEntry.chapterCount,
                totalChars: remoteEntry.totalChars,
                progress: remoteEntry.progress || 0,
                lastOpenedAt: remoteEntry.lastOpenedAt || 0,
                addedAt: remoteEntry.addedAt || Date.now(),
                syncUpdatedAt: remoteEntry.updatedAt,
                readingPoint: remoteEntry.readingPoint ?? null,
                bookmarks: remoteEntry.bookmarks || [],
                highlights: remoteEntry.highlights || [],
                notes: remoteEntry.notes || [],
                driveFileId: remoteEntry.driveFileId,
                fileExt: remoteEntry.fileExt || "epub",
                format:
                    remoteEntry.format
                    || (remoteEntry.fileExt === "cbz" || remoteEntry.fileExt === "zip" ? "manga" : undefined),
                hasMokuro: remoteEntry.hasMokuro,
                fileRevision: remoteEntry.fileRevision,
                coverThumb: remoteEntry.coverThumb,
                cloudOnly: true,
                lines: [],
            },
        });
    }

    return {
        nextTabs,
        localChanged,
        mergedManifest: {
            schemaVersion: EPUB_SYNC_SCHEMA_VERSION,
            updatedAt: Date.now(),
            books: mergedBooks,
        },
        remoteChanged,
    };
}

export function buildEpubSyncFingerprint(tabs: readonly Tab[]): string {
    const parts: string[] = [];
    for (const tab of tabs) {
        const e = tabToSyncEntry(tab);
        if (!e) continue;
        parts.push([
            e.bookKey,
            e.chapterIndex,
            Math.round((e.chapterOffset || 0) * 1000),
            Math.round((e.progress || 0) * 1000),
            e.lastOpenedAt || 0,
            e.series || "",
            e.seriesPosition ?? "",
            (e.tags || []).join(","),
            (e.shelves || []).join(","),
            e.manualStatus || "",
            e.coverBlurred ? 1 : 0,
            e.bookmarks?.length || 0,
            e.highlights?.length || 0,
            e.notes?.length || 0,
            e.readingPoint?.savedAt || 0,
            e.stats?.chars || 0,
            e.driveFileId || "",
            e.format || "",
            e.hasMokuro ? 1 : 0,
            e.fileRevision || 0,
            e.coverThumb ? e.coverThumb.length : 0,
        ].join("|"));
    }
    return parts.sort().join(";");
}
