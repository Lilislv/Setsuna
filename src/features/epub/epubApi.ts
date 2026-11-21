import { invoke } from "@tauri-apps/api/core";
import type { EpubBookMeta, EpubChapterContent } from "./epubModel";

export const storeEpubFile = async (path: string, tabId: number): Promise<string> => {
    return invoke<string>("epub_store", { path, tabId });
};

export const pruneEpubFiles = async (keepIds: number[]): Promise<number> => {
    return invoke<number>("epub_prune", { keepIds });
};

export const openEpubBook = async (path: string): Promise<EpubBookMeta> => {
    return invoke<EpubBookMeta>("epub_open", { path });
};

export const loadEpubCover = async (path: string): Promise<string | null> => {
    return invoke<string | null>("epub_cover", { path });
};

export const loadEpubChapter = async (path: string, index: number): Promise<EpubChapterContent> => {
    return invoke<EpubChapterContent>("epub_chapter", { path, index });
};
