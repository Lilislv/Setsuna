import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import Lookuper from '../src/components/Lookuper';
import { findHoverTextPoint } from '../src/utils/hoverScan';
const calls: number[] = []; const shown: string[] = [];
const settings = { appLanguage: 'en', lookupHotkey: 'Ctrl+KeyQ', dictionaries: [], autoPlayAudio: false } as any;
const emptyStack = [];
(window as any).__TAURI_INTERNALS__ = { invoke: async (cmd, args) => {
    if (cmd !== 'scan_cursor') throw new Error(`Unexpected command: ${cmd}`);
    calls.push(args.cursor);
    await new Promise(resolve => setTimeout(resolve, 100));
    const chars = Array.from(args.sentence) as string[];
    const word = chars.slice(args.cursor, args.cursor + (args.cursor === 0 ? 2 : 1)).join('');
    return { word, match_start: args.cursor, match_len: Array.from(word).length, entries: [{ term: word, reading: word, definition: '["test"]', dict_name: 'test', source_length: Array.from(word).length }] };
} };
const pause = (ms = 160) => new Promise(resolve => setTimeout(resolve, ms));
function Harness() {
    const [checks, setChecks] = useState<string[]>([]); const [, render] = useState(0);
    useEffect(() => {
        let cancelled = false;
        const record = (label, passed, details = '') => setChecks(previous => [...previous, `${passed ? 'PASS' : 'FAIL'} ${label} ${details}`]);
        const point = (id, offset) => {
            const node = document.getElementById(id)!.firstChild!;
            const range = document.createRange(); range.setStart(node, offset);
            range.setEnd(node, offset + ((node.textContent!.codePointAt(offset) || 0) > 0xffff ? 2 : 1));
            const rect = range.getBoundingClientRect(); return { x: rect.left + rect.width * 0.7, y: rect.top + rect.height * 0.7 };
        };
        const move = (id, offset, ctrl = true) => { const p = point(id, offset); window.dispatchEvent(new MouseEvent('mousemove', { clientX: p.x, clientY: p.y, ctrlKey: ctrl })); };
        void (async () => {
            await pause(); if (cancelled) return;
            move('horizontal', 0, false);
            window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyQ', key: 'q', ctrlKey: true, bubbles: true }));
            await pause(10); move('horizontal', 1); await pause(260);
            record('stale result suppressed; newest character wins', shown.join('|') === 'ビ', JSON.stringify({ calls, shown }));
            move('horizontal', 0); await pause();
            record('first character selects the whole word', shown.at(-1) === 'ヒビ');
            move('horizontal', 1); await pause();
            record('moving inside selected word rescans after React rerender', shown.at(-1) === 'ビ' && calls.at(-1) === 1);
            const count = calls.length; move('horizontal', 1); await pause();
            record('same character does not repeat lookup', calls.length === count);
            move('unicode', 2); await pause();
            record('DOM surrogate pair converts to code-point cursor', calls.at(-1) === 1 && shown.at(-1) === 'ヒ');
            const rubyBase = point('ruby-base', 0); const rubyReading = point('ruby-reading', 0);
            record('ruby base scans', !!findHoverTextPoint(rubyBase.x, rubyBase.y));
            record('furigana excluded', findHoverTextPoint(rubyReading.x, rubyReading.y) === null);
            move('vertical', 0); await pause(); move('vertical', 1); await pause();
            record('vertical text updates by character', shown.at(-1) === 'ビ' && calls.at(-1) === 1);
            const rect = document.getElementById('horizontal')!.getBoundingClientRect();
            record('padding beside text does not snap to a word', findHoverTextPoint(rect.right - 2, rect.top + rect.height / 2) === null);
            move('horizontal', 0); await pause(10);
            window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyQ', key: 'q', ctrlKey: true }));
            const shownCount = shown.length; await pause();
            record('released hotkey suppresses pending result', shown.length === shownCount);
        })().catch(error => record('fixture completed', false, String(error)));
        return () => { cancelled = true; };
    }, []);
    return <><style>{`body{background:#202124;color:#eee;font:16px sans-serif;margin:24px}.text-line{font:32px sans-serif;margin:24px 0;width:500px;line-height:1.8}#vertical{writing-mode:vertical-rl;height:180px;width:60px;position:absolute;left:650px;top:40px}pre{white-space:pre-wrap}rt{font-size:14px}`}</style>
        <div className="text-line" id="horizontal">ヒビだらけ</div><div className="text-line" id="unicode">😀ヒビ</div>
        <div className="text-line"><ruby><span id="ruby-base">食</span><rt id="ruby-reading">た</rt></ruby>べる</div>
        <div className="text-line" id="vertical">ヒビだらけ</div><pre>{checks.join('\n')}</pre>
        <Lookuper stack={emptyStack} settings={settings} onReplace={data => { shown.push(data.word); render(n => n + 1); }} />
    </>;
}
createRoot(document.getElementById('root')!).render(<Harness />);
