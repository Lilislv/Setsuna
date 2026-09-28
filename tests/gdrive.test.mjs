import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

// Exercise the production Drive client; only the native HTTP boundary is mocked.
const bundle = await build({
    entryPoints: ['src/utils/gdrive.ts'], bundle: true, write: false, format: 'esm', platform: 'node',
    define: { 'import.meta.env.VITE_GOOGLE_CLIENT_ID': '"test-client"', 'import.meta.env.VITE_GOOGLE_CLIENT_SECRET': '"test-secret"' },
    plugins: [{ name: 'native-http', setup(builder) {
        builder.onResolve({ filter: /^@tauri-apps\// }, args => ({ path: args.path, namespace: 'native-mock' }));
        builder.onLoad({ filter: /.*/, namespace: 'native-mock' }, () => ({ contents:
            'export const invoke = () => { throw new Error("Unexpected IPC"); }; export const fetch = (...args) => globalThis.driveHttp(...args);' }));
    } }],
});
const drive = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
globalThis.window = { __TAURI_INTERNALS__: {} };
const json = (value, status = 200) => new Response(JSON.stringify(value), { status });

test('native Drive listing follows pages and ignores unfinished uploads in favor of the newest ready DB', async () => {
    const requests = [];
    globalThis.driveHttp = async (url, options) => {
        requests.push(new URL(url));
        assert.equal(options.headers.Authorization, 'Bearer test-token');
        assert.equal(options.connectTimeout, 20_000);
        assert.ok(options.signal instanceof AbortSignal);
        assert.equal(new URL(url).searchParams.get('spaces'), 'appDataFolder');
        return requests.length === 1 ? json({ nextPageToken: 'page-two', files: [
            { id: 'empty', name: 'dictionary.db', size: '0', modifiedTime: '2026-09-24' },
            { id: 'backup', name: 'setsuna_backup_today.json', size: '500', modifiedTime: '2026-09-24' },
            { id: 'old', name: 'dictionary.db', size: '12000', modifiedTime: '2026-09-20' },
        ] }) : json({ files: [
            { id: 'ready', name: 'dictionary.db', size: '22000', modifiedTime: '2026-09-23' },
        ] });
    };
    assert.equal((await drive.getDictDriveInfo('test-token')).id, 'ready');
    assert.equal(requests.length, 2);
    assert.equal(requests[1].searchParams.get('pageToken'), 'page-two');
});

test('Drive metadata authorization failure is surfaced instead of being reported as an empty cloud', async () => {
    globalThis.driveHttp = async () => json({ error: { message: 'Invalid credentials' } }, 401);
    await assert.rejects(drive.getDictDriveInfo('expired'), /Invalid credentials/);
    globalThis.driveHttp = async () => json({ files: [] });
    assert.equal(await drive.getDictDriveInfo('test-token'), null);
});

test('native resumable upload preserves the Location header and exact binary file size', async () => {
    globalThis.driveHttp = async (url, options) => {
        assert.equal(new URL(url).searchParams.get('uploadType'), 'resumable');
        assert.equal(options.method, 'PATCH');
        assert.equal(options.headers['X-Upload-Content-Length'], '6442450944');
        assert.equal(options.headers['X-Upload-Content-Type'], 'application/octet-stream');
        return new Response('', { headers: { Location: 'https://www.googleapis.com/upload/session' } });
    };
    assert.equal(await drive.startDictionaryResumableUpload('test-token', 'file-id', 6442450944), 'https://www.googleapis.com/upload/session');
    globalThis.driveHttp = async () => new Response('{}');
    await assert.rejects(drive.startDictionaryResumableUpload('test-token', 'file-id', 100), /did not return/);
});
