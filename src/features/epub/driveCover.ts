import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { compactCoverDataUrl } from "./epubCoverCache";
import { readZipBookCover, type RangeReader } from "./zipCover";

const DRIVE_FILES = "https://www.googleapis.com/drive/v3/files/";

const driveFetch: typeof globalThis.fetch = async (input, init) => {
    const options = { ...init, signal: init?.signal ?? AbortSignal.timeout(60_000) };
    if (typeof window !== "undefined" && "__TAURI_INTERNALS__" in window) {
        return await tauriFetch(input, { ...options, connectTimeout: 20_000 }) as Response;
    }
    return globalThis.fetch(input, options);
};

/** Small (sync-sized) cover thumbnail of a book stored on Drive, or null. */
export async function fetchDriveBookCover(accessToken: string, fileId: string, kind: "manga" | "epub"): Promise<string | null> {
    const auth = { Authorization: `Bearer ${accessToken}` };
    const metaRes = await driveFetch(`${DRIVE_FILES}${encodeURIComponent(fileId)}?fields=size`, { headers: auth });
    if (!metaRes.ok) throw new Error(`Drive metadata ${metaRes.status}`);
    const size = Number((await metaRes.json() as { size?: string }).size || 0);
    if (!(size > 22)) return null;
    const read: RangeReader = async (start, end) => {
        const last = Math.min(size, end) - 1;
        const res = await driveFetch(`${DRIVE_FILES}${encodeURIComponent(fileId)}?alt=media`, {
            headers: { ...auth, Range: `bytes=${start}-${last}` },
        });
        if (res.status !== 206 && res.status !== 200) throw new Error(`Drive range ${res.status}`);
        const bytes = new Uint8Array(await res.arrayBuffer());
        // A server that ignores Range returns the whole file.
        return res.status === 200 && bytes.length === size ? bytes.subarray(start, last + 1) : bytes;
    };
    const full = await readZipBookCover(read, size, kind);
    return full ? compactCoverDataUrl(full) : null;
}
