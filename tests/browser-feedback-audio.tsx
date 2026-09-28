import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import SettingsFeedback from '../src/components/Settings/SettingsFeedback';
import SettingsAudio from '../src/components/Settings/SettingsAudio';
import { MobileLayout } from '../src/components/AppLayout';
import { DEFAULT_SETTINGS, defaultStats } from '../src/utils/constants';
import '../src/index.css';
import '../src/App.css';
import '../src/components/SettingsModal.css';

// Isolated UI fixture: never opens GitHub, writes the real clipboard or changes app settings.
// Optional ?sample=1 reads output/audio-preview-test.mp3 extracted locally by the developer.
const silentWav = () => {
    const bytes = new Uint8Array(44 + 8000); const view = new DataView(bytes.buffer);
    const put = (offset, text) => [...text].forEach((char, index) => { bytes[offset + index] = char.charCodeAt(0); });
    put(0, 'RIFF'); view.setUint32(4, bytes.length - 8, true); put(8, 'WAVEfmt '); view.setUint32(16, 16, true);
    view.setUint16(20, 1, true); view.setUint16(22, 1, true); view.setUint32(24, 8000, true); view.setUint32(28, 8000, true);
    view.setUint16(32, 1, true); view.setUint16(34, 8, true); put(36, 'data'); view.setUint32(40, 8000, true); bytes.fill(128, 44);
    return bytes;
};
let report = (_value: string) => {};
(window as any).__TAURI_INTERNALS__ = { transformCallback: () => 1, unregisterCallback: () => {}, invoke: async (command, args) => {
    if (command === 'plugin:event|listen') return 1;
    if (command === 'plugin:event|unlisten') return;
    if (command === 'plugin:app|version') return '0.1.3';
    if (command === 'plugin:dialog|open') return 'fixture.db';
    if (command === 'inspect_local_audio_database') return { filename: 'fixture.db', entries: 877464, sources: ['nhk16', 'shinmeikai8'] };
    if (command === 'lookup_local_audio') {
        const sample = new URLSearchParams(location.search).has('sample');
        const bytes = sample ? new Uint8Array(await (await fetch('/output/audio-preview-test.mp3')).arrayBuffer()) : silentWav();
        return { data: btoa(String.fromCharCode(...bytes)), mimeType: sample ? 'audio/mpeg' : 'audio/wav', filename: sample ? 'sample.mp3' : 'sample.wav', source: 'nhk16', speaker: '', display: '', reading: 'たべる' };
    }
    if (command === 'plugin:opener|open_url') { report(`PASS GitHub draft intercepted: ${new URL(args.url).pathname}`); return; }
    if (command === 'plugin:clipboard-manager|write_text') { report(`PASS clipboard intercepted: ${args.text.length} characters`); return; }
    throw new Error(`Unexpected fixture command: ${command}`);
} };
localStorage.setItem('setsuna-feedback-draft-v1', JSON.stringify({ kind: 'bug', title: 'Проверка ドジ', description: 'Тест формы: японский текст & символы ? #', steps: 'Открыть словарь', expected: 'Найти ドジ', includeEnvironment: true }));
function Harness() {
    const [settings, setSettings] = useState<any>({ appLanguage: 'ru', dictionaryAudioSource: 'local', localAudioDatabasePath: 'fixture.db', localAudioPreferredSource: 'nhk16' });
    const [messages, setMessages] = useState<string[]>([]);
    report = value => setMessages(previous => [...previous, value]);
    const [mobileSettings, setMobileSettings] = useState<any>({ ...DEFAULT_SETTINGS, mobileOverlayEnabled: false });
    if (new URLSearchParams(location.search).has('mobile')) return <>
        <style>{`.mobile-settings-backdrop{width:390px;right:auto}.mobile-settings-sheet{width:390px;max-width:100%}.fixture-results{position:fixed;left:410px;top:20px;max-width:450px;white-space:pre-wrap;z-index:100000}`}</style>
        <pre className="fixture-results">{messages.join('\n')}</pre>
        <MobileLayout settings={mobileSettings} updateSettings={setMobileSettings} settingsRequest={{ id: 1, section: 'reading' }}
            tabs={[]} activeTabId={1} activeTab={{ id: 1, name: 'Fixture', lines: [], stats: defaultStats }}
            isPaused={true} setIsPaused={() => {}} />
    </>;
    return <><style>{`html,body,#root{min-height:100%;margin:0;background:#202124;color:#eee} .settings-window{position:relative;transform:none;max-width:920px;width:auto;height:auto;margin:24px auto;padding:20px;display:block} .modern-card{margin:18px 0} pre{white-space:pre-wrap}`}</style>
        <div className="settings-window"><pre>{messages.join('\n')}</pre><SettingsFeedback english={false} />
        <SettingsAudio settings={settings} updateSetting={(key, value) => setSettings(previous => ({ ...previous, [key]: value }))} /></div></>;
}
createRoot(document.getElementById('root')!).render(<Harness />);
