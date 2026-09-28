import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHoverScanQueue } from '../src/utils/hoverScan.ts';
const pause = () => new Promise(resolve => setImmediate(resolve));
test('every new character scans, including positions inside the previous match', async () => {
    const requests = [];
    const queue = createHoverScanQueue((a, b) => a === b, async (cursor, current) => { if (current()) requests.push(cursor); });
    queue.request(0); await pause(); queue.request(0); await pause();
    queue.request(1); await pause(); queue.request(2); await pause(); queue.request(0); await pause();
    assert.deepEqual(requests, [0, 1, 2, 0]); queue.dispose();
});
test('slow lookups retain only the latest character and never publish old replies', async () => {
    let release; const gate = new Promise(resolve => { release = resolve; });
    const requests = []; const shown = [];
    const queue = createHoverScanQueue((a, b) => a === b, async (cursor, current) => {
        requests.push(cursor); if (cursor === 0) await gate; if (current()) shown.push(cursor);
    });
    queue.request(0);
    for (let cursor = 1; cursor <= 1000; cursor++) queue.request(cursor);
    release(); await pause();
    assert.deepEqual(requests, [0, 1000]); assert.deepEqual(shown, [1000]); queue.dispose();
});
test('release, leaving text and unmount invalidate both active and queued lookups', async () => {
    for (const dispose of [false, true]) {
        let release; const gate = new Promise(resolve => { release = resolve; }); const shown = [];
        const queue = createHoverScanQueue((a, b) => a === b, async (cursor, current) => { await gate; if (current()) shown.push(cursor); });
        queue.request(0); queue.request(1);
        if (dispose) queue.dispose(); else queue.request(null);
        release(); await pause(); assert.deepEqual(shown, []);
        if (!dispose) { queue.request(0); await pause(); assert.deepEqual(shown, [0]); }
        queue.dispose();
    }
});
