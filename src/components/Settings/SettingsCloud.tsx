import { useState, useEffect } from "react";
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { openUrl } from '@tauri-apps/plugin-opener';
import { getAuthUrl, exchangeCodeForToken, getAccessToken, uploadToDrive, downloadFromDrive, listBackups, getDictDriveInfo, createDictFileMetadata } from "../../utils/gdrive";
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

export default function SettingsCloud({ settings, updateSetting, onSettingsChange, tabs, setTabs, syncDictionaries, highlightedSection, isOpen }: SettingsCloudProps) {
    const [cloudStatus, setCloudStatus] = useState("");
    const [isLoading, setIsLoading] = useState(false);
    const [authStep, setAuthStep] = useState(0); 
    const [authCodeInput, setAuthCodeInput] = useState("");
    const [syncProgress, setSyncProgress] = useState(0);
  
    const [syncOptions, setSyncOptions] = useState({ settings: true }); 
    const [uploadTabSelections, setUploadTabSelections] = useState<Record<string, boolean>>({});
    
    const [backupsList, setBackupsList] = useState<any[]>([]);
    const [selectedBackupId, setSelectedBackupId] = useState<string>("");
    const [cloudBackup, setCloudBackup] = useState<any>(null); 
    const [downloadTabSelections, setDownloadTabSelections] = useState<Record<string, boolean>>({});
    const [downloadSettingsSelected, setDownloadSettingsSelected] = useState(false);
  
    const [dictCloudInfo, setDictCloudInfo] = useState<{ id: string, modifiedTime: string, size?: string } | null>(null);

    useEffect(() => {
        setUploadTabSelections(prev => {
            const next = { ...prev };
            tabs.forEach(t => { if (next[t.id] === undefined) next[t.id] = true; });
            return next;
        });
    }, [tabs]);

    useEffect(() => {
        let unlisten: any;
        if (authStep === 1) {
            listen<string>('oauth_code', (event) => { handleGDriveSubmitCode(event.payload); }).then(f => unlisten = f);
        }
        return () => { if (unlisten) unlisten(); };
    }, [authStep]);

    const handleGDriveStartAuth = async () => {
        setAuthStep(1);
        try { await invoke('start_oauth_server'); } catch (e) { console.error("Server error", e); }
    };

    const handleGDriveSubmitCode = async (codeFromEvent?: string) => {
        const finalCode = typeof codeFromEvent === 'string' ? codeFromEvent : authCodeInput;
        if (!finalCode.trim()) return;
        setIsLoading(true); setCloudStatus("Код получен! Подключение...");
        try {
            const tokenData = await exchangeCodeForToken(finalCode);
            if (tokenData.refresh_token) {
                updateSetting('gdriveRefreshToken', tokenData.refresh_token);
                setAuthStep(0); setAuthCodeInput("");
                setCloudStatus("Успешно подключено к Google Drive!");
                handleGDriveRefreshList(tokenData.access_token);
            } else setCloudStatus("Ошибка: Google не выдал Refresh Token.");
        } catch (e: any) { setCloudStatus(`Ошибка авторизации: ${e.message || String(e)}`); }
        setIsLoading(false);
    };

    const handleGDriveDisconnect = () => {
        updateSetting('gdriveRefreshToken', ''); setAuthStep(0);
        setCloudStatus("Аккаунт отключен."); setSyncProgress(0); setCloudBackup(null); setBackupsList([]); setDictCloudInfo(null);
    };

    const handleGDriveRefreshList = async (providedToken?: string) => {
        if (!settings.gdriveRefreshToken && !providedToken) return;
        setIsLoading(true); setCloudStatus("Поиск данных в облаке..."); setSyncProgress(0);
        try {
            const token = providedToken || await getAccessToken(settings.gdriveRefreshToken!);
            const list = await listBackups(token);
            setBackupsList(list);
            if (list.length > 0) setSelectedBackupId(list[0].id);
            const dictInfo = await getDictDriveInfo(token);
            setDictCloudInfo(dictInfo);
            setCloudStatus(`Данные успешно загружены.`);
        } catch(e) { setCloudStatus("Ошибка получения списка с Google Drive."); }
        setIsLoading(false);
    };

    const handleGDriveUpload = async () => {
        if (!settings.gdriveRefreshToken) return;
        const selectedTabs = tabs.filter(t => uploadTabSelections[t.id]);
        if (!syncOptions.settings && selectedTabs.length === 0) { setCloudStatus("Выберите данные для выгрузки!"); return; }
  
        setIsLoading(true); setCloudStatus("Сохраняем бэкап в облако..."); setSyncProgress(0);
        try {
            const token = await getAccessToken(settings.gdriveRefreshToken);
            if (!token) throw new Error("Не удалось получить токен доступа");
            
            setSyncProgress(5);
            const payload: any = { metadata: { date: new Date().toISOString() } };
            if (selectedTabs.length > 0) payload.tabs = selectedTabs;
            if (syncOptions.settings) payload.settings = settings;

            await uploadToDrive(token, payload, (p: number) => setSyncProgress(p));
            
            setCloudStatus(`Успешно выгружено: Настройки (${syncOptions.settings ? 'Да' : 'Нет'}), Вкладок: ${selectedTabs.length}`);
            setSyncProgress(100);
            
            try { await handleGDriveRefreshList(token); } catch(refreshErr) { console.warn(refreshErr); }
            
            setTimeout(() => setSyncProgress(0), 3000);
        } catch(e: any) { 
            setCloudStatus(`Ошибка выгрузки: ${e.message || String(e)}`); 
            setSyncProgress(0); 
        }
        setIsLoading(false);
    };

    const handleGDriveDownload = async () => {
        if (!settings.gdriveRefreshToken || !selectedBackupId) return;
        setIsLoading(true); setCloudStatus("Скачивание бэкапа..."); setSyncProgress(0);
        try {
            const token = await getAccessToken(settings.gdriveRefreshToken);
            const rawData = await downloadFromDrive(token, selectedBackupId, (p: number) => setSyncProgress(p));
            
            let data = rawData;
            if (typeof rawData === 'string') {
                try { data = JSON.parse(rawData); } catch(e) {}
            }
            
            if (data) {
                if (Array.isArray(data)) {
                    setCloudBackup({ tabs: data, oldFormat: true, metadata: { date: 'Неизвестно (Старый формат)' } });
                    const initialSels: Record<string, boolean> = {};
                    data.forEach((t: any) => initialSels[t.id] = true);
                    setDownloadTabSelections(initialSels);
                    setDownloadSettingsSelected(false);
                } else {
                    setCloudBackup(data);
                    const initialSels: Record<string, boolean> = {};
                    if (data.tabs) data.tabs.forEach((t: any) => initialSels[t.id] = true);
                    setDownloadTabSelections(initialSels);
                    setDownloadSettingsSelected(false);
                }
                setCloudStatus("Бэкап загружен! Выберите, что применить.");
            } else setCloudStatus("Ошибка: бэкап пуст.");
        } catch(e) { setCloudStatus("Ошибка при скачивании."); }
        setIsLoading(false); setTimeout(() => setSyncProgress(0), 2000);
    };

    const handleGDriveRestore = () => {
        if (!cloudBackup) return;
        let restoredCount = 0; let msg = "Восстановлено: ";
        const tabsToRestore = cloudBackup.tabs?.filter((t: any) => downloadTabSelections[t.id]) || [];
        if (tabsToRestore.length > 0) {
            const newTabs = [...tabs];
            tabsToRestore.forEach((rt: any) => {
                const idx = newTabs.findIndex(t => t.id === rt.id);
                if (idx >= 0) newTabs[idx] = rt; 
                else newTabs.push(rt);           
            });
            setTabs(newTabs); restoredCount++; msg += `${tabsToRestore.length} вкладок. `;
        }
        if (downloadSettingsSelected && cloudBackup.settings) {
            const newSettings = { ...cloudBackup.settings, gdriveRefreshToken: settings.gdriveRefreshToken };
            onSettingsChange(newSettings); restoredCount++; msg += "Настройки. ";
        }
        if (restoredCount === 0) msg = "Ничего не было выбрано.";
        setCloudStatus(msg); setCloudBackup(null);
    };

    const handleBackupDictionaryDB = async () => {
        setCloudStatus("Синхронизация...");
        try {
            const token = await getAccessToken(settings.gdriveRefreshToken!);
            if (!token) { setCloudStatus("Требуется авторизация"); return; }
            
            const dbPath = await invoke<string>("get_data_path", { filename: "dictionary.db" });
            const info = await getDictDriveInfo(token);
            let fileId = info.files?.[0]?.id;
            
            if (!fileId) {
                const meta = await createDictFileMetadata(token);
                fileId = meta.id;
            }
            
            const fileData = await invoke<number[]>("read_file_bytes", { path: dbPath });
            const uint8Array = new Uint8Array(fileData);
            
            await fetch(`https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=media`, {
                method: 'PATCH',
                headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/octet-stream' },
                body: uint8Array
            });
            
            setCloudStatus('Словари успешно сохранены в облако!'); 
        } catch (e) { console.error(e); setCloudStatus("Ошибка загрузки: " + e); }
    };

    const handleRestoreDictionaryDB = async () => {
        setCloudStatus("Синхронизация...");
        try {
            const token = await getAccessToken(settings.gdriveRefreshToken!); if (!token) return;
            const info = await getDictDriveInfo(token);
            if (!info.files || info.files.length === 0) { alert("В облаке нет сохраненных словарей."); setCloudStatus('Ожидание...'); return; }
            
            const fileId = info.files[0].id;
            const dbPath = await invoke<string>("get_data_path", { filename: "dictionary.db" });
            
            const dlRes = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, { headers: { Authorization: `Bearer ${token}` } });
            const blob = await dlRes.blob();
            const arrayBuffer = await blob.arrayBuffer();
            const uint8Array = new Uint8Array(arrayBuffer);
            
            await invoke("write_file_bytes", { path: dbPath, bytes: Array.from(uint8Array) });
            await syncDictionaries();
            setCloudStatus('Словари успешно восстановлены!'); 
        } catch (e) { setCloudStatus("Ошибка: " + e); }
    };

    useEffect(() => {
        if (isOpen && settings.gdriveRefreshToken) {
            setCloudStatus(""); 
            // ИСПРАВЛЕНИЕ: Перехватываем ошибку токена молча
            getAccessToken(settings.gdriveRefreshToken).catch(() => null);
        }
    }, [isOpen, settings.gdriveRefreshToken]);

    if (!isOpen) return null;

    return (
        <div className="tab-content-anim">
            <div id="cloud-main" className={`modern-section ${highlightedSection === 'cloud-main' ? 'card-highlighted' : ''}`}>
            {settings.gdriveRefreshToken ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
                    <div className="modern-card" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', border: '1px solid #4fa6ff', background: 'rgba(79, 166, 255, 0.05)', padding: '15px 20px' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '15px' }}>
                            <div style={{ padding: '10px', background: 'rgba(79, 166, 255, 0.1)', borderRadius: '8px' }}>
                                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="var(--accent-blue)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"></path></svg>
                            </div>
                            <div>
                                <div style={{ color: 'var(--accent-blue)', fontWeight: 'bold', fontSize: '16px' }}>Google Drive подключен</div>
                                <div style={{ color: 'var(--text-muted)', fontSize: '12px' }}>Синхронизация через скрытую папку</div>
                            </div>
                        </div>
                        <button onClick={handleGDriveDisconnect} disabled={isLoading} style={{ background: 'transparent', border: '1px solid rgba(255, 68, 68, 0.3)', color: '#ff4444', borderRadius: '4px', padding: '6px 12px', cursor: 'pointer', fontSize: '12px' }}>Отключить</button>
                    </div>

                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '20px' }}>
                        <div className="modern-card" style={{ border: '1px solid var(--border-main)', background: 'var(--bg-panel)' }}>
                            <div className="card-label" style={{ color: 'var(--text-main)', borderBottom: '1px solid var(--border-main)', paddingBottom: '10px', marginBottom: '15px' }}>Выгрузить в облако (Бэкап)</div>
                            <div style={{ display: 'flex', flexDirection: 'column', gap: '15px', marginBottom: '20px' }}>
                                <label className="checkbox-label" style={{ fontSize: '14px', fontWeight: 'bold' }}>
                                    <input type="checkbox" checked={syncOptions.settings} onChange={(e) => setSyncOptions({ ...syncOptions, settings: e.target.checked })} /> 
                                    Общие настройки
                                </label>
                                <div style={{ background: 'var(--bg-main)', padding: '10px', borderRadius: '6px', border: '1px solid var(--border-main)' }}>
                                    <div style={{ color: 'var(--text-main)', fontSize: '13px', fontWeight: 'bold', marginBottom: '8px' }}>Текущие вкладки ({tabs.length}):</div>
                                    <div className="tiny-scroll" style={{ maxHeight: '150px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '6px' }}>
                                        {tabs.length === 0 ? (
                                            <div style={{ color: 'var(--text-muted)', fontSize: '12px', fontStyle: 'italic' }}>Нет открытых вкладок</div>
                                        ) : (
                                            tabs.map((t: any) => (
                                                <label key={t.id} className="checkbox-label" style={{ fontSize: '13px', margin: 0 }}>
                                                    <input type="checkbox" checked={uploadTabSelections[t.id] || false} onChange={(e) => setUploadTabSelections({ ...uploadTabSelections, [t.id]: e.target.checked })} /> 
                                                    {t.name || 'Безымянная'}
                                                </label>
                                            ))
                                        )}
                                    </div>
                                </div>
                            </div>
                            <button className="btn-primary" onClick={handleGDriveUpload} disabled={isLoading || (!syncOptions.settings && tabs.filter(t => uploadTabSelections[t.id]).length === 0)} style={{ width: '100%', padding: '10px' }}>Отправить выбранное</button>
                        </div>

                        <div className="modern-card" style={{ border: '1px solid var(--border-main)', background: 'var(--bg-panel)', display: 'flex', flexDirection: 'column' }}>
                            <div className="card-label" style={{ display: 'flex', justifyContent: 'space-between', color: 'var(--text-main)', borderBottom: '1px solid var(--border-main)', paddingBottom: '10px', marginBottom: '15px' }}>
                                <span>Загрузить из облака</span>
                                <button onClick={() => handleGDriveRefreshList()} disabled={isLoading} style={{ background: 'transparent', border: 'none', color: 'var(--accent-blue)', cursor: 'pointer', fontSize: '16px' }} title="Обновить список бэкапов">🔄</button>
                            </div>
                            
                            {backupsList.length === 0 && !cloudBackup ? (
                                <div style={{ textAlign: 'center', padding: '20px 0', margin: 'auto 0' }}>
                                    <button className="btn-primary" onClick={() => handleGDriveRefreshList()} disabled={isLoading} style={{ background: 'var(--bg-side)', border: '1px solid var(--accent-blue)', color: 'var(--accent-blue)', padding: '10px 20px' }}>Найти бэкапы</button>
                                </div>
                            ) : !cloudBackup ? (
                                <div style={{ display: 'flex', flexDirection: 'column', gap: '15px' }}>
                                    <div style={{ color: 'var(--text-main)', fontSize: '13px' }}>Выберите бэкап:</div>
                                    <select className="modern-select" value={selectedBackupId} onChange={(e) => setSelectedBackupId(e.target.value)} style={{ padding: '10px', fontSize: '13px' }}>
                                        {backupsList.map((b, i) => (<option key={b.id} value={b.id}>{new Date(b.createdTime).toLocaleString()} {i === 0 ? '(Последний)' : ''}</option>))}
                                    </select>
                                    <button className="btn-primary" onClick={handleGDriveDownload} disabled={isLoading} style={{ width: '100%', padding: '10px' }}>Скачать этот бэкап</button>
                                </div>
                            ) : (
                                <div style={{ display: 'flex', flexDirection: 'column', gap: '15px', animation: 'fadeIn 0.2s' }}>
                                    <div style={{ background: 'rgba(79, 166, 255, 0.1)', border: '1px solid var(--accent-blue)', padding: '8px 12px', borderRadius: '6px', color: 'var(--text-main)', fontSize: '13px' }}>
                                        <strong>Бэкап:</strong> {cloudBackup.metadata?.date ? new Date(cloudBackup.metadata.date).toLocaleString() : 'Старый формат'}
                                    </div>
                                    {!cloudBackup.oldFormat && (
                                        <label className="checkbox-label" style={{ fontSize: '14px', fontWeight: 'bold' }}>
                                            <input type="checkbox" disabled={!cloudBackup.settings} checked={downloadSettingsSelected} onChange={(e) => setDownloadSettingsSelected(e.target.checked)} /> 
                                            Настройки {!cloudBackup.settings && <span style={{ color: 'var(--text-muted)', fontSize: '11px', marginLeft: '5px' }}>(Нет)</span>}
                                        </label>
                                    )}
                                    <div style={{ background: 'var(--bg-main)', padding: '10px', borderRadius: '6px', border: '1px solid var(--border-main)' }}>
                                        <div style={{ color: 'var(--text-main)', fontSize: '13px', fontWeight: 'bold', marginBottom: '8px' }}>Вкладки в бэкапе:</div>
                                        <div className="tiny-scroll" style={{ maxHeight: '150px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '6px' }}>
                                            {!(cloudBackup.tabs && cloudBackup.tabs.length > 0) ? (
                                                <div style={{ color: 'var(--text-muted)', fontSize: '12px', fontStyle: 'italic' }}>Нет вкладок</div>
                                            ) : (
                                                cloudBackup.tabs.map((t: any) => (
                                                    <label key={t.id} className="checkbox-label" style={{ fontSize: '13px', margin: 0 }}>
                                                        <input type="checkbox" checked={downloadTabSelections[t.id] || false} onChange={(e) => setDownloadTabSelections({ ...downloadTabSelections, [t.id]: e.target.checked })} /> 
                                                        {t.name || 'Безымянная'}
                                                    </label>
                                                ))
                                            )}
                                        </div>
                                    </div>
                                    <div style={{ display: 'flex', gap: '10px', marginTop: 'auto' }}>
                                        <button className="btn-primary" onClick={handleGDriveRestore} style={{ flex: 1, padding: '10px', background: '#4CAF50', border: 'none' }}>Применить</button>
                                        <button onClick={() => setCloudBackup(null)} style={{ background: 'var(--bg-main)', border: '1px solid var(--border-main)', color: 'var(--text-muted)', padding: '10px', borderRadius: '6px', cursor: 'pointer' }}>Назад</button>
                                    </div>
                                </div>
                            )}
                        </div>
                    </div>

                    <div className="modern-card" style={{ border: '1px solid #bb86fc', background: 'rgba(187, 134, 252, 0.03)' }}>
                        <div className="card-label" style={{ color: '#bb86fc', borderBottom: '1px solid rgba(187, 134, 252, 0.2)', paddingBottom: '10px', marginBottom: '15px' }}>База данных словарей (.db)</div>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '15px' }}>
                            <div style={{ color: 'var(--text-muted)', fontSize: '13px', maxWidth: '60%' }}>
                                Файл словарей слишком большой для обычного бэкапа. Он выгружается единым архивом через фоновый процесс (Rust).
                            </div>
                            <div style={{ background: 'var(--bg-main)', border: '1px solid var(--border-main)', padding: '10px 15px', borderRadius: '6px', textAlign: 'right' }}>
                                <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>В облаке:</div>
                                {dictCloudInfo ? (
                                    <div style={{ color: 'var(--text-main)', fontSize: '13px', fontWeight: 'bold' }}>
                                        {new Date(dictCloudInfo.modifiedTime).toLocaleDateString()}
                                        {dictCloudInfo.size && <span style={{ color: 'var(--accent-blue)', marginLeft: '8px' }}>({(Number(dictCloudInfo.size) / 1024 / 1024).toFixed(1)} МБ)</span>}
                                    </div>
                                ) : (
                                    <div style={{ color: '#ff4444', fontSize: '13px' }}>Не найдено</div>
                                )}
                            </div>
                        </div>
                        <div style={{ display: 'flex', gap: '15px' }}>
                            <button onClick={handleBackupDictionaryDB} disabled={isLoading} style={{ flex: 1, padding: '10px', background: 'rgba(187, 134, 252, 0.1)', color: '#bb86fc', border: '1px solid #bb86fc', borderRadius: '6px', cursor: isLoading ? 'default' : 'pointer', fontWeight: 'bold' }}>
                                Выгрузить словари в облако
                            </button>
                            <button onClick={handleRestoreDictionaryDB} disabled={isLoading || !dictCloudInfo} style={{ flex: 1, padding: '10px', background: 'var(--bg-main)', color: dictCloudInfo ? 'var(--text-main)' : 'var(--text-muted)', border: '1px solid var(--border-main)', borderRadius: '6px', cursor: (isLoading || !dictCloudInfo) ? 'default' : 'pointer' }}>
                                Скачать и применить
                            </button>
                        </div>
                    </div>

                    <div style={{ gridColumn: '1 / -1' }}>
                        {syncProgress > 0 && (
                            <div style={{ width: '100%', height: '4px', background: 'var(--bg-main)', borderRadius: '2px', overflow: 'hidden', marginBottom: '10px' }}>
                                <div style={{ width: `${syncProgress}%`, height: '100%', background: 'var(--accent-blue)', transition: 'width 0.2s ease-out' }} />
                            </div>
                        )}
                        {cloudStatus && (
                            <div style={{ padding: '10px', background: 'var(--bg-side)', borderRadius: '4px', border: '1px solid var(--border-main)', color: 'var(--text-main)', textAlign: 'center', fontSize: '13px' }}>{cloudStatus}</div>
                        )}
                    </div>
                </div>
            ) : (
                <div className="modern-card" style={{ background: 'var(--bg-panel)', border: '1px solid var(--border-main)' }}>
                    <div className="card-label" style={{ fontSize: '16px', color: 'var(--text-main)' }}>Синхронизация через Google Drive</div>
                    <div style={{ color: 'var(--text-muted)', fontSize: '13px', marginBottom: '20px', lineHeight: '1.5' }}>Ваши данные будут сохраняться в скрытой системной папке приложения. Никакие другие файлы затронуты не будут.</div>
                    
                    {authStep === 1 ? (
                        <div style={{ background: 'var(--bg-main)', padding: '20px', borderRadius: '8px', border: '1px dashed var(--accent-blue)' }}>
                            <div style={{ color: 'var(--text-main)', marginBottom: '10px', fontSize: '15px', textAlign: 'center' }}>Ожидание ответа от браузера... ⏳</div>
                            <div style={{ textAlign: 'center', marginBottom: '20px' }}>
                                <button className="btn-primary" onClick={async () => { try { await openUrl(getAuthUrl()); } catch (e) {} }} style={{ display: 'inline-block', padding: '10px 20px', border: 'none', borderRadius: '6px', cursor: 'pointer', fontSize: '14px' }}>
                                    Открыть Google для входа
                                </button>
                            </div>
                            <div style={{ borderTop: '1px solid var(--border-main)', paddingTop: '15px', marginTop: '15px' }}>
                                <div style={{ color: 'var(--text-muted)', fontSize: '12px', marginBottom: '8px' }}>Если автоматический вход не сработал, вставьте URL с ошибкой сюда:</div>
                                <div style={{ display: 'flex', gap: '10px' }}>
                                    <input type="text" className="modern-input" placeholder="http://127.0.0.1:1337/?state=...&code=..." value={authCodeInput} onChange={(e) => setAuthCodeInput(e.target.value)} style={{ flex: 1, fontFamily: 'monospace', background: 'var(--bg-panel)', color: 'var(--text-main)', border: '1px solid var(--border-main)' }} />
                                    <button className="btn-primary" onClick={() => handleGDriveSubmitCode()} disabled={isLoading || !authCodeInput.trim()}>Подключить</button>
                                </div>
                            </div>
                            <button onClick={() => setAuthStep(0)} style={{ background: 'transparent', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', marginTop: '15px', fontSize: '12px', width: '100%', textAlign: 'center' }}>Отмена</button>
                        </div>
                    ) : (
                        <button className="btn-primary" onClick={handleGDriveStartAuth} disabled={isLoading} style={{ width: '100%', padding: '12px', fontSize: '14px' }}>Авторизоваться через Google</button>
                    )}
                    {cloudStatus && <div style={{ marginTop: '15px', padding: '10px', background: 'var(--bg-side)', borderRadius: '4px', border: '1px solid var(--border-main)', color: 'var(--text-main)', textAlign: 'center', fontSize: '13px' }}>{cloudStatus}</div>}
                </div>
            )}
            </div>
        </div>
    );
}