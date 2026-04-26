import { useState, useEffect, useCallback, useRef } from "react";
import { readText } from '@tauri-apps/plugin-clipboard-manager';
import { save, open } from '@tauri-apps/plugin-dialog';
import { invoke } from '@tauri-apps/api/core';
import { listen, UnlistenFn } from '@tauri-apps/api/event';
import TextContainer from "./components/TextContainer";
import StatsPanel from "./components/StatsPanel";
import SettingsModal, { AppSettings, WsConfig } from "./components/SettingsModal";
import { removeGarbageTags } from "./utils/textCleaner";
import Lookuper, { LookupData } from "./components/Lookuper";
import "./App.css";

import { calculateStats, getSmartTitle } from "./utils/helpers";
import { IconSearch } from "./components/Icons";
import { DEFAULT_SETTINGS, defaultStats, EMPTY_LINES, Tab, BrowserTab } from "./utils/constants";
import { ConfirmDialogModal, ImportProgressModal, ExportModal } from "./components/AppModals";
import { SearchBar, TopBar, BrowserSidebar } from "./components/AppLayout";
import SetupWizard from "./components/SetupWizard";

export default function App() {
    const [isFirstRunWizardOpen, setIsFirstRunWizardOpen] = useState(() => {
        return localStorage.getItem("setsuna-setup-wizard-completed") !== "true";
    });

    const closeFirstRunWizard = useCallback(() => {
        localStorage.setItem("setsuna-setup-wizard-completed", "true");
        setIsFirstRunWizardOpen(false);
    }, []);

    const [settings, setSettings] = useState<AppSettings>(() => {
        const saved = localStorage.getItem('txthk-settings');
        const parsed = saved ? { ...DEFAULT_SETTINGS, ...JSON.parse(saved) } : DEFAULT_SETTINGS;

        if (typeof parsed.hookProcesses === 'string') {
            parsed.hookProcesses = (parsed.hookProcesses as string)
                .split(',')
                .map((s) => s.trim())
                .filter(Boolean)
                .map((name) => ({ name, active: true }));
        }

        if ((parsed as any).wsUrl && (!parsed.websockets || parsed.websockets.length === 0)) {
            parsed.websockets = [{
                id: 'legacy_ws',
                name: 'TextHooker',
                url: (parsed as any).wsUrl,
                active: (parsed as any).useWebsocket ?? true,
            }];
        }

        return parsed;
    });

    const [tabs, setTabs] = useState<Tab[]>(() => {
        const savedTabs = localStorage.getItem('txthk-tabs');
        if (savedTabs) {
            try {
                return JSON.parse(savedTabs);
            } catch {}
        }
        return [{ id: 1, name: "Окно 1", lines: [], stats: defaultStats }];
    });

    const [activeTabId, setActiveTabId] = useState(() => {
        const savedActive = localStorage.getItem('txthk-active-tab');
        return savedActive ? parseInt(savedActive) : 1;
    });

    const activeTabIdRef = useRef(activeTabId);
    const nextTabId = useRef(Math.max(...tabs.map((t) => t.id), 0) + 1);

    const mainContentRef = useRef<HTMLElement>(null);

    const [isSearchOpen, setIsSearchOpen] = useState(false);
    const [searchQuery, setSearchQuery] = useState("");
    const [searchResults, setSearchResults] = useState<{ lineIdx: number; matchIdx: number }[]>([]);
    const [currentSearchIdx, setCurrentSearchIdx] = useState(-1);
    const [searchTrigger, setSearchTrigger] = useState(0);
    const searchInputRef = useRef<HTMLInputElement>(null);

    const [floatingBtn, setFloatingBtn] = useState<{ x: number; y: number; text: string } | null>(null);
    const [isExportModalOpen, setIsExportModalOpen] = useState(false);
    const [exportTabsSelection, setExportTabsSelection] = useState<number[]>([]);
    const [exportFileName, setExportFileName] = useState("txthk_export");

    const [confirmDialog, setConfirmDialog] = useState<{ title: string; message: string; onConfirm: () => void } | null>(null);

    useEffect(() => {
        const handleSelection = () => {
            const selection = window.getSelection();

            if (selection && selection.toString().trim().length > 0) {
                const text = selection.toString().trim();

                if (/[\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FAF]/.test(text) || text.length < 30) {
                    const range = selection.getRangeAt(0);
                    const rect = range.getBoundingClientRect();
                    setFloatingBtn({ x: rect.right, y: rect.bottom + window.scrollY, text });
                }
            } else {
                setFloatingBtn(null);
            }
        };

        document.addEventListener('selectionchange', handleSelection);
        return () => document.removeEventListener('selectionchange', handleSelection);
    }, []);

    useEffect(() => {
        let unlistenSel: UnlistenFn;
        let unlistenClear: UnlistenFn;

        listen('browser_selection', (e: any) => {
            const { text, x, y } = e.payload;
            const container = document.getElementById('native-browser-container');
            const rect = container?.getBoundingClientRect();

            if (rect && text) {
                setFloatingBtn({ x: rect.left + x, y: rect.top + y, text });
            }
        }).then((f) => (unlistenSel = f));

        listen('browser_selection_clear', () => setFloatingBtn(null)).then((f) => (unlistenClear = f));

        return () => {
            if (unlistenSel) unlistenSel();
            if (unlistenClear) unlistenClear();
        };
    }, []);

    useEffect(() => {
        localStorage.setItem('txthk-tabs', JSON.stringify(tabs));
    }, [tabs]);

    useEffect(() => {
        localStorage.setItem('txthk-active-tab', activeTabId.toString());
    }, [activeTabId]);

    const [isPaused, setIsPaused] = useState(true);
    const isPausedRef = useRef(isPaused);

    useEffect(() => {
        isPausedRef.current = isPaused;
    }, [isPaused]);

    const switchTab = useCallback((id: number) => {
        setActiveTabId(id);
        activeTabIdRef.current = id;
        setIsPaused(true);
        setSearchQuery("");
        setIsSearchOpen(false);
    }, []);

    const [editingTabId, setEditingTabId] = useState<number | null>(null);
    const [isFlashing, setIsFlashing] = useState(false);
    const [isSettingsOpen, setIsSettingsOpen] = useState(false);
    const [lookupStack, setLookupStack] = useState<LookupData[]>([]);
    const [jsonImportProgress, setJsonImportProgress] = useState<{ current: number; total: number } | null>(null);
    const [dictImportProgress, setDictImportProgress] = useState<{
        dict_name: string;
        total_dicts: number;
        current_file: number;
        total_files: number;
        words_added: number;
        status?: string;
    } | null>(null);

    const [isHelperSpaceReserved, setIsHelperSpaceReserved] = useState(false);
    const [reservedWidth, setReservedWidth] = useState(() => {
        const saved = localStorage.getItem("txthk-browser-width");
        const parsed = saved ? parseInt(saved, 10) : 450;
        return Number.isFinite(parsed) ? parsed : 450;
    });
    const [showBrowserUI, setShowBrowserUI] = useState(true);
    const isResizingRef = useRef(false);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const [isAppLoaded, setIsAppLoaded] = useState(false);

    const activeTab = tabs.find((t) => t.id === activeTabId);

    useEffect(() => {
        if (!isAppLoaded || !mainContentRef.current) return;

        const container = mainContentRef.current;
        let prevScrollHeight = 0;
        let stableCount = 0;

        const interval = setInterval(() => {
            if (!container) return;

            container.scrollTop = container.scrollHeight + 10000;

            if (container.scrollHeight === prevScrollHeight) {
                stableCount++;
            } else {
                stableCount = 0;
                prevScrollHeight = container.scrollHeight;
            }

            if (stableCount > 5) clearInterval(interval);
        }, 25);

        const timeout = setTimeout(() => clearInterval(interval), 1500);

        return () => {
            clearInterval(interval);
            clearTimeout(timeout);
        };
    }, [activeTabId, isAppLoaded]);

    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            const key = e.key.toLowerCase();
            const isCtrl = e.ctrlKey || e.metaKey;

            if (isCtrl && (key === 'f' || key === 'а')) {
                e.preventDefault();
                e.stopPropagation();
                setIsSearchOpen(true);
                setTimeout(() => searchInputRef.current?.focus(), 100);
            } else if (e.code === 'Escape' && isSearchOpen) {
                setIsSearchOpen(false);
                setSearchQuery("");
                setSearchResults([]);
                setCurrentSearchIdx(-1);
            } else if (isCtrl && (key === 'z' || key === 'я')) {
                if (isSettingsOpen) return;

                e.preventDefault();

                setTabs((prev) =>
                    prev.map((tab) => {
                        if (tab.id === activeTabIdRef.current && tab.lines.length > 0) {
                            const newLines = [...tab.lines];
                            const removedLine = newLines.pop() || "";
                            const remStats = calculateStats(removedLine, settings.appLanguage);

                            return {
                                ...tab,
                                lines: newLines,
                                stats: {
                                    ...tab.stats,
                                    chars: Math.max(0, tab.stats.chars - remStats.chars),
                                    words: Math.max(0, tab.stats.words - remStats.words),
                                    sentences: Math.max(0, tab.stats.sentences - remStats.sentences),
                                    time: tab.stats.time,
                                },
                            };
                        }
                        return tab;
                    })
                );
            }
        };

        window.addEventListener('keydown', handleKeyDown, { capture: true });
        return () => window.removeEventListener('keydown', handleKeyDown, { capture: true });
    }, [isSearchOpen, isSettingsOpen, settings.appLanguage]);

    useEffect(() => {
        if (!searchQuery.trim() || !activeTab) {
            setSearchResults([]);
            setCurrentSearchIdx(-1);
            return;
        }

        const results: { lineIdx: number; matchIdx: number }[] = [];
        const lowerQuery = searchQuery.toLowerCase();

        activeTab.lines.forEach((line, lineIdx) => {
            let startIndex = 0;
            let matchIdx = line.toLowerCase().indexOf(lowerQuery, startIndex);

            while (matchIdx !== -1) {
                results.push({ lineIdx, matchIdx });
                startIndex = matchIdx + lowerQuery.length;
                matchIdx = line.toLowerCase().indexOf(lowerQuery, startIndex);
            }
        });

        setSearchResults(results);

        if (results.length > 0) {
            setCurrentSearchIdx(0);
            setSearchTrigger((prev) => prev + 1);
        } else {
            setCurrentSearchIdx(-1);
        }
    }, [searchQuery, activeTab?.lines]);

    const handleSearchNext = () => {
        if (searchResults.length > 0) {
            setCurrentSearchIdx((prev) => (prev + 1) % searchResults.length);
            setSearchTrigger((prev) => prev + 1);
        }
    };

    const handleSearchPrev = () => {
        if (searchResults.length > 0) {
            setCurrentSearchIdx((prev) => (prev - 1 + searchResults.length) % searchResults.length);
            setSearchTrigger((prev) => prev + 1);
        }
    };

    const [browserTabs, setBrowserTabs] = useState<BrowserTab[]>(() => {
        const savedTabs = localStorage.getItem('txthk-browser-tabs');
        if (savedTabs) {
            try {
                const parsed = JSON.parse(savedTabs);
                if (parsed.length > 0) return parsed;
            } catch {}
        }

        return [{
            id: `tab_${Date.now()}`,
            url: settings.searchEngine || "https://duckduckgo.com/?q=",
            title: "Поиск",
        }];
    });

    const [activeBrowserIdx, setActiveBrowserIdx] = useState(() => {
        const saved = localStorage.getItem('txthk-active-browser-idx');
        return saved ? parseInt(saved) : 0;
    });

    const [urlInput, setUrlInput] = useState(browserTabs[activeBrowserIdx]?.url || "");
    const [isUrlFocused, setIsUrlFocused] = useState(false);

    const activeBrowserIdxRef = useRef(activeBrowserIdx);
    const isUrlFocusedRef = useRef(isUrlFocused);

    useEffect(() => {
        activeBrowserIdxRef.current = activeBrowserIdx;
    }, [activeBrowserIdx]);

    useEffect(() => {
        isUrlFocusedRef.current = isUrlFocused;
    }, [isUrlFocused]);

    useEffect(() => {
        localStorage.setItem('txthk-browser-tabs', JSON.stringify(browserTabs));
    }, [browserTabs]);

    useEffect(() => {
        localStorage.setItem('txthk-active-browser-idx', activeBrowserIdx.toString());
    }, [activeBrowserIdx]);

    useEffect(() => {
        localStorage.setItem('txthk-settings', JSON.stringify(settings));
    }, [settings]);

    useEffect(() => {
        localStorage.setItem("txthk-browser-width", reservedWidth.toString());
    }, [reservedWidth]);

    useEffect(() => {
        let unlisten: UnlistenFn;

        listen("browser_meta", (event: any) => {
            const { id, url, title, favicon } = event.payload;

            setBrowserTabs((prev) => {
                let changed = false;

                const next = prev.map((tab) => {
                    if (tab.id !== id) return tab;

                    const cleanOldUrl = (tab.url || "").replace(/\/$/, "");
                    const cleanNewUrl = (url || "").replace(/\/$/, "");
                    const smartTitle = getSmartTitle(url || tab.url, title || tab.title);

                    const nextTab = {
                        ...tab,
                        url: url || tab.url,
                        title: smartTitle,
                        favicon: favicon || tab.favicon || "",
                    };

                    if (
                        cleanOldUrl !== cleanNewUrl ||
                        tab.title !== nextTab.title ||
                        (tab.favicon || "") !== (nextTab.favicon || "")
                    ) {
                        changed = true;
                        return nextTab;
                    }

                    return tab;
                });

                if (changed) {
                    const active = next[activeBrowserIdxRef.current];
                    if (active && !isUrlFocusedRef.current) {
                        setUrlInput(active.url);
                    }
                    return next;
                }

                return prev;
            });
        }).then((f) => {
            unlisten = f;
        });

        const interval = setInterval(async () => {
            if (!isHelperSpaceReserved) return;

            try {
                const infos = await invoke<[string, string][]>("get_browser_info");

                if (!infos || !Array.isArray(infos)) return;

                setBrowserTabs((prev) => {
                    let changed = false;

                    const next = prev.map((tab) => {
                        const found = infos.find(([id]) => id === tab.id);
                        if (!found) return tab;

                        const [, realUrl] = found;
                        if (!realUrl) return tab;

                        const cleanOldUrl = (tab.url || "").replace(/\/$/, "");
                        const cleanNewUrl = (realUrl || "").replace(/\/$/, "");

                        if (cleanOldUrl !== cleanNewUrl) {
                            changed = true;

                            const fallbackTitle =
                                tab.title.startsWith("🔍 ") || tab.title === "Новая вкладка"
                                    ? ""
                                    : tab.title;

                            return {
                                ...tab,
                                url: realUrl,
                                title: getSmartTitle(realUrl, fallbackTitle),
                            };
                        }

                        return tab;
                    });

                    if (changed) {
                        const active = next[activeBrowserIdxRef.current];
                        if (active && !isUrlFocusedRef.current) {
                            setUrlInput(active.url);
                        }
                        return next;
                    }

                    return prev;
                });
            } catch (e) {
                // fallback sync, errors ignored
            }
        }, 1200);

        return () => {
            if (unlisten) unlisten();
            clearInterval(interval);
        };
    }, [isHelperSpaceReserved]);

    useEffect(() => {
        syncDictionaries();
    }, []);

    const syncDictionaries = useCallback(async () => {
        try {
            const dbDicts: string[] = await invoke("get_installed_dicts");
            if (!dbDicts || !Array.isArray(dbDicts)) return;

            setSettings((prev) => {
                const currentList = [...(prev.dictionaries || [])];
                let updated = false;

                const getRandomHexColor = () =>
                    '#' + Math.floor(Math.random() * 16777215).toString(16).padStart(6, '0');

                dbDicts.forEach((d: string) => {
                    if (!currentList.find((x) => x.name === d)) {
                        currentList.push({ name: d, active: true, color: getRandomHexColor() });
                        updated = true;
                    }
                });

                const finalDicts = currentList.filter((x) => dbDicts.includes(x.name));
                return updated || finalDicts.length !== currentList.length
                    ? { ...prev, dictionaries: finalDicts }
                    : prev;
            });
        } catch {}
    }, []);

    const runDictImport = useCallback(async (filePath: string) => {
        setDictImportProgress({
            dict_name: "Ожидание...",
            total_dicts: 1,
            current_file: 0,
            total_files: 1,
            words_added: 0,
            status: "Подготовка файла к чтению...",
        });

        try {
            await invoke("import_dictionary", { path: filePath });
            await syncDictionaries();
        } catch (e) {
            alert("Ошибка импорта: " + e);
        }

        setDictImportProgress(null);
    }, [syncDictionaries]);

    const handleImportYomitanFromWizard = useCallback(async () => {
        try {
            const selected = await open({
                multiple: true,
                directory: false,
                filters: [
                    {
                        name: 'Yomitan export',
                        extensions: ['json', 'zip'],
                    },
                ],
            });

            if (!selected) return;

            const files = Array.isArray(selected) ? selected : [selected];

            const settingsFiles = files.filter((file) => {
                const name = file.toLowerCase().split(/[\\/]/).pop() || file.toLowerCase();
                return name.includes('settings') && name.endsWith('.json');
            });

            const dictionaryFiles = files.filter((file) => {
                const lower = file.toLowerCase();
                const name = lower.split(/[\\/]/).pop() || lower;

                if (settingsFiles.includes(file)) return false;

                return lower.endsWith('.zip') || lower.endsWith('.json') || name.includes('dictionaries');
            });

            if (dictionaryFiles.length === 0) {
                alert(
                    settingsFiles.length > 0
                        ? 'Ты выбрал только yomitan-settings.json. Для словарей нужен ещё файл Export Dictionary Collection: обычно yomitan-dictionaries.json.'
                        : 'Не найден файл словарей. Выбери yomitan-dictionaries.json или .zip словаря.'
                );
                return;
            }

            for (const file of dictionaryFiles) {
                await runDictImport(file);
            }

            await syncDictionaries();

            if (settingsFiles.length > 0) {
                alert('Словари импортированы. yomitan-settings.json выбран тоже, но сейчас он не обязателен: настройки Yomitan пока не переносятся автоматически.');
            } else {
                alert('Словари Yomitan импортированы.');
            }
        } catch (e) {
            alert('Ошибка выбора/импорта файлов Yomitan: ' + e);
        }
    }, [runDictImport, syncDictionaries]);


    useEffect(() => {
        let unlistenProgress: UnlistenFn;
        let unlistenDrag: UnlistenFn;

        listen('import_progress', (e: any) => {
            setDictImportProgress(e.payload);
        }).then((f) => (unlistenProgress = f));

        listen('tauri://drag-drop', async (event: any) => {
            const paths = event.payload?.paths as string[];
            if (!paths || paths.length === 0) return;

            const file = paths[0];
            const lowerFile = file.toLowerCase();

            if (lowerFile.endsWith('.json')) {
                try {
                    const content = await invoke<string>("load_sync_file", { path: file });
                    const parsed = JSON.parse(content);

                    if (Array.isArray(parsed) && parsed.length > 0 && parsed[0].lines !== undefined) {
                        let currentId = nextTabId.current;
                        const newTabs = parsed.map((t: any) => ({ ...t, id: currentId++ }));
                        nextTabId.current = currentId;
                        setTabs((prev) => [...prev, ...newTabs]);
                        switchTab(newTabs[0].id);
                        setJsonImportProgress(null);
                    } else if (parsed && parsed["bannou-texthooker-lineData"]) {
                        const rawLines = parsed["bannou-texthooker-lineData"];
                        const importedTime = parsed["bannou-texthooker-timeValue"] || 0;
                        const total = rawLines.length;
                        let currentChunk = 0;
                        const chunkSize = 1000;
                        const importedLines: string[] = [];
                        let totalChars = 0;
                        let totalWords = 0;
                        let totalSents = 0;

                        setJsonImportProgress({ current: 0, total });

                        const processChunk = () => {
                            const end = Math.min(currentChunk + chunkSize, total);

                            for (let i = currentChunk; i < end; i++) {
                                const text = rawLines[i]?.text;
                                if (text) {
                                    const parts = text.split('\n').filter((l: string) => l.trim() !== "");
                                    for (const p of parts) {
                                        importedLines.push(p);
                                        const s = calculateStats(p, settings.appLanguage);
                                        totalChars += s.chars;
                                        totalWords += s.words;
                                        totalSents += s.sentences;
                                    }
                                }
                            }

                            currentChunk = end;
                            setJsonImportProgress({ current: currentChunk, total });

                            if (currentChunk < total) {
                                setTimeout(processChunk, 10);
                            } else {
                                const newId = nextTabId.current++;
                                let name = file.split(/[/\\]/).pop()?.replace('.json', '') || "Импорт";
                                if (name.length > 20) name = name.substring(0, 20) + '...';

                                setTabs((prev) => [
                                    ...prev,
                                    {
                                        id: newId,
                                        name,
                                        lines: importedLines,
                                        stats: {
                                            chars: totalChars,
                                            words: totalWords,
                                            sentences: totalSents,
                                            time: importedTime,
                                        },
                                    },
                                ]);
                                switchTab(newId);
                                setJsonImportProgress(null);
                            }
                        };

                        processChunk();
                    }
                } catch {
                    setJsonImportProgress(null);
                }
            } else if (lowerFile.endsWith('.zip')) {
                runDictImport(file);
            }
        }).then((f) => (unlistenDrag = f));

        return () => {
            if (unlistenProgress) unlistenProgress();
            if (unlistenDrag) unlistenDrag();
        };
    }, [runDictImport, switchTab, setTabs, settings.appLanguage]);

    useEffect(() => {
        const loadCloudSync = async () => {
            if (settings.syncPin) {
                try {
                    const res = await fetch(`https://jsonblob.com/api/jsonBlob/${settings.syncPin}`);
                    if (res.ok) {
                        const data = await res.json();
                        if (data && Array.isArray(data) && data.length > 0) {
                            setTabs(data);
                            if (!data.some((t: any) => t.id === activeTabIdRef.current)) {
                                switchTab(data[0].id);
                            }
                            nextTabId.current = Math.max(...data.map((t: any) => t.id)) + 1;
                        }
                    }
                } catch {}
            }

            setIsAppLoaded(true);
        };

        loadCloudSync();
    }, [settings.syncPin, switchTab, setTabs]);

    useEffect(() => {
        if (!isAppLoaded || !settings.syncPin) return;

        const timer = setTimeout(() => {
            fetch(`https://jsonblob.com/api/jsonBlob/${settings.syncPin}`, {
                method: 'PUT',
                headers: {
                    'Content-Type': 'application/json',
                    Accept: 'application/json',
                },
                body: JSON.stringify(tabs),
            });
        }, 2000);

        return () => clearTimeout(timer);
    }, [tabs, settings.syncPin, isAppLoaded]);

    useEffect(() => {
        let interval: any;

        if (!isPaused) {
            interval = setInterval(() => {
                setTabs((prev) =>
                    prev.map((t) =>
                        t.id === activeTabId
                            ? { ...t, stats: { ...t.stats, time: t.stats.time + 1 } }
                            : t
                    )
                );
            }, 1000);
        }

        return () => clearInterval(interval);
    }, [isPaused, activeTabId, setTabs]);

    const triggerFlash = useCallback(() => {
        setIsFlashing(false);
        setTimeout(() => setIsFlashing(true), 10);
    }, []);

    const handleNewText = useCallback((rawText: string, bypassPause: boolean = false) => {
        let cleanText = settings.enableTextCleaner !== false ? removeGarbageTags(rawText) : rawText;
        if (!cleanText) return;

        if (settings.replacements && settings.replacements.length > 0) {
            for (const rule of settings.replacements) {
                if (!rule.active || !rule.pattern) continue;

                try {
                    if (rule.isRegex) {
                        const regex = new RegExp(rule.pattern, 'g');
                        cleanText = cleanText.replace(regex, rule.replacement);
                    } else {
                        cleanText = cleanText.split(rule.pattern).join(rule.replacement);
                    }
                } catch {}
            }
        }

        if (settings.removeWhitespace) cleanText = cleanText.replace(/\s+/g, '');
        cleanText = cleanText.trim();
        if (!cleanText) return;

        if (settings.requireJapanese && !/[\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FAF]/.test(cleanText)) {
            return;
        }

        if (isPausedRef.current && !bypassPause) {
            triggerFlash();
            return;
        }

        const newStats = calculateStats(cleanText, settings.appLanguage);
        const currentTabId = activeTabIdRef.current;

        setTabs((prev) =>
            prev.map((t) => {
                if (t.id === currentTabId) {
                    if (
                        settings.ignoreDuplicates &&
                        t.lines.length > 0 &&
                        removeGarbageTags(t.lines[t.lines.length - 1]).trim() === cleanText
                    ) {
                        return t;
                    }

                    return {
                        ...t,
                        lines: [...t.lines, cleanText],
                        stats: {
                            chars: t.stats.chars + newStats.chars,
                            words: t.stats.words + newStats.words,
                            sentences: t.stats.sentences + newStats.sentences,
                            time: t.stats.time,
                        },
                    };
                }
                return t;
            })
        );
    }, [
        triggerFlash,
        settings.replacements,
        settings.removeWhitespace,
        settings.requireJapanese,
        settings.enableTextCleaner,
        settings.ignoreDuplicates,
        settings.appLanguage,
    ]);

    useEffect(() => {
        const handlePaste = (e: ClipboardEvent) => {
            if (!settings.allowManualPaste) return;

            const target = e.target as HTMLElement;
            if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
                return;
            }

            const pastedText = e.clipboardData?.getData('text');
            if (pastedText) {
                if (isPausedRef.current && !(settings.allowManualPasteDuringPause ?? true)) {
                    triggerFlash();
                    return;
                }
                handleNewText(pastedText, true);
            }
        };

        window.addEventListener('paste', handlePaste);
        return () => window.removeEventListener('paste', handlePaste);
    }, [settings.allowManualPaste, settings.allowManualPasteDuringPause, handleNewText, triggerFlash]);

    const deleteLine = useCallback((index: number) => {
        setTabs((prev) =>
            prev.map((t) => {
                if (t.id === activeTabIdRef.current) {
                    const removedStats = calculateStats(t.lines[index], settings.appLanguage);
                    return {
                        ...t,
                        lines: t.lines.filter((_, i) => i !== index),
                        stats: {
                            chars: Math.max(0, t.stats.chars - removedStats.chars),
                            words: Math.max(0, t.stats.words - removedStats.words),
                            sentences: Math.max(0, t.stats.sentences - removedStats.sentences),
                            time: t.stats.time,
                        },
                    };
                }
                return t;
            })
        );
    }, [settings.appLanguage]);

    const editLine = useCallback((index: number, newText: string) => {
        setTabs((prev) =>
            prev.map((t) => {
                if (t.id === activeTabIdRef.current) {
                    const removedStats = calculateStats(t.lines[index], settings.appLanguage);
                    const addedStats = calculateStats(newText, settings.appLanguage);

                    return {
                        ...t,
                        lines: t.lines.map((l, i) => (i === index ? newText : l)),
                        stats: {
                            chars: Math.max(0, t.stats.chars - removedStats.chars + addedStats.chars),
                            words: Math.max(0, t.stats.words - removedStats.words + addedStats.words),
                            sentences: Math.max(0, t.stats.sentences - removedStats.sentences + addedStats.sentences),
                            time: t.stats.time,
                        },
                    };
                }
                return t;
            })
        );
    }, [settings.appLanguage]);

    const clearAll = () => {
        setConfirmDialog({
            title: 'Очистка вкладки',
            message: 'Очистить текущую вкладку от всего текста?',
            onConfirm: () => {
                setTabs((prev) =>
                    prev.map((t) =>
                        t.id === activeTabIdRef.current ? { ...t, lines: [], stats: defaultStats } : t
                    )
                );
            },
        });
    };

    const handleResetSettings = () => {
        setConfirmDialog({
            title: 'Сброс настроек',
            message: 'Сбросить все настройки внешнего вида на стандартные? Ваши словари и вкладки не удалятся.',
            onConfirm: () => {
                setSettings({
                    ...DEFAULT_SETTINGS,
                    dictionaries: settings.dictionaries,
                    websockets: settings.websockets,
                    hookProcesses: settings.hookProcesses,
                });
            },
        });
    };

    const addNewTab = () => {
        const newId = nextTabId.current++;
        setTabs((prev) => [...prev, { id: newId, name: `Окно ${newId}`, lines: [], stats: defaultStats }]);
        switchTab(newId);
    };

    const closeTab = (e: React.MouseEvent, id: number) => {
        e.stopPropagation();
        if (tabs.length === 1) return;

        const newTabs = tabs.filter((t) => t.id !== id);
        setTabs(newTabs);

        if (activeTabId === id) {
            switchTab(newTabs[0].id);
        }
    };

    const getActiveBrowserTabSafe = () => {
        if (!browserTabs || browserTabs.length === 0) return null;
        const safeIdx = Math.max(0, Math.min(activeBrowserIdxRef.current, browserTabs.length - 1));
        return browserTabs[safeIdx] || null;
    };

    const getBrowserContainerRect = () => {
        const container = document.getElementById("native-browser-container");
        if (!container) return null;

        const rect = container.getBoundingClientRect();
        if (rect.width < 10 || rect.height < 10) return null;

        return {
            xOffset: Math.round(rect.left),
            yOffset: Math.round(rect.top),
            width: Math.round(rect.width),
            height: Math.round(rect.height),
        };
    };

    const manageBrowserTab = useCallback(
        async (action: string, tabId: string, url: string = "") => {
            const rect = getBrowserContainerRect();

            const payload = {
                action,
                id: tabId,
                url,
                xOffset: rect?.xOffset ?? Math.max(0, window.innerWidth - reservedWidth),
                yOffset: rect?.yOffset ?? 52,
                width: rect?.width ?? reservedWidth,
                height: rect?.height ?? Math.max(200, window.innerHeight - 52),
            };

            try {
                await invoke("manage_browser", payload);
            } catch (e) {
                console.error("Ошибка управления браузером:", e);
                alert(`Ошибка браузера: ${e}`);
            }
        },
        [reservedWidth]
    );

    const syncBrowserBoundsLocal = useCallback(() => {
        if (!isHelperSpaceReserved) return;

        const activeBrowserTab = getActiveBrowserTabSafe();
        if (!activeBrowserTab) return;

        manageBrowserTab("resize", activeBrowserTab.id, activeBrowserTab.url);
    }, [isHelperSpaceReserved, manageBrowserTab]);

    useEffect(() => {
        const handleMouseMove = (e: MouseEvent) => {
            if (!isResizingRef.current) return;

            const newWidth = window.innerWidth - e.clientX;
            if (newWidth > 260 && newWidth < window.innerWidth - 250) {
                setReservedWidth(newWidth);
            }
        };

        const handleMouseUp = () => {
            if (!isResizingRef.current) return;

            isResizingRef.current = false;
            document.body.style.cursor = "default";
            document.body.style.userSelect = "auto";

            setTimeout(() => {
                syncBrowserBoundsLocal();
            }, 30);
        };

        document.addEventListener("mousemove", handleMouseMove);
        document.addEventListener("mouseup", handleMouseUp);

        return () => {
            document.removeEventListener("mousemove", handleMouseMove);
            document.removeEventListener("mouseup", handleMouseUp);
        };
    }, [syncBrowserBoundsLocal]);

    useEffect(() => {
        const onResize = () => {
            setTimeout(() => {
                syncBrowserBoundsLocal();
            }, 30);
        };

        window.addEventListener("resize", onResize);
        return () => window.removeEventListener("resize", onResize);
    }, [syncBrowserBoundsLocal]);

    useEffect(() => {
        if (!isHelperSpaceReserved) return;

        const activeBrowserTab = getActiveBrowserTabSafe();
        if (!activeBrowserTab) return;

        const t = setTimeout(() => {
            manageBrowserTab("resize", activeBrowserTab.id, activeBrowserTab.url);
        }, 60);

        return () => clearTimeout(t);
    }, [isHelperSpaceReserved, reservedWidth, showBrowserUI, activeBrowserIdx, browserTabs, manageBrowserTab]);

    const handleAiHelperClick = () => {
        const activeBrowserTab = getActiveBrowserTabSafe();
        if (!activeBrowserTab) return;

        if (isHelperSpaceReserved) {
            setIsHelperSpaceReserved(false);
            manageBrowserTab("hide", activeBrowserTab.id, activeBrowserTab.url);
            return;
        }

        setIsHelperSpaceReserved(true);

        setTimeout(() => {
            manageBrowserTab("show", activeBrowserTab.id, activeBrowserTab.url);
        }, 80);
    };

    const submitUrlLocal = () => {
        let finalUrl = urlInput.trim();
        if (!finalUrl) return;

        if (!/^https?:\/\//i.test(finalUrl)) {
            if (finalUrl.includes(".") && !finalUrl.includes(" ")) {
                finalUrl = "https://" + finalUrl;
            } else {
                const engine = settings.searchEngine || "https://duckduckgo.com/?q=";
                finalUrl = `${engine}${encodeURIComponent(finalUrl)}`;
            }
        }

        setUrlInput(finalUrl);

        const newTabs = [...browserTabs];
        const safeIdx = Math.max(0, Math.min(activeBrowserIdx, newTabs.length - 1));

        newTabs[safeIdx] = {
            ...newTabs[safeIdx],
            url: finalUrl,
            title: getSmartTitle(finalUrl, "Сайт"),
        };

        setBrowserTabs(newTabs);

        if (isHelperSpaceReserved) {
            manageBrowserTab("navigate", newTabs[safeIdx].id, finalUrl);
        }
    };

    const addBrowserTab = () => {
        const engine = settings.searchEngine || "https://duckduckgo.com/?q=";
        const newTab = {
			id: `tab_${Date.now()}`,
			url: engine,
			title: "Новая вкладка",
			favicon: "",
		};

        const newTabs = [...browserTabs, newTab];
        const newIdx = newTabs.length - 1;

        setBrowserTabs(newTabs);
        setActiveBrowserIdx(newIdx);
        setUrlInput(engine);

        if (isHelperSpaceReserved) {
            setTimeout(() => {
                manageBrowserTab("show", newTab.id, newTab.url);
            }, 40);
        }
    };

    const closeBrowserTab = (e: React.MouseEvent, idx: number) => {
        e.stopPropagation();

        if (browserTabs.length === 1) return;

        const tabToClose = browserTabs[idx];
        const wasActive = activeBrowserIdx === idx;

        manageBrowserTab("close", tabToClose.id, tabToClose.url);

        const newTabs = browserTabs.filter((_, i) => i !== idx);
        setBrowserTabs(newTabs);

        let nextIdx = activeBrowserIdx;

        if (wasActive) {
            nextIdx = Math.max(0, idx - 1);
        } else if (activeBrowserIdx > idx) {
            nextIdx = activeBrowserIdx - 1;
        }

        const safeNextIdx = Math.max(0, Math.min(nextIdx, newTabs.length - 1));
        setActiveBrowserIdx(safeNextIdx);
        setUrlInput(newTabs[safeNextIdx].url);

        if (isHelperSpaceReserved && wasActive) {
            setTimeout(() => {
                manageBrowserTab("show", newTabs[safeNextIdx].id, newTabs[safeNextIdx].url);
            }, 40);
        }
    };

    const selectBrowserTab = (idx: number) => {
        const oldTab = browserTabs[activeBrowserIdx];
        const newTab = browserTabs[idx];
        if (!newTab) return;

        setActiveBrowserIdx(idx);
        setUrlInput(newTab.url);

        if (isHelperSpaceReserved) {
            if (oldTab && oldTab.id !== newTab.id) {
                manageBrowserTab("hide", oldTab.id, oldTab.url);
            }

            setTimeout(() => {
                manageBrowserTab("show", newTab.id, newTab.url);
            }, 20);
        }
    };

    const openExportModal = () => {
        setExportTabsSelection([activeTabIdRef.current]);
        setExportFileName(activeTab?.name || "txthk_export");
        setIsExportModalOpen(true);
    };

    const executeExport = async () => {
        if (exportTabsSelection.length === 0) return;

        let exportData;

        if (exportTabsSelection.length === 1) {
            const tab = tabs.find((t) => t.id === exportTabsSelection[0]);
            if (!tab) return;

            exportData = {
                "bannou-texthooker-timeValue": tab.stats.time,
                "bannou-texthooker-userNotes": "",
                "bannou-texthooker-lineData": tab.lines.map((l, i) => ({ id: `line-${i}`, text: l })),
            };
        } else {
            exportData = tabs.filter((t) => exportTabsSelection.includes(t.id));
        }

        try {
            const filePath = await save({
                filters: [{ name: 'JSON Data', extensions: ['json'] }],
                defaultPath: `${exportFileName}.json`,
            });

            if (filePath) {
                await invoke("save_sync_file", {
                    path: filePath,
                    content: JSON.stringify(exportData, null, 2),
                });
                setIsExportModalOpen(false);
            }
        } catch {}
    };

    const handleImportJson = (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file) return;

        const reader = new FileReader();

        reader.onload = (event) => {
            try {
                const parsed = JSON.parse(event.target?.result as string);

                if (Array.isArray(parsed) && parsed.length > 0 && parsed[0].lines !== undefined) {
                    let currentId = nextTabId.current;
                    const newTabs = parsed.map((t: any) => ({ ...t, id: currentId++ }));
                    nextTabId.current = currentId;
                    setTabs((prev) => [...prev, ...newTabs]);
                    switchTab(newTabs[0].id);
                    setJsonImportProgress(null);
                } else if (parsed && parsed["bannou-texthooker-lineData"]) {
                    const rawLines = parsed["bannou-texthooker-lineData"];
                    const importedTime = parsed["bannou-texthooker-timeValue"] || 0;
                    const total = rawLines.length;
                    let currentChunk = 0;
                    const chunkSize = 1000;
                    const importedLines: string[] = [];
                    let totalChars = 0;
                    let totalWords = 0;
                    let totalSents = 0;

                    setJsonImportProgress({ current: 0, total });

                    const processChunk = () => {
                        const end = Math.min(currentChunk + chunkSize, total);

                        for (let i = currentChunk; i < end; i++) {
                            const text = rawLines[i]?.text;
                            if (text) {
                                const parts = text.split('\n').filter((l: string) => l.trim() !== "");
                                for (const p of parts) {
                                    importedLines.push(p);
                                    const s = calculateStats(p, settings.appLanguage);
                                    totalChars += s.chars;
                                    totalWords += s.words;
                                    totalSents += s.sentences;
                                }
                            }
                        }

                        currentChunk = end;
                        setJsonImportProgress({ current: currentChunk, total });

                        if (currentChunk < total) {
                            setTimeout(processChunk, 10);
                        } else {
                            const newId = nextTabId.current++;
                            let name = file.name.replace('.json', '');
                            if (name.length > 20) name = name.substring(0, 20) + '...';

                            setTabs((prev) => [
                                ...prev,
                                {
                                    id: newId,
                                    name,
                                    lines: importedLines,
                                    stats: {
                                        chars: totalChars,
                                        words: totalWords,
                                        sentences: totalSents,
                                        time: importedTime,
                                    },
                                },
                            ]);
                            switchTab(newId);
                            setJsonImportProgress(null);
                        }
                    };

                    processChunk();
                } else {
                    alert("Неверный формат файла. Ожидался JSON от Texthooker.");
                }
            } catch {
                alert("Ошибка при чтении файла.");
                setJsonImportProgress(null);
            }
        };

        reader.readAsText(file);
        e.target.value = '';
    };

    const lastClipboardText = useRef("");

    useEffect(() => {
        if (!settings.useClipboard) return;

        const initClipboard = async () => {
            try {
                lastClipboardText.current = (await readText()) || "";
            } catch {}
        };

        initClipboard();

        const interval = setInterval(async () => {
            try {
                const currentText = await readText();
                if (
                    currentText &&
                    currentText.trim() !== "" &&
                    currentText !== lastClipboardText.current
                ) {
                    lastClipboardText.current = currentText;
                    handleNewText(currentText, false);
                }
            } catch {}
        }, 500);

        return () => clearInterval(interval);
    }, [settings.useClipboard, handleNewText]);

    const [wsStatuses, setWsStatuses] = useState<Record<string, boolean>>({});
    const [wsConnecting, setWsConnecting] = useState<Record<string, boolean>>({});
    const [wsIntents, setWsIntents] = useState<Record<string, boolean>>({});
    const wsRefs = useRef<Record<string, WebSocket>>({});

    const wsIntentsRef = useRef(wsIntents);

    useEffect(() => {
        wsIntentsRef.current = wsIntents;
    }, [wsIntents]);

    useEffect(() => {
        setWsIntents((prev) => {
            const next = { ...prev };
            (settings.websockets || []).forEach((ws) => {
                if (next[ws.id] === undefined) next[ws.id] = true;
            });
            return next;
        });
    }, [settings.websockets]);

    const connectWs = useCallback((wsConfig: WsConfig) => {
        if (!wsConfig.url) return;

        try {
            setWsConnecting((prev) => ({ ...prev, [wsConfig.id]: true }));
            const ws = new WebSocket(wsConfig.url);
            wsRefs.current[wsConfig.id] = ws;

            ws.onopen = () => {
                setWsConnecting((prev) => ({ ...prev, [wsConfig.id]: false }));
                setWsStatuses((prev) => ({ ...prev, [wsConfig.id]: true }));
            };

            ws.onclose = () => {
                setWsConnecting((prev) => ({ ...prev, [wsConfig.id]: false }));
                setWsStatuses((prev) => ({ ...prev, [wsConfig.id]: false }));
                delete wsRefs.current[wsConfig.id];
            };

            ws.onerror = () => {
                setWsConnecting((prev) => ({ ...prev, [wsConfig.id]: false }));
                ws.close();
            };

            ws.onmessage = (e) => {
                if (typeof e.data === 'string') {
                    try {
                        const parsed = JSON.parse(e.data);
                        handleNewText(parsed.text || parsed.message || e.data, false);
                    } catch {
                        handleNewText(e.data, false);
                    }
                }
            };
        } catch {}
    }, [handleNewText]);

    useEffect(() => {
        const interval = setInterval(() => {
            const activeSockets = settings.websockets || [];

            Object.keys(wsRefs.current).forEach((id) => {
                const exists = activeSockets.find((w) => w.id === id);
                if (!exists || !wsIntentsRef.current[id]) {
                    wsRefs.current[id].close();
                    delete wsRefs.current[id];

                    setWsStatuses((prev) => {
                        const n = { ...prev };
                        delete n[id];
                        return n;
                    });

                    setWsConnecting((prev) => {
                        const n = { ...prev };
                        delete n[id];
                        return n;
                    });
                }
            });

            activeSockets.forEach((wsConfig) => {
                if (wsIntentsRef.current[wsConfig.id] && !wsRefs.current[wsConfig.id]) {
                    connectWs(wsConfig);
                }
            });
        }, 3000);

        return () => clearInterval(interval);
    }, [settings.websockets, connectWs]);

    const toggleWs = (id: string) => {
        setWsIntents((prev) => ({ ...prev, [id]: !prev[id] }));
    };

    if (!isAppLoaded) {
        return <div style={{ backgroundColor: 'var(--bg-main)', width: '100vw', height: '100vh' }} />;
    }

    return (
        <div
            style={{
                display: 'flex',
                width: '100vw',
                height: '100vh',
                overflow: 'hidden',
                backgroundColor: 'var(--bg-main)',
            }}
            onClick={() => setLookupStack([])}
        >
            <SetupWizard
                isOpen={isFirstRunWizardOpen}
                onClose={closeFirstRunWizard}
                onImportYomitan={handleImportYomitanFromWizard}
                installedDictionariesCount={settings.dictionaries?.length || 0}
                ankiDeck={settings.ankiDeck}
                ankiModel={settings.ankiModel}
                onAnkiDeckChange={(deck) => setSettings((prev) => ({ ...prev, ankiDeck: deck }))}
            />
            {floatingBtn && (
                <button
                    onClick={(e) => {
                        e.stopPropagation();
                        invoke('lookup_word', { word: floatingBtn.text }).then((entries: any) => {
                            if (entries && entries.length > 0) {
                                setLookupStack([{
                                    rect: new DOMRect(floatingBtn.x, floatingBtn.y, 0, 0),
                                    entries,
                                    word: floatingBtn.text,
                                    sentence: floatingBtn.text,
                                }]);
                            }
                        });
                        setFloatingBtn(null);
                        window.getSelection()?.removeAllRanges();
                    }}
                    style={{
                        position: 'absolute',
                        top: `${floatingBtn.y + 8}px`,
                        left: `${floatingBtn.x - 16}px`,
                        background: 'var(--accent-blue)',
                        color: '#fff',
                        border: 'none',
                        borderRadius: '50%',
                        width: '32px',
                        height: '32px',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        boxShadow: '0 4px 12px rgba(0,0,0,0.3)',
                        cursor: 'pointer',
                        zIndex: 10000,
                    }}
                >
                    <IconSearch />
                </button>
            )}

            <SearchBar
                isOpen={isSearchOpen}
                isHelperSpaceReserved={isHelperSpaceReserved}
                reservedWidth={reservedWidth}
                searchQuery={searchQuery}
                setSearchQuery={setSearchQuery}
                onClose={() => {
                    setIsSearchOpen(false);
                    setSearchQuery("");
                }}
                onNext={handleSearchNext}
                onPrev={handleSearchPrev}
                resultsLength={searchResults.length}
                currentIdx={currentSearchIdx}
                inputRef={searchInputRef}
            />

            {isFlashing && (
                <div
                    style={{
                        position: 'absolute',
                        top: 0,
                        left: 0,
                        right: 0,
                        bottom: 0,
                        backgroundColor: 'rgba(100, 150, 255, 0.2)',
                        pointerEvents: 'none',
                        zIndex: 9999,
                        animation: 'flashAnim 0.3s ease-out forwards',
                    }}
                >
                    <style>{`@keyframes flashAnim { 0% { opacity: 1; } 100% { opacity: 0; } }`}</style>
                </div>
            )}

            <ImportProgressModal jsonProgress={jsonImportProgress} dictProgress={dictImportProgress} />
            <ConfirmDialogModal dialog={confirmDialog} setDialog={setConfirmDialog} />

            <ExportModal
                isOpen={isExportModalOpen}
                onClose={() => setIsExportModalOpen(false)}
                fileName={exportFileName}
                setFileName={setExportFileName}
                tabs={tabs}
                selection={exportTabsSelection}
                setSelection={setExportTabsSelection}
                onExport={executeExport}
            />

            <input
                type="file"
                accept=".json"
                ref={fileInputRef}
                style={{ display: 'none' }}
                onChange={handleImportJson}
            />

            <div
                className="app-wrapper"
                style={{
                    flex: 1,
                    display: 'flex',
                    flexDirection: 'column',
                    minWidth: 0,
                    position: 'relative',
                    transform: 'translateZ(0)',
                    transition: isResizingRef.current ? 'none' : 'all 0.3s cubic-bezier(0.4, 0, 0.2, 1)',
                }}
            >
                <TopBar
                    tabs={tabs}
                    activeTabId={activeTabId}
                    switchTab={switchTab}
                    editingTabId={editingTabId}
                    setEditingTabId={setEditingTabId}
                    setTabs={setTabs}
                    closeTab={closeTab}
                    addNewTab={addNewTab}
                    settings={{ ...settings, websockets: settings.websockets?.filter((w) => w.active) }}
                    wsStatuses={wsStatuses}
                    wsConnecting={wsConnecting}
                    wsIntents={wsIntents}
                    toggleWs={toggleWs}
                    useClipboard={settings.useClipboard}
                    toggleClipboard={() => setSettings({ ...settings, useClipboard: !settings.useClipboard })}
                    openSearch={() => {
                        setIsSearchOpen(true);
                        setTimeout(() => searchInputRef.current?.focus(), 100);
                    }}
                    openImport={() => fileInputRef.current?.click()}
                    openExport={openExportModal}
                    toggleBrowser={handleAiHelperClick}
                    isBrowserOpen={isHelperSpaceReserved}
                    clearAll={clearAll}
                    openSettings={() => setIsSettingsOpen(true)}
                />

                <main ref={mainContentRef} className="main-content" style={{ flex: 1, overflowY: 'auto' }}>
                    <TextContainer
                        lines={activeTab?.lines || EMPTY_LINES}
                        onDelete={deleteLine}
                        onEdit={editLine}
                        furiganaMode={settings?.furiganaMode || 'none'}
                        autoScrollOffset={settings?.autoScrollOffset ?? 80}
                        searchQuery={searchQuery}
                        activeSearchLineIdx={searchResults[currentSearchIdx]?.lineIdx ?? -1}
                        searchTrigger={searchTrigger}
                        panelPosition={settings.panelPosition}
                    />
                </main>

                <StatsPanel
                    isPaused={isPaused}
                    onTogglePause={() => setIsPaused(!isPaused)}
                    stats={activeTab?.stats || defaultStats}
                    position={settings.panelPosition}
                    speedMetric={settings.speedMetric}
                    speedTimeframe={settings.speedTimeframe}
                />

                <SettingsModal
                    isOpen={isSettingsOpen}
                    onClose={() => setIsSettingsOpen(false)}
                    settings={settings}
                    onSettingsChange={setSettings}
                    tabs={tabs}
                    setTabs={setTabs}
                    syncDictionaries={syncDictionaries}
                    runDictImport={runDictImport}
                    onResetSettings={handleResetSettings}
                    onClearLookup={() => setLookupStack([])}
                />

                <Lookuper
                    stack={lookupStack}
                    onAppend={(data) => setLookupStack((prev) => [...prev, data])}
                    onReplace={(data) => setLookupStack([data])}
                    onReplaceAt={(index, data) =>
                        setLookupStack((prev) => [...prev.slice(0, index + 1), data])
                    }
                    onSlice={(index) => setLookupStack((prev) => prev.slice(0, index + 1))}
                    settings={settings}
                />
            </div>

            <BrowserSidebar
                isOpen={isHelperSpaceReserved}
                reservedWidth={reservedWidth}
                isResizing={isResizingRef.current}
                onMouseDownResize={(e: any) => {
                    e.preventDefault();
                    isResizingRef.current = true;
                    document.body.style.cursor = 'col-resize';
                    document.body.style.userSelect = 'none';
                }}
                showBrowserUI={showBrowserUI}
                setShowBrowserUI={setShowBrowserUI}
                syncBrowserBounds={syncBrowserBoundsLocal}
                browserTabs={browserTabs}
                activeBrowserIdx={activeBrowserIdx}
                selectBrowserTab={selectBrowserTab}
                closeBrowserTab={closeBrowserTab}
                addBrowserTab={addBrowserTab}
                urlInput={urlInput}
                setUrlInput={setUrlInput}
                submitUrl={submitUrlLocal}
                setIsUrlFocused={setIsUrlFocused}
            />
        </div>
    );
}