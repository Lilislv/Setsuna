import { createRoot } from 'react-dom/client';
import DictionaryShare from '../src/components/Settings/DictionaryShare';
import { themes } from '../src/utils/constants';
import '../src/index.css';
import '../src/App.css';

// Visual check for the dictionary sharing dialog. Native commands are mocked.
Object.entries(themes.dark).forEach(([key, value]) => document.documentElement.style.setProperty(key, String(value)));
(window as any).__TAURI_INTERNALS__ = {
    invoke: async (cmd: string) => cmd === 'inspect_shared_dictionaries'
        ? { format: 3, title: 'Японский набор', dictionaries: [
            { name: 'JMdict (Russian)', rows: 100634, sizeBytes: 9_800_000 },
            { name: 'Warodai', rows: 107341, sizeBytes: 4_300_000 },
            { name: 'Kenrowa', rows: 163342, sizeBytes: 11_200_000 },
            { name: 'JPDB frequency', rows: 520000, sizeBytes: 2_100_000 },
        ] }
        : null,
    transformCallback: () => 1,
    unregisterCallback: () => {},
};
const tab = (new URLSearchParams(location.search).get('tab') || 'share') as 'share' | 'receive' | 'mine';
const dictionaries = ['JMdict (Russian)', 'Warodai', 'wty-en-ru', 'wty-en-en', 'Leipzig English Web', 'JPDB frequency'].map((name) => ({ name }));

createRoot(document.getElementById('root')!).render(
    <div style={{ height: '100vh', background: 'var(--bg-main)' }}>
        <DictionaryShare language="ru" dictionaries={dictionaries} initialSelection={['wty-en-ru', 'wty-en-en']} initialTab={tab} onClose={() => {}} syncDictionaries={async () => {}} />
    </div>,
);
