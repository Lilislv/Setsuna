// Run with PLAYWRIGHT_MODULE pointing to an installed Playwright package.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { readFileSync } = require('node:fs');
const assert = require('node:assert/strict');

(async () => {
    const browser = await chromium.launch({ channel: 'msedge', headless: true });
    try {
        const page = await browser.newPage({ viewport: { width: 1000, height: 850 } });
        const errors = []; page.on('pageerror', error => errors.push(error.message));
        // Replace only native navigation. Everything determining the character,
        // ruby exclusion, context offsets and highlight is the production adapter.
        let script = readFileSync('src-tauri/src/yatsu-reader.js', 'utf8');
        const transport = "location.href = 'setsuna-yatsu://' + action + (data ? '?data=' + encodeURIComponent(JSON.stringify(data)) : '');";
        assert.ok(script.includes(transport));
        script = script.replace(transport, "window.__messages.push({action, data}); if (action === 'lookup') window.__scans.push(data);");
        await page.addInitScript('window.__scans = []; window.__messages = [];\n' + script);
        await page.route('https://app.yatsu.moe/**', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: `
            <style>body{padding:60px;font:32px serif}p{line-height:2;margin:30px}#vertical{writing-mode:vertical-rl;height:500px}</style>
            <div class="book-content"><p id="horizontal">𠮷野家。<ruby>食<rt>た</rt></ruby><span>べる</span>。猫と犬。</p>
            <p id="vertical">ヒビだらけ。そんなにドジじゃない。</p></div>
            <div class="book-content book-content-page-measure"><p id="hidden">猫</p></div>` }));
        await page.goto('https://app.yatsu.moe/b?id=test');
        const coordinate = async (selector, character) => page.locator(selector).evaluate((el, char) => {
            const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
            for (let node = walker.nextNode(); node; node = walker.nextNode()) {
                const offset = node.data.indexOf(char); if (offset < 0) continue;
                const range = document.createRange(); range.setStart(node, offset); range.setEnd(node, offset + char.length);
                const rect = range.getBoundingClientRect(); return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
            }
            throw Error('Missing fixture character');
        }, character);
        const move = async (selector, char) => { const p = await coordinate(selector, char); await page.mouse.move(p.x, p.y); await page.waitForTimeout(100); };
        await move('#horizontal', '猫');
        assert.equal((await page.evaluate(() => window.__scans)).length, 0, 'requires Shift');
        await page.keyboard.down('Shift'); await page.waitForTimeout(100);
        for (const c of ['犬', '食', '𠮷']) await move('#horizontal', c);
        for (const c of ['ヒ', 'ド']) await move('#vertical', c);
        const scans = await page.evaluate(() => window.__scans);
        assert.deepEqual(scans.map(r => Array.from(r.sentence)[r.cursor]), ['猫', '犬', '食', '𠮷', 'ヒ', 'ド']);
        assert.ok(scans.every(r => !r.sentence.includes('た')));
        const food = scans.find(r => Array.from(r.sentence)[r.cursor] === '食');
        assert.ok(food.sentence.includes('食べる'), 'joins ruby base and sibling span');
        await move('#vertical', 'ド');
        assert.equal((await page.evaluate(() => window.__scans)).length, scans.length, 'same character is deduplicated');
        await move('rt', 'た'); await move('#hidden', '猫');
        assert.equal((await page.evaluate(() => window.__scans)).length, scans.length, 'ruby and measuring content excluded');
        const last = scans.at(-1);
        await page.evaluate(r => window.__setsunaYatsuHighlight(r.id, r.cursor, 2), last);
        assert.equal(await page.evaluate(() => [...CSS.highlights.get('setsuna-yatsu')][0].toString()), 'ドジ');
        await page.keyboard.press('Escape');
        assert.equal(await page.evaluate(() => CSS.highlights.has('setsuna-yatsu')), false);
        await page.keyboard.up('Shift');
        await page.keyboard.press('Escape');
        const menu = page.locator('setsuna-reader-controls').locator('dialog');
        await menu.waitFor({ state: 'visible' });
        await page.waitForTimeout(260);
        assert.ok(await menu.evaluate(el => getComputedStyle(el, '::backdrop').backdropFilter.includes('blur(14px)')));
        await page.screenshot({ path: 'output/yatsu-menu-browser.png' });
        await page.getByRole('button', { name: /Продолжить/ }).click();
        await menu.waitFor({ state: 'hidden' });
        await page.keyboard.press('Escape');
        await menu.waitFor({ state: 'visible' });
        await page.getByRole('button', { name: /Главный экран/ }).click();
        await page.waitForFunction(() => window.__messages.some(m => m.action === 'home'));
        assert.ok(scans.every(r => r.anchor.width > 0 && r.anchor.height > 0));
        assert.ok(scans.filter(r => Array.from(r.sentence)[r.cursor] === 'ド').every(r => r.vertical && r.prefer_right));
        assert.deepEqual(errors, []);
        console.log('PASS Yatsu character scanning, vertical text, ruby, supplementary Unicode, deduplication and highlights');
    } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
