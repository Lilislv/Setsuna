import { getRelaySockets, joinRoom, type Room } from "trystero/nostr";

// Shared reading, peer to peer: the host's Setsuna holds the room. Viewers
// connect straight to it over WebRTC. To find each other both sides announce
// themselves on several independent public Nostr relays at once (Trystero):
// one blocked or dead relay doesn't matter while any other one works for both.
// The connection details sent through relays are encrypted with the room code.
// Nothing is stored anywhere: while the host is away viewers keep their text.

export type TabShare = {
    code: string;
    role: "host" | "viewer";
    /** Set on a viewer tab once the host ended the broadcast. */
    ended?: boolean;
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
    | { t: "hello"; title: string }
    | { t: "presence"; viewers: number; hostOnline: boolean }
    | { t: "ended"; reason: string };

export type RoomConnection = "connecting" | "live" | "offline" | "ended";

const ROOM_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const APP_ID = "setsuna-shared-reading-v1";

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

/** True while at least one relay connection is open. */
const anyRelayOpen = () => {
    try {
        const sockets = getRelaySockets() as Record<string, WebSocket>;
        return Object.values(sockets || {}).some((socket) => socket?.readyState === 1);
    } catch {
        return false;
    }
};

/**
 * Reports "relays" when no relay could be reached for a while (the network
 * blocks them all), and clears it as soon as one connects.
 */
const watchRelays = (onChange: (reachable: boolean) => void) => {
    const startedAt = Date.now();
    let last: boolean | null = null;
    const check = () => {
        const reachable = anyRelayOpen();
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
    private readonly stopWatching: () => void;
    private closed = false;

    constructor(
        code: string,
        private readonly handlers: {
            /** What a newly connected viewer gets: the text already broadcast. */
            snapshot: () => { title: string; lines: string[] };
            onState: (state: RoomConnection) => void;
            onViewers: (count: number) => void;
            /** Why the room can't work ("" once it does). */
            onError?: (type: string) => void;
        },
    ) {
        handlers.onState("connecting");
        this.room = openRoom(code, (error) => {
            console.warn("[shared reading] host join error", error);
            handlers.onError?.("webrtc");
        });
        const action = this.room.makeAction<RoomMessage>("r");
        this.send = (message, target) => { void action.send(message, target ? { target } : undefined).catch(() => {}); };
        this.room.onPeerJoin = (peerId) => {
            if (this.closed) return;
            this.viewers.add(peerId);
            const { title, lines } = handlers.snapshot();
            this.send({ t: "hello", title }, peerId);
            snapshotMessages(title, lines).forEach((message) => this.send(message, peerId));
            this.presence();
        };
        this.room.onPeerLeave = (peerId) => {
            if (this.viewers.delete(peerId)) this.presence();
        };
        this.stopWatching = watchRelays((reachable) => {
            if (this.closed) return;
            handlers.onError?.(reachable ? "" : "relays");
            handlers.onState(reachable ? "live" : "offline");
        });
        // Usually a relay connects within a second or two.
        window.setTimeout(() => { if (!this.closed && anyRelayOpen()) handlers.onState("live"); }, 1500);
    }

    private presence() {
        const viewers = this.viewers.size;
        this.handlers.onViewers(viewers);
        this.broadcast({ t: "presence", viewers, hostOnline: true });
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
        this.stopWatching();
        window.setTimeout(() => { void this.room.leave(); }, 600);
    }

    close() {
        this.closed = true;
        this.stopWatching();
        void this.room.leave();
    }
}

/** The viewer side: follows the host while it is in the room. */
export class ViewerRoom {
    private readonly room: Room;
    private readonly stopWatching: () => void;
    private hostId: string | null = null;
    private closed = false;

    constructor(
        code: string,
        handlers: {
            onMessage: (message: RoomMessage) => void;
            onState: (state: RoomConnection) => void;
            onError?: (type: string) => void;
        },
    ) {
        handlers.onState("connecting");
        this.room = openRoom(code, (error) => {
            console.warn("[shared reading] viewer join error", error);
            handlers.onError?.("webrtc");
        });
        const action = this.room.makeAction<RoomMessage>("r");
        action.onMessage = (message, context) => {
            if (this.closed || !message || typeof message !== "object" || typeof (message as RoomMessage).t !== "string") return;
            // Only the peer that introduced itself as the host may change the text.
            if (message.t === "hello") {
                this.hostId = context.peerId;
                handlers.onError?.("");
                handlers.onState("live");
                return;
            }
            if (context.peerId !== this.hostId) return;
            if (message.t === "ended") {
                handlers.onMessage(message);
                handlers.onState("ended");
                this.close();
                return;
            }
            handlers.onMessage(message);
        };
        this.room.onPeerLeave = (peerId) => {
            if (this.closed || peerId !== this.hostId) return;
            this.hostId = null;
            handlers.onMessage({ t: "presence", viewers: 0, hostOnline: false });
            handlers.onState("offline");
        };
        this.stopWatching = watchRelays((reachable) => {
            if (this.closed || this.hostId) return;
            handlers.onError?.(reachable ? "" : "relays");
            if (!reachable) handlers.onState("offline");
        });
    }

    close() {
        this.closed = true;
        this.stopWatching();
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
