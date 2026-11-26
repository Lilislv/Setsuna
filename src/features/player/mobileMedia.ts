// Android has no file paths for media picked through <input type="file">. Each picked
// file gets a virtual path that keeps its real name (so episode labels, title cleanup
// and subtitle matching work exactly like on desktop) and resolves to a blob URL.

export const MOBILE_MEDIA_PREFIX = "mobile-file://";

const files = new Map<string, File>();
const urls = new Map<string, string>();
let counter = 0;

export const isMobileMediaPath = (path: string) => path.startsWith(MOBILE_MEDIA_PREFIX);

export function registerMobileFiles(list: Iterable<File>): string[] {
    const paths: string[] = [];
    for (const file of list) {
        const path = `${MOBILE_MEDIA_PREFIX}${++counter}/${file.name.replace(/[\\/]/g, "_")}`;
        files.set(path, file);
        paths.push(path);
    }
    return paths;
}

export const mobileFileFor = (path: string) => files.get(path);

export function mobileMediaUrl(path: string): string {
    let url = urls.get(path);
    const file = files.get(path);
    if (!url && file) {
        url = URL.createObjectURL(file);
        urls.set(path, url);
    }
    return url || "";
}

/** Same key the player already used for picked files, so saved positions carry over. */
export function mobileProgressKey(path: string): string | undefined {
    const file = files.get(path);
    return file && "mobile-file:" + JSON.stringify([file.name, file.size, file.lastModified]);
}

export interface RecentMobileMedia {
    key: string;
    name: string;
    time: number;
    duration: number;
    completed: boolean;
    lastPlayedAt: number;
}

/** Recently watched picked files, newest first (from the player's progress store). */
export function recentMobileMedia(progress: Record<string, unknown>, limit = 12): RecentMobileMedia[] {
    const out: RecentMobileMedia[] = [];
    for (const [key, raw] of Object.entries(progress)) {
        if (!key.startsWith("mobile-file:") || !raw || typeof raw !== "object") continue;
        let name = "";
        try {
            const parsed = JSON.parse(key.slice("mobile-file:".length));
            name = Array.isArray(parsed) && typeof parsed[0] === "string" ? parsed[0] : "";
        } catch {
            continue;
        }
        const item = raw as Partial<RecentMobileMedia>;
        if (!name || !(Number(item.lastPlayedAt) > 0)) continue;
        out.push({
            key,
            name,
            time: Number(item.time) || 0,
            duration: Number(item.duration) || 0,
            completed: item.completed === true,
            lastPlayedAt: Number(item.lastPlayedAt),
        });
    }
    return out.sort((a, b) => b.lastPlayedAt - a.lastPlayedAt).slice(0, limit);
}
