import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";

// HostRoom / ViewerRoom over a fake Trystero room: checks the recovery paths
// that keep a viewer in sync when the first hello is lost or arrives late.

globalThis.window = globalThis;

const fakeTrystero = `
export const rooms = [];
export const getRelaySockets = () => ({ a: { readyState: 1 } });
export function joinRoom(config, roomId) {
    const sent = [];
    const action = { onMessage: null, send: (message, options) => { sent.push({ message, target: options?.target }); return Promise.resolve(); } };
    const room = { roomId, sent, action, onPeerJoin: null, onPeerLeave: null, left: false,
        makeAction: () => action, leave: () => { room.left = true; return Promise.resolve(); } };
    rooms.push(room);
    return room;
}`;

const bundle = await build({
    stdin: {
        contents: "export * from './src/utils/sharedReading'; export { rooms } from 'trystero/nostr';",
        resolveDir: process.cwd(),
        loader: "ts",
    },
    bundle: true,
    write: false,
    format: "esm",
    platform: "node",
    plugins: [{
        name: "fake-trystero",
        setup(b) {
            b.onResolve({ filter: /^trystero\/nostr$/ }, () => ({ path: "fake", namespace: "fake" }));
            b.onLoad({ filter: /.*/, namespace: "fake" }, () => ({ contents: fakeTrystero, loader: "js" }));
        },
    }],
});

const mod = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`);
const { ViewerRoom, HostRoom, rooms } = mod;
const profile = { name: "Me", color: "#4fa6ff" };

const viewer = () => {
    const got = [];
    const states = [];
    const room = new ViewerRoom("ABC-123", {
        profile,
        onMessage: (message) => got.push(message),
        onState: (state) => states.push(state),
    });
    return { room, raw: rooms[rooms.length - 1], got, states };
};

test("viewer applies a snapshot that arrived before the host's hello", () => {
    const { room, raw, got, states } = viewer();
    raw.action.onMessage({ t: "snapshot", title: "VN", lines: ["一", "二"] }, { peerId: "host" });
    assert.equal(got.length, 0, "nothing applied before the hello");
    raw.action.onMessage({ t: "hello", title: "VN" }, { peerId: "host" });
    assert.deepEqual(got.map((m) => m.t), ["hello", "snapshot"]);
    assert.equal(states.at(-1), "live");
    room.close();
});

test("viewer ignores text from a peer that never introduced itself as host", () => {
    const { room, raw, got } = viewer();
    raw.action.onMessage({ t: "hello", title: "VN" }, { peerId: "host" });
    raw.action.onMessage({ t: "append", lines: ["fake"] }, { peerId: "other-viewer" });
    raw.action.onMessage({ t: "hello-req" }, { peerId: "other-viewer" });
    assert.deepEqual(got.map((m) => m.t), ["hello"]);
    room.close();
});

test("viewer asks a new peer for a hello when none came", async () => {
    const { room, raw } = viewer();
    raw.onPeerJoin("host");
    await new Promise((resolve) => setTimeout(resolve, 1600));
    assert.ok(raw.sent.some((s) => s.message.t === "hello-req" && s.target === "host"));
    room.close();
});

test("host answers hello-req with hello and the text so far, even for an unseen peer", async () => {
    const viewers = [];
    const host = new HostRoom("ABC-123", {
        snapshot: () => ({ title: "VN", lines: ["一", "二"] }),
        originUid: "tab-1",
        profile,
        timerRunning: false,
        shareScreenshots: false,
        locked: false,
        onState: () => {},
        onViewers: (count) => viewers.push(count),
    });
    const raw = rooms[rooms.length - 1];
    raw.action.onMessage({ t: "hello-req" }, { peerId: "phone" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const toPhone = raw.sent.filter((s) => s.target === "phone").map((s) => s.message.t);
    assert.deepEqual(toPhone.slice(0, 2), ["hello", "snapshot"]);
    assert.equal(viewers.at(-1), 1);
    host.close();
});

test("a locked host turns away an unknown peer's hello-req", async () => {
    const host = new HostRoom("ABC-123", {
        snapshot: () => ({ title: "VN", lines: [] }),
        originUid: "tab-1",
        profile,
        timerRunning: false,
        shareScreenshots: false,
        locked: true,
        onState: () => {},
        onViewers: () => {},
    });
    const raw = rooms[rooms.length - 1];
    raw.action.onMessage({ t: "hello-req" }, { peerId: "stranger" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(raw.sent.filter((s) => s.target === "stranger").map((s) => s.message.t), ["kicked"]);
    host.close();
});

test("host leaving marks the viewer offline; a new hello brings it back", () => {
    const { room, raw, got, states } = viewer();
    raw.action.onMessage({ t: "hello", title: "VN" }, { peerId: "host" });
    raw.onPeerLeave("host");
    assert.equal(states.at(-1), "offline");
    assert.equal(got.at(-1).t, "presence");
    assert.equal(got.at(-1).hostOnline, false);
    raw.action.onMessage({ t: "hello", title: "VN" }, { peerId: "host-again" });
    assert.equal(states.at(-1), "live");
    room.close();
});
