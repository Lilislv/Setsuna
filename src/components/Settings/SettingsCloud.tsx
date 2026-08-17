import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getVersion } from '@tauri-apps/api/app';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { openUrl } from '@tauri-apps/plugin-opener';
import {
    bytesAvailableInDrive,
    createDictFileMetadata,
    createGooglePkceSession,
    deleteDriveFile,
    deleteStoredGoogleRefreshToken,
    downloadFromDrive,
    exchangeCodeForToken,
    getAccessToken,
    getAuthUrl,
    getDictDriveInfo,
    getDriveQuota,
    hasDriveSpace,
    listBackups,
    loadStoredGoogleRefreshToken,
    startDictionaryResumableUpload,
    storeGoogleRefreshToken,
    uploadToDrive,
    type DriveFileInfo,
    type DriveQuotaInfo,
    type GooglePkceSession,
} from '../../utils/gdrive';
import type { AppSettings } from '../SettingsModal';
import './SettingsCloud.css';

interface SettingsCloudProps {
    settings: AppSettings;
    updateSetting: <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => void;
    onSettingsChange: (newSettings: AppSettings) => void;
    tabs: any[];
    setTabs: (tabs: any[]) => void;
    syncDictionaries: () => Promise<void>;
    highlightedSection: string | null;
    isOpen: boolean;
}

interface OAuthServerStart {
    port: number;
    redirect_uri: string;
    reused: boolean;
}

interface DictionaryStorageInfo {
    path: string;
    size: number;
    availableBytes: number | null;
}

interface DriveTransferProgress {
    operation: 'upload' | 'download';
    transferred: number;
    total: number;
    percent: number;
}

const text = {
    ru: {
        privateStorage: 'Приватные резервные копии Setsuna',
        privateHint: 'Данные хранятся в скрытой папке приложения. Setsuna не видит остальные файлы Google Drive.',
        connected: 'Google Drive подключён',
        disconnected: 'Google Drive не подключён',
        connect: 'Подключить Google Drive',
        disconnect: 'Отключить',
        opening: 'Открываю Google…',
        waiting: 'Завершите вход в браузере. Setsuna подключится автоматически.',
        fallback: 'Вход не вернулся в приложение',
        fallbackHint: 'Вставьте полный адрес страницы после входа.',
        finish: 'Завершить вход',
        quota: 'Место в Google Drive',
        unlimited: 'Без ограничения',
        available: 'свободно',
        used: 'занято',
        refresh: 'Обновить данные',
        backupTitle: 'Новый бэкап',
        backupHint: 'Сохраните настройки и выбранные вкладки. Старые бэкапы останутся в архиве.',
        settings: 'Общие настройки',
        tabs: 'Вкладки',
        createBackup: 'Создать бэкап',
        archive: 'Архив бэкапов',
        archiveHint: 'Показаны все найденные бэкапы, включая созданные старыми версиями Setsuna.',
        noBackups: 'Бэкапов пока нет.',
        inspect: 'Открыть',
        delete: 'Удалить',
        restore: 'Восстановить выбранное',
        close: 'Закрыть',
        legacy: 'Старый формат',
        dictionary: 'База словарей',
        dictionaryWarning: 'Словари могут занимать несколько гигабайт. Загрузка расходует место Google Drive и интернет-трафик.',
        acknowledge: 'Я проверил размер и свободное место',
        local: 'На компьютере',
        cloud: 'В облаке',
        uploadDictionary: 'Загрузить в Drive',
        restoreDictionary: 'Скачать и применить',
        notFound: 'не найдена',
        selectedTabs: (count: number) => `Выбрано вкладок: ${count}`,
        statusReady: 'Данные Drive обновлены.',
        statusBackupCreated: 'Бэкап добавлен в архив.',
        statusRestored: 'Выбранные данные восстановлены.',
        statusDeleted: 'Бэкап удалён.',
        notEnoughCloud: 'В Google Drive недостаточно свободного места для этой операции.',
        notEnoughLocal: 'На компьютере недостаточно свободного места для восстановления базы.',
        confirmDelete: 'Удалить этот бэкап без возможности восстановления?',
    },
    en: {
        privateStorage: 'Private Setsuna backups',
        privateHint: 'Data is stored in the hidden app folder. Setsuna cannot access your other Google Drive files.',
        connected: 'Google Drive connected',
        disconnected: 'Google Drive is not connected',
        connect: 'Connect Google Drive',
        disconnect: 'Disconnect',
        opening: 'Opening Google…',
        waiting: 'Finish signing in in the browser. Setsuna will connect automatically.',
        fallback: 'Sign-in did not return to the app',
        fallbackHint: 'Paste the full page address shown after signing in.',
        finish: 'Finish sign-in',
        quota: 'Google Drive storage',
        unlimited: 'Unlimited',
        available: 'available',
        used: 'used',
        refresh: 'Refresh data',
        backupTitle: 'New backup',
        backupHint: 'Save settings and selected tabs. Existing backups remain in the archive.',
        settings: 'App settings',
        tabs: 'Tabs',
        createBackup: 'Create backup',
        archive: 'Backup archive',
        archiveHint: 'Every Setsuna backup is listed, including backups made by older versions.',
        noBackups: 'No backups yet.',
        inspect: 'Open',
        delete: 'Delete',
        restore: 'Restore selected',
        close: 'Close',
        legacy: 'Legacy format',
        dictionary: 'Dictionary database',
        dictionaryWarning: 'Dictionaries can use several gigabytes. Uploading consumes Google Drive storage and network traffic.',
        acknowledge: 'I checked the size and available storage',
        local: 'On this computer',
        cloud: 'In the cloud',
        uploadDictionary: 'Upload to Drive',
        restoreDictionary: 'Download and apply',
        notFound: 'not found',
        selectedTabs: (count: number) => `${count} tabs selected`,
        statusReady: 'Drive data refreshed.',
        statusBackupCreated: 'Backup added to the archive.',
        statusRestored: 'Selected data restored.',
        statusDeleted: 'Backup deleted.',
        notEnoughCloud: 'Google Drive does not have enough free storage for this operation.',
        notEnoughLocal: 'This computer does not have enough free space to restore the database.',
        confirmDelete: 'Permanently delete this backup?',
    },
};

const formatBytes = (value?: number | string | null) => {
    if (value == null || !Number.isFinite(Number(value))) return '—';
    const bytes = Number(value);
    if (bytes <= 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const index = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
    return `${(bytes / 1024 ** index).toFixed(index > 1 ? 1 : 0)} ${units[index]}`;
};

const stripLocalTabFields = (tab: any) => {
    const clean = structuredClone(tab);
    delete clean.captureSource;
    return clean;
};

const stripCloudSettingsFields = (settings: AppSettings) => {
    const clean = structuredClone(settings);
    delete clean.gdriveRefreshToken;
    return clean;
};

export default function SettingsCloud({
    settings,
    updateSetting,
    onSettingsChange,
    tabs,
    setTabs,
    syncDictionaries,
    highlightedSection,
    isOpen,
}: SettingsCloudProps) {
    const t = text[settings.appLanguage === 'en' ? 'en' : 'ru'];
    const [refreshToken, setRefreshToken] = useState('');
    const [initializing, setInitializing] = useState(true);
    const [busy, setBusy] = useState(false);
    const [status, setStatus] = useState('');
    const [authUrl, setAuthUrl] = useState('');
    const [authRedirectUri, setAuthRedirectUri] = useState('');
    const [manualCallback, setManualCallback] = useState('');
    const pkceRef = useRef<GooglePkceSession | null>(null);
    const redirectRef = useRef('');
    const [quota, setQuota] = useState<DriveQuotaInfo | null>(null);
    const [backups, setBackups] = useState<DriveFileInfo[]>([]);
    const [dictionaryCloud, setDictionaryCloud] = useState<DriveFileInfo | null>(null);
    const [dictionaryLocal, setDictionaryLocal] = useState<DictionaryStorageInfo | null>(null);
    const [dictionaryAcknowledged, setDictionaryAcknowledged] = useState(false);
    const [transfer, setTransfer] = useState<DriveTransferProgress | null>(null);
    const [includeSettings, setIncludeSettings] = useState(true);
    const [selectedTabs, setSelectedTabs] = useState<Record<string, boolean>>({});
    const [openedBackup, setOpenedBackup] = useState<any | null>(null);
    const [openedBackupFile, setOpenedBackupFile] = useState<DriveFileInfo | null>(null);
    const [restoreSettings, setRestoreSettings] = useState(false);
    const [restoreTabs, setRestoreTabs] = useState<Record<string, boolean>>({});

    useEffect(() => {
        setSelectedTabs((previous) => {
            const next = { ...previous };
            tabs.forEach((tab) => { if (next[String(tab.id)] == null) next[String(tab.id)] = true; });
            return next;
        });
    }, [tabs]);

    useEffect(() => {
        if (!isOpen) return;
        let cancelled = false;
        const initialize = async () => {
            setInitializing(true);
            try {
                let token = await loadStoredGoogleRefreshToken();
                if (!token && settings.gdriveRefreshToken) {
                    await storeGoogleRefreshToken(settings.gdriveRefreshToken);
                    token = settings.gdriveRefreshToken;
                    updateSetting('gdriveRefreshToken', '');
                }
                if (!cancelled) setRefreshToken(token || '');
            } catch (error: any) {
                if (!cancelled) setStatus(error?.message || String(error));
            } finally {
                if (!cancelled) setInitializing(false);
            }
        };
        void initialize();
        return () => { cancelled = true; };
    }, [isOpen]);

    useEffect(() => {
        if (!isOpen) return;
        let unlisten: (() => void) | undefined;
        listen<string>('oauth_code', (event) => { void finishAuthorization(event.payload); })
            .then((dispose) => { unlisten = dispose; });
        return () => unlisten?.();
    }, [isOpen]);

    useEffect(() => {
        if (!isOpen) return;
        let unlisten: (() => void) | undefined;
        listen<DriveTransferProgress>('drive_dictionary_progress', (event) => setTransfer(event.payload))
            .then((dispose) => { unlisten = dispose; });
        return () => unlisten?.();
    }, [isOpen]);

    const accessToken = useCallback(async () => {
        if (!refreshToken) throw new Error(t.disconnected);
        return getAccessToken(refreshToken);
    }, [refreshToken, t.disconnected]);

    const refreshDriveData = useCallback(async (providedAccessToken?: string) => {
        if (!refreshToken && !providedAccessToken) return;
        setBusy(true);
        try {
            const token = providedAccessToken || await accessToken();
            const [nextQuota, nextBackups, nextDictionary, nextLocal] = await Promise.all([
                getDriveQuota(token),
                listBackups(token),
                getDictDriveInfo(token),
                invoke<DictionaryStorageInfo>('get_dictionary_storage_info'),
            ]);
            setQuota(nextQuota);
            setBackups(nextBackups);
            setDictionaryCloud(nextDictionary);
            setDictionaryLocal(nextLocal);
            setStatus(t.statusReady);
        } catch (error: any) {
            setStatus(error?.message || String(error));
        } finally {
            setBusy(false);
        }
    }, [accessToken, refreshToken, t.statusReady]);

    useEffect(() => {
        if (isOpen && refreshToken) void refreshDriveData();
    }, [isOpen, refreshToken]);

    const startAuthorization = async () => {
        if (busy) return;
        setBusy(true);
        setStatus(t.opening);
        try {
            const server = await invoke<OAuthServerStart>('start_oauth_server');
            const pkce = await createGooglePkceSession();
            pkceRef.current = pkce;
            redirectRef.current = server.redirect_uri;
            setAuthRedirectUri(server.redirect_uri);
            const url = getAuthUrl(server.redirect_uri, pkce);
            setAuthUrl(url);
            await openUrl(url);
            setStatus(t.waiting);
        } catch (error: any) {
            setStatus(error?.message || String(error));
        } finally {
            setBusy(false);
        }
    };

    async function finishAuthorization(callback = manualCallback) {
        const pkce = pkceRef.current;
        if (!callback.trim() || !pkce) return;
        setBusy(true);
        try {
            const tokenData = await exchangeCodeForToken(
                callback,
                redirectRef.current || authRedirectUri,
                pkce.verifier,
                pkce.state,
            );
            if (!tokenData.refresh_token) throw new Error('Google did not return a refresh token. Revoke Setsuna access and sign in again.');
            await storeGoogleRefreshToken(tokenData.refresh_token);
            setRefreshToken(tokenData.refresh_token);
            updateSetting('gdriveRefreshToken', '');
            setAuthUrl('');
            setManualCallback('');
            pkceRef.current = null;
            await refreshDriveData(tokenData.access_token);
        } catch (error: any) {
            setStatus(error?.message || String(error));
        } finally {
            setBusy(false);
        }
    }

    const disconnect = async () => {
        setBusy(true);
        try {
            await deleteStoredGoogleRefreshToken();
            updateSetting('gdriveRefreshToken', '');
            setRefreshToken('');
            setQuota(null);
            setBackups([]);
            setDictionaryCloud(null);
            setOpenedBackup(null);
            setStatus(t.disconnected);
        } catch (error: any) {
            setStatus(error?.message || String(error));
        } finally {
            setBusy(false);
        }
    };

    const backupPayload = async () => {
        const chosenTabs = tabs.filter((tab) => selectedTabs[String(tab.id)]).map(stripLocalTabFields);
        const version = await getVersion().catch(() => 'unknown');
        return {
            metadata: { date: new Date().toISOString(), appVersion: version },
            ...(includeSettings ? { settings: stripCloudSettingsFields(settings) } : {}),
            ...(chosenTabs.length ? { tabs: chosenTabs } : {}),
        };
    };

    const createBackup = async () => {
        setBusy(true);
        try {
            const token = await accessToken();
            const payload = await backupPayload();
            const size = new Blob([JSON.stringify(payload)]).size;
            const currentQuota = quota || await getDriveQuota(token);
            if (!hasDriveSpace(currentQuota, size)) throw new Error(t.notEnoughCloud);
            await uploadToDrive(token, payload);
            setStatus(t.statusBackupCreated);
            await refreshDriveData(token);
        } catch (error: any) {
            setStatus(error?.message || String(error));
        } finally {
            setBusy(false);
        }
    };

    const openBackup = async (file: DriveFileInfo) => {
        setBusy(true);
        try {
            const token = await accessToken();
            const data = await downloadFromDrive(token, file.id);
            const normalized = Array.isArray(data) ? { tabs: data, oldFormat: true } : data;
            const selections: Record<string, boolean> = {};
            normalized.tabs?.forEach((tab: any) => { selections[String(tab.id)] = true; });
            setRestoreTabs(selections);
            setRestoreSettings(Boolean(normalized.settings));
            setOpenedBackup(normalized);
            setOpenedBackupFile(file);
        } catch (error: any) {
            setStatus(error?.message || String(error));
        } finally {
            setBusy(false);
        }
    };

    const sanitizeRestoredSettings = async (restored: AppSettings) => {
        try {
            const installed = await invoke<string[]>('get_installed_dicts');
            const restoredMap = new Map((restored.dictionaries || []).map((dictionary) => [dictionary.name, dictionary]));
            const localMap = new Map((settings.dictionaries || []).map((dictionary) => [dictionary.name, dictionary]));
            return {
                ...restored,
                gdriveRefreshToken: '',
                dictionaries: installed.map((name) => restoredMap.get(name) || localMap.get(name) || { name, active: true }),
            };
        } catch {
            return { ...restored, gdriveRefreshToken: '', dictionaries: settings.dictionaries || [] };
        }
    };

    const restoreOpenedBackup = async () => {
        if (!openedBackup) return;
        setBusy(true);
        try {
            const chosen = (openedBackup.tabs || []).filter((tab: any) => restoreTabs[String(tab.id)]);
            if (chosen.length) {
                const nextTabs = [...tabs];
                chosen.forEach((restoredTab: any) => {
                    const clean = stripLocalTabFields(restoredTab);
                    const index = nextTabs.findIndex((tab) => tab.id === restoredTab.id);
                    if (index >= 0) {
                        if (nextTabs[index].captureSource) clean.captureSource = nextTabs[index].captureSource;
                        nextTabs[index] = clean;
                    } else {
                        nextTabs.push(clean);
                    }
                });
                setTabs(nextTabs);
            }
            if (restoreSettings && openedBackup.settings) {
                onSettingsChange(await sanitizeRestoredSettings(openedBackup.settings));
            }
            setOpenedBackup(null);
            setOpenedBackupFile(null);
            setStatus(t.statusRestored);
        } catch (error: any) {
            setStatus(error?.message || String(error));
        } finally {
            setBusy(false);
        }
    };

    const deleteBackup = async (file: DriveFileInfo) => {
        if (!window.confirm(t.confirmDelete)) return;
        setBusy(true);
        try {
            const token = await accessToken();
            await deleteDriveFile(token, file.id);
            setBackups((current) => current.filter((backup) => backup.id !== file.id));
            if (openedBackupFile?.id === file.id) setOpenedBackup(null);
            setStatus(t.statusDeleted);
        } catch (error: any) {
            setStatus(error?.message || String(error));
        } finally {
            setBusy(false);
        }
    };

    const uploadDictionary = async () => {
        if (!dictionaryLocal || !dictionaryAcknowledged) return;
        setBusy(true);
        setTransfer({ operation: 'upload', transferred: 0, total: dictionaryLocal.size, percent: 0 });
        let accessTokenForCleanup = '';
        let newFileId = '';
        try {
            const token = await accessToken();
            accessTokenForCleanup = token;
            const currentQuota = quota || await getDriveQuota(token);
            if (!hasDriveSpace(currentQuota, dictionaryLocal.size)) throw new Error(t.notEnoughCloud);
            const fileId = dictionaryCloud?.id || await createDictFileMetadata(token);
            if (!dictionaryCloud?.id) newFileId = fileId;
            const sessionUrl = await startDictionaryResumableUpload(token, fileId, dictionaryLocal.size);
            await invoke('upload_db_to_drive', { url: sessionUrl, token });
            newFileId = '';
            setStatus(t.statusReady);
            setDictionaryCloud(await getDictDriveInfo(token));
            setQuota(await getDriveQuota(token));
        } catch (error: any) {
            if (newFileId && accessTokenForCleanup) {
                await deleteDriveFile(accessTokenForCleanup, newFileId).catch(() => undefined);
            }
            setStatus(error?.message || String(error));
        } finally {
            setBusy(false);
        }
    };

    const restoreDictionary = async () => {
        if (!dictionaryCloud?.id) return;
        const expectedSize = Number(dictionaryCloud.size || 0);
        if (expectedSize && dictionaryLocal?.availableBytes != null) {
            const margin = Math.max(32 * 1024 * 1024, Math.ceil(expectedSize * 0.02));
            if (dictionaryLocal.availableBytes < expectedSize + margin) {
                setStatus(t.notEnoughLocal);
                return;
            }
        }
        setBusy(true);
        setTransfer({ operation: 'download', transferred: 0, total: expectedSize, percent: 0 });
        try {
            const token = await accessToken();
            await invoke('download_db_from_drive', {
                url: `https://www.googleapis.com/drive/v3/files/${dictionaryCloud.id}?alt=media`,
                token,
                expectedSize: expectedSize || null,
            });
            await syncDictionaries();
            setDictionaryLocal(await invoke<DictionaryStorageInfo>('get_dictionary_storage_info'));
            setStatus(t.statusRestored);
        } catch (error: any) {
            setStatus(error?.message || String(error));
        } finally {
            setBusy(false);
        }
    };

    const selectedTabCount = useMemo(
        () => tabs.filter((tab) => selectedTabs[String(tab.id)]).length,
        [tabs, selectedTabs],
    );
    const driveAvailable = quota ? bytesAvailableInDrive(quota) : null;
    const quotaPercent = quota?.limit
        ? Math.min(100, Number(quota.usage || 0) / Number(quota.limit) * 100)
        : 0;

    if (!isOpen) return null;

    return (
        <div className="tab-content-anim drive-settings" id="cloud-main">
            <section className={`drive-connection ${highlightedSection === 'cloud-main' ? 'card-highlighted' : ''}`}>
                <div>
                    <span className={`drive-status-dot ${refreshToken ? 'is-online' : ''}`} aria-hidden="true" />
                    <strong>{refreshToken ? t.connected : t.disconnected}</strong>
                    <p>{t.privateHint}</p>
                </div>
                {refreshToken ? (
                    <div className="drive-inline-actions">
                        <button type="button" className="btn-secondary" disabled={busy} onClick={() => void refreshDriveData()}>{t.refresh}</button>
                        <button type="button" className="btn-danger-outline" disabled={busy} onClick={() => void disconnect()}>{t.disconnect}</button>
                    </div>
                ) : (
                    <button type="button" className="btn-primary" disabled={busy || initializing} onClick={() => void startAuthorization()}>{t.connect}</button>
                )}
            </section>

            {!refreshToken && authUrl && (
                <section className="drive-auth-fallback">
                    <strong>{t.waiting}</strong>
                    <details>
                        <summary>{t.fallback}</summary>
                        <p>{t.fallbackHint}</p>
                        <div className="drive-callback-row">
                            <input className="modern-input" value={manualCallback} onChange={(event) => setManualCallback(event.target.value)} placeholder={`${authRedirectUri}/?state=…&code=…`} />
                            <button type="button" className="btn-secondary" disabled={busy || !manualCallback.trim()} onClick={() => void finishAuthorization()}>{t.finish}</button>
                        </div>
                    </details>
                </section>
            )}

            {refreshToken && (
                <>
                    <section className="drive-quota-section">
                        <div className="drive-section-heading">
                            <div><h3>{t.quota}</h3><p>{quota?.unlimited ? t.unlimited : `${formatBytes(driveAvailable)} ${t.available}`}</p></div>
                            <strong>{quota ? `${formatBytes(quota.usage)} ${t.used}` : '—'}</strong>
                        </div>
                        <div className="drive-quota-track" aria-label={`${quotaPercent.toFixed(0)}%`}><span style={{ width: `${quotaPercent}%` }} /></div>
                    </section>

                    <section className="drive-section">
                        <div className="drive-section-heading"><div><h3>{t.backupTitle}</h3><p>{t.backupHint}</p></div></div>
                        <label className="drive-check-row"><input type="checkbox" checked={includeSettings} onChange={(event) => setIncludeSettings(event.target.checked)} /><span>{t.settings}</span></label>
                        <div className="drive-tab-picker">
                            <div className="drive-picker-heading"><span>{t.tabs}</span><small>{t.selectedTabs(selectedTabCount)}</small></div>
                            {tabs.map((tab) => (
                                <label key={tab.id}><input type="checkbox" checked={Boolean(selectedTabs[String(tab.id)])} onChange={(event) => setSelectedTabs((current) => ({ ...current, [String(tab.id)]: event.target.checked }))} /><span>{tab.name || `#${tab.id}`}</span></label>
                            ))}
                        </div>
                        <button type="button" className="btn-primary drive-primary-action" disabled={busy || (!includeSettings && selectedTabCount === 0)} onClick={() => void createBackup()}>{t.createBackup}</button>
                    </section>

                    <section className="drive-section">
                        <div className="drive-section-heading"><div><h3>{t.archive}</h3><p>{t.archiveHint}</p></div><span className="drive-count">{backups.length}</span></div>
                        <div className="drive-archive-list">
                            {backups.length === 0 && <div className="drive-empty">{t.noBackups}</div>}
                            {backups.map((backup) => (
                                <div className={`drive-backup-row ${openedBackupFile?.id === backup.id ? 'is-selected' : ''}`} key={backup.id}>
                                    <div><strong>{new Date(backup.createdTime || backup.modifiedTime || Date.now()).toLocaleString()}</strong><span>{formatBytes(backup.size)} · {backup.appProperties?.platform || (backup.name.startsWith('txthk_backup_') ? t.legacy : 'Setsuna')}</span></div>
                                    <div className="drive-row-actions"><button type="button" className="btn-secondary" disabled={busy} onClick={() => void openBackup(backup)}>{t.inspect}</button><button type="button" className="drive-icon-danger" disabled={busy} onClick={() => void deleteBackup(backup)} title={t.delete} aria-label={t.delete}>×</button></div>
                                </div>
                            ))}
                        </div>
                        {openedBackup && (
                            <div className="drive-restore-panel">
                                <div className="drive-restore-title"><strong>{openedBackupFile?.name}</strong><button type="button" onClick={() => setOpenedBackup(null)} aria-label={t.close}>×</button></div>
                                {openedBackup.settings && <label className="drive-check-row"><input type="checkbox" checked={restoreSettings} onChange={(event) => setRestoreSettings(event.target.checked)} /><span>{t.settings}</span></label>}
                                <div className="drive-restore-tabs">{(openedBackup.tabs || []).map((tab: any) => <label key={tab.id}><input type="checkbox" checked={Boolean(restoreTabs[String(tab.id)])} onChange={(event) => setRestoreTabs((current) => ({ ...current, [String(tab.id)]: event.target.checked }))} /><span>{tab.name || `#${tab.id}`}</span></label>)}</div>
                                <button type="button" className="btn-primary" disabled={busy} onClick={() => void restoreOpenedBackup()}>{t.restore}</button>
                            </div>
                        )}
                    </section>

                    <section className="drive-section drive-dictionary-section">
                        <div className="drive-section-heading"><div><h3>{t.dictionary}</h3><p>{t.dictionaryWarning}</p></div></div>
                        <div className="drive-storage-comparison">
                            <div><span>{t.local}</span><strong>{formatBytes(dictionaryLocal?.size)}</strong><small>{dictionaryLocal?.availableBytes != null ? `${formatBytes(dictionaryLocal.availableBytes)} ${t.available}` : '—'}</small></div>
                            <div><span>{t.cloud}</span><strong>{dictionaryCloud ? formatBytes(dictionaryCloud.size) : t.notFound}</strong><small>{dictionaryCloud?.modifiedTime ? new Date(dictionaryCloud.modifiedTime).toLocaleString() : '—'}</small></div>
                        </div>
                        <label className="drive-warning-check"><input type="checkbox" checked={dictionaryAcknowledged} onChange={(event) => setDictionaryAcknowledged(event.target.checked)} /><span>{t.acknowledge}</span></label>
                        {transfer && busy && <div className="drive-transfer"><div><span>{transfer.operation === 'upload' ? t.uploadDictionary : t.restoreDictionary}</span><strong>{transfer.percent}%</strong></div><div className="drive-transfer-track"><span style={{ width: `${transfer.percent}%` }} /></div><small>{formatBytes(transfer.transferred)} / {formatBytes(transfer.total)}</small></div>}
                        <div className="drive-dictionary-actions"><button type="button" className="btn-primary" disabled={busy || !dictionaryAcknowledged || !dictionaryLocal?.size} onClick={() => void uploadDictionary()}>{t.uploadDictionary}</button><button type="button" className="btn-secondary" disabled={busy || !dictionaryCloud} onClick={() => void restoreDictionary()}>{t.restoreDictionary}</button></div>
                    </section>
                </>
            )}

            {status && <div className="drive-message" role="status">{status}</div>}
        </div>
    );
}
