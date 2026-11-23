import { useCallback, useEffect, useRef, useState } from "react";
import type { Tab } from "../../utils/constants";
import {
    createAppDataFileMetadata,
    downloadAppDataJson,
    getAccessToken,
    loadStoredGoogleRefreshToken,
    uploadAppDataJson,
} from "../../utils/gdrive";
import { downloadEpubFromDrive, openEpubBook, uploadEpubToDrive } from "./epubApi";
import { setMemoryCover } from "./epubCoverCache";
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

let cachedToken: { value: string; expiresAt: number } | null = null;

async function getValidAccessToken(): Promise<string | null> {
    const now = Date.now();
    if (cachedToken && now < cachedToken.expiresAt) {
        return cachedToken.value;
    }
    const refreshToken = await loadStoredGoogleRefreshToken().catch(() => null);
    if (!refreshToken || !refreshToken.trim()) {
        cachedToken = null;
        return null;
    }
    const token = await getAccessToken(refreshToken);
    cachedToken = { value: token, expiresAt: now + TOKEN_TTL_MS };
    return token;
}

export function useEpubSync({
    enabled,
    uploadFiles,
    activeInEpub,
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
    const lastPullAtRef = useRef(0);
    const lastSyncedFingerprintRef = useRef<string>("");
    const debounceTimerRef = useRef<number | null>(null);
    const allocateTabIdRef = useRef(allocateTabId);
    allocateTabIdRef.current = allocateTabId;
    const uploadFilesRef = useRef(uploadFiles);
    uploadFilesRef.current = uploadFiles;

    const syncNow = useCallback(async (opts?: { silent?: boolean; forcePush?: boolean }) => {
        if (!enabled || syncingRef.current) return;
        syncingRef.current = true;
        if (!opts?.silent) {
            setStatus("syncing");
            setError(null);
        }

        try {
            let accessToken: string | null;
            try {
                accessToken = await getValidAccessToken();
            } catch {
                // Retry once by clearing cached token
                cachedToken = null;
                accessToken = await getValidAccessToken();
            }
            if (!accessToken) {
                setStatus("disconnected");
                return;
            }

            // 1. Pull latest remote manifest and merge cleanly with local EPUB tabs
            const remote = await downloadAppDataJson<EpubSyncManifest>(
                accessToken,
                EPUB_SYNC_FILENAME,
                emptySyncManifest(),
            );

            const currentTabs = tabsRef.current;
            const merged = mergeManifestWithLocalTabs(currentTabs, remote, () => allocateTabIdRef.current());
            let workingTabs = merged.nextTabs;
            let workingManifest = merged.mergedManifest;
            let needManifestUpload = merged.remoteChanged || Boolean(opts?.forcePush);

            if (merged.localChanged) {
                setTabs(workingTabs);
            }

            // 2. Optionally upload local book files that aren't in Drive AppData yet (max 2 per cycle)
            if (uploadFilesRef.current) {
                let uploadedCount = 0;
                for (let i = 0; i < workingTabs.length && uploadedCount < 2; i++) {
                    const tab = workingTabs[i];
                    if (tab.mode !== "epub" || tab.archived || !tab.epub?.path || tab.epub.cloudOnly || tab.epub.driveFileId) {
                        continue;
                    }
                    const entry = tabToSyncEntry(tab);
                    if (!entry) continue;
                    const ext = inferFileExtFromPath(tab.epub.path);
                    const fileName = `setsuna_epub_${entry.bookKey.slice(0, 48)}.${ext}`;
                    try {
                        const driveFileId = await createAppDataFileMetadata(accessToken, fileName, {
                            setsunaType: "epub-book",
                            bookKey: entry.bookKey.slice(0, 100),
                        });
                        await uploadEpubToDrive(accessToken, tab.epub.path, driveFileId);
                        uploadedCount += 1;
                        needManifestUpload = true;

                        // Update both local tab and manifest entry with driveFileId
                        workingManifest = {
                            ...workingManifest,
                            books: {
                                ...workingManifest.books,
                                [entry.bookKey]: {
                                    ...workingManifest.books[entry.bookKey],
                                    driveFileId,
                                    fileExt: ext,
                                },
                            },
                        };
                        const updatedId = tab.id;
                        workingTabs = workingTabs.map((t) => (
                            t.id === updatedId && t.epub
                                ? { ...t, epub: { ...t.epub, driveFileId, fileExt: ext } }
                                : t
                        ));
                        setTabs((prev) => prev.map((t) => (
                            t.id === updatedId && t.epub
                                ? { ...t, epub: { ...t.epub, driveFileId, fileExt: ext } }
                                : t
                        )));
                    } catch {
                        // Skip oversized or unreadable files without blocking position sync
                    }
                }
            }

            // 3. Push merged manifest when anything changed locally or new files uploaded
            if (needManifestUpload && Object.keys(workingManifest.books).length > 0) {
                workingManifest = { ...workingManifest, updatedAt: Date.now() };
                await uploadAppDataJson(accessToken, EPUB_SYNC_FILENAME, workingManifest);
            }

            lastSyncedFingerprintRef.current = buildEpubSyncFingerprint(workingTabs);
            lastPullAtRef.current = Date.now();
            setLastSyncedAt(Date.now());
            setStatus("synced");
            setError(null);
        } catch (err: any) {
            setStatus("error");
            setError(err?.message || String(err));
        } finally {
            syncingRef.current = false;
        }
    }, [enabled, tabsRef, setTabs]);

    const downloadCloudBook = useCallback(async (tab: Tab): Promise<boolean> => {
        if (!tab.epub?.driveFileId) return false;
        setDownloadingBookId(tab.id);
        setError(null);
        try {
            const accessToken = await getValidAccessToken();
            if (!accessToken) {
                setStatus("disconnected");
                return false;
            }
            const ext = tab.epub.fileExt || "epub";
            const storedPath = await downloadEpubFromDrive(accessToken, tab.epub.driveFileId, tab.id, ext);
            const meta = await openEpubBook(storedPath);
            if (meta.cover) {
                setMemoryCover(storedPath, meta.cover);
            }
            setTabs((prev) => prev.map((t) => (
                t.id === tab.id && t.epub
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
            setError(err?.message || String(err));
            return false;
        } finally {
            setDownloadingBookId(null);
        }
    }, [setTabs]);

    // Auto-pull whenever user enters EPUB workspace
    useEffect(() => {
        if (!enabled || !activeInEpub) return;
        void syncNow({ silent: false });
    }, [enabled, activeInEpub, syncNow]);

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
