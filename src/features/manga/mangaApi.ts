import { invoke } from "@tauri-apps/api/core";
import type { MangaMeta, MangaMokuroStatus, MangaPagePayload } from "./mangaModel";

export interface MangaFolderEntry {
    path: string;
    subfolderSeries: string | null;
    hasMokuro: boolean;
    sourceKind: "folder" | "cbz";
}

export const openMangaVolume = async (path: string): Promise<MangaMeta> => {
    return invoke<MangaMeta>("manga_open", { path });
};

export const loadMangaCover = async (path: string): Promise<string | null> => {
    return invoke<string | null>("manga_cover", { path });
};

export const loadMangaPage = async (path: string, pageIndex: number): Promise<MangaPagePayload> => {
    return invoke<MangaPagePayload>("manga_page", { path, pageIndex });
};

export const storeMangaVolume = async (path: string, tabId: number): Promise<string> => {
    return invoke<string>("manga_store", { path, tabId });
};

export const attachMokuroOverlay = async (
    mangaPath: string,
    mokuroPath: string,
): Promise<MangaMeta> => {
    return invoke<MangaMeta>("manga_attach_mokuro", { mangaPath, mokuroPath });
};

export const loadMangaOverrides = async (
    mangaPath: string,
): Promise<Record<number, Record<number, string>>> => {
    return invoke<Record<number, Record<number, string>>>("manga_load_overrides", { mangaPath });
};

export const saveMangaOverride = async (
    mangaPath: string,
    pageIndex: number,
    blockIndex: number,
    text: string,
): Promise<void> => {
    return invoke<void>("manga_save_override", { mangaPath, pageIndex, blockIndex, text });
};

export const scanMangaFolder = async (dir: string): Promise<MangaFolderEntry[]> => {
    return invoke<MangaFolderEntry[]>("manga_scan_folder", { dir });
};

export const extractMangaArchive = async (path: string): Promise<MangaFolderEntry[]> => {
    return invoke<MangaFolderEntry[]>("manga_extract_archive", { path });
};

export const checkMokuroStatus = async (): Promise<MangaMokuroStatus> => {
    return invoke<MangaMokuroStatus>("manga_mokuro_status");
};

export interface MokuroInstallProgress {
    stage: "python" | "pip" | "torch" | "mokuro" | "done" | string;
    line: string;
}

/** Installs Python (if needed), PyTorch and mokuro on Windows; progress via `manga_mokuro_install`. */
export const installMokuro = async (): Promise<void> => {
    await invoke("manga_install_mokuro");
};

export const runMokuroOnVolume = async (path: string): Promise<MangaMeta> => {
    return invoke<MangaMeta>("manga_run_mokuro", { path });
};

export interface MangaExportResult {
    outputPath: string;
    pageCount: number;
    hasMokuro: boolean;
    bytes: number;
}

export interface MangaOcrServerStatus {
    running: boolean;
    available: boolean;
    url: string | null;
    port: number;
    device: string | null;
    token: string;
    error: string | null;
}

export interface MangaOcrResult {
    text: string;
    engine: string;
    device?: string | null;
    elapsedMs: number;
}

export interface MangaOcrHealth {
    ok: boolean;
    service: string;
    device: string | null;
    version: string | null;
}

export const exportMangaMobileCbz = async (
    path: string,
    outputPath: string,
): Promise<MangaExportResult> => {
    return invoke<MangaExportResult>("manga_export_mobile_cbz", { path, outputPath });
};

export const convertMangaToCbz = async (
    path: string,
    tabId: number,
    coverDataUri?: string | null,
): Promise<MangaExportResult> => {
    return invoke<MangaExportResult>("manga_convert_to_cbz", {
        path,
        tabId,
        coverDataUri: coverDataUri || null,
    });
};

export const getMangaOcrServerStatus = async (): Promise<MangaOcrServerStatus> => {
    return invoke<MangaOcrServerStatus>("manga_ocr_server_status");
};

export const startMangaOcrServer = async (
    port?: number,
    token?: string,
): Promise<MangaOcrServerStatus> => {
    return invoke<MangaOcrServerStatus>("manga_ocr_server_start", { port, token });
};

export const stopMangaOcrServer = async (): Promise<MangaOcrServerStatus> => {
    return invoke<MangaOcrServerStatus>("manga_ocr_server_stop");
};

export const recognizeMangaCropLocalPc = async (
    imageBase64: string,
): Promise<MangaOcrResult> => {
    return invoke<MangaOcrResult>("manga_ocr_local_recognize", { imageBase64 });
};

export const checkMangaOcrRemoteHealth = async (
    url: string,
    token?: string,
): Promise<MangaOcrHealth> => {
    return invoke<MangaOcrHealth>("manga_ocr_remote_health", { url, token });
};

export const recognizeMangaCropRemote = async (
    url: string,
    token: string | undefined,
    imageBase64: string,
): Promise<MangaOcrResult> => {
    return invoke<MangaOcrResult>("manga_ocr_remote_recognize", { url, token, imageBase64 });
};

export interface RemoteMokuroJobState {
    jobId: number;
    state: "idle" | "queued" | "running" | "converting" | "done" | "error";
    title: string;
    bookKey?: string | null;
    message?: string | null;
    error?: string | null;
    current?: number | null;
    total?: number | null;
    updatedAt?: number;
}

export const setRemoteMokuroState = async (state: RemoteMokuroJobState): Promise<void> => {
    return invoke<void>("manga_ocr_set_remote_mokuro_state", { state });
};

export const requestRemotePcMokuro = async (
    url: string,
    token: string | undefined,
    title: string,
    bookKey?: string | null,
    autoConvertCbz = true,
): Promise<RemoteMokuroJobState> => {
    return invoke<RemoteMokuroJobState>("manga_ocr_remote_mokuro_request", {
        url,
        token,
        title,
        bookKey: bookKey || null,
        autoConvertCbz,
    });
};

export const fetchRemotePcMokuroStatus = async (
    url: string,
    token: string | undefined,
): Promise<RemoteMokuroJobState> => {
    return invoke<RemoteMokuroJobState>("manga_ocr_remote_mokuro_status", { url, token });
};

export interface MangaCatalogCandidate {
    id: string;
    title: string;
    nativeTitle?: string | null;
    author?: string | null;
    year?: number | null;
    format: string;
    source: string;
    imageUrl: string;
    pageUrl: string;
    volume?: string | null;
    volumeNumber?: number | null;
}

export interface MangaCatalogSearch {
    candidates: MangaCatalogCandidate[];
    unavailable: string[];
}

export interface CatalogVolumeCover {
    volume: string;
    volumeNumber?: number | null;
    title?: string | null;
    imageUrl: string;
    source: string;
}

export const searchMangaCatalog = async (query: string): Promise<MangaCatalogSearch> => {
    return invoke<MangaCatalogSearch>("manga_search_catalog", { query });
};

export const fetchCatalogSeriesVolumes = async (params: {
    title: string;
    nativeTitle?: string | null;
    anilistId?: string | null;
    malId?: string | null;
    format?: string | null;
    targetVolume?: string | null;
}): Promise<CatalogVolumeCover[]> => {
    return invoke<CatalogVolumeCover[]>("manga_fetch_series_volumes", params);
};

export const fetchCatalogCoverDataUri = async (url: string): Promise<string> => {
    return invoke<string>("manga_fetch_cover_data_uri", { url });
};
