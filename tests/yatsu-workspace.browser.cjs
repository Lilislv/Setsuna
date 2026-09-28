const { build } = require('esbuild');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { readFileSync } = require('node:fs');
const assert = require('node:assert/strict');

(async () => {
    const bundle = await build({
        stdin: { contents: `
            import React, {useState} from 'react';
            import {createRoot} from 'react-dom/client';
            import YatsuWorkspace from './src/components/YatsuWorkspace';
            window.calls = []; window.block = false;
            window.testInvoke = async (command, args) => {
                window.calls.push({command, ...args});
                if (window.block) { window.block = false; await new Promise(resolve => window.release = resolve); }
            };
            function App() { const [open, setOpen] = useState(false); return open
                ? <YatsuWorkspace language="ru" onHome={() => setOpen(false)} />
                : <button onClick={() => setOpen(true)}>Open reader</button>; }
            createRoot(document.getElementById('root')).render(<App />);
        `, resolveDir: process.cwd(), loader: 'tsx' },
        bundle: true, write: false, format: 'iife', jsx: 'automatic', loader: { '.css': 'empty' },
        plugins: [{ name: 'native-boundary', setup(builder) {
            builder.onResolve({ filter: /^@tauri-apps\/api\/(core|event)$/ }, () => ({ path: 'native', namespace: 'mock' }));
            builder.onLoad({ filter: /.*/, namespace: 'mock' }, () => ({ contents: 'export const invoke = (...args) => window.testInvoke(...args); export const listen = async (_, callback) => { window.goHome = callback; return () => {}; };' }));
        } }],
    });
    const browser = await chromium.launch({ channel: 'msedge', headless: true });
    try {
        const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
        await page.setContent('<meta charset="UTF-8"><div id="root"></div>');
        await page.addStyleTag({ content: 'body{margin:0} #root{height:100vh;display:flex;flex-direction:column}' + readFileSync('src/components/YatsuWorkspace.css', 'utf8') });
        await page.addScriptTag({ content: bundle.outputFiles[0].text });
        await page.getByText('Open reader').click();
        await page.waitForFunction(() => window.calls.at(-1)?.layout?.reader);
        const first = await page.evaluate(() => window.calls.at(-1).layout);
        assert.deepEqual(first.reader, { x: 0, y: 0, width: 1280, height: 800 });
        assert.equal(await page.locator('header').count(), 0);
        await page.setViewportSize({ width: 1000, height: 600 });
        await page.waitForFunction(() => window.calls.at(-1)?.layout?.reader.width === 1000);
        await page.evaluate(() => window.goHome());
        await page.getByText('Open reader').waitFor();
        await page.waitForFunction(() => window.calls.at(-1)?.layout === null);
        await page.evaluate(() => { window.block = true; window.release = null; });
        await page.getByText('Open reader').click();
        await page.waitForFunction(() => !!window.release);
        await page.setViewportSize({ width: 1100, height: 700 });
        await page.evaluate(() => window.goHome());
        await page.getByText('Open reader').waitFor();
        await page.evaluate(() => window.release());
        await page.waitForFunction(() => window.calls.at(-1)?.layout === null);
        console.log('PASS embedded workspace full-window geometry, resizing, menu navigation and slow-open/back race');
    } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
