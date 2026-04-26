import { useState, useEffect } from "react";
import { open } from '@tauri-apps/plugin-dialog';
import { invoke } from '@tauri-apps/api/core';
import { DndContext, closestCenter, KeyboardSensor, PointerSensor, useSensor, useSensors } from '@dnd-kit/core';
import { arrayMove, SortableContext, sortableKeyboardCoordinates, verticalListSortingStrategy, useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { LookupEntryItem, groupDictionaryEntries } from "../Lookuper";
import { AppSettings } from "../SettingsModal";

interface SettingsLookupProps {
    settings: AppSettings;
    updateSetting: <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => void;
    highlightedSection: string | null;
    isOpen: boolean;
    syncDictionaries: () => Promise<void>;
    runDictImport: (path: string) => Promise<void>;
    setConfirmDialog: (dialog: any) => void;
}

function SortableDictItem({ dict, idx, totalLen, toggleDict, changeDictColor, deleteDict, moveDict, toggleSelection, isSelected, isSelectionMode }: any) {
    const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: dict.name });
    const style = { transform: CSS.Transform.toString(transform), transition, display: 'flex', flexDirection: 'column' as const, alignItems: 'stretch', background: isSelected ? 'var(--hover-bg)' : 'var(--bg-side)', border: isSelected ? '1px solid var(--accent-blue)' : '1px solid transparent', padding: '8px', marginBottom: '6px', borderRadius: '4px', opacity: isDragging ? 0.9 : 1, boxShadow: isDragging ? '0 0 15px rgba(79, 166, 255, 0.6)' : 'none', zIndex: isDragging ? 99 : 0, position: 'relative' as any, cursor: isSelectionMode ? 'pointer' : 'default' };

    return (
        <div ref={setNodeRef} style={style} onClick={() => isSelectionMode && toggleSelection(dict.name)}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px', width: '100%' }}>
                <span {...attributes} {...listeners} style={{ color: 'var(--text-muted)', fontSize: '18px', padding: '0 5px', cursor: 'grab', touchAction: 'none' }}>≡</span>
                <span style={{ color: 'var(--text-muted)', fontSize: '12px', width: '20px', textAlign: 'right', userSelect: 'none' }}>{idx + 1}.</span>
                {!isSelectionMode && ( <input type="checkbox" checked={dict.active} onChange={() => toggleDict(idx)} style={{ cursor: 'pointer' }} /> )}
                <span style={{ color: dict.active || isSelectionMode ? 'var(--text-main)' : 'var(--text-muted)', fontSize: '14px', flex: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', userSelect: 'none' }}>{dict.name}</span>
                <input type="color" value={dict.color || "#4fa6ff"} onChange={(e) => changeDictColor(idx, e.target.value)} onClick={(e) => isSelectionMode && e.stopPropagation()} style={{ width: '24px', height: '24px', border: 'none', background: 'none', cursor: 'pointer', padding: 0 }} title="Цвет словаря" />
                <div style={{ display: 'flex', gap: '4px', marginRight: '5px' }}>
                    <button onClick={(e) => { e.stopPropagation(); moveDict(idx, -1); }} disabled={idx === 0} style={{ background: 'var(--bg-main)', color: 'var(--text-main)', border: '1px solid var(--border-main)', padding: '2px 6px', borderRadius: '4px', cursor: idx === 0 ? 'default' : 'pointer', opacity: idx === 0 ? 0.3 : 1 }}>↑</button>
                    <button onClick={(e) => { e.stopPropagation(); moveDict(idx, 1); }} disabled={idx === totalLen - 1} style={{ background: 'var(--bg-main)', color: 'var(--text-main)', border: '1px solid var(--border-main)', padding: '2px 6px', borderRadius: '4px', cursor: idx === totalLen - 1 ? 'default' : 'pointer', opacity: idx === totalLen - 1 ? 0.3 : 1 }}>↓</button>
                    {/* НОВАЯ КНОПКА УДАЛЕНИЯ */}
                    <button onClick={(e) => { e.stopPropagation(); deleteDict(idx); }} style={{ background: 'rgba(255,68,68,0.1)', color: '#ff4444', border: '1px solid rgba(255,68,68,0.3)', padding: '2px 6px', borderRadius: '4px', cursor: 'pointer', marginLeft: '4px' }} title="Удалить словарь">✕</button>
                </div>
            </div>
        </div>
    );
}

export default function SettingsLookup({ settings, updateSetting, highlightedSection, isOpen, syncDictionaries, runDictImport, setConfirmDialog }: SettingsLookupProps) {
    const [isSelectionMode, setIsSelectionMode] = useState(false);
    const [selectedDicts, setSelectedDicts] = useState<string[]>([]);
    const [previewWord, setPreviewWord] = useState('刹那');
    const [previewEntries, setPreviewEntries] = useState<any[]>([]);
    const [activeGrammarDesc, setActiveGrammarDesc] = useState<string | null>(null);

    useEffect(() => {
        if (!isOpen) return;
        const wordToSearch = previewWord.trim() || '刹那';
        const timer = setTimeout(() => {
            invoke('scan_cursor', { sentence: wordToSearch, cursor: 0 }).then((res: any) => {
                if (res && res.entries && res.entries.length > 0) setPreviewEntries(res.entries);
                else invoke('lookup_word', { word: wordToSearch }).then((res2: any) => setPreviewEntries(res2 || [])).catch(() => setPreviewEntries([]));
            }).catch(() => setPreviewEntries([]));
        }, 400);
        return () => clearTimeout(timer);
    }, [previewWord, settings.dictionaries, isOpen]);

    let finalPreviewEntries = previewEntries;
    if (finalPreviewEntries.length === 0) {
        const activeDicts = settings?.dictionaries?.filter(d => d.active) || [];
        const fallbackDictName = activeDicts.length > 0 ? activeDicts[0].name : 'JMdict';
        finalPreviewEntries = [{
            term: previewWord.trim() || '刹那', reading: 'せつな', definition: '1. Момент, мгновение.\n2. Доля секунды.',
            dict_name: fallbackDictName, tags: ['Noun', 'Temporal noun'], deinflection_reasons: [], frequencies: [{ dict_name: 'VN Freq', display_value: '2500', value: 2500 }],
            pitches: [{ dict_name: 'NHK', reading: 'せつな', position: 0 }], source_length: (previewWord.trim() || '刹那').length
        }];
    }

    const groupedPreview = groupDictionaryEntries(finalPreviewEntries, settings, false);

    const handleDictionaryImport = async () => {
        try {
            const selectedPath = await open({ multiple: false, filters: [{ name: 'Dictionaries', extensions: ['zip', 'json'] }] });
            if (selectedPath && typeof selectedPath === 'string') runDictImport(selectedPath);
        } catch (e) {}
    };

    const handleDeleteSelected = () => {
        if (selectedDicts.length === 0) return;
        setConfirmDialog({
            title: 'Удаление',
            message: `Удалить ${selectedDicts.length} выделенных словарей?`,
            onConfirm: async () => {
                const newList = settings.dictionaries.filter(d => !selectedDicts.includes(d.name));
                updateSetting('dictionaries', newList); setSelectedDicts([]);
                try { await invoke("delete_dictionaries", { dictNames: [...selectedDicts] }); syncDictionaries(); } catch(e) { syncDictionaries(); }
            }
        });
    };

    const handleDeleteAll = () => {
        if (settings.dictionaries.length === 0) return;
        setConfirmDialog({
            title: 'ВНИМАНИЕ',
            message: `Вы собираетесь удалить ВСЕ словари. Эта операция необратима. Продолжить?`,
            onConfirm: async () => {
                updateSetting('dictionaries', []); setSelectedDicts([]);
                try { await invoke("clear_database"); syncDictionaries(); } catch(e) { syncDictionaries(); }
            }
        });
    };

    const toggleSelection = (name: string) => { setSelectedDicts(prev => prev.includes(name) ? prev.filter(n => n !== name) : [...prev, name]); };
    const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }), useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }));
    
    const handleDragEnd = (event: any) => {
        const { active, over } = event; if (!over || active.id === over.id) return;
        let newDicts = [...settings.dictionaries];
        if (isSelectionMode && selectedDicts.includes(active.id)) {
            const selectedItems = newDicts.filter(d => selectedDicts.includes(d.name));
            newDicts = newDicts.filter(d => !selectedDicts.includes(d.name));
            let dropIndex = newDicts.findIndex(d => d.name === over.id);
            if (dropIndex === -1) dropIndex = newDicts.length;
            newDicts.splice(dropIndex, 0, ...selectedItems);
        } else {
            const oldIndex = newDicts.findIndex(d => d.name === active.id);
            const newIndex = newDicts.findIndex(d => d.name === over.id);
            newDicts = arrayMove(newDicts, oldIndex, newIndex);
        }
        updateSetting('dictionaries', newDicts);
    };

    const moveDict = (index: number, direction: -1 | 1) => {
        const newList = [...settings.dictionaries]; const targetIndex = index + direction;
        if (targetIndex < 0 || targetIndex >= newList.length) return;
        [newList[index], newList[targetIndex]] = [newList[targetIndex], newList[index]]; updateSetting('dictionaries', newList);
    };

    const toggleDict = (index: number) => { 
        const newList = [...settings.dictionaries]; 
        newList[index] = { ...newList[index], active: !newList[index].active }; 
        updateSetting('dictionaries', newList); 
    };

    const changeDictColor = (index: number, color: string) => { 
        const newList = [...settings.dictionaries]; 
        newList[index] = { ...newList[index], color }; 
        updateSetting('dictionaries', newList); 
    };

    // ФУНКЦИЯ УДАЛЕНИЯ ОДНОГО СЛОВАРЯ
    const deleteDict = (index: number) => {
        const dictName = settings.dictionaries[index].name;
        setConfirmDialog({
            title: 'Удаление',
            message: `Удалить словарь "${dictName}"?`,
            onConfirm: async () => {
                const newList = settings.dictionaries.filter((_, i) => i !== index);
                updateSetting('dictionaries', newList);
                try { await invoke("delete_dictionaries", { dictNames: [dictName] }); syncDictionaries(); } catch(e) { syncDictionaries(); }
            }
        });
    };

    if (!isOpen) return null;

    return (
        <div className="tab-content-anim">
            <div id="lookup-win" className={`modern-card ${highlightedSection === 'lookup-win' ? 'card-highlighted' : ''}`} style={{ background: 'var(--bg-panel)', border: '1px solid var(--border-main)' }}>
                <div className="card-label" style={{ color: 'var(--text-main)' }}>Настройки окна предпросмотра</div>
                
                <div style={{ display: 'flex', gap: '15px', alignItems: 'center', marginBottom: '15px' }}>
                    <span style={{ color: 'var(--text-muted)', fontSize: '13px', width: '150px' }}>Горячая клавиша:</span>
                    <select className="modern-select" value={settings.lookupHotkey} onChange={(e) => updateSetting('lookupHotkey', e.target.value as any)} style={{ flex: 1, marginTop: 0 }}><option value="Shift">Shift</option><option value="Control">Ctrl</option><option value="Alt">Alt</option></select>
                </div>
                
                <div style={{ display: 'flex', gap: '15px', alignItems: 'center', marginBottom: '15px' }}>
                    <span style={{ color: 'var(--text-muted)', fontSize: '13px', width: '150px' }}>Масштаб окна (Zoom):</span>
                    <input type="range" min="0.5" max="1.5" step="0.1" value={settings.lookupScale || 1.0} onChange={(e) => updateSetting('lookupScale', Number(e.target.value))} style={{ flex: 1 }} />
                    <span style={{ color: 'var(--text-main)', width: '40px', textAlign: 'center', fontWeight: 'bold' }}>{Math.round((settings.lookupScale || 1.0) * 100)}%</span>
                </div>
                
                <div style={{ display: 'flex', gap: '15px', alignItems: 'center', marginBottom: '15px' }}>
                    <span style={{ color: 'var(--text-muted)', fontSize: '12px', width: '150px' }}>Базовая ширина:</span>
                    <input type="range" min="250" max="800" step="10" value={settings.lookupWidth || 380} onChange={(e) => updateSetting('lookupWidth', Number(e.target.value))} style={{ flex: 1 }} />
                    <span style={{ color: 'var(--text-muted)', width: '40px', textAlign: 'center', fontSize: '12px' }}>{settings.lookupWidth || 380}px</span>
                </div>

                <div style={{ display: 'flex', gap: '15px', alignItems: 'center', marginBottom: '15px' }}>
                    <span style={{ color: 'var(--text-muted)', fontSize: '12px', width: '150px' }}>Размер текста (px):</span>
                    <input type="range" min="10" max="36" step="1" value={settings.lookupFontSize || 14} onChange={(e) => updateSetting('lookupFontSize', Number(e.target.value))} style={{ flex: 1 }} />
                    <span style={{ color: 'var(--text-muted)', width: '40px', textAlign: 'center', fontSize: '12px' }}>{settings.lookupFontSize || 14}px</span>
                </div>
                <div style={{ display: 'flex', gap: '15px', alignItems: 'center', marginBottom: '15px' }}>
                    <span style={{ color: 'var(--text-muted)', fontSize: '12px', width: '150px' }}>Размер тегов (px):</span>
                    <input type="range" min="8" max="24" step="1" value={settings.lookupTagFontSize || 11} onChange={(e) => updateSetting('lookupTagFontSize', Number(e.target.value))} style={{ flex: 1 }} />
                    <span style={{ color: 'var(--text-muted)', width: '40px', textAlign: 'center', fontSize: '12px' }}>{settings.lookupTagFontSize || 11}px</span>
                </div>
                
                <div style={{ display: 'flex', gap: '20px', marginTop: '10px' }}>
                    <label className="checkbox-label" style={{ flex: 1 }}><input type="checkbox" checked={settings.lookupShowTags ?? true} onChange={(e) => updateSetting('lookupShowTags', e.target.checked)} /> Показывать плашки и теги</label>
                    <label className="checkbox-label" style={{ flex: 1 }}><input type="checkbox" checked={settings.lookupShowAudio ?? true} onChange={(e) => updateSetting('lookupShowAudio', e.target.checked)} /> Показывать кнопку Аудио</label>
                </div>

                <div style={{ padding: '20px', background: 'var(--bg-main)', border: '1px solid var(--border-main)', borderRadius: '6px', marginTop: '20px', display: 'flex', flexDirection: 'column', alignItems: 'center', overflow: 'hidden' }}>
                    <div style={{ display: 'flex', gap: '10px', alignItems: 'center', marginBottom: '20px', width: '100%', justifyContent: 'center' }}>
                        <span style={{ color: 'var(--text-muted)', fontSize: '13px' }}>Тестовое слово:</span>
                        <input type="text" className="modern-input" value={previewWord} onChange={e => setPreviewWord(e.target.value)} style={{ width: '150px' }} />
                    </div>

                    <div style={{ width: `${settings.lookupWidth || 380}px`, maxHeight: `450px`, overflowY: 'auto', background: 'var(--bg-panel)', border: '1px solid var(--border-main)', borderRadius: '6px', padding: '14px', boxShadow: '0 10px 25px rgba(0,0,0,0.4)', zoom: settings.lookupScale || 1.0, textAlign: 'left' }}>
                        {groupedPreview.map((group, i) => (
                            <LookupEntryItem key={i} group={group} settings={settings} sentence={previewWord} onWordLookup={() => {}} activeGrammarDesc={activeGrammarDesc} setActiveGrammarDesc={setActiveGrammarDesc} playAudio={() => {}} audioFailed={{}} playingAudio={null} isKanjidic={Object.keys(group.cleanDictionaries)[0]?.toUpperCase().includes("KANJI")} ankiStatus={'loading'} onStatusChange={()=>{}} />
                        ))}
                    </div>
                </div>
            </div>

            <div id="lookup-dicts" className={`modern-card ${highlightedSection === 'lookup-dicts' ? 'card-highlighted' : ''}`} style={{ background: 'var(--bg-panel)', border: '1px solid var(--border-main)' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '15px' }}>
                    <div className="card-label" style={{ margin: 0, color: 'var(--text-main)' }}>Словари</div>
                    <div style={{ display: 'flex', gap: '10px' }}>
                        <button onClick={handleDictionaryImport} className="btn-primary" style={{ padding: '6px 12px' }}>+ Импорт (.zip/.json)</button>
                        <button onClick={() => { setIsSelectionMode(!isSelectionMode); setSelectedDicts([]); }} style={{ background: isSelectionMode ? 'var(--accent-blue)' : 'var(--bg-side)', border: `1px solid ${isSelectionMode ? 'var(--accent-blue)' : 'var(--border-main)'}`, color: isSelectionMode ? '#fff' : 'var(--text-main)', padding: '6px 12px', borderRadius: '6px', cursor: 'pointer', fontSize: '13px' }}>{isSelectionMode ? 'Готово' : 'Выделение'}</button>
                    </div>
                </div>
                {selectedDicts.length > 0 && isSelectionMode && ( <div style={{ marginBottom: '10px' }}><button onClick={handleDeleteSelected} style={{ background: 'rgba(255, 68, 68, 0.1)', color: '#ff4444', border: '1px solid rgba(255, 68, 68, 0.3)', padding: '6px 12px', borderRadius: '6px', cursor: 'pointer', fontSize: '13px' }}>Удалить выделенное ({selectedDicts.length})</button></div> )}
                <div style={{ background: 'var(--bg-main)', border: '1px solid var(--border-main)', borderRadius: '6px', padding: '10px' }}>
                    {(!settings.dictionaries || settings.dictionaries.length === 0) ? ( <div style={{ color: 'var(--text-muted)', fontSize: '13px', textAlign: 'center', padding: '10px' }}>Нет словарей.</div> ) : (
                        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
                            <SortableContext items={settings.dictionaries.map(d => d.name)} strategy={verticalListSortingStrategy}>
                                <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                                    {settings.dictionaries.map((dict, index) => (
                                        <SortableDictItem key={dict.name} dict={dict} idx={index} totalLen={settings.dictionaries.length} toggleDict={toggleDict} changeDictColor={changeDictColor} deleteDict={deleteDict} moveDict={moveDict} toggleSelection={toggleSelection} isSelected={selectedDicts.includes(dict.name)} isSelectionMode={isSelectionMode} />
                                    ))}
                                </div>
                            </SortableContext>
                        </DndContext>
                    )}
                </div>
                <div style={{ marginTop: '15px' }}>
                    <button onClick={handleDeleteAll} style={{ background: 'transparent', color: '#ff4444', border: '1px solid rgba(255, 68, 68, 0.3)', padding: '6px 12px', borderRadius: '6px', cursor: 'pointer', fontSize: '13px', width: '100%' }}>Удалить ВСЕ словари</button>
                </div>
            </div>
        </div>
    );
}