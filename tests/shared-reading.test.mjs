import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";

const store = new Map();
globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
};

const bundle = await build({
    stdin: {
        contents: "export * from './src/utils/sharedReading';",
        resolveDir: process.cwd(),
        loader: "ts",
    },
    bundle: true,
    write: false,
    format: "esm",
    platform: "node",
});

const mod = await import(
    `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`
);

const {
    RECENT_HISTORY_LINES,
    SHARED_PROFILE_STORAGE_KEY,
    applyRoomOp,
    applyViewerStatsDelta,
    assembleDataChunks,
    createRoomCode,
    createTabUid,
    diffLines,
    findMatchingSavedTab,
    mergeSharedLines,
    normalizeRoomCode,
    readSharedProfile,
    resolveStartOffset,
    sliceSharedLines,
    splitDataChunks,
    writeSharedProfile,
} = mod;

beforeEach(() => {
    store.clear();
});

test("createRoomCode and normalizeRoomCode format 6-char room codes", () => {
    const code = createRoomCode();
    assert.match(code, /^[A-Z0-9]{3}-[A-Z0-9]{3}$/);
    assert.equal(normalizeRoomCode(" abc123 "), "ABC-123");
    assert.equal(normalizeRoomCode("ab-12"), "");
});

test("diffLines and applyRoomOp round-trip append, set, insert, remove", () => {
    const base = ["a", "b", "c"];
    const ops1 = diffLines(base, ["a", "b", "c", "d"]);
    assert.deepEqual(ops1, [{ t: "append", lines: ["d"] }]);
    assert.deepEqual(ops1.reduce(applyRoomOp, base), ["a", "b", "c", "d"]);

    const ops2 = diffLines(["a", "b", "c"], ["a", "B", "c"]);
    assert.deepEqual(ops2, [{ t: "set", index: 1, text: "B" }]);
    assert.deepEqual(ops2.reduce(applyRoomOp, ["a", "b", "c"]), ["a", "B", "c"]);

    const ops3 = diffLines(["a", "c"], ["a", "b", "c"]);
    assert.deepEqual(ops3, [{ t: "insert", index: 1, text: "b" }]);
    assert.deepEqual(ops3.reduce(applyRoomOp, ["a", "c"]), ["a", "b", "c"]);

    const ops4 = diffLines(["a", "b", "c"], ["a", "c"]);
    assert.deepEqual(ops4, [{ t: "remove", index: 1 }]);
    assert.deepEqual(ops4.reduce(applyRoomOp, ["a", "b", "c"]), ["a", "c"]);
});

test("resolveStartOffset and sliceSharedLines handle new, recent, all, and shrinking host tabs", () => {
    assert.equal(resolveStartOffset(120, "all"), 0);
    assert.equal(resolveStartOffset(120, "recent"), 120 - RECENT_HISTORY_LINES);
    assert.equal(resolveStartOffset(20, "recent"), 0);
    assert.equal(resolveStartOffset(120, "new"), 120);

    const lines = ["l0", "l1", "l2", "l3", "l4"];
    assert.deepEqual(sliceSharedLines(lines, 3), { lines: ["l3", "l4"], offset: 3 });
    assert.deepEqual(sliceSharedLines(["only0"], 10), { lines: [], offset: 1 });
});

test("splitDataChunks and assembleDataChunks reassemble arbitrary screenshots", () => {
    const payload = "data:image/jpeg;base64," + "A".repeat(80000);
    const chunks = splitDataChunks(payload, 30000);
    assert.equal(chunks.length, 3);
    assert.equal(assembleDataChunks(chunks), payload);
    assert.equal(assembleDataChunks([chunks[0], undefined, chunks[2]]), null);
});

test("applyViewerStatsDelta avoids counting initial backlog while tracking live reading", () => {
    const count = (text) => {
        const clean = text.replace(/\s+/g, "");
        return { chars: clean.length, words: text ? text.trim().split(/\s+/).length : 0, sentences: text ? 1 : 0 };
    };
    const initial = applyViewerStatsDelta(
        { chars: 0, words: 0, sentences: 0 },
        [],
        ["история 1", "история 2"],
        { t: "snapshot", lines: ["история 1", "история 2"] },
        count,
    );
    assert.deepEqual(initial, { chars: 0, words: 0, sentences: 0 });

    const afterAppend = applyViewerStatsDelta(
        initial,
        ["история 1", "история 2"],
        ["история 1", "история 2", "новая строка"],
        { t: "append", lines: ["новая строка"] },
        count,
    );
    assert.equal(afterAppend.chars, "новаястрока".length);
    assert.equal(afterAppend.sentences, 1);
});

test("readSharedProfile and writeSharedProfile sanitize and handle corrupt storage", () => {
    const def = readSharedProfile(false);
    assert.equal(def.name, "Читатель");

    writeSharedProfile({ name: "  Seri  ", color: "#3ecf8e" }, false);
    assert.deepEqual(readSharedProfile(false), { name: "Seri", color: "#3ecf8e" });

    store.set(SHARED_PROFILE_STORAGE_KEY, "{broken json");
    assert.equal(readSharedProfile(true).name, "Reader");
});

test("createTabUid creates distinct non-empty persistent ids", () => {
    const a = createTabUid();
    const b = createTabUid();
    assert.ok(a.length >= 8);
    assert.notEqual(a, b);
});

test("mergeSharedLines deduplicates recent/all overlaps, handles new lines and typo anchor", () => {
    // Overlap across recent/all
    const m1 = mergeSharedLines(["l1", "l2", "l3", "l4"], ["l3", "l4", "l5", "l6"]);
    assert.deepEqual(m1, { lines: ["l1", "l2", "l3", "l4", "l5", "l6"], addedCount: 2, overlapCount: 2 });

    // Full overlap (nothing new)
    const m2 = mergeSharedLines(["l1", "l2", "l3"], ["l2", "l3"]);
    assert.deepEqual(m2, { lines: ["l1", "l2", "l3"], addedCount: 0, overlapCount: 2 });

    // New-only continuation
    const m3 = mergeSharedLines(["l1", "l2"], ["l3", "l4"]);
    assert.deepEqual(m3, { lines: ["l1", "l2", "l3", "l4"], addedCount: 2, overlapCount: 0 });

    // Anchor fallback when an earlier overlapping line was edited on host
    const m4 = mergeSharedLines(
        ["old headline", "guest's last line here"],
        ["edited headline", "guest's last line here", "brand new sentence"],
    );
    assert.deepEqual(m4, {
        lines: ["old headline", "guest's last line here", "brand new sentence"],
        addedCount: 1,
        overlapCount: 2,
    });
});

test("findMatchingSavedTab locates saved tab by originUid regardless of renames and prefers active over archived", () => {
    const viewerTab = { id: 99, name: "Host Renamed VN", shared: { code: "ABC-123", role: "viewer", originUid: "host-uid-1" } };
    const archivedSaved = { id: 2, name: "My Custom Renamed Archive", archived: true, sharedOriginUid: "host-uid-1" };
    const activeSaved = { id: 3, name: "My Custom Name", archived: false, sharedOriginUid: "host-uid-1" };
    const otherTab = { id: 4, name: "Host Renamed VN", sharedOriginUid: "other-uid" };

    assert.equal(findMatchingSavedTab([otherTab, archivedSaved, viewerTab], viewerTab)?.id, 2);
    assert.equal(findMatchingSavedTab([archivedSaved, activeSaved, viewerTab], viewerTab)?.id, 3);
    assert.equal(findMatchingSavedTab([otherTab, viewerTab], viewerTab), null);
});
