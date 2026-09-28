import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLatestTaskQueue, contentFingerprint } from '../src/utils/runtimeMemory.ts';
import { selectActiveLookupResult } from '../src/utils/lookupResults.ts';

test('a stalled save retains only the active and latest snapshots', async () => {
    const writes = [];
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const queue = createLatestTaskQueue(async value => {
        writes.push(value);
        if (value === 0) await gate;
    });
    const done = queue.push(0);
    await Promise.resolve();
    for (let i = 1; i <= 10000; i++) queue.push(i);
    assert.equal(queue.pendingCount, 1);
    release();
    await done;
    assert.deepEqual(writes, [0, 10000]);
    assert.equal(queue.pendingCount, 0);
    await queue.push(10001);
    assert.deepEqual(writes, [0, 10000, 10001]);
});

test('failed and microtask-adjacent writes do not strand the newest save', async () => {
    const writes = [];
    const errors = [];
    const queue = createLatestTaskQueue(async value => {
        writes.push(value);
        if (value === 1) throw new Error('disk unavailable');
    }, error => errors.push(error));
    await queue.push(1);
    const second = queue.push(2);
    await Promise.resolve();
    await Promise.resolve();
    const third = queue.push(3);
    await Promise.all([second, third]);
    assert.deepEqual(writes, [1, 2, 3]);
    assert.equal(errors.length, 1);
});

test('workspace fingerprints are compact, stable across JSON and detect edits', () => {
    const lines = Array.from({ length: 10000 }, (_, index) => `${index} 食べさせられませんでした`);
    const workspace = { version: 1, tabs: [{ id: 1, lines, optional: undefined }], activeTabId: 1 };
    const key = contentFingerprint(workspace);
    assert.equal(key.length, 16);
    assert.equal(key, contentFingerprint(JSON.parse(JSON.stringify(workspace))));
    const edited = { ...workspace, tabs: [{ ...workspace.tabs[0], lines: [...lines, '次の行'] }] };
    assert.notEqual(key, contentFingerprint(edited));
    assert.notEqual(key, contentFingerprint({ ...workspace, activeTabId: 2 }));
});

test('disabled dictionaries cannot choose the highlighted prefix; offsets are code points', () => {
    const result = selectActiveLookupResult({ match_start: 1, match_len: 4, entries: [
        { dict_name: 'off', source_length: 4 }, { dict_name: 'on', source_length: 2 },
    ] }, '😀食べたい', { dictionaries: [{ name: 'off', active: false }] });
    assert.equal(result.word, '食べ');
    assert.equal(result.match_len, 2);
    assert.equal(result.entries.length, 1);
    assert.equal(selectActiveLookupResult({ start: 0, end: 1, entries: [{ dict_name: 'off' }] }, '食', { dictionaries: [{ name: 'off', active: false }] }), null);
});
