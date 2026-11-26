const STORAGE_KEY = "setsuna-epub-cover-thumbs-v1";
const MAX_CACHED_COVERS = 120;
const MAX_TOTAL_CHARS = 2_400_000;
const THUMB_MAX_W = 200;
const THUMB_MAX_H = 300;
const MAX_SYNC_THUMB_CHARS = 42_000;

interface StoredEntry {
    src: string;
    at: number;
}

const memoryCache = new Map<string, string | null>();
let diskMap: Record<string, StoredEntry> | null = null;
let saveTimer: number | null = null;

function loadDiskMap(): Record<string, StoredEntry> {
    if (diskMap) return diskMap;
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (raw) {
            const parsed = JSON.parse(raw);
            if (parsed && typeof parsed === "object") {
                diskMap = parsed as Record<string, StoredEntry>;
                for (const [path, entry] of Object.entries(diskMap)) {
                    if (entry && typeof entry.src === "string" && entry.src.startsWith("data:")) {
                        memoryCache.set(path, entry.src);
                    }
                }
                return diskMap;
            }
        }
    } catch {
        // Ignore storage errors
    }
    diskMap = {};
    return diskMap;
}

function schedulePersist(): void {
    if (saveTimer !== null) return;
    saveTimer = window.setTimeout(() => {
        saveTimer = null;
        if (!diskMap) return;
        const entries = Object.entries(diskMap).sort((a, b) => (b[1]?.at || 0) - (a[1]?.at || 0));
        const kept: Record<string, StoredEntry> = {};
        let totalChars = 0;
        let count = 0;
        for (const [k, v] of entries) {
            if (!v || typeof v.src !== "string") continue;
            if (count >= MAX_CACHED_COVERS || totalChars + v.src.length > MAX_TOTAL_CHARS) break;
            kept[k] = v;
            totalChars += v.src.length;
            count += 1;
        }
        diskMap = kept;
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(kept));
        } catch {
            // Trim aggressively if quota is tight
            const half = Object.fromEntries(Object.entries(kept).slice(0, Math.max(10, Math.floor(count / 2))));
            diskMap = half;
            try {
                localStorage.setItem(STORAGE_KEY, JSON.stringify(half));
            } catch {}
        }
    }, 120);
}

/**
 * Synchronously returns all cached cover thumbnails (from memory + localStorage)
 * so the library renders covers on frame 0 with zero placeholder flicker.
 */
export function getInitialCoverSnapshot(): Record<string, string | null> {
    loadDiskMap();
    const out: Record<string, string | null> = {};
    memoryCache.forEach((value, key) => {
        out[key] = value;
    });
    return out;
}

export function hasCachedCover(path: string): boolean {
    loadDiskMap();
    return memoryCache.has(path);
}

export function getCachedCover(path: string): string | null | undefined {
    loadDiskMap();
    return memoryCache.get(path);
}

export function setMemoryCover(path: string, src: string | null): void {
    loadDiskMap();
    memoryCache.set(path, src);
    if (!src) return;
    // If already compact, persist directly; otherwise downscale in browser GPU/Canvas (~3ms)
    if (src.length <= 45_000) {
        diskMap![path] = { src, at: Date.now() };
        schedulePersist();
        return;
    }
    void downscaleDataUrl(src).then((compact) => {
        if (!compact || memoryCache.get(path) !== src) return;
        memoryCache.set(path, compact);
        loadDiskMap()[path] = { src: compact, at: Date.now() };
        schedulePersist();
    });
}

export async function compactCoverDataUrl(src: string): Promise<string | null> {
    const clean = src.trim();
    if (!clean.startsWith("data:image/")) return null;
    if (clean.length <= MAX_SYNC_THUMB_CHARS) return clean;
    const downscaled = await downscaleDataUrl(clean);
    if (!downscaled || downscaled.length > MAX_SYNC_THUMB_CHARS) return null;
    return downscaled;
}

function downscaleDataUrl(dataUrl: string): Promise<string | null> {
    return new Promise((resolve) => {
        const img = new Image();
        img.onload = () => {
            try {
                let scale = Math.min(1, THUMB_MAX_W / img.width, THUMB_MAX_H / img.height);
                for (const quality of [0.74, 0.56, 0.4]) {
                    const w = Math.max(1, Math.round(img.width * scale));
                    const h = Math.max(1, Math.round(img.height * scale));
                    const canvas = document.createElement("canvas");
                    canvas.width = w;
                    canvas.height = h;
                    const ctx = canvas.getContext("2d");
                    if (!ctx) {
                        resolve(null);
                        return;
                    }
                    ctx.drawImage(img, 0, 0, w, h);
                    const out = canvas.toDataURL("image/jpeg", quality);
                    if (out.length <= MAX_SYNC_THUMB_CHARS) {
                        resolve(out);
                        return;
                    }
                    scale *= 0.8;
                }
                resolve(null);
            } catch {
                resolve(null);
            }
        };
        img.onerror = () => resolve(null);
        img.src = dataUrl;
    });
}
