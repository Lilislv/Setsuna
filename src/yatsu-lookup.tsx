import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import Lookuper, { type LookupData } from './components/Lookuper';
import type { AppSettings } from './components/SettingsModal';
import { createHoverScanQueue } from './utils/hoverScan';
import { selectActiveLookupResult } from './utils/lookupResults';
import './App.css';
import './jl-popup.css';
import './yatsu-lookup.css';

type Request = { revision: number; sentence: string; cursor: number };
const readSettings = (): AppSettings => {
    try { return JSON.parse(localStorage.getItem('txthk-settings') || '{}'); } catch { return {} as AppSettings; }
};
function YatsuLookup() {
    const [settings, setSettings] = useState(readSettings);
    const [stack, setStack] = useState<LookupData[]>([]);
    const [status, setStatus] = useState('');
    const settingsRef = useRef(settings); settingsRef.current = settings;
    const isEn = settings.appLanguage === 'en';
    const dismiss = () => { void invoke('dismiss_yatsu_lookup', { revision: null }); };
    useEffect(() => {
        const escape = (event: KeyboardEvent) => { if (event.key === 'Escape' && !event.repeat) { event.preventDefault(); event.stopImmediatePropagation(); dismiss(); } };
        window.addEventListener('keydown', escape, true);
        return () => window.removeEventListener('keydown', escape, true);
    }, []);
    useEffect(() => {
        let disposed = false, unlisten: (() => void) | undefined, revision = 0;
        const queue = createHoverScanQueue<Request>((a, b) => a.revision === b.revision, async (request, isCurrent) => {
            setStack([]); setStatus(settingsRef.current.appLanguage === 'en' ? 'Looking up…' : 'Ищу слово…');
            try {
                const raw = await invoke('scan_cursor', { sentence: request.sentence, cursor: request.cursor });
                if (!isCurrent()) return;
                const result = selectActiveLookupResult(raw, request.sentence, settingsRef.current);
                if (result) {
                    setStack([{ ...result, sentence: request.sentence, rect: new DOMRect(10, 8, 1, 1), source: 'internal' }]);
                    setStatus('');
                    await invoke('show_yatsu_lookup', { revision: request.revision, width: (settingsRef.current.lookupWidth || 420) * (settingsRef.current.lookupScale || 1) });
                    if (!isCurrent()) return;
                } else setStatus(settingsRef.current.appLanguage === 'en' ? 'No match in enabled dictionaries.' : 'Нет совпадений во включённых словарях.');
                await invoke('highlight_yatsu_match', { revision: request.revision, start: result?.match_start || 0, length: result?.match_len || 0 });
            } catch (error) {
                if (isCurrent()) {
                    setStatus(String(error));
                    void invoke('highlight_yatsu_match', { revision: request.revision, start: 0, length: 0 }).catch(() => {});
                }
            }
        });
        const apply = (request: Request) => {
            if (disposed || request.revision <= revision) return;
            revision = request.revision;
            if (!request.sentence) { queue.request(null); setStack([]); setStatus(''); return; }
            queue.request(request);
        };
        void listen<Request>('yatsu-scan', event => apply(event.payload)).then(async stop => {
            if (disposed) { stop(); return; }
            unlisten = stop;
            try { apply(await invoke<Request>('get_yatsu_request')); } catch (error) { if (!disposed) setStatus(String(error)); }
        }).catch(error => { if (!disposed) setStatus(String(error)); });
        const refresh = () => setSettings(readSettings());
        window.addEventListener('storage', refresh);
        window.addEventListener('focus', refresh);
        return () => { disposed = true; queue.dispose(); unlisten?.(); window.removeEventListener('storage', refresh); window.removeEventListener('focus', refresh); };
    }, []);
    return <main className="jl-popup-root yatsu-lookup-root">
        <button className="jl-popup-close" onClick={dismiss} aria-label={isEn ? 'Close lookup' : 'Закрыть лукап'}>×</button>
        <div className="jl-popup-content">
            {!stack.length && status && <div className="jl-popup-empty" role="status">{status}</div>}
            <Lookuper stack={stack} settings={{ ...settings, lookupHotkey: 'Shift' }} ankiDeck={settings.ankiDeck}
                screenshotSource={{ kind: 'none' }}
                onAppend={data => setStack(previous => [...previous, data])} onReplace={data => setStack([data])}
                onReplaceAt={(index, data) => setStack(previous => [...previous.slice(0, index + 1), data])}
                onSlice={index => setStack(previous => previous.slice(0, index + 1))} />
        </div>
    </main>;
}
createRoot(document.getElementById('root')!).render(<YatsuLookup />);
