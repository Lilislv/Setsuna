import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import { getAuthUrl, exchangeCodeForToken, getAccessToken, uploadToDrive, downloadFromDrive, listBackups, getDictDriveInfo, createDictFileMetadata } from "../../utils/gdrive";
import { GOOGLE_DRIVE_AVAILABLE } from "../../utils/featureFlags";
import { AppSettings } from "../SettingsModal";

interface SettingsCloudProps {
    settings: AppSettings;
    updateSetting: <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => void;
    onSettingsChange: (newSettings: AppSettings) => void;
    tabs: any[];
    setTabs: (t: any[]) => void;
    syncDictionaries: () => Promise<void>;
    highlightedSection: string | null;
    isOpen: boolean;
}

interface OAuthServerStart {
    port: number;
    redirect_uri: string;
    reused: boolean;
}

const labels = {
    ru: {
        codeReceived: "Код получен. Подключаемся...",
        connected: "Успешно подключено к Google Drive.",
        noRefresh: "Ошибка: Google не выдал refresh token.",
        authError: (e: string) => `Ошибка авторизации: ${e}`,
        disconnected: "Аккаунт отключен.",
        loadingBackups: "Поиск данных в облаке...",
        backupsLoaded: "Данные успешно загружены.",
        loadBackupsError: "Ошибка получения списка из Google Drive.",
        selectData: "Выберите данные для выгрузки.",
        savingBackup: "Сохраняем бэкап в облако...",
        tokenError: "Не удалось получить токен доступа.",
        uploaded: (settings: boolean, count: number) => `Успешно выгружено: настройки (${settings ? "да" : "нет"}), вкладок: ${count}`,
        uploadError: (e: string) => `Ошибка выгрузки: ${e}`,
        downloading: "Скачивание бэкапа...",
        oldFormat: "Неизвестно (старый формат)",
        backupReady: "Бэкап загружен. Выберите, что применить.",
        emptyBackup: "Ошибка: бэкап пустой.",
        downloadError: "Ошибка при скачивании.",
        restored: "Восстановлено: ",
        restoredTabs: (count: number) => `${count} вкладок. `,
        restoredSettings: "настройки. ",
        nothingSelected: "Ничего не было выбрано.",
        syncing: "Синхронизация...",
        authRequired: "Требуется авторизация.",
        dictUploaded: "Словари успешно сохранены в облаке.",
        dictUploadError: (e: string) => `Ошибка загрузки: ${e}`,
        noDictBackup: "В облаке нет сохраненных словарей.",
        waiting: "Ожидание...",
        dictRestored: "Словари успешно восстановлены.",
        error: (e: string) => `Ошибка: ${e}`,
        driveConnected: "Google Drive подключен",
        syncViaFolder: "Синхронизация через скрытую папку приложения",
        disconnect: "Отключить",
        uploadBackup: "Выгрузить в облако",
        allSettings: "Общие настройки",
        currentTabs: (count: number) => `Текущие вкладки (${count}):`,
        noOpenTabs: "Нет открытых вкладок",
        unnamed: "Безымянная",
        uploadSelected: "Отправить выбранное",
        downloadBackup: "Загрузить из облака",
        refreshBackups: "Обновить список бэкапов",
        findBackups: "Найти бэкапы",
        chooseBackup: "Выберите бэкап:",
        latest: "последний",
        downloadBackupButton: "Скачать этот бэкап",
        backup: "Бэкап:",
        settings: "Настройки",
        missing: "нет",
        tabsInBackup: "Вкладки в бэкапе:",
        noTabs: "Нет вкладок",
        apply: "Применить",
        back: "Назад",
        dictionaryDb: "База данных словарей (.db)",
        dictionaryDbHint: "Файл словарей слишком большой для обычного JSON-бэкапа. Он синхронизируется отдельным архивом.",
        inCloud: "В облаке:",
        notFound: "не найдено",
        uploadDicts: "Выгрузить словари в облако",
        restoreDicts: "Скачать и применить",
        driveSync: "Синхронизация через Google Drive",
        driveHint: "Ваши данные будут храниться в скрытой системной папке приложения. Другие файлы затронуты не будут.",
        waitingForBrowser: "Ожидание ответа от браузера...",
        openGoogle: "Открыть Google для входа",
        manualCodeHint: "Если автоматический вход не сработал, вставьте URL с ошибкой сюда:",
        connect: "Подключить",
        cancel: "Отмена",
        authorize: "Авторизовать через Google",
    },
    en: {
        codeReceived: "Code received. Connecting...",
        connected: "Successfully connected to Google Drive.",
        noRefresh: "Error: Google did not return a refresh token.",
        authError: (e: string) => `Authorization error: ${e}`,
        disconnected: "Account disconnected.",
        loadingBackups: "Searching cloud data...",
        backupsLoaded: "Cloud data loaded.",
        loadBackupsError: "Could not load the Google Drive list.",
        selectData: "Select data to upload.",
        savingBackup: "Saving backup to cloud...",
        tokenError: "Could not get access token.",
        uploaded: (settings: boolean, count: number) => `Uploaded: settings (${settings ? "yes" : "no"}), tabs: ${count}`,
        uploadError: (e: string) => `Upload error: ${e}`,
        downloading: "Downloading backup...",
        oldFormat: "Unknown (old format)",
        backupReady: "Backup downloaded. Choose what to apply.",
        emptyBackup: "Error: backup is empty.",
        downloadError: "Download error.",
        restored: "Restored: ",
        restoredTabs: (count: number) => `${count} tabs. `,
        restoredSettings: "settings. ",
        nothingSelected: "Nothing was selected.",
        syncing: "Syncing...",
        authRequired: "Authorization required.",
        dictUploaded: "Dictionaries saved to cloud.",
        dictUploadError: (e: string) => `Dictionary upload error: ${e}`,
        noDictBackup: "No dictionary backup found in cloud.",
        waiting: "Waiting...",
        dictRestored: "Dictionaries restored.",
        error: (e: string) => `Error: ${e}`,
        driveConnected: "Google Drive connected",
        syncViaFolder: "Syncing through the app's hidden folder",
        disconnect: "Disconnect",
        uploadBackup: "Upload backup",
        allSettings: "General settings",
        currentTabs: (count: number) => `Current tabs (${count}):`,
        noOpenTabs: "No open tabs",
        unnamed: "Unnamed",
        uploadSelected: "Upload selected",
        downloadBackup: "Download from cloud",
        refreshBackups: "Refresh backup list",
        findBackups: "Find backups",
        chooseBackup: "Choose backup:",
        latest: "latest",
        downloadBackupButton: "Download this backup",
        backup: "Backup:",
        settings: "Settings",
        missing: "missing",
        tabsInBackup: "Tabs in backup:",
        noTabs: "No tabs",
        apply: "Apply",
        back: "Back",
        dictionaryDb: "Dictionary database (.db)",
        dictionaryDbHint: "Dictionary files are too large for the normal JSON backup, so they sync as a separate archive.",
        inCloud: "In cloud:",
        notFound: "not found",
        uploadDicts: "Upload dictionaries to cloud",
        restoreDicts: "Download and apply",
        driveSync: "Google Drive sync",
        driveHint: "Your data is stored in the app's hidden system folder. Other Drive files are not touched.",
        waitingForBrowser: "Waiting for browser response...",
        openGoogle: "Open Google sign-in",
        manualCodeHint: "If automatic sign-in did not work, paste the redirected URL here:",
        connect: "Connect",
        cancel: "Cancel",
        authorize: "Authorize with Google",
    },
};

export default function SettingsCloud({ settings, updateSetting, onSettingsChange, tabs, setTabs, syncDictionaries, highlightedSection, isOpen }: SettingsCloudProps) {
    const t = labels[settings.appLanguage === "en" ? "en" : "ru"];
    const [cloudStatus, setCloudStatus] = useState("");
    const [isLoading, setIsLoading] = useState(false);
    const [authStep, setAuthStep] = useState(0);
    const [authCodeInput, setAuthCodeInput] = useState("");
    const [authUrl, setAuthUrl] = useState("");
    const [authRedirectUri, setAuthRedirectUri] = useState("");
    const authRedirectUriRef = useRef("");
    const [syncProgress, setSyncProgress] = useState(0);
    const [syncOptions, setSyncOptions] = useState({ settings: true });
    const [uploadTabSelections, setUploadTabSelections] = useState<Record<string, boolean>>({});
    const [backupsList, setBackupsList] = useState<any[]>([]);
    const [selectedBackupId, setSelectedBackupId] = useState("");
    const [cloudBackup, setCloudBackup] = useState<any>(null);
    const [downloadTabSelections, setDownloadTabSelections] = useState<Record<string, boolean>>({});
    const [downloadSettingsSelected, setDownloadSettingsSelected] = useState(false);
    const [dictCloudInfo, setDictCloudInfo] = useState<{ id: string; modifiedTime: string; size?: string } | null>(null);

    const stripLocalTabFields = (tab: any) => {
        const clean = JSON.parse(JSON.stringify(tab));
        delete clean.captureSource;
        return clean;
    };

    const stripCloudSettingsFields = (nextSettings: AppSettings) => {
        const clean = JSON.parse(JSON.stringify(nextSettings));
        delete clean.gdriveRefreshToken;
        return clean;
    };

    const restoreTabWithoutSyncedLocalFields = (restoredTab: any, existingTab?: any) => {
        const clean = stripLocalTabFields(restoredTab);
        if (existingTab?.captureSource) {
            clean.captureSource = existingTab.captureSource;
        }
        return clean;
    };

    useEffect(() => {
        setUploadTabSelections((prev) => {
            const next = { ...prev };
            tabs.forEach((tab) => { if (next[tab.id] === undefined) next[tab.id] = true; });
            return next;
        });
    }, [tabs]);

    useEffect(() => {
        authRedirectUriRef.current = authRedirectUri;
    }, [authRedirectUri]);

    useEffect(() => {
        if (!GOOGLE_DRIVE_AVAILABLE || !isOpen) return;
        let unlisten: any;
        listen<string>("oauth_code", (event) => {
            handleGDriveSubmitCode(event.payload, authRedirectUriRef.current);
        }).then((f) => unlisten = f);
        return () => { if (unlisten) unlisten(); };
    }, [isOpen]);

    const withTimeout = async <T,>(promise: Promise<T>, ms: number, message: string): Promise<T> => {
        let timer: ReturnType<typeof setTimeout> | null = null;
        try {
            return await Promise.race([
                promise,
                new Promise<T>((_, reject) => {
                    timer = setTimeout(() => reject(new Error(message)), ms);
                }),
            ]);
        } finally {
            if (timer) clearTimeout(timer);
        }
    };

    const handleGDriveStartAuth = async () => {
        if (isLoading) return;
        const isEn = settings.appLanguage === "en";
        setIsLoading(true);
        setCloudStatus(isEn ? "Starting local callback server..." : "???????? ????????? ?????? ?????...");
        try {
            const server = await withTimeout(
                invoke<OAuthServerStart>("start_oauth_server"),
                4000,
                isEn
                    ? "Local OAuth server did not answer. Restart Setsuna dev and try again."
                    : "????????? OAuth-?????? ?? ???????. ??????????? dev-?????? Setsuna ? ???????? ??? ???."
            );
            const url = getAuthUrl(server.redirect_uri);
            authRedirectUriRef.current = server.redirect_uri;
            setAuthRedirectUri(server.redirect_uri);
            setAuthUrl(url);
            setAuthStep(1);
            setCloudStatus(isEn ? "Opening Google in the browser..." : "???????? Google ? ????????...");
            try {
                await withTimeout(
                    openUrl(url),
                    3500,
                    isEn ? "System browser opener timed out." : "???????? ?????????? ???????? ???????."
                );
                setCloudStatus(isEn
                    ? "Browser opened. Finish Google sign-in, Setsuna will connect automatically."
                    : "??????? ??????. ??????? ???? Google, Setsuna ??????????? ????.");
            } catch {
                window.open(url, "_blank", "noopener,noreferrer");
                setCloudStatus(isEn
                    ? "Could not use the system opener. Tried to open Google in a browser tab."
                    : "?? ?????????? ??????? ????????? ???????. ?????????? ??????? Google ?? ???????.");
            }
        } catch (e: any) {
            setAuthStep(0);
            setAuthRedirectUri("");
            setAuthUrl("");
            authRedirectUriRef.current = "";
            setCloudStatus(t.authError(e?.message || String(e)));
        } finally {
            setIsLoading(false);
        }
    };

    const handleGDriveSubmitCode = async (codeFromEvent?: string, redirectOverride?: string) => {
        const finalCode = typeof codeFromEvent === "string" ? codeFromEvent : authCodeInput;
        if (!finalCode.trim()) return;
        setIsLoading(true);
        setCloudStatus(t.codeReceived);
        try {
            const tokenData = await exchangeCodeForToken(finalCode, redirectOverride || authRedirectUri || undefined);
            if (tokenData.refresh_token) {
                updateSetting("gdriveRefreshToken", tokenData.refresh_token);
                setAuthStep(0);
                setAuthCodeInput("");
                setAuthUrl("");
                setAuthRedirectUri("");
                authRedirectUriRef.current = "";
                setCloudStatus(t.connected);
                handleGDriveRefreshList(tokenData.access_token);
            } else {
                setCloudStatus(t.noRefresh);
            }
        } catch (e: any) {
            setCloudStatus(t.authError(e.message || String(e)));
        }
        setIsLoading(false);
    };

    const handleGDriveDisconnect = () => {
        updateSetting("gdriveRefreshToken", "");
        setAuthStep(0);
        setCloudStatus(t.disconnected);
        setSyncProgress(0);
        setCloudBackup(null);
        setBackupsList([]);
        setDictCloudInfo(null);
    };

    const handleGDriveRefreshList = async (providedToken?: string) => {
        if (!settings.gdriveRefreshToken && !providedToken) return;
        setIsLoading(true);
        setCloudStatus(t.loadingBackups);
        setSyncProgress(0);
        try {
            const token = providedToken || await getAccessToken(settings.gdriveRefreshToken!);
            const list = await listBackups(token);
            setBackupsList(list);
            if (list.length > 0) setSelectedBackupId(list[0].id);
            const dictInfo = await getDictDriveInfo(token);
            setDictCloudInfo(dictInfo);
            setCloudStatus(t.backupsLoaded);
        } catch (e: any) {
            setCloudStatus(`${t.loadBackupsError} ${e?.message || String(e)}`);
        }
        setIsLoading(false);
    };

    const handleGDriveUpload = async () => {
        if (!settings.gdriveRefreshToken) return;
        const selectedTabs = tabs.filter((tab) => uploadTabSelections[tab.id]);
        if (!syncOptions.settings && selectedTabs.length === 0) {
            setCloudStatus(t.selectData);
            return;
        }
        setIsLoading(true);
        setCloudStatus(t.savingBackup);
        setSyncProgress(0);
        try {
            const token = await getAccessToken(settings.gdriveRefreshToken);
            if (!token) throw new Error(t.tokenError);
            const payload: any = { metadata: { date: new Date().toISOString() } };
            if (selectedTabs.length > 0) payload.tabs = selectedTabs.map(stripLocalTabFields);
            if (syncOptions.settings) payload.settings = stripCloudSettingsFields(settings);
            await uploadToDrive(token, payload, setSyncProgress);
            setCloudStatus(t.uploaded(syncOptions.settings, selectedTabs.length));
            setSyncProgress(100);
            try { await handleGDriveRefreshList(token); } catch {}
            setTimeout(() => setSyncProgress(0), 3000);
        } catch (e: any) {
            setCloudStatus(t.uploadError(e.message || String(e)));
            setSyncProgress(0);
        }
        setIsLoading(false);
    };

    const handleGDriveDownload = async () => {
        if (!settings.gdriveRefreshToken || !selectedBackupId) return;
        setIsLoading(true);
        setCloudStatus(t.downloading);
        setSyncProgress(0);
        try {
            const token = await getAccessToken(settings.gdriveRefreshToken);
            const rawData = await downloadFromDrive(token, selectedBackupId, setSyncProgress);
            let data = rawData;
            if (typeof rawData === "string") {
                try { data = JSON.parse(rawData); } catch {}
            }
            if (data) {
                const backup = Array.isArray(data) ? { tabs: data, oldFormat: true, metadata: { date: t.oldFormat } } : data;
                setCloudBackup(backup);
                const initialSels: Record<string, boolean> = {};
                backup.tabs?.forEach((tab: any) => initialSels[tab.id] = true);
                setDownloadTabSelections(initialSels);
                setDownloadSettingsSelected(false);
                setCloudStatus(t.backupReady);
            } else {
                setCloudStatus(t.emptyBackup);
            }
        } catch (e: any) {
            setCloudStatus(`${t.downloadError} ${e?.message || String(e)}`);
        }
        setIsLoading(false);
        setTimeout(() => setSyncProgress(0), 2000);
    };

    const sanitizeRestoredSettings = async (restoredSettings: AppSettings): Promise<AppSettings> => {
        let installedDicts: string[] | null = null;
        try {
            const result = await invoke<string[]>("get_installed_dicts");
            installedDicts = Array.isArray(result) ? result : [];
        } catch {
            installedDicts = null;
        }

        if (!installedDicts) {
            return {
                ...restoredSettings,
                dictionaries: settings.dictionaries || [],
            };
        }

        const restoredByName = new Map((restoredSettings.dictionaries || []).map((dict) => [dict.name, dict]));
        const localByName = new Map((settings.dictionaries || []).map((dict) => [dict.name, dict]));
        const dictionaries = installedDicts.map((name) => {
            const restored = restoredByName.get(name);
            const local = localByName.get(name);
            return restored || local || { name, active: true };
        });

        return {
            ...restoredSettings,
            dictionaries,
        };
    };

    const handleGDriveRestore = async () => {
        if (!cloudBackup) return;
        setIsLoading(true);
        let restoredCount = 0;
        let message = t.restored;
        try {
            const tabsToRestore = cloudBackup.tabs?.filter((tab: any) => downloadTabSelections[tab.id]) || [];
            if (tabsToRestore.length > 0) {
                const newTabs = [...tabs];
                tabsToRestore.forEach((restoredTab: any) => {
                    const index = newTabs.findIndex((tab) => tab.id === restoredTab.id);
                    if (index >= 0) newTabs[index] = restoreTabWithoutSyncedLocalFields(restoredTab, newTabs[index]);
                    else newTabs.push(restoreTabWithoutSyncedLocalFields(restoredTab));
                });
                setTabs(newTabs);
                restoredCount++;
                message += t.restoredTabs(tabsToRestore.length);
            }
            if (downloadSettingsSelected && cloudBackup.settings) {
                const restoredSettings = await sanitizeRestoredSettings(cloudBackup.settings);
                onSettingsChange({ ...restoredSettings, gdriveRefreshToken: settings.gdriveRefreshToken });
                restoredCount++;
                message += t.restoredSettings;
            }
            if (restoredCount === 0) message = t.nothingSelected;
            setCloudStatus(message);
            setCloudBackup(null);
        } finally {
            setIsLoading(false);
        }
    };

    const handleBackupDictionaryDB = async () => {
        setCloudStatus(t.syncing);
        try {
            const token = await getAccessToken(settings.gdriveRefreshToken!);
            if (!token) {
                setCloudStatus(t.authRequired);
                return;
            }
            const info = await getDictDriveInfo(token);
            let fileId = info?.id;
            if (!fileId) fileId = await createDictFileMetadata(token);
            await invoke("upload_db_to_drive", {
                url: `https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=media`,
                token,
            });
            setCloudStatus(t.dictUploaded);
            setDictCloudInfo(await getDictDriveInfo(token));
        } catch (e) {
            console.error(e);
            setCloudStatus(t.dictUploadError(String(e)));
        }
    };

    const handleRestoreDictionaryDB = async () => {
        setCloudStatus(t.syncing);
        try {
            const token = await getAccessToken(settings.gdriveRefreshToken!);
            if (!token) return;
            const info = await getDictDriveInfo(token);
            if (!info?.id) {
                alert(t.noDictBackup);
                setCloudStatus(t.waiting);
                return;
            }
            await invoke("download_db_from_drive", {
                url: `https://www.googleapis.com/drive/v3/files/${info.id}?alt=media`,
                token,
            });
            await syncDictionaries();
            setCloudStatus(t.dictRestored);
        } catch (e) {
            setCloudStatus(t.error(String(e)));
        }
    };

    if (!isOpen) return null;

    if (!GOOGLE_DRIVE_AVAILABLE) {
        const isEn = settings.appLanguage === "en";
        return (
            <div className="tab-content-anim">
                <div id="cloud-main" className={`modern-section ${highlightedSection === "cloud-main" ? "card-highlighted" : ""}`}>
                    <div className="modern-card" style={{ background: "var(--bg-panel)", border: "1px solid var(--border-main)", padding: "20px" }}>
                        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: "20px", marginBottom: "18px" }}>
                            <div>
                                <div className="card-label" style={{ color: "var(--text-main)", fontSize: "16px", marginBottom: "7px" }}>Google Drive</div>
                                <div style={{ color: "var(--text-muted)", fontSize: "13px", lineHeight: 1.5 }}>
                                    {isEn
                                        ? "Backup and synchronization are temporarily unavailable."
                                        : "Резервные копии и синхронизация временно недоступны."}
                                </div>
                            </div>
                            <span style={{ flex: "0 0 auto", padding: "4px 8px", border: "1px solid var(--border-main)", borderRadius: "4px", color: "var(--text-main)", background: "var(--bg-side)", fontSize: "12px", fontWeight: 700 }}>
                                {isEn ? "Coming soon" : "Скоро"}
                            </span>
                        </div>
                        <button className="btn-primary" type="button" disabled style={{ width: "100%", padding: "12px", cursor: "not-allowed" }}>
                            {isEn ? "Google Drive - coming soon" : "Google Drive - скоро"}
                        </button>
                    </div>
                </div>
            </div>
        );
    }

    const statusBlock = cloudStatus && <div style={{ padding: "10px", background: "var(--bg-side)", borderRadius: "4px", border: "1px solid var(--border-main)", color: "var(--text-main)", textAlign: "center", fontSize: "13px" }}>{cloudStatus}</div>;

    return (
        <div className="tab-content-anim">
            <div id="cloud-main" className={`modern-section ${highlightedSection === "cloud-main" ? "card-highlighted" : ""}`}>
                {settings.gdriveRefreshToken ? (
                    <div style={{ display: "flex", flexDirection: "column", gap: "20px" }}>
                        <div className="modern-card" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", border: "1px solid #4fa6ff", background: "rgba(79, 166, 255, 0.05)", padding: "15px 20px" }}>
                            <div>
                                <div style={{ color: "var(--accent-blue)", fontWeight: "bold", fontSize: "16px" }}>{t.driveConnected}</div>
                                <div style={{ color: "var(--text-muted)", fontSize: "12px" }}>{t.syncViaFolder}</div>
                            </div>
                            <button onClick={handleGDriveDisconnect} disabled={isLoading} style={{ background: "transparent", border: "1px solid rgba(255, 68, 68, 0.3)", color: "#ff4444", borderRadius: "4px", padding: "6px 12px", cursor: "pointer", fontSize: "12px" }}>{t.disconnect}</button>
                        </div>

                        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "20px" }}>
                            <div className="modern-card" style={{ border: "1px solid var(--border-main)", background: "var(--bg-panel)" }}>
                                <div className="card-label" style={{ color: "var(--text-main)", borderBottom: "1px solid var(--border-main)", paddingBottom: "10px", marginBottom: "15px" }}>{t.uploadBackup}</div>
                                <label className="checkbox-label" style={{ fontSize: "14px", fontWeight: "bold", marginBottom: "15px" }}>
                                    <input type="checkbox" checked={syncOptions.settings} onChange={(e) => setSyncOptions({ ...syncOptions, settings: e.target.checked })} /> {t.allSettings}
                                </label>
                                <div style={{ background: "var(--bg-main)", padding: "10px", borderRadius: "6px", border: "1px solid var(--border-main)", marginBottom: "15px" }}>
                                    <div style={{ color: "var(--text-main)", fontSize: "13px", fontWeight: "bold", marginBottom: "8px" }}>{t.currentTabs(tabs.length)}</div>
                                    <div className="tiny-scroll" style={{ maxHeight: "150px", overflowY: "auto", display: "flex", flexDirection: "column", gap: "6px" }}>
                                        {tabs.length === 0 ? <div style={{ color: "var(--text-muted)", fontSize: "12px", fontStyle: "italic" }}>{t.noOpenTabs}</div> : tabs.map((tab) => (
                                            <label key={tab.id} className="checkbox-label" style={{ fontSize: "13px", margin: 0 }}>
                                                <input type="checkbox" checked={uploadTabSelections[tab.id] || false} onChange={(e) => setUploadTabSelections({ ...uploadTabSelections, [tab.id]: e.target.checked })} /> {tab.name || t.unnamed}
                                            </label>
                                        ))}
                                    </div>
                                </div>
                                <button className="btn-primary" onClick={handleGDriveUpload} disabled={isLoading || (!syncOptions.settings && tabs.filter((tab) => uploadTabSelections[tab.id]).length === 0)} style={{ width: "100%", padding: "10px" }}>{t.uploadSelected}</button>
                            </div>

                            <div className="modern-card" style={{ border: "1px solid var(--border-main)", background: "var(--bg-panel)", display: "flex", flexDirection: "column" }}>
                                <div className="card-label" style={{ display: "flex", justifyContent: "space-between", color: "var(--text-main)", borderBottom: "1px solid var(--border-main)", paddingBottom: "10px", marginBottom: "15px" }}>
                                    <span>{t.downloadBackup}</span>
                                    <button onClick={() => handleGDriveRefreshList()} disabled={isLoading} style={{ background: "transparent", border: "none", color: "var(--accent-blue)", cursor: "pointer", fontSize: "16px" }} title={t.refreshBackups}>↻</button>
                                </div>
                                {backupsList.length === 0 && !cloudBackup ? (
                                    <div style={{ textAlign: "center", padding: "20px 0", margin: "auto 0" }}><button className="btn-primary" onClick={() => handleGDriveRefreshList()} disabled={isLoading} style={{ background: "var(--bg-side)", border: "1px solid var(--accent-blue)", color: "var(--accent-blue)", padding: "10px 20px" }}>{t.findBackups}</button></div>
                                ) : !cloudBackup ? (
                                    <div style={{ display: "flex", flexDirection: "column", gap: "15px" }}>
                                        <div style={{ color: "var(--text-main)", fontSize: "13px" }}>{t.chooseBackup}</div>
                                        <select className="modern-select" value={selectedBackupId} onChange={(e) => setSelectedBackupId(e.target.value)} style={{ padding: "10px", fontSize: "13px" }}>
                                            {backupsList.map((backup, i) => <option key={backup.id} value={backup.id}>{new Date(backup.createdTime).toLocaleString()} {i === 0 ? `(${t.latest})` : ""}</option>)}
                                        </select>
                                        <button className="btn-primary" onClick={handleGDriveDownload} disabled={isLoading} style={{ width: "100%", padding: "10px" }}>{t.downloadBackupButton}</button>
                                    </div>
                                ) : (
                                    <div style={{ display: "flex", flexDirection: "column", gap: "15px" }}>
                                        <div style={{ background: "rgba(79, 166, 255, 0.1)", border: "1px solid var(--accent-blue)", padding: "8px 12px", borderRadius: "6px", color: "var(--text-main)", fontSize: "13px" }}><strong>{t.backup}</strong> {cloudBackup.metadata?.date ? new Date(cloudBackup.metadata.date).toLocaleString() : t.oldFormat}</div>
                                        {!cloudBackup.oldFormat && <label className="checkbox-label" style={{ fontSize: "14px", fontWeight: "bold" }}><input type="checkbox" disabled={!cloudBackup.settings} checked={downloadSettingsSelected} onChange={(e) => setDownloadSettingsSelected(e.target.checked)} /> {t.settings} {!cloudBackup.settings && <span style={{ color: "var(--text-muted)", fontSize: "11px", marginLeft: "5px" }}>({t.missing})</span>}</label>}
                                        <div style={{ background: "var(--bg-main)", padding: "10px", borderRadius: "6px", border: "1px solid var(--border-main)" }}>
                                            <div style={{ color: "var(--text-main)", fontSize: "13px", fontWeight: "bold", marginBottom: "8px" }}>{t.tabsInBackup}</div>
                                            <div className="tiny-scroll" style={{ maxHeight: "150px", overflowY: "auto", display: "flex", flexDirection: "column", gap: "6px" }}>
                                                {!(cloudBackup.tabs?.length > 0) ? <div style={{ color: "var(--text-muted)", fontSize: "12px", fontStyle: "italic" }}>{t.noTabs}</div> : cloudBackup.tabs.map((tab: any) => (
                                                    <label key={tab.id} className="checkbox-label" style={{ fontSize: "13px", margin: 0 }}><input type="checkbox" checked={downloadTabSelections[tab.id] || false} onChange={(e) => setDownloadTabSelections({ ...downloadTabSelections, [tab.id]: e.target.checked })} /> {tab.name || t.unnamed}</label>
                                                ))}
                                            </div>
                                        </div>
                                        <div style={{ display: "flex", gap: "10px", marginTop: "auto" }}><button className="btn-primary" onClick={handleGDriveRestore} style={{ flex: 1, padding: "10px", background: "#4CAF50", border: "none" }}>{t.apply}</button><button onClick={() => setCloudBackup(null)} style={{ background: "var(--bg-main)", border: "1px solid var(--border-main)", color: "var(--text-muted)", padding: "10px", borderRadius: "6px", cursor: "pointer" }}>{t.back}</button></div>
                                    </div>
                                )}
                            </div>
                        </div>

                        <div className="modern-card" style={{ border: "1px solid #bb86fc", background: "rgba(187, 134, 252, 0.03)" }}>
                            <div className="card-label" style={{ color: "#bb86fc", borderBottom: "1px solid rgba(187, 134, 252, 0.2)", paddingBottom: "10px", marginBottom: "15px" }}>{t.dictionaryDb}</div>
                            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "15px" }}>
                                <div style={{ color: "var(--text-muted)", fontSize: "13px", maxWidth: "60%" }}>{t.dictionaryDbHint}</div>
                                <div style={{ background: "var(--bg-main)", border: "1px solid var(--border-main)", padding: "10px 15px", borderRadius: "6px", textAlign: "right" }}>
                                    <div style={{ fontSize: "11px", color: "var(--text-muted)" }}>{t.inCloud}</div>
                                    {dictCloudInfo ? <div style={{ color: "var(--text-main)", fontSize: "13px", fontWeight: "bold" }}>{new Date(dictCloudInfo.modifiedTime).toLocaleDateString()}{dictCloudInfo.size && <span style={{ color: "var(--accent-blue)", marginLeft: "8px" }}>({(Number(dictCloudInfo.size) / 1024 / 1024).toFixed(1)} MB)</span>}</div> : <div style={{ color: "#ff4444", fontSize: "13px" }}>{t.notFound}</div>}
                                </div>
                            </div>
                            <div style={{ display: "flex", gap: "15px" }}><button onClick={handleBackupDictionaryDB} disabled={isLoading} style={{ flex: 1, padding: "10px", background: "rgba(187, 134, 252, 0.1)", color: "#bb86fc", border: "1px solid #bb86fc", borderRadius: "6px", cursor: isLoading ? "default" : "pointer", fontWeight: "bold" }}>{t.uploadDicts}</button><button onClick={handleRestoreDictionaryDB} disabled={isLoading || !dictCloudInfo} style={{ flex: 1, padding: "10px", background: "var(--bg-main)", color: dictCloudInfo ? "var(--text-main)" : "var(--text-muted)", border: "1px solid var(--border-main)", borderRadius: "6px", cursor: (isLoading || !dictCloudInfo) ? "default" : "pointer" }}>{t.restoreDicts}</button></div>
                        </div>

                        {syncProgress > 0 && <div style={{ width: "100%", height: "4px", background: "var(--bg-main)", borderRadius: "2px", overflow: "hidden", marginBottom: "10px" }}><div style={{ width: `${syncProgress}%`, height: "100%", background: "var(--accent-blue)", transition: "width 0.2s ease-out" }} /></div>}
                        {statusBlock}
                    </div>
                ) : (
                    <div className="modern-card" style={{ background: "var(--bg-panel)", border: "1px solid var(--border-main)" }}>
                        <div className="card-label" style={{ fontSize: "16px", color: "var(--text-main)" }}>{t.driveSync}</div>
                        <div style={{ color: "var(--text-muted)", fontSize: "13px", marginBottom: "20px", lineHeight: "1.5" }}>{t.driveHint}</div>
                        {authStep === 1 ? (
                            <div style={{ background: "var(--bg-main)", padding: "20px", borderRadius: "8px", border: "1px dashed var(--accent-blue)" }}>
                                <div style={{ color: "var(--text-main)", marginBottom: "10px", fontSize: "15px", textAlign: "center" }}>
                                    {settings.appLanguage === "en" ? "Waiting for Google sign-in..." : "Жду вход Google..."}
                                </div>
                                <div style={{ color: "var(--text-muted)", marginBottom: "14px", fontSize: "13px", textAlign: "center", lineHeight: 1.5 }}>
                                    {settings.appLanguage === "en"
                                        ? "Finish sign-in in the browser. Setsuna will catch the redirect and connect Drive automatically."
                                        : "Заверши вход в браузере. Setsuna сама поймает redirect и подключит Drive."}
                                </div>
                                <div style={{ textAlign: "center", marginBottom: "14px" }}><button className="btn-primary" onClick={async () => { const url = authUrl || getAuthUrl(authRedirectUri || undefined); try { await openUrl(url); } catch { window.open(url, "_blank", "noopener,noreferrer"); setCloudStatus(settings.appLanguage === "en" ? "Tried to open Google in a browser tab." : "Попробовал открыть Google во вкладке."); } }} style={{ display: "inline-block", padding: "10px 20px", border: "none", borderRadius: "6px", cursor: "pointer", fontSize: "14px" }}>{t.openGoogle}</button></div>
                                <details style={{ borderTop: "1px solid var(--border-main)", paddingTop: "12px", marginTop: "12px" }}>
                                    <summary style={{ color: "var(--text-muted)", cursor: "pointer", fontSize: "12px" }}>
                                        {settings.appLanguage === "en" ? "Fallback: paste redirect URL manually" : "Запасной вариант: вставить redirect URL вручную"}
                                    </summary>
                                    {authUrl && <input type="text" className="modern-input" readOnly value={authUrl} onFocus={(e) => e.currentTarget.select()} style={{ width: "100%", margin: "12px 0", fontFamily: "monospace", fontSize: "11px", background: "var(--bg-panel)", color: "var(--text-muted)", border: "1px solid var(--border-main)" }} />}
                                    <div style={{ color: "var(--text-muted)", fontSize: "12px", marginBottom: "8px" }}>{t.manualCodeHint}</div>
                                    <div style={{ display: "flex", gap: "10px" }}><input type="text" className="modern-input" placeholder={`${authRedirectUri || "http://127.0.0.1:1337"}/?state=...&code=...`} value={authCodeInput} onChange={(e) => setAuthCodeInput(e.target.value)} style={{ flex: 1, fontFamily: "monospace", background: "var(--bg-panel)", color: "var(--text-main)", border: "1px solid var(--border-main)" }} /><button className="btn-primary" onClick={() => handleGDriveSubmitCode()} disabled={isLoading || !authCodeInput.trim()}>{t.connect}</button></div>
                                </details>
                                <button onClick={() => { setAuthStep(0); setAuthUrl(""); setAuthRedirectUri(""); setAuthCodeInput(""); }} style={{ background: "transparent", border: "none", color: "var(--text-muted)", cursor: "pointer", marginTop: "15px", fontSize: "12px", width: "100%", textAlign: "center" }}>{t.cancel}</button>
                            </div>
                        ) : (
                            <button className="btn-primary" type="button" onClick={handleGDriveStartAuth} style={{ width: "100%", padding: "12px", fontSize: "14px", cursor: isLoading ? "wait" : "pointer", opacity: isLoading ? 0.75 : 1, background: "var(--accent-blue)", color: "#fff", border: "none" }}>{isLoading ? (settings.appLanguage === "en" ? "Opening Google..." : "Открываю Google...") : t.authorize}</button>
                        )}
                        {statusBlock && <div style={{ marginTop: "15px" }}>{statusBlock}</div>}
                    </div>
                )}
            </div>
        </div>
    );
}
