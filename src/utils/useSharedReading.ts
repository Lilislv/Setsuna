import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import type { Tab, TabStats } from "./constants";
import {
    HostRoom,
    ViewerRoom,
    applyRoomOp,
    applyViewerStatsDelta,
    createRoomCode,
    createTabUid,
    diffLines,
    mergeSharedLines,
    readSharedProfile,
    resolveStartOffset,
    sliceSharedLines,
    writeSharedProfile,
    type MemberActivity,
    type RoomConnection,
    type RoomMember,
    type RoomMessage,
    type RoomOp,
    type RoomSpotlight,
    type SharedHistoryMode,
    type SharedProfile,
} from "./sharedReading";
import { appendSpeedSample } from "./speedSamples";

// Keeps one peer-to-peer room per shared tab. A host tab sends every change of
// its lines to the viewers; a viewer tab takes its lines from the host.

export type ShareStatus = {
    state: RoomConnection;
    viewers: number;
    hostOnline: boolean;
    error?: string;
    members: RoomMember[];
    hostName?: string;
    timerRunning?: boolean;
    shareScreenshots?: boolean;
    locked?: boolean;
    relays?: { open: number; total: number };
    spotlight?: RoomSpotlight | null;
    kickedReason?: "kicked" | "locked";
};

type HostEntry = {
    key: string;
    role: "host";
    room: HostRoom;
    sent: string[];
    sentTitle: string;
    offset: number;
};

type ViewerEntry = {
    key: string;
    role: "viewer";
    room: ViewerRoom;
    code: string;
};

type Entry = HostEntry | ViewerEntry;

const ROOM_OPS = new Set(["snapshot", "append", "set", "insert", "remove"]);
const STATUS_DEFAULT: ShareStatus = {
    state: "connecting",
    viewers: 0,
    hostOnline: false,
    members: [],
};

export function useSharedReading({
    tabs,
    setTabs,
    activeTabId,
    isPaused,
    lookupOpen,
    en,
    countStats,
    onViewerTimerSync,
    onViewerActivity,
    onViewerStreamEnded,
    captureHostScreenshot,
}: {
    tabs: Tab[];
    setTabs: Dispatch<SetStateAction<Tab[]>>;
    activeTabId: number;
    isPaused: boolean;
    lookupOpen: boolean;
    en: boolean;
    countStats: (text: string) => Omit<TabStats, "time">;
    onViewerTimerSync: (running: boolean) => void;
    onViewerActivity: () => void;
    onViewerStreamEnded?: (tabId: number) => void;
    captureHostScreenshot: (tabId: number) => Promise<string | null>;
}) {
    const [status, setStatus] = useState<Record<number, ShareStatus>>({});
    const [profile, setProfile] = useState<SharedProfile>(() => readSharedProfile(en));
    const [manualActivity, setManualActivity] = useState<Record<number, MemberActivity>>({});

    const entriesRef = useRef(new Map<number, Entry>());
    const tabsRef = useRef(tabs);
    tabsRef.current = tabs;
    const activeTabIdRef = useRef(activeTabId);
    activeTabIdRef.current = activeTabId;
    const isPausedRef = useRef(isPaused);
    isPausedRef.current = isPaused;
    const profileRef = useRef(profile);
    profileRef.current = profile;
    const lookupOpenRef = useRef(lookupOpen);
    lookupOpenRef.current = lookupOpen;
    const countRef = useRef(countStats);
    countRef.current = countStats;
    const onViewerTimerSyncRef = useRef(onViewerTimerSync);
    onViewerTimerSyncRef.current = onViewerTimerSync;
    const onViewerActivityRef = useRef(onViewerActivity);
    onViewerActivityRef.current = onViewerActivity;
    const onViewerStreamEndedRef = useRef(onViewerStreamEnded);
    onViewerStreamEndedRef.current = onViewerStreamEnded;
    const captureHostRef = useRef(captureHostScreenshot);
    captureHostRef.current = captureHostScreenshot;
    const readyTimersRef = useRef(new Map<number, number>());
    const spotlightTimersRef = useRef(new Map<number, number>());

    const patchStatus = useCallback((id: number, patch: Partial<ShareStatus>) => {
        setStatus((prev) => ({
            ...prev,
            [id]: { ...STATUS_DEFAULT, ...prev[id], ...patch },
        }));
    }, []);

    const showSpotlight = useCallback(
        (id: number, spotlight: RoomSpotlight) => {
            const existing = spotlightTimersRef.current.get(id);
            if (existing) window.clearTimeout(existing);
            patchStatus(id, { spotlight });
            const timer = window.setTimeout(() => {
                spotlightTimersRef.current.delete(id);
                patchStatus(id, { spotlight: null });
            }, 9000);
            spotlightTimersRef.current.set(id, timer);
        },
        [patchStatus],
    );

    const dismissSpotlight = useCallback(
        (tabId: number) => {
            const existing = spotlightTimersRef.current.get(tabId);
            if (existing) {
                window.clearTimeout(existing);
                spotlightTimersRef.current.delete(tabId);
            }
            patchStatus(tabId, { spotlight: null });
        },
        [patchStatus],
    );

    const maybeSyncViewerTimer = useCallback((id: number, running: boolean) => {
        if (id !== activeTabIdRef.current) return;
        const tab = tabsRef.current.find((t) => t.id === id);
        if (!tab?.shared || tab.shared.role !== "viewer" || tab.shared.ended) return;
        if (tab.shared.syncTimer === false) return;
        onViewerTimerSyncRef.current(running);
    }, []);

    const applyToViewer = useCallback(
        (id: number, op: RoomOp) => {
            if (op.t === "append" || op.t === "insert" || op.t === "set") {
                onViewerActivityRef.current();
            }
            setTabs((prev) =>
                prev.map((tab) => {
                    if (tab.id !== id) return tab;
                    const lines = applyRoomOp(tab.lines, op);
                    if (lines === tab.lines) return tab;
                    const stats = applyViewerStatsDelta(tab.stats, tab.lines, lines, op, countRef.current);
                    // A just-joined tab is named by its code until the host's title arrives.
                    const name =
                        op.t === "snapshot" && op.title && tab.shared && tab.name === tab.shared.code
                            ? op.title
                            : tab.name;
                    return {
                        ...tab,
                        name,
                        lines,
                        lineFurigana: undefined,
                        historyTail: false,
                        lineCount: undefined,
                        stats: { ...stats, time: tab.stats.time },
                    };
                }),
            );
        },
        [setTabs],
    );

    const markEnded = useCallback(
        (id: number) => {
            maybeSyncViewerTimer(id, false);
            const currentTab = tabsRef.current.find((t) => t.id === id);
            // Tell the viewer the broadcast is over even if no line ever arrived.
            const shouldPrompt = Boolean(
                currentTab?.shared?.role === "viewer"
                && !currentTab.shared.ended,
            );
            setTabs((prev) =>
                prev.map((tab) =>
                    tab.id === id && tab.shared ? { ...tab, shared: { ...tab.shared, ended: true } } : tab,
                ),
            );
            if (shouldPrompt) {
                onViewerStreamEndedRef.current?.(id);
            }
        },
        [maybeSyncViewerTimer, setTabs],
    );

    const effectiveActivityFor = useCallback(
        (tabId: number): MemberActivity => {
            const manual = manualActivity[tabId] || "reading";
            if (manual === "wait") return "wait";
            if (tabId === activeTabId && lookupOpen) return "lookup";
            return manual;
        },
        [activeTabId, lookupOpen, manualActivity],
    );

    // Open and close rooms as tabs start or stop being shared, and send the
    // host's changes.
    useEffect(() => {
        const entries = entriesRef.current;
        const wanted = new Map<number, string>();
        for (const tab of tabs) {
            if (tab.shared && !tab.shared.ended && !tab.archived) {
                wanted.set(tab.id, `${tab.shared.role}:${tab.shared.code}`);
            }
        }
        for (const [id, entry] of entries) {
            if (wanted.get(id) === entry.key) continue;
            entry.room.close();
            entries.delete(id);
            const tab = tabs.find((t) => t.id === id);
            if (!tab?.shared?.ended) {
                setStatus((prev) => {
                    const next = { ...prev };
                    delete next[id];
                    return next;
                });
            }
        }
        for (const [id, key] of wanted) {
            if (entries.has(id)) continue;
            const tab = tabs.find((t) => t.id === id)!;
            const share = tab.shared!;
            if (share.role === "host") {
                const originUid = tab.uid || share.originUid || createTabUid();
                if (!tab.uid || share.originUid !== originUid) {
                    setTabs((prev) =>
                        prev.map((t) =>
                            t.id === id && t.shared?.role === "host"
                                ? { ...t, uid: t.uid || originUid, shared: { ...t.shared, originUid } }
                                : t,
                        ),
                    );
                }
                const sliced = sliceSharedLines(tab.lines, share.startOffset ?? 0);
                const entry: HostEntry = {
                    key,
                    role: "host",
                    room: null as unknown as HostRoom,
                    sent: sliced.lines,
                    sentTitle: tab.name,
                    offset: sliced.offset,
                };
                entry.room = new HostRoom(share.code, {
                    snapshot: () => ({ title: entry.sentTitle, lines: entry.sent }),
                    originUid,
                    profile: profileRef.current,
                    timerRunning: !isPausedRef.current,
                    shareScreenshots: share.shareScreenshots !== false,
                    locked: Boolean(share.locked),
                    onState: (state) => patchStatus(id, { state, hostOnline: state === "live" }),
                    onViewers: (viewers) => patchStatus(id, { viewers }),
                    onMembers: (members) => patchStatus(id, { members }),
                    onSpotlight: (spotlight) =>
                        showSpotlight(id, {
                            ...spotlight,
                            lineIndex: spotlight.lineIndex + entry.offset,
                        }),
                    onCaptureScreenshot: () => captureHostRef.current(id),
                    onRelayStats: (relays) => patchStatus(id, { relays }),
                    onError: (error) => patchStatus(id, { error }),
                });
                entries.set(id, entry);
            } else {
                const manual = manualActivity[id] || "reading";
                const initialActivity: MemberActivity =
                    manual === "wait"
                        ? "wait"
                        : id === activeTabIdRef.current && lookupOpenRef.current
                          ? "lookup"
                          : manual;
                const room = new ViewerRoom(share.code, {
                    profile: profileRef.current,
                    initialActivity,
                    onError: (error) => patchStatus(id, { error }),
                    onRelayStats: (relays) => patchStatus(id, { relays }),
                    onState: (state) => {
                        patchStatus(id, {
                            state,
                            ...(state === "offline" || state === "ended" ? { hostOnline: false } : {}),
                        });
                        if (state === "offline") maybeSyncViewerTimer(id, false);
                        if (state === "ended") markEnded(id);
                    },
                    onMessage: (message: RoomMessage) => {
                        if (message.t === "hello") {
                            if (message.originUid) {
                                const originUid = message.originUid;
                                setTabs((prev) =>
                                    prev.map((t) =>
                                        t.id === id && t.shared?.role === "viewer" && t.shared.originUid !== originUid
                                            ? { ...t, shared: { ...t.shared, originUid } }
                                            : t,
                                    ),
                                );
                            }
                            patchStatus(id, {
                                hostName: message.hostName,
                                hostOnline: true,
                                timerRunning: message.timerRunning,
                                shareScreenshots: message.shareScreenshots,
                                locked: message.locked,
                            });
                            if (typeof message.timerRunning === "boolean") {
                                maybeSyncViewerTimer(id, message.timerRunning);
                            }
                        } else if (message.t === "presence") {
                            if (message.originUid) {
                                const originUid = message.originUid;
                                setTabs((prev) =>
                                    prev.map((t) =>
                                        t.id === id && t.shared?.role === "viewer" && t.shared.originUid !== originUid
                                            ? { ...t, shared: { ...t.shared, originUid } }
                                            : t,
                                    ),
                                );
                            }
                            patchStatus(id, {
                                viewers: message.viewers,
                                hostOnline: message.hostOnline,
                                ...(message.members ? { members: message.members } : {}),
                                ...(typeof message.timerRunning === "boolean"
                                    ? { timerRunning: message.timerRunning }
                                    : {}),
                                ...(typeof message.shareScreenshots === "boolean"
                                    ? { shareScreenshots: message.shareScreenshots }
                                    : {}),
                                ...(typeof message.locked === "boolean" ? { locked: message.locked } : {}),
                            });
                            if (!message.hostOnline) maybeSyncViewerTimer(id, false);
                            else if (typeof message.timerRunning === "boolean") {
                                maybeSyncViewerTimer(id, message.timerRunning);
                            }
                        } else if (message.t === "timer") {
                            patchStatus(id, { timerRunning: message.running });
                            maybeSyncViewerTimer(id, message.running);
                        } else if (message.t === "spotlight") {
                            showSpotlight(id, {
                                id: message.id,
                                lineIndex: message.lineIndex,
                                snippet: message.snippet,
                                byName: message.byName,
                                byColor: message.byColor,
                                at: Date.now(),
                            });
                        } else if (message.t === "kicked") {
                            patchStatus(id, {
                                kickedReason: message.reason || "kicked",
                                hostOnline: false,
                            });
                            markEnded(id);
                        } else if (message.t === "title") {
                            setTabs((prev) =>
                                prev.map((t) =>
                                    t.id === id && t.shared?.role === "viewer" ? { ...t, name: message.title } : t,
                                ),
                            );
                        } else if (ROOM_OPS.has(message.t)) {
                            if (message.t === "snapshot") patchStatus(id, { hostOnline: true });
                            applyToViewer(id, message as RoomOp);
                        }
                    },
                });
                entries.set(id, { key, role: "viewer", room, code: share.code });
            }
        }
        for (const tab of tabs) {
            const entry = entries.get(tab.id);
            if (!entry || entry.role !== "host") continue;
            if (tab.name !== entry.sentTitle) {
                entry.room.broadcast({ t: "title", title: tab.name });
                entry.sentTitle = tab.name;
            }
            const sliced = sliceSharedLines(tab.lines, tab.shared?.startOffset ?? entry.offset);
            entry.offset = sliced.offset;
            const ops = diffLines(entry.sent, sliced.lines);
            if (ops === "snapshot") {
                entry.room.broadcastSnapshot(tab.name, sliced.lines);
                entry.sent = sliced.lines;
            } else if (ops.length > 0) {
                ops.forEach((op) => entry.room.broadcast(op));
                entry.sent = sliced.lines;
            }
        }
    }, [tabs, applyToViewer, markEnded, maybeSyncViewerTimer, patchStatus, setTabs, showSpotlight]);

    // Sync host timer state to all connected viewers.
    useEffect(() => {
        const running = !isPaused;
        for (const entry of entriesRef.current.values()) {
            if (entry.role === "host") {
                entry.room.setTimerRunning(running);
            }
        }
    }, [isPaused]);

    // Sync viewer profile and activity (wait / lookup / ready) to the host.
    useEffect(() => {
        for (const [id, entry] of entriesRef.current.entries()) {
            if (entry.role === "viewer") {
                entry.room.sendMeta(profile, effectiveActivityFor(id));
            }
        }
    }, [profile, effectiveActivityFor]);

    // When switching tabs onto a synced viewer tab, align local timer with host.
    useEffect(() => {
        const tab = tabsRef.current.find((t) => t.id === activeTabId);
        if (!tab?.shared || tab.shared.role !== "viewer" || tab.shared.ended) return;
        if (tab.shared.syncTimer === false) return;
        const st = status[activeTabId];
        if (!st) return;
        onViewerTimerSyncRef.current(Boolean(st.hostOnline && st.timerRunning));
    }, [activeTabId]);

    useEffect(
        () => () => {
            entriesRef.current.forEach((entry) => entry.room.close());
            entriesRef.current.clear();
            readyTimersRef.current.forEach((t) => window.clearTimeout(t));
            readyTimersRef.current.clear();
            spotlightTimersRef.current.forEach((t) => window.clearTimeout(t));
            spotlightTimersRef.current.clear();
        },
        [],
    );

    const updateProfile = useCallback(
        (next: SharedProfile) => {
            const saved = writeSharedProfile(next, en);
            setProfile(saved);
            for (const entry of entriesRef.current.values()) {
                if (entry.role === "host") entry.room.setProfile(saved);
            }
            return saved;
        },
        [en],
    );

    /** Starts broadcasting the tab. Returns the room code. */
    const startHosting = useCallback(
        async (tabId: number, opts?: { historyMode?: SharedHistoryMode; shareScreenshots?: boolean }) => {
            const code = createRoomCode();
            const historyMode: SharedHistoryMode = opts?.historyMode || "recent";
            const shareScreenshots = opts?.shareScreenshots ?? true;
            setTabs((prev) =>
                prev.map((t) => {
                    if (t.id !== tabId) return t;
                    const uid = t.uid || createTabUid();
                    const startOffset = resolveStartOffset(t.lines.length, historyMode);
                    return {
                        ...t,
                        uid,
                        shared: {
                            code,
                            role: "host",
                            originUid: uid,
                            historyMode,
                            startOffset,
                            shareScreenshots,
                            locked: false,
                        },
                    };
                }),
            );
            return code;
        },
        [setTabs],
    );

    /** Ends the broadcast for everyone; the host keeps the tab as it is. */
    const stopHosting = useCallback(
        (tabId: number) => {
            const entry = entriesRef.current.get(tabId);
            if (entry?.role === "host") {
                entry.room.end();
                entriesRef.current.delete(tabId);
            }
            setTabs((prev) => prev.map((t) => (t.id === tabId ? { ...t, shared: undefined } : t)));
        },
        [setTabs],
    );

    /** Turns a viewer tab into an ordinary tab of your own, keeping originUid for future updates. */
    const keepCopy = useCallback(
        (tabId: number) => {
            setTabs((prev) =>
                prev.map((t) =>
                    t.id === tabId
                        ? {
                              ...t,
                              uid: t.uid || createTabUid(),
                              sharedOriginUid: t.shared?.originUid || t.sharedOriginUid,
                              shared: undefined,
                          }
                        : t,
                ),
            );
        },
        [setTabs],
    );

    /** Merges a viewer tab's lines into a previously saved tab from the same host stream. */
    const mergeViewerIntoTab = useCallback(
        (viewerTabId: number, targetTabId: number, existingFullLines?: string[]): number => {
            const viewerTab = tabsRef.current.find((t) => t.id === viewerTabId);
            const targetTab = tabsRef.current.find((t) => t.id === targetTabId);
            if (!viewerTab || !targetTab) return 0;

            const baseLines = existingFullLines ?? targetTab.lines;
            const merged = mergeSharedLines(baseLines, viewerTab.lines);
            const textStats = countRef.current(merged.lines.join("\n"));
            const totalTime = (targetTab.stats.time || 0) + (viewerTab.stats.time || 0);
            const nextStats: TabStats = { ...textStats, time: totalTime };
            const nextSamples = appendSpeedSample(targetTab.speedSamples || [], {
                at: Date.now(),
                chars: nextStats.chars,
                words: nextStats.words,
                sentences: nextStats.sentences,
                time: nextStats.time,
            });
            const originUid = viewerTab.shared?.originUid || targetTab.sharedOriginUid;

            const entry = entriesRef.current.get(viewerTabId);
            if (entry) {
                entry.room.close();
                entriesRef.current.delete(viewerTabId);
            }

            setTabs((prev) =>
                prev
                    .filter((t) => t.id !== viewerTabId)
                    .map((t) =>
                        t.id === targetTabId
                            ? {
                                  ...t,
                                  uid: t.uid || createTabUid(),
                                  sharedOriginUid: originUid,
                                  lines: merged.lines,
                                  lineCount: merged.lines.length,
                                  historyTail: false,
                                  archived: false,
                                  stats: nextStats,
                                  speedSamples: nextSamples,
                              }
                            : t,
                    ),
            );
            return merged.addedCount;
        },
        [setTabs],
    );

    const setRoomLocked = useCallback(
        (tabId: number, locked: boolean) => {
            const entry = entriesRef.current.get(tabId);
            if (entry?.role === "host") entry.room.setLocked(locked);
            setTabs((prev) =>
                prev.map((t) =>
                    t.id === tabId && t.shared?.role === "host" ? { ...t, shared: { ...t.shared, locked } } : t,
                ),
            );
        },
        [setTabs],
    );

    const setShareScreenshots = useCallback(
        (tabId: number, enabled: boolean) => {
            const entry = entriesRef.current.get(tabId);
            if (entry?.role === "host") entry.room.setShareScreenshots(enabled);
            setTabs((prev) =>
                prev.map((t) =>
                    t.id === tabId && t.shared?.role === "host"
                        ? { ...t, shared: { ...t.shared, shareScreenshots: enabled } }
                        : t,
                ),
            );
        },
        [setTabs],
    );

    const kickViewer = useCallback((tabId: number, peerId: string) => {
        const entry = entriesRef.current.get(tabId);
        if (entry?.role === "host") entry.room.kick(peerId);
    }, []);

    const toggleViewerWait = useCallback((tabId: number) => {
        const existingTimer = readyTimersRef.current.get(tabId);
        if (existingTimer) {
            window.clearTimeout(existingTimer);
            readyTimersRef.current.delete(tabId);
        }
        setManualActivity((prev) => {
            const cur = prev[tabId] || "reading";
            if (cur === "wait") {
                const timer = window.setTimeout(() => {
                    readyTimersRef.current.delete(tabId);
                    setManualActivity((curr) => (curr[tabId] === "ready" ? { ...curr, [tabId]: "reading" } : curr));
                }, 6000);
                readyTimersRef.current.set(tabId, timer);
                return { ...prev, [tabId]: "ready" };
            }
            return { ...prev, [tabId]: "wait" };
        });
    }, []);

    const setViewerSyncTimer = useCallback(
        (tabId: number, sync: boolean) => {
            setTabs((prev) =>
                prev.map((t) =>
                    t.id === tabId && t.shared?.role === "viewer"
                        ? { ...t, shared: { ...t.shared, syncTimer: sync } }
                        : t,
                ),
            );
            if (sync && tabId === activeTabIdRef.current) {
                const st = status[tabId];
                if (st) onViewerTimerSyncRef.current(Boolean(st.hostOnline && st.timerRunning));
            }
        },
        [setTabs, status],
    );

    const sendSpotlight = useCallback((tabId: number, lineIndex: number, text: string) => {
        const entry = entriesRef.current.get(tabId);
        if (!entry) return;
        const snippet = text.trim().replace(/\s+/g, " ").slice(0, 64);
        const spotId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
        const prof = profileRef.current;
        if (entry.role === "host") {
            const relIndex = Math.max(0, lineIndex - entry.offset);
            entry.room.broadcastSpotlight({
                id: spotId,
                lineIndex: relIndex,
                snippet,
                byName: prof.name,
                byColor: prof.color,
            });
        } else {
            entry.room.sendSpotlight({
                id: spotId,
                lineIndex,
                snippet,
                byName: prof.name,
                byColor: prof.color,
            });
        }
    }, []);

    const requestScreenshot = useCallback((tabId: number): Promise<string | null> => {
        const entry = entriesRef.current.get(tabId);
        if (!entry || entry.role !== "viewer") return Promise.resolve(null);
        return entry.room.requestScreenshot();
    }, []);

    const viewerActivity: Record<number, MemberActivity> = {};
    for (const tab of tabs) {
        if (tab.shared?.role === "viewer") {
            viewerActivity[tab.id] = effectiveActivityFor(tab.id);
        }
    }

    return {
        status,
        profile,
        updateProfile,
        viewerActivity,
        startHosting,
        stopHosting,
        keepCopy,
        mergeViewerIntoTab,
        setRoomLocked,
        setShareScreenshots,
        kickViewer,
        toggleViewerWait,
        setViewerSyncTimer,
        sendSpotlight,
        dismissSpotlight,
        requestScreenshot,
    };
}
