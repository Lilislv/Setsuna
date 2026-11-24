import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { libraryKey, naturalOrder, type LibraryFolder } from "./libraryModel";

type Scan = { folder: LibraryFolder } | { error: string };
function storedRoots(): string[] {
    try {
        const roots: unknown = JSON.parse(localStorage.getItem(libraryKey) || "[]");
        return Array.isArray(roots) ? roots.filter((path): path is string => typeof path === "string") : [];
    } catch {
        return [];
    }
}

export function usePlayerLibrary() {
    const [roots, setRoots] = useState(storedRoots);
    const [results, setResults] = useState<Record<string, Scan>>({});
    const [revision, setRevision] = useState(0);
    const [error, setError] = useState("");
    const [pending, setPending] = useState(false);

    useEffect(() => {
        let cancelled = false;
        setResults({});
        try {
            localStorage.setItem(libraryKey, JSON.stringify(roots));
        } catch {
            /* storage unavailable */
        }
        for (const root of roots) {
            void invoke<LibraryFolder>("player_scan_folder", { path: root }).then(
                (folder) => {
                    for (const group of folder.directories)
                        group.episodes.sort((a, b) => naturalOrder(a.path, b.path));
                    folder.directories.sort((a, b) => naturalOrder(a.path, b.path));
                    if (!cancelled) setResults((previous) => ({ ...previous, [root]: { folder } }));
                },
                (failure) => {
                    if (!cancelled)
                        setResults((previous) => ({ ...previous, [root]: { error: String(failure) } }));
                },
            );
        }
        return () => {
            cancelled = true;
        };
    }, [roots, revision]);

    const changeRoots = async <T>(action: () => Promise<T>) => {
        setPending(true);
        setError("");
        try {
            return await action();
        } catch (failure) {
            setError(String(failure));
        } finally {
            setPending(false);
        }
    };

    return {
        roots,
        results,
        error,
        pending,
        refresh: () => setRevision((value) => value + 1),
        chooseFolder: () =>
            changeRoots(async () => {
                const path = await open({ directory: true, recursive: false, multiple: false });
                if (typeof path !== "string") return;
                setRoots((roots) => (roots.includes(path) ? roots : [...roots, path]));
                setRevision((value) => value + 1);
                return path;
            }),
        removeFolder: (path: string) =>
            changeRoots(async () => {
                await invoke("player_forget_library_folder", { path });
                setRoots((roots) => roots.filter((root) => root !== path));
            }),
    };
}

export type PlayerLibraryData = ReturnType<typeof usePlayerLibrary>;
