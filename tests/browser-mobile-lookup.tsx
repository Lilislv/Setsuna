import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import TextContainer from '../src/components/TextContainer';
import { MobileLayout } from '../src/components/AppLayout';
import { DEFAULT_SETTINGS, defaultStats } from '../src/utils/constants';
import '../src/index.css';
import '../src/App.css';
import '../src/components/SettingsModal.css';

const sentence = '猫と犬と鳥';
(window as any).__TAURI_INTERNALS__ = { invoke: async (command: string) => {
    if (command === 'get_furigana') return Array.from(sentence).map((text, start) => ({ text, start, lookup: true }));
    if (command === 'lookup_word' || command === 'check_dictionary_updates') return [];
    if (command === 'get_installed_dicts') return ['Test dictionary'];
    if (command === 'plugin:app|version') return 'test';
    if (command.includes('listen')) return 1;
    return null;
}, transformCallback: () => 1, unregisterCallback: () => {} };

function Harness() {
    const [calls, setCalls] = useState<string[]>([]);
    const [paused, setPaused] = useState(true);
    const [settings, setSettings] = useState({ ...DEFAULT_SETTINGS, dictionaries: [{ name: 'Test dictionary', active: true, color: '#66aaff' }] });
    const lookup = async (token: string, _sentence: string, cursor: number) => {
        setCalls(previous => [...previous, `${token}:${cursor}`]);
        return { start: cursor, length: 1 };
    };
    if (location.search.includes('layout')) return <MobileLayout settings={settings} updateSettings={setSettings}
        settingsRequest={location.search.includes('settings') ? { id: 1, section: 'data' } : undefined}
        tabs={[]} activeTabId={1} activeTab={{ id: 1, name: 'Fixture', lines: [], stats: defaultStats }}
        isPaused={paused} setIsPaused={setPaused} syncDictionaries={async () => {}} runDictImport={async () => true}
        setConfirmDialog={() => {}} />;
    return <div style={{ height: '95vh', display: 'flex', flexDirection: 'column' }}>
        <pre id="results">{calls.join('|')}</pre>
        <TextContainer contentKey="test" lines={[sentence]} onLookupToken={lookup} lookupActive={calls.length > 0}
            lineFurigana={location.search.includes('supplied') ? [[{ text: sentence, reading: 'ねこといぬととり' }]] : []}
            onEdit={() => { throw new Error('Lookup must not edit the line'); }} onDelete={() => {}} furiganaMode="none" />
        <button id="outside">Outside focus</button>
    </div>;
}
createRoot(document.getElementById('root')!).render(<Harness />);
