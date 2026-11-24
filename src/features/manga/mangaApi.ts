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

export const runMokuroOnVolume = async (path: string): Promise<MangaMeta> => {
    return invoke<MangaMeta>("manga_run_mokuro", { path });
};
