import SettingsLookup from "./Settings/SettingsLookup";
import {
    IconSearch,
    IconImport,
    IconClear,
    IconSettings,
    IconChevronUp,
    IconChevronDown,
    IconClose,
} from './Icons';
import { defaultStats, EMPTY_LINES, Tab } from '../utils/constants';
import { useEffect, useRef, useState } from 'react';
import { usePresence } from '../utils/presence';
import './MobileShell.css';
import { getTranslator } from '../utils/i18n';
import TextContainer from './TextContainer';
import EpubWorkspace from '../features/epub/EpubWorkspace';
import StatsPanel from './StatsPanel';
import { invoke } from '@tauri-apps/api/core';
import { openUrl } from '@tauri-apps/plugin-opener';
import { readText as readClipboardText } from '@tauri-apps/plugin-clipboard-manager';
import { listen } from '@tauri-apps/api/event';
import {
    assertGoogleOAuthConfigured,
    createDictFileMetadata,
    createGooglePkceSession,
    bytesAvailableInDrive,
    deleteDriveFile,
    downloadFromDrive,
    exchangeCodeForToken,
    getAccessToken,
    getAuthUrl,
    getDictDriveInfo,
    getDriveQuota,
    listBackups,
    startDictionaryResumableUpload,
    storeGoogleRefreshToken,
    uploadToDrive,
    type DriveFileInfo,
    type DriveQuotaInfo,
    type GooglePkceSession,
} from '../utils/gdrive';
import { GOOGLE_DRIVE_AVAILABLE } from '../utils/featureFlags';
import { tokenizeLookupText, normalizeWebSocketUrl } from '../utils/appRuntime';
import {
    getMobileOverlayStatus,
    enableMobileOverlay,
    hideMobileOverlay,
    requestMobileOverlayPermission,
    showMobileOverlay,
} from '../utils/mobileOverlay';
import {
    getMobileTextCaptureStatus,
    hasMobileTextCapture,
    startMobileTextCapture,
    stopMobileTextCapture,
} from '../utils/mobileTextCapture';
import { openMobileDictionaryPicker } from '../utils/mobileFiles';
import { MOBILE_BACK_PRIORITY, useMobileBackHandler } from '../utils/mobileBack';
import SettingsFeedback from './Settings/SettingsFeedback';
import {
    clearAnkiMetaCache,
    getAnkiDroidStatus,
    getDecks,
    getModelFields,
    getModels,
    requestAnkiDroidPermission,
} from '../utils/anki';


export const SearchBar = ({
    isOpen,
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
                right: '20px',
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

type MobileLookupToken = {
    text: string;
    reading?: string | null;
    lemma?: string | null;
    lookupTerm?: string | null;
    lookupReading?: string | null;
    lookupFound?: boolean;
    start?: number;
    end?: number;
    lookup?: boolean;
};
type MobileSettingsSection = 'reading' | 'flow' | 'source' | 'anki' | 'drive' | 'data' | 'feedback';
type MobileDriveTransfer = {
    operation: 'backup-upload' | 'backup-download' | 'upload' | 'download';
    label: string;
    transferred: number;
    total: number;
    percent: number;
    startedAt: number;
};
type MobileDictionaryStorage = { path: string; size: number; availableBytes?: number | null };

const MOBILE_JAPANESE_RE = /[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff\uff66-\uff9f]/;
const MOBILE_LATIN_RE = /[A-Za-z\u00c0-\u024f]/;

const formatMobileBytes = (raw?: string | number | null) => {
    const value = Number(raw || 0);
    if (!Number.isFinite(value) || value <= 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const index = Math.min(units.length - 1, Math.floor(Math.log(value) / Math.log(1024)));
    const number = value / Math.pow(1024, index);
    return `${number >= 10 || index === 0 ? number.toFixed(0) : number.toFixed(1)} ${units[index]}`;
};

const formatMobileDuration = (seconds: number) => {
    if (!Number.isFinite(seconds) || seconds <= 0) return '—';
    if (seconds < 60) return `${Math.ceil(seconds)} s`;
    const minutes = Math.floor(seconds / 60);
    const rest = Math.ceil(seconds % 60);
    return `${minutes}m ${rest}s`;
};

const MobileSentenceTokens = ({
    text,
    onLookup,
    placeholder,
}: {
    text: string;
    onLookup: (token: string, cursor: number) => void;
    placeholder: string;
}) => {
    const [tokens, setTokens] = useState<MobileLookupToken[] | null>(null);

    useEffect(() => {
        let cancelled = false;
        setTokens(null);
        const timer = window.setTimeout(() => {
            if (!text.trim()) {
                setTokens([]);
                return;
            }
            invoke<MobileLookupToken[]>('get_furigana', { text, contextBefore: '', contextAfter: '' })
                .then((result) => {
                    if (!cancelled) setTokens(Array.isArray(result) && result.length > 0 ? result : null);
                })
                .catch(() => {
                    if (!cancelled) setTokens(null);
                });
        }, 140);
        return () => {
            cancelled = true;
            window.clearTimeout(timer);
        };
    }, [text]);

    if (!text.trim()) return <div className="mobile-placeholder compact">{placeholder}</div>;

    const parts = !tokens?.length
        ? tokenizeLookupText(text).map((part) => ({ text: part.text, cursor: part.cursor, lookup: part.lookup, reading: null }))
        : (() => {
            let charOffset = 0;
            return tokens.map((token) => {
                const nativeStart = Number(token.start);
                const cursor = Number.isInteger(nativeStart) && nativeStart >= 0
                    ? nativeStart
                    : charOffset;
                charOffset += Array.from(token.text).length;
                return {
                    text: token.text,
                    cursor,
                    lookup: typeof token.lookup === 'boolean'
                        ? token.lookup
                        : MOBILE_JAPANESE_RE.test(token.text) || MOBILE_LATIN_RE.test(token.text),
                    reading: token.reading,
                };
            });
        })();

    return <>
        {parts.map((part, index) => part.lookup ? (
            <button
                key={`${part.text}-${part.cursor}-${index}`}
                type="button"
                className="lookup-token mobile-token"
                onClick={() => onLookup(part.text, part.cursor)}
            >
                {part.reading && <ruby>{part.text}<rt>{part.reading}</rt></ruby>}
                {!part.reading && part.text}
            </button>
        ) : (
            <span key={`${part.text}-${part.cursor}-${index}`} className="mobile-token-plain">{part.text}</span>
        ))}
    </>;
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
    runDictImport,
    setConfirmDialog,
    openImport,
    clearAll,
    wsStatuses,
    wsConnecting,
    wsIntents,
    setWsEnabled,
    lookupOpen,
    onCloseLookup,
    lookupNotice,
    settingsRequest,
    epubBooks = [],
    onOpenEpubFile,
    onSelectEpubBook,
    onRemoveEpubBook,
    onRemoveEpubBooks,
    onPatchEpubBooks,
    onUpdateEpubMeta,
    onUpdateMangaMeta,
    onMangaScreenshot,
    onEpubProgress,
    onEpubOrientationChange,
    onEpubBookmarksChange,
    onEpubHighlightsChange,
    onEpubNotesChange,
    onEpubReadingPointChange,
    onEpubRecordStats,
    onResetEpubStats,
    onImportEpubBackup,
    epubSyncStatus,
    epubLastSyncedAt,
    epubSyncError,
    epubDownloadingBookId,
    onEpubSyncNow,
    onOpenCloudSettings,
    onHome,
    onCloseMobileSettings,
}: any) => {
    const t = getTranslator(settings?.appLanguage || 'ru');
    const [activeMobileView, setActiveMobileView] = useState<'text' | 'lookup'>('text');
    const [lookupText, setLookupText] = useState('');
    const [isMobileSettingsOpen, setIsMobileSettingsOpen] = useState(false);
    const [mobileSettingsSection, setMobileSettingsSection] = useState<MobileSettingsSection>('reading');
    const [isStatsOpen, setIsStatsOpen] = useState(false);
    const [tabsOpen, setTabsOpen] = useState(false);
    const [driveStatus, setDriveStatus] = useState('');
    const [driveAuthInput, setDriveAuthInput] = useState('');
    const [driveBusy, setDriveBusy] = useState(false);
    const [driveQuota, setDriveQuota] = useState<DriveQuotaInfo | null>(null);
    const [driveBackups, setDriveBackups] = useState<DriveFileInfo[]>([]);
    const [driveDictionary, setDriveDictionary] = useState<DriveFileInfo | null>(null);
    const [localDictionary, setLocalDictionary] = useState<MobileDictionaryStorage | null>(null);
    const [driveTransfer, setDriveTransfer] = useState<MobileDriveTransfer | null>(null);
    const [isDriveArchiveOpen, setIsDriveArchiveOpen] = useState(false);
    const [driveClock, setDriveClock] = useState(Date.now());
    const [overlayStatus, setOverlayStatus] = useState('');
    const [overlayResumeTick, setOverlayResumeTick] = useState(0);
    const drivePkceRef = useRef<GooglePkceSession | null>(null);
    const driveRedirectRef = useRef('http://127.0.0.1:1337');
    const driveOauthUnlistenRef = useRef<(() => void) | null>(null);
    const mobileSettingsNavRef = useRef<HTMLDivElement | null>(null);

    const DRIVE_PKCE_STORAGE_KEY = 'setsuna-mobile-drive-pkce';
    const savePendingDrivePkce = (pkce: GooglePkceSession, redirectUri: string) => {
        drivePkceRef.current = pkce;
        driveRedirectRef.current = redirectUri;
        try {
            const raw = sessionStorage.getItem(DRIVE_PKCE_STORAGE_KEY);
            const prev = raw ? (JSON.parse(raw) as Array<{ pkce: GooglePkceSession; redirectUri: string; at: number }>) : [];
            const next = [...prev.filter((e) => e?.pkce?.state && Date.now() - (e.at || 0) < 20 * 60_000), { pkce, redirectUri, at: Date.now() }].slice(-4);
            sessionStorage.setItem(DRIVE_PKCE_STORAGE_KEY, JSON.stringify(next));
        } catch {}
    };
    const resolvePendingDrivePkce = (codeOrUrl: string): { pkce: GooglePkceSession; redirectUri: string } | null => {
        let stateParam = '';
        try {
            const trimmed = codeOrUrl.trim();
            if (trimmed.startsWith('http')) {
                stateParam = new URL(trimmed).searchParams.get('state') || '';
            }
        } catch {}
        if (drivePkceRef.current && (!stateParam || drivePkceRef.current.state === stateParam)) {
            return { pkce: drivePkceRef.current, redirectUri: driveRedirectRef.current };
        }
        try {
            const raw = sessionStorage.getItem(DRIVE_PKCE_STORAGE_KEY);
            const list = raw ? (JSON.parse(raw) as Array<{ pkce: GooglePkceSession; redirectUri: string; at: number }>) : [];
            if (stateParam) {
                const matched = list.find((entry) => entry?.pkce?.state === stateParam);
                if (matched) return { pkce: matched.pkce, redirectUri: matched.redirectUri };
            }
            const latest = list[list.length - 1];
            if (latest?.pkce) return { pkce: latest.pkce, redirectUri: latest.redirectUri };
        } catch {}
        if (drivePkceRef.current) {
            return { pkce: drivePkceRef.current, redirectUri: driveRedirectRef.current };
        }
        return null;
    };
    const clearPendingDrivePkce = () => {
        drivePkceRef.current = null;
        try { sessionStorage.removeItem(DRIVE_PKCE_STORAGE_KEY); } catch {}
    };
    useEffect(() => () => {
        try { driveOauthUnlistenRef.current?.(); } catch {}
        driveOauthUnlistenRef.current = null;
    }, []);
    const [ankiStatusText, setAnkiStatusText] = useState('');
    const [ankiDecks, setAnkiDecks] = useState<string[]>([]);
    const [ankiModels, setAnkiModels] = useState<string[]>([]);
    const [ankiFields, setAnkiFields] = useState<string[]>([]);
    const [ankiBusy, setAnkiBusy] = useState(false);
    const [nativeCapture, setNativeCapture] = useState(() => getMobileTextCaptureStatus());
    const [settingsHome, setSettingsHome] = useState(true);
    const settingsPresence = usePresence(isMobileSettingsOpen, 260);
    const inputPresence = usePresence(activeMobileView === 'lookup', 240);
    const tabsPresence = usePresence(tabsOpen, 240);
    const statsPresence = usePresence(isStatsOpen, 240);
    // Android WebViews can deliver the tap that opened a sheet a second time to
    // whatever the new sheet put under the finger (for example "new tab").
    // Taps inside a layer during its first moments are ignored.
    const layerOpenedAtRef = useRef(0);
    useEffect(() => {
        if (tabsOpen || isStatsOpen || isMobileSettingsOpen || activeMobileView === 'lookup') {
            layerOpenedAtRef.current = performance.now();
        }
    }, [tabsOpen, isStatsOpen, isMobileSettingsOpen, activeMobileView]);
    const swallowGhostTap = (event: { preventDefault(): void; stopPropagation(): void }) => {
        if (performance.now() - layerOpenedAtRef.current < 380) {
            event.preventDefault();
            event.stopPropagation();
        }
    };
    const visibleTabs = (tabs || []).filter((tab: Tab) => !tab.archived);
    const stats = activeTab?.stats || defaultStats;
    const isEn = settings?.appLanguage === 'en';
    const overlayText = activeTab?.lines?.[activeTab.lines.length - 1] || '';
    const overlayOptions = {
        dictionaries: settings.dictionaries || [],
        fontSize: settings.mobileOverlayFontSize ?? 22,
        fontFamily: settings.mobileOverlayFontFamily || 'serif',
        lineHeight: settings.mobileOverlayLineHeight ?? 1.2,
        opacity: settings.mobileOverlayOpacity ?? 88,
        textColor: settings.mobileOverlayTextColor || '#ffffff',
        backgroundColor: settings.mobileOverlayBackgroundColor || '#15181d',
        borderColor: settings.mobileOverlayBorderColor || '#56606d',
        width: settings.mobileOverlayWidth ?? 320,
        height: settings.mobileOverlayHeight ?? 160,
        padding: settings.mobileOverlayPadding ?? 12,
        lookupHeight: settings.mobileOverlayLookupHeight ?? 220,
        locked: settings.mobileOverlayLocked === true,
        toolbarExpanded: settings.mobileOverlayToolbarExpanded === true,
        language: settings.appLanguage || 'ru',
        ankiDeck: activeTab?.ankiDeck || settings.ankiDeck || '',
        ankiModel: settings.ankiModel || '',
        ankiFieldWord: settings.ankiFieldWord || '',
        ankiFieldReading: settings.ankiFieldReading || '',
        ankiFieldMeaning: settings.ankiFieldMeaning || '',
        ankiFieldSentence: settings.ankiFieldSentence || '',
        ankiFieldDict: settings.ankiFieldDict || '',
        ankiFieldScreenshot: settings.ankiFieldScreenshot || '',
    };
    const openMobileDictionaryImport = () => {
        try {
            if (!openMobileDictionaryPicker()) openImport();
        } catch (error: any) {
            setDriveStatus(error?.message || String(error));
        }
    };

    useEffect(() => {
        if (!settingsRequest?.id) return;
        if (settingsRequest.section) setMobileSettingsSection(settingsRequest.section);
        setSettingsHome(!settingsRequest.section);
        setIsMobileSettingsOpen(true);
    }, [settingsRequest?.id, settingsRequest?.section]);

    useEffect(() => {
        if (!isMobileSettingsOpen) return;
        const frame = window.requestAnimationFrame(() => {
            const active = mobileSettingsNavRef.current?.querySelector<HTMLElement>('[aria-selected="true"]');
            active?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
        });
        return () => window.cancelAnimationFrame(frame);
    }, [isMobileSettingsOpen, mobileSettingsSection]);

    useEffect(() => {
        let unlisten: (() => void) | undefined;
        listen<{ operation: 'upload' | 'download'; transferred: number; total: number; percent: number; phase?: string }>(
            'drive_dictionary_progress',
            (event) => {
                const payload = event.payload;
                setDriveTransfer((current) => ({
                    operation: payload.operation,
                    label: payload.phase === 'connecting' ? (isEn ? 'Connecting to Google Drive…' : 'Подключение к Google Drive…')
                        : payload.phase === 'retrying' ? (isEn ? 'Reconnecting to Google Drive…' : 'Повторное подключение к Google Drive…')
                        : payload.phase === 'validating' ? (isEn ? 'Checking and installing the database…' : 'Проверка и установка базы…')
                        : payload.operation === 'upload'
                        ? (isEn ? 'Uploading dictionaries' : 'Загрузка словарей в Drive')
                        : (isEn ? 'Downloading dictionaries' : 'Скачивание словарей из Drive'),
                    transferred: Number(payload.transferred || 0),
                    total: Number(payload.total || 0),
                    percent: Number(payload.percent || 0),
                    startedAt: current?.operation === payload.operation ? current.startedAt : Date.now(),
                }));
            },
        ).then((dispose) => { unlisten = dispose; });
        return () => unlisten?.();
    }, [isEn]);

    useEffect(() => {
        if (!driveBusy || !driveTransfer) return;
        const timer = window.setInterval(() => setDriveClock(Date.now()), 1000);
        return () => window.clearInterval(timer);
    }, [driveBusy, driveTransfer?.startedAt]);

    const closeMobileSettings = () => {
        setIsMobileSettingsOpen(false);
        onCloseMobileSettings?.();
    };

    useMobileBackHandler(isMobileSettingsOpen, MOBILE_BACK_PRIORITY.MODAL, () => {
        if (!settingsHome) {
            setSettingsHome(true);
        } else {
            closeMobileSettings();
        }
    });
    useMobileBackHandler(tabsOpen, MOBILE_BACK_PRIORITY.SUBVIEW + 2, () => {
        setTabsOpen(false);
    });
    useMobileBackHandler(isStatsOpen, MOBILE_BACK_PRIORITY.SUBVIEW + 1, () => {
        setIsStatsOpen(false);
    });
    useMobileBackHandler(activeMobileView === 'lookup', MOBILE_BACK_PRIORITY.SUBVIEW, () => {
        setActiveMobileView('text');
    });
    useMobileBackHandler(Boolean(onHome), MOBILE_BACK_PRIORITY.WORKSPACE, () => {
        if (!onHome) return false;
        onHome();
    });

    const refreshOverlayStatus = () => {
        try {
            const status = getMobileOverlayStatus();
            setOverlayStatus(status.granted
                ? (isEn ? 'Overlay permission is allowed.' : 'Разрешение на показ поверх приложений выдано.')
                : (isEn ? 'Allow “display over other apps” for Setsuna first.' : 'Сначала разреши Setsuna показ поверх других приложений.'));
            return status.granted;
        } catch (error: any) {
            setOverlayStatus(error?.message || String(error));
            return false;
        }
    };

    useEffect(() => {
        const resume = () => setOverlayResumeTick((value) => value + 1);
        window.addEventListener('focus', resume);
        document.addEventListener('visibilitychange', resume);
        return () => {
            window.removeEventListener('focus', resume);
            document.removeEventListener('visibilitychange', resume);
        };
    }, []);

    useEffect(() => {
        if (!settings.mobileOverlayEnabled) {
            try { hideMobileOverlay(); } catch {}
            return;
        }
        if (getMobileOverlayStatus().dismissed) {
            updateSetting('mobileOverlayEnabled', false);
            return;
        }
        if (!overlayText) return;
        let cancelled = false;
        void (async () => {
            let tokenData: Array<{
                text: string;
                lookup: boolean;
                lemma?: string | null;
                reading?: string | null;
                lookupTerm?: string | null;
                lookupReading?: string | null;
            }> = [];
            try {
                const tokens = await invoke<MobileLookupToken[]>('get_flow_tokens', {
                    text: overlayText,
                });
                tokenData = (Array.isArray(tokens) ? tokens : []).map((token) => ({
                    text: token.text,
                    lookup: token.lookup !== false
                        && (MOBILE_JAPANESE_RE.test(token.text) || MOBILE_LATIN_RE.test(token.text)),
                    lemma: token.lemma,
                    reading: token.reading,
                    lookupTerm: token.lookupTerm,
                    lookupReading: token.lookupReading,
                }));
            } catch {
                // The overlay can still display the raw line when tokenization is unavailable.
            }
            if (cancelled) return;
            try {
                const result = showMobileOverlay(overlayText, { ...overlayOptions, tokens: tokenData });
                if (result.dismissed) {
                    updateSetting('mobileOverlayEnabled', false);
                    return;
                }
                setOverlayStatus(isEn ? 'Showing the latest line over other apps.' : 'Последняя строка показывается поверх других приложений.');
            } catch (error: any) {
                setOverlayStatus(error?.message || String(error));
            }
        })();
        return () => { cancelled = true; };
    }, [
        overlayText,
        settings.mobileOverlayEnabled,
        settings.dictionaries,
        settings.mobileOverlayFontSize,
        settings.mobileOverlayFontFamily,
        settings.mobileOverlayLineHeight,
        settings.mobileOverlayOpacity,
        settings.mobileOverlayTextColor,
        settings.mobileOverlayBackgroundColor,
        settings.mobileOverlayBorderColor,
        settings.mobileOverlayWidth,
        settings.mobileOverlayHeight,
        settings.mobileOverlayPadding,
        settings.mobileOverlayLookupHeight,
        settings.mobileOverlayLocked,
        settings.mobileOverlayToolbarExpanded,
        activeTab?.ankiDeck,
        settings.ankiDeck,
        settings.ankiModel,
        settings.ankiFieldWord,
        settings.ankiFieldReading,
        settings.ankiFieldMeaning,
        settings.ankiFieldSentence,
        settings.ankiFieldDict,
        settings.ankiFieldScreenshot,
        overlayResumeTick,
    ]);
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
            const pending = resolvePendingDrivePkce(code);
            if (!pending) throw new Error(isEn ? 'Start Google sign-in again first.' : 'Сначала снова открой вход Google.');
            const tokenData = await exchangeCodeForToken(code, pending.redirectUri, pending.pkce.verifier, pending.pkce.state);
            if (!tokenData.refresh_token) throw new Error(isEn ? 'Google did not return a refresh token.' : 'Google не выдал refresh token.');
            clearPendingDrivePkce();
            try { driveOauthUnlistenRef.current?.(); } catch {}
            driveOauthUnlistenRef.current = null;
            updateSetting('gdriveRefreshToken', tokenData.refresh_token);
            void storeGoogleRefreshToken(tokenData.refresh_token).catch(() => {});
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

    const updateActiveTabDeck = (deck: string) => {
        setTabs?.((currentTabs: Tab[]) => currentTabs.map((tab) => (
            tab.id === activeTabId ? { ...tab, ankiDeck: deck || null } : tab
        )));
        if (settings.ankiDeckMode !== 'contextual') updateSetting('ankiDeckMode', 'contextual');
    };

    const toggleMobileFlow = () => {
        if (settings.mobileOverlayEnabled) {
            try { hideMobileOverlay(); } catch {}
            updateSetting('mobileOverlayEnabled', false);
            setOverlayStatus(isEn ? 'Setsuna Flow is hidden.' : 'Setsuna Flow скрыт.');
            return;
        }
        const granted = refreshOverlayStatus();
        enableMobileOverlay();
        updateSetting('mobileOverlayEnabled', true);
        if (!granted) {
            try {
                requestMobileOverlayPermission();
                setOverlayStatus(isEn
                    ? 'Allow display over other apps, then return to Setsuna.'
                    : 'Разреши показ поверх приложений и вернись в Setsuna.');
            } catch (error: any) {
                setOverlayStatus(error?.message || String(error));
            }
        }
    };

    // Mobile text source over WebSocket (e.g. Textractor / LunaTranslator WS server
    // running on a Steam Deck / PC on the same network). Reuses the shared websocket
    // client in App.tsx by persisting a single dedicated entry in settings.websockets.
    const MOBILE_WS_ID = 'mobile-ws';
    const mobileWs = (settings.websockets || []).find((w: any) => w.id === MOBILE_WS_ID) || null;
    const useNativeCapture = hasMobileTextCapture();
    const wsConnected = useNativeCapture
        ? nativeCapture.connected
        : !!(wsStatuses && wsStatuses[MOBILE_WS_ID]);
    const wsIsConnecting = useNativeCapture
        ? nativeCapture.running && !nativeCapture.connected
        : !!(wsConnecting && wsConnecting[MOBILE_WS_ID]) && !wsConnected;
    const wsIntentOn = useNativeCapture
        ? nativeCapture.running
        : !!(wsIntents && wsIntents[MOBILE_WS_ID]);
    const [wsDraftUrl, setWsDraftUrl] = useState(mobileWs?.url || '');

    useEffect(() => {
        if (!useNativeCapture) return;
        const refresh = () => setNativeCapture(getMobileTextCaptureStatus());
        refresh();
        const timer = window.setInterval(refresh, 1500);
        return () => window.clearInterval(timer);
    }, [useNativeCapture]);

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
        if (useNativeCapture) {
            try {
                startMobileTextCapture(url);
                setNativeCapture(getMobileTextCaptureStatus());
                setWsEnabled?.(MOBILE_WS_ID, false);
                if (setIsPaused) setIsPaused(false);
            } catch (error: any) {
                setDriveStatus(error?.message || String(error));
            }
            return;
        }
        // This must be explicit rather than a toggle: persisting settings is
        // asynchronous, so a stale "off" value used to leave Android waiting
        // forever without actually opening a socket.
        setWsEnabled?.(MOBILE_WS_ID, true);
        // Connecting a text source means "I want to read now" - the app starts
        // paused, which would otherwise silently drop the incoming lines.
        if (setIsPaused) setIsPaused(false);
    };

    const disconnectMobileWs = () => {
        if (useNativeCapture) {
            try {
                stopMobileTextCapture();
                setNativeCapture(getMobileTextCaptureStatus());
            } catch (error: any) {
                setDriveStatus(error?.message || String(error));
            }
            return;
        }
        setWsEnabled?.(MOBILE_WS_ID, false);
    };

    const wsStatusLabel = wsConnected
        ? (isEn ? 'Connected - receiving text' : 'Подключено - принимаю текст')
        : wsIsConnecting
            ? (isEn ? 'Connecting...' : 'Подключаюсь...')
            : wsIntentOn
                ? (nativeCapture.error
                    ? nativeCapture.error
                    : (isEn ? 'Waiting for source...' : 'Жду источник...'))
                : (isEn ? 'Not connected' : 'Не подключено');

    const findAnkiField = (fields: string[], ...candidates: string[]) => {
        const normalized = candidates.map((item) => item.toLowerCase().replace(/[^a-z0-9]/g, ''));
        return fields.find((field) => normalized.includes(field.toLowerCase().replace(/[^a-z0-9]/g, ''))) || 'none';
    };

    const loadMobileAnki = async (force = false) => {
        setAnkiBusy(true);
        try {
            const status = await getAnkiDroidStatus().catch(() => null);
            if (!status?.available) {
                setAnkiDecks([]);
                setAnkiModels([]);
                setAnkiFields([]);
                setAnkiStatusText(isEn
                    ? 'Install AnkiDroid first, then return here.'
                    : 'Сначала установи AnkiDroid, затем вернись сюда.');
                return;
            }
            if (!status.permissionGranted) {
                setAnkiDecks([]);
                setAnkiModels([]);
                setAnkiFields([]);
                setAnkiStatusText(isEn
                    ? 'Allow AnkiDroid access, then tap Refresh.'
                    : 'Разреши доступ к AnkiDroid, затем нажми «Обновить».');
                return;
            }
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
        if (isMobileSettingsOpen) loadMobileAnki(false);
    }, [isMobileSettingsOpen]);

    useEffect(() => {
        if (isMobileSettingsOpen && settings.gdriveRefreshToken) {
            void refreshDriveOverview(true);
        }
    }, [isMobileSettingsOpen, settings.gdriveRefreshToken]);

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

    const refreshDriveOverview = async (quiet = false) => {
        if (!settings.gdriveRefreshToken) return;
        if (!quiet) setDriveBusy(true);
        try {
            const token = await getAccessToken(settings.gdriveRefreshToken);
            const [quota, backups, dictionary, local] = await Promise.all([
                getDriveQuota(token),
                listBackups(token),
                getDictDriveInfo(token),
                invoke<MobileDictionaryStorage>('get_dictionary_storage_info').catch(() => null),
            ]);
            setDriveQuota(quota);
            setDriveBackups(backups);
            setDriveDictionary(dictionary);
            setLocalDictionary(local);
            if (!quiet) setDriveStatus(isEn ? 'Google Drive is ready.' : 'Google Drive готов.');
        } catch (error: any) {
            setDriveStatus(error?.message || String(error));
        } finally {
            if (!quiet) setDriveBusy(false);
        }
    };

    const connectDrive = async () => {
        if (!GOOGLE_DRIVE_AVAILABLE) return;
        setDriveStatus(isEn ? 'Opening Google…' : 'Открываю Google…');
        try {
            assertGoogleOAuthConfigured();
            setDriveAuthInput('');
            try { driveOauthUnlistenRef.current?.(); } catch {}
            driveOauthUnlistenRef.current = null;
            // Start the on-device OAuth catch server; the browser's redirect to 127.0.0.1
            // hits this app and fires the "oauth_code" event, which we exchange automatically.
            const start = await invoke<{ port: number; redirect_uri: string; reused: boolean }>('start_oauth_server');
            const redirectUri = start.redirect_uri;
            const pkce = await createGooglePkceSession();
            savePendingDrivePkce(pkce, redirectUri);
            const unlisten = await listen<string>('oauth_code', async (event) => {
                const payload = String(event.payload || '');
                const pending = resolvePendingDrivePkce(payload) || { pkce, redirectUri };
                try { unlisten(); } catch {}
                if (driveOauthUnlistenRef.current === unlisten) {
                    driveOauthUnlistenRef.current = null;
                }
                setDriveBusy(true);
                setDriveStatus(isEn ? 'Connecting…' : 'Подключаю…');
                try {
                    const tokenData = await exchangeCodeForToken(payload, pending.redirectUri, pending.pkce.verifier, pending.pkce.state);
                    if (!tokenData.refresh_token) throw new Error(isEn ? 'Google did not return a refresh token.' : 'Google не выдал refresh token.');
                    clearPendingDrivePkce();
                    updateSetting('gdriveRefreshToken', tokenData.refresh_token);
                    void storeGoogleRefreshToken(tokenData.refresh_token).catch(() => {});
                    setDriveAuthInput('');
                    setDriveStatus(isEn ? 'Google Drive connected.' : 'Google Drive подключён.');
                } catch (err: any) {
                    setDriveStatus(err?.message || String(err));
                } finally {
                    setDriveBusy(false);
                }
            });
            driveOauthUnlistenRef.current = unlisten;
            const url = getAuthUrl(redirectUri, pkce);
            await openUrl(url).catch(() => window.open(url, '_blank'));
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
            const pending = resolvePendingDrivePkce(code);
            if (!pending) throw new Error(isEn ? 'Start Google sign-in again first.' : 'Сначала снова открой вход Google.');
            const tokenData = await exchangeCodeForToken(code, pending.redirectUri, pending.pkce.verifier, pending.pkce.state);
            if (!tokenData.refresh_token) throw new Error(isEn ? 'Google did not return refresh token.' : 'Google не выдал refresh token.');
            clearPendingDrivePkce();
            try { driveOauthUnlistenRef.current?.(); } catch {}
            driveOauthUnlistenRef.current = null;
            updateSetting('gdriveRefreshToken', tokenData.refresh_token);
            void storeGoogleRefreshToken(tokenData.refresh_token).catch(() => {});
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
            const payload = {
                metadata: { date: new Date().toISOString(), source: 'setsuna-mobile' },
                settings: cleanSettingsForBackup(),
                activeTabId,
                tabs: (tabs || []).filter((tab: any) => !tab.archived).map((tab: any) => {
                    const clean = JSON.parse(JSON.stringify(tab));
                    delete clean.captureSource;
                    delete clean.shared;
                    return clean;
                }),
                archive: (tabs || []).filter((tab: any) => tab.archived).map((tab: any) => {
                    const clean = JSON.parse(JSON.stringify(tab));
                    delete clean.captureSource;
                    delete clean.shared;
                    return clean;
                }),
            };
            const estimatedSize = new Blob([JSON.stringify(payload)]).size;
            setDriveTransfer({
                operation: 'backup-upload',
                label: isEn ? 'Uploading windows and settings' : 'Загрузка окон и настроек',
                transferred: 0,
                total: estimatedSize,
                percent: 0,
                startedAt: Date.now(),
            });
            await uploadToDrive(token, payload, (percent) => setDriveTransfer((current) => current ? {
                ...current,
                percent,
                transferred: Math.round(estimatedSize * percent / 100),
            } : current));
            setDriveStatus(isEn ? 'Backup uploaded.' : 'Бэкап загружен.');
            await refreshDriveOverview(true);
        } catch (error: any) {
            setDriveStatus(error?.message || String(error));
        } finally {
            setDriveBusy(false);
        }
    };

    const restoreMobileBackup = async (backup?: DriveFileInfo) => {
        if (!GOOGLE_DRIVE_AVAILABLE) return;
        if (!settings.gdriveRefreshToken) return;
        setDriveBusy(true);
        setDriveStatus(isEn ? 'Restoring backup...' : 'Восстанавливаю бэкап...');
        try {
            const token = await getAccessToken(settings.gdriveRefreshToken);
            const selected = backup || driveBackups[0] || (await listBackups(token))[0];
            if (!selected) throw new Error(isEn ? 'No backups in Google Drive.' : 'В Google Drive нет бэкапов.');
            const total = Number(selected.size || 0);
            setDriveTransfer({
                operation: 'backup-download',
                label: isEn ? 'Downloading windows and settings' : 'Скачивание окон и настроек',
                transferred: 0,
                total,
                percent: 0,
                startedAt: Date.now(),
            });
            const data = await downloadFromDrive(token, selected.id, (percent) => setDriveTransfer((current) => current ? {
                ...current,
                percent,
                transferred: total ? Math.round(total * percent / 100) : current.transferred,
            } : current));
            const restoredTabs = [
                ...(Array.isArray(data.tabs) ? data.tabs : []),
                ...(Array.isArray(data.archive) ? data.archive.map((tab: any) => ({ ...tab, archived: true })) : []),
            ];
            try {
                localStorage.setItem('setsuna-pre-drive-restore', JSON.stringify({
                    createdAt: new Date().toISOString(),
                    settings,
                    tabs,
                    activeTabId,
                }));
            } catch {}

            if (data.settings && updateSettings) {
                const currentDictionaries = Array.isArray(settings.dictionaries) ? settings.dictionaries : [];
                const restoredDictionaries = Array.isArray(data.settings.dictionaries) ? data.settings.dictionaries : [];
                const restoredByName = new Map(restoredDictionaries.map((dictionary: any) => [dictionary?.name, dictionary]));
                updateSettings({
                    ...settings,
                    ...data.settings,
                    dictionaries: currentDictionaries.map((dictionary: any) => restoredByName.get(dictionary?.name) || dictionary),
                    gdriveRefreshToken: settings.gdriveRefreshToken,
                });
            }
            if (restoredTabs.length > 0 && setTabs) {
                setTabs(restoredTabs);
                const requestedId = Number(data.activeTabId);
                const nextActiveId = restoredTabs.some((tab: any) => tab.id === requestedId && !tab.archived)
                    ? requestedId
                    : restoredTabs.find((tab: any) => !tab.archived)?.id ?? restoredTabs[0].id;
                window.setTimeout(() => switchTab(nextActiveId), 0);
                await invoke('save_workspace_state', {
                    content: JSON.stringify({
                        version: 1,
                        updatedAt: Date.now(),
                        activeTabId: nextActiveId,
                        tabs: restoredTabs,
                    }),
                });
            }
            const restoredParts = [
                data.settings ? (isEn ? 'settings' : 'настройки') : '',
                restoredTabs.length ? `${restoredTabs.length} ${isEn ? 'tabs' : 'вкладок'}` : '',
            ].filter(Boolean).join(isEn ? ' and ' : ' и ');
            setDriveStatus(isEn
                ? `Restored ${restoredParts || 'backup data'}. A safety copy was saved locally.`
                : `Восстановлено: ${restoredParts || 'данные бэкапа'}. Перед заменой сохранена локальная страховочная копия.`);
        } catch (error: any) {
            setDriveStatus(error?.message || String(error));
        } finally {
            setDriveBusy(false);
        }
    };

    const deleteMobileBackup = async (backup: DriveFileInfo) => {
        if (!settings.gdriveRefreshToken) return;
        setDriveBusy(true);
        try {
            const token = await getAccessToken(settings.gdriveRefreshToken);
            await deleteDriveFile(token, backup.id);
            await refreshDriveOverview(true);
            setDriveStatus(isEn ? 'Backup removed.' : 'Бэкап удалён.');
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
            const local = localDictionary || await invoke<MobileDictionaryStorage>('get_dictionary_storage_info');
            const available = driveQuota ? bytesAvailableInDrive(driveQuota) : null;
            const replacedSize = Number(driveDictionary?.size || 0);
            if (available != null && available + replacedSize < local.size + Math.max(32 * 1024 * 1024, local.size * 0.02)) {
                throw new Error(isEn ? 'Not enough free space in Google Drive.' : 'В Google Drive недостаточно свободного места.');
            }
            const info = await getDictDriveInfo(token);
            const fileId = info?.id || await createDictFileMetadata(token);
            const sessionUrl = await startDictionaryResumableUpload(token, fileId, local.size);
            setDriveTransfer({
                operation: 'upload',
                label: isEn ? 'Uploading dictionaries' : 'Загрузка словарей в Drive',
                transferred: 0,
                total: local.size,
                percent: 0,
                startedAt: Date.now(),
            });
            await invoke('upload_db_to_drive', {
                url: sessionUrl,
                token,
            });
            setDriveStatus(isEn ? 'Dictionary uploaded.' : 'Словарь загружен.');
            await refreshDriveOverview(true);
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
            const expectedSize = Number(info.size || 0);
            if (expectedSize && localDictionary?.availableBytes != null) {
                const margin = Math.max(32 * 1024 * 1024, Math.ceil(expectedSize * 0.02));
                if (localDictionary.availableBytes < expectedSize + margin) {
                    throw new Error(isEn ? 'Not enough free storage on this phone.' : 'На телефоне недостаточно свободного места.');
                }
            }
            setDriveTransfer({
                operation: 'download',
                label: isEn ? 'Downloading dictionaries' : 'Скачивание словарей из Drive',
                transferred: 0,
                total: expectedSize,
                percent: 0,
                startedAt: Date.now(),
            });
            await invoke('download_db_from_drive', {
                url: `https://www.googleapis.com/drive/v3/files/${info.id}?alt=media`,
                token,
                expectedSize: expectedSize || null,
            });
            await syncDictionaries?.();
            setDriveStatus(isEn ? 'Dictionary restored.' : 'Словарь восстановлен.');
            await refreshDriveOverview(true);
        } catch (error: any) {
            setDriveStatus(error?.message || String(error));
        } finally {
            setDriveBusy(false);
        }
    };

    const transferElapsedSeconds = driveTransfer
        ? Math.max(0.01, (driveClock - driveTransfer.startedAt) / 1000)
        : 0;
    const transferSpeed = driveTransfer ? driveTransfer.transferred / transferElapsedSeconds : 0;
    const transferEta = driveTransfer && transferSpeed > 0 && driveTransfer.total > driveTransfer.transferred
        ? (driveTransfer.total - driveTransfer.transferred) / transferSpeed
        : 0;

    const tabStatusColor = (status?: string) => status === 'reading' ? '#4CAF50' : status === 'paused' ? '#d6a84f' : status === 'completed' ? '#8bdeff' : '#8b8f98';
    const formatTimer = (seconds: number) => {
        const total = Math.max(0, Math.floor(seconds || 0));
        const h = Math.floor(total / 3600);
        const m = Math.floor((total % 3600) / 60);
        const s = total % 60;
        return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
    };
    const sourceState = wsConnected ? 'on' : wsIsConnecting || wsIntentOn ? 'pending' : 'off';
    const openSettingsPage = (section: MobileSettingsSection | null) => {
        if (section) setMobileSettingsSection(section);
        setSettingsHome(!section);
        setIsMobileSettingsOpen(true);
    };
    const settingsGroups: { id: MobileSettingsSection; label: string; hint: string; icon: string; tone: string }[][] = [
        [
            { id: 'source', label: isEn ? 'Text source' : 'Источник текста', hint: wsStatusLabel, icon: '◉', tone: sourceState === 'on' ? '#4caf50' : sourceState === 'pending' ? '#e5a957' : '#e05a5a' },
            { id: 'data', label: isEn ? 'Dictionaries' : 'Словари', hint: `${(settings.dictionaries || []).length} ${isEn ? 'installed' : 'установлено'}`, icon: '字', tone: '#4fa6ff' },
            {
                id: 'drive',
                label: 'Google Drive',
                hint: driveBusy && driveTransfer
                    ? `${driveTransfer.label} · ${Math.round(driveTransfer.percent)}%`
                    : settings.gdriveRefreshToken ? (isEn ? 'Connected' : 'Подключён') : (isEn ? 'Not connected' : 'Не подключён'),
                icon: '☁',
                tone: '#e5a957',
            },
        ],
        [
            { id: 'flow', label: 'Setsuna Flow', hint: settings.mobileOverlayEnabled ? (isEn ? 'Shown over apps' : 'Поверх приложений') : (isEn ? 'Off' : 'Выключен'), icon: '▣', tone: '#8bdeff' },
            { id: 'anki', label: 'AnkiDroid', hint: settings.ankiDeck || (isEn ? 'Not set up' : 'Не настроено'), icon: 'A', tone: '#d7b8ff' },
            { id: 'reading', label: isEn ? 'Appearance' : 'Внешний вид', hint: `${settings.appLanguage === 'en' ? 'English' : 'Русский'} · ${settings.fontSize || 26}px`, icon: 'Aa', tone: '#c8ccd4' },
        ],
        [
            { id: 'feedback', label: isEn ? 'Feedback' : 'Обратная связь', hint: isEn ? 'Bugs and ideas' : 'Ошибки и идеи', icon: '✉', tone: '#c8ccd4' },
        ],
    ];
    const currentPage = settingsGroups.flat().find((item) => item.id === mobileSettingsSection);

    return (
        <div
            className="mobile-shell m-shell"
            onClick={(e) => {
                // Word buttons stop propagation, so any other tap on the reader,
                // island or dock dismisses an open lookup sheet.
                e.stopPropagation();
                if (lookupOpen) onCloseLookup?.();
            }}
        >
            <header className="m-island-row">
                <button type="button" className="m-island" onClick={() => setTabsOpen(true)} aria-label={isEn ? 'Tabs' : 'Вкладки'}>
                    <span className="m-dot" style={{ ['--dot' as any]: tabStatusColor(activeTab?.status) }} aria-hidden="true" />
                    <span key={activeTab?.id} className="m-island-name">{activeTab?.name || t('tabs.defaultName')}</span>
                    <span className="m-island-meta">{(stats.chars || 0).toLocaleString('ru-RU')}</span>
                </button>
                <button
                    type="button"
                    className={`m-source m-source-${sourceState}`}
                    onClick={() => openSettingsPage('source')}
                    aria-label={wsStatusLabel}
                    title={wsStatusLabel}
                >
                    <span className="m-source-dot" aria-hidden="true" />
                </button>
            </header>

            <main className="m-main">
                {lookupNotice && <div className="m-toast" role="status">{lookupNotice}</div>}
                {activeTab?.mode === 'player' ? (
                    <div className="m-empty">
                        <div className="m-empty-icon">▶</div>
                        <strong>{isEn ? 'Video Player (Beta)' : 'Видео-плеер (Бета)'}</strong>
                        <span>{isEn ? 'The mobile video player will come after text, lookup, and Anki are stable.' : 'Мобильный видео-плеер добавим после текста, лукапа и Anki.'}</span>
                    </div>
                ) : activeTab?.mode === 'epub' ? (
                    <EpubWorkspace
                        books={epubBooks}
                        activeBookTab={activeTab}
                        settings={settings}
                        isMobile={true}
                        standaloneMobile={false}
                        onHome={() => setActiveMobileView('text')}
                        onSettings={() => openSettingsPage('reading')}
                        onOpenFile={() => onOpenEpubFile?.()}
                        onSelectBook={(tabId) => (onSelectEpubBook ? onSelectEpubBook(tabId) : switchTab(tabId))}
                        onRemoveBook={(tabId) => onRemoveEpubBook?.(tabId)}
                        onRemoveBooks={(tabIds) => onRemoveEpubBooks?.(tabIds)}
                        onPatchBooks={(tabIds, patch) => onPatchEpubBooks?.(tabIds, patch)}
                        onUpdateBookMeta={(tabId, meta) => onUpdateEpubMeta?.(tabId, meta)}
                        onUpdateMangaMeta={(tabId, meta) => onUpdateMangaMeta?.(tabId, meta)}
                        onMangaScreenshot={onMangaScreenshot}
                        onProgressChange={(tabId, chIdx, offset, prog) => onEpubProgress?.(tabId, chIdx, offset, prog)}
                        onChangeBookOrientation={(tabId, orient) => onEpubOrientationChange?.(tabId, orient)}
                        onChangeBookBookmarks={(tabId, bookmarks) => onEpubBookmarksChange?.(tabId, bookmarks)}
                        onChangeBookHighlights={(tabId, highlights) => onEpubHighlightsChange?.(tabId, highlights)}
                        onChangeBookNotes={(tabId, notes) => onEpubNotesChange?.(tabId, notes)}
                        onChangeReadingPoint={(tabId, point) => onEpubReadingPointChange?.(tabId, point)}
                        onRecordReadingStats={(tabId, chars, secs) => onEpubRecordStats?.(tabId, chars, secs)}
                        onResetStats={onResetEpubStats}
                        onImportBackup={onImportEpubBackup}
                        syncStatus={epubSyncStatus}
                        lastSyncedAt={epubLastSyncedAt}
                        syncError={epubSyncError}
                        downloadingBookId={epubDownloadingBookId}
                        onSyncNow={onEpubSyncNow}
                        onOpenCloudSettings={onOpenCloudSettings}
                        onUpdateSettings={(patch) => updateSettings({ ...settings, ...patch })}
                        onLookupToken={(token: string, sentence: string, cursor: number, boundaries?: number[], lemma?: string) => onLookupSentenceToken?.(token, sentence, cursor, boundaries, lemma)}
                    />
                ) : activeTab?.lines?.length ? (
                    <TextContainer
                        contentKey={activeTab?.id ?? activeTabId}
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
                        onLookupToken={(token: string, sentence: string, cursor: number, boundaries?: number[], lemma?: string) => onLookupSentenceToken?.(token, sentence, cursor, boundaries, lemma)}
                    />
                ) : (
                    <div className="m-empty">
                        <div className="m-empty-icon">刹</div>
                        <strong>{isEn ? 'Waiting for text' : 'Ждём текст'}</strong>
                        <span>{isEn ? 'Connect a source, share text to Setsuna or type it in.' : 'Подключи источник, отправь текст через «Поделиться» или введи его.'}</span>
                        <div className="m-empty-actions">
                            <button type="button" className="m-pill-button primary" onClick={() => openSettingsPage('source')}>{isEn ? 'Connect source' : 'Подключить источник'}</button>
                            <button type="button" className="m-pill-button" onClick={() => setActiveMobileView('lookup')}>{isEn ? 'Type text' : 'Ввести текст'}</button>
                        </div>
                    </div>
                )}
            </main>

            <nav className="m-dock" aria-label={isEn ? 'Reader controls' : 'Управление чтением'}>
                <button
                    type="button"
                    className={`m-dock-timer${isPaused ? '' : ' is-running'}`}
                    onClick={() => setIsPaused(!isPaused)}
                    aria-label={isPaused ? (isEn ? 'Start timer' : 'Запустить таймер') : (isEn ? 'Pause timer' : 'Пауза')}
                >
                    <span aria-hidden="true">{isPaused ? '▶' : 'Ⅱ'}</span>
                    {formatTimer(stats.time)}
                </button>
                <button type="button" className="m-dock-btn" onClick={() => setTabsOpen(true)} aria-label={isEn ? 'Tabs' : 'Вкладки'}>
                    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true"><rect x="4" y="5" width="16" height="15" rx="3" /><path d="M4 10h16" /></svg>
                    {visibleTabs.length > 1 && <span className="m-badge">{visibleTabs.length}</span>}
                </button>
                <button type="button" className={`m-dock-btn${activeMobileView === 'lookup' ? ' is-active' : ''}`} onClick={() => setActiveMobileView(activeMobileView === 'lookup' ? 'text' : 'lookup')} aria-label={isEn ? 'Type or look up text' : 'Ввод и поиск'}>
                    <IconSearch />
                </button>
                <button type="button" className={`m-dock-btn${settings.mobileOverlayEnabled ? ' is-active' : ''}`} onClick={toggleMobileFlow} aria-label="Setsuna Flow">
                    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" aria-hidden="true"><rect x="3" y="4" width="13" height="10" rx="2.5" /><rect x="8" y="10" width="13" height="10" rx="2.5" /></svg>
                </button>
                <button type="button" className="m-dock-btn" onClick={() => openSettingsPage(null)} aria-label={isEn ? 'Settings' : 'Настройки'}>
                    <IconSettings />
                </button>
            </nav>

            {tabsPresence.mounted && (
                <div className={`m-scrim${tabsPresence.closing ? ' is-closing' : ''}`} onClickCapture={swallowGhostTap} onClick={() => setTabsOpen(false)}>
                    <section className="m-sheet" onClick={(e) => e.stopPropagation()} aria-label={isEn ? 'Tabs' : 'Вкладки'}>
                        <div className="m-grabber" />
                        <div className="m-sheet-head">
                            <h2>{isEn ? 'Tabs' : 'Вкладки'}</h2>
                            <button type="button" className="m-round-btn" onClick={() => setTabsOpen(false)} aria-label={isEn ? 'Close' : 'Закрыть'}>×</button>
                        </div>
                        <div className="m-tab-list">
                            {visibleTabs.map((tab: Tab, index: number) => (
                                <div key={tab.id} className={`m-tab-row${tab.id === activeTabId ? ' is-active' : ''}`} style={{ ['--i' as any]: Math.min(index, 10) }}>
                                    <button type="button" className="m-tab-main" onClick={() => { switchTab(tab.id); setTabsOpen(false); }}>
                                        <span className="m-dot" style={{ ['--dot' as any]: tabStatusColor(tab.status) }} aria-hidden="true" />
                                        <span className="m-tab-name">{tab.name || t('tabs.defaultName')}</span>
                                        <span className="m-tab-meta">{(tab.stats?.chars || 0).toLocaleString('ru-RU')}</span>
                                    </button>
                                    {visibleTabs.length > 1 && (
                                        <button type="button" className="m-tab-close" aria-label={isEn ? 'Close' : 'Закрыть'} onClick={() => closeTab(tab.id)}>×</button>
                                    )}
                                </div>
                            ))}
                        </div>
                        <div className="m-sheet-actions">
                            <button type="button" className="m-pill-button primary m-wide" onClick={() => { addNewTab(); setTabsOpen(false); }}>＋ {isEn ? 'New tab' : 'Новая вкладка'}</button>
                            <button type="button" className="m-pill-button" onClick={() => { setTabsOpen(false); setActiveMobileView('lookup'); }}>✎ {isEn ? 'Type text' : 'Ввести текст'}</button>
                            <button type="button" className="m-pill-button" onClick={() => { setTabsOpen(false); setIsStatsOpen(true); }}>⏱ {isEn ? 'Statistics' : 'Статистика'}</button>
                            <button type="button" className="m-pill-button danger" onClick={() => { clearAll(); setTabsOpen(false); }}>{isEn ? 'Clear tab' : 'Очистить вкладку'}</button>
                        </div>
                    </section>
                </div>
            )}

            {inputPresence.mounted && (
                <div className={`m-scrim${inputPresence.closing ? ' is-closing' : ''}`} onClickCapture={swallowGhostTap} onClick={() => setActiveMobileView('text')}>
                    <section className="m-sheet m-input-sheet" onClick={(e) => e.stopPropagation()} aria-label={isEn ? 'Type text' : 'Ввод текста'}>
                        <div className="m-grabber" />
                        <div className="m-sheet-head">
                            <h2>{isEn ? 'Text and lookup' : 'Текст и лукап'}</h2>
                            <button type="button" className="m-round-btn" onClick={() => setActiveMobileView('text')} aria-label={isEn ? 'Close' : 'Закрыть'}>×</button>
                        </div>
                        <textarea
                            value={lookupText}
                            onChange={(e) => setLookupText(e.target.value)}
                            className="m-textarea"
                            placeholder={isEn ? 'Paste a sentence or type a word…' : 'Вставь предложение или введи слово…'}
                            rows={3}
                        />
                        <div className="m-token-panel">
                            <MobileSentenceTokens
                                text={lookupText}
                                onLookup={lookupTypedToken}
                                placeholder={isEn ? 'Words become tappable here.' : 'Здесь слова станут кликабельными.'}
                            />
                        </div>
                        <div className="m-sheet-actions">
                            <button type="button" className="m-pill-button primary" onClick={() => lookupText.trim() && onLookupText(lookupText.trim())}>
                                <IconSearch /> {isEn ? 'Look up' : 'Найти'}
                            </button>
                            <button type="button" className="m-pill-button" onClick={() => { submitDraft(); setActiveMobileView('text'); }}>{isEn ? 'Add to tab' : 'В текст вкладки'}</button>
                            <button type="button" className="m-pill-button" onClick={() => setLookupText('')}>{isEn ? 'Clear' : 'Очистить'}</button>
                        </div>
                    </section>
                </div>
            )}

            {statsPresence.mounted && (
                <div className={`m-scrim${statsPresence.closing ? ' is-closing' : ''}`} onClickCapture={swallowGhostTap} onClick={() => setIsStatsOpen(false)}>
                    <section className="m-sheet" onClick={(e) => e.stopPropagation()} aria-label={isEn ? 'Statistics' : 'Статистика'}>
                        <div className="m-grabber" />
                        <div className="m-sheet-head">
                            <h2>{isEn ? 'Session' : 'Сессия'}</h2>
                            <button type="button" className="m-round-btn" onClick={() => setIsStatsOpen(false)} aria-label={isEn ? 'Close' : 'Закрыть'}>×</button>
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
                            tabId={activeTab?.id ?? null}
                            tabName={activeTab?.name || ''}
                        />
                    </section>
                </div>
            )}

            {settingsPresence.mounted && (
                <div className={`m-page${settingsPresence.closing ? ' is-closing' : ''}`} onClickCapture={swallowGhostTap} onClick={(e) => e.stopPropagation()}>
                    {settingsHome ? (
                        <div className="m-page-inner" key="home">
                            <header className="m-page-head">
                                <div>
                                    <p className="m-eyebrow">SETSUNA</p>
                                    <h1>{isEn ? 'Settings' : 'Настройки'}</h1>
                                </div>
                                <button type="button" className="m-round-btn" onClick={closeMobileSettings} aria-label={isEn ? 'Close settings' : 'Закрыть настройки'}>×</button>
                            </header>
                            {driveBusy && driveTransfer && (
                                <button type="button" className="m-card m-transfer-card" onClick={() => openSettingsPage('drive')}>
                                    <span className="m-transfer-label">{driveTransfer.label}</span>
                                    <span className="m-progress"><span style={{ width: `${Math.max(0, Math.min(100, driveTransfer.percent))}%` }} /></span>
                                    <span className="m-transfer-meta">{Math.round(driveTransfer.percent)}% · {formatMobileBytes(driveTransfer.transferred)} / {driveTransfer.total ? formatMobileBytes(driveTransfer.total) : '—'}</span>
                                </button>
                            )}
                            {settingsGroups.map((group, groupIndex) => (
                                <div key={groupIndex} className="m-card m-list" style={{ ['--i' as any]: groupIndex }}>
                                    {group.map((item) => (
                                        <button key={item.id} type="button" className="m-list-row" onClick={() => openSettingsPage(item.id)}>
                                            <span className="m-list-icon" style={{ ['--tone' as any]: item.tone }} aria-hidden="true">{item.icon}</span>
                                            <span className="m-list-text">
                                                <strong>{item.label}</strong>
                                                <small>{item.hint}</small>
                                            </span>
                                            <span className="m-chevron" aria-hidden="true">›</span>
                                        </button>
                                    ))}
                                </div>
                            ))}
                        </div>
                    ) : (
                        <div className="m-page-inner m-subpage" key={mobileSettingsSection}>
                            <header className="m-page-head">
                                <button type="button" className="m-back" onClick={() => setSettingsHome(true)}>
                                    <span aria-hidden="true">‹</span> {isEn ? 'Settings' : 'Настройки'}
                                </button>
                                <button type="button" className="m-round-btn" onClick={closeMobileSettings} aria-label={isEn ? 'Close settings' : 'Закрыть настройки'}>×</button>
                            </header>
                            <h1 className="m-page-title">{currentPage?.label || (isEn ? 'Settings' : 'Настройки')}</h1>
                            <div className="mobile-settings-sheet m-section">
                        {mobileSettingsSection === 'reading' && <div className="mobile-settings-section">
                            <div className="mobile-section-title">{isEn ? 'Interface' : 'Интерфейс'}</div>
                            <label className="mobile-setting-row">
                                <span>{isEn ? 'Language' : 'Язык'}</span>
                                <select value={settings.appLanguage || 'ru'} onChange={(e) => updateSetting('appLanguage', e.target.value)}>
                                    <option value="ru">Русский</option>
                                    <option value="en">English</option>
                                </select>
                            </label>
                            <div className="mobile-settings-note">
                                <strong style={{ color: '#f59e0b', marginRight: 6 }}>{isEn ? 'ALPHA' : 'АЛЬФА'}</strong>
                                {isEn
                                    ? 'Primary target learning language: Japanese. English as a target learning language is early alpha.'
                                    : 'Основной язык изучения: японский. Поддержка английского как целевого языка изучения — ранняя альфа.'}
                            </div>
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
                        </div>}

                        {mobileSettingsSection === 'flow' && <div className="mobile-settings-section mobile-flow-settings">
                            <div className="mobile-section-title">Setsuna Flow</div>
                            <div className="mobile-settings-note">
                                {isEn
                                    ? 'The latest hooked line over any app. Expand the toolbar for controls, tap a word to look it up, or lock the window in place.'
                                    : 'Последняя пойманная строка поверх любого приложения. Разверни панель для управления, нажми слово для лукапа или закрепи окно на месте.'}
                            </div>
                            <div className="mobile-overlay-card">
                                <div>
                                    <strong>{isEn ? 'Show over other apps' : 'Показывать поверх приложений'}</strong>
                                    <span>{isEn ? 'The arrow in Flow returns to Setsuna.' : 'Стрелка в окне Flow возвращает в Setsuna.'}</span>
                                </div>
                                <label className="mobile-overlay-toggle">
                                    <input
                                        type="checkbox"
                                        checked={settings.mobileOverlayEnabled === true}
                                        onChange={toggleMobileFlow}
                                    />
                                    <span />
                                </label>
                            </div>
                            <div className="mobile-settings-actions two">
                                <button type="button" className="mobile-action" onClick={() => {
                                    try {
                                        requestMobileOverlayPermission();
                                        setOverlayStatus(isEn ? 'Allow the permission, then return here.' : 'Разреши доступ и вернись сюда.');
                                    } catch (error: any) { setOverlayStatus(error?.message || String(error)); }
                                }}>
                                    {isEn ? 'Allow overlay' : 'Разрешить доступ'}
                                </button>
                                <button type="button" className="mobile-action" onClick={refreshOverlayStatus}>
                                    {isEn ? 'Check permission' : 'Проверить доступ'}
                                </button>
                            </div>
                            <label className="mobile-setting-row mobile-setting-range">
                                <span>{isEn ? 'Window width' : 'Ширина окна'} <b>{settings.mobileOverlayWidth ?? 320}</b></span>
                                <input type="range" min="220" max="480" step="10" value={settings.mobileOverlayWidth ?? 320} onChange={(event) => updateSetting('mobileOverlayWidth', Number(event.target.value))} />
                            </label>
                            <label className="mobile-setting-row mobile-setting-range">
                                <span>{isEn ? 'Window height' : 'Высота окна'} <b>{settings.mobileOverlayHeight ?? 160}</b></span>
                                <input type="range" min="110" max="320" step="10" value={settings.mobileOverlayHeight ?? 160} onChange={(event) => updateSetting('mobileOverlayHeight', Number(event.target.value))} />
                            </label>
                            <label className="mobile-setting-row mobile-setting-range">
                                <span>{isEn ? 'Text size' : 'Размер текста'} <b>{settings.mobileOverlayFontSize ?? 22}</b></span>
                                <input type="range" min="12" max="48" value={settings.mobileOverlayFontSize ?? 22} onChange={(event) => updateSetting('mobileOverlayFontSize', Number(event.target.value))} />
                            </label>
                            <label className="mobile-setting-row">
                                <span>{isEn ? 'Font' : 'Шрифт'}</span>
                                <select value={settings.mobileOverlayFontFamily || 'serif'} onChange={(event) => updateSetting('mobileOverlayFontFamily', event.target.value)}>
                                    <option value="serif">{isEn ? 'Serif' : 'С засечками'}</option>
                                    <option value="sans">{isEn ? 'Sans serif' : 'Без засечек'}</option>
                                    <option value="monospace">{isEn ? 'Monospace' : 'Моноширинный'}</option>
                                </select>
                            </label>
                            <label className="mobile-setting-row mobile-setting-range">
                                <span>{isEn ? 'Line spacing' : 'Межстрочный интервал'} <b>{(settings.mobileOverlayLineHeight ?? 1.2).toFixed(2)}</b></span>
                                <input type="range" min="1" max="1.8" step="0.05" value={settings.mobileOverlayLineHeight ?? 1.2} onChange={(event) => updateSetting('mobileOverlayLineHeight', Number(event.target.value))} />
                            </label>
                            <label className="mobile-setting-row mobile-setting-range">
                                <span>{isEn ? 'Inner padding' : 'Отступ текста'} <b>{settings.mobileOverlayPadding ?? 12}</b></span>
                                <input type="range" min="6" max="28" step="1" value={settings.mobileOverlayPadding ?? 12} onChange={(event) => updateSetting('mobileOverlayPadding', Number(event.target.value))} />
                            </label>
                            <label className="mobile-setting-row mobile-setting-range">
                                <span>{isEn ? 'Background opacity' : 'Прозрачность фона'} <b>{settings.mobileOverlayOpacity ?? 88}%</b></span>
                                <input type="range" min="20" max="100" value={settings.mobileOverlayOpacity ?? 88} onChange={(event) => updateSetting('mobileOverlayOpacity', Number(event.target.value))} />
                            </label>
                            <div className="mobile-color-row">
                                <label><span>{isEn ? 'Font color' : 'Цвет шрифта'}</span><input type="color" value={settings.mobileOverlayTextColor || '#ffffff'} onChange={(event) => updateSetting('mobileOverlayTextColor', event.target.value)} /></label>
                                <label><span>{isEn ? 'Background' : 'Фон'}</span><input type="color" value={settings.mobileOverlayBackgroundColor || '#15181d'} onChange={(event) => updateSetting('mobileOverlayBackgroundColor', event.target.value)} /></label>
                                <label><span>{isEn ? 'Border' : 'Рамка'}</span><input type="color" value={settings.mobileOverlayBorderColor || '#56606d'} onChange={(event) => updateSetting('mobileOverlayBorderColor', event.target.value)} /></label>
                            </div>
                            <label className="mobile-setting-row mobile-setting-range">
                                <span>{isEn ? 'Lookup height' : 'Высота лукапа'} <b>{settings.mobileOverlayLookupHeight ?? 220}</b></span>
                                <input type="range" min="150" max="280" step="10" value={settings.mobileOverlayLookupHeight ?? 220} onChange={(event) => updateSetting('mobileOverlayLookupHeight', Number(event.target.value))} />
                            </label>
                            <label className="mobile-setting-row">
                                <span>{isEn ? 'Lock position and size' : 'Зафиксировать положение и размер'}</span>
                                <input type="checkbox" checked={settings.mobileOverlayLocked === true} onChange={(event) => updateSetting('mobileOverlayLocked', event.target.checked)} />
                            </label>
                            <label className="mobile-setting-row">
                                <span>{isEn ? 'Toolbar expanded by default' : 'Панель развёрнута по умолчанию'}</span>
                                <input type="checkbox" checked={settings.mobileOverlayToolbarExpanded === true} onChange={(event) => updateSetting('mobileOverlayToolbarExpanded', event.target.checked)} />
                            </label>
                            {overlayStatus && <div className="mobile-drive-status">{overlayStatus}</div>}
                        </div>}

                        {mobileSettingsSection === 'source' && <div className="mobile-settings-section">
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
                        </div>}

                        {mobileSettingsSection === 'anki' && <div className="mobile-settings-section">
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
                                        const permission = await requestAnkiDroidPermission()
                                            .catch((error) => {
                                                setAnkiStatusText(error?.message || String(error));
                                                return null;
                                            });
                                        if (!permission?.permissionGranted) {
                                            setAnkiStatusText(isEn
                                                ? 'Allow the Android permission, then tap Refresh.'
                                                : 'Подтверди Android-разрешение, затем нажми «Обновить».');
                                            return;
                                        }
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
                                <span>{isEn ? 'Default deck' : 'Колода по умолчанию'}</span>
                                <select value={settings.ankiDeck || ''} onChange={(e) => updateSetting('ankiDeck', e.target.value)}>
                                    <option value="">{isEn ? 'Not selected' : 'Не выбрано'}</option>
                                    {ankiDecks.map((deck) => <option key={deck} value={deck}>{deck}</option>)}
                                </select>
                            </label>
                            <label className="mobile-setting-row mobile-window-deck-row">
                                <span>
                                    {isEn ? 'This window' : 'Это окно'}
                                    <small>{activeTab?.name || (isEn ? 'Current window' : 'Текущее окно')}</small>
                                </span>
                                <select value={activeTab?.ankiDeck || ''} onChange={(e) => updateActiveTabDeck(e.target.value)}>
                                    <option value="">{isEn ? `Use default: ${settings.ankiDeck || 'not selected'}` : `Как по умолчанию: ${settings.ankiDeck || 'не выбрано'}`}</option>
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
                        </div>}

                        {mobileSettingsSection === 'drive' && <div className="mobile-settings-section">
                            <div className="mobile-section-title">{isEn ? 'Cloud backup' : 'Облачные копии'}</div>
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
                                    <div className="mobile-drive-account">
                                        <span className="mobile-drive-account-dot" />
                                        <div>
                                            <strong>{isEn ? 'Drive connected' : 'Drive подключён'}</strong>
                                            <span>{isEn ? 'Compatible with desktop Setsuna backups' : 'Совместим с резервными копиями Setsuna на ПК'}</span>
                                        </div>
                                        <button type="button" className="mobile-icon-btn tiny" disabled={driveBusy} onClick={() => void refreshDriveOverview()} aria-label={isEn ? 'Refresh Drive' : 'Обновить Drive'}>↻</button>
                                    </div>

                                    {driveTransfer && (
                                        <div className={`mobile-drive-transfer ${driveBusy ? 'active' : 'done'}`} role="status" aria-live="polite">
                                            <div className="mobile-drive-transfer-head">
                                                <strong>{driveTransfer.label}</strong>
                                                <span>{Math.max(0, Math.min(100, Math.round(driveTransfer.percent)))}%</span>
                                            </div>
                                            <div className="mobile-drive-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(driveTransfer.percent)}>
                                                <span style={{ width: `${Math.max(0, Math.min(100, driveTransfer.percent))}%` }} />
                                            </div>
                                            <div className="mobile-drive-transfer-meta">
                                                <span>{formatMobileBytes(driveTransfer.transferred)} / {driveTransfer.total ? formatMobileBytes(driveTransfer.total) : '—'}</span>
                                                <span>{driveBusy && transferSpeed > 0 ? `${formatMobileBytes(transferSpeed)}/s` : (isEn ? 'Finished' : 'Готово')}</span>
                                                <span>{driveBusy && transferEta > 0
                                                    ? `${isEn ? 'left' : 'осталось'} ${formatMobileDuration(transferEta)}`
                                                    : `${isEn ? 'elapsed' : 'прошло'} ${formatMobileDuration(transferElapsedSeconds)}`}</span>
                                            </div>
                                        </div>
                                    )}

                                    <section className="mobile-drive-block">
                                        <div className="mobile-drive-block-head">
                                            <div>
                                                <strong>{isEn ? 'Setsuna backup' : 'Копия Setsuna'}</strong>
                                                <span>{isEn ? 'Windows, text, timers and settings' : 'Окна, текст, таймеры и настройки'}</span>
                                            </div>
                                            <span className="mobile-drive-size">{driveBackups[0] ? formatMobileBytes(driveBackups[0].size) : '—'}</span>
                                        </div>
                                        <div className="mobile-drive-last-backup">
                                            {driveBackups[0]?.modifiedTime
                                                ? `${isEn ? 'Latest' : 'Последняя'}: ${new Date(driveBackups[0].modifiedTime).toLocaleString(isEn ? 'en-US' : 'ru-RU')}`
                                                : (isEn ? 'No backup has been created yet' : 'Резервных копий пока нет')}
                                        </div>
                                        <div className="mobile-settings-actions two compact">
                                            <button className="mobile-action primary" disabled={driveBusy} onClick={uploadMobileBackup}>
                                                {isEn ? 'Create backup' : 'Создать копию'}
                                            </button>
                                            <button className="mobile-action" disabled={driveBusy || !driveBackups.length} onClick={() => restoreMobileBackup()}>
                                                {isEn ? 'Restore latest' : 'Восстановить последнюю'}
                                            </button>
                                        </div>
                                    </section>

                                    <section className="mobile-drive-block">
                                        <div className="mobile-drive-block-head">
                                            <div>
                                                <strong>{isEn ? 'Dictionary database' : 'База словарей'}</strong>
                                                <span>{isEn ? 'All imported Yomitan dictionaries' : 'Все импортированные словари Yomitan'}</span>
                                            </div>
                                            <span className="mobile-drive-size">{formatMobileBytes(localDictionary?.size)}</span>
                                        </div>
                                        <div className="mobile-drive-storage-grid">
                                            <div>
                                                <span>{isEn ? 'On phone' : 'На телефоне'}</span>
                                                <strong>{formatMobileBytes(localDictionary?.size)}</strong>
                                            </div>
                                            <div>
                                                <span>{isEn ? 'In Drive' : 'В Drive'}</span>
                                                <strong>{driveDictionary ? formatMobileBytes(driveDictionary.size) : (isEn ? 'Not saved' : 'Не сохранено')}</strong>
                                            </div>
                                            <div>
                                                <span>{isEn ? 'Phone free' : 'Свободно на телефоне'}</span>
                                                <strong>{localDictionary?.availableBytes != null ? formatMobileBytes(localDictionary.availableBytes) : '—'}</strong>
                                            </div>
                                            <div>
                                                <span>{isEn ? 'Drive free' : 'Свободно в Drive'}</span>
                                                <strong>{driveQuota?.unlimited
                                                    ? (isEn ? 'Unlimited' : 'Без лимита')
                                                    : driveQuota ? formatMobileBytes(bytesAvailableInDrive(driveQuota)) : '—'}</strong>
                                            </div>
                                        </div>
                                        <div className="mobile-drive-warning">
                                            {isEn
                                                ? 'Dictionaries may take several gigabytes. Setsuna checks free space before upload and restore. Wi-Fi is recommended.'
                                                : 'Словари могут занимать несколько гигабайт. Перед загрузкой Setsuna проверит свободное место. Рекомендуется Wi-Fi.'}
                                        </div>
                                        <div className="mobile-settings-actions two compact">
                                            <button className="mobile-action" disabled={driveBusy || !localDictionary?.size} onClick={uploadMobileDictionary}>
                                                {isEn ? 'Upload database' : 'Загрузить базу в Drive'}
                                            </button>
                                            <button className="mobile-action" disabled={driveBusy || !driveDictionary} onClick={restoreMobileDictionary}>
                                                {isEn ? 'Replace phone database' : 'Заменить базу на телефоне'}
                                            </button>
                                        </div>
                                    </section>

                                    <div className={`mobile-backup-list ${isDriveArchiveOpen ? 'open' : ''}`}>
                                        <button type="button" className="mobile-backup-list-head" onClick={() => setIsDriveArchiveOpen((open) => !open)} aria-expanded={isDriveArchiveOpen}>
                                            <span className="mobile-backup-list-title">
                                                <strong>{isEn ? 'Backup archive' : 'Архив копий'}</strong>
                                                <small>{driveBackups.length} {isEn ? 'saved' : 'сохранено'}</small>
                                            </span>
                                            {isDriveArchiveOpen ? <IconChevronUp /> : <IconChevronDown />}
                                        </button>
                                        {isDriveArchiveOpen && (
                                            <div className="mobile-backup-list-body">
                                                {driveBackups.length === 0 ? (
                                                    <div className="mobile-settings-note">{isEn ? 'No cloud backups yet.' : 'В облаке пока нет копий.'}</div>
                                                ) : driveBackups.map((backup) => (
                                                    <div key={backup.id} className="mobile-backup-row">
                                                        <div>
                                                            <strong>{backup.modifiedTime ? new Date(backup.modifiedTime).toLocaleString(isEn ? 'en-US' : 'ru-RU') : backup.name}</strong>
                                                            <span>{formatMobileBytes(backup.size)}</span>
                                                        </div>
                                                        <div className="mobile-backup-actions">
                                                            <button type="button" disabled={driveBusy} onClick={() => restoreMobileBackup(backup)}>{isEn ? 'Restore' : 'Восстановить'}</button>
                                                            <button type="button" disabled={driveBusy} className="danger" onClick={() => deleteMobileBackup(backup)} aria-label={isEn ? 'Delete backup' : 'Удалить бэкап'}>×</button>
                                                        </div>
                                                    </div>
                                                ))}
                                            </div>
                                        )}
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
                        </div>}

                        {mobileSettingsSection === 'feedback' && <div className="mobile-settings-section mobile-feedback-section">
                            <SettingsFeedback english={isEn} />
                        </div>}

                        {mobileSettingsSection === 'data' && <div className="mobile-settings-section">
                            <div className="mobile-section-title">{isEn ? 'Data' : 'Данные'}</div>
                            <SettingsLookup dictionariesOnly settings={settings} updateSetting={updateSetting} highlightedSection={null} isOpen={true} syncDictionaries={syncDictionaries} runDictImport={runDictImport} setConfirmDialog={setConfirmDialog} />
                            <div className="mobile-settings-note mobile-starter-dicts-note">
                                {isEn
                                    ? 'Import dictionaries or dictionary.db from PC. Enable and order dictionaries below.'
                                    : 'Импортируй словари или dictionary.db с ПК. Ниже можно включать словари, менять порядок и устанавливать обновления.'}
                            </div>
                            <div className="mobile-settings-actions">
                                <button className="mobile-action" onClick={openMobileDictionaryImport}><IconImport /> {isEn ? 'Import dictionary' : 'Импорт словаря'}</button>
                                <button className="mobile-action danger" onClick={clearAll}><IconClear /> {isEn ? 'Clear current text' : 'Очистить текст'}</button>
                            </div>
                        </div>}
                            </div>
                        </div>
                    )}
                </div>
            )}
        </div>
    );
};

