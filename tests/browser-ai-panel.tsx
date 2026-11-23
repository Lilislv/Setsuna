import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import TextContainer from '../src/components/TextContainer';
import AiPanel, { type AiPanelRequest } from '../src/components/AiPanel';
import { themes } from '../src/utils/constants';
import '../src/index.css';
import '../src/App.css';

// Browser check for the AI panel: reader line buttons, picking lines and the
// docked panel with a streamed answer. Native commands are mocked.

Object.entries(themes.dark).forEach(([key, value]) => document.documentElement.style.setProperty(key, String(value)));

const lines = [
    '「おまえ、ちょっと今日おかしいぞ。何かあったか？」',
    '「実は二日目なのですよ」',
    '「蓮、アホか」',
    '「アホってなによ。ほんとのことなのに」',
    '「ほんとなら、なおさらそんなの公言するなよ。年頃の乙女が」',
];

const callbacks = new Map<number, (event: unknown) => void>();
const listeners = new Map<string, number[]>();
let nextCallback = 1;
const w = window as any;
w.__aiCalls = [];
w.__TAURI_INTERNALS__ = {
    transformCallback: (cb: (event: unknown) => void) => { const id = nextCallback++; callbacks.set(id, cb); return id; },
    unregisterCallback: (id: number) => callbacks.delete(id),
    invoke: async (command: string, args: any) => {
        if (command === 'plugin:event|listen') { listeners.set(args.event, [...(listeners.get(args.event) || []), args.handler]); return args.handler; }
        if (command === 'plugin:event|unlisten') return null;
        if (command === 'ai_history_load') return { version: 1, threads: [
            { id: 'old1', tabId: 2, tabName: 'Yakuza 0', createdAt: Date.now() - 86400000, messages: [
                { role: 'user', content: 'x', lines: ['Kiryu-chan, you got a minute?'] },
                { role: 'assistant', content: '**Перевод**\nКирю-тян, есть минутка?' },
            ] },
        ] };
        if (command === 'ai_history_save') { w.__aiSaved = args.data; return null; }
        if (command === 'ai_chat') {
            w.__aiCalls.push(args);
            if (args.messages[0].content.startsWith('You extract')) {
                await new Promise((r) => setTimeout(r, 300));
                return { content: '```json\n[{"term": "蓮", "reading": "れん", "note": "Рэн, друг Касуми"}, {"term": "Придуманный", "reading": "", "note": "нет в тексте"}]\n```' };
            }
            const emit = (payload: unknown) => (listeners.get('ai://chunk') || []).forEach((id) => callbacks.get(id)?.({ event: 'ai://chunk', id, payload }));
            const last = args.messages[args.messages.length - 1]?.content || '';
            const text = !/шаблону/.test(last) ? 'Обычный ответ без шаблона: ' + last.slice(0, 40) : '### Перевод\n«Ты сегодня какой-то странный». — «На самом деле, это второй день».\n\n### Смысл\nКасуми намекает на месячные.\n\n### Слова и грамматика\n- **二日目**（ふつかめ） — «второй день»';
            for (const piece of text.match(/.{1,8}/gs) || []) {
                emit({ requestId: args.requestId, content: piece, reasoning: '' });
                await new Promise((r) => setTimeout(r, 15));
            }
            return { content: text, tokensPerSecond: 80 };
        }
        if (command.startsWith('plugin:')) return null;
        return null;
    },
};

function Harness() {
    const [open, setOpen] = useState(false);
    const [request, setRequest] = useState<AiPanelRequest | null>(null);
    const [tab, setTab] = useState<{ id: number; name: string }>({ id: 1, name: 'Dies Irae' });
    return (
        <div style={{ height: '100vh', display: 'flex', flexDirection: 'column', background: 'var(--bg-main)' }}>
            <div style={{ display: 'flex', gap: 8, padding: 8 }}>
                <button id="tab1" onClick={() => setTab({ id: 1, name: 'Dies Irae' })}>Dies Irae</button>
                <button id="tab2" onClick={() => setTab({ id: 2, name: 'Yakuza 0' })}>Yakuza 0</button>
                <button id="openai" onClick={() => setOpen(true)}>AI</button>
            </div>
            <div className="reader-row">
                <div className="reader-stage">
                    <main className="main-content" style={{ flex: 1, minHeight: 0, overflow: 'hidden', display: 'flex' }}>
                        <TextContainer
                            contentKey="ai"
                            lines={lines}
                            onDelete={() => {}}
                            onEdit={() => {}}
                            furiganaMode="none"
                            onExplainLines={(indices: number[]) => {
                                setRequest({ id: Date.now(), request: { tabId: tab.id, tabName: tab.name, lines: indices.map((i) => lines[i]) } });
                                setOpen(true);
                            }}
                        />
                    </main>
                </div>
                <AiPanel open={open} settings={{ appLanguage: 'ru', aiExplainLanguage: 'ru', aiModel: 'gemma-4-e4b' }} request={request} activeTabId={tab.id} activeTabName={tab.name} onClose={() => setOpen(false)} />
            </div>
        </div>
    );
}

createRoot(document.getElementById('root')!).render(<Harness />);
