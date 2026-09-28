import { useEffect, useRef, useState } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import { invoke } from '@tauri-apps/api/core';
import './SettingsAudio.css';
import type { AppSettings } from '../SettingsModal';
import { audioPreviewUrl, resolveDictionaryAudio } from '../../utils/dictionaryAudio';

type Info = { filename: string; entries: number; sources: string[] };
export default function SettingsAudio({ settings, updateSetting }: {
    settings: AppSettings; updateSetting: <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => void;
}) {
    const english = settings.appLanguage === 'en';
    const [info, setInfo] = useState<Info | null>(null);
    const [busy, setBusy] = useState(false);
    const [message, setMessage] = useState('');
    const [term, setTerm] = useState('食べる');
    const [reading, setReading] = useState('たべる');
    const playback = useRef<(() => void) | null>(null);
    const request = useRef(0);
    useEffect(() => () => { request.current++; playback.current?.(); }, []);
    useEffect(() => {
        let disposed = false;
        request.current++; playback.current?.(); setBusy(false);
        setInfo(null); setMessage('');
        const path = settings.localAudioDatabasePath;
        if (path) invoke<Info>('inspect_local_audio_database', { path }).then(value => {
            if (!disposed) setInfo(value);
        }).catch(error => { if (!disposed) setMessage(String(error)); });
        return () => { disposed = true; };
    }, [settings.localAudioDatabasePath, settings.dictionaryAudioSource, settings.localAudioPreferredSource]);

    const choose = async () => {
        setBusy(true); setMessage('');
        try {
            const path = await open({ multiple: false, directory: false, filters: [{ name: 'Audio database', extensions: ['db', 'sqlite', 'sqlite3'] }] });
            if (typeof path !== 'string') return;
            if (path.startsWith('content://')) throw new Error(english ? 'This version supports audio databases on desktop. Android document storage is not supported yet.' : 'В этой версии базы озвучки поддерживаются на ПК. Хранилище документов Android пока не поддерживается.');
            const value = await invoke<Info>('inspect_local_audio_database', { path });
            updateSetting('localAudioDatabasePath', path);
            setInfo(value);
        } catch (error) { setMessage(String(error)); }
        finally { setBusy(false); }
    };
    const preview = async () => {
        const serial = ++request.current;
        playback.current?.(); setBusy(true); setMessage('');
        try {
            const result = await resolveDictionaryAudio(settings, term, reading);
            if (serial !== request.current) return;
            if (result.kind === 'none') { setMessage(english ? 'No recording for this word and reading.' : 'Для этого слова и чтения записи нет.'); return; }
            const source = audioPreviewUrl(result);
            const audio = new Audio(source.url);
            const dispose = () => { audio.onended = null; audio.onerror = null; audio.pause(); audio.removeAttribute('src'); audio.load(); source.dispose(); };
            playback.current = dispose;
            audio.onended = dispose;
            audio.onerror = () => { if (serial === request.current) setMessage(english ? 'Cannot play this recording.' : 'Не удалось воспроизвести запись.'); dispose(); };
            await audio.play();
            if (serial !== request.current) return;
            setMessage(result.kind === 'local' ? `${english ? 'Local database' : 'Локальная база'} · ${result.clip.source}${result.clip.speaker ? ` · ${result.clip.speaker}` : ''}` : (english ? 'Online · JapanesePod101' : 'Онлайн · JapanesePod101'));
        } catch (error) { if (serial === request.current) { playback.current?.(); setMessage(String(error)); } }
        finally { if (serial === request.current) setBusy(false); }
    };

    const mode = settings.dictionaryAudioSource || 'online';
    const usesLocal = mode !== 'online';
    const descriptions = english ? {
        online: 'Find audio on JapanesePod101. Requires an internet connection.',
        local: 'Search the selected file only. Works offline.',
        'local-first': 'Search the file first. If there is no recording, use JapanesePod101.',
        'online-first': 'Try JapanesePod101 first. If there is no recording or the service is unavailable, search the selected file.',
    } : {
        online: 'Искать озвучку на JapanesePod101. Нужно подключение к интернету.',
        local: 'Искать только в выбранном файле. Работает без интернета.',
        'local-first': 'Сначала искать в файле. Если записи нет — использовать JapanesePod101.',
        'online-first': 'Сначала искать на JapanesePod101. Если записи нет или сервис недоступен — искать в выбранном файле.',
    };
    return <section className="modern-card audio-settings" id="anki-audio">
        <header><h3>{english ? 'Word audio' : 'Озвучка слов'}</h3>
            <p>{english ? 'Choose where Setsuna finds recordings for dictionary playback and new Anki cards.' : 'Выбери, откуда Setsuna берёт озвучку для словаря и новых карточек Anki.'}</p></header>
        <div className="audio-settings-section">
            <label htmlFor="audio-source">{english ? 'Search order' : 'Порядок поиска'}</label>
            <select id="audio-source" className="modern-select" value={mode} onChange={event => updateSetting('dictionaryAudioSource', event.target.value as AppSettings['dictionaryAudioSource'])}>
                <option value="online">{english ? 'Online only — JapanesePod101' : 'Только онлайн — JapanesePod101'}</option>
                <option value="online-first">{english ? 'Online first, then local database' : 'Сначала онлайн, затем локальная база'}</option>
                <option value="local-first">{english ? 'Local database first, then online' : 'Сначала локальная база, затем онлайн'}</option>
                <option value="local">{english ? 'Local database only (offline)' : 'Только локальная база (без интернета)'}</option>
            </select>
            <p>{descriptions[mode]}</p>
        </div>
        {usesLocal && <div className="audio-settings-section audio-database">
            <div className="audio-settings-row"><h4>{english ? 'Local audio file' : 'Файл локальной озвучки'}</h4>
                <span className={info ? 'audio-file-ready' : 'audio-file-empty'}>{info ? (english ? 'Connected' : 'Подключён') : (english ? 'Not connected' : 'Не подключён')}</span></div>
            <p>{english ? 'Select an audio database in android.db format. The file stays in its current folder; Setsuna reads it without changing it.' : 'Выбери базу озвучки в формате android.db. Файл остаётся в своей папке — Setsuna читает его, не изменяя.'}</p>
            <div className="audio-settings-row">
                <button type="button" className="btn-primary" onClick={choose} disabled={busy}>{settings.localAudioDatabasePath ? (english ? 'Change file…' : 'Изменить файл…') : (english ? 'Choose file…' : 'Выбрать файл…')}</button>
                {settings.localAudioDatabasePath && <button type="button" className="audio-disconnect" disabled={busy} onClick={() => updateSetting('localAudioDatabasePath', '')}>{english ? 'Disconnect' : 'Отключить'}</button>}
            </div>
            {settings.localAudioDatabasePath && <div className="audio-file-path">{settings.localAudioDatabasePath}</div>}
            {info ? <>
                <p>{info.entries.toLocaleString(english ? 'en' : 'ru')} {english ? 'recordings available' : 'записей в базе'}</p>
                <label htmlFor="audio-preferred">{english ? 'Preferred source within the file' : 'Предпочтительный источник внутри файла'}</label>
                <select id="audio-preferred" className="modern-select" value={info.sources.includes(settings.localAudioPreferredSource || '') ? settings.localAudioPreferredSource : ''} onChange={event => updateSetting('localAudioPreferredSource', event.target.value)}>
                    <option value="">{english ? 'Automatic — any matching recording' : 'Автоматически — любая подходящая запись'}</option>
                    {info.sources.map(source => <option key={source} value={source}>{source}</option>)}
                </select>
                <p>{english ? 'If the preferred source has no recording, other sources in this file are checked.' : 'Если у этого источника нет записи, поиск продолжится в других источниках файла.'}</p>
            </> : !settings.localAudioDatabasePath && <p className="audio-file-warning">{english ? 'Choose a file to enable local audio search.' : 'Выбери файл, чтобы включить поиск локальной озвучки.'}</p>}
        </div>}
        <div className="audio-settings-section">
            <h4>{english ? 'Test audio' : 'Проверить озвучку'}</h4>
            <p>{english ? 'Uses the search order above and shows which source was found. Does not create an Anki card.' : 'Проверка использует выбранный порядок поиска и показывает найденный источник. Карточка Anki не создаётся.'}</p>
            <div className="audio-test-fields">
                <label>{english ? 'Word' : 'Слово'}<input className="modern-input" value={term} onChange={e => setTerm(e.target.value)} placeholder="食べる" maxLength={200} /></label>
                <label>{english ? 'Reading (optional)' : 'Чтение (необязательно)'}<input className="modern-input" value={reading} onChange={e => setReading(e.target.value)} placeholder="たべる" maxLength={200} /></label>
            </div>
            <button type="button" className="btn-primary" disabled={busy || !term.trim()} onClick={preview}>{busy ? (english ? 'Checking…' : 'Проверяю…') : (english ? 'Listen to a sample' : 'Прослушать пример')}</button>
            {message && <p className="audio-test-result" role="status">{message}</p>}
        </div>
        <p>{english ? 'For player cards, a selected clip takes priority over word audio.' : 'Для карточек из плеера выбранный клип имеет приоритет перед озвучкой слова.'}</p>
    </section>;
}
