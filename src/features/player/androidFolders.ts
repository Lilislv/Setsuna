import type { LibraryFolder } from "./libraryModel";

// Video library folders on Android. A folder is picked once through the system
// picker (Storage Access Framework); the app keeps read access across restarts.
// Episodes get virtual paths built from real names, so titles, episode labels,
// subtitle matching and saved progress work exactly like desktop paths:
//   android-folder://<encoded tree uri>/<folder name>/<sub/dirs>/<file name>
// Each path maps to the document's content:// URI, played through the app's
// local media server (MediaServer.kt) so seeking works without copying.

type Bridge = {
    selectVideoFolder: () => string;
    scanVideoFolder: (treeUri: string) => string;
    forgetVideoFolder: (treeUri: string) => string;
    videoFolders: () => string;
    mediaUrl: (documentUri: string) => string;
    readDocumentBase64: (documentUri: string) => string;
};

type ScanEntry = { name: string; uri: string; size: number };
type Scan = {
    name: string;
    truncated?: boolean;
    directories: { relative: string; episodes: ScanEntry[]; subtitles: ScanEntry[] }[];
};

export const ANDROID_FOLDER_PREFIX = "android-folder://";
export const FOLDER_PICKED_EVENT = "setsuna-mobile-video-folder";

const documents = new Map<string, string>();
const mediaUrls = new Map<string, string>();

const bridge = (): Bridge | null =>
    typeof window === "undefined" ? null : ((window as unknown as { SetsunaMobileFiles?: Bridge }).SetsunaMobileFiles ?? null);

const call = <T>(raw: string): T => {
    const value = JSON.parse(raw || "{}");
    if (!value.ok) throw new Error(value.error || "Android file access failed");
    return value.value as T;
};

export const hasAndroidFolders = () => Boolean(bridge()?.selectVideoFolder);
export const isAndroidFolderPath = (path: string) => path.startsWith(ANDROID_FOLDER_PREFIX);

const cleanName = (name: string) => name.replace(/[\\/]/g, "_").trim() || "Videos";

/** Library root for a picked tree: its name is the folder's own name. */
export const androidRoot = (treeUri: string, name: string) =>
    `${ANDROID_FOLDER_PREFIX}${encodeURIComponent(treeUri)}/${cleanName(name)}`;

export const treeUriOf = (root: string) => {
    const encoded = root.slice(ANDROID_FOLDER_PREFIX.length).split("/")[0] || "";
    try {
        return decodeURIComponent(encoded);
    } catch {
        return "";
    }
};

/** Builds the library folder for a scan result (pure: also used by tests). */
export function folderFromScan(root: string, scan: Scan, remember?: (path: string, uri: string) => void): LibraryFolder {
    const join = (...parts: string[]) => parts.filter(Boolean).join("/");
    return {
        path: root,
        directories: scan.directories.map((directory) => {
            const path = join(root, ...directory.relative.split("/").map(cleanName).filter(Boolean));
            return {
                path,
                episodes: directory.episodes.map((episode) => {
                    const episodePath = join(path, cleanName(episode.name));
                    remember?.(episodePath, episode.uri);
                    return { path: episodePath };
                }),
                subtitles: directory.subtitles.map((subtitle) => {
                    // "Subs/Ep01.ass" keeps its folder so matching sees the right name.
                    const subtitlePath = join(path, ...subtitle.name.split("/").map(cleanName));
                    remember?.(subtitlePath, subtitle.uri);
                    return subtitlePath;
                }),
            };
        }),
    };
}

/** Opens the system folder picker; resolves with the library root, or null if cancelled. */
export function chooseAndroidFolder(): Promise<string | null> {
    const native = bridge();
    if (!native) return Promise.resolve(null);
    return new Promise((resolve, reject) => {
        const onPicked = (event: Event) => {
            window.removeEventListener(FOLDER_PICKED_EVENT, onPicked);
            const treeUri = String((event as CustomEvent<string>).detail || "");
            if (!treeUri) {
                resolve(null);
                return;
            }
            try {
                const scan = call<Scan>(native.scanVideoFolder(treeUri));
                resolve(androidRoot(treeUri, scan.name));
            } catch (error) {
                reject(error);
            }
        };
        window.addEventListener(FOLDER_PICKED_EVENT, onPicked);
        try {
            call(native.selectVideoFolder());
        } catch (error) {
            window.removeEventListener(FOLDER_PICKED_EVENT, onPicked);
            reject(error);
        }
    });
}

/** Lists a saved root again (after a restart or "Refresh"). */
export async function scanAndroidFolder(root: string): Promise<LibraryFolder> {
    const native = bridge();
    if (!native) throw new Error("Folders are available in the Android app.");
    const treeUri = treeUriOf(root);
    // Let React paint "loading" before the (synchronous) native listing runs.
    await new Promise((resolve) => setTimeout(resolve, 0));
    let scan: Scan;
    try {
        scan = call<Scan>(native.scanVideoFolder(treeUri));
    } catch (error) {
        const granted = (() => {
            try {
                return call<string[]>(native.videoFolders());
            } catch {
                return [];
            }
        })();
        if (!granted.includes(treeUri)) {
            throw new Error("Setsuna lost access to this folder. Remove it and add it again.");
        }
        throw error;
    }
    return folderFromScan(root, scan, (path, uri) => documents.set(path, uri));
}

export function forgetAndroidFolder(root: string) {
    const native = bridge();
    if (!native) return;
    try {
        call(native.forgetVideoFolder(treeUriOf(root)));
    } catch {
        /* nothing to release */
    }
}

/** URL for <video>; empty until the folder has been scanned this session. */
export function androidMediaUrl(path: string): string {
    const cached = mediaUrls.get(path);
    if (cached) return cached;
    const native = bridge();
    const uri = documents.get(path);
    if (!native || !uri) return "";
    const url = call<string>(native.mediaUrl(uri));
    mediaUrls.set(path, url);
    return url;
}

export function readAndroidFileBytes(path: string): Uint8Array {
    const native = bridge();
    const uri = documents.get(path);
    if (!native || !uri) throw new Error("This file is not available any more. Refresh the library.");
    const base64 = call<string>(native.readDocumentBase64(uri));
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
}
