import type { Tab, TabStats } from "../../utils/constants";
import type { DayRecord } from "../../utils/dailyStats";
import type { EpubSyncBookEntry } from "./epubSyncModel";
import type { EpubReadingGoals } from "./epubTracker";

export const EPUB_BACKUP_SCHEMA_VERSION = 1;

export interface EpubPortableBackup {
    schemaVersion: number;
    app: "Setsuna";
    exportedAt: number;
    books: EpubSyncBookEntry[];
    customShelves: string[];
    goals?: EpubReadingGoals;
    dailyStats?: Record<string, DayRecord>;
}

function normalizeBookKey(title: string): string {
    return title.normalize("NFKC").replace(/\s+/g, "").toLowerCase();
}

function mergeItemsById<T extends { id: string; createdAt?: number; updatedAt?: number }>(
    localList: readonly T[] | undefined,
    incomingList: readonly T[] | undefined,
): T[] {
    const map = new Map<string, T>();
    for (const item of localList || []) map.set(item.id, item);
    for (const item of incomingList || []) {
        const existing = map.get(item.id);
        if (!existing) {
            map.set(item.id, item);
        } else {
            const existingTs = existing.updatedAt ?? existing.createdAt ?? 0;
            const incomingTs = item.updatedAt ?? item.createdAt ?? 0;
            if (incomingTs >= existingTs) map.set(item.id, item);
        }
    }
    return Array.from(map.values()).sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
}

function unionStrings(a: readonly string[] | undefined, b: readonly string[] | undefined): string[] | undefined {
    const set = new Set<string>();
    for (const v of a || []) {
        const clean = v.trim();
        if (clean) set.add(clean);
    }
    for (const v of b || []) {
        const clean = v.trim();
        if (clean) set.add(clean);
    }
    return set.size > 0 ? Array.from(set) : undefined;
}

/**
 * Builds a path-independent portable JSON backup of the EPUB library:
 * progress, bookmarks, highlights, notes, reading points, custom shelves,
 * series/tags, daily goals, and reading stats.
 */
export function buildPortableEpubBackup(
    allTabs: readonly Tab[],
    customShelves: readonly string[],
    goals?: EpubReadingGoals,
    dailyStats?: Record<string, DayRecord>,
): EpubPortableBackup {
    const books: EpubSyncBookEntry[] = [];
    const shelfSet = new Set<string>(customShelves.map((s) => s.trim()).filter(Boolean));

    for (const tab of allTabs) {
        if (tab.mode !== "epub" || !tab.epub || tab.archived) continue;
        const title = (tab.epub.title || tab.name || "").trim();
        const bookKey = normalizeBookKey(title);
        if (!bookKey) continue;
        for (const s of tab.epub.shelves || []) {
            const clean = s.trim();
            if (clean) shelfSet.add(clean);
        }
        const updatedAt = Math.max(
            tab.epub.syncUpdatedAt || 0,
            tab.epub.lastOpenedAt || 0,
            tab.epub.readingPoint?.savedAt || 0,
        );
        books.push({
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
            fileExt: tab.epub.fileExt,
        });
    }

    return {
        schemaVersion: EPUB_BACKUP_SCHEMA_VERSION,
        app: "Setsuna",
        exportedAt: Date.now(),
        books,
        customShelves: Array.from(shelfSet),
        goals,
        dailyStats,
    };
}

export function parsePortableEpubBackup(rawJson: string): EpubPortableBackup {
    let parsed: unknown;
    try {
        parsed = JSON.parse(rawJson);
    } catch {
        throw new Error("Invalid JSON file");
    }
    if (!parsed || typeof parsed !== "object") {
        throw new Error("Backup payload must be a JSON object");
    }
    const obj = parsed as Record<string, unknown>;
    if (obj.schemaVersion !== EPUB_BACKUP_SCHEMA_VERSION || !Array.isArray(obj.books)) {
        throw new Error("Unsupported Setsuna EPUB backup format");
    }

    const books: EpubSyncBookEntry[] = [];
    for (const item of obj.books) {
        if (!item || typeof item !== "object") continue;
        const rec = item as Record<string, unknown>;
        const title = typeof rec.title === "string" ? rec.title.trim() : "";
        const bookKey = typeof rec.bookKey === "string" && rec.bookKey.trim()
            ? rec.bookKey.trim()
            : normalizeBookKey(title);
        if (!title || !bookKey) continue;
        books.push({
            ...(rec as unknown as EpubSyncBookEntry),
            bookKey,
            title,
            chapterIndex: Math.max(0, Number(rec.chapterIndex) || 0),
            chapterOffset: Math.min(1, Math.max(0, Number(rec.chapterOffset) || 0)),
            progress: Math.min(1, Math.max(0, Number(rec.progress) || 0)),
            lastOpenedAt: Math.max(0, Number(rec.lastOpenedAt) || 0),
            updatedAt: Math.max(0, Number(rec.updatedAt) || 0),
        });
    }

    const customShelves = Array.isArray(obj.customShelves)
        ? Array.from(
              new Set(
                  obj.customShelves
                      .filter((s): s is string => typeof s === "string")
                      .map((s) => s.trim())
                      .filter(Boolean),
              ),
          )
        : [];

    return {
        schemaVersion: EPUB_BACKUP_SCHEMA_VERSION,
        app: "Setsuna",
        exportedAt: Number(obj.exportedAt) || Date.now(),
        books,
        customShelves,
        goals: obj.goals && typeof obj.goals === "object" ? (obj.goals as EpubReadingGoals) : undefined,
        dailyStats: obj.dailyStats && typeof obj.dailyStats === "object"
            ? (obj.dailyStats as Record<string, DayRecord>)
            : undefined,
    };
}

export function mergePortableEpubBackup(
    allLocalTabs: readonly Tab[],
    backup: EpubPortableBackup,
): {
    nextTabs: Tab[];
    updatedBooks: number;
    unmatchedEntries: EpubSyncBookEntry[];
    mergedShelves: string[];
} {
    const byKey = new Map<string, EpubSyncBookEntry>();
    for (const entry of backup.books) {
        byKey.set(entry.bookKey, entry);
    }

    const matchedKeys = new Set<string>();
    let updatedBooks = 0;

    const nextTabs = allLocalTabs.map((tab) => {
        if (tab.mode !== "epub" || !tab.epub || tab.archived) return tab;
        const key = normalizeBookKey(tab.epub.title || tab.name || "");
        const incoming = byKey.get(key);
        if (!incoming) return tab;

        matchedKeys.add(key);
        updatedBooks += 1;

        const localTs = Math.max(tab.epub.syncUpdatedAt || 0, tab.epub.lastOpenedAt || 0);
        const incomingTs = Math.max(incoming.updatedAt || 0, incoming.lastOpenedAt || 0);
        const incomingWinsPos = incomingTs > localTs
            || (incomingTs === localTs && incoming.progress > (tab.epub.progress || 0));

        const nextStats: TabStats = {
            chars: Math.max(tab.stats?.chars || 0, incoming.stats?.chars || 0),
            words: Math.max(tab.stats?.words || 0, incoming.stats?.words || 0),
            sentences: Math.max(tab.stats?.sentences || 0, incoming.stats?.sentences || 0),
            time: Math.max(tab.stats?.time || 0, incoming.stats?.time || 0),
        };

        const mergedReadingPoint = (() => {
            const lp = tab.epub.readingPoint;
            const rp = incoming.readingPoint;
            if (!lp) return rp ?? null;
            if (!rp) return lp;
            return (rp.savedAt || 0) >= (lp.savedAt || 0) ? rp : lp;
        })();

        const nextProgress = incomingWinsPos ? incoming.progress : (tab.epub.progress || 0);

        return {
            ...tab,
            readerProgress: nextProgress,
            stats: nextStats,
            epub: {
                ...tab.epub,
                series: tab.epub.series || incoming.series,
                seriesPosition: tab.epub.seriesPosition ?? incoming.seriesPosition ?? null,
                tags: unionStrings(tab.epub.tags, incoming.tags),
                shelves: unionStrings(tab.epub.shelves, incoming.shelves),
                manualStatus: incomingWinsPos
                    ? (incoming.manualStatus ?? tab.epub.manualStatus)
                    : (tab.epub.manualStatus ?? incoming.manualStatus),
                coverBlurred: tab.epub.coverBlurred ?? incoming.coverBlurred,
                orientation: tab.epub.orientation || incoming.orientation,
                chapterIndex: incomingWinsPos ? incoming.chapterIndex : (tab.epub.chapterIndex || 0),
                chapterOffset: incomingWinsPos ? incoming.chapterOffset : (tab.epub.chapterOffset || 0),
                progress: nextProgress,
                lastOpenedAt: Math.max(tab.epub.lastOpenedAt || 0, incoming.lastOpenedAt || 0),
                syncUpdatedAt: Math.max(localTs, incomingTs, Date.now()),
                readingPoint: mergedReadingPoint,
                bookmarks: mergeItemsById(tab.epub.bookmarks, incoming.bookmarks),
                highlights: mergeItemsById(tab.epub.highlights, incoming.highlights),
                notes: mergeItemsById(tab.epub.notes, incoming.notes),
            },
        };
    });

    const unmatchedEntries = backup.books.filter((e) => !matchedKeys.has(e.bookKey));
    const shelfSet = new Set<string>(backup.customShelves);
    for (const entry of backup.books) {
        for (const s of entry.shelves || []) {
            if (s.trim()) shelfSet.add(s.trim());
        }
    }

    return {
        nextTabs,
        updatedBooks,
        unmatchedEntries,
        mergedShelves: Array.from(shelfSet),
    };
}
