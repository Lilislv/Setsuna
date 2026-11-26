import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";

const bundle = await build({
    stdin: { contents: "export * from './src/utils/mobileSources';", resolveDir: process.cwd(), loader: "ts" },
    bundle: true,
    write: false,
    format: "esm",
    platform: "node",
    // appRuntime imports app types only; nothing else from the UI is needed.
    external: ["@tauri-apps/*"],
});
const { addWsSource, removeWsSource, updateWsSource, primaryWsSource, sameWsUrl, defaultSourceName } = await import(
    `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`
);

const pc = { id: "a", name: "PC", url: "ws://192.168.0.40:9003", active: true };
const deck = { id: "b", name: "Deck", url: "ws://192.168.0.50:6677", active: false };

test("adding keeps every existing source", () => {
    const result = addWsSource([pc, deck], "192.168.0.60:9001");
    assert.equal(result.added, true);
    assert.equal(result.list.length, 3);
    assert.deepEqual(result.list.slice(0, 2), [pc, deck]);
    assert.equal(result.list[2].url, "ws://192.168.0.60:9001");
    assert.equal(result.list[2].name, "192.168.0.60:9001");
});

test("adding a known address reuses it and switches it on", () => {
    const result = addWsSource([pc, deck], "ws://192.168.0.50:6677/");
    assert.equal(result.added, false);
    assert.equal(result.id, "b");
    assert.equal(result.list.length, 2);
    assert.equal(result.list[1].active, true);
});

test("removing the main source hands the role to the next one", () => {
    assert.deepEqual(removeWsSource([pc, deck], "a", "a"), { list: [deck], primaryId: "b" });
    assert.deepEqual(removeWsSource([pc, deck], "a", "b"), { list: [pc], primaryId: "a" });
    assert.deepEqual(removeWsSource([pc], "a", "a"), { list: [], primaryId: "" });
});

test("editing normalizes the address and falls back to a readable name", () => {
    const list = updateWsSource([pc, deck], "a", { name: "  ", url: "10.0.0.2:9002" });
    assert.equal(list[0].url, "ws://10.0.0.2:9002");
    assert.equal(list[0].name, "10.0.0.2:9002");
    assert.equal(list[1], deck);
});

test("main source and address comparison", () => {
    assert.equal(primaryWsSource([pc, deck], "b"), deck);
    assert.equal(primaryWsSource([pc, deck], "missing"), pc);
    assert.equal(primaryWsSource([], "a"), null);
    assert.equal(sameWsUrl("WS://192.168.0.40:9003/", "192.168.0.40:9003"), true);
    assert.equal(defaultSourceName("ws://host.local/api/text/origin"), "host.local");
});
