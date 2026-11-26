import { useEffect, useRef, type RefObject } from "react";
import { listen } from "@tauri-apps/api/event";
import type { Tab } from "../../utils/constants";
import { getBookSyncKey } from "../epub/epubSyncModel";
import { isMangaTabData, type MangaMeta } from "./mangaModel";
import { runMokuroOnVolume, setRemoteMokuroState, type MangaExportResult, type RemoteMokuroJobState } from "./mangaApi";

interface RemoteRequest {
    jobId: number;
    bookKey: string;
    autoConvertCbz: boolean;
}

export function useRemoteMokuroHost(
    enabled: boolean,
    tabsRef: RefObject<Tab[]>,
    updateMeta: (tabId: number, meta: MangaMeta) => void,
    convert: (tabId: number) => Promise<MangaExportResult | null>,
) {
    const callbacks = useRef({ updateMeta, convert });
    callbacks.current = { updateMeta, convert };
    useEffect(() => {
        if (!enabled) return;
        let disposed = false;
        let busy = false;
        const listener = listen<RemoteRequest>("setsuna://remote-mokuro-request", async ({ payload }) => {
            if (disposed || busy) return;
            busy = true;
            const { jobId, bookKey, autoConvertCbz } = payload;
            let status: RemoteMokuroJobState = { jobId, title: "", state: "running" };
            let stopProgress: (() => void) | undefined;
            let heartbeat: number | undefined;
            try {
                await setRemoteMokuroState(status);
                // Only the PC library supplies filesystem paths. A title must identify one local manga.
                const matches = tabsRef.current?.filter(tab => tab.mode === "epub" && !tab.archived
                    && isMangaTabData(tab.epub) && !tab.epub?.cloudOnly && tab.epub?.path?.trim()
                    && getBookSyncKey(tab.epub.title || tab.name) === bookKey) || [];
                if (matches.length !== 1) throw new Error(matches.length
                    ? "Multiple local manga volumes have this title on the PC."
                    : "This manga volume is missing from the PC library.");
                const book = matches[0];
                const path = book.epub!.path!;
                const stillLocal = () => tabsRef.current?.some(tab => tab.id === book.id
                    && !tab.archived && !tab.epub?.cloudOnly && tab.epub?.path === path);
                stopProgress = await listen<{ path: string; current?: number; total?: number }>(
                    "manga_mokuro_progress", ({ payload: progress }) => {
                        if (progress.path === path && status.state === "running" && typeof progress.current === "number") {
                            status = { ...status, current: progress.current, total: progress.total };
                        }
                    },
                );
                heartbeat = window.setInterval(() => { void setRemoteMokuroState(status).catch(() => {}); }, 2500);
                const meta = await runMokuroOnVolume(path);
                if (!meta.hasMokuro) throw new Error("Mokuro finished without an OCR layer.");
                if (!stillLocal()) throw new Error("The volume in the PC library changed during OCR.");
                callbacks.current.updateMeta(book.id, meta);
                if (autoConvertCbz) {
                    status = { ...status, state: "converting" };
                    await setRemoteMokuroState(status);
                    if (!stillLocal()) throw new Error("The volume in the PC library changed before conversion.");
                    const result = await callbacks.current.convert(book.id);
                    if (!result?.hasMokuro) throw new Error("The PC could not pack the OCR layer into a CBZ.");
                }
                status = { ...status, state: "done" };
            } catch (error) {
                status = { ...status, state: "error", error: String(error) };
            } finally {
                window.clearInterval(heartbeat);
                stopProgress?.();
                await setRemoteMokuroState(status).catch(() => {});
                busy = false;
            }
        }, { target: "main" });
        void listener.catch(() => {});
        return () => {
            disposed = true;
            void listener.then(stop => stop()).catch(() => {});
        };
    }, [enabled, tabsRef]);
}
