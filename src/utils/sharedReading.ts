import { getRelaySockets, joinRoom, type Room } from "trystero/nostr";
import type { Tab, TabStats } from "./constants";

// Shared reading, peer to peer: the host's Setsuna holds the room. Viewers
// connect straight to it over WebRTC. To find each other both sides announce
// themselves on several independent public Nostr relays at once (Trystero):
// one blocked or dead relay doesn't matter while any other one works for both.
// The connection details sent through relays are encrypted with the room code.
// Nothing is stored anywhere: while the host is away viewers keep their text.

export type SharedHistoryMode = "new" | "recent" | "all";
export type MemberActivity = "reading" | "lookup" | "wait" | "ready";

export type SharedProfile = {
    name: string;
    color: string;
};

export type RoomMember = {
    id: string;
    name: string;
    color: string;
    role: "host" | "viewer";
    activity: MemberActivity;
};

export type RoomSpotlight = {
    id: string;
    lineIndex: number;
    snippet: string;
    byName: string;
    byColor: string;
    at: number;
};

export type TabShare = {
    code: string;
    role: "host" | "viewer";
    /** Stable UID of the host tab being broadcast, used to update saved guest copies. */
    originUid?: string;
    /** Set on a viewer tab once the host ended the broadcast. */
    ended?: boolean;
    /** History slice chosen when the host started the broadcast. */
    historyMode?: SharedHistoryMode;
    /** Index in the host tab where shared lines start. */
    startOffset?: number;
    /** Allow viewers to request game screenshots for Anki cards. */
    shareScreenshots?: boolean;
    /** Prevent new viewers from joining the room. */
    locked?: boolean;
    /** Viewer-side toggle: follow the host's timer pause/resume state. */
    syncTimer?: boolean;
};

export type RoomOp =
    | { t: "snapshot"; title?: string; lines: string[]; more?: boolean; hostOnline?: boolean }
    | { t: "append"; lines: string[] }
    | { t: "set"; index: number; text: string }
    | { t: "insert"; index: number; text: string }
    | { t: "remove"; index: number }
    | { t: "title"; title: string };

export type RoomMessage =
    | RoomOp
    | {
          t: "hello";
          title: string;
          originUid?: string;
          hostName?: string;
          hostColor?: string;
          timerRunning?: boolean;
          shareScreenshots?: boolean;
          locked?: boolean;
      }
    | {
          t: "presence";
          viewers: number;
          hostOnline: boolean;
          originUid?: string;
          members?: RoomMember[];
          timerRunning?: boolean;
          shareScreenshots?: boolean;
          locked?: boolean;
      }
    | { t: "join-meta"; name: string; color: string; activity: MemberActivity }
    | { t: "timer"; running: boolean }
    | { t: "spotlight"; id: string; lineIndex: number; snippet: string; byName: string; byColor: string }
    | { t: "kicked"; reason?: "kicked" | "locked" }
    | { t: "shot-req"; reqId: string }
    | { t: "shot-chunk"; reqId: string; index: number; total: number; data: string }
    | { t: "shot-err"; reqId: string; reason: string }
    | { t: "ended"; reason: string }
    /** Viewer → host: "introduce yourself again" (the first hello may be lost). */
    | { t: "hello-req" }
    /** Host → viewers heartbeat, so a silent host reads as away. */
    | { t: "ping"; at: number };

export type RoomConnection = "connecting" | "live" | "offline" | "ended";

const ROOM_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const APP_ID = "setsuna-shared-reading-v1";

export const SHARED_PROFILE_STORAGE_KEY = "setsuna_shared_reading_profile_v1";
export const SHARED_PROFILE_COLORS = [
    "#4fa6ff",
    "#3ecf8e",
    "#ff7b72",
    "#f2b84b",
    "#b388ff",
    "#ff79c6",
    "#4dd0e1",
    "#9ccc65",
] as const;

/**
 * Public Nostr relays on different hostings, none behind Cloudflare (which
 * some Russian providers throttle). Checked in November 2026; both sides use
 * the whole list, so any one relay reachable by both is enough.
 */
const RELAYS = [
    "wss://nos.lol",
    "wss://nostr.stakey.net",
    "wss://relay.piazza.today",
    "wss://relay.nostrmap.net",
    "wss://nostr.oxtr.dev",
    "wss://relay.snort.social",
    "wss://relay.degmods.com",
    "wss://offchain.pub",
    "wss://nostr.bitcoiner.social",
    "wss://relay.nostr.dev.br",
    "wss://testr.nymble.world",
    "wss://relay.kaleidoswap.com",
];

/** One message stays well under WebRTC data channel limits. */
const CHUNK_BYTES = 48 * 1024;
/** How long to wait for any relay before saying the network blocks them. */
const RELAY_GRACE_MS = 12000;
/** Host heartbeat; a viewer that hears nothing for HOST_SILENCE_MS treats the host as away. */
const HOST_HEARTBEAT_MS = 8000;
const HOST_SILENCE_MS = 25000;
/** A viewer without a host asks the room for one this often. */
const HELLO_RETRY_MS = 3000;
/** Messages kept from a peer that hasn't said hello yet (they arrive before it on some links). */
const EARLY_MESSAGE_LIMIT = 400;

const sendFailed = (side: string, type: string) => (error: unknown) => {
    console.warn(`[shared reading] ${side} could not send "${type}"`, error);
};
/** Default number of lines shared when starting in "recent" mode. */
export const RECENT_HISTORY_LINES = 50;

export const createTabUid = (): string => {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
        return crypto.randomUUID();
    }
    return `tab-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
};

/**
 * Merges incoming shared lines onto a guest's previously saved lines without duplicating
 * overlapping tail history (works across "all", "recent", and "new" broadcast modes).
 */
export function mergeSharedLines(
    existingLines: readonly string[],
    incomingLines: readonly string[],
): { lines: string[]; addedCount: number; overlapCount: number } {
    if (!incomingLines.length) {
        return { lines: [...existingLines], addedCount: 0, overlapCount: 0 };
    }
    if (!existingLines.length) {
        return { lines: [...incomingLines], addedCount: incomingLines.length, overlapCount: 0 };
    }

    const maxOverlap = Math.min(existingLines.length, incomingLines.length);
    for (let k = maxOverlap; k >= 1; k--) {
        let matches = true;
        const offset = existingLines.length - k;
        for (let i = 0; i < k; i++) {
            if (existingLines[offset + i] !== incomingLines[i]) {
                matches = false;
                break;
            }
        }
        if (matches) {
            const tail = incomingLines.slice(k);
            return {
                lines: [...existingLines, ...tail],
                addedCount: tail.length,
                overlapCount: k,
            };
        }
    }

    // Fallback anchor: if the host edited an earlier overlapping line slightly, locate
    // the guest's last line inside the incoming stream when uniquely present.
    if (incomingLines.length >= 3) {
        const lastExisting = existingLines[existingLines.length - 1]?.trim();
        if (lastExisting && lastExisting.length >= 6) {
            let matchIndex = -1;
            let multiple = false;
            for (let i = 0; i < incomingLines.length; i++) {
                if (incomingLines[i].trim() === lastExisting) {
                    if (matchIndex >= 0) {
                        multiple = true;
                        break;
                    }
                    matchIndex = i;
                }
            }
            if (!multiple && matchIndex >= 0) {
                const tail = incomingLines.slice(matchIndex + 1);
                return {
                    lines: [...existingLines, ...tail],
                    addedCount: tail.length,
                    overlapCount: matchIndex + 1,
                };
            }
        }
    }

    return {
        lines: [...existingLines, ...incomingLines],
        addedCount: incomingLines.length,
        overlapCount: 0,
    };
}

/**
 * Finds a local saved tab that previously came from the same host stream (`originUid`),
 * surviving tab renames on both sides. Prefers active tabs before archived ones.
 */
export function findMatchingSavedTab(
    tabs: readonly Tab[],
    viewerTab: Tab | null | undefined,
): Tab | null {
    const originUid = viewerTab?.shared?.originUid;
    if (!viewerTab || !originUid) return null;
    const candidates = tabs.filter(
        (t) =>
            t.id !== viewerTab.id
            && !t.shared
            && (!t.mode || t.mode === "text")
            && t.sharedOriginUid === originUid,
    );
    if (!candidates.length) return null;
    return candidates.find((t) => !t.archived) || candidates[0];
}

export const createRoomCode = () => {
    const bytes = new Uint8Array(6);
    crypto.getRandomValues(bytes);
    const chars = Array.from(bytes, (byte) => ROOM_ALPHABET[byte % ROOM_ALPHABET.length]).join("");
    return `${chars.slice(0, 3)}-${chars.slice(3)}`;
};

export const normalizeRoomCode = (value: string) => {
    const raw = String(value || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
    return raw.length === 6 ? `${raw.slice(0, 3)}-${raw.slice(3)}` : "";
};

const defaultProfile = (en = false): SharedProfile => ({
    name: en ? "Reader" : "Читатель",
    color: SHARED_PROFILE_COLORS[0],
});

const sanitizeProfile = (raw: unknown, en = false): SharedProfile => {
    const fallback = defaultProfile(en);
    if (!raw || typeof raw !== "object") return fallback;
    const candidate = raw as { name?: unknown; color?: unknown };
    const cleanName = typeof candidate.name === "string" ? candidate.name.trim().slice(0, 24) : "";
    const cleanColor =
        typeof candidate.color === "string" && /^#[0-9a-fA-F]{6}$/.test(candidate.color)
            ? candidate.color
            : fallback.color;
    return {
        name: cleanName || fallback.name,
        color: cleanColor,
    };
};

export function readSharedProfile(en = false): SharedProfile {
    if (typeof localStorage === "undefined") return defaultProfile(en);
    try {
        const raw = localStorage.getItem(SHARED_PROFILE_STORAGE_KEY);
        if (!raw) return defaultProfile(en);
        return sanitizeProfile(JSON.parse(raw), en);
    } catch {
        return defaultProfile(en);
    }
}

export function writeSharedProfile(profile: SharedProfile, en = false): SharedProfile {
    const clean = sanitizeProfile(profile, en);
    if (typeof localStorage !== "undefined") {
        try {
            localStorage.setItem(SHARED_PROFILE_STORAGE_KEY, JSON.stringify(clean));
        } catch {
            // Ignore storage failures.
        }
    }
    return clean;
}

export function resolveStartOffset(totalLines: number, mode: SharedHistoryMode): number {
    const len = Math.max(0, Math.floor(totalLines || 0));
    if (mode === "all") return 0;
    if (mode === "recent") return Math.max(0, len - RECENT_HISTORY_LINES);
    return len;
}

export function sliceSharedLines(lines: readonly string[], startOffset = 0): { lines: string[]; offset: number } {
    const offset = Math.max(0, Math.min(Math.floor(startOffset || 0), lines.length));
    return {
        lines: offset === 0 ? [...lines] : lines.slice(offset),
        offset,
    };
}

export function splitDataChunks(data: string, maxChunkChars = 36000): string[] {
    if (!data) return [];
    const chunks: string[] = [];
    for (let i = 0; i < data.length; i += maxChunkChars) {
        chunks.push(data.slice(i, i + maxChunkChars));
    }
    return chunks;
}

export function assembleDataChunks(parts: readonly (string | undefined)[]): string | null {
    if (!parts.length) return null;
    for (let i = 0; i < parts.length; i++) {
        if (typeof parts[i] !== "string") return null;
    }
    return parts.join("");
}

/**
 * Updates guest reading counters fairly: initial snapshot history doesn't inflate
 * characters-per-hour speed; subsequent snapshots and live ops count new text.
 */
export function applyViewerStatsDelta(
    current: Omit<TabStats, "time">,
    prevLines: readonly string[],
    nextLines: readonly string[],
    op: RoomOp,
    countStats: (text: string) => Omit<TabStats, "time">,
): Omit<TabStats, "time"> {
    if (op.t === "title") return current;
    if (op.t === "snapshot") {
        if (prevLines.length === 0) {
            return { chars: 0, words: 0, sentences: 0 };
        }
        const before = countStats(prevLines.join("\n"));
        const after = countStats(nextLines.join("\n"));
        return {
            chars: current.chars + Math.max(0, after.chars - before.chars),
            words: current.words + Math.max(0, after.words - before.words),
            sentences: current.sentences + Math.max(0, after.sentences - before.sentences),
        };
    }
    const removed = op.t === "set" || op.t === "remove" ? prevLines[op.index] ?? "" : "";
    const added = op.t === "append" ? op.lines.join("\n") : op.t === "set" || op.t === "insert" ? op.text : "";
    const before = countStats(removed);
    const after = countStats(added);
    return {
        chars: Math.max(0, current.chars - before.chars + after.chars),
        words: Math.max(0, current.words - before.words + after.words),
        sentences: Math.max(0, current.sentences - before.sentences + after.sentences),
    };
}

const roomIdFor = (code: string) => code.replace(/[^A-Za-z0-9]/g, "").toUpperCase();

const openRoom = (code: string, onJoinError: (error: string) => void): Room => joinRoom(
    {
        appId: APP_ID,
        password: `setsuna:${roomIdFor(code)}`,
        relayConfig: { urls: RELAYS, warnOnRelayFailure: false },
    },
    roomIdFor(code),
    { onJoinError: (details) => onJoinError(details.error) },
);

export const getRelayStats = (): { open: number; total: number } => {
    try {
        const sockets = Object.values((getRelaySockets() as Record<string, WebSocket>) || {});
        return {
            open: sockets.filter((socket) => socket?.readyState === 1).length,
            total: sockets.length || RELAYS.length,
        };
    } catch {
        return { open: 0, total: RELAYS.length };
    }
};

/** True while at least one relay connection is open. */
const anyRelayOpen = () => getRelayStats().open > 0;

/**
 * Reports "relays" when no relay could be reached for a while (the network
 * blocks them all), and clears it as soon as one connects.
 */
const watchRelays = (
    onChange: (reachable: boolean) => void,
    onStats?: (stats: { open: number; total: number }) => void,
) => {
    const startedAt = Date.now();
    let last: boolean | null = null;
    let lastOpen = -1;
    const check = () => {
        const stats = getRelayStats();
        if (stats.open !== lastOpen) {
            lastOpen = stats.open;
            onStats?.(stats);
        }
        const reachable = stats.open > 0;
        if (!reachable && Date.now() - startedAt < RELAY_GRACE_MS) return;
        if (reachable !== last) {
            last = reachable;
            onChange(reachable);
        }
    };
    const timer = window.setInterval(check, 1500);
    return () => window.clearInterval(timer);
};

/** Splits lines into pieces that fit one data channel message. */
const chunkLines = (lines: string[]) => {
    const chunks: string[][] = [];
    let current: string[] = [];
    let size = 0;
    for (const line of lines) {
        const bytes = line.length * 3 + 8;
        if (current.length && size + bytes > CHUNK_BYTES) {
            chunks.push(current);
            current = [];
            size = 0;
        }
        current.push(line);
        size += bytes;
    }
    chunks.push(current);
    return chunks;
};

const snapshotMessages = (title: string, lines: string[]): RoomMessage[] => {
    const chunks = chunkLines(lines);
    return chunks.map((chunk, index) => index === 0
        ? { t: "snapshot", title, lines: chunk, more: chunks.length > 1, hostOnline: true }
        : { t: "append", lines: chunk });
};

/** The host side: serves every viewer that joins the room. */
export class HostRoom {
    private readonly room: Room;
    private readonly send: (message: RoomMessage, target?: string) => void;
    private readonly viewers = new Set<string>();
    private readonly viewerMeta = new Map<string, RoomMember>();
    private readonly stopWatching: () => void;
    private readonly originUid: string;
    private profile: SharedProfile;
    private timerRunning: boolean;
    private shareScreenshots: boolean;
    private locked: boolean;
    private guestCounter = 0;
    private closed = false;
    private heartbeat = 0;

    constructor(
        code: string,
        private readonly handlers: {
            /** What a newly connected viewer gets: the text already broadcast. */
            snapshot: () => { title: string; lines: string[] };
            originUid: string;
            profile: SharedProfile;
            timerRunning: boolean;
            shareScreenshots: boolean;
            locked: boolean;
            onState: (state: RoomConnection) => void;
            onViewers: (count: number) => void;
            onMembers?: (members: RoomMember[]) => void;
            onSpotlight?: (spotlight: RoomSpotlight) => void;
            onCaptureScreenshot?: () => Promise<string | null>;
            onRelayStats?: (stats: { open: number; total: number }) => void;
            /** Why the room can't work ("" once it does). */
            onError?: (type: string) => void;
        },
    ) {
        this.originUid = handlers.originUid;
        this.profile = handlers.profile;
        this.timerRunning = handlers.timerRunning;
        this.shareScreenshots = handlers.shareScreenshots;
        this.locked = handlers.locked;

        handlers.onState("connecting");
        this.room = openRoom(code, (error) => {
            console.warn("[shared reading] host join error", error);
            handlers.onError?.("webrtc");
        });
        const action = this.room.makeAction<RoomMessage>("r");
        this.send = (message, target) => {
            void Promise.resolve()
                .then(() => action.send(message, target ? { target } : undefined))
                .catch(sendFailed("host", message.t));
        };

        action.onMessage = (message, context) => {
            if (this.closed || !message || typeof message !== "object" || typeof (message as RoomMessage).t !== "string") return;
            if (message.t === "hello-req") {
                // A viewer missed the hello (or joined before this side saw it): introduce again.
                this.admit(context.peerId);
                return;
            }
            if (!this.viewers.has(context.peerId)) return;

            if (message.t === "join-meta") {
                const prev = this.viewerMeta.get(context.peerId);
                this.viewerMeta.set(context.peerId, {
                    id: context.peerId,
                    name: typeof message.name === "string" && message.name.trim()
                        ? message.name.trim().slice(0, 24)
                        : prev?.name || "Guest",
                    color: typeof message.color === "string" && /^#[0-9a-fA-F]{6}$/.test(message.color)
                        ? message.color
                        : prev?.color || SHARED_PROFILE_COLORS[1],
                    role: "viewer",
                    activity: message.activity || "reading",
                });
                this.presence();
            } else if (message.t === "spotlight") {
                const sender = this.viewerMeta.get(context.peerId);
                const relayed: RoomMessage = {
                    t: "spotlight",
                    id: message.id,
                    lineIndex: message.lineIndex,
                    snippet: String(message.snippet || "").slice(0, 80),
                    byName: sender?.name || message.byName,
                    byColor: sender?.color || message.byColor,
                };
                this.broadcast(relayed);
                this.handlers.onSpotlight?.({
                    id: relayed.id,
                    lineIndex: relayed.lineIndex,
                    snippet: relayed.snippet,
                    byName: relayed.byName,
                    byColor: relayed.byColor,
                    at: Date.now(),
                });
            } else if (message.t === "shot-req") {
                if (!this.shareScreenshots || !this.handlers.onCaptureScreenshot) {
                    this.send({ t: "shot-err", reqId: message.reqId, reason: "disabled" }, context.peerId);
                    return;
                }
                void Promise.resolve(this.handlers.onCaptureScreenshot())
                    .then((dataUrl) => {
                        if (this.closed) return;
                        if (!dataUrl) {
                            this.send({ t: "shot-err", reqId: message.reqId, reason: "unavailable" }, context.peerId);
                            return;
                        }
                        const chunks = splitDataChunks(dataUrl);
                        if (!chunks.length) {
                            this.send({ t: "shot-err", reqId: message.reqId, reason: "unavailable" }, context.peerId);
                            return;
                        }
                        chunks.forEach((data, idx) => {
                            this.send(
                                { t: "shot-chunk", reqId: message.reqId, index: idx, total: chunks.length, data },
                                context.peerId,
                            );
                        });
                    })
                    .catch(() => {
                        if (!this.closed) {
                            this.send({ t: "shot-err", reqId: message.reqId, reason: "unavailable" }, context.peerId);
                        }
                    });
            }
        };

        this.room.onPeerJoin = (peerId) => this.admit(peerId);
        this.room.onPeerLeave = (peerId) => {
            this.viewerMeta.delete(peerId);
            if (this.viewers.delete(peerId)) this.presence();
        };
        this.stopWatching = watchRelays(
            (reachable) => {
                if (this.closed) return;
                handlers.onError?.(reachable ? "" : "relays");
                handlers.onState(reachable ? "live" : "offline");
            },
            (stats) => {
                if (!this.closed) handlers.onRelayStats?.(stats);
            },
        );
        // Report host member immediately so UI always shows host badge.
        this.presence();
        // Usually a relay connects within a second or two.
        window.setTimeout(() => { if (!this.closed && anyRelayOpen()) handlers.onState("live"); }, 1500);
        this.heartbeat = window.setInterval(() => {
            if (!this.closed) this.broadcast({ t: "ping", at: Date.now() });
        }, HOST_HEARTBEAT_MS);
    }

    /** Greets a peer: hello, then the text so far. A known viewer is simply re-synced. */
    private admit(peerId: string) {
        if (this.closed) return;
        if (!this.viewers.has(peerId)) {
            if (this.locked) {
                this.send({ t: "kicked", reason: "locked" }, peerId);
                return;
            }
            this.guestCounter += 1;
            const color = SHARED_PROFILE_COLORS[this.guestCounter % SHARED_PROFILE_COLORS.length];
            this.viewers.add(peerId);
            this.viewerMeta.set(peerId, {
                id: peerId,
                name: `Guest ${this.guestCounter}`,
                color,
                role: "viewer",
                activity: "reading",
            });
        }
        const { title, lines } = this.handlers.snapshot();
        this.send(
            {
                t: "hello",
                title,
                originUid: this.originUid,
                hostName: this.profile.name,
                hostColor: this.profile.color,
                timerRunning: this.timerRunning,
                shareScreenshots: this.shareScreenshots,
                locked: this.locked,
            },
            peerId,
        );
        snapshotMessages(title, lines).forEach((message) => this.send(message, peerId));
        this.presence();
    }

    private allMembers(): RoomMember[] {
        const hostMember: RoomMember = {
            id: "host",
            name: this.profile.name,
            color: this.profile.color,
            role: "host",
            activity: "reading",
        };
        return [hostMember, ...Array.from(this.viewerMeta.values())];
    }

    private presence() {
        const viewers = this.viewers.size;
        const members = this.allMembers();
        this.handlers.onViewers(viewers);
        this.handlers.onMembers?.(members);
        this.broadcast({
            t: "presence",
            viewers,
            hostOnline: true,
            originUid: this.originUid,
            members,
            timerRunning: this.timerRunning,
            shareScreenshots: this.shareScreenshots,
            locked: this.locked,
        });
    }

    setProfile(profile: SharedProfile) {
        this.profile = profile;
        this.presence();
    }

    setTimerRunning(running: boolean) {
        if (this.timerRunning === running) return;
        this.timerRunning = running;
        this.broadcast({ t: "timer", running });
        this.presence();
    }

    setShareScreenshots(enabled: boolean) {
        if (this.shareScreenshots === enabled) return;
        this.shareScreenshots = enabled;
        this.presence();
    }

    setLocked(locked: boolean) {
        if (this.locked === locked) return;
        this.locked = locked;
        this.presence();
    }

    kick(peerId: string) {
        if (!this.viewers.has(peerId)) return;
        this.send({ t: "kicked", reason: "kicked" }, peerId);
        this.viewers.delete(peerId);
        this.viewerMeta.delete(peerId);
        this.presence();
    }

    broadcastSpotlight(spotlight: Omit<RoomSpotlight, "at">) {
        this.broadcast({
            t: "spotlight",
            id: spotlight.id,
            lineIndex: spotlight.lineIndex,
            snippet: spotlight.snippet,
            byName: spotlight.byName,
            byColor: spotlight.byColor,
        });
        this.handlers.onSpotlight?.({ ...spotlight, at: Date.now() });
    }

    broadcast(message: RoomMessage) {
        if (this.viewers.size) this.send(message);
    }

    broadcastSnapshot(title: string, lines: string[]) {
        if (!this.viewers.size) return;
        snapshotMessages(title, lines).forEach((message) => this.send(message));
    }

    /** Tells every viewer the broadcast is over, then leaves the room. */
    end() {
        this.broadcast({ t: "ended", reason: "ended" });
        this.closed = true;
        window.clearInterval(this.heartbeat);
        this.stopWatching();
        window.setTimeout(() => { void this.room.leave(); }, 600);
    }

    close() {
        this.closed = true;
        window.clearInterval(this.heartbeat);
        this.stopWatching();
        void this.room.leave();
    }
}

/** The viewer side: follows the host while it is in the room. */
export class ViewerRoom {
    private readonly room: Room;
    private readonly send: (message: RoomMessage, target?: string) => void;
    private readonly stopWatching: () => void;
    private readonly pendingShots = new Map<
        string,
        { parts: (string | undefined)[]; total: number; resolve: (url: string | null) => void; timer: number }
    >();
    private hostId: string | null = null;
    private profile: SharedProfile;
    private activity: MemberActivity;
    private closed = false;
    private lastHostAt = 0;
    private watchdog = 0;
    private readonly early = new Map<string, RoomMessage[]>();
    private readonly handlers: {
        onMessage: (message: RoomMessage) => void;
        onState: (state: RoomConnection) => void;
        onRelayStats?: (stats: { open: number; total: number }) => void;
        onError?: (type: string) => void;
    };

    constructor(
        code: string,
        handlers: {
            profile: SharedProfile;
            initialActivity?: MemberActivity;
            onMessage: (message: RoomMessage) => void;
            onState: (state: RoomConnection) => void;
            onRelayStats?: (stats: { open: number; total: number }) => void;
            onError?: (type: string) => void;
        },
    ) {
        this.profile = handlers.profile;
        this.activity = handlers.initialActivity || "reading";

        handlers.onState("connecting");
        this.room = openRoom(code, (error) => {
            console.warn("[shared reading] viewer join error", error);
            handlers.onError?.("webrtc");
        });
        const action = this.room.makeAction<RoomMessage>("r");
        this.send = (message, target) => {
            void Promise.resolve()
                .then(() => action.send(message, target ? { target } : undefined))
                .catch(sendFailed("viewer", message.t));
        };
        this.handlers = handlers;

        action.onMessage = (message, context) => {
            if (this.closed || !message || typeof message !== "object" || typeof (message as RoomMessage).t !== "string") return;
            this.receive(message, context.peerId);
        };
        this.room.onPeerJoin = (peerId) => {
            // The host greets every new peer; if that greeting is lost, ask for it.
            window.setTimeout(() => {
                if (!this.closed && !this.hostId) this.send({ t: "hello-req" }, peerId);
            }, 1500);
        };
        this.room.onPeerLeave = (peerId) => {
            this.early.delete(peerId);
            if (this.closed || peerId !== this.hostId) return;
            this.hostAway();
        };
        // No host yet: keep asking the room. Host silent too long: it is away.
        this.watchdog = window.setInterval(() => {
            if (this.closed) return;
            if (!this.hostId) {
                this.send({ t: "hello-req" });
            } else if (Date.now() - this.lastHostAt > HOST_SILENCE_MS) {
                this.hostAway();
            }
        }, HELLO_RETRY_MS);
        this.stopWatching = watchRelays(
            (reachable) => {
                if (this.closed || this.hostId) return;
                handlers.onError?.(reachable ? "" : "relays");
                if (!reachable) handlers.onState("offline");
            },
            (stats) => {
                if (!this.closed) handlers.onRelayStats?.(stats);
            },
        );
    }

    private receive(message: RoomMessage, peerId: string) {
        const handlers = this.handlers;
        if (message.t === "hello-req") return; // another viewer looking for the host
        // Only the peer that introduced itself as the host may change the text.
        if (message.t === "hello") {
            const fresh = this.hostId !== peerId;
            this.hostId = peerId;
            this.lastHostAt = Date.now();
            handlers.onError?.("");
            handlers.onState("live");
            if (fresh) {
                this.send(
                    { t: "join-meta", name: this.profile.name, color: this.profile.color, activity: this.activity },
                    peerId,
                );
            }
            handlers.onMessage(message);
            // Anything this peer sent before its hello (snapshot, appends) applies now, in order.
            const early = this.early.get(peerId);
            this.early.delete(peerId);
            early?.forEach((queued) => this.receive(queued, peerId));
            return;
        }
        if (message.t === "kicked") {
            if (this.hostId && peerId !== this.hostId) return;
            handlers.onMessage(message);
            handlers.onState("ended");
            this.close();
            return;
        }
        if (peerId !== this.hostId) {
            if (!this.hostId) {
                const queue = this.early.get(peerId) || [];
                if (queue.length < EARLY_MESSAGE_LIMIT) queue.push(message);
                this.early.set(peerId, queue);
            }
            return;
        }
        const wasAway = Date.now() - this.lastHostAt > HOST_SILENCE_MS;
        this.lastHostAt = Date.now();
        if (wasAway) handlers.onState("live");
        if (message.t === "ping") return;
        if (message.t === "shot-chunk") {
            const pending = this.pendingShots.get(message.reqId);
            if (!pending) return;
            if (message.total > 0 && message.index >= 0 && message.index < message.total) {
                if (pending.total !== message.total) {
                    pending.total = message.total;
                    pending.parts = new Array<string | undefined>(message.total);
                }
                pending.parts[message.index] = message.data;
                const assembled = assembleDataChunks(pending.parts);
                if (assembled !== null) {
                    window.clearTimeout(pending.timer);
                    this.pendingShots.delete(message.reqId);
                    pending.resolve(assembled);
                }
            }
            return;
        }
        if (message.t === "shot-err") {
            const pending = this.pendingShots.get(message.reqId);
            if (pending) {
                window.clearTimeout(pending.timer);
                this.pendingShots.delete(message.reqId);
                pending.resolve(null);
            }
            return;
        }
        if (message.t === "ended") {
            handlers.onMessage(message);
            handlers.onState("ended");
            this.close();
            return;
        }
        handlers.onMessage(message);
    }

    /** The host left or went silent: say so and keep asking until it is back. */
    private hostAway() {
        if (!this.hostId) return;
        this.hostId = null;
        this.clearPendingShots();
        this.handlers.onMessage({ t: "presence", viewers: 0, hostOnline: false });
        this.handlers.onState("offline");
    }

    private clearPendingShots() {
        for (const pending of this.pendingShots.values()) {
            window.clearTimeout(pending.timer);
            pending.resolve(null);
        }
        this.pendingShots.clear();
    }

    sendMeta(profile: SharedProfile, activity: MemberActivity) {
        this.profile = profile;
        this.activity = activity;
        if (!this.closed && this.hostId) {
            this.send({ t: "join-meta", name: profile.name, color: profile.color, activity }, this.hostId);
        }
    }

    sendSpotlight(spotlight: Omit<RoomSpotlight, "at">) {
        if (!this.closed && this.hostId) {
            this.send(
                {
                    t: "spotlight",
                    id: spotlight.id,
                    lineIndex: spotlight.lineIndex,
                    snippet: spotlight.snippet,
                    byName: spotlight.byName,
                    byColor: spotlight.byColor,
                },
                this.hostId,
            );
        }
    }

    requestScreenshot(): Promise<string | null> {
        if (this.closed || !this.hostId) return Promise.resolve(null);
        const reqId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
        return new Promise<string | null>((resolve) => {
            const timer = window.setTimeout(() => {
                this.pendingShots.delete(reqId);
                resolve(null);
            }, 6500);
            this.pendingShots.set(reqId, { parts: [], total: 0, resolve, timer });
            this.send({ t: "shot-req", reqId }, this.hostId!);
        });
    }

    close() {
        this.closed = true;
        window.clearInterval(this.watchdog);
        this.early.clear();
        this.stopWatching();
        this.clearPendingShots();
        void this.room.leave();
    }
}

/**
 * Turns a change of the host tab into room operations. Typing, hooking and
 * the editor change one line at a time, so most changes are one small op;
 * anything else is sent as a fresh snapshot.
 */
export const diffLines = (prev: string[], next: string[]): RoomOp[] | "snapshot" => {
    if (prev === next) return [];
    const p = prev.length;
    const n = next.length;
    let start = 0;
    while (start < p && start < n && prev[start] === next[start]) start++;
    if (start === p && start === n) return [];
    if (start === p) return [{ t: "append", lines: next.slice(p) }];
    let endPrev = p - 1;
    let endNext = n - 1;
    while (endPrev >= start && endNext >= start && prev[endPrev] === next[endNext]) { endPrev--; endNext--; }
    const removed = endPrev - start + 1;
    const added = endNext - start + 1;
    if (removed === 1 && added === 1) return [{ t: "set", index: start, text: next[start] }];
    if (removed === 0 && added === 1) return [{ t: "insert", index: start, text: next[start] }];
    if (removed === 1 && added === 0) return [{ t: "remove", index: start }];
    if (removed + added <= 20) {
        const ops: RoomOp[] = [];
        for (let i = 0; i < removed; i++) ops.push({ t: "remove", index: start });
        for (let i = 0; i < added; i++) ops.push({ t: "insert", index: start + i, text: next[start + i] });
        return ops;
    }
    return "snapshot";
};

/** Applies a room operation to a viewer tab's lines. */
export const applyRoomOp = (lines: string[], op: RoomOp): string[] => {
    switch (op.t) {
        case "snapshot": return [...op.lines];
        case "append": return [...lines, ...op.lines];
        case "set": {
            if (op.index < 0 || op.index >= lines.length) return lines;
            const next = [...lines];
            next[op.index] = op.text;
            return next;
        }
        case "insert": {
            const next = [...lines];
            next.splice(Math.max(0, Math.min(op.index, next.length)), 0, op.text);
            return next;
        }
        case "remove": {
            if (op.index < 0 || op.index >= lines.length) return lines;
            const next = [...lines];
            next.splice(op.index, 1);
            return next;
        }
        default: return lines;
    }
};
