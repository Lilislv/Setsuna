import {
    recognizeMangaCropLocalPc,
    recognizeMangaCropRemote,
    startMangaOcrServer,
    type MangaOcrResult,
} from "./mangaApi";
import {
    DEFAULT_MANGA_OCR_PREFS,
    loadMangaOcrPrefs,
    normalizeOcrServerUrl,
    resolveMobileOcrChain,
    saveMangaOcrPrefs,
    type MangaMobileOcrEngine,
    type MangaOcrPrefs,
} from "./mangaModel";

export {
    DEFAULT_MANGA_OCR_PREFS,
    loadMangaOcrPrefs,
    normalizeOcrServerUrl,
    resolveMobileOcrChain,
    saveMangaOcrPrefs,
    type MangaMobileOcrEngine,
    type MangaOcrPrefs,
};

export interface AndroidMangaOcrStatus {
    onnxReady: boolean;
    onnxDownloading: boolean;
    onnxSizeBytes: number;
    mlkitReady: boolean;
}

export interface MangaOcrDownloadEvent {
    status: "downloading" | "done" | "cancelled" | "error";
    file: string;
    downloadedBytes: number;
    totalBytes: number;
    percent: number;
    error?: string;
}

export interface MlKitDetectedBlock {
    box: [number, number, number, number];
    text: string;
    vertical: boolean;
}

type AndroidMangaOcrBridge = {
    getStatus: () => string;
    startModelDownload: () => string;
    cancelModelDownload: () => string;
    deleteModel: () => string;
    recognizeOnnx: (imageBase64: string) => string;
    recognizeMlKit: (imageBase64: string) => string;
    detectPageBlocksMlKit: (imageBase64: string) => string;
};

declare global {
    interface Window {
        SetsunaMangaOcr?: AndroidMangaOcrBridge;
    }
}

function getBridge(): AndroidMangaOcrBridge | null {
    if (typeof window === "undefined") return null;
    return window.SetsunaMangaOcr || null;
}

function parseBridgeResponse<T>(raw: string): T {
    const parsed = JSON.parse(raw) as { ok?: boolean; value?: T; error?: string };
    if (!parsed?.ok) {
        throw new Error(parsed?.error || "Android OCR bridge error");
    }
    return parsed.value as T;
}

export function hasAndroidMangaOcrBridge(): boolean {
    return Boolean(getBridge());
}

export async function getAndroidMangaOcrStatus(): Promise<AndroidMangaOcrStatus> {
    const bridge = getBridge();
    if (!bridge) {
        return { onnxReady: false, onnxDownloading: false, onnxSizeBytes: 0, mlkitReady: false };
    }
    return parseBridgeResponse<AndroidMangaOcrStatus>(bridge.getStatus());
}

export function startAndroidOnnxDownload(): void {
    const bridge = getBridge();
    if (!bridge) throw new Error("Android OCR bridge unavailable.");
    parseBridgeResponse(bridge.startModelDownload());
}

export function cancelAndroidOnnxDownload(): void {
    const bridge = getBridge();
    if (!bridge) return;
    parseBridgeResponse(bridge.cancelModelDownload());
}

export function deleteAndroidOnnxModel(): void {
    const bridge = getBridge();
    if (!bridge) return;
    parseBridgeResponse(bridge.deleteModel());
}

function runBridgeAsync<T>(invokeFn: (bridge: AndroidMangaOcrBridge) => string): Promise<T> {
    return new Promise((resolve, reject) => {
        window.setTimeout(() => {
            try {
                const bridge = getBridge();
                if (!bridge) {
                    reject(new Error("Android OCR bridge is not available."));
                    return;
                }
                resolve(parseBridgeResponse<T>(invokeFn(bridge)));
            } catch (error) {
                reject(error instanceof Error ? error : new Error(String(error)));
            }
        }, 0);
    });
}

export function recognizeAndroidOnnx(imageBase64: string): Promise<MangaOcrResult> {
    return runBridgeAsync<MangaOcrResult>((b) => b.recognizeOnnx(imageBase64));
}

export function recognizeAndroidMlKit(imageBase64: string): Promise<MangaOcrResult> {
    return runBridgeAsync<MangaOcrResult>((b) => b.recognizeMlKit(imageBase64));
}

export async function detectAndroidPageBlocksMlKit(imageBase64: string): Promise<{
    blocks: MlKitDetectedBlock[];
    elapsedMs: number;
}> {
    return runBridgeAsync<{ blocks: MlKitDetectedBlock[]; elapsedMs: number }>((b) =>
        b.detectPageBlocksMlKit(imageBase64),
    );
}

/**
 * Route a bubble crop through the best available OCR engine on Desktop or Android.
 * In Android `auto` mode, tries: PC Wi-Fi server (if configured) -> offline ONNX INT8 (if downloaded) -> ML Kit Japanese.
 */
export async function recognizeMangaCrop(
    imageBase64: string,
    prefs: MangaOcrPrefs,
    isMobile: boolean,
): Promise<MangaOcrResult> {
    if (!isMobile) {
        try {
            return await recognizeMangaCropLocalPc(imageBase64);
        } catch (localErr) {
            const remote = normalizeOcrServerUrl(prefs.remoteUrl);
            if (remote) {
                return recognizeMangaCropRemote(remote, prefs.remoteToken || undefined, imageBase64);
            }
            throw localErr;
        }
    }

    const status = await getAndroidMangaOcrStatus().catch(() => ({
        onnxReady: false,
        onnxDownloading: false,
        onnxSizeBytes: 0,
        mlkitReady: hasAndroidMangaOcrBridge(),
    }));
    const chain = resolveMobileOcrChain(prefs, status.onnxReady);
    let lastError: unknown = null;

    for (const engine of chain) {
        try {
            if (engine === "remote") {
                const url = normalizeOcrServerUrl(prefs.remoteUrl);
                if (!url) throw new Error("PC Wi-Fi OCR server URL is not configured.");
                return await recognizeMangaCropRemote(url, prefs.remoteToken || undefined, imageBase64);
            }
            if (engine === "onnx") {
                return await recognizeAndroidOnnx(imageBase64);
            }
            if (engine === "mlkit") {
                return await recognizeAndroidMlKit(imageBase64);
            }
        } catch (err) {
            lastError = err;
            if (prefs.mobileEngine !== "auto") {
                throw err;
            }
        }
    }

    throw lastError instanceof Error
        ? lastError
        : new Error("No OCR engine available on this device.");
}

/** Auto-start the PC LAN OCR server when enabled in saved preferences (desktop only). */
export async function ensurePcOcrServerFromPrefs(): Promise<void> {
    try {
        const prefs = loadMangaOcrPrefs();
        if (!prefs.pcServerEnabled) return;
        await startMangaOcrServer(prefs.pcServerPort, prefs.pcServerToken || undefined);
    } catch {
        // Ignore auto-start failures silently at boot; status card shows details in Settings
    }
}
