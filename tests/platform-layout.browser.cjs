const {build} = require('esbuild');
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const {readFileSync} = require('node:fs');

(async () => {
    const bundle = await build({stdin: {contents: `
        import React from 'react';
        import {createRoot} from 'react-dom/client';
        import App from './src/App';
        import Lookuper from './src/components/Lookuper';
        import {DEFAULT_SETTINGS, defaultStats} from './src/utils/constants';
        const settings = {...DEFAULT_SETTINGS, ankiEnabled: false, websockets: [], discordEnabled: false,
            dictionaries: [{name: 'Fixture', active: true}], appLanguage: 'en'};
        localStorage.setItem('txthk-settings', JSON.stringify(settings));
        localStorage.setItem('setsuna-setup-wizard-completed', 'true');
        localStorage.setItem('txthk-tabs', JSON.stringify([{id: 1, name: 'Fixture', mode: 'text', lines: ['猫と犬'], stats: defaultStats}]));
        window.__TAURI_EVENT_PLUGIN_INTERNALS__ = {unregisterListener: () => {}};
        window.__TAURI_INTERNALS__ = {
            metadata: {currentWindow: {label: 'main'}, currentWebview: {label: 'main'}},
            transformCallback: () => 1, unregisterCallback: () => {},
            invoke: async command => {
                if (command === 'get_windows_device_name') return 'Fixture';
                if (command === 'load_workspace_state') return null;
                if (command === 'plugin:app|version') return '0.1.3';
                if (command === 'get_installed_dicts') return ['Fixture'];
                if (command.includes('listen')) return 1;
                return [];
            }
        };
        window.openLookup = () => createRoot(document.getElementById('lookup')).render(<Lookuper settings={settings}
            onClose={() => {}} stack={[{word: '猫', sentence: '猫と犬', rect: new DOMRect(50, 180, 28, 32),
            entries: [{term: '猫', reading: 'ねこ', definition: '["cat"]', dict_name: 'Fixture', tags: '',
            deinflection_reasons: [], frequencies: [], pitches: [], pronunciations: [], source_length: 1}]}]} />);
        createRoot(document.getElementById('root')).render(<App />);
    `, resolveDir: process.cwd(), loader: 'tsx'}, bundle: true, write: false, format: 'iife', jsx: 'automatic',
        loader: {'.css': 'empty'}, define: {'import.meta.env.DEV': 'false', 'import.meta.env.PROD': 'true', 'import.meta.env': '{}'}});
    const browser = await chromium.launch({channel: 'msedge', headless: true});
    try {
        for (const mobile of [false, true]) {
            const context = await browser.newContext({viewport: {width: 1280, height: 800}, hasTouch: mobile,
                userAgent: mobile ? 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/130.0 Mobile Safari/537.36' : undefined});
            const page = await context.newPage(); page.setDefaultTimeout(10000);
            const errors = []; page.on('pageerror', error => errors.push(error.message));
            await page.route('**/*', route => route.fulfill({contentType: 'text/html', body: '<div id="root"></div><div id="lookup"></div>'}));
            await page.goto('http://setsuna-fixture.test');
            await page.addStyleTag({content: readFileSync('src/App.css', 'utf8').replace(/^@import.*$/m, '')});
            await page.addScriptTag({content: bundle.outputFiles[0].text});
            await page.locator('.home-mode-text').click();
            await page.locator(mobile ? '.mobile-shell' : '.top-bar').waitFor();
            await page.evaluate(() => window.openLookup());
            await page.locator('.dict-popup').waitFor();
            for (const width of [1280, 640, 480, 900, 1280]) {
                await page.setViewportSize({width, height: 800});
                await page.waitForTimeout(100);
                assert.equal(await page.locator('.mobile-shell').count(), mobile ? 1 : 0, 'shell at ' + width);
                assert.equal(await page.locator('.top-bar').count(), mobile ? 0 : 1, 'toolbar at ' + width);
                assert.equal(await page.locator('.dict-mobile-sheet').count(), mobile ? 1 : 0, 'popup at ' + width);
                assert.equal(await page.locator('.dict-mobile-scrim').count(), mobile ? 1 : 0);
                if (width === 640) await page.screenshot({path: 'output/platform-' + (mobile ? 'android' : 'desktop') + '-narrow.png'});
            }
            assert.deepEqual(errors, []);
            console.log('PASS ' + (mobile ? 'Android portrait/landscape keeps mobile shell and sheet' : 'Desktop narrow/wide keeps desktop toolbar and floating lookup'));
            await context.close();
        }
    } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
