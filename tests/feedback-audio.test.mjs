import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
import { buildFeedback, normalizeFeedbackDraft, feedbackPlatform, EMPTY_FEEDBACK } from '../src/utils/feedback.ts';

// Exercise the production Anki/audio integration with only native/network boundaries mocked.
const bundle = await build({ stdin: { contents: "export * from './src/utils/anki'; export * from './src/utils/dictionaryAudio';", resolveDir: process.cwd() },
    bundle: true, write: false, format: 'esm', platform: 'node', plugins: [{ name: 'native-boundaries', setup(builder) {
        builder.onResolve({ filter: /^@tauri-apps\// }, args => ({ path: args.path, namespace: 'native-mock' }));
        builder.onLoad({ filter: /.*/, namespace: 'native-mock' }, () => ({ contents: 'export const invoke = (...args) => globalThis.testInvoke(...args); export const fetch = () => { throw new Error("Unexpected network"); };' }));
    } }] });
const { addNote, checkWordsStatusMulti, formatLapisFurigana, resolveDictionaryAudio, audioPreviewUrl } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
const clip = { data: 'SUQzAg==', filename: 'setsuna_audio_0123456789abcdef.mp3', mimeType: 'audio/mpeg', source: 'nhk16', speaker: '', display: '', reading: 'たべる' };
const settings = { dictionaryAudioSource: 'local', localAudioDatabasePath: 'test.db', ankiFieldWord: 'Word', ankiFieldAudio: 'Audio', ankiDeck: 'Test', ankiModel: 'Test' };
const note = { word: '食べる', rawReading: 'たべる', audioUrl: 'https://old.example/audio.mp3' };

test('Anki ruby separates preceding kana but keeps okurigana attached', () => {
    for (const [word, reading, expected] of [
        ['むず痒い', 'むずがゆい', 'むず 痒[がゆ]い'],
        ['お祝い', 'おいわい', 'お 祝[いわ]い'],
        ['取り扱う', 'とりあつかう', '取[と]り 扱[あつか]う'],
        ['食べる', 'たべる', '食[た]べる'],
        ['学校', 'がっこう', '学校[がっこう]'],
        ['かな', 'かな', 'かな'],
        ['むず 痒い', 'むずがゆい', 'むず 痒[がゆ]い'],
    ]) assert.equal(formatLapisFurigana(word, reading), expected);
});

test('desktop and AnkiDroid export corrected furigana without changing the word or plain reading', async () => {
    const exportSettings = { ...settings, ankiFieldAudio: 'none', ankiFieldReading: 'ExpressionFurigana' };
    const data = { word: 'むず痒い', rawReading: 'むずがゆい' };
    const calls = native();
    await addNote(exportSettings, data);
    assert.equal(calls[0].params.note.fields.Word, data.word);
    assert.equal(calls[0].params.note.fields.ExpressionFurigana, 'むず 痒[がゆ]い');
    await addNote({ ...exportSettings, ankiFieldReading: 'Reading' }, data);
    assert.equal(calls[1].params.note.fields.Reading, data.rawReading);
    let payload;
    window.SetsunaAnkiDroid = { addNote(raw) { payload = JSON.parse(raw); return JSON.stringify({ ok: true, value: { result: 456 } }); } };
    await addNote(exportSettings, data);
    assert.equal(payload.fields.ExpressionFurigana, 'むず 痒[がゆ]い');
    assert.equal(payload.fields.Word, data.word);
});

test('duplicate detection still recognizes cards with the previous unspaced furigana', async () => {
    native();
    globalThis.testInvoke = async (command, args) => {
        assert.equal(command, 'anki_request');
        assert.equal(args.action, 'multi');
        if (args.params.actions[0].action === 'findNotes') return [[123], []];
        return [[{ fields: { Word: { value: 'むず痒い' }, ExpressionFurigana: { value: 'むず痒[がゆ]い' } } }]];
    };
    const statuses = await checkWordsStatusMulti('Legacy', 'Word', 'ExpressionFurigana', [{ word: 'むず痒い', reading: 'むずがゆい' }]);
    assert.equal(statuses['むず痒い__むずがゆい'], 'red');
});
function native(lookupResult = clip, storeError = null) {
    globalThis.window = { __TAURI_INTERNALS__: {} };
    const calls = [];
    globalThis.testInvoke = async (command, args) => {
        calls.push({ command, ...args });
        if (command === 'lookup_local_audio') { if (lookupResult instanceof Error) throw lookupResult; return lookupResult; }
        assert.equal(command, 'anki_request');
        if (args.action === 'storeMediaFile') { if (storeError) throw storeError; return 'actual_name.mp3'; }
        assert.equal(args.action, 'addNote'); return 123;
    };
    return calls;
}

test('feedback preserves Japanese, Russian and URL delimiters without adding privileged parameters', () => {
    const draft = { ...EMPTY_FEEDBACK, title: 'ドジ & ошибка?#', description: 'Строка 1\n日本語 + & ? #', steps: 'Открыть словарь', expected: 'Показать ドジ' };
    const report = buildFeedback(draft, '0.1.3', 'Windows');
    const url = new URL(report.url);
    assert.equal(url.origin, 'https://github.com'); assert.equal(url.pathname, '/Lilislv/Setsuna/issues/new');
    assert.equal(url.searchParams.get('body'), report.body); assert.equal(url.searchParams.get('title'), report.title);
    assert.deepEqual([...url.searchParams.keys()], ['title', 'body']);
    assert.ok(report.body.includes(draft.description)); assert.ok(report.body.includes('Setsuna: 0.1.3\nOS: Windows'));
});
test('long feedback keeps the full body for explicit clipboard transfer', () => {
    const report = buildFeedback({ ...EMPTY_FEEDBACK, title: 'Long', description: 'あ'.repeat(8000) }, '1', 'Windows');
    assert.equal(report.copyRequired, true); assert.ok(report.url.length < 7500);
    assert.equal(new URL(report.url).searchParams.has('body'), false); assert.ok(report.body.includes('あ'.repeat(8000)));
    const capabilities = JSON.parse(readFileSync('src-tauri/capabilities/default.json', 'utf8'));
    assert.ok(capabilities.permissions.includes('clipboard-manager:allow-write-text'));
});
test('feature reports omit hidden bug fields and can omit environment', () => {
    const report = buildFeedback({ ...EMPTY_FEEDBACK, kind: 'feature', title: 'Feature', description: 'Desired behavior', steps: 'stale steps', expected: 'stale expected', includeEnvironment: false }, 'secret-version', 'secret-platform');
    assert.equal(report.body, '## Feature request\n\nDesired behavior');
    assert.equal(report.title, '[Feature] Feature');
    assert.deepEqual(normalizeFeedbackDraft(null), EMPTY_FEEDBACK);
    assert.equal(normalizeFeedbackDraft({ description: 7, title: 'a'.repeat(500), kind: '__proto__' }).title.length, 120);
    assert.equal(feedbackPlatform('Linux; Android 16'), 'Android');
});
test('local card stores bytes in Anki and uses the returned filename, without online audio', async () => {
    const calls = native();
    assert.equal((await addNote(settings, note)).result, 123);
    assert.deepEqual(calls.map(c => c.action || c.command), ['lookup_local_audio', 'storeMediaFile', 'addNote']);
    assert.equal(calls[0].term, '食べる'); assert.equal(calls[0].reading, 'たべる');
    assert.deepEqual(calls[1].params, { filename: clip.filename, data: clip.data });
    assert.equal(calls[2].params.note.fields.Audio, '[sound:actual_name.mp3]');
    assert.equal(calls[2].params.note.audio, undefined);
});
test('local-only miss creates a card with a warning; local-first falls back online', async () => {
    let calls = native(null);
    const result = await addNote(settings, note);
    assert.equal(result.result, 123); assert.ok(result.warning);
    assert.equal(calls.at(-1).params.note.audio, undefined);
    calls = native(null);
    assert.equal((await addNote({ ...settings, dictionaryAudioSource: 'local-first' }, note)).result, 123);
    const url = new URL(calls.at(-1).params.note.audio[0].url);
    assert.equal(url.searchParams.get('kanji'), '食べる'); assert.equal(url.searchParams.get('kana'), 'たべる');
});

test('online-first uses verified online bytes in Anki without opening the local database', async () => {
    const calls = native();
    const fallback = globalThis.testInvoke;
    globalThis.testInvoke = async (command, args) => {
        if (command === 'lookup_online_audio') { calls.push({ command }); return { ...clip, source: 'JapanesePod101' }; }
        return fallback(command, args);
    };
    const result = await addNote({ ...settings, dictionaryAudioSource: 'online-first', localAudioDatabasePath: '' }, note);
    assert.equal(result.result, 123);
    assert.deepEqual(calls.map(c => c.action || c.command), ['lookup_online_audio', 'storeMediaFile', 'addNote']);
    assert.equal(calls.at(-1).params.note.audio, undefined);
    assert.equal(calls.at(-1).params.note.fields.Audio, '[sound:actual_name.mp3]');
});

test('online-first falls back on missing audio or a network failure, and reports a double miss', async () => {
    for (const onlineResult of [null, new Error('Offline')]) {
        for (const localResult of [clip, null]) {
            const calls = native(localResult);
            const fallback = globalThis.testInvoke;
            globalThis.testInvoke = async (command, args) => {
                if (command === 'lookup_online_audio') {
                    calls.push({ command });
                    if (onlineResult instanceof Error) throw onlineResult;
                    return onlineResult;
                }
                return fallback(command, args);
            };
            const result = await resolveDictionaryAudio({ ...settings, dictionaryAudioSource: 'online-first' }, '食べる', 'たべる');
            assert.equal(result.kind, localResult ? 'local' : 'none');
            assert.deepEqual(calls.map(c => c.command), ['lookup_online_audio', 'lookup_local_audio']);
        }
    }
});
test('database or media-store errors prevent creating an incomplete card', async () => {
    let calls = native(new Error('Database unavailable'));
    assert.equal((await addNote(settings, note)).error, 'Database unavailable'); assert.equal(calls.length, 1);
    calls = native(clip, new Error('Cannot store media'));
    assert.equal((await addNote(settings, note)).error, 'Cannot store media');
    assert.equal(calls.some(c => c.action === 'addNote'), false);
    await assert.rejects(resolveDictionaryAudio({ ...settings, localAudioDatabasePath: '' }, '語', 'ご'), /Select a local/);
});
test('player clips have priority and disabled audio never reads the database', async () => {
    let calls = native(new Error('Should not read the DB'));
    assert.equal((await addNote(settings, { ...note, audioPath: 'clip.mp3' })).result, 123);
    assert.equal(calls[0].action, 'storeMediaFile'); assert.equal(calls[0].params.path, 'clip.mp3');
    calls = native(new Error('Should not read the DB'));
    assert.equal((await addNote({ ...settings, ankiFieldAudio: 'none' }, note)).result, 123);
    assert.equal(calls.length, 1); assert.equal(calls[0].action, 'addNote');
});
test('online mode avoids the local DB; local preview object URLs release their blobs', async () => {
    const calls = native();
    assert.equal((await resolveDictionaryAudio({}, '食べる', 'たべる')).kind, 'online'); assert.equal(calls.length, 0);
    const source = audioPreviewUrl({ kind: 'local', clip });
    assert.equal(await (await fetch(source.url)).text(), 'ID3\x02');
    source.dispose(); await assert.rejects(fetch(source.url));
});
test('AnkiDroid receives local audio bytes through the bridge', async () => {
    const calls = native(); let payload;
    window.SetsunaAnkiDroid = { addNote(raw) { payload = JSON.parse(raw); return JSON.stringify({ ok: true, value: { result: 456 } }); } };
    assert.equal((await addNote(settings, note)).result, 456);
    assert.equal(payload.audioBase64, clip.data); assert.equal(payload.audioField, 'Audio'); assert.equal(payload.audioFilename, clip.filename);
    assert.equal(calls.length, 1);
});
