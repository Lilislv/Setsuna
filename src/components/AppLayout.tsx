import {
    IconSearch,
    IconWifi,
    IconImport,
    IconExport,
    IconBrowser,
    IconClear,
    IconSettings,
    IconPin,
    IconHome,
    IconTextTab,
    IconBookTab,
    IconPlayerTab,
    IconChevronUp,
    IconChevronDown,
    IconClose,
} from './Icons';
import { defaultStats, EMPTY_LINES, Tab, BrowserTab } from '../utils/constants';
import { useEffect, useRef, useState, type PointerEvent } from 'react';
import { getTranslator } from '../utils/i18n';
import TextContainer from './TextContainer';
import StatsPanel from './StatsPanel';
import { invoke } from '@tauri-apps/api/core';
import { openUrl } from '@tauri-apps/plugin-opener';
import { readText as readClipboardText } from '@tauri-apps/plugin-clipboard-manager';
import { listen } from '@tauri-apps/api/event';
import {
    createDictFileMetadata,
    downloadFromDrive,
    exchangeCodeForToken,
    getAccessToken,
    getAuthUrl,
    getDictDriveInfo,
    listBackups,
    uploadToDrive,
} from '../utils/gdrive';
import { GOOGLE_DRIVE_AVAILABLE } from '../utils/featureFlags';
import { tokenizeLookupText, normalizeWebSocketUrl } from '../utils/appRuntime';
import {
    clearAnkiMetaCache,
    getAnkiDroidStatus,
    getDecks,
    getModelFields,
    getModels,
    requestAnkiDroidPermission,
} from '../utils/anki';

const TAB_WINDOW_START_STORAGE_KEY = 'txthk-tab-window-start';

export const SearchBar = ({
    isOpen,
    isHelperSpaceReserved,
    reservedWidth,
    searchQuery,
    setSearchQuery,
    onClose,
    onNext,
    onPrev,
    resultsLength,
    currentIdx,
    inputRef,
    language = 'ru',
}: any) => {
    if (!isOpen) return null;
    const t = getTranslator(language);

    return (
        <div
            className="search-bar-anim"
            onClick={(e) => e.stopPropagation()}
            style={{
                position: 'absolute',
                top: '65px',
                right: isHelperSpaceReserved ? `${reservedWidth + 20}px` : '20px',
                background: 'var(--bg-panel)',
                border: '1px solid var(--border-main)',
                padding: '10px 16px',
                borderRadius: '12px',
                zIndex: 1000,
                display: 'flex',
                alignItems: 'center',
                gap: '12px',
                boxShadow: '0 8px 24px rgba(0,0,0,0.4)',
                transition: 'right 0.3s cubic-bezier(0.4, 0, 0.2, 1)',
            }}
        >
            <IconSearch />

            <input
                ref={inputRef}
                type="text"
                placeholder={t('common.searchTextPlaceholder')}
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                        if (e.shiftKey) onPrev();
                        else onNext();
                    } else if (e.code === 'Escape') {
                        onClose();
                    }
                }}
                style={{
                    background: 'transparent',
                    border: 'none',
                    color: 'var(--text-main)',
                    outline: 'none',
                    width: '180px',
                    fontSize: '15px',
                }}
            />

            <span
                style={{
                    color: 'var(--text-muted)',
                    fontSize: '13px',
                    minWidth: '45px',
                    textAlign: 'center',
                    background: 'var(--bg-side)',
                    padding: '2px 6px',
                    borderRadius: '4px',
                }}
            >
                {resultsLength > 0 ? `${currentIdx + 1} / ${resultsLength}` : '0 / 0'}
            </span>

            <div
                style={{
                    display: 'flex',
                    gap: '4px',
                    borderLeft: '1px solid var(--border-main)',
                    paddingLeft: '8px',
                }}
            >
                <button
                    onClick={onPrev}
                    disabled={resultsLength === 0}
                    aria-label={t('common.back')}
                    title={t('common.back')}
                    style={{
                        background: 'transparent',
                        border: 'none',
                        color: 'var(--text-main)',
                        cursor: 'pointer',
                        padding: '4px',
                    }}
                >
                    <IconChevronUp />
                </button>

                <button
                    onClick={onNext}
                    disabled={resultsLength === 0}
                    aria-label={t('common.next')}
                    title={t('common.next')}
                    style={{
                        background: 'transparent',
                        border: 'none',
                        color: 'var(--text-main)',
                        cursor: 'pointer',
                        padding: '4px',
                    }}
                >
                    <IconChevronDown />
                </button>
            </div>

            <button
                onClick={onClose}
                aria-label={t('common.close')}
                title={t('common.close')}
                style={{
                    background: 'transparent',
                    border: 'none',
                    color: 'var(--text-muted)',
                    cursor: 'pointer',
                    padding: '4px',
                }}
            >
                <IconClose />
            </button>
        </div>
    );
};

export const MobileLayout = ({
    tabs,
    activeTab,
    activeTabId,
    switchTab,
    addNewTab,
    closeTab,
    settings,
    isPaused,
    setIsPaused,
    deleteLine,
    editLine,
    searchQuery,
    searchResults,
    currentSearchIdx,
    searchTrigger,
    onSubmitText,
    onLookupText,
    onLookupSentenceToken,
    updateSettings,
    setTabs,
    syncDictionaries,
    openImport,
    clearAll,
    wsStatuses,
    wsConnecting,
    wsIntents,
    toggleWs,
    lookupOpen,
}: any) => {
    const t = getTranslator(settings?.appLanguage || 'ru');
    const [activeMobileView, setActiveMobileView] = useState<'text' | 'lookup'>('text');
    const [lookupText, setLookupText] = useState('');
    const [isMobileSettingsOpen, setIsMobileSettingsOpen] = useState(false);
    const [isStatsOpen, setIsStatsOpen] = useState(false);
    const [tabsOpen, setTabsOpen] = useState(false);
    const [driveStatus, setDriveStatus] = useState('');
    const [driveAuthInput, setDriveAuthInput] = useState('');
    const [driveBusy, setDriveBusy] = useState(false);
    const [ankiStatusText, setAnkiStatusText] = useState('');
    const [ankiDecks, setAnkiDecks] = useState<string[]>([]);
    const [ankiModels, setAnkiModels] = useState<string[]>([]);
    const [ankiFields, setAnkiFields] = useState<string[]>([]);
    const [ankiBusy, setAnkiBusy] = useState(false);
    const visibleTabs = (tabs || []).filter((tab: Tab) => !tab.archived);
    const stats = activeTab?.stats || defaultStats;
    const isEn = settings?.appLanguage === 'en';
    const pasteAndConnectDrive = async () => {
        let text = '';
        try {
            text = await readClipboardText();
        } catch {
            try { text = await navigator.clipboard.readText(); } catch {}
        }
        text = (text || '').trim();
        if (!text) {
            setDriveStatus(isEn ? 'Clipboard is empty — copy the address first.' : 'Буфер пуст — сначала скопируй адрес.');
            return;
        }
        setDriveAuthInput(text);
        const code = text;
        setDriveBusy(true);
        setDriveStatus(isEn ? 'Connecting...' : 'Подключаю...');
        try {
            const tokenData = await exchangeCodeForToken(code, 'http://127.0.0.1:1337');
            if (!tokenData.refresh_token) throw new Error(isEn ? 'Google did not return a refresh token.' : 'Google не выдал refresh token.');
            updateSetting('gdriveRefreshToken', tokenData.refresh_token);
            setDriveAuthInput('');
            setDriveStatus(isEn ? 'Google Drive connected.' : 'Google Drive подключён.');
        } catch (error: any) {
            setDriveStatus(error?.message || String(error));
        } finally {
            setDriveBusy(false);
        }
    };

    const submitDraft = () => {
        const text = lookupText.trim();
        if (!text) return;
        onSubmitText(text);
        setLookupText('');
    };

    const lookupTypedToken = (token: string, cursor: number) => {
        const sentence = lookupText || token;
        onLookupSentenceToken?.(token, sentence, cursor);
    };

    const updateSetting = (key: string, value: any) => {
        if (updateSettings) {
            updateSettings({ ...settings, [key]: value });
        }
    };

    const updateManySettings = (patch: Record<string, any>) => {
        if (updateSettings) {
            updateSettings({ ...settings, ...patch });
        }
    };

    // Mobile text source over WebSocket (e.g. Textractor / LunaTranslator WS server
    // running on a Steam Deck / PC on the same network). Reuses the shared websocket
    // client in App.tsx by persisting a single dedicated entry in settings.websockets.
    const MOBILE_WS_ID = 'mobile-ws';
    const mobileWs = (settings.websockets || []).find((w: any) => w.id === MOBILE_WS_ID) || null;
    const wsConnected = !!(wsStatuses && wsStatuses[MOBILE_WS_ID]);
    const wsIsConnecting = !!(wsConnecting && wsConnecting[MOBILE_WS_ID]) && !wsConnected;
    const wsIntentOn = !!(wsIntents && wsIntents[MOBILE_WS_ID]);
    const [wsDraftUrl, setWsDraftUrl] = useState(mobileWs?.url || '');

    const persistMobileWsUrl = (rawUrl: string, active: boolean) => {
        const url = normalizeWebSocketUrl(rawUrl);
        const list: any[] = Array.isArray(settings.websockets) ? [...settings.websockets] : [];
        const idx = list.findIndex((w) => w.id === MOBILE_WS_ID);
        if (idx >= 0) list[idx] = { ...list[idx], url, active };
        else list.push({ id: MOBILE_WS_ID, name: isEn ? 'Phone source' : 'Источник телефона', url, active });
        updateManySettings({
            websockets: list,
            websocketAutoConnect: true,
            primaryWebSocketId: MOBILE_WS_ID,
        });
        return url;
    };

    const connectMobileWs = () => {
        const url = normalizeWebSocketUrl(wsDraftUrl);
        if (!url) return;
        setWsDraftUrl(url);
        persistMobileWsUrl(url, true);
        if (toggleWs && !wsIntentOn) toggleWs(MOBILE_WS_ID);
        // Connecting a text source means "I want to read now" - the app starts
        // paused, which would otherwise silently drop the incoming lines.
        if (setIsPaused) setIsPaused(false);
    };

    const disconnectMobileWs = () => {
        if (toggleWs && wsIntentOn) toggleWs(MOBILE_WS_ID);
    };

    const wsStatusLabel = wsConnected
        ? (isEn ? 'Connected - receiving text' : 'Подключено - принимаю текст')
        : wsIsConnecting
            ? (isEn ? 'Connecting...' : 'Подключаюсь...')
            : wsIntentOn
                ? (isEn ? 'Waiting for source...' : 'Жду источник...')
                : (isEn ? 'Not connected' : 'Не подключено');

    const findAnkiField = (fields: string[], ...candidates: string[]) => {
        const normalized = candidates.map((item) => item.toLowerCase().replace(/[^a-z0-9]/g, ''));
        return fields.find((field) => normalized.includes(field.toLowerCase().replace(/[^a-z0-9]/g, ''))) || 'none';
    };

    const loadMobileAnki = async (force = false) => {
        setAnkiBusy(true);
        try {
            const status = await getAnkiDroidStatus().catch(() => null);
            const decks = await getDecks(force);
            const models = await getModels(force);
            const nextDeck = settings.ankiDeck || decks[0] || '';
            const nextModel = settings.ankiModel || models[0] || '';
            const fields = nextModel ? await getModelFields(nextModel, force) : [];
            setAnkiDecks(decks);
            setAnkiModels(models);
            setAnkiFields(fields);

            const patch: Record<string, any> = {};
            if (!settings.ankiDeck && nextDeck) patch.ankiDeck = nextDeck;
            if (!settings.ankiModel && nextModel) patch.ankiModel = nextModel;
            if (fields.length > 0) {
                if (!settings.ankiFieldWord) patch.ankiFieldWord = findAnkiField(fields, 'Expression', 'Word', 'Front');
                if (!settings.ankiFieldReading) patch.ankiFieldReading = findAnkiField(fields, 'ExpressionFurigana', 'Reading', 'Furigana');
                if (!settings.ankiFieldMeaning) patch.ankiFieldMeaning = findAnkiField(fields, 'MainDefinition', 'Definition', 'Meaning', 'Back');
                if (!settings.ankiFieldSentence) patch.ankiFieldSentence = findAnkiField(fields, 'Sentence', 'Example');
                if (!settings.ankiFieldSentenceFurigana) patch.ankiFieldSentenceFurigana = findAnkiField(fields, 'SentenceFurigana', 'SelectionFurigana');
                if (!settings.ankiFieldDict) patch.ankiFieldDict = findAnkiField(fields, 'Dictionary', 'Source');
                if (!settings.ankiFieldAudio) patch.ankiFieldAudio = findAnkiField(fields, 'ExpressionAudio', 'Audio');
                if (!settings.ankiFieldScreenshot) patch.ankiFieldScreenshot = findAnkiField(fields, 'DefinitionPicture', 'Picture', 'Screenshot', 'Image');
            }
            if (Object.keys(patch).length > 0) updateManySettings(patch);
            setAnkiStatusText(status?.available
                ? (isEn ? 'AnkiDroid connected.' : 'AnkiDroid подключен.')
                : (isEn ? 'AnkiDroid is not installed or not visible.' : 'AnkiDroid не установлен или не виден.'));
        } catch (error: any) {
            setAnkiStatusText(error?.message || String(error));
        } finally {
            setAnkiBusy(false);
        }
    };

    useEffect(() => {
        if (isMobileSettingsOpen) {
            loadMobileAnki(false);
        }
    }, [isMobileSettingsOpen]);

    useEffect(() => {
        if (!isMobileSettingsOpen || !settings.ankiModel) return;
        getModelFields(settings.ankiModel)
            .then(setAnkiFields)
            .catch(() => setAnkiFields([]));
    }, [isMobileSettingsOpen, settings.ankiModel]);

    const cleanSettingsForBackup = () => {
        const clean = JSON.parse(JSON.stringify(settings || {}));
        delete clean.gdriveRefreshToken;
        return clean;
    };

    const connectDrive = async () => {
        if (!GOOGLE_DRIVE_AVAILABLE) return;
        setDriveStatus(isEn ? 'Opening Google…' : 'Открываю Google…');
        try {
            // Start the on-device OAuth catch server; the browser's redirect to 127.0.0.1
            // hits this app and fires the "oauth_code" event, which we exchange automatically.
            const start = await invoke<{ port: number; redirect_uri: string; reused: boolean }>('start_oauth_server');
            const redirectUri = start.redirect_uri;
            const unlisten = await listen<string>('oauth_code', async (event) => {
                try { unlisten(); } catch {}
                setDriveBusy(true);
                setDriveStatus(isEn ? 'Connecting…' : 'Подключаю…');
                try {
                    const tokenData = await exchangeCodeForToken(String(event.payload || ''), redirectUri);
                    if (!tokenData.refresh_token) throw new Error(isEn ? 'Google did not return a refresh token.' : 'Google не выдал refresh token.');
                    updateSetting('gdriveRefreshToken', tokenData.refresh_token);
                    setDriveAuthInput('');
                    setDriveStatus(isEn ? 'Google Drive connected.' : 'Google Drive подключён.');
                } catch (err: any) {
                    setDriveStatus(err?.message || String(err));
                } finally {
                    setDriveBusy(false);
                }
            });
            const url = getAuthUrl(redirectUri);
            await openUrl(url);
            setDriveStatus(isEn ? 'Sign in in the browser, then return to the app.' : 'Войди в браузере и вернись в приложение.');
        } catch (error: any) {
            setDriveStatus(error?.message || String(error));
            setDriveBusy(false);
        }
    };

    const submitDriveCode = async () => {
        if (!GOOGLE_DRIVE_AVAILABLE) return;
        const code = driveAuthInput.trim();
        if (!code) return;
        setDriveBusy(true);
        setDriveStatus(isEn ? 'Connecting...' : 'Подключаю...');
        try {
            const tokenData = await exchangeCodeForToken(code, 'http://127.0.0.1:1337');
            if (!tokenData.refresh_token) throw new Error(isEn ? 'Google did not return refresh token.' : 'Google не выдал refresh token.');
            updateSetting('gdriveRefreshToken', tokenData.refresh_token);
            setDriveAuthInput('');
            setDriveStatus(isEn ? 'Google Drive connected.' : 'Google Drive подключен.');
        } catch (error: any) {
            setDriveStatus(error?.message || String(error));
        } finally {
            setDriveBusy(false);
        }
    };

    const uploadMobileBackup = async () => {
        if (!GOOGLE_DRIVE_AVAILABLE) return;
        if (!settings.gdriveRefreshToken) return;
        setDriveBusy(true);
        setDriveStatus(isEn ? 'Uploading backup...' : 'Загружаю бэкап...');
        try {
            const token = await getAccessToken(settings.gdriveRefreshToken);
            await uploadToDrive(token, {
                metadata: { date: new Date().toISOString(), source: 'setsuna-mobile' },
                settings: cleanSettingsForBackup(),
                tabs: (tabs || []).map((tab: any) => {
                    const clean = JSON.parse(JSON.stringify(tab));
                    delete clean.captureSource;
                    return clean;
                }),
            });
            setDriveStatus(isEn ? 'Backup uploaded.' : 'Бэкап загружен.');
        } catch (error: any) {
            setDriveStatus(error?.message || String(error));
        } finally {
            setDriveBusy(false);
        }
    };

    const restoreLatestMobileBackup = async () => {
        if (!GOOGLE_DRIVE_AVAILABLE) return;
        if (!settings.gdriveRefreshToken) return;
        setDriveBusy(true);
        setDriveStatus(isEn ? 'Restoring latest backup...' : 'Восстанавливаю последний бэкап...');
        try {
            const token = await getAccessToken(settings.gdriveRefreshToken);
            const backups = await listBackups(token);
            if (!backups.length) throw new Error(isEn ? 'No backups in Google Drive.' : 'В Google Drive нет бэкапов.');
            const data = await downloadFromDrive(token, backups[0].id);
            if (data.settings && updateSettings) {
                updateSettings({ ...data.settings, gdriveRefreshToken: settings.gdriveRefreshToken });
            }
            if (Array.isArray(data.tabs) && setTabs) {
                setTabs(data.tabs);
                if (data.tabs.length > 0) {
                    switchTab(data.tabs[0].id);
                }
            }
            setDriveStatus(isEn ? 'Latest backup restored.' : 'Последний бэкап восстановлен.');
        } catch (error: any) {
            setDriveStatus(error?.message || String(error));
        } finally {
            setDriveBusy(false);
        }
    };

    const uploadMobileDictionary = async () => {
        if (!GOOGLE_DRIVE_AVAILABLE) return;
        if (!settings.gdriveRefreshToken) return;
        setDriveBusy(true);
        setDriveStatus(isEn ? 'Uploading dictionary.db...' : 'Загружаю dictionary.db...');
        try {
            const token = await getAccessToken(settings.gdriveRefreshToken);
            const info = await getDictDriveInfo(token);
            const fileId = info?.id || await createDictFileMetadata(token);
            await invoke('upload_db_to_drive', {
                url: `https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=media`,
                token,
            });
            setDriveStatus(isEn ? 'Dictionary uploaded.' : 'Словарь загружен.');
        } catch (error: any) {
            setDriveStatus(error?.message || String(error));
        } finally {
            setDriveBusy(false);
        }
    };

    const restoreMobileDictionary = async () => {
        if (!GOOGLE_DRIVE_AVAILABLE) return;
        if (!settings.gdriveRefreshToken) return;
        setDriveBusy(true);
        setDriveStatus(isEn ? 'Downloading dictionary.db...' : 'Скачиваю dictionary.db...');
        try {
            const token = await getAccessToken(settings.gdriveRefreshToken);
            const info = await getDictDriveInfo(token);
            if (!info?.id) throw new Error(isEn ? 'No dictionary.db in Google Drive.' : 'В Google Drive нет dictionary.db.');
            await invoke('download_db_from_drive', {
                url: `https://www.googleapis.com/drive/v3/files/${info.id}?alt=media`,
                token,
            });
            await syncDictionaries?.();
            setDriveStatus(isEn ? 'Dictionary restored.' : 'Словарь восстановлен.');
        } catch (error: any) {
            setDriveStatus(error?.message || String(error));
        } finally {
            setDriveBusy(false);
        }
    };

    return (
        <div className="mobile-shell" onClick={(e) => e.stopPropagation()}>
            <header className="mobile-header">
                <div className="mobile-topleft" onClick={() => (mobileWs || wsIntentOn) && setIsMobileSettingsOpen(true)}>
                    <span
                        className={`mobile-conn-dot ${wsConnected ? 'on' : wsIsConnecting || wsIntentOn ? 'pending' : 'off'}`}
                        title={wsStatusLabel}
                    />
                    <span className="mobile-tabname">{activeTab?.name || t('tabs.defaultName')}</span>
                </div>
                <div className="mobile-topright">
                    <button
                        type="button"
                        className="mobile-statpill"
                        onClick={() => setIsStatsOpen(true)}
                        aria-label={isEn ? 'Statistics' : 'Статистика'}
                    >
                        {(stats.chars || 0).toLocaleString(isEn ? 'en-US' : 'ru-RU')} <span>字</span>
                    </button>
                    <button className="mobile-gear" onClick={() => setIsMobileSettingsOpen(true)} aria-label={isEn ? 'Settings' : 'Настройки'}>
                        <IconSettings />
                    </button>
                </div>
            </header>

            <main className="mobile-main">
                {activeMobileView === 'lookup' ? (
                    <div className="mobile-lookup-page">
                        <div className="mobile-section-title">{isEn ? 'Lookup' : 'Лукап'}</div>
                        <textarea
                            value={lookupText}
                            onChange={(e) => setLookupText(e.target.value)}
                            className="mobile-lookup-input"
                            placeholder={isEn ? 'Paste a sentence or type a word...' : 'Вставь предложение или введи слово...'}
                            rows={4}
                        />
                        <div className="mobile-lookup-actions">
                            <button type="button" className="mobile-action primary" onClick={() => lookupText.trim() && onLookupText(lookupText.trim())}>
                                <IconSearch /> {isEn ? 'Lookup whole text' : 'Искать весь текст'}
                            </button>
                            <button type="button" className="mobile-action" onClick={submitDraft}>
                                {isEn ? 'Send to text' : 'В текст'}
                            </button>
                            <button type="button" className="mobile-action" onClick={() => setLookupText('')}>
                                {isEn ? 'Clear' : 'Очистить'}
                            </button>
                        </div>
                        <div className="mobile-token-panel">
                            {lookupText.trim() ? tokenizeLookupText(lookupText).map((part, index) =>
                                part.lookup ? (
                                    <button key={`${part.text}-${part.cursor}-${index}`} type="button" className="lookup-token mobile-token" onClick={() => lookupTypedToken(part.text, part.cursor)}>
                                        {part.text}
                                    </button>
                                ) : (
                                    <span key={`${part.text}-${index}`} className="mobile-token-plain">{part.text}</span>
                                )
                            ) : (
                                <div className="mobile-placeholder compact">{isEn ? 'Japanese words will become tappable here.' : 'Японские слова тут станут кликабельными.'}</div>
                            )}
                        </div>
                    </div>
                ) : activeTab?.mode === 'player' ? (
                    <div className="mobile-placeholder">
                        <div className="mobile-placeholder-title">{isEn ? 'Player' : 'Плеер'}</div>
                        <div>{isEn ? 'The mobile player will come after text, lookup, and Anki are stable.' : 'Мобильный плеер добавим после текста, lookup и Anki.'}</div>
                    </div>
                ) : activeTab?.mode === 'epub' ? (
                    <div className="mobile-placeholder">
                        <div className="mobile-placeholder-title">EPUB</div>
                        <div>{isEn ? 'The reader will use the same dictionary and mining flow.' : 'Ридер будет использовать тот же словарь и майнинг.'}</div>
                    </div>
                ) : activeTab?.lines?.length ? (
                    <TextContainer
                        lines={activeTab.lines || EMPTY_LINES}
                        lineFurigana={activeTab.lineFurigana || []}
                        onDelete={deleteLine}
                        onEdit={editLine}
                        furiganaMode={settings?.furiganaMode || 'none'}
                        autoScrollOffset={settings?.autoScrollOffset ?? 80}
                        searchQuery={searchQuery}
                        activeSearchLineIdx={searchResults[currentSearchIdx]?.lineIdx ?? -1}
                        searchTrigger={searchTrigger}
                        panelPosition="bottom"
                        language={settings.appLanguage}
                        textOrientation="horizontal"
                        lookupActive={lookupOpen}
                        onLookupToken={(token: string, sentence: string, cursor: number) => onLookupSentenceToken?.(token, sentence, cursor)}
                    />
                ) : (
                    <div className="mobile-placeholder">
                        <div className="mobile-placeholder-title">{isEn ? 'Text' : 'Текст'}</div>
                        <div>{isEn ? 'Paste or share text to start reading.' : 'Вставь или отправь текст через Share, чтобы начать читать.'}</div>
                    </div>
                )}
            </main>

            <footer className="mobile-dock">
                <button type="button" className="mobile-dock-btn" onClick={() => setIsPaused(!isPaused)}>
                    {isPaused ? (isEn ? 'Resume' : 'Пуск') : (isEn ? 'Pause' : 'Пауза')}
                </button>
                <button
                    type="button"
                    className={`mobile-dock-btn primary ${activeMobileView === 'lookup' ? 'active' : ''}`}
                    onClick={() => setActiveMobileView(activeMobileView === 'lookup' ? 'text' : 'lookup')}
                >
                    <IconSearch /> <span>{activeMobileView === 'lookup' ? (isEn ? 'Reading' : 'Чтение') : (isEn ? 'Lookup' : 'Лукап')}</span>
                </button>
                <button type="button" className="mobile-dock-btn tabs" onClick={() => setTabsOpen(true)} aria-label={isEn ? 'Windows' : 'Окна'}>
                    <svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" strokeWidth="1.8"><rect x="4" y="6" width="16" height="14" rx="2.5" /><path d="M4 10h16" /></svg>
                    {visibleTabs.length > 1 && <span className="mobile-dock-badge">{visibleTabs.length}</span>}
                </button>
            </footer>

            {tabsOpen && (
                <div className="mobile-tabs-scrim" onClick={() => setTabsOpen(false)}>
                    <section className="mobile-tabs-sheet" onClick={(e) => e.stopPropagation()}>
                        <div className="mobile-shade-grabber" />
                        <div className="mobile-tabs-head">{isEn ? 'Windows' : 'Окна'}</div>
                        <div className="mobile-tabs-list">
                            {visibleTabs.map((tab: Tab) => (
                                <div key={tab.id} className={`mobile-tabs-row ${tab.id === activeTabId ? 'active' : ''}`}>
                                    <button type="button" className="mobile-tabs-name" onClick={() => { switchTab(tab.id); setTabsOpen(false); }}>
                                        <span className={`mobile-tabs-dot ${tab.id === activeTabId ? 'on' : ''}`} />
                                        <span className="mobile-tabs-title">{tab.name || t('tabs.defaultName')}</span>
                                        <span className="mobile-tabs-count">{(tab.stats?.chars || 0).toLocaleString(isEn ? 'en-US' : 'ru-RU')} 字</span>
                                    </button>
                                    {visibleTabs.length > 1 && (
                                        <button type="button" className="mobile-tabs-close" aria-label={isEn ? 'Close' : 'Закрыть'} onClick={() => closeTab(tab.id)}>×</button>
                                    )}
                                </div>
                            ))}
                        </div>
                        <button type="button" className="mobile-tabs-new" onClick={() => { addNewTab(); setTabsOpen(false); }}>
                            + {isEn ? 'New window' : 'Новое окно'}
                        </button>
                        <div className="mobile-tabs-actions">
                            <button type="button" className="mobile-action" onClick={() => { openImport(); setTabsOpen(false); }}><IconImport /> {isEn ? 'Import dictionary' : 'Импорт словаря'}</button>
                            <button type="button" className="mobile-action mobile-action-danger" onClick={() => { clearAll(); setTabsOpen(false); }}><IconClear /> {isEn ? 'Clear text' : 'Очистить'}</button>
                        </div>
                    </section>
                </div>
            )}

            {isStatsOpen && (
                <div className="mobile-stats-scrim" onClick={() => setIsStatsOpen(false)}>
                    <section className="mobile-stats-shade" onClick={(e) => e.stopPropagation()}>
                        <div className="mobile-stats-shade-head">
                            <span>{isEn ? 'Session' : 'Сессия'}</span>
                            <button className="mobile-icon-btn tiny" onClick={() => setIsStatsOpen(false)} aria-label={isEn ? 'Close' : 'Закрыть'}>×</button>
                        </div>
                        <StatsPanel
                            isPaused={isPaused}
                            onTogglePause={() => setIsPaused(!isPaused)}
                            stats={stats}
                            speedSamples={activeTab?.speedSamples || []}
                            position="bottom"
                            speedMetric={settings.speedMetric}
                            speedTimeframe={settings.speedTimeframe}
                            language={settings.appLanguage}
                            textOrientation="horizontal"
                        />
                        <div className="mobile-shade-grabber" />
                    </section>
                </div>
            )}

            {isMobileSettingsOpen && (
                <div className="mobile-settings-backdrop" onClick={() => setIsMobileSettingsOpen(false)}>
                    <div className="mobile-settings-sheet" onClick={(e) => e.stopPropagation()}>
                        <div className="mobile-settings-header">
                            <div>
                                <div className="mobile-kicker">Setsuna</div>
                                <div className="mobile-settings-title">{isEn ? 'Settings' : 'Настройки'}</div>
                            </div>
                            <button className="mobile-icon-btn" onClick={() => setIsMobileSettingsOpen(false)}>x</button>
                        </div>

                        <div className="mobile-settings-section">
                            <div className="mobile-section-title">{isEn ? 'Interface' : 'Интерфейс'}</div>
                            <label className="mobile-setting-row">
                                <span>{isEn ? 'Language' : 'Язык'}</span>
                                <select value={settings.appLanguage || 'ru'} onChange={(e) => updateSetting('appLanguage', e.target.value)}>
                                    <option value="ru">Русский</option>
                                    <option value="en">English</option>
                                </select>
                            </label>
                            <label className="mobile-setting-row">
                                <span>{isEn ? 'Font size' : 'Размер текста'}</span>
                                <input
                                    type="range"
                                    min="18"
                                    max="36"
                                    value={settings.fontSize || 26}
                                    onChange={(e) => updateSetting('fontSize', Number(e.target.value))}
                                />
                            </label>
                            <label className="mobile-setting-row">
                                <span>{isEn ? 'Clean hooked text' : 'Чистить текст'}</span>
                                <input
                                    type="checkbox"
                                    checked={settings.enableTextCleaner !== false}
                                    onChange={(e) => updateSetting('enableTextCleaner', e.target.checked)}
                                />
                            </label>
                        </div>

                        <div className="mobile-settings-section">
                            <div className="mobile-section-title">{isEn ? 'Text source (WebSocket)' : 'Источник текста (WebSocket)'}</div>
                            <div className="mobile-settings-note">
                                {isEn
                                    ? 'Connect to a texthooker on another device (Textractor / LunaTranslator WebSocket server) over the same Wi-Fi. Enter its address, e.g. ws://192.168.1.50:6677.'
                                    : 'Подключись к текстхукеру на другом устройстве (WebSocket-сервер Textractor / LunaTranslator) по одной сети Wi-Fi. Введи адрес, например ws://192.168.1.50:6677.'}
                            </div>
                            <label className="mobile-setting-row">
                                <span>{isEn ? 'Address' : 'Адрес'}</span>
                                <input
                                    type="text"
                                    inputMode="url"
                                    autoCapitalize="none"
                                    autoCorrect="off"
                                    spellCheck={false}
                                    placeholder="ws://192.168.1.50:6677"
                                    value={wsDraftUrl}
                                    onChange={(e) => setWsDraftUrl(e.target.value)}
                                    onBlur={() => { if (wsDraftUrl.trim()) persistMobileWsUrl(wsDraftUrl, mobileWs?.active ?? true); }}
                                />
                            </label>
                            <div className="mobile-settings-actions two">
                                <button
                                    type="button"
                                    className="mobile-action primary"
                                    disabled={!wsDraftUrl.trim() || wsIsConnecting}
                                    onClick={connectMobileWs}
                                >
                                    {wsIsConnecting ? (isEn ? 'Connecting...' : 'Подключаюсь...') : (isEn ? 'Connect' : 'Подключить')}
                                </button>
                                <button
                                    type="button"
                                    className="mobile-action"
                                    disabled={!wsIntentOn}
                                    onClick={disconnectMobileWs}
                                >
                                    {isEn ? 'Disconnect' : 'Отключить'}
                                </button>
                            </div>
                            <div className="mobile-drive-status">
                                <span className={`mobile-ws-dot ${wsConnected ? 'on' : wsIsConnecting || wsIntentOn ? 'pending' : 'off'}`} />
                                {wsStatusLabel}
                            </div>
                        </div>

                        <div className="mobile-settings-section">
                            <div className="mobile-section-title">Anki</div>
                            <div className="mobile-settings-note">
                                {isEn
                                    ? 'On Android Setsuna writes cards through AnkiDroid.'
                                    : 'На Android Setsuna добавляет карточки через AnkiDroid.'}
                            </div>
                            <div className="mobile-settings-actions two">
                                <button
                                    className="mobile-action"
                                    disabled={ankiBusy}
                                    onClick={async () => {
                                        await requestAnkiDroidPermission().catch((error) => setAnkiStatusText(error?.message || String(error)));
                                        clearAnkiMetaCache();
                                        await loadMobileAnki(true);
                                    }}
                                >
                                    {isEn ? 'Allow AnkiDroid' : 'Разрешить AnkiDroid'}
                                </button>
                                <button
                                    className="mobile-action"
                                    disabled={ankiBusy}
                                    onClick={async () => {
                                        clearAnkiMetaCache();
                                        await loadMobileAnki(true);
                                    }}
                                >
                                    {isEn ? 'Refresh' : 'Обновить'}
                                </button>
                            </div>
                            <label className="mobile-setting-row">
                                <span>{isEn ? 'Deck' : 'Колода'}</span>
                                <select value={settings.ankiDeck || ''} onChange={(e) => updateSetting('ankiDeck', e.target.value)}>
                                    <option value="">{isEn ? 'Not selected' : 'Не выбрано'}</option>
                                    {ankiDecks.map((deck) => <option key={deck} value={deck}>{deck}</option>)}
                                </select>
                            </label>
                            <label className="mobile-setting-row">
                                <span>{isEn ? 'Model' : 'Модель'}</span>
                                <select value={settings.ankiModel || ''} onChange={(e) => updateSetting('ankiModel', e.target.value)}>
                                    <option value="">{isEn ? 'Not selected' : 'Не выбрано'}</option>
                                    {ankiModels.map((model) => <option key={model} value={model}>{model}</option>)}
                                </select>
                            </label>
                            <label className="mobile-setting-row">
                                <span>{isEn ? 'Word field' : 'Поле слова'}</span>
                                <select value={settings.ankiFieldWord || 'none'} onChange={(e) => updateSetting('ankiFieldWord', e.target.value)}>
                                    <option value="none">{t("common.none")}</option>
                                    {ankiFields.map((field) => <option key={field} value={field}>{field}</option>)}
                                </select>
                            </label>
                            <label className="mobile-setting-row">
                                <span>{isEn ? 'Meaning field' : 'Поле значения'}</span>
                                <select value={settings.ankiFieldMeaning || 'none'} onChange={(e) => updateSetting('ankiFieldMeaning', e.target.value)}>
                                    <option value="none">{t("common.none")}</option>
                                    {ankiFields.map((field) => <option key={field} value={field}>{field}</option>)}
                                </select>
                            </label>
                            <label className="mobile-setting-row">
                                <span>{isEn ? 'Sentence field' : 'Поле примера'}</span>
                                <select value={settings.ankiFieldSentence || 'none'} onChange={(e) => updateSetting('ankiFieldSentence', e.target.value)}>
                                    <option value="none">{t("common.none")}</option>
                                    {ankiFields.map((field) => <option key={field} value={field}>{field}</option>)}
                                </select>
                            </label>
                            <label className="mobile-setting-row">
                                <span>{isEn ? 'Screenshot field' : 'Поле скрина'}</span>
                                <select value={settings.ankiFieldScreenshot || 'none'} onChange={(e) => updateSetting('ankiFieldScreenshot', e.target.value)}>
                                    <option value="none">{t("common.none")}</option>
                                    {ankiFields.map((field) => <option key={field} value={field}>{field}</option>)}
                                </select>
                            </label>
                            {ankiStatusText && <div className="mobile-drive-status">{ankiStatusText}</div>}
                        </div>

                        <div className="mobile-settings-section">
                            <div className="mobile-section-title">Google Drive</div>
                            {!GOOGLE_DRIVE_AVAILABLE ? (
                                <>
                                    <div className="mobile-settings-note">
                                        {isEn
                                            ? 'Backup and synchronization are temporarily unavailable.'
                                            : 'Резервные копии и синхронизация временно недоступны.'}
                                    </div>
                                    <button className="mobile-action" type="button" disabled>
                                        {isEn ? 'Google Drive - coming soon' : 'Google Drive - скоро'}
                                    </button>
                                </>
                            ) : settings.gdriveRefreshToken ? (
                                <>
                                    <div className="mobile-settings-note">
                                        {isEn ? 'Connected. Backups use the same hidden app folder as desktop Setsuna.' : 'Подключено. Бэкапы лежат в той же скрытой папке приложения, что и на ПК.'}
                                    </div>
                                    <div className="mobile-settings-actions two">
                                        <button className="mobile-action" disabled={driveBusy} onClick={uploadMobileBackup}>
                                            {isEn ? 'Upload backup' : 'Загрузить бэкап'}
                                        </button>
                                        <button className="mobile-action" disabled={driveBusy} onClick={restoreLatestMobileBackup}>
                                            {isEn ? 'Restore latest' : 'Восстановить последний'}
                                        </button>
                                        <button className="mobile-action" disabled={driveBusy} onClick={uploadMobileDictionary}>
                                            {isEn ? 'Upload dictionary' : 'Загрузить словарь'}
                                        </button>
                                        <button className="mobile-action" disabled={driveBusy} onClick={restoreMobileDictionary}>
                                            {isEn ? 'Download dictionary' : 'Скачать словарь'}
                                        </button>
                                    </div>
                                    <button className="mobile-action danger" disabled={driveBusy} onClick={() => updateSetting('gdriveRefreshToken', '')}>
                                        {isEn ? 'Disconnect Drive' : 'Отключить Drive'}
                                    </button>
                                </>
                            ) : (
                                <>
                                    <div className="mobile-settings-note">
                                        {isEn
                                            ? '1. Tap “Open Google sign-in” and log in. 2. The browser will show a “can’t reach this page” error — that is expected. 3. Copy the full address from the address bar. 4. Come back and tap “Paste & connect”.'
                                            : '1. Нажми «Открыть вход Google» и войди. 2. Браузер покажет ошибку «страница недоступна» — это нормально. 3. Скопируй весь адрес из адресной строки. 4. Вернись и нажми «Вставить и подключить».'}
                                    </div>
                                    <button className="mobile-action primary" disabled={driveBusy} onClick={connectDrive}>
                                        {isEn ? '1 · Open Google sign-in' : '1 · Открыть вход Google'}
                                    </button>
                                    <button className="mobile-action" disabled={driveBusy} onClick={pasteAndConnectDrive}>
                                        {isEn ? '2 · Paste & connect' : '2 · Вставить и подключить'}
                                    </button>
                                    <textarea
                                        className="mobile-drive-code-input"
                                        value={driveAuthInput}
                                        onChange={(e) => setDriveAuthInput(e.target.value)}
                                        placeholder={isEn ? '…or paste the address here manually' : '…или вставь адрес сюда вручную'}
                                        rows={2}
                                    />
                                    <button className="mobile-action" disabled={driveBusy || !driveAuthInput.trim()} onClick={submitDriveCode}>
                                        {isEn ? 'Connect Drive' : 'Подключить Drive'}
                                    </button>
                                </>
                            )}
                            {driveStatus && <div className="mobile-drive-status">{driveStatus}</div>}
                        </div>

                        <div className="mobile-settings-section">
                            <div className="mobile-section-title">{isEn ? 'Data' : 'Данные'}</div>
                            <div className="mobile-settings-actions">
                                <button className="mobile-action" onClick={openImport}><IconImport /> {isEn ? 'Import dictionary' : 'Импорт словаря'}</button>
                                <button className="mobile-action danger" onClick={clearAll}><IconClear /> {isEn ? 'Clear current text' : 'Очистить текст'}</button>
                            </div>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
};

export const TopBar = ({
    tabs,
    activeTabId,
    switchTab,
    editingTabId,
    setEditingTabId,
    setTabs,
    closeTab,
    archiveTab,
    openArchiveSettings,
    cycleTabStatus,
    addNewTab,
    settings,
    wsStatuses,
    wsIntents,
    toggleWs,
    textSyncServerEnabled,
    textSyncRemoteEnabled,
    textSyncCloudEnabled,
    toggleTextSyncRemote,
    openTextSyncSettings,
    useClipboard,
    toggleClipboard,
    openSearch,
    openImport,
    openExport,
    toggleBrowser,
    isBrowserOpen,
    activeTab,
    openCaptureSourcePicker,
    openJlModeWindow,
    clearAll,
    openHome,
    openSettings,
}: any) => {
    const t = getTranslator(settings?.appLanguage || 'ru');
    const [draggedTabId, setDraggedTabId] = useState<number | null>(null);
    const [dragOverTabId, setDragOverTabId] = useState<number | null>(null);
    const [tabMenu, setTabMenu] = useState<{ x: number; y: number; tabId: number } | null>(null);
    const [tabDecks, setTabDecks] = useState<string[]>([]);
    const tabStripRef = useRef<HTMLDivElement>(null);
    const [isTopbarCollapsed, setIsTopbarCollapsed] = useState(true);
    const topbarRef = useRef<HTMLDivElement>(null);
    const pointerDragRef = useRef<{ id: number; startX: number; dragging: boolean; lastOverId: number | null } | null>(null);
    const suppressTabClickRef = useRef(false);
    const visibleTabs = tabs.filter((tab: Tab) => !tab.archived);
    const [tabWindowStart, setTabWindowStart] = useState(() => {
        const maxStart = Math.max(0, visibleTabs.length - 1);
        try {
            const raw = localStorage.getItem(TAB_WINDOW_START_STORAGE_KEY);
            if (raw !== null) {
                const saved = Number.parseInt(raw, 10);
                if (Number.isFinite(saved)) return Math.max(0, Math.min(saved, maxStart));
            }
        } catch {}
        const activeIndex = visibleTabs.findIndex((tab: Tab) => tab.id === activeTabId);
        return Math.max(0, activeIndex);
    });
    const [visibleTabSlots, setVisibleTabSlots] = useState(1);
    const [tabItemWidth, setTabItemWidth] = useState(180);
    const visibleWindowTabs = visibleTabs.slice(tabWindowStart, tabWindowStart + visibleTabSlots);
    const hasHiddenTabs = visibleTabs.length > visibleTabSlots;
    const primaryWebSocketId = settings?.primaryWebSocketId || settings?.websockets?.[0]?.id;
    const statusMeta = (status?: Tab["status"]) => {
        const isEn = settings?.appLanguage === 'en';
        if (status === 'reading') return { label: isEn ? 'Reading' : 'Читаю', color: '#4CAF50', icon: '▶' };
        if (status === 'paused') return { label: isEn ? 'Paused' : 'На паузе', color: '#d6a84f', icon: 'Ⅱ' };
        if (status === 'completed') return { label: isEn ? 'Completed' : 'Прочитано', color: '#8bdeff', icon: '✓' };
        return { label: isEn ? 'Planned' : 'В планах', color: '#8b8f98', icon: '○' };
    };
    const tabTypeIcon = (tab: Tab) => {
        if (tab.mode === 'epub') return { icon: <IconBookTab />, title: 'EPUB', color: '#d6a84f' };
        if (tab.mode === 'player') return { icon: <IconPlayerTab />, title: settings?.appLanguage === 'en' ? 'Player' : 'Плеер', color: '#ff6b6b' };
        return { icon: <IconTextTab />, title: 'TextHooker', color: 'var(--accent-blue)' };
    };
    const moveTab = (fromId: number, toId: number) => {
        if (fromId === toId) return;
        setTabs((prev: Tab[]) => {
            const fromIndex = prev.findIndex((tab) => tab.id === fromId);
            const toIndex = prev.findIndex((tab) => tab.id === toId);
            if (fromIndex < 0 || toIndex < 0) return prev;
            const next = [...prev];
            const [moved] = next.splice(fromIndex, 1);
            next.splice(toIndex, 0, moved);
            return next;
        });
    };
    const startPointerTabDrag = (e: PointerEvent, id: number) => {
        if (editingTabId === id) return;
        const target = e.target as HTMLElement;
        if (target.closest('button') || target.closest('input') || target.closest('.tab-close')) return;
        pointerDragRef.current = { id, startX: e.clientX, dragging: false, lastOverId: null };
        (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    };
    const movePointerTabDrag = (e: PointerEvent) => {
        const drag = pointerDragRef.current;
        if (!drag) return;
        if (!drag.dragging && Math.abs(e.clientX - drag.startX) > 8) {
            drag.dragging = true;
            suppressTabClickRef.current = true;
            setDraggedTabId(drag.id);
        }
        if (!drag.dragging) return;
        const target = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null;
        const tabEl = target?.closest('[data-tab-id]') as HTMLElement | null;
        const overId = Number(tabEl?.dataset.tabId || 0);
        if (overId && overId !== drag.id && overId !== drag.lastOverId) {
            drag.lastOverId = overId;
            moveTab(drag.id, overId);
            setDragOverTabId(overId);
        }
    };
    const endPointerTabDrag = (e: PointerEvent) => {
        const drag = pointerDragRef.current;
        pointerDragRef.current = null;
        setDraggedTabId(null);
        setDragOverTabId(null);
        try { (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId); } catch {}
        if (drag?.dragging) {
            window.setTimeout(() => { suppressTabClickRef.current = false; }, 0);
        }
    };
    const shiftTabWindow = (direction: -1 | 1) => {
        setTabWindowStart((start) => {
            const maxStart = Math.max(0, visibleTabs.length - visibleTabSlots);
            return Math.max(0, Math.min(maxStart, start + direction));
        });
    };
    const getTabById = (id: number) => tabs.find((tab: Tab) => tab.id === id);
    const setTabStatus = (id: number, status: NonNullable<Tab["status"]>) => {
        setTabs((prev: Tab[]) => prev.map((tab) => tab.id === id ? { ...tab, status } : tab));
        setTabMenu(null);
    };
    const setTabDeck = (id: number, deck: string) => {
        setTabs((prev: Tab[]) => prev.map((tab) => tab.id === id ? { ...tab, ankiDeck: deck || null } : tab));
    };
    const renameTab = (id: number) => {
        setEditingTabId(id);
        switchTab(id);
        setTabMenu(null);
    };
    const duplicateTab = (id: number) => {
        const source = getTabById(id);
        if (!source) return;
        const copy: Tab = {
            ...source,
            id: Date.now(),
            name: `${source.name} copy`,
            stats: { ...source.stats },
            lines: [...source.lines],
            speedSamples: source.speedSamples ? [...source.speedSamples] : undefined,
            archived: false,
        };
        setTabs((prev: Tab[]) => {
            const index = prev.findIndex((tab) => tab.id === id);
            const next = [...prev];
            next.splice(index + 1, 0, copy);
            return next;
        });
        switchTab(copy.id);
        setTabMenu(null);
    };
    const archiveTabFromMenu = (id: number) => {
        const visible = tabs.filter((tab: Tab) => !tab.archived);
        if (visible.length <= 1) return;
        setTabs((prev: Tab[]) => prev.map((tab) => tab.id === id ? { ...tab, archived: true } : tab));
        if (activeTabId === id) {
            const next = visible.find((tab: Tab) => tab.id !== id);
            if (next) switchTab(next.id);
        }
        setTabMenu(null);
    };
    const deleteTabFromMenu = (id: number) => {
        if (visibleTabs.length <= 1) return;
        const next = tabs.filter((tab: Tab) => tab.id !== id);
        setTabs(next);
        if (activeTabId === id) {
            const nextVisible = next.find((tab: Tab) => !tab.archived);
            if (nextVisible) switchTab(nextVisible.id);
        }
        setTabMenu(null);
    };
    useEffect(() => {
        if (!tabMenu) return;
        if (settings?.ankiDeckMode === 'contextual') {
            getDecks().then(setTabDecks).catch(() => setTabDecks(settings?.ankiDeck ? [settings.ankiDeck] : []));
        }
        const close = () => setTabMenu(null);
        window.addEventListener('click', close);
        window.addEventListener('keydown', close);
        window.addEventListener('resize', close);
        return () => {
            window.removeEventListener('click', close);
            window.removeEventListener('keydown', close);
            window.removeEventListener('resize', close);
        };
    }, [tabMenu]);
    useEffect(() => {
        const el = tabStripRef.current;
        if (!el) return;
        const updateSlots = () => {
            const addButtonWidth = 36;
            const arrowWidth = 64;
            const maxTabWidth = 210;
            const minTabWidth = 148;
            const width = Math.max(0, el.clientWidth);
            const tabAreaWithoutArrows = Math.max(0, width - addButtonWidth);
            const allFitAtMax = visibleTabs.length * maxTabWidth <= tabAreaWithoutArrows;
            const allFitAtMin = visibleTabs.length * minTabWidth <= tabAreaWithoutArrows;
            const tabAreaWithArrows = Math.max(0, width - addButtonWidth - arrowWidth);
            const slots = allFitAtMax || allFitAtMin
                ? Math.max(1, visibleTabs.length)
                : Math.max(1, Math.floor(tabAreaWithArrows / minTabWidth));
            const availableForTabs = (slots >= visibleTabs.length) ? tabAreaWithoutArrows : tabAreaWithArrows;
            const nextWidth = Math.max(minTabWidth, Math.min(maxTabWidth, Math.floor(availableForTabs / Math.max(1, slots))));
            setVisibleTabSlots((prev) => (prev === slots ? prev : slots));
            setTabItemWidth((prev) => (prev === nextWidth ? prev : nextWidth));
        };
        updateSlots();
        const observer = new ResizeObserver(updateSlots);
        observer.observe(el);
        return () => observer.disconnect();
    }, [visibleTabs.length]);

    useEffect(() => {
        const el = topbarRef.current;
        if (!el) return;
        const updateCompactMode = () => {
            // A very narrow window always falls back to the compact state.
            if (el.clientWidth < 900) setIsTopbarCollapsed(true);
        };
        updateCompactMode();
        const observer = new ResizeObserver(updateCompactMode);
        observer.observe(el);
        return () => observer.disconnect();
    }, []);
    useEffect(() => {
        setTabWindowStart((start) => Math.max(0, Math.min(start, Math.max(0, visibleTabs.length - visibleTabSlots))));
    }, [visibleTabs.length, visibleTabSlots]);
    useEffect(() => {
        try {
            localStorage.setItem(TAB_WINDOW_START_STORAGE_KEY, String(tabWindowStart));
        } catch {}
    }, [tabWindowStart]);

    return (
        <div
            ref={topbarRef}
            className={`top-bar${isTopbarCollapsed ? ' is-compact' : ''}`}
            style={{
                backgroundColor: 'var(--bg-topbar)',
                borderBottom: '1px solid var(--border-subtle)',
                minHeight: '40px',
                gap: '8px',
                overflow: 'hidden',
            }}
        >
            <style>{`
                @keyframes fast-blink {
                    0%, 100% { opacity: 1; }
                    50% { opacity: 0.3; }
                }
            `}</style>

            <button
                type="button"
                className="header-btn topbar-optional"
                onClick={openHome}
                title={settings?.appLanguage === 'en' ? 'Back to Hub' : 'Выйти в Hub'}
                aria-label={settings?.appLanguage === 'en' ? 'Open home' : 'Открыть главное меню'}
                style={{ width: 76, height: 33, flex: '0 0 76px', padding: '0 8px', alignSelf: 'flex-end', justifyContent: 'center', gap: 6, fontSize: 12 }}
            >
                <IconHome />
                <span>{settings?.appLanguage === 'en' ? 'Hub' : 'В Hub'}</span>
            </button>

            <div ref={tabStripRef} style={{ minWidth: 0, flex: '1 1 auto', overflow: 'hidden', display: 'flex', alignItems: 'flex-end' }}>
            <div className="tabs" style={{ minWidth: 0, width: '100%', flex: '1 1 auto', overflow: 'hidden', alignItems: 'flex-end' }}>
                {hasHiddenTabs && (
                    <button
                        className="tab"
                        onClick={() => shiftTabWindow(-1)}
                        disabled={tabWindowStart <= 0}
                        style={{ height: '33px', flex: '0 0 auto', width: 28, justifyContent: 'center', padding: 0, borderBottom: 'none', opacity: tabWindowStart <= 0 ? 0.35 : 1 }}
                        title={settings?.appLanguage === 'en' ? 'Previous tab' : 'Предыдущая вкладка'}
                    >
                        ‹
                    </button>
                )}
                {visibleWindowTabs.map((tab: Tab) => {
                    const type = tabTypeIcon(tab);
                    const status = statusMeta(tab.status);
                    return (
                        <div
                            key={tab.id}
                            data-tab-id={tab.id}
                            className={`tab ${activeTabId === tab.id ? 'active' : ''}`}
                            draggable={false}
                            onPointerDown={(e) => startPointerTabDrag(e, tab.id)}
                            onPointerMove={movePointerTabDrag}
                            onPointerUp={endPointerTabDrag}
                            onPointerCancel={endPointerTabDrag}
                            onClick={() => {
                                if (suppressTabClickRef.current) {
                                    suppressTabClickRef.current = false;
                                    return;
                                }
                                switchTab(tab.id);
                            }}
                            onContextMenu={(e) => {
                                e.preventDefault();
                                e.stopPropagation();
                                setTabMenu({ x: e.clientX, y: e.clientY, tabId: tab.id });
                            }}
                            title={tab.name || (settings?.appLanguage === 'en' ? 'Unnamed tab' : 'Без названия')}
                            style={{
                                opacity: draggedTabId === tab.id ? 0.55 : 1,
                                outline: dragOverTabId === tab.id ? '1px solid var(--accent-blue)' : undefined,
                                outlineOffset: dragOverTabId === tab.id ? '-2px' : undefined,
                                height: '33px',
                                width: `${tabItemWidth}px`,
                                flex: `0 0 ${tabItemWidth}px`,
                                whiteSpace: 'nowrap',
                                overflow: 'hidden',
                                cursor: editingTabId === tab.id ? 'text' : 'grab',
                                transition: 'transform 160ms ease, opacity 160ms ease, background-color 120ms ease, border-color 120ms ease',
                                transform: dragOverTabId === tab.id ? 'translateY(-2px)' : 'translateY(0)',
                            }}
                        >
                                    <button
                                        onClick={(e) => cycleTabStatus?.(e, tab.id)}
                                        title={status.label}
                                        style={{
                                            width: '18px',
                                            height: '18px',
                                            borderRadius: '5px',
                                            background: 'var(--bg-side)',
                                            border: `1px solid ${status.color}`,
                                            color: status.color,
                                            padding: 0,
                                            flexShrink: 0,
                                            cursor: 'pointer',
                                            display: 'inline-flex',
                                            alignItems: 'center',
                                            justifyContent: 'center',
                                            fontSize: '11px',
                                            fontWeight: 800,
                                            lineHeight: 1,
                                        }}
                                    >
                                        {status.icon}
                                    </button>
                                    <span title={type.title} style={{ width: '18px', height: '18px', borderRadius: '5px', background: 'var(--bg-side)', border: `1px solid ${type.color}`, color: type.color, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                                        {type.icon}
                                    </span>
                                    {editingTabId === tab.id ? (
                                        <input
                                            autoFocus
                                            defaultValue={tab.name}
                                            onBlur={(e) => {
                                                const newName = e.target.value.trim() || tab.name;
                                                setTabs((prev: Tab[]) =>
                                                    prev.map((t) =>
                                                        t.id === tab.id ? { ...t, name: newName } : t
                                                    )
                                                );
                                                setEditingTabId(null);
                                            }}
                                            onKeyDown={(e) => {
                                                if (e.key === 'Enter') e.currentTarget.blur();
                                                else if (e.code === 'Escape') setEditingTabId(null);
                                            }}
                                            onClick={(e) => e.stopPropagation()}
                                            style={{
                                                width: '80px',
                                                background: 'transparent',
                                                color: 'var(--text-main)',
                                                border: 'none',
                                                borderBottom: '1px solid var(--accent-blue)',
                                                outline: 'none',
                                                fontSize: '14px',
                                            }}
                                        />
                                    ) : (
                                        <span onDoubleClick={() => setEditingTabId(tab.id)} title={tab.name} style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: '1 1 auto' }}>
                                            {tab.name}
                                        </span>
                                    )}

                                    {visibleTabs.length > 1 && (
                                        <span
                                            className="tab-close"
                                            title={settings?.appLanguage === 'en' ? 'Archive tab' : 'В архив'}
                                            onClick={(e) => archiveTab?.(e, tab.id)}
                                            style={{ color: 'var(--text-muted)' }}
                                        >
                                            ↓
                                        </span>
                                    )}

                                    {visibleTabs.length > 1 && (
                                        <span
                                            className="tab-close"
                                            onClick={(e) => closeTab(e, tab.id)}
                                        >
                                            x
                                        </span>
                                    )}
                        </div>
                    );
                })}

                <button
                    type="button"
                    className="tab tab-add"
                    onClick={addNewTab}
                    title={settings?.appLanguage === 'en' ? 'New tab' : 'Новая вкладка'}
                    aria-label={settings?.appLanguage === 'en' ? 'Create new tab' : 'Создать новую вкладку'}
                >
                    <span aria-hidden="true">+</span>
                </button>
                {hasHiddenTabs && (
                    <button
                        className="tab"
                        onClick={() => shiftTabWindow(1)}
                        disabled={tabWindowStart >= Math.max(0, visibleTabs.length - visibleTabSlots)}
                        style={{ height: '33px', flex: '0 0 auto', width: 28, justifyContent: 'center', padding: 0, borderBottom: 'none', opacity: tabWindowStart >= Math.max(0, visibleTabs.length - visibleTabSlots) ? 0.35 : 1 }}
                        title={settings?.appLanguage === 'en' ? 'Next tab' : 'Следующая вкладка'}
                    >
                        ›
                    </button>
                )}
            </div>
            </div>
            {tabMenu && (() => {
                const tab = getTabById(tabMenu.tabId);
                if (!tab) return null;
                const menuX = Math.min(tabMenu.x, window.innerWidth - 230);
                const menuY = Math.min(tabMenu.y, window.innerHeight - 320);
                const isEn = settings?.appLanguage === 'en';
                const menuButtonStyle = {
                    width: '100%',
                    textAlign: 'left' as const,
                    background: 'transparent',
                    border: 'none',
                    color: 'var(--text-main)',
                    padding: '8px 10px',
                    borderRadius: 5,
                    cursor: 'pointer',
                    fontSize: 13,
                };
                return (
                    <div
                        onClick={(e) => e.stopPropagation()}
                        style={{
                            position: 'fixed',
                            left: menuX,
                            top: menuY,
                            width: 220,
                            zIndex: 2000,
                            background: 'var(--bg-panel)',
                            border: '1px solid var(--border-main)',
                            borderRadius: 6,
                            boxShadow: '0 10px 28px rgba(0,0,0,0.42)',
                            padding: 6,
                        }}
                    >
                        <div style={{ color: 'var(--text-muted)', fontSize: 11, padding: '5px 8px 8px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {tab.name}
                        </div>
                        <button style={menuButtonStyle} onClick={() => renameTab(tab.id)}>{isEn ? 'Rename' : 'Переименовать'}</button>
                        <button style={menuButtonStyle} onClick={() => duplicateTab(tab.id)}>{isEn ? 'Duplicate' : 'Дублировать'}</button>
                        <button style={menuButtonStyle} onClick={() => { openArchiveSettings?.(); setTabMenu(null); }}>{isEn ? 'Open archive' : 'Открыть архив'}</button>
                        {settings?.ankiDeckMode === 'contextual' && (
                            <label style={{ display: 'block', padding: '5px 8px 8px' }}>
                                <span style={{ display: 'block', color: 'var(--text-muted)', fontSize: 11, marginBottom: 6 }}>
                                    {isEn ? 'Anki deck' : 'Колода Anki'}
                                </span>
                                <select
                                    value={tab.ankiDeck || ''}
                                    onChange={(event) => setTabDeck(tab.id, event.target.value)}
                                    onClick={(event) => event.stopPropagation()}
                                    style={{ width: '100%', height: 30, border: '1px solid var(--border-main)', borderRadius: 5, background: 'var(--bg-main)', color: 'var(--text-main)', padding: '0 7px' }}
                                >
                                    <option value="">{isEn ? `Main: ${settings.ankiDeck || '-'}` : `Основная: ${settings.ankiDeck || '-'}`}</option>
                                    {tabDecks.map((deck) => <option key={deck} value={deck}>{deck}</option>)}
                                </select>
                            </label>
                        )}
                        <div style={{ height: 1, background: 'var(--border-main)', margin: '5px 0' }} />
                        <div style={{ color: 'var(--text-muted)', fontSize: 11, padding: '5px 8px' }}>{isEn ? 'Status' : 'Статус'}</div>
                        {([
                            ['planned', statusMeta('planned')],
                            ['reading', statusMeta('reading')],
                            ['paused', statusMeta('paused')],
                            ['completed', statusMeta('completed')],
                        ] as const).map(([value, meta]) => (
                            <button key={value} style={{ ...menuButtonStyle, display: 'flex', alignItems: 'center', gap: 8 }} onClick={() => setTabStatus(tab.id, value)}>
                                <span style={{ width: 18, height: 18, borderRadius: 5, border: `1px solid ${meta.color}`, color: meta.color, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 800, flexShrink: 0 }}>{meta.icon}</span>
                                <span style={{ flex: 1 }}>{meta.label}</span>
                                {(tab.status || 'planned') === value && <span style={{ color: 'var(--accent-blue)' }}>✓</span>}
                            </button>
                        ))}
                        <div style={{ height: 1, background: 'var(--border-main)', margin: '5px 0' }} />
                        <button style={{ ...menuButtonStyle, opacity: visibleTabs.length <= 1 ? 0.45 : 1 }} disabled={visibleTabs.length <= 1} onClick={() => archiveTabFromMenu(tab.id)}>{isEn ? 'Archive tab' : 'В архив'}</button>
                        <button style={{ ...menuButtonStyle, color: '#ff5555', opacity: visibleTabs.length <= 1 ? 0.45 : 1 }} disabled={visibleTabs.length <= 1} onClick={() => deleteTabFromMenu(tab.id)}>{isEn ? 'Delete tab' : 'Удалить вкладку'}</button>
                    </div>
                );
            })()}

            <button
                type="button"
                className="header-btn topbar-collapse-toggle"
                onClick={() => setIsTopbarCollapsed((value) => !value)}
                title={isTopbarCollapsed
                    ? (settings?.appLanguage === 'en' ? 'Expand toolbar' : 'Развернуть панель')
                    : (settings?.appLanguage === 'en' ? 'Collapse toolbar' : 'Свернуть панель')}
                aria-label={isTopbarCollapsed ? 'Expand toolbar' : 'Collapse toolbar'}
                style={{ width: 28, height: 33, flex: '0 0 28px', padding: 0, justifyContent: 'center', fontSize: 18 }}
            >
                {isTopbarCollapsed ? '‹' : '›'}
            </button>

            <div className="header-actions" style={{ display: 'flex', alignItems: 'center', flex: '0 0 auto', minWidth: 0, overflow: 'visible' }}>
                {(settings.topbarShowClipboard ?? true) && <button
                    onClick={toggleClipboard}
                    className="header-btn topbar-optional"
                    style={{
                        color: useClipboard ? '#4CAF50' : '#ff4444',
                        display: 'flex',
                        alignItems: 'center',
                        gap: '6px',
                    }}
                >
                    <svg
                        width="14"
                        height="14"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2.5"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                    >
                        <rect x="9" y="2" width="6" height="4" rx="1" ry="1"></rect>
                        <path d="M19 6h-2M5 6h2M5 6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-2"></path>
                    </svg>
                    <span>{t('topbar.clipboard')}</span>
                </button>}

                {(settings.topbarShowWebSockets ?? true) && settings.websockets &&
                    [...settings.websockets]
                    .sort((a: any, b: any) => {
                        if (a.id === settings.primaryWebSocketId) return -1;
                        if (b.id === settings.primaryWebSocketId) return 1;
                        return 0;
                    })
                    .map((ws: any) => {
                        const isConnected = wsStatuses[ws.id];
                        const isBlinking = wsIntents && wsIntents[ws.id] && !isConnected;
                        const color = isConnected ? '#4CAF50' : '#ff4444';

                        return (
                            <button
                                key={ws.id}
                                onClick={() => toggleWs(ws.id)}
                                className={`header-btn${ws.id === primaryWebSocketId ? '' : ' topbar-secondary-ws'}`}
                                style={{
                                    color,
                                    display: 'flex',
                                    alignItems: 'center',
                                    gap: '6px',
                                }}
                            >
                                <div
                                    style={{
                                        animation: isBlinking ? 'fast-blink 0.8s infinite' : 'none',
                                        display: 'flex',
                                        alignItems: 'center',
                                    }}
                                >
                                    <IconWifi connected={isConnected} />
                                </div>
                                <span>{ws.id === settings.primaryWebSocketId ? `★ ${ws.name}` : ws.name}</span>
                            </button>
                        );
                    })}

                {(settings.topbarShowSync ?? true) && <button
                    onClick={toggleTextSyncRemote}
                    onContextMenu={(e) => {
                        e.preventDefault();
                        openTextSyncSettings?.();
                    }}
                    className="header-btn topbar-optional"
                    title={
                        settings?.appLanguage === 'en'
                            ? 'Setsuna Sync. Click to toggle receiving when configured, right-click for settings.'
                            : 'Setsuna Sync. Клик включает/выключает приём, ПКМ открывает настройки.'
                    }
                    style={{
                        color: textSyncCloudEnabled ? '#4CAF50' : (textSyncRemoteEnabled ? '#4CAF50' : (textSyncServerEnabled ? 'var(--accent-blue)' : '#ff4444')),
                        display: 'flex',
                        alignItems: 'center',
                        gap: '6px',
                    }}
                >
                    <IconWifi connected={Boolean(textSyncCloudEnabled || textSyncRemoteEnabled || textSyncServerEnabled)} />
                    <span>
                        {textSyncCloudEnabled
                            ? 'Cloud'
                            : textSyncRemoteEnabled
                            ? 'Sync'
                            : textSyncServerEnabled
                                ? (settings?.appLanguage === 'en' ? 'Host' : 'Отдаю')
                                : 'Sync'}
                    </span>
                </button>}

                {(settings.topbarShowCapture ?? true) && <button
                    onClick={openCaptureSourcePicker}
                    className="header-btn topbar-optional"
                    title={
                        activeTab?.captureSource?.name
                            ? t('capture.current', { source: activeTab.captureSource.name })
                            : t('capture.notBound')
                    }
                    style={{
                        color: activeTab?.captureSource?.name ? 'var(--accent-blue)' : 'var(--text-muted)',
                        display: 'flex',
                        alignItems: 'center',
                        gap: '6px',
                        maxWidth: '180px',
                    }}
                >
                    <IconPin />
                    <span
                        style={{
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                        }}
                    >
                        {activeTab?.captureSource?.name || t('topbar.captureSource')}
                    </span>
                </button>}

                <button
                    onClick={openJlModeWindow}
                    className="header-btn topbar-optional"
                    style={{ color: 'var(--accent-blue)', display: 'flex', alignItems: 'center', gap: '6px' }}
                    title={settings?.appLanguage === 'en' ? 'Open Setsuna Flow' : 'Открыть Setsuna Flow'}
                >
                    <IconPin /> <span>Flow</span>
                </button>

                {(settings.topbarShowSearch ?? true) && <button
                    onClick={openSearch}
                    className="header-btn topbar-optional"
                    style={{ display: 'flex', alignItems: 'center', gap: '6px' }}
                >
                    <IconSearch /> <span>{t('common.search')}</span>
                </button>}

                {(settings.topbarShowImport ?? true) && <button
                    onClick={openImport}
                    className="header-btn topbar-optional"
                    style={{ display: 'flex', alignItems: 'center', gap: '6px' }}
                >
                    <IconExport /> <span>{t('topbar.import')}</span>
                </button>}

                {(settings.topbarShowExport ?? true) && <button
                    onClick={openExport}
                    className="header-btn topbar-optional"
                    style={{ display: 'flex', alignItems: 'center', gap: '6px' }}
                >
                    <IconImport /> <span>{t('topbar.export')}</span>
                </button>}

                {(settings.topbarShowBrowser ?? true) && <button
                    onClick={toggleBrowser}
                    className="header-btn topbar-optional"
                    style={{ display: 'flex', alignItems: 'center', gap: '6px' }}
                >
                    <IconBrowser /> <span>{isBrowserOpen ? t('topbar.hideBrowser') : t('topbar.browser')}</span>
                </button>}

                <button
                    onClick={clearAll}
                    className="header-btn topbar-optional"
                    style={{
                        color: '#ff4444',
                        display: 'flex',
                        alignItems: 'center',
                        gap: '6px',
                    }}
                >
                    <IconClear /> <span>{t('topbar.clear')}</span>
                </button>

                <button
                    onClick={openSettings}
                    className="header-btn"
                    style={{ display: 'flex', alignItems: 'center', gap: '6px' }}
                >
                    <IconSettings /> <span>{t('topbar.settings')}</span>
                </button>
            </div>
        </div>
    );
};

export const BrowserSidebar = ({
    isOpen,
    reservedWidth,
    isResizing,
    onMouseDownResize,
    showBrowserUI,
    setShowBrowserUI,
    syncBrowserBounds,
    browserTabs,
    activeBrowserIdx,
    selectBrowserTab,
    closeBrowserTab,
    addBrowserTab,
    urlInput,
    setUrlInput,
    submitUrl,
    setIsUrlFocused,
    language = 'ru',
}: any) => {
    const t = getTranslator(language);

    return (
        <>
            <div
                onMouseDown={onMouseDownResize}
                style={{
                    width: isOpen ? '5px' : '0px',
                    backgroundColor: 'var(--bg-topbar)',
                    cursor: 'col-resize',
                    zIndex: 101,
                    borderLeft: isOpen ? '1px solid var(--border-subtle)' : 'none',
                    overflow: 'hidden',
                }}
            />

            <div
                style={{
                    width: isOpen ? `${reservedWidth}px` : '0px',
                    flexShrink: 0,
                    backgroundColor: 'var(--bg-side)',
                    transition: isResizing ? 'none' : 'width 0.3s cubic-bezier(0.4, 0, 0.2, 1)',
                    display: 'flex',
                    flexDirection: 'column',
                    overflow: 'hidden',
                }}
            >
                <div
                    style={{
                        backgroundColor: 'var(--bg-panel)',
                        display: 'flex',
                        flexDirection: 'column',
                        borderBottom: '1px solid var(--border-main)',
                        minWidth: `${reservedWidth}px`,
                    }}
                >
                    <div
                        style={{
                            display: 'flex',
                            justifyContent: 'space-between',
                            alignItems: 'center',
                            padding: '6px 12px',
                        }}
                    >
                        <span
                            style={{
                                fontWeight: 'bold',
                                color: 'var(--accent-blue)',
                                fontSize: '11px',
                                letterSpacing: '1px',
                            }}
                        >
                            {t('browser.title')}
                        </span>

                        <button
                            onClick={() => {
                                setShowBrowserUI(!showBrowserUI);
                                setTimeout(syncBrowserBounds, 50);
                            }}
                            style={{
                                background: 'transparent',
                                border: 'none',
                                color: 'var(--text-muted)',
                                fontSize: '11px',
                                cursor: 'pointer',
                            }}
                        >
                            {showBrowserUI ? t('browser.hideUi') : t('browser.showUi')}
                        </button>
                    </div>

                    {showBrowserUI && (
                        <div
                            style={{
                                padding: '0 12px 10px 12px',
                                display: 'flex',
                                flexDirection: 'column',
                                gap: '8px',
                            }}
                        >
                            <div
                                style={{
                                    display: 'flex',
                                    overflowX: 'auto',
                                    gap: '4px',
                                    paddingBottom: '2px',
                                }}
                            >
                                {browserTabs.map((bt: BrowserTab, i: number) => (
                                    <div
                                        key={bt.id || i}
                                        onClick={() => selectBrowserTab(i)}
                                        style={{
                                            padding: '4px 10px',
                                            background:
                                                activeBrowserIdx === i
                                                    ? 'var(--bg-main)'
                                                    : 'var(--bg-side)',
                                            border: `1px solid ${
                                                activeBrowserIdx === i
                                                    ? 'var(--accent-blue)'
                                                    : 'var(--border-main)'
                                            }`,
                                            color:
                                                activeBrowserIdx === i
                                                    ? 'var(--text-main)'
                                                    : 'var(--text-muted)',
                                            borderRadius: '4px',
                                            cursor: 'pointer',
                                            fontSize: '11px',
                                            display: 'flex',
                                            alignItems: 'center',
                                            gap: '6px',
                                            whiteSpace: 'nowrap',
                                            minWidth: '0',
                                            maxWidth: '180px',
                                            flexShrink: 0,
                                        }}
                                    >
                                        <div
                                            style={{
                                                display: 'flex',
                                                alignItems: 'center',
                                                gap: '6px',
                                                minWidth: 0,
                                                flex: 1,
                                            }}
                                        >
                                            {bt.favicon ? (
                                                <img
                                                    src={bt.favicon}
                                                    alt=""
                                                    style={{
                                                        width: '14px',
                                                        height: '14px',
                                                        flexShrink: 0,
                                                        borderRadius: '2px',
                                                    }}
                                                    onError={(e) => {
                                                        (e.currentTarget as HTMLImageElement).style.display = 'none';
                                                    }}
                                                />
                                            ) : (
                                                <div
                                                    style={{
                                                        width: '14px',
                                                        height: '14px',
                                                        flexShrink: 0,
                                                        borderRadius: '2px',
                                                        background: 'var(--border-main)',
                                                        opacity: 0.5,
                                                    }}
                                                />
                                            )}

                                            <span
                                                title={bt.title}
                                                style={{
                                                    maxWidth: '132px',
                                                    overflow: 'hidden',
                                                    textOverflow: 'ellipsis',
                                                    whiteSpace: 'nowrap',
                                                    display: 'inline-block',
                                                    verticalAlign: 'bottom',
                                                }}
                                            >
                                                {bt.title}
                                            </span>
                                        </div>

                                        <span
                                            onClick={(e) => closeBrowserTab(e, i)}
                                            style={{
                                                fontSize: '12px',
                                                opacity: 0.6,
                                                flexShrink: 0,
                                                lineHeight: 1,
                                            }}
                                        >
                                            x
                                        </span>
                                    </div>
                                ))}

                                <button
                                    onClick={addBrowserTab}
                                    style={{
                                        background: 'var(--bg-main)',
                                        border: '1px solid var(--border-main)',
                                        color: 'var(--text-main)',
                                        borderRadius: '4px',
                                        padding: '2px 8px',
                                        cursor: 'pointer',
                                        flexShrink: 0,
                                    }}
                                >
                                    +
                                </button>
                            </div>

                            <div style={{ display: 'flex', gap: '6px' }}>
                                <input
                                    type="text"
                                    placeholder={t('browser.addressPlaceholder')}
                                    value={urlInput}
                                    onChange={(e) => setUrlInput(e.target.value)}
                                    onKeyDown={(e) => e.key === 'Enter' && submitUrl()}
                                    onFocus={() => setIsUrlFocused(true)}
                                    onBlur={() => setIsUrlFocused(false)}
                                    style={{
                                        flex: 1,
                                        padding: '6px 10px',
                                        background: 'var(--bg-main)',
                                        color: 'var(--text-main)',
                                        border: '1px solid var(--border-main)',
                                        borderRadius: '4px',
                                        fontSize: '12px',
                                    }}
                                />

                                <button
                                    onClick={() => syncBrowserBounds()}
                                    title={t('browser.syncBounds')}
                                    style={{
                                        background: 'var(--bg-main)',
                                        border: '1px solid var(--border-main)',
                                        color: 'var(--text-muted)',
                                        borderRadius: '4px',
                                        padding: '0 10px',
                                        cursor: 'pointer',
                                    }}
                                >
                                    <IconPin />
                                </button>
                            </div>
                        </div>
                    )}
                </div>

                <div
                    id="native-browser-container"
                    style={{
                        flex: 1,
                        position: 'relative',
                        minWidth: `${reservedWidth}px`,
                        minHeight: 0,
                        overflow: 'hidden',
                    }}
                >
                    <div
                        style={{
                            position: 'absolute',
                            top: '50%',
                            left: '50%',
                            transform: 'translate(-50%, -50%)',
                            color: 'var(--border-main)',
                            textAlign: 'center',
                        }}
                    >
                        <IconBrowser />
                    </div>
                </div>
            </div>
        </>
    );
};
