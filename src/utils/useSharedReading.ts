import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import type { Tab, TabStats } from "./constants";
import {
    HostRoom,
    ViewerRoom,
    applyRoomOp,
    createRoomCode,
    diffLines,
    type RoomConnection,
    type RoomMessage,
    type RoomOp,
} from "./sharedReading";

// Keeps one peer-to-peer room per shared tab. A host tab sends every change of
// its lines to the viewers; a viewer tab takes its lines from the host.

export type ShareStatus = { state: RoomConnection; viewers: number; hostOnline: boolean; error?: string };

type Entry =
    | { key: string; role: "host"; room: HostRoom; sent: string[]; sentTitle: string }
    | { key: string; role: "viewer"; room: ViewerRoom };

const ROOM_OPS = new Set(["snapshot", "append", "set", "insert", "remove"]);
const STATUS_DEFAULT: ShareStatus = { state: "connecting", viewers: 0, hostOnline: false };

export function useSharedReading({
    tabs,
    setTabs,
    countStats,
}: {
    tabs: Tab[];
    setTabs: Dispatch<SetStateAction<Tab[]>>;
    countStats: (text: string) => Omit<TabStats, "time">;
}) {
    const [status, setStatus] = useState<Record<number, ShareStatus>>({});
    const entriesRef = useRef(new Map<number, Entry>());
    const tabsRef = useRef(tabs);
    tabsRef.current = tabs;
    const countRef = useRef(countStats);
    countRef.current = countStats;

    const patchStatus = useCallback((id: number, patch: Partial<ShareStatus>) => {
        setStatus((prev) => ({ ...prev, [id]: { ...STATUS_DEFAULT, ...prev[id], ...patch } }));
    }, []);

    const applyToViewer = useCallback((id: number, op: RoomOp) => {
        setTabs((prev) => prev.map((tab) => {
            if (tab.id !== id) return tab;
            const lines = applyRoomOp(tab.lines, op);
            if (lines === tab.lines) return tab;
            // Snapshots recount everything; single ops adjust the counters.
            let stats: Omit<TabStats, "time">;
            if (op.t === "snapshot") {
                stats = countRef.current(lines.join("\n"));
            } else {
                const removed = op.t === "set" || op.t === "remove" ? tab.lines[op.index] ?? "" : "";
                const added = op.t === "append" ? op.lines.join("\n") : op.t === "set" || op.t === "insert" ? op.text : "";
                const before = countRef.current(removed);
                const after = countRef.current(added);
                stats = {
                    chars: Math.max(0, tab.stats.chars - before.chars + after.chars),
                    words: Math.max(0, tab.stats.words - before.words + after.words),
                    sentences: Math.max(0, tab.stats.sentences - before.sentences + after.sentences),
                };
            }
            // A just-joined tab is named by its code until the host's title arrives.
            const name = op.t === "snapshot" && op.title && tab.shared && tab.name === tab.shared.code ? op.title : tab.name;
            return { ...tab, name, lines, lineFurigana: undefined, historyTail: false, lineCount: undefined, stats: { ...stats, time: tab.stats.time } };
        }));
    }, [setTabs]);

    const markEnded = useCallback((id: number) => {
        setTabs((prev) => prev.map((tab) => tab.id === id && tab.shared ? { ...tab, shared: { ...tab.shared, ended: true } } : tab));
    }, [setTabs]);

    // Open and close rooms as tabs start or stop being shared, and send the
    // host's changes.
    useEffect(() => {
        const entries = entriesRef.current;
        const wanted = new Map<number, string>();
        for (const tab of tabs) {
            if (tab.shared && !tab.shared.ended && !tab.archived) wanted.set(tab.id, `${tab.shared.role}:${tab.shared.code}`);
        }
        for (const [id, entry] of entries) {
            if (wanted.get(id) === entry.key) continue;
            entry.room.close();
            entries.delete(id);
            setStatus((prev) => { const next = { ...prev }; delete next[id]; return next; });
        }
        for (const [id, key] of wanted) {
            if (entries.has(id)) continue;
            const tab = tabs.find((t) => t.id === id)!;
            const share = tab.shared!;
            if (share.role === "host") {
                const entry = { key, role: "host" as const, room: null as unknown as HostRoom, sent: tab.lines, sentTitle: tab.name };
                entry.room = new HostRoom(share.code, {
                    // New viewers get exactly what the others already have; later
                    // changes reach everyone as operations.
                    snapshot: () => ({ title: entry.sentTitle, lines: entry.sent }),
                    onState: (state) => patchStatus(id, { state, hostOnline: state === "live" }),
                    onViewers: (viewers) => patchStatus(id, { viewers }),
                    onError: (error) => patchStatus(id, { error }),
                });
                entries.set(id, entry);
            } else {
                const room = new ViewerRoom(share.code, {
                    onError: (error) => patchStatus(id, { error }),
                    onState: (state) => {
                        patchStatus(id, { state });
                        if (state === "ended") markEnded(id);
                    },
                    onMessage: (message: RoomMessage) => {
                        if (message.t === "presence") patchStatus(id, { viewers: message.viewers, hostOnline: message.hostOnline });
                        else if (ROOM_OPS.has(message.t)) {
                            if (message.t === "snapshot") patchStatus(id, { hostOnline: true });
                            applyToViewer(id, message as RoomOp);
                        }
                    },
                });
                entries.set(id, { key, role: "viewer", room });
            }
        }
        for (const tab of tabs) {
            const entry = entries.get(tab.id);
            if (!entry || entry.role !== "host") continue;
            if (tab.name !== entry.sentTitle) {
                entry.room.broadcast({ t: "title", title: tab.name });
                entry.sentTitle = tab.name;
            }
            if (tab.lines === entry.sent) continue;
            const ops = diffLines(entry.sent, tab.lines);
            if (ops === "snapshot") entry.room.broadcastSnapshot(tab.name, tab.lines);
            else ops.forEach((op) => entry.room.broadcast(op));
            entry.sent = tab.lines;
        }
    }, [tabs, applyToViewer, markEnded, patchStatus]);

    useEffect(() => () => {
        entriesRef.current.forEach((entry) => entry.room.close());
        entriesRef.current.clear();
    }, []);

    /** Starts broadcasting the tab. Returns the room code. */
    const startHosting = useCallback(async (tabId: number) => {
        const code = createRoomCode();
        setTabs((prev) => prev.map((t) => t.id === tabId ? { ...t, shared: { code, role: "host" } } : t));
        return code;
    }, [setTabs]);

    /** Ends the broadcast for everyone; the host keeps the tab as it is. */
    const stopHosting = useCallback((tabId: number) => {
        const entry = entriesRef.current.get(tabId);
        if (entry?.role === "host") {
            entry.room.end();
            entriesRef.current.delete(tabId);
        }
        setTabs((prev) => prev.map((t) => t.id === tabId ? { ...t, shared: undefined } : t));
    }, [setTabs]);

    /** Turns a viewer tab into an ordinary tab of your own. */
    const keepCopy = useCallback((tabId: number) => {
        setTabs((prev) => prev.map((t) => t.id === tabId ? { ...t, shared: undefined } : t));
    }, [setTabs]);

    return { status, startHosting, stopHosting, keepCopy };
}
