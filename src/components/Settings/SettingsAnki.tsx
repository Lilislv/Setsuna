import { useState, useEffect } from "react";
import { invoke } from '@tauri-apps/api/core';
import { getDecks, getModels, getModelFields, clearAnkiMetaCache } from "../../utils/anki";
import { AppSettings } from "../SettingsModal";

interface SettingsAnkiProps {
    settings: AppSettings;
    updateSetting: <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => void;
    updateMultipleSettings?: (newValues: Partial<AppSettings>) => void; // НОВАЯ ФУНКЦИЯ ДЛЯ ПАКЕТНОГО ОБНОВЛЕНИЯ
    highlightedSection: string | null;
    isOpen: boolean;
}

export default function SettingsAnki({ settings, updateSetting, updateMultipleSettings, highlightedSection, isOpen }: SettingsAnkiProps) {
    const [ankiDecks, setAnkiDecks] = useState<string[]>([]);
    const [ankiModels, setAnkiModels] = useState<string[]>([]);
    const [ankiFields, setAnkiFields] = useState<string[]>([]);
    const [ankiConnected, setAnkiConnected] = useState(true);

    const [runningProcesses, setRunningProcesses] = useState<any[]>([]);
    const [isProcessMenuOpen, setIsProcessMenuOpen] = useState(false);
    const [processSearch, setProcessSearch] = useState("");
    const [showAdvancedFields, setShowAdvancedFields] = useState(false);

    const loadAnkiData = async () => {
        try {
            const decks = await getDecks();
            if (decks && decks.length > 0) { 
                setAnkiDecks(decks); setAnkiConnected(true); 
                if (!settings.ankiDeck) updateSetting('ankiDeck', decks[0]); 
                const models = await getModels();
                if (models && models.length > 0) { 
                    setAnkiModels(models); 
                    if (!settings.ankiModel) updateSetting('ankiModel', models[0]); 
                }
            } else { 
                setAnkiConnected(false); 
            }
        } catch(e) {
            setAnkiConnected(false);
        }
    };

    useEffect(() => { if (isOpen) loadAnkiData(); }, [isOpen]);
    useEffect(() => { if (settings.ankiModel && isOpen) { getModelFields(settings.ankiModel).then(fields => setAnkiFields(fields)); } }, [settings.ankiModel, isOpen]);

    const normalizeFieldName = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, "");

    const findField = (...candidates: string[]) => {
        const normalizedCandidates = candidates.map(normalizeFieldName);
        return ankiFields.find((field) => normalizedCandidates.includes(normalizeFieldName(field))) || "none";
    };

    const applyLapisPreset = (force = true) => {
        if (ankiFields.length === 0) return;

        const preset: Partial<AppSettings> = {
            ankiFieldWord: findField("Expression"),
            ankiFieldReading: findField("ExpressionFurigana", "Reading", "Furigana"),
            ankiFieldMeaning: findField("MainDefinition", "Definition", "Meaning"),
            ankiFieldSentence: findField("Sentence"),
            ankiFieldDict: findField("Dictionary", "Source"),
            ankiFieldAudio: findField("ExpressionAudio", "Audio"),
            ankiFieldPitch: findField("PitchPosition", "Pitch", "PitchAccent"),
            ankiFieldFreq: findField("Frequency", "Freq"),
            ankiFieldScreenshot: findField("DefinitionPicture", "Picture", "Screenshot", "Image"),
        };

        if (!force) {
            const alreadyConfigured = Boolean(
                settings.ankiFieldWord &&
                settings.ankiFieldWord !== "none" &&
                settings.ankiFieldReading &&
                settings.ankiFieldReading !== "none" &&
                settings.ankiFieldMeaning &&
                settings.ankiFieldMeaning !== "none"
            );

            if (alreadyConfigured) return;
        }

        if (updateMultipleSettings) {
            updateMultipleSettings(preset);
            return;
        }

        Object.entries(preset).forEach(([key, value]) => {
            updateSetting(key as keyof AppSettings, value as any);
        });
    };

    useEffect(() => {
        if (!isOpen || ankiFields.length === 0) return;
        if (!/lapis/i.test(settings.ankiModel || "")) return;
        applyLapisPreset(false);
    }, [isOpen, ankiFields.join("|"), settings.ankiModel]);

    const fetchProcesses = async () => {
        setIsProcessMenuOpen(true);
        try {
            const list = await invoke<any[]>('get_running_processes');
            if (Array.isArray(list)) { setRunningProcesses(list); } else { setRunningProcesses([]); }
        } catch (e) {
            console.error("Ошибка загрузки процессов", e);
            setRunningProcesses([]);
        }
    };

    const addProcess = (proc: any) => {
        if (!proc) return;
        const procName = typeof proc === 'string' ? proc : proc.name;
        const procIcon = typeof proc === 'string' ? undefined : proc.icon;
        if (!procName) return;

        const current = settings.hookProcesses || [];
        if (!current.find(p => p.name === procName)) {
            updateSetting('hookProcesses', [...current, { name: procName, active: true, icon: procIcon }]);
        }
        setIsProcessMenuOpen(false);
        setProcessSearch("");
    };

    const getAvatarColor = (name: string) => {
        if (!name) return '#4fa6ff';
        let hash = 0;
        for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
        return `hsl(${Math.abs(hash % 360)}, 65%, 45%)`;
    };

    if (!isOpen) return null;

    return (
        <div className="tab-content-anim">
            <div className="modern-card" style={{ background: 'var(--bg-panel)', border: `1px solid ${ankiConnected ? '#4CAF50' : '#ff4444'}` }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                        <div style={{ width: '12px', height: '12px', borderRadius: '50%', background: ankiConnected ? '#4CAF50' : '#ff4444', boxShadow: `0 0 10px ${ankiConnected ? '#4CAF50' : '#ff4444'}` }}></div>
                        <span style={{ color: 'var(--text-main)', fontWeight: 'bold' }}>
                            AnkiConnect: {ankiConnected ? 'Подключено' : 'Не найдено'}
                        </span>
                    </div>
                    <button
                        onClick={async () => {
                            clearAnkiMetaCache();
                            await loadAnkiData();
                        }}
                        className="btn-primary"
                        style={{
                            padding: '6px 12px',
                            fontSize: '12px',
                            background: 'var(--bg-side)',
                            border: '1px solid var(--border-main)',
                            color: 'var(--text-main)'
                        }}
                    >
                        {ankiConnected ? '🔄 Обновить подключение' : 'Повторить попытку'}
                    </button>
                </div>
                {!ankiConnected && (
                    <div style={{ marginTop: '10px', color: 'var(--text-muted)', fontSize: '12px' }}>
                        Убедитесь, что программа Anki запущена, и установлен аддон AnkiConnect (код 2055492159).
                    </div>
                )}
            </div>

            {ankiConnected && (
                <>
                    <div id="anki-cards" className={`modern-card ${highlightedSection === 'anki-cards' ? 'card-highlighted' : ''}`} style={{ background: 'var(--bg-panel)', border: '1px solid var(--border-main)' }}>
                        <div className="card-label" style={{ color: 'var(--text-main)' }}>Настройки колоды</div>
                        <div style={{ display: 'flex', gap: '15px', marginBottom: '20px' }}>
                            <div style={{ flex: 1 }}><div style={{ fontSize: '12px', color: 'var(--text-muted)', marginBottom: '6px' }}>Колода:</div><select className="modern-select" value={settings.ankiDeck} onChange={(e) => updateSetting('ankiDeck', e.target.value)}>{ankiDecks.map(d => <option key={d} value={d}>{d}</option>)}</select></div>
                            <div style={{ flex: 1 }}><div style={{ fontSize: '12px', color: 'var(--text-muted)', marginBottom: '6px' }}>Модель:</div><select className="modern-select" value={settings.ankiModel} onChange={(e) => updateSetting('ankiModel', e.target.value)}>{ankiModels.map(m => <option key={m} value={m}>{m}</option>)}</select></div>
                        </div>
                        <div style={{
                            borderTop: '1px solid var(--border-main)',
                            paddingTop: '15px',
                            display: 'flex',
                            justifyContent: 'space-between',
                            alignItems: 'center',
                            gap: '12px'
                        }}>
                            <div>
                                <div className="card-label" style={{ margin: 0, color: 'var(--text-main)' }}>
                                    Формат карточки
                                </div>
                                <div style={{ color: 'var(--text-muted)', fontSize: '12px', marginTop: '6px' }}>
                                    По умолчанию используется безопасный пресет Lapis/Lapis++++. Ручные поля нужны только если ты специально меняешь шаблон карточки.
                                </div>
                            </div>

                            <div style={{ display: 'flex', gap: '8px', flexShrink: 0 }}>
                                <button
                                    onClick={() => applyLapisPreset(true)}
                                    style={{
                                        background: 'var(--bg-side)',
                                        color: 'var(--text-main)',
                                        border: '1px solid var(--border-main)',
                                        padding: '6px 12px',
                                        borderRadius: '6px',
                                        cursor: 'pointer',
                                        fontSize: '12px'
                                    }}
                                >
                                    Пресет Lapis++++
                                </button>

                                <button
                                    onClick={() => setShowAdvancedFields((v) => !v)}
                                    style={{
                                        background: 'transparent',
                                        color: showAdvancedFields ? 'var(--accent-blue)' : 'var(--text-muted)',
                                        border: '1px solid var(--border-main)',
                                        padding: '6px 12px',
                                        borderRadius: '6px',
                                        cursor: 'pointer',
                                        fontSize: '12px'
                                    }}
                                >
                                    {showAdvancedFields ? 'Скрыть поля' : 'Опытные настройки'}
                                </button>
                            </div>
                        </div>

                        {!showAdvancedFields && (
                            <div style={{
                                marginTop: '14px',
                                padding: '12px',
                                borderRadius: '8px',
                                background: 'var(--bg-side)',
                                color: 'var(--text-muted)',
                                fontSize: '12px',
                                lineHeight: 1.5
                            }}>
                                Активная модель: <b style={{ color: 'var(--text-main)' }}>{settings.ankiModel || 'не выбрана'}</b>.
                                Для Lapis/Lapis++++ поля выставляются автоматически. Если карточка добавляется неправильно, открой опытные настройки и проверь поля вручную.
                            </div>
                        )}

                        {showAdvancedFields && (
                            <div style={{
                                marginTop: '15px',
                                display: 'grid',
                                gridTemplateColumns: '1fr 1fr',
                                gap: '15px'
                            }}>
                                {[ 
                                    { type: 'Word', label: 'Слово' },
                                    { type: 'Reading', label: 'Чтение' },
                                    { type: 'Meaning', label: 'Перевод' },
                                    { type: 'Sentence', label: 'Предложение' },
                                    { type: 'Dict', label: 'Словарь' },
                                    { type: 'Audio', label: 'Аудио' },
                                    { type: 'Pitch', label: 'Питч-акцент' },
                                    { type: 'Freq', label: 'Частотность' },
                                    { type: 'Screenshot', label: 'Скриншот' }
                                ].map(({ type, label }) => {
                                    const settingKey = `ankiField${type}` as keyof AppSettings;

                                    return (
                                        <div key={type} style={{ display: 'flex', alignItems: 'center' }}>
                                            <div style={{
                                                width: '110px',
                                                color: 'var(--text-muted)',
                                                fontSize: '12px'
                                            }}>
                                                {label}:
                                            </div>

                                            <select
                                                className="modern-select"
                                                style={{ flex: 1, marginTop: 0 }}
                                                value={(settings[settingKey] as string) || 'none'}
                                                onChange={(e) => updateSetting(settingKey, e.target.value)}
                                            >
                                                <option value="none">-- Пусто --</option>
                                                {ankiFields.map((field) => (
                                                    <option key={field} value={field}>{field}</option>
                                                ))}
                                            </select>
                                        </div>
                                    );
                                })}
                            </div>
                        )}
                    </div>

                    <div id="anki-hooks" className={`modern-card ${highlightedSection === 'anki-hooks' ? 'card-highlighted' : ''}`} style={{ background: 'var(--bg-panel)', border: '1px solid var(--border-main)' }}>
                        <div className="card-label" style={{ color: 'var(--text-main)' }}>Умные скриншоты и кнопки</div>
                        
                        <div style={{ marginBottom: '15px', display: 'flex', flexDirection: 'column', gap: '10px' }}>
                            <label className="checkbox-label"><input type="checkbox" checked={settings.ankiShowButtonNormal ?? true} onChange={(e) => updateSetting('ankiShowButtonNormal', e.target.checked)} /> Показывать обычную кнопку добавления (+)</label>
                            <label className="checkbox-label"><input type="checkbox" checked={settings.ankiShowButtonScreenshot ?? true} onChange={(e) => updateSetting('ankiShowButtonScreenshot', e.target.checked)} /> Показывать кнопку со скриншотом (+ 📷)</label>
                        </div>

                        <div style={{ color: 'var(--text-muted)', fontSize: '12px', marginBottom: '10px', borderTop: '1px solid var(--border-main)', paddingTop: '15px' }}>
                            Процесс игры для авто-скриншота:
                        </div>
                        
                        <div style={{ display: 'flex', gap: '10px', position: 'relative', marginBottom: '15px' }}>
                            <div style={{ flex: 1, color: 'var(--text-muted)', fontSize: '13px', display: 'flex', alignItems: 'center' }}>
                                Выберите процесс из списка, чтобы программа делала скриншот именно этого окна.
                            </div>
                            <button onClick={fetchProcesses} className="btn-primary" style={{ padding: '8px 16px' }}>
                                🔍 Найти игру
                            </button>

                            {isProcessMenuOpen && (
                                <div style={{ position: 'absolute', top: '100%', left: 0, right: 0, marginTop: '8px', background: 'var(--bg-panel)', border: '1px solid var(--accent-blue)', borderRadius: '8px', zIndex: 100, boxShadow: '0 10px 25px rgba(0,0,0,0.5)', overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
                                    <div style={{ padding: '10px', borderBottom: '1px solid var(--border-main)', display: 'flex', gap: '10px', background: 'var(--bg-main)' }}>
                                        <input 
                                            autoFocus
                                            type="text" 
                                            className="modern-input" 
                                            placeholder="Поиск по запущенным..." 
                                            value={processSearch} 
                                            onChange={(e) => setProcessSearch(e.target.value)} 
                                            style={{ flex: 1, padding: '6px 10px' }} 
                                        />
                                        <button onClick={() => {setIsProcessMenuOpen(false); setProcessSearch("");}} style={{ background: 'transparent', border: 'none', color: 'var(--text-muted)', cursor: 'pointer' }}>✕</button>
                                    </div>
                                    <div className="tiny-scroll" style={{ maxHeight: '250px', overflowY: 'auto' }}>
                                        {runningProcesses.length === 0 ? (
                                            <div style={{ padding: '15px', textAlign: 'center', color: 'var(--text-muted)', fontSize: '13px' }}>Загрузка...</div>
                                        ) : (
                                            runningProcesses
                                                .filter((p: any) => {
                                                    const procName = typeof p === 'string' ? p : (p?.name || "");
                                                    return procName.toLowerCase().includes(processSearch.toLowerCase());
                                                })
                                                .map((p: any) => {
                                                    const procName = typeof p === 'string' ? p : p.name;
                                                    const procIcon = typeof p === 'string' ? undefined : p.icon;
                                                    return (
                                                        <div 
                                                            key={procName} 
                                                            onClick={() => addProcess({ name: procName, icon: procIcon })}
                                                            style={{ padding: '10px 15px', cursor: 'pointer', borderBottom: '1px solid var(--border-main)', fontSize: '13px', color: 'var(--text-main)', transition: '0.1s', display: 'flex', alignItems: 'center', gap: '10px' }}
                                                            className="hover-item"
                                                            onMouseOver={(e) => e.currentTarget.style.background = 'var(--hover-bg)'}
                                                            onMouseOut={(e) => e.currentTarget.style.background = 'transparent'}
                                                        >
                                                            {procIcon ? (
                                                                <img src={`data:image/png;base64,${procIcon}`} style={{ width: '24px', height: '24px' }} alt="icon" />
                                                            ) : (
                                                                <div style={{ width: '24px', height: '24px', background: getAvatarColor(procName), borderRadius: '4px', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 'bold', color: '#fff', fontSize: '12px' }}>
                                                                    {procName.charAt(0).toUpperCase()}
                                                                </div>
                                                            )}
                                                            <span>{procName}</span>
                                                        </div>
                                                    );
                                                })
                                        )}
                                    </div>
                                </div>
                            )}
                        </div>

                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: '10px' }}>
                            {(settings.hookProcesses || []).map((proc, idx) => (
                                <div key={idx} style={{ display: 'flex', alignItems: 'center', background: 'var(--bg-side)', padding: '10px', borderRadius: '6px', border: '1px solid var(--border-main)' }}>
                                    <input type="checkbox" checked={proc.active} onChange={(e) => {
                                        const newProcs = [...settings.hookProcesses];
                                        newProcs[idx].active = e.target.checked;
                                        updateSetting('hookProcesses', newProcs);
                                    }} style={{ accentColor: 'var(--accent-blue)', width: '16px', height: '16px', cursor: 'pointer' }} />
                                    <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flex: 1, marginLeft: '10px', minWidth: 0 }}>
                                        {proc.icon ? (
                                            <img src={`data:image/png;base64,${proc.icon}`} style={{ width: '24px', height: '24px', flexShrink: 0 }} alt="icon" />
                                        ) : (
                                            <div style={{ width: '24px', height: '24px', background: getAvatarColor(proc.name), borderRadius: '4px', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontWeight: 'bold', fontSize: '12px', flexShrink: 0 }}>
                                                {proc.name.charAt(0).toUpperCase()}
                                            </div>
                                        )}
                                        <span style={{ color: proc.active ? 'var(--text-main)' : 'var(--text-muted)', fontSize: '13px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} title={proc.name}>
                                            {proc.name}
                                        </span>
                                    </div>
                                    <button onClick={() => {
                                        const newProcs = settings.hookProcesses.filter((_, i) => i !== idx);
                                        updateSetting('hookProcesses', newProcs);
                                    }} style={{ background: 'rgba(255, 68, 68, 0.1)', color: '#ff4444', border: '1px solid rgba(255, 68, 68, 0.3)', borderRadius: '4px', padding: '4px 8px', cursor: 'pointer', flexShrink: 0 }}>✕</button>
                                </div>
                            ))}
                        </div>

                    </div>

                    <div className="modern-card" style={{ background: 'var(--bg-panel)', border: '1px solid var(--border-main)' }}>
                        <div className="card-label" style={{ color: 'var(--text-main)' }}>Проверка дубликатов (Цветовая индикация)</div>
                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '10px', marginBottom: '15px' }}>
                            <div><div style={{ fontSize: '11px', color: 'var(--text-muted)', marginBottom: '4px' }}>Новая</div><input type="color" value={settings.ankiColorNew || '#4CAF50'} onChange={(e) => updateSetting('ankiColorNew', e.target.value)} style={{ width: '100%', height: '30px', border: 'none', cursor: 'pointer', background: 'transparent' }} /></div>
                            <div><div style={{ fontSize: '11px', color: 'var(--text-muted)', marginBottom: '4px' }}>Уже есть (Другая колода)</div><input type="color" value={settings.ankiColorOther || '#4fa6ff'} onChange={(e) => updateSetting('ankiColorOther', e.target.value)} style={{ width: '100%', height: '30px', border: 'none', cursor: 'pointer', background: 'transparent' }} /></div>
                            <div><div style={{ fontSize: '11px', color: 'var(--text-muted)', marginBottom: '4px' }}>Уже есть (Эта колода)</div><input type="color" value={settings.ankiColorSame || '#ff4444'} onChange={(e) => updateSetting('ankiColorSame', e.target.value)} style={{ width: '100%', height: '30px', border: 'none', cursor: 'pointer', background: 'transparent' }} /></div>
                        </div>
                        <label className="checkbox-label" style={{ marginBottom: '10px' }}><input type="checkbox" checked={settings.ankiAllowDuplicatesOther ?? true} onChange={(e) => updateSetting('ankiAllowDuplicatesOther', e.target.checked)} /> Разрешить добавлять дубликаты из других колод</label>
                        <label className="checkbox-label"><input type="checkbox" checked={settings.ankiAllowDuplicatesSame ?? false} onChange={(e) => updateSetting('ankiAllowDuplicatesSame', e.target.checked)} /> Разрешить добавлять дубликаты из этой же колоды</label>
                    </div>
                </>
            )}
        </div>
    );
}