import { useCallback, useEffect, useRef, useState } from "react";
import type { Tab } from "../../utils/constants";
import {
    createAppDataFileMetadata,
    deleteDriveFile,
    downloadAppDataJson,
    getAccessToken,
    loadStoredGoogleRefreshToken,
    uploadAppDataJson,
} from "../../utils/gdrive";
import { downloadEpubFromDrive, loadEpubCover, openEpubBook, uploadEpubToDrive } from "./epubApi";
import { loadMangaCover, openMangaVolume } from "../manga/mangaApi";
import { isMangaTabData } from "../manga/mangaModel";
import { compactCoverDataUrl, getCachedCover, setMemoryCover } from "./epubCoverCache";
import { fetchDriveBookCover } from "./driveCover";
import {
    buildEpubSyncFingerprint,
    emptySyncManifest,
    EPUB_SYNC_FILENAME,
    inferFileExtFromPath,
    mergeManifestWithLocalTabs,
    tabToSyncEntry,
    type EpubSyncManifest,
} from "./epubSyncModel";

export type EpubSyncStatus = "idle" | "syncing" | "synced" | "disconnected" | "error";

export interface UseEpubSyncOptions {
    enabled: boolean;
    uploadFiles: boolean;
    activeInEpub: boolean;
    fallbackRefreshToken?: string;
    tabs: Tab[];
    tabsRef: React.MutableRefObject<Tab[]>;
    setTabs: React.Dispatch<React.SetStateAction<Tab[]>>;
    allocateTabId: () => number;
}

export interface EpubSyncController {
    status: EpubSyncStatus;
    lastSyncedAt: number | null;
    error: string | null;
    downloadingBookId: number | null;
    syncNow: (options?: { silent?: boolean; forcePush?: boolean }) => Promise<void>;
    downloadCloudBook: (tab: Tab) => Promise<boolean>;
}

const TOKEN_TTL_MS = 45 * 60 * 1000;
const FOCUS_THROTTLE_MS = 20_000;
const AUTO_PUSH_DEBOUNCE_MS = 5_000;
const PERIODIC_SYNC_MS = 180_000;

let cachedToken: { refreshToken: string; token: Promise<string>; expiresAt: number } | null = null;

async function getValidAccessToken(fallbackRefreshToken?: string): Promise<string | null> {
    const now = Date.now();
    const stored = await loadStoredGoogleRefreshToken().catch(() => null);
    const refreshToken = (stored && stored.trim()) ? stored.trim() : (fallbackRefreshToken?.trim() || '');
    if (!refreshToken) {
        cachedToken = null;
        return null;
    }
    if (cachedToken?.refreshToken === refreshToken && now < cachedToken.expiresAt) return cachedToken.token;
    const token = getAccessToken(refreshToken);
    cachedToken = { refreshToken, token, expiresAt: now + TOKEN_TTL_MS };
    try {
        return await token;
    } catch (error) {
        if (cachedToken?.token === token) cachedToken = null;
        throw error;
    }
}

export function useEpubSync({
    enabled,
    uploadFiles,
    activeInEpub,
    fallbackRefreshToken,
    tabs,
    tabsRef,
    setTabs,
    allocateTabId,
}: UseEpubSyncOptions): EpubSyncController {
    const [status, setStatus] = useState<EpubSyncStatus>("idle");
    const [lastSyncedAt, setLastSyncedAt] = useState<number | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [downloadingBookId, setDownloadingBookId] = useState<number | null>(null);

    const syncingRef = useRef(false);
    const uploadingRef = useRef(false);
    const failedUploadsRef = useRef(new Map<string, number>());
    const failedCloudCoversRef = useRef(new Map<string, number>());
    const pendingDownloadsRef = useRef(new Map<number, Promise<boolean>>());
    const latestDownloadRef = useRef<number | null>(null);
    const queuedPushRef = useRef(false);
    const enabledRef = useRef(enabled);
    enabledRef.current = enabled;
    const lastPullAtRef = useRef(0);
    const lastSyncedFingerprintRef = useRef<string>("");
    const debounceTimerRef = useRef<number | null>(null);
    const allocateTabIdRef = useRef(allocateTabId);
    allocateTabIdRef.current = allocateTabId;
    const uploadFilesRef = useRef(uploadFiles);
    uploadFilesRef.current = uploadFiles;
    const fallbackRefreshTokenRef = useRef(fallbackRefreshToken);
    fallbackRefreshTokenRef.current = fallbackRefreshToken;

    const runBackgroundWork = useCallback(async (snapshot: Tab[], account: string | undefined) => {
        if (uploadingRef.current) return;
        uploadingRef.current = true;
        try {
            // Older libraries may have only a disk thumbnail or an embedded cover.
            // Read these after metadata is visible. A failed/no-cover book cannot starve later books.
            for (const tab of snapshot) {
                if (!enabledRef.current) return;
                const path = tab.epub?.path;
                if (!path || tab.mode !== "epub" || tab.archived || tab.epub?.cloudOnly || tab.epub?.coverThumb) continue;
                let cover = getCachedCover(path);
                if (cover === undefined) {
                    try {
                        cover = isMangaTabData(tab.epub) ? await loadMangaCover(path) : await loadEpubCover(path);
                    } catch {
                        continue;
                    }
                    if (getCachedCover(path) === undefined) setMemoryCover(path, cover);
                }
                if (!cover) continue;
                const thumb = await compactCoverDataUrl(cover).catch(() => null);
                if (thumb && enabledRef.current) {
                    setTabs((prev) => prev.map((t) => t.id === tab.id && t.epub?.path === path && !t.epub.coverThumb
                        ? { ...t, epub: { ...t.epub, coverThumb: thumb } } : t));
                }
            }

            // Cloud-only books whose uploader never sent a thumbnail (older builds):
            // read the cover from the Drive file with range requests, then publish it.
            for (const tab of snapshot) {
                if (!enabledRef.current) return;
                const fileId = tab.epub?.driveFileId;
                if (!fileId || tab.mode !== "epub" || tab.archived || !tab.epub?.cloudOnly || tab.epub.coverThumb) continue;
                const ext = (tab.epub.fileExt || "").toLowerCase();
                const kind = isMangaTabData(tab.epub) || ext === "cbz" || ext === "zip" ? "manga" : ext === "epub" ? "epub" : null;
                if (!kind || (failedCloudCoversRef.current.get(fileId) || 0) > Date.now()) continue;
                const token = await getValidAccessToken(fallbackRefreshTokenRef.current);
                if (!token || cachedToken?.refreshToken !== account || !enabledRef.current) return;
                let thumb: string | null = null;
                try {
                    thumb = await fetchDriveBookCover(token, fileId, kind);
                } catch {
                    thumb = null;
                }
                if (!thumb) {
                    failedCloudCoversRef.current.set(fileId, Date.now() + 6 * 60 * 60 * 1000);
                    continue;
                }
                setTabs((prev) => prev.map((t) => t.id === tab.id && t.epub?.driveFileId === fileId && !t.epub.coverThumb
                    ? { ...t, epub: { ...t.epub, coverThumb: thumb } } : t));
            }

            for (const tab of snapshot) {
                if (!enabledRef.current || !uploadFilesRef.current) return;
                const path = tab.epub?.path;
                if (!path || tab.epub?.cloudOnly || tab.epub?.driveFileId || tab.epub?.fileExt === "manga-dir"
                    || !/\.[a-z0-9]{2,8}$/i.test(path)) continue;
                const entry = tabToSyncEntry(tab);
                if (!entry) continue;
                const revision = tab.epub?.fileRevision || 0;
                const key = JSON.stringify([tab.id, path, revision]);
                if ((failedUploadsRef.current.get(key) || 0) > Date.now()) continue;
                const stillPending = (t: Tab) => t.id === tab.id && !t.archived && t.epub?.path === path
                    && !t.epub.cloudOnly && !t.epub.driveFileId && (t.epub.fileRevision || 0) === revision;
                if (!tabsRef.current.some(stillPending)) continue;
                const ext = inferFileExtFromPath(path);
                const token = await getValidAccessToken(fallbackRefreshTokenRef.current);
                if (!token || cachedToken?.refreshToken !== account || !uploadFilesRef.current || !enabledRef.current) return;
                let newFileId: string | undefined;
                try {
                    newFileId = await createAppDataFileMetadata(token, `setsuna_epub_${entry.bookKey.slice(0, 48)}.${ext}`, {
                        setsunaType: "epub-book",
                        bookKey: entry.bookKey.slice(0, 100),
                    });
                    await uploadEpubToDrive(token, path, newFileId);
                } catch (error) {
                    if (newFileId) await deleteDriveFile(token, newFileId).catch(() => {});
                    const permanent = /exceeds 250 MB|file is empty/i.test(String(error));
                    failedUploadsRef.current.set(key, permanent ? Infinity : Date.now() + PERIODIC_SYNC_MS);
                    continue;
                }
                if (!tabsRef.current.some(stillPending)) {
                    await deleteDriveFile(token, newFileId).catch(() => {});
                    continue;
                }
                // Publish the new ID through the normal serialized manifest sync.
                setTabs((prev) => prev.map((t) => stillPending(t) && t.epub
                    ? { ...t, epub: { ...t.epub, driveFileId: newFileId, fileExt: ext } } : t));
            }
        } catch (error) {
            setError(error instanceof Error ? error.message : String(error));
        } finally {
            uploadingRef.current = false;
        }
    }, [setTabs, tabsRef]);

    const syncNow = useCallback(async (opts?: { silent?: boolean; forcePush?: boolean }): Promise<void> => {
        if (!enabled) return;
        if (syncingRef.current) {
            if (opts?.forcePush) queuedPushRef.current = true;
            return;
        }
        if (opts?.forcePush && !opts.silent) failedUploadsRef.current.clear();
        syncingRef.current = true;
        if (!opts?.silent) {
            setStatus("syncing");
            setError(null);
        }

        try {
            let accessToken = await getValidAccessToken(fallbackRefreshTokenRef.current);
            if (!accessToken) {
                setStatus("disconnected");
                return;
            }
            let remote: EpubSyncManifest;
            try {
                remote = await downloadAppDataJson(accessToken, EPUB_SYNC_FILENAME, emptySyncManifest());
            } catch (error) {
                if (!(error instanceof Error && "status" in error && error.status === 401)) throw error;
                cachedToken = null;
                accessToken = await getValidAccessToken(fallbackRefreshTokenRef.current);
                if (!accessToken) {
                    setStatus("disconnected");
                    return;
                }
                remote = await downloadAppDataJson(accessToken, EPUB_SYNC_FILENAME, emptySyncManifest());
            }

            const currentTabs = tabsRef.current;
            const merged = mergeManifestWithLocalTabs(currentTabs, remote, () => allocateTabIdRef.current());
            const workingTabs = merged.nextTabs;
            const workingManifest = merged.mergedManifest;
            if (merged.localChanged) {
                setTabs((prev) => prev === currentTabs ? workingTabs
                    : mergeManifestWithLocalTabs(prev, remote, () => allocateTabIdRef.current()).nextTabs);
            }

            if ((merged.remoteChanged || opts?.forcePush) && Object.keys(workingManifest.books).length > 0) {
                // Keep a previously downloadable revision available until its replacement is fully uploaded.
                for (const [key, entry] of Object.entries(workingManifest.books)) {
                    const previous = remote.books?.[key];
                    if (!entry.driveFileId && previous?.driveFileId && (entry.fileRevision || 0) > (previous.fileRevision || 0)) {
                        workingManifest.books[key] = { ...entry, driveFileId: previous.driveFileId,
                            fileRevision: previous.fileRevision, fileExt: previous.fileExt, hasMokuro: previous.hasMokuro };
                    }
                }
                await uploadAppDataJson(accessToken, EPUB_SYNC_FILENAME, workingManifest);
            }

            lastSyncedFingerprintRef.current = buildEpubSyncFingerprint(workingTabs);
            lastPullAtRef.current = Date.now();
            setLastSyncedAt(Date.now());
            setStatus("synced");
            setError(null);

            void runBackgroundWork(workingTabs, cachedToken?.refreshToken);
        } catch (err: any) {
            setStatus("error");
            setError(err?.message || String(err));
        } finally {
            syncingRef.current = false;
            if (queuedPushRef.current && enabledRef.current) {
                queuedPushRef.current = false;
                void syncNow({ silent: true, forcePush: true });
            }
        }
    }, [enabled, tabsRef, setTabs, runBackgroundWork]);

    const downloadBook = useCallback(async (tab: Tab): Promise<boolean> => {
        if (!tab.epub?.driveFileId) return false;
        setError(null);
        try {
            const accessToken = await getValidAccessToken(fallbackRefreshTokenRef.current);
            if (!accessToken) {
                setStatus("disconnected");
                return false;
            }
            const ext = tab.epub.fileExt || (tab.epub.format === "manga" ? "cbz" : "epub");
            const isManga = isMangaTabData(tab.epub) || ext === "cbz" || ext === "zip";
            const matchesDownload = (t: Tab) => t.id === tab.id && !t.archived && t.epub?.cloudOnly
                && t.epub.driveFileId === tab.epub?.driveFileId && t.epub.fileRevision === tab.epub?.fileRevision;
            const storedPath = await downloadEpubFromDrive(accessToken, tab.epub.driveFileId, tab.id, ext);
            if (isManga) {
                const meta = await openMangaVolume(storedPath);
                if (!tabsRef.current.some(matchesDownload)) return false;
                const coverToCache = tab.epub.coverThumb || meta.cover || null;
                if (coverToCache) {
                    setMemoryCover(storedPath, coverToCache);
                }
                setTabs((prev) => prev.map((t) => (
                    matchesDownload(t) && t.epub
                        ? {
                              ...t,
                              name: t.epub.title || meta.title || t.name,
                              epub: {
                                  ...t.epub,
                                  path: storedPath,
                                  cloudOnly: false,
                                  format: "manga",
                                  fileExt: ext === "zip" ? "zip" : "cbz",
                                  hasMokuro: meta.hasMokuro,
                                  chapterCount: meta.pageCount,
                                  totalChars: meta.totalChars || t.epub.totalChars,
                                  series: t.epub.series || meta.series || undefined,
                                  seriesPosition: t.epub.seriesPosition ?? meta.seriesPosition ?? null,
                              },
                          }
                        : t
                )));
                return true;
            }
            const meta = await openEpubBook(storedPath);
            if (!tabsRef.current.some(matchesDownload)) return false;
            const coverToCache = tab.epub.coverThumb || meta.cover;
            if (coverToCache) setMemoryCover(storedPath, coverToCache);
            setTabs((prev) => prev.map((t) => (
                matchesDownload(t) && t.epub
                    ? {
                          ...t,
                          name: meta.title || t.name,
                          epub: {
                              ...t.epub,
                              path: storedPath,
                              cloudOnly: false,
                              language: meta.language,
                              defaultVertical: meta.defaultVertical,
                              chapterCount: meta.chapters.length,
                              totalChars: meta.totalChars ?? t.epub.totalChars,
                              author: t.epub.author || meta.author || undefined,
                              series: t.epub.series || meta.series || undefined,
                              seriesPosition: t.epub.seriesPosition ?? meta.seriesPosition ?? null,
                          },
                      }
                    : t
            )));
            return true;
        } catch (err: any) {
            if (latestDownloadRef.current === tab.id) setError(err?.message || String(err));
            return false;
        }
    }, [setTabs, tabsRef]);

    const downloadCloudBook = useCallback((tab: Tab): Promise<boolean> => {
        latestDownloadRef.current = tab.id;
        setDownloadingBookId(tab.id);
        let pending = pendingDownloadsRef.current.get(tab.id);
        if (!pending) {
            pending = downloadBook(tab).finally(() => {
                pendingDownloadsRef.current.delete(tab.id);
                if (latestDownloadRef.current === tab.id) setDownloadingBookId(null);
            });
            pendingDownloadsRef.current.set(tab.id, pending);
        }
        return pending;
    }, [downloadBook]);

    // Auto-pull whenever user enters EPUB workspace or connects Google Drive
    useEffect(() => {
        if (!enabled || !activeInEpub) return;
        void syncNow({ silent: false });
    }, [enabled, activeInEpub, fallbackRefreshToken, syncNow]);

    // Auto-pull on window focus / visibility regain & flush on hide
    useEffect(() => {
        if (!enabled) return;
        const onVisible = () => {
            if (document.visibilityState === "hidden") {
                const currentFp = buildEpubSyncFingerprint(tabsRef.current);
                if (currentFp && currentFp !== lastSyncedFingerprintRef.current) {
                    void syncNow({ silent: true, forcePush: true });
                }
                return;
            }
            if (!activeInEpub) return;
            if (Date.now() - lastPullAtRef.current < FOCUS_THROTTLE_MS) return;
            void syncNow({ silent: true });
        };
        const onFocus = () => {
            if (!activeInEpub) return;
            if (Date.now() - lastPullAtRef.current < FOCUS_THROTTLE_MS) return;
            void syncNow({ silent: true });
        };
        document.addEventListener("visibilitychange", onVisible);
        window.addEventListener("focus", onFocus);
        return () => {
            document.removeEventListener("visibilitychange", onVisible);
            window.removeEventListener("focus", onFocus);
        };
    }, [enabled, activeInEpub, tabsRef, syncNow]);

    // Periodic background sync while reading
    useEffect(() => {
        if (!enabled || !activeInEpub) return;
        const interval = window.setInterval(() => {
            if (!document.hidden) {
                void syncNow({ silent: true });
            }
        }, PERIODIC_SYNC_MS);
        return () => window.clearInterval(interval);
    }, [enabled, activeInEpub, syncNow]);

    // Debounced auto-push whenever local EPUB state changes (page turn, bookmark, highlight, note, metadata)
    const epubFingerprint = buildEpubSyncFingerprint(tabs);
    useEffect(() => {
        if (!enabled || !epubFingerprint) return;
        if (!lastSyncedFingerprintRef.current) {
            lastSyncedFingerprintRef.current = epubFingerprint;
            return;
        }
        if (epubFingerprint === lastSyncedFingerprintRef.current) return;

        if (debounceTimerRef.current !== null) {
            window.clearTimeout(debounceTimerRef.current);
        }
        debounceTimerRef.current = window.setTimeout(() => {
            debounceTimerRef.current = null;
            void syncNow({ silent: true, forcePush: true });
        }, AUTO_PUSH_DEBOUNCE_MS);

        return () => {
            if (debounceTimerRef.current !== null) {
                window.clearTimeout(debounceTimerRef.current);
                debounceTimerRef.current = null;
            }
        };
    }, [enabled, epubFingerprint, syncNow]);

    return {
        status,
        lastSyncedAt,
        error,
        downloadingBookId,
        syncNow,
        downloadCloudBook,
    };
}
