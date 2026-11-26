import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { build } from 'esbuild';

const compiled = await build({
    entryPoints: ['src/features/epub/useEpubSync.ts'],
    bundle: true, write: false, format: 'esm', platform: 'node',
    define: { 'import.meta.env.VITE_GOOGLE_CLIENT_ID': '"test"', 'import.meta.env.VITE_GOOGLE_CLIENT_SECRET': '"test"' },
    plugins: [{ name: 'hook-environment', setup(builder) {
        builder.onResolve({ filter: /^(react$|@tauri-apps\/)/ }, ({ path }) => ({ path, namespace: 'mock' }));
        builder.onLoad({ filter: /.*/, namespace: 'mock' }, ({ path }) => ({
            contents: path === 'react'
                ? 'export const {useRef, useState, useCallback, useEffect} = globalThis.testReact'
                : 'export const invoke = (...args) => globalThis.native(...args); export const fetch = (...args) => globalThis.http(...args);',
        }));
    } }],
});
globalThis.testReact = React;
globalThis.window = { __TAURI_INTERNALS__: {}, setTimeout };
const { useEpubSync } = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`);

// Mount the actual hook without activating background timers. Tests explicitly advance network
// and IPC operations, and use the same functional setTabs contract as the React host.
function mount(initialTabs) {
    let controller;
    const tabsRef = { current: initialTabs };
    const setTabs = (next) => { tabsRef.current = typeof next === 'function' ? next(tabsRef.current) : next; };
    function Host() {
        controller = useEpubSync({ enabled: true, uploadFiles: true, activeInEpub: false,
            tabs: initialTabs, tabsRef, setTabs, allocateTabId: () => 123 });
        return null;
    }
    renderToStaticMarkup(React.createElement(Host));
    return { controller, tabsRef, setTabs };
}

const json = (data) => new Response(JSON.stringify(data));
const nextTick = () => new Promise((resolve) => setImmediate(resolve));
const thumb = 'data:image/jpeg;base64,AQ==';

test('manifest completes while legacy cover and CBZ are pending and keeps old file usable until replacement is published', async () => {
    const cover = Promise.withResolvers();
    const upload = Promise.withResolvers();
    const uploadStarted = Promise.withResolvers();
    const library = mount([{ id: 7, name: 'Volume', mode: 'epub',
        epub: { title: 'Volume', format: 'manga', fileExt: 'cbz', path: 'new.cbz', fileRevision: 2, progress: 0.2 } }]);
    let remote = { schemaVersion: 1, books: { volume: { bookKey: 'volume', title: 'Volume', format: 'manga',
        fileExt: 'cbz', driveFileId: 'old', fileRevision: 1, progress: 0 } } };
    let tokenRequests = 0;
    globalThis.http = async (url, init) => {
        const path = new URL(url);
        if (path.hostname === 'oauth2.googleapis.com') {
            tokenRequests++;
            return json({ access_token: 'token-a' });
        }
        if (path.searchParams.has('q')) return json({ files: [{ id: 'manifest' }] });
        if (path.pathname.endsWith('/manifest') && init.method === 'PATCH') {
            remote = JSON.parse(init.body);
            return json({});
        }
        if (path.pathname.endsWith('/manifest')) return json(remote);
        if (path.pathname.endsWith('/files') && init.method === 'POST') return json({ id: 'new-binary' });
        throw Error('Unexpected mocked HTTP request');
    };
    globalThis.native = async (name) => {
        if (name === 'load_google_refresh_token') return 'refresh-a';
        if (name === 'manga_cover') return cover.promise;
        if (name === 'epub_drive_upload') { uploadStarted.resolve(); return upload.promise; }
        throw Error(name);
    };
    await library.controller.syncNow({ forcePush: true });
    assert.equal(remote.books.volume.fileRevision, 1);
    assert.equal(remote.books.volume.driveFileId, 'old');
    library.setTabs(prev => prev.map(t => ({ ...t, epub: { ...t.epub, progress: 0.9, syncUpdatedAt: 3000 } })));
    cover.resolve(thumb);
    await uploadStarted.promise;
    await library.controller.syncNow({ forcePush: true });
    assert.equal(remote.books.volume.coverThumb, thumb);
    assert.equal(remote.books.volume.progress, 0.9);
    assert.equal(remote.books.volume.driveFileId, 'old');
    upload.resolve(400);
    await nextTick();
    await library.controller.syncNow({ forcePush: true });
    assert.equal(remote.books.volume.driveFileId, 'new-binary');
    assert.equal(remote.books.volume.fileRevision, 2);
    assert.equal(tokenRequests, 1);
});

test('overlapping taps reuse the download and discard a file superseded by a newer cloud revision', async () => {
    const tab = { id: 8, name: 'Novel', mode: 'epub', epub: { title: 'Novel', cloudOnly: true, fileExt: 'epub', driveFileId: 'v1' } };
    const library = mount([tab]);
    const download = Promise.withResolvers();
    let downloads = 0;
    globalThis.http = async () => json({ access_token: 'token-b' });
    globalThis.native = async (name) => {
        if (name === 'load_google_refresh_token') return 'refresh-b';
        if (name === 'epub_drive_download') { downloads++; return download.promise; }
        if (name === 'epub_open') return { chapters: [] };
        throw Error(name);
    };
    const first = library.controller.downloadCloudBook(tab);
    assert.equal(library.controller.downloadCloudBook(tab), first);
    library.setTabs([{ ...tab, epub: { ...tab.epub, driveFileId: 'v2', fileRevision: 2 } }]);
    download.resolve('novel.epub');
    assert.equal(await first, false);
    assert.equal(downloads, 1);
    assert.equal(library.tabsRef.current[0].epub.cloudOnly, true);
});
