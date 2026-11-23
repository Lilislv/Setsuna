import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import SharedReadingDialog from '../src/components/SharedReadingDialog';
import { useSharedReading } from '../src/utils/useSharedReading';
import { defaultStats, isTabLocked, themes, type Tab } from '../src/utils/constants';
import '../src/index.css';
import '../src/App.css';

// One Setsuna "client" per page (?side=host or ?side=viewer): open both in two
// tabs. They find each other through public Nostr relays and talk over WebRTC.

Object.entries(themes.dark).forEach(([key, value]) => document.documentElement.style.setProperty(key, String(value)));
const count = (text: string) => ({ chars: text.replace(/\s/g, '').length, words: 0, sentences: 0 });

function Client({ side, initial }: { side: 'host' | 'viewer'; initial: Tab[] }) {
    const [tabs, setTabs] = useState<Tab[]>(initial);
    const [activeId, setActiveId] = useState(initial[0].id);
    const [dialog, setDialog] = useState(false);
    const [draft, setDraft] = useState('');
    const shared = useSharedReading({ tabs, setTabs, countStats: count });
    const active = tabs.find((t) => t.id === activeId) || tabs[0];
    const locked = isTabLocked(active);
    const setLines = (lines: string[]) => setTabs((prev) => prev.map((t) => (t.id === active.id ? { ...t, lines } : t)));
    const join = async (code: string) => {
        const id = Date.now();
        setTabs((prev) => [...prev, { id, name: code, lines: [], stats: { ...defaultStats }, shared: { code, role: 'viewer' } }]);
        setActiveId(id);
    };
    return (
        <div className={`client client-${side}`} style={{ flex: 1, padding: 14, borderRight: '1px solid var(--border-main)', display: 'flex', flexDirection: 'column', gap: 8, minWidth: 0 }}>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                <b style={{ marginRight: 6 }}>{side === 'host' ? 'Хост' : 'Зритель'}</b>
                {tabs.map((t) => (
                    <button key={t.id} className="tabbtn" onClick={() => setActiveId(t.id)} style={{ fontWeight: t.id === active.id ? 700 : 400 }}>
                        {t.name}{t.shared ? (t.shared.role === 'host' ? ' ●host' : t.shared.ended ? ' (end)' : ' ●live') : ''}
                    </button>
                ))}
                <button className="open-dialog" onClick={() => setDialog(true)}>Читать вместе</button>
            </div>
            <div className="status" style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                {JSON.stringify(shared.status[active.id] || null)} {locked ? '· только чтение' : ''}
            </div>
            <ol className="lines" style={{ margin: 0, paddingLeft: 22, fontSize: 18, flex: 1, overflow: 'auto' }}>
                {active.lines.map((line, i) => (
                    <li key={i}>
                        {line}{' '}
                        {!locked && <>
                            <button className="edit" onClick={() => { const n = [...active.lines]; n[i] = `${line}（改）`; setLines(n); }}>✎</button>
                            <button className="del" onClick={() => setLines(active.lines.filter((_, j) => j !== i))}>×</button>
                        </>}
                    </li>
                ))}
            </ol>
            {!locked && (
                <form onSubmit={(e) => { e.preventDefault(); if (draft.trim()) { setLines([...active.lines, draft.trim()]); setDraft(''); } }} style={{ display: 'flex', gap: 6 }}>
                    <input className="add" value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Новая строка (как из хука)" style={{ flex: 1 }} />
                    <button type="submit">+</button>
                </form>
            )}
            <SharedReadingDialog
                open={dialog}
                tab={active}
                status={shared.status[active.id]}
                en={false}
                onStart={shared.startHosting}
                onStop={shared.stopHosting}
                onJoin={join}
                onKeep={shared.keepCopy}
                onLeave={(id) => { setTabs((prev) => prev.filter((t) => t.id !== id)); setActiveId(tabs[0].id); }}
                onClose={() => setDialog(false)}
            />
        </div>
    );
}

const hostTabs: Tab[] = [{ id: 1, name: 'Dies Irae', lines: ['「おまえ、ちょっと今日おかしいぞ」', '「実は二日目なのですよ」'], stats: { ...defaultStats } }];
const viewerTabs: Tab[] = [{ id: 1, name: 'Моя вкладка', lines: ['своя строка'], stats: { ...defaultStats } }];

createRoot(document.getElementById('root')!).render(
    <div style={{ display: 'flex', height: '100vh', background: 'var(--bg-main)', color: 'var(--text-main)', fontFamily: 'sans-serif' }}>
        {new URLSearchParams(location.search).get('side') === 'viewer'
            ? <Client side="viewer" initial={viewerTabs} />
            : <Client side="host" initial={hostTabs} />}
    </div>,
);
