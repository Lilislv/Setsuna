import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

const store = new Map();
const dispatched = [];
globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
};
globalThis.window = {
    dispatchEvent: (event) => {
        dispatched.push(event);
    },
};

const bundle = await build({
    stdin: {
        contents: "export * from './src/utils/escMenuLayout';",
        resolveDir: process.cwd(),
        loader: 'ts',
    },
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'node',
});

const mod = await import(
    `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`
);

const {
    ESC_MENU_LAYOUT_STORAGE_KEY,
    applyEscMenuLayout,
    hideEscMenuItem,
    readEscMenuLayout,
    reorderEscMenuLayout,
    resetEscMenuLayout,
    restoreEscMenuItem,
    writeEscMenuLayout,
} = mod;

const items = (ids) => ids.map((id) => ({ id, label: id.toUpperCase() }));

beforeEach(() => {
    store.clear();
    dispatched.length = 0;
});

test('applyEscMenuLayout returns default order when uncustomized', () => {
    const res = applyEscMenuLayout(items(['a', 'b', 'c']));
    assert.deepEqual(res.visible.map((x) => x.id), ['a', 'b', 'c']);
    assert.deepEqual(res.hidden, []);
    assert.equal(res.isCustomized, false);
});

test('reorderEscMenuLayout swaps forward/backward and preserves absent dynamic ids', () => {
    const initial = { order: ['library', 'open', 'url', 'deck', 'settings'], hidden: [] };
    // Simulate library screen with no video loaded: "library" tile is temporarily absent.
    const visibleIds = ['open', 'url', 'deck', 'settings'];

    const forward = reorderEscMenuLayout(initial, visibleIds, 'open', 'deck');
    assert.deepEqual(forward.order, ['library', 'url', 'deck', 'open', 'settings']);

    const afterIds = applyEscMenuLayout(items(['library', 'open', 'url', 'deck', 'settings']), forward);
    assert.deepEqual(afterIds.visible.map((x) => x.id), ['library', 'url', 'deck', 'open', 'settings']);
    assert.equal(afterIds.isCustomized, true);

    const backward = reorderEscMenuLayout(forward, ['url', 'deck', 'open', 'settings'], 'settings', 'url');
    assert.deepEqual(backward.order, ['library', 'settings', 'url', 'deck', 'open']);
});

test('hideEscMenuItem and restoreEscMenuItem keep remembered position', () => {
    const base = resetEscMenuLayout();
    const afterHide = hideEscMenuItem(base, ['a', 'b', 'c', 'd'], 'b');
    const view1 = applyEscMenuLayout(items(['a', 'b', 'c', 'd']), afterHide);
    assert.deepEqual(view1.visible.map((x) => x.id), ['a', 'c', 'd']);
    assert.deepEqual(view1.hidden.map((x) => x.id), ['b']);
    assert.equal(view1.isCustomized, true);

    const afterRestore = restoreEscMenuItem(afterHide, 'b');
    const view2 = applyEscMenuLayout(items(['a', 'b', 'c', 'd']), afterRestore);
    assert.deepEqual(view2.visible.map((x) => x.id), ['a', 'b', 'c', 'd']);
    assert.deepEqual(view2.hidden, []);
    assert.equal(view2.isCustomized, false);
});

test('hiding all items yields empty visible list and full hidden list', () => {
    let layout = resetEscMenuLayout();
    for (const id of ['a', 'b', 'c']) {
        layout = hideEscMenuItem(layout, ['a', 'b', 'c'], id);
    }
    const view = applyEscMenuLayout(items(['a', 'b', 'c']), layout);
    assert.deepEqual(view.visible, []);
    assert.deepEqual(view.hidden.map((x) => x.id), ['a', 'b', 'c']);
    assert.equal(view.isCustomized, true);
});

test('applyEscMenuLayout appends newly introduced tiles in default order', () => {
    const saved = { order: ['b', 'a'], hidden: [] };
    const view = applyEscMenuLayout(items(['a', 'b', 'c', 'd']), saved);
    assert.deepEqual(view.visible.map((x) => x.id), ['b', 'a', 'c', 'd']);
    assert.equal(view.isCustomized, true);
});

test('localStorage persistence round-trip, reset cleanup, and corrupt JSON safety', () => {
    writeEscMenuLayout('player', { order: ['settings', 'open'], hidden: ['url'] });
    assert.equal(dispatched.length, 1);

    const loaded = readEscMenuLayout('player');
    assert.deepEqual(loaded, { order: ['settings', 'open'], hidden: ['url'] });
    assert.deepEqual(readEscMenuLayout('epub'), { order: [], hidden: [] });

    writeEscMenuLayout('player', resetEscMenuLayout());
    assert.equal(store.has(ESC_MENU_LAYOUT_STORAGE_KEY), false);

    store.set(ESC_MENU_LAYOUT_STORAGE_KEY, '{broken json');
    assert.deepEqual(readEscMenuLayout('texthooker'), { order: [], hidden: [] });
});
