import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

const store = new Map();
globalThis.localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
let resets = 0;
globalThis.window = { dispatchEvent: () => { resets += 1; } };

const bundle = await build({
    stdin: { contents: "export * from './src/features/onboarding/onboardingStore'; export * from './src/features/onboarding/guides'; export * from './src/features/onboarding/surfaceTips'; export * from './src/features/onboarding/readerTips'; export * from './src/features/onboarding/tipDetails';", resolveDir: process.cwd(), loader: 'ts' },
    bundle: true, write: false, format: 'esm', platform: 'node',
});
const mod = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
const { introSeen, markIntroSeen, tipSeen, markTipsSeen, resetOnboarding, modeTips, modeGuide } = mod;

test('intros and tips are remembered per mode and reset together', () => {
    assert.equal(introSeen('texthooker'), false);
    markIntroSeen('texthooker');
    assert.equal(introSeen('texthooker'), true);
    assert.equal(introSeen('epub'), false, 'other modes stay untouched');
    markTipsSeen(['texthooker.source']);
    assert.equal(tipSeen('texthooker.source'), true);
    assert.equal(tipSeen('texthooker.flow'), false);
    resetOnboarding();
    assert.equal(introSeen('texthooker'), false);
    assert.equal(tipSeen('texthooker.source'), false);
    assert.equal(resets, 1);
});

test('broken storage does not throw', () => {
    store.set('setsuna-onboarding', '{not json');
    assert.equal(introSeen('player'), false);
});

test('every mode has an introduction in both languages and tips have unique ids', () => {
    for (const mode of ['texthooker', 'epub', 'player']) {
        for (const lang of ['ru', 'en']) assert.ok(modeGuide(mode, lang).points.length > 0);
    }
    const ru = modeTips('texthooker', 'ru');
    const en = modeTips('texthooker', 'en');
    assert.deepEqual(ru.map((s) => s.id), en.map((s) => s.id));
    assert.equal(new Set(ru.map((s) => s.id)).size, ru.length);
});

test('menu and every settings section have tips with unique ids in both languages', async () => {
    const { menuTips, epubMenuTips, playerMenuTips, settingsTips, SETTINGS_TIP_SECTIONS } = mod;
    const ids = new Set();
    for (const menuFn of [menuTips, epubMenuTips, playerMenuTips]) {
        const ruMenu = menuFn('ru');
        const enMenu = menuFn('en');
        assert.deepEqual(ruMenu.map((s) => s.id), enMenu.map((s) => s.id));
        for (const step of ruMenu) {
            assert.ok(step.body.length > 20, step.id);
            assert.ok(!ids.has(step.id), step.id);
            ids.add(step.id);
        }
    }
    for (const section of SETTINGS_TIP_SECTIONS) {
        const ru = settingsTips(section, 'ru');
        const en = settingsTips(section, 'en');
        assert.deepEqual(ru.map((s) => s.id), en.map((s) => s.id));
        assert.ok(ru.length > 2, `${section} has its own tips`);
        ru.slice(2).forEach((step) => { assert.ok(!ids.has(step.id), step.id); ids.add(step.id); });
    }
    for (const section of ['text', 'epub', 'player', 'jl', 'lookup', 'anki', 'ai', 'cloud', 'discord', 'updates', 'feedback']) {
        assert.ok(SETTINGS_TIP_SECTIONS.includes(section), `settings section ${section} is covered`);
    }
    const ankiIds = settingsTips('anki', 'ru').map((step) => step.id);
    assert.ok(ankiIds.includes('settings.anki-connect') && ankiIds.includes('settings.anki-connected') && ankiIds.includes('settings.anki-dupes'));
    const cloudIds = settingsTips('cloud', 'ru').map((step) => step.id);
    for (const expected of ['settings.cloud-connect', 'settings.cloud-connected', 'settings.cloud-quota', 'settings.cloud-backup', 'settings.cloud-archive', 'settings.cloud-dict']) {
        assert.ok(cloudIds.includes(expected), `cloud covers ${expected}`);
    }
});

test('reader and player tips: unique ids, same steps in both languages', async () => {
    const { readerTips, playerTips } = mod;
    for (const tips of [readerTips, playerTips]) {
        const ru = tips('ru');
        const en = tips('en');
        assert.deepEqual(ru.map((s) => s.id), en.map((s) => s.id));
        assert.equal(new Set(ru.map((s) => s.id)).size, ru.length);
        ru.forEach((step) => assert.ok(step.target && step.body.length > 20, step.id));
    }
    // Shared reader buttons are scoped so the library and the book never double up.
    assert.ok(readerTips('ru').every((s) => /^(\.epub-library|\.epub-reader-shell|\.pdf-reader-shell|:is\()/.test(s.target)));
    assert.equal(readerTips('ru').find((s) => s.id === 'library.open')?.target, '.epub-library [data-coach="lib-open"]');
    assert.equal(playerTips('ru').some((s) => s.id === 'player.manual'), false);
});

test('every tip has a longer explanation behind "More" in both languages', () => {
    const { tipDetail, menuTips, epubMenuTips, playerMenuTips, settingsTips, SETTINGS_TIP_SECTIONS, readerTips, playerTips, modeTips } = mod;
    const all = [
        ...modeTips('texthooker', 'ru'),
        ...menuTips('ru'),
        ...epubMenuTips('ru'),
        ...playerMenuTips('ru'),
        ...SETTINGS_TIP_SECTIONS.flatMap((s) => settingsTips(s, 'ru')),
        ...readerTips('ru'),
        ...playerTips('ru'),
    ];
    const missing = [...new Set(all.map((s) => s.id))].filter((id) => !tipDetail(id, 'ru')?.length || !tipDetail(id, 'en')?.length);
    assert.deepEqual(missing, []);
    // The source tips explain the hookers and WebSocket vs clipboard.
    const source = tipDetail('texthooker.source', 'ru').join(' ');
    for (const word of ['Agent', 'Textractor', 'LunaTranslator', 'WebSocket', 'Буфер']) assert.ok(source.includes(word), word);
});
