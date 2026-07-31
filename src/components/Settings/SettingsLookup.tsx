import { useEffect, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { DndContext, closestCenter, KeyboardSensor, PointerSensor, useSensor, useSensors } from "@dnd-kit/core";
import { arrayMove, SortableContext, sortableKeyboardCoordinates, verticalListSortingStrategy, useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { LookupEntryItem, groupDictionaryEntries } from "../Lookuper";
import { AppSettings } from "../SettingsModal";

interface SettingsLookupProps {
    settings: AppSettings;
    updateSetting: <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => void;
    highlightedSection: string | null;
    isOpen: boolean;
    syncDictionaries: () => Promise<void>;
    runDictImport: (path: string | string[]) => Promise<boolean>;
    setConfirmDialog: (dialog: any) => void;
}

interface DictionaryUpdateStatus {
    dictName: string;
    currentRevision: string;
    latestRevision: string;
    updateAvailable: boolean;
    error: string;
}

const labels = {
    ru: {
        color: "Цвет словаря",
        deleteDictionary: "Удалить словарь",
        deleteTitle: "Удаление",
        deleteSelected: (count: number) => `Удалить ${count} выбранных словарей?`,
        deleteOne: (name: string) => `Удалить словарь "${name}"?`,
        warningTitle: "Внимание",
        deleteAllMessage: "Вы собираетесь удалить все словари. Это действие нельзя отменить. Продолжить?",
        windowSettings: "Настройки окна предпросмотра",
        activationKey: "Горячая клавиша:",
        zoom: "Масштаб окна:",
        width: "Ширина окна:",
        fontSize: "Размер текста:",
        tagSize: "Размер тегов:",
        showTags: "Показывать грамматику и теги",
        showAudio: "Показывать кнопку аудио",
        previewWord: "Тестовое слово:",
        dictionaries: "Словари",
        import: "Импорт словаря",
        select: "Выделение",
        done: "Готово",
        noDictionaries: "Словарей нет.",
        deleteSelectedButton: (count: number) => `Удалить выбранные (${count})`,
        deleteAll: "Удалить все словари",
    },
    en: {
        color: "Dictionary color",
        deleteDictionary: "Delete dictionary",
        deleteTitle: "Delete",
        deleteSelected: (count: number) => `Delete ${count} selected dictionaries?`,
        deleteOne: (name: string) => `Delete dictionary "${name}"?`,
        warningTitle: "Warning",
        deleteAllMessage: "You are about to delete all dictionaries. This cannot be undone. Continue?",
        windowSettings: "Lookup window settings",
        activationKey: "Activation key:",
        zoom: "Window scale:",
        width: "Window width:",
        fontSize: "Text size:",
        tagSize: "Tag size:",
        showTags: "Show grammar and tags",
        showAudio: "Show audio button",
        previewWord: "Preview word:",
        dictionaries: "Dictionaries",
        import: "Import dictionary",
        select: "Select",
        done: "Done",
        noDictionaries: "No dictionaries installed.",
        deleteSelectedButton: (count: number) => `Delete selected (${count})`,
        deleteAll: "Delete all dictionaries",
    },
};

function SortableDictItem({ dict, idx, totalLen, toggleDict, changeDictColor, deleteDict, moveDict, toggleSelection, isSelected, isSelectionMode, t, updateStatus, updateDictionary, isUpdating, updateLabel }: any) {
    const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: dict.name });
    const style = {
        transform: CSS.Transform.toString(transform),
        transition,
        display: "flex",
        flexDirection: "column" as const,
        alignItems: "stretch",
        background: isSelected ? "var(--hover-bg)" : "var(--bg-side)",
        border: isSelected ? "1px solid var(--accent-blue)" : "1px solid transparent",
        padding: "8px",
        marginBottom: "6px",
        borderRadius: "4px",
        opacity: isDragging ? 0.9 : 1,
        boxShadow: isDragging ? "0 0 15px rgba(79, 166, 255, 0.6)" : "none",
        zIndex: isDragging ? 99 : 0,
        position: "relative" as const,
        cursor: isSelectionMode ? "pointer" : "default",
    };

    return (
        <div ref={setNodeRef} style={style} onClick={() => isSelectionMode && toggleSelection(dict.name)}>
            <div style={{ display: "flex", alignItems: "center", gap: "10px", width: "100%" }}>
                <span {...attributes} {...listeners} style={{ color: "var(--text-muted)", fontSize: "18px", padding: "0 5px", cursor: "grab", touchAction: "none" }}>☰</span>
                <span style={{ color: "var(--text-muted)", fontSize: "12px", width: "20px", textAlign: "right", userSelect: "none" }}>{idx + 1}.</span>
                {!isSelectionMode && <input type="checkbox" checked={dict.active} onChange={() => toggleDict(idx)} style={{ cursor: "pointer" }} />}
                <span style={{ color: dict.active || isSelectionMode ? "var(--text-main)" : "var(--text-muted)", fontSize: "14px", flex: 1, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", userSelect: "none" }}>{dict.name}</span>
                {updateStatus?.updateAvailable && !isSelectionMode && (
                    <button
                        type="button"
                        onClick={(event) => { event.stopPropagation(); updateDictionary(dict.name); }}
                        disabled={isUpdating}
                        style={{ background: "rgba(79,166,255,0.12)", color: "var(--accent-blue)", border: "1px solid rgba(79,166,255,0.35)", padding: "3px 7px", borderRadius: "4px", cursor: isUpdating ? "default" : "pointer", opacity: isUpdating ? 0.6 : 1, whiteSpace: "nowrap" }}
                        title={`${updateStatus.currentRevision || "?"} -> ${updateStatus.latestRevision || "?"}`}
                    >
                        {isUpdating ? "..." : updateLabel}
                    </button>
                )}
                <input type="color" value={dict.color || "#4fa6ff"} onChange={(e) => changeDictColor(idx, e.target.value)} onClick={(e) => isSelectionMode && e.stopPropagation()} style={{ width: "24px", height: "24px", border: "none", background: "none", cursor: "pointer", padding: 0 }} title={t.color} />
                <div style={{ display: "flex", gap: "4px", marginRight: "5px" }}>
                    <button onClick={(e) => { e.stopPropagation(); moveDict(idx, -1); }} disabled={idx === 0} style={{ background: "var(--bg-main)", color: "var(--text-main)", border: "1px solid var(--border-main)", padding: "2px 6px", borderRadius: "4px", cursor: idx === 0 ? "default" : "pointer", opacity: idx === 0 ? 0.3 : 1 }}>↑</button>
                    <button onClick={(e) => { e.stopPropagation(); moveDict(idx, 1); }} disabled={idx === totalLen - 1} style={{ background: "var(--bg-main)", color: "var(--text-main)", border: "1px solid var(--border-main)", padding: "2px 6px", borderRadius: "4px", cursor: idx === totalLen - 1 ? "default" : "pointer", opacity: idx === totalLen - 1 ? 0.3 : 1 }}>↓</button>
                    <button onClick={(e) => { e.stopPropagation(); deleteDict(idx); }} style={{ background: "rgba(255,68,68,0.1)", color: "#ff4444", border: "1px solid rgba(255,68,68,0.3)", padding: "2px 6px", borderRadius: "4px", cursor: "pointer", marginLeft: "4px" }} title={t.deleteDictionary}>x</button>
                </div>
            </div>
        </div>
    );
}

const displayShortcut = (shortcut: string) => shortcut
    .split("+")
    .map((part) => part.replace(/^Key/, "").replace(/^Digit/, "").replace(/^Control$/, "Ctrl"))
    .join("+");

function ShortcutRecorder({ value, global, language, onChange }: {
    value: string;
    global?: boolean;
    language: "ru" | "en";
    onChange: (shortcut: string) => void;
}) {
    const [recording, setRecording] = useState(false);
    const [error, setError] = useState("");
    const modifierOnlyRef = useRef<string | null>(null);

    const modifierLabel = (code: string) => {
        if (code.startsWith("Control")) return "Ctrl";
        if (code.startsWith("Shift")) return "Shift";
        if (code.startsWith("Alt")) return "Alt";
        return null;
    };

    return (
        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
            <button
                type="button"
                className="modern-input shortcut-recorder"
                data-shortcut-recorder="true"
                autoFocus={recording}
                onClick={() => { setRecording(true); setError(""); modifierOnlyRef.current = null; }}
                onKeyDown={(event) => {
                    if (!recording) return;
                    event.preventDefault();
                    event.stopPropagation();
                    if (event.code === "Escape") {
                        setRecording(false);
                        setError("");
                        return;
                    }
                    const modifier = modifierLabel(event.code);
                    if (modifier) {
                        modifierOnlyRef.current = modifier;
                        return;
                    }
                    if (event.metaKey) {
                        setError(language === "en" ? "Windows key is not supported" : "Клавиша Windows не поддерживается");
                        return;
                    }
                    const modifiers = [
                        event.ctrlKey ? "Ctrl" : "",
                        event.altKey ? "Alt" : "",
                        event.shiftKey ? "Shift" : "",
                    ].filter(Boolean);
                    const functionKey = /^F(?:[1-9]|1[0-2])$/.test(event.code);
                    if (global && modifiers.length === 0 && !functionKey) {
                        setError(language === "en" ? "Add Ctrl, Alt, Shift or use F1-F12" : "Добавь Ctrl, Alt, Shift или используй F1-F12");
                        return;
                    }
                    onChange([...modifiers, event.code].join("+"));
                    modifierOnlyRef.current = null;
                    setRecording(false);
                    setError("");
                }}
                onKeyUp={(event) => {
                    if (!recording) return;
                    const modifier = modifierLabel(event.code);
                    if (!modifier || modifierOnlyRef.current !== modifier) return;
                    event.preventDefault();
                    if (global) {
                        setError(language === "en" ? "A modifier alone would break system shortcuts" : "Один модификатор будет мешать системным сочетаниям");
                        modifierOnlyRef.current = null;
                        return;
                    }
                    onChange(modifier);
                    modifierOnlyRef.current = null;
                    setRecording(false);
                    setError("");
                }}
                style={{ minWidth: "150px", height: "32px", cursor: "pointer", color: recording ? "var(--accent-blue)" : "var(--text-main)" }}
            >
                {recording
                    ? (language === "en" ? "Press shortcut..." : "Нажми сочетание...")
                    : displayShortcut(value)}
            </button>
            {error && <span style={{ maxWidth: "250px", color: "#ff6868", fontSize: "11px", lineHeight: 1.25 }}>{error}</span>}
        </div>
    );
}

export default function SettingsLookup({ settings, updateSetting, highlightedSection, isOpen, syncDictionaries, runDictImport, setConfirmDialog }: SettingsLookupProps) {
    const t = labels[settings.appLanguage === "en" ? "en" : "ru"];
    const [isSelectionMode, setIsSelectionMode] = useState(false);
    const [selectedDicts, setSelectedDicts] = useState<string[]>([]);
    const [previewWord, setPreviewWord] = useState("刹那");
    const [previewEntries, setPreviewEntries] = useState<any[]>([]);
    const [activeGrammarDesc, setActiveGrammarDesc] = useState<string | null>(null);
    const [cambridgeStatus, setCambridgeStatus] = useState("");
    const [dictionaryUpdates, setDictionaryUpdates] = useState<DictionaryUpdateStatus[] | null>(null);
    const [checkingUpdates, setCheckingUpdates] = useState(false);
    const [updatingDictionary, setUpdatingDictionary] = useState<string | null>(null);
    const [dictionaryUpdateMessage, setDictionaryUpdateMessage] = useState("");

    const checkDictionaryUpdates = async () => {
        setCheckingUpdates(true);
        setDictionaryUpdateMessage("");
        try {
            const statuses = await invoke<DictionaryUpdateStatus[]>("check_dictionary_updates");
            setDictionaryUpdates(statuses || []);
            const count = (statuses || []).filter((status) => status.updateAvailable).length;
            setDictionaryUpdateMessage(count > 0
                ? (settings.appLanguage === "en" ? `${count} update(s) available` : `Доступно обновлений: ${count}`)
                : (settings.appLanguage === "en" ? "Dictionaries are up to date" : "Словари обновлены"));
        } catch (error) {
            setDictionaryUpdateMessage(String(error));
        } finally {
            setCheckingUpdates(false);
        }
    };

    const updateDictionaryFromSource = async (dictName: string) => {
        setUpdatingDictionary(dictName);
        setDictionaryUpdateMessage(settings.appLanguage === "en" ? `Updating ${dictName}...` : `Обновляю ${dictName}...`);
        try {
            await invoke<number>("update_dictionary_from_source", { dictName });
            await syncDictionaries();
            await checkDictionaryUpdates();
        } catch (error) {
            setDictionaryUpdateMessage(String(error));
        } finally {
            setUpdatingDictionary(null);
        }
    };

    useEffect(() => {
        if (isOpen && dictionaryUpdates === null && !checkingUpdates) void checkDictionaryUpdates();
    }, [isOpen]);

    useEffect(() => {
        if (!isOpen) return;
        const wordToSearch = previewWord.trim() || "刹那";
        const timer = setTimeout(() => {
            invoke("scan_cursor", { sentence: wordToSearch, cursor: 0 })
                .then((res: any) => {
                    if (res?.entries?.length > 0) setPreviewEntries(res.entries);
                    else invoke("lookup_word", { word: wordToSearch }).then((res2: any) => setPreviewEntries(res2 || [])).catch(() => setPreviewEntries([]));
                })
                .catch(() => setPreviewEntries([]));
        }, 400);
        return () => clearTimeout(timer);
    }, [previewWord, settings.dictionaries, isOpen]);

    let finalPreviewEntries = previewEntries;
    if (finalPreviewEntries.length === 0) {
        const activeDicts = settings?.dictionaries?.filter((d) => d.active) || [];
        const fallbackDictName = activeDicts.length > 0 ? activeDicts[0].name : "JMdict";
        finalPreviewEntries = [{
            term: previewWord.trim() || "刹那",
            reading: "せつな",
            definition: "1. moment; instant.\n2. Setsuna preview entry.",
            dict_name: fallbackDictName,
            tags: ["Noun", "Temporal noun"],
            deinflection_reasons: [],
            frequencies: [{ dict_name: "VN Freq", display_value: "2500", value: 2500 }],
            pitches: [{ dict_name: "NHK", reading: "せつな", position: 0 }],
            source_length: (previewWord.trim() || "刹那").length,
        }];
    }

    const groupedPreview = groupDictionaryEntries(finalPreviewEntries, settings, false);

    const handleDictionaryImport = async () => {
        try {
            const selectedPath = await open({ multiple: true, filters: [{ name: "Dictionaries", extensions: ["zip", "json", "jsonl", "gz", "xz", "txz", "ifo", "idx", "dict", "dz", "csv", "tsv", "txt", "dsl"] }] });
            if (selectedPath) await runDictImport(Array.isArray(selectedPath) ? selectedPath : [selectedPath]);
        } catch {}
    };

    const handleDeleteSelected = () => {
        if (selectedDicts.length === 0) return;
        setConfirmDialog({
            title: t.deleteTitle,
            message: t.deleteSelected(selectedDicts.length),
            onConfirm: async () => {
                const toDelete = [...selectedDicts];
                updateSetting("dictionaries", settings.dictionaries.filter((d) => !toDelete.includes(d.name)));
                setSelectedDicts([]);
                try { await invoke("delete_dictionaries", { dictNames: toDelete }); } finally { syncDictionaries(); }
            },
        });
    };

    const handleDeleteAll = () => {
        if (settings.dictionaries.length === 0) return;
        setConfirmDialog({
            title: t.warningTitle,
            message: t.deleteAllMessage,
            onConfirm: async () => {
                updateSetting("dictionaries", []);
                setSelectedDicts([]);
                try { await invoke("clear_database"); } finally { syncDictionaries(); }
            },
        });
    };

    const deleteDict = (index: number) => {
        const dictName = settings.dictionaries[index].name;
        setConfirmDialog({
            title: t.deleteTitle,
            message: t.deleteOne(dictName),
            onConfirm: async () => {
                updateSetting("dictionaries", settings.dictionaries.filter((_, i) => i !== index));
                try { await invoke("delete_dictionaries", { dictNames: [dictName] }); } finally { syncDictionaries(); }
            },
        });
    };

    const toggleSelection = (name: string) => setSelectedDicts((prev) => prev.includes(name) ? prev.filter((n) => n !== name) : [...prev, name]);
    const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }), useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }));

    const handleDragEnd = (event: any) => {
        const { active, over } = event;
        if (!over || active.id === over.id) return;
        let newDicts = [...settings.dictionaries];
        if (isSelectionMode && selectedDicts.includes(active.id)) {
            const selectedItems = newDicts.filter((d) => selectedDicts.includes(d.name));
            newDicts = newDicts.filter((d) => !selectedDicts.includes(d.name));
            let dropIndex = newDicts.findIndex((d) => d.name === over.id);
            if (dropIndex === -1) dropIndex = newDicts.length;
            newDicts.splice(dropIndex, 0, ...selectedItems);
        } else {
            const oldIndex = newDicts.findIndex((d) => d.name === active.id);
            const newIndex = newDicts.findIndex((d) => d.name === over.id);
            newDicts = arrayMove(newDicts, oldIndex, newIndex);
        }
        updateSetting("dictionaries", newDicts);
    };

    const moveDict = (index: number, direction: -1 | 1) => {
        const newList = [...settings.dictionaries];
        const targetIndex = index + direction;
        if (targetIndex < 0 || targetIndex >= newList.length) return;
        [newList[index], newList[targetIndex]] = [newList[targetIndex], newList[index]];
        updateSetting("dictionaries", newList);
    };

    const toggleDict = (index: number) => {
        const newList = [...settings.dictionaries];
        newList[index] = { ...newList[index], active: !newList[index].active };
        updateSetting("dictionaries", newList);
    };

    const changeDictColor = (index: number, color: string) => {
        const newList = [...settings.dictionaries];
        newList[index] = { ...newList[index], color };
        updateSetting("dictionaries", newList);
    };

    const testCambridgeApi = async () => {
        const testWord = /^[A-Za-z][A-Za-z' -]*$/.test(previewWord.trim()) ? previewWord.trim() : "from";
        setCambridgeStatus(settings.appLanguage === "en" ? "Checking..." : "Проверяю...");
        try {
            const entries = await invoke<any[]>("lookup_cambridge_api", {
                word: testWord,
                config: {
                    enabled: true,
                    apiKey: settings.cambridgeApiKey || "",
                    dictionaryCode: settings.cambridgeApiDictionary || "english-russian",
                    baseUrl: settings.cambridgeApiBaseUrl || "https://dictionary.cambridge.org/api/v1",
                },
            });
            setCambridgeStatus(
                entries?.length
                    ? (settings.appLanguage === "en" ? `OK: ${entries.length} result(s)` : `OK: найдено ${entries.length}`)
                    : (settings.appLanguage === "en" ? "No result for test word." : "Нет результата для тестового слова.")
            );
        } catch (err) {
            setCambridgeStatus(String(err || "Cambridge API error"));
        }
    };

    if (!isOpen) return null;

    return (
        <div className="tab-content-anim">
            <div id="lookup-win" className={`modern-card ${highlightedSection === "lookup-win" ? "card-highlighted" : ""}`} style={{ background: "var(--bg-panel)", border: "1px solid var(--border-main)" }}>
                <div className="card-label" style={{ color: "var(--text-main)" }}>{t.windowSettings}</div>
                <div style={{ display: "grid", gridTemplateColumns: "minmax(180px, 1fr) minmax(260px, auto)", alignItems: "center", gap: "10px 14px", marginBottom: "18px", padding: "11px", border: "1px solid var(--border-main)", borderRadius: "5px", background: "var(--bg-main)" }}>
                    <span style={{ color: "var(--text-muted)", fontSize: "13px" }}>
                        {settings.appLanguage === "en" ? "Lookup inside Setsuna" : "Лукап внутри Setsuna"}
                    </span>
                    <ShortcutRecorder
                        value={settings.lookupHotkey || "Shift"}
                        language={settings.appLanguage === "en" ? "en" : "ru"}
                        onChange={(shortcut) => updateSetting("lookupHotkey", shortcut)}
                    />
                    <span style={{ color: "var(--text-muted)", fontSize: "13px" }}>
                        {settings.appLanguage === "en" ? "Lookup anywhere in Windows" : "Лукап в любом приложении Windows"}
                    </span>
                    <ShortcutRecorder
                        global
                        value={settings.globalLookupShortcut || "Alt+Q"}
                        language={settings.appLanguage === "en" ? "en" : "ru"}
                        onChange={(shortcut) => {
                            updateSetting("globalLookupShortcut", shortcut);
                            invoke("update_lookup_agent_shortcut", { shortcut }).catch((error) => {
                                updateSetting("globalLookupShortcut", "Alt+Q");
                                alert(String(error));
                            });
                        }}
                    />
                </div>
                {[
                    [t.zoom, <><input type="range" min="0.5" max="1.5" step="0.1" value={settings.lookupScale || 1.0} onChange={(e) => updateSetting("lookupScale", Number(e.target.value))} style={{ flex: 1 }} /><span style={{ color: "var(--text-main)", width: "40px", textAlign: "center", fontWeight: "bold" }}>{Math.round((settings.lookupScale || 1.0) * 100)}%</span></>],
                    [t.width, <><input type="range" min="250" max="800" step="10" value={settings.lookupWidth || 380} onChange={(e) => updateSetting("lookupWidth", Number(e.target.value))} style={{ flex: 1 }} /><span style={{ color: "var(--text-muted)", width: "45px", textAlign: "center", fontSize: "12px" }}>{settings.lookupWidth || 380}px</span></>],
                    [t.fontSize, <><input type="range" min="10" max="36" step="1" value={settings.lookupFontSize || 14} onChange={(e) => updateSetting("lookupFontSize", Number(e.target.value))} style={{ flex: 1 }} /><span style={{ color: "var(--text-muted)", width: "45px", textAlign: "center", fontSize: "12px" }}>{settings.lookupFontSize || 14}px</span></>],
                    [t.tagSize, <><input type="range" min="8" max="24" step="1" value={settings.lookupTagFontSize || 11} onChange={(e) => updateSetting("lookupTagFontSize", Number(e.target.value))} style={{ flex: 1 }} /><span style={{ color: "var(--text-muted)", width: "45px", textAlign: "center", fontSize: "12px" }}>{settings.lookupTagFontSize || 11}px</span></>],
                ].map(([label, control]: any) => (
                    <div key={label} style={{ display: "flex", gap: "15px", alignItems: "center", marginBottom: "15px" }}>
                        <span style={{ color: "var(--text-muted)", fontSize: "13px", width: "150px" }}>{label}</span>
                        {control}
                    </div>
                ))}

                <div style={{ display: "flex", gap: "20px", marginTop: "10px" }}>
                    <label className="checkbox-label" style={{ flex: 1 }}><input type="checkbox" checked={settings.lookupShowTags ?? true} onChange={(e) => updateSetting("lookupShowTags", e.target.checked)} /> {t.showTags}</label>
                    <label className="checkbox-label" style={{ flex: 1 }}><input type="checkbox" checked={settings.lookupShowAudio ?? true} onChange={(e) => updateSetting("lookupShowAudio", e.target.checked)} /> {t.showAudio}</label>
                </div>
                <div style={{ display: "flex", gap: "20px", marginTop: "10px" }}>
                    <label className="checkbox-label" style={{ flex: 1 }}><input type="checkbox" checked={settings.autoPlayAudio ?? true} onChange={(e) => updateSetting("autoPlayAudio", e.target.checked)} /> {settings.appLanguage === "en" ? "Automatically play audio" : "Автоматически проигрывать аудио"}</label>
                </div>

                <div style={{ padding: "16px", background: "var(--bg-main)", border: "1px solid var(--border-main)", borderRadius: "6px", marginTop: "20px" }}>
                    <div className="card-label" style={{ color: "var(--text-main)", marginBottom: "12px" }}>Cambridge Dictionary API</div>
                    <label className="checkbox-label" style={{ marginBottom: "12px" }}>
                        <input
                            type="checkbox"
                            checked={settings.cambridgeApiEnabled ?? false}
                            onChange={(e) => updateSetting("cambridgeApiEnabled", e.target.checked)}
                        />
                        {settings.appLanguage === "en" ? "Use Cambridge API for English lookup" : "Использовать Cambridge API для английского лукапа"}
                    </label>
                    <label className="checkbox-label" style={{ marginBottom: "12px" }}>
                        <input
                            type="checkbox"
                            checked={settings.cambridgeApiOnlyWhenNoLocal ?? true}
                            onChange={(e) => updateSetting("cambridgeApiOnlyWhenNoLocal", e.target.checked)}
                        />
                        {settings.appLanguage === "en" ? "Only call Cambridge when local dictionaries have no result" : "Вызывать Cambridge только если локальные словари ничего не нашли"}
                    </label>
                    <div style={{ display: "grid", gridTemplateColumns: "140px 1fr", gap: "10px 14px", alignItems: "center" }}>
                        <span style={{ color: "var(--text-muted)", fontSize: "13px" }}>{settings.appLanguage === "en" ? "API key" : "API ключ"}</span>
                        <input
                            type="password"
                            className="modern-input"
                            value={settings.cambridgeApiKey || ""}
                            onChange={(e) => updateSetting("cambridgeApiKey", e.target.value)}
                            placeholder="accessKey"
                        />
                        <span style={{ color: "var(--text-muted)", fontSize: "13px" }}>{settings.appLanguage === "en" ? "Dictionary code" : "Код словаря"}</span>
                        <input
                            type="text"
                            className="modern-input"
                            value={settings.cambridgeApiDictionary || "english-russian"}
                            onChange={(e) => updateSetting("cambridgeApiDictionary", e.target.value)}
                            placeholder="english-russian"
                        />
                        <span style={{ color: "var(--text-muted)", fontSize: "13px" }}>Base URL</span>
                        <input
                            type="text"
                            className="modern-input"
                            value={settings.cambridgeApiBaseUrl || "https://dictionary.cambridge.org/api/v1"}
                            onChange={(e) => updateSetting("cambridgeApiBaseUrl", e.target.value)}
                            placeholder="https://dictionary.cambridge.org/api/v1"
                        />
                    </div>
                    <div style={{ display: "flex", gap: "10px", alignItems: "center", marginTop: "12px" }}>
                        <button type="button" className="btn-primary" onClick={testCambridgeApi} style={{ padding: "6px 12px" }}>{settings.appLanguage === "en" ? "Test" : "Проверить"}</button>
                        {cambridgeStatus && <span style={{ color: "var(--text-muted)", fontSize: "12px" }}>{cambridgeStatus}</span>}
                    </div>
                </div>

                <div style={{ padding: "20px", background: "var(--bg-main)", border: "1px solid var(--border-main)", borderRadius: "6px", marginTop: "20px", display: "flex", flexDirection: "column", alignItems: "center", overflow: "hidden" }}>
                    <div style={{ display: "flex", gap: "10px", alignItems: "center", marginBottom: "20px", width: "100%", justifyContent: "center" }}>
                        <span style={{ color: "var(--text-muted)", fontSize: "13px" }}>{t.previewWord}</span>
                        <input type="text" className="modern-input" value={previewWord} onChange={(e) => setPreviewWord(e.target.value)} style={{ width: "150px" }} />
                    </div>
                    <div style={{ width: `${settings.lookupWidth || 380}px`, maxHeight: "450px", overflowY: "auto", background: "var(--bg-panel)", border: "1px solid var(--border-main)", borderRadius: "6px", padding: "14px", boxShadow: "0 10px 25px rgba(0,0,0,0.4)", zoom: settings.lookupScale || 1.0, textAlign: "left" }}>
                        {groupedPreview.map((group, i) => (
                            <LookupEntryItem key={i} group={group} settings={settings} sentence={previewWord} onWordLookup={() => {}} activeGrammarDesc={activeGrammarDesc} setActiveGrammarDesc={setActiveGrammarDesc} playAudio={() => {}} audioFailed={{}} playingAudio={null} isKanjidic={Object.keys(group.cleanDictionaries)[0]?.toUpperCase().includes("KANJI")} ankiStatus="loading" onStatusChange={() => {}} />
                        ))}
                    </div>
                </div>
            </div>

            <div id="lookup-dicts" className={`modern-card ${highlightedSection === "lookup-dicts" ? "card-highlighted" : ""}`} style={{ background: "var(--bg-panel)", border: "1px solid var(--border-main)" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "15px" }}>
                    <div className="card-label" style={{ margin: 0, color: "var(--text-main)" }}>{t.dictionaries}</div>
                    <div style={{ display: "flex", gap: "10px" }}>
                        <button onClick={checkDictionaryUpdates} disabled={checkingUpdates} style={{ background: "var(--bg-side)", border: "1px solid var(--border-main)", color: "var(--text-main)", padding: "6px 12px", borderRadius: "6px", cursor: checkingUpdates ? "default" : "pointer", opacity: checkingUpdates ? 0.6 : 1 }}>
                            {checkingUpdates ? "..." : (settings.appLanguage === "en" ? "Check updates" : "Проверить обновления")}
                        </button>
                        <button onClick={handleDictionaryImport} className="btn-primary" style={{ padding: "6px 12px" }}>+ {t.import}</button>
                        <button onClick={() => { setIsSelectionMode(!isSelectionMode); setSelectedDicts([]); }} style={{ background: isSelectionMode ? "var(--accent-blue)" : "var(--bg-side)", border: `1px solid ${isSelectionMode ? "var(--accent-blue)" : "var(--border-main)"}`, color: isSelectionMode ? "#fff" : "var(--text-main)", padding: "6px 12px", borderRadius: "6px", cursor: "pointer", fontSize: "13px" }}>{isSelectionMode ? t.done : t.select}</button>
                    </div>
                </div>
                {dictionaryUpdateMessage && <div style={{ color: "var(--text-muted)", fontSize: "12px", marginBottom: "10px" }}>{dictionaryUpdateMessage}</div>}
                {selectedDicts.length > 0 && isSelectionMode && <div style={{ marginBottom: "10px" }}><button onClick={handleDeleteSelected} style={{ background: "rgba(255, 68, 68, 0.1)", color: "#ff4444", border: "1px solid rgba(255, 68, 68, 0.3)", padding: "6px 12px", borderRadius: "6px", cursor: "pointer", fontSize: "13px" }}>{t.deleteSelectedButton(selectedDicts.length)}</button></div>}
                <div style={{ background: "var(--bg-main)", border: "1px solid var(--border-main)", borderRadius: "6px", padding: "10px" }}>
                    {(!settings.dictionaries || settings.dictionaries.length === 0) ? (
                        <div style={{ color: "var(--text-muted)", fontSize: "13px", textAlign: "center", padding: "10px" }}>{t.noDictionaries}</div>
                    ) : (
                        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
                            <SortableContext items={settings.dictionaries.map((d) => d.name)} strategy={verticalListSortingStrategy}>
                                <div style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
                                    {settings.dictionaries.map((dict, index) => (
                                        <SortableDictItem key={dict.name} dict={dict} idx={index} totalLen={settings.dictionaries.length} toggleDict={toggleDict} changeDictColor={changeDictColor} deleteDict={deleteDict} moveDict={moveDict} toggleSelection={toggleSelection} isSelected={selectedDicts.includes(dict.name)} isSelectionMode={isSelectionMode} t={t} updateStatus={dictionaryUpdates?.find((status) => status.dictName === dict.name)} updateDictionary={updateDictionaryFromSource} isUpdating={updatingDictionary === dict.name} updateLabel={settings.appLanguage === "en" ? "Update" : "Обновить"} />
                                    ))}
                                </div>
                            </SortableContext>
                        </DndContext>
                    )}
                </div>
                <div style={{ marginTop: "15px" }}>
                    <button onClick={handleDeleteAll} style={{ background: "transparent", color: "#ff4444", border: "1px solid rgba(255, 68, 68, 0.3)", padding: "6px 12px", borderRadius: "6px", cursor: "pointer", fontSize: "13px", width: "100%" }}>{t.deleteAll}</button>
                </div>
            </div>
        </div>
    );
}
