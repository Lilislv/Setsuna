import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { TopBar as ReaderChrome } from '../src/components/ReaderChrome';
import { themes, defaultStats } from '../src/utils/constants';
import '../src/index.css';
import '../src/App.css';

// Visual check for the tab menu with the archive view. Native commands are mocked.
Object.entries(themes.dark).forEach(([key, value]) => document.documentElement.style.setProperty(key, String(value)));
(window as any).__TAURI_INTERNALS__ = { invoke: async () => null, transformCallback: () => 1, unregisterCallback: () => {} };

const many = Array.from({ length: 14 }, (_, i) => ({ id: 100 + i, name: `Новелла ${i + 1}`, lines: [], stats: { ...defaultStats, chars: 1000 * (i + 1) } }));
const initial = [
    { id: 1, name: 'I/O', lines: [], stats: { ...defaultStats, chars: 11004 }, status: 'reading' },
    { id: 2, name: '13 se', lines: [], stats: { ...defaultStats, chars: 9517 }, status: 'paused' },
    { id: 3, name: 'Root Double', lines: [], stats: { ...defaultStats, chars: 120000 }, archived: true },
    { id: 4, name: 'Anemoi', lines: [], stats: { ...defaultStats, chars: 98000 }, archived: true },
    ...many,
] as any[];

function Harness() {
    const [tabs, setTabs] = useState<any[]>(initial);
    const [active, setActive] = useState(1);
    const [editing, setEditing] = useState<number | null>(null);
    (window as any).__state = { tabs, active };
    return (
        <div style={{ height: '100vh', background: 'var(--bg-main)' }}>
            <ReaderChrome
                tabs={tabs} setTabs={setTabs} activeTabId={active} switchTab={setActive} editingTabId={editing} setEditingTabId={setEditing}
                closeTab={() => {}} cycleTabStatus={() => {}} addNewTab={() => { const id = Date.now(); setTabs((prev) => [...prev, { id, name: `Окно ${prev.length + 1}`, lines: [], stats: { ...defaultStats } }]); setActive(id); }}
                settings={{ appLanguage: 'ru', websockets: [] }} wsStatuses={{}} wsIntents={{}} toggleWs={() => {}}
                useClipboard toggleClipboard={() => {}} openSearch={() => {}} openImport={() => {}} openExport={() => {}}
                activeTab={tabs.find((t) => t.id === active)} openCaptureSourcePicker={() => {}} openJlModeWindow={() => {}}
                flowOpen={false} toggleFlow={() => {}} clearAll={() => {}} openHome={() => {}} openSettings={() => {}}
                lookupOpen={false} closeLookup={() => {}} escMenuBlocked={false}
            />
        </div>
    );
}
createRoot(document.getElementById('root')!).render(<Harness />);
