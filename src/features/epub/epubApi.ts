import { invoke } from "@tauri-apps/api/core";
import type { EpubBookMeta, EpubChapterContent, EpubGalleryImage, EpubSearchHit } from "./epubModel";

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

export const searchEpubBook = async (path: string, query: string): Promise<EpubSearchHit[]> => {
    return invoke<EpubSearchHit[]>("epub_search", { path, query });
};

export const loadEpubGallery = async (path: string): Promise<EpubGalleryImage[]> => {
    return invoke<EpubGalleryImage[]>("epub_gallery", { path });
};

export const readBookBinary = async (path: string): Promise<Uint8Array> => {
    const buf = await invoke<ArrayBuffer>("epub_read_binary", { path });
    return new Uint8Array(buf);
};

export interface EpubFolderEntry {
    path: string;
    subfolderSeries: string | null;
}

export const scanEpubFolder = async (dir: string): Promise<EpubFolderEntry[]> => {
    return invoke<EpubFolderEntry[]>("epub_scan_folder", { dir });
};

export const uploadEpubToDrive = async (
    accessToken: string,
    path: string,
    driveFileId: string,
): Promise<number> => {
    return invoke<number>("epub_drive_upload", { accessToken, path, driveFileId });
};

export const downloadEpubFromDrive = async (
    accessToken: string,
    driveFileId: string,
    tabId: number,
    ext: string,
): Promise<string> => {
    return invoke<string>("epub_drive_download", { accessToken, driveFileId, tabId, ext });
};

export interface EpubAlignedCue {
    index: number;
    startSec: number;
    endSec: number;
    text: string;
    chapterIndex: number | null;
    paragraphIndex: number | null;
}

export interface EpubAlignedParagraph {
    chapterIndex: number;
    paragraphIndex: number;
    startSec: number;
    endSec: number;
}

export interface EpubAudioChapterMarker {
    title: string;
    startSec: number;
    chapterIndex: number | null;
}

export interface EpubAudioAlignment {
    matchedChars: number;
    totalChars: number;
    matchPct: number;
    matchedCues: number;
    totalCues: number;
    cues: EpubAlignedCue[];
    paragraphs: EpubAlignedParagraph[];
    chapters: EpubAudioChapterMarker[];
}

export interface EpubAudioFileLinkInfo {
    audioPath: string;
    companionSrt: string | null;
    companionCue: string | null;
}

export const allowEpubAudioFile = async (path: string): Promise<EpubAudioFileLinkInfo> => {
    return invoke<EpubAudioFileLinkInfo>("epub_audio_allow_file", { path });
};

export const alignEpubAudio = async (
    bookPath: string,
    srtPath: string,
    cuePath: string | null,
    bookKey: string,
): Promise<EpubAudioAlignment> => {
    return invoke<EpubAudioAlignment>("epub_audio_align", {
        bookPath,
        srtPath,
        cuePath,
        bookKey,
    });
};

export const alignEpubAudioText = async (
    bookPath: string,
    srtText: string,
    cueText: string | null,
    bookKey: string,
): Promise<EpubAudioAlignment> => {
    return invoke<EpubAudioAlignment>("epub_audio_align_text", {
        bookPath,
        srtText,
        cueText,
        bookKey,
    });
};

export const loadEpubAudioAlignment = async (
    bookKey: string,
): Promise<EpubAudioAlignment | null> => {
    return invoke<EpubAudioAlignment | null>("epub_audio_load_alignment", { bookKey });
};

export const clearEpubAudioAlignment = async (bookKey: string): Promise<void> => {
    return invoke<void>("epub_audio_clear_alignment", { bookKey });
};
