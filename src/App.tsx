import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { readText } from '@tauri-apps/plugin-clipboard-manager';
import { isMobilePlatform } from './utils/platform';
import { save, open } from '@tauri-apps/plugin-dialog';
import { invoke } from '@tauri-apps/api/core';
import { getMobileFlowTimer } from './utils/mobileOverlay';
import { cleanupMobileDictionaries } from './utils/mobileFiles';
import { emit, emitTo, listen, UnlistenFn } from '@tauri-apps/api/event';
import { check, Update } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';
import TextContainer from "./components/TextContainer";
import { SearchBar, TopBar, MobileLayout } from './components/AppLayout';
import YatsuWorkspace, { hideYatsuWorkspace } from "./components/YatsuWorkspace";
import StatsPanel from "./components/StatsPanel";
import SettingsModal, { AppSettings, WsConfig } from "./components/SettingsModal";
import { removeGarbageTags } from "./utils/textCleaner";
import { DictEntry, LookupData } from "./components/Lookuper";
import LookupSurface from "./features/lookup/LookupSurface";
import "./App.css";

import { calculateStats } from "./utils/helpers";
import { IconBookTab, IconPin, IconPlayerTab, IconSearch } from "./components/Icons";
import { DEFAULT_SETTINGS, defaultStats, EMPTY_LINES, Tab, themes, PlayerMiningClip, ReadingSpeedSample } from "./utils/constants";
import { getTranslator } from "./utils/i18n";
import { ConfirmDialogModal, ImportProgressModal, ExportModal, NoticeModal } from "./components/AppModals";
import SetupWizard from "./components/SetupWizard";
import StartupSplash from "./components/StartupSplash";
import HomeScreen from "./components/HomeScreen";
import { YATSU_READER_AVAILABLE } from './utils/featureFlags';
import PlayerSkeleton from "./components/PlayerSkeleton";
import WorkspaceShell from "./components/WorkspaceShell";
import releaseInfo from "./release-info.json";
import { contentFingerprint, createLatestTaskQueue } from './utils/runtimeMemory';
import { selectActiveLookupResult } from './utils/lookupResults';
import {
    discordActivityTypeForMode,
    applyTabOrder,
    extractHookPayload,
    formatDiscordMode,
    formatDiscordStats,
    normalizeIncomingHookText,
    trimRuntimeLine,
    normalizeJapaneseFontStack,
    normalizeLookupText,
    normalizeWebSocketUrl,
    readStoredTabOrder,
    TAB_ORDER_STORAGE_KEY,
    trimTabForRuntime,
} from "./utils/appRuntime";

type CaptureWindowInfo = {
    id?: number;
    title: string;
    app_name: string;
    process_name: string;
    path: string;
    pid?: number;
    width: number;
    height: number;
    is_focused?: boolean;
    is_recent?: boolean;
    icon?: string | null;
    sourceType?: 'local' | 'remote';
    remoteUrl?: string;
    remoteToken?: string;
};

type UpdateDialogState =
    | { kind: 'available'; update: Update; progress?: number; message?: string; busy?: boolean }
    | { kind: 'none'; message: string }
    | { kind: 'error'; message: string };

const stripRemovedSettings = <T extends Record<string, any>>(settings: T): T => {
    for (const key of Object.keys(settings)) {
        if ((key.startsWith('jl') && key.includes('Overlay')) || key.startsWith('cambridgeApi') || ['helperUrl', 'searchEngine', 'topbarShowBrowser'].includes(key)) {
            delete settings[key];
        }
    }
    return settings;
};

const APP_LANGUAGE_STORAGE_KEY = 'setsuna-app-language';
const readStoredAppLanguage = (): AppSettings['appLanguage'] | undefined => {
    const value = localStorage.getItem(APP_LANGUAGE_STORAGE_KEY);
    return value === 'ru' || value === 'en' ? value : undefined;
};

const readStoredSettings = (): AppSettings => {
    try {
        const saved = localStorage.getItem('txthk-settings');
        const storedLanguage = readStoredAppLanguage();
        const languageOverride = storedLanguage ? { appLanguage: storedLanguage } : {};
        if (!saved) return stripRemovedSettings({ ...DEFAULT_SETTINGS, ...languageOverride });

        const value = JSON.parse(saved);
        const overrides = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
        return stripRemovedSettings({ ...DEFAULT_SETTINGS, ...overrides, ...languageOverride });
    } catch (error) {
        console.warn('Failed to read saved settings; defaults will be used', error);
        const storedLanguage = readStoredAppLanguage();
        return stripRemovedSettings({
            ...DEFAULT_SETTINGS,
            ...(storedLanguage ? { appLanguage: storedLanguage } : {}),
        });
    }
};

const WORKSPACE_UPDATED_AT_STORAGE_KEY = "txthk-workspace-updated-at";
const SKIPPED_UPDATE_VERSION_STORAGE_KEY = "setsuna-skipped-update-version";

const countExportedTextLines = (value: unknown): number => {
    if (Array.isArray(value)) {
        return value.reduce((total, tab) => (
            total + (Array.isArray(tab?.lines) ? tab.lines.length : 0)
        ), 0);
    }

    if (!value || typeof value !== 'object') return 0;
    const lineData = (value as Record<string, unknown>)["bannou-texthooker-lineData"];
    return Array.isArray(lineData) ? lineData.length : 0;
};

const normalizeStoredTabs = (value: unknown, defaultName: string): Tab[] => {
    if (!Array.isArray(value)) return [];
    return value
        .filter((tab): tab is Tab => Boolean(tab && typeof tab === 'object' && Number.isFinite(tab.id)))
        .map((tab) => trimTabForRuntime({
            ...tab,
            name: typeof tab.name === 'string' ? tab.name : defaultName,
            lines: Array.isArray(tab.lines) ? tab.lines : [],
            stats: {
                ...defaultStats,
                ...(tab.stats && typeof tab.stats === 'object' ? tab.stats : {}),
            },
        }));
};

const createStableTextSyncToken = () => {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
};

const FLOW_CLICK_LOOKUP_MIGRATION_KEY = "setsuna-flow-click-lookup-v1";

export default function App() {
    const [isFirstRunWizardOpen, setIsFirstRunWizardOpen] = useState(() => {
        return localStorage.getItem("setsuna-setup-wizard-completed") !== "true";
    });

    const closeFirstRunWizard = useCallback(() => {
        localStorage.setItem("setsuna-setup-wizard-completed", "true");
        setIsFirstRunWizardOpen(false);
    }, []);

    const [settings, setSettings] = useState<AppSettings>(() => {
        const parsed = readStoredSettings();

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

        if (!parsed.discordClientId?.trim()) {
            parsed.discordClientId = DEFAULT_SETTINGS.discordClientId;
        }

        if (!parsed.textSyncServerToken?.trim()) {
            parsed.textSyncServerToken = createStableTextSyncToken();
        }
        if (!parsed.textSyncDeviceId?.trim()) {
            parsed.textSyncDeviceId = createStableTextSyncToken();
        }
        if (localStorage.getItem(FLOW_CLICK_LOOKUP_MIGRATION_KEY) !== "true") {
            if (!parsed.jlModeLookupTrigger || parsed.jlModeLookupTrigger === "hover") {
                parsed.jlModeLookupTrigger = "click";
            }
            localStorage.setItem(FLOW_CLICK_LOOKUP_MIGRATION_KEY, "true");
        }
        if (!parsed.accountDeviceName?.trim()) {
            parsed.accountDeviceName = "";
        }

        return parsed;
    });

    useEffect(() => {
        if (settings.accountDeviceName?.trim()) return;
        invoke<string>("get_windows_device_name")
            .then((name) => {
                const clean = String(name || "").trim();
                if (clean && clean !== settings.accountDeviceName) {
                    setSettings((prev) => ({ ...prev, accountDeviceName: clean }));
                }
            })
            .catch(() => {});
    }, []);

    useEffect(() => {
        const apiBaseUrl = settings.accountApiBaseUrl?.trim();
        const token = settings.accountAccessToken?.trim();
        if (!apiBaseUrl || !token) return;

        const heartbeat = () => {
            void invoke("account_register_device", {
                apiBaseUrl,
                token,
                deviceId: settings.textSyncDeviceId?.trim() || settings.textSyncServerToken?.trim() || "setsuna",
                deviceName: settings.accountDeviceName?.trim() || "Setsuna",
            }).catch(() => {});
        };

        heartbeat();
        const interval = window.setInterval(heartbeat, 45_000);
        return () => window.clearInterval(interval);
    }, [
        settings.accountApiBaseUrl,
        settings.accountAccessToken,
        settings.accountDeviceName,
        settings.textSyncDeviceId,
        settings.textSyncServerToken,
    ]);

    const t = getTranslator(settings.appLanguage || 'ru');
    const isMobileLayout = isMobilePlatform();

    useEffect(() => {
        const root = document.documentElement;
        const themeName = settings.theme in themes ? settings.theme : DEFAULT_SETTINGS.theme;
        const activeTheme = themes[themeName];

        Object.entries(activeTheme).forEach(([name, value]) => {
            root.style.setProperty(name, value);
        });

        root.style.setProperty('--txt-font-size', `${settings.fontSize || DEFAULT_SETTINGS.fontSize}px`);
        root.style.setProperty('--txt-font-family', normalizeJapaneseFontStack(settings.fontFamily || DEFAULT_SETTINGS.fontFamily));

        root.style.setProperty('--accent', activeTheme['--accent-blue']);
        root.style.setProperty('--accent-bg', themeName === 'light' ? 'rgba(0, 102, 204, 0.12)' : 'rgba(79, 166, 255, 0.14)');
        root.style.setProperty('--bg-secondary', activeTheme['--bg-panel']);
        root.style.setProperty('--border-color', activeTheme['--border-main']);
        root.style.setProperty('--button-bg', activeTheme['--bg-side']);

        // Native form controls (<select> popups, checkboxes, scrollbars) are
        // painted by the engine, not by our CSS, so they need to be told which
        // variant to use or they stay light on the dark themes.
        root.style.colorScheme = themeName === 'light' ? 'light' : 'dark';

        root.dataset.theme = themeName;
        document.body.dataset.theme = themeName;
    }, [settings.theme, settings.fontSize, settings.fontFamily]);

    const [tabs, setTabs] = useState<Tab[]>(() => {
        const savedTabs = localStorage.getItem('txthk-tabs');
        if (savedTabs) {
            try {
                const sanitizedTabs = savedTabs.includes('"html"')
                    ? savedTabs
                        .replace(/,"html":"(?:\\.|[^"\\])*"/g, "")
                        .replace(/"html":"(?:\\.|[^"\\])*",?/g, "")
                    : savedTabs;
                if (sanitizedTabs !== savedTabs) {
                    localStorage.setItem('txthk-tabs', sanitizedTabs);
                }
                const parsed = JSON.parse(sanitizedTabs);
                const restored = normalizeStoredTabs(parsed, t('tabs.defaultName'));
                if (restored.length > 0) {
                    return applyTabOrder(restored, readStoredTabOrder());
                }
            } catch {}
        }
        return [{ id: 1, name: t('tabs.defaultName'), lines: [], stats: defaultStats }];
    });

    const [activeTabId, setActiveTabId] = useState(() => {
        const savedActive = localStorage.getItem('txthk-active-tab');
        const parsed = savedActive ? Number.parseInt(savedActive, 10) : Number.NaN;
        const fallback = tabs.find((tab) => !tab.archived)?.id ?? tabs[0]?.id ?? 1;
        return Number.isFinite(parsed) && tabs.some((tab) => tab.id === parsed && !tab.archived) ? parsed : fallback;
    });
    const [activeWorkspace, setActiveWorkspace] = useState<"hub" | "texthooker" | "epub" | "player">("hub");
    const resolvedWorkspace = activeWorkspace === "texthooker" || activeWorkspace === "epub" || activeWorkspace === "player"
        ? activeWorkspace
        : "hub";

    const activeTabIdRef = useRef(activeTabId);
    const nextTabId = useRef(Math.max(...tabs.map((t) => t.id), 0) + 1);

    const mainContentRef = useRef<HTMLElement>(null);
    const discordSessionStartRef = useRef(Date.now());
    const discordLastPayloadRef = useRef("");
    const discordFailureCountRef = useRef(0);
    const discordDisabledUntilRef = useRef(0);
    const [isInTray, setIsInTray] = useState(false);

    const [isSearchOpen, setIsSearchOpen] = useState(false);
    const [searchQuery, setSearchQuery] = useState("");
    const [searchResults, setSearchResults] = useState<{ lineIdx: number; matchIdx: number }[]>([]);
    const [currentSearchIdx, setCurrentSearchIdx] = useState(-1);
    const [searchTrigger, setSearchTrigger] = useState(0);
    const searchContextRef = useRef<{ tabId: number | null; query: string }>({ tabId: null, query: '' });
    const selectedSearchResultRef = useRef<{ lineIdx: number; matchIdx: number } | null>(null);
    const searchInputRef = useRef<HTMLInputElement>(null);

    const [floatingBtn, setFloatingBtn] = useState<{ x: number; y: number; text: string } | null>(null);
    const [isExportModalOpen, setIsExportModalOpen] = useState(false);
    const [exportTabsSelection, setExportTabsSelection] = useState<number[]>([]);
    const [exportFileName, setExportFileName] = useState("txthk_export");
    const [isCaptureSourcePickerOpen, setIsCaptureSourcePickerOpen] = useState(false);
    const [captureSources, setCaptureSources] = useState<CaptureWindowInfo[]>([]);
    const [captureSourceSearch, setCaptureSourceSearch] = useState("");
    const [isCaptureSourceLoading, setIsCaptureSourceLoading] = useState(false);

    const [confirmDialog, setConfirmDialog] = useState<{ title: string; message: string; onConfirm: () => void } | null>(null);
    const [notice, setNotice] = useState<{ title?: string; message: string } | null>(null);

    useEffect(() => {
        const nativeAlert = window.alert;
        window.alert = (message?: any) => {
            setNotice({ title: "Setsuna", message: String(message ?? "") });
        };
        return () => {
            window.alert = nativeAlert;
        };
    }, []);

    useEffect(() => {
        const handleSelection = () => {
            const selection = window.getSelection();

            if (selection && selection.toString().trim().length > 0) {
                const text = normalizeLookupText(selection.toString());

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

    const runtimeTabs = useMemo(() => tabs.map(trimTabForRuntime), [tabs]);
    const tabsPersistKey = useMemo(() => contentFingerprint(runtimeTabs), [runtimeTabs]);

    const tabOrderPersistKey = useMemo(() => JSON.stringify(tabs.map((tab) => tab.id)), [tabs]);
    const workspacePersistenceRef = useRef({
        tabs: runtimeTabs,
        order: tabOrderPersistKey,
        activeTabId,
    });
    const workspaceHydratedRef = useRef(false);
    const workspaceFileWriteQueueRef = useRef(createLatestTaskQueue<string>(
        (content) => invoke<void>('save_workspace_state', { content }),
        (error) => console.warn('Failed to save file-backed workspace', error),
    ));
    workspacePersistenceRef.current = {
        tabs: runtimeTabs,
        order: tabOrderPersistKey,
        activeTabId,
    };

    const queueWorkspaceFileSave = useCallback((content: string) => {
        void workspaceFileWriteQueueRef.current.push(content);
    }, []);

    const persistWorkspaceNow = useCallback(() => {
        if (!workspaceHydratedRef.current) return;
        const snapshot = workspacePersistenceRef.current;
        const serializedTabs = JSON.stringify(snapshot.tabs);
        const updatedAt = Date.now();
        try {
            localStorage.setItem('txthk-tabs', serializedTabs);
            localStorage.setItem(TAB_ORDER_STORAGE_KEY, snapshot.order);
            localStorage.setItem('txthk-active-tab', snapshot.activeTabId.toString());
            localStorage.setItem(WORKSPACE_UPDATED_AT_STORAGE_KEY, updatedAt.toString());
        } catch (error) {
            console.warn('Failed to persist workspace', error);
        }
        queueWorkspaceFileSave(`{"version":1,"updatedAt":${updatedAt},"activeTabId":${snapshot.activeTabId},"tabs":${serializedTabs}}`);
    }, [queueWorkspaceFileSave]);

    useEffect(() => {
        let disposed = false;
        let restoredFromFile = false;
        invoke<string | null>('load_workspace_state')
            .then((content) => {
                if (disposed || !content) return;
                const parsed = JSON.parse(content) as {
                    version?: number;
                    updatedAt?: number;
                    activeTabId?: number;
                    tabs?: unknown;
                };
                if (parsed.version !== 1) return;
                const localUpdatedAt = Number.parseInt(localStorage.getItem(WORKSPACE_UPDATED_AT_STORAGE_KEY) || '0', 10) || 0;
                const fileUpdatedAt = Number(parsed.updatedAt) || 0;
                if (localUpdatedAt > fileUpdatedAt) return;

                const restoredTabs = normalizeStoredTabs(parsed.tabs, t('tabs.defaultName'));
                if (restoredTabs.length === 0) return;
                const restoredActiveId = Number(parsed.activeTabId);
                const nextActiveId = Number.isFinite(restoredActiveId)
                    && restoredTabs.some((tab) => tab.id === restoredActiveId && !tab.archived)
                    ? restoredActiveId
                    : restoredTabs.find((tab) => !tab.archived)?.id ?? restoredTabs[0].id;

                restoredFromFile = true;
                setTabs(restoredTabs);
                setActiveTabId(nextActiveId);
                activeTabIdRef.current = nextActiveId;
                nextTabId.current = Math.max(...restoredTabs.map((tab) => tab.id), 0) + 1;
            })
            .catch((error) => {
                console.warn('Failed to load file-backed workspace', error);
            })
            .finally(() => {
                if (disposed) return;
                workspaceHydratedRef.current = true;
                if (!restoredFromFile) {
                    window.setTimeout(persistWorkspaceNow, 0);
                }
            });
        return () => {
            disposed = true;
        };
    }, [persistWorkspaceNow]);

    useEffect(() => {
        try {
            localStorage.setItem(TAB_ORDER_STORAGE_KEY, tabOrderPersistKey);
        } catch (error) {
            console.warn("Failed to persist tab order", error);
        }
    }, [tabOrderPersistKey]);

    useEffect(() => {
        const timer = window.setTimeout(() => {
            persistWorkspaceNow();
        }, 3000);
        return () => window.clearTimeout(timer);
    }, [tabsPersistKey, persistWorkspaceNow]);

    useEffect(() => {
        // Tab creation/removal and active-tab changes must reach storage together.
        persistWorkspaceNow();
    }, [activeTabId]);

    useEffect(() => {
        const flush = () => persistWorkspaceNow();
        const flushWhenHidden = () => {
            if (document.visibilityState === 'hidden') flush();
        };
        window.addEventListener('beforeunload', flush);
        window.addEventListener('pagehide', flush);
        document.addEventListener('visibilitychange', flushWhenHidden);
        return () => {
            window.removeEventListener('beforeunload', flush);
            window.removeEventListener('pagehide', flush);
            document.removeEventListener('visibilitychange', flushWhenHidden);
            flush();
        };
    }, [persistWorkspaceNow]);

    useEffect(() => {
        if (tabs.some((tab) => tab.id === activeTabId && !tab.archived)) return;
        const fallback = tabs.find((tab) => !tab.archived)?.id ?? tabs[0]?.id;
        if (fallback === undefined) return;
        setActiveTabId(fallback);
        activeTabIdRef.current = fallback;
    }, [tabs, activeTabId]);

    const [isPaused, setIsPaused] = useState(true);
    useEffect(() => {
        const dismissed = () => {
            setSettings((previous) => ({ ...previous, mobileOverlayEnabled: false }));
            setIsPaused(true);
        };
        window.addEventListener('setsuna-flow-dismissed', dismissed);
        return () => window.removeEventListener('setsuna-flow-dismissed', dismissed);
    }, []);
    const isPausedRef = useRef(isPaused);
    const [timerDisplayOffset, setTimerDisplayOffset] = useState(0);
    const lastReadingActivityRef = useRef(Date.now());
    const recentIncomingTextRef = useRef<Map<string, number>>(new Map());

    useEffect(() => {
        isPausedRef.current = isPaused;
        if (!isPaused) lastReadingActivityRef.current = Date.now();
        invoke('set_flow_timer_state', { paused: isPaused }).catch(() => {});
    }, [isPaused]);

    useEffect(() => {
        let disposed = false;
        const syncFlowTimer = () => {
            invoke<boolean>('get_flow_timer_state')
                .then((paused) => {
                    if (!disposed && paused !== isPausedRef.current) setIsPaused(paused);
                })
                .catch(() => {});
        };
        syncFlowTimer();
        const interval = window.setInterval(syncFlowTimer, 250);
        return () => {
            disposed = true;
            window.clearInterval(interval);
        };
    }, []);

    const switchTab = useCallback((id: number) => {
        setActiveTabId(id);
        activeTabIdRef.current = id;
        setIsPaused(true);
        setSearchQuery("");
        setIsSearchOpen(false);
    }, []);

    const openSettingsPanel = useCallback((section?: string | null) => {
        setSettingsInitialSection(section || null);
        setIsSettingsOpen(true);
    }, []);

    const [editingTabId, setEditingTabId] = useState<number | null>(null);
    const [isFlashing, setIsFlashing] = useState(false);
    const [isSettingsOpen, setIsSettingsOpen] = useState(false);
    const [settingsInitialSection, setSettingsInitialSection] = useState<string | null>(null);
    const [lookupStack, setLookupStack] = useState<LookupData[]>([]);
    const sentenceLookupRequestRef = useRef(0);
    const [mobileLookupNotice, setMobileLookupNotice] = useState('');
    const [mobileSettingsRequest, setMobileSettingsRequest] = useState({ id: 0, section: 'reading' });
    const [playerMiningClip, setPlayerMiningClip] = useState<PlayerMiningClip | null>(null);
    const [jsonImportProgress, setJsonImportProgress] = useState<{ current: number; total: number } | null>(null);
    const [dictImportProgress, setDictImportProgress] = useState<{
        dict_name: string;
        total_dicts: number;
        current_file: number;
        total_files: number;
        words_added: number;
        status?: string;
    } | null>(null);

    useEffect(() => {
        if (!mobileLookupNotice) return;
        const timer = window.setTimeout(() => setMobileLookupNotice(''), 4200);
        return () => window.clearTimeout(timer);
    }, [mobileLookupNotice]);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const [isAppLoaded, setIsAppLoaded] = useState(false);
    const [splashMinimumElapsed, setSplashMinimumElapsed] = useState(false);
    const [splashPhase, setSplashPhase] = useState<'visible' | 'leaving' | 'hidden'>('visible');
    const [updateDialog, setUpdateDialog] = useState<UpdateDialogState | null>(null);
    const [isCheckingUpdate, setIsCheckingUpdate] = useState(false);
    const isCheckingUpdateRef = useRef(false);

    useEffect(() => {
        const timer = window.setTimeout(() => setSplashMinimumElapsed(true), 1850);
        return () => window.clearTimeout(timer);
    }, []);

    useEffect(() => {
        if (!isAppLoaded || !splashMinimumElapsed || splashPhase !== 'visible') return;
        setSplashPhase('leaving');
    }, [isAppLoaded, splashMinimumElapsed, splashPhase]);

    useEffect(() => {
        if (splashPhase !== 'leaving') return;
        const timer = window.setTimeout(() => setSplashPhase('hidden'), 600);
        return () => window.clearTimeout(timer);
    }, [splashPhase]);

    const activeTab = tabs.find((t) => t.id === activeTabId);
    const activeTabForDisplay = activeTab && timerDisplayOffset > 0
        ? { ...activeTab, stats: { ...activeTab.stats, time: activeTab.stats.time + timerDisplayOffset } }
        : activeTab;
    const textHookerTabs = useMemo(
        () => tabs.filter((tab) => !tab.mode || tab.mode === "text"),
        [tabs]
    );
    const filteredCaptureSources = captureSources.filter((source) => {
        const query = captureSourceSearch.trim().toLowerCase();
        if (!query) return true;
        return [
            source.title,
            source.app_name,
            source.process_name,
            source.path,
            source.pid?.toString() || "",
        ].some((value) => value.toLowerCase().includes(query));
    });

    useEffect(() => {
        let unlisten: UnlistenFn | undefined;
        listen<boolean>("setsuna://tray-state", (event) => {
            setIsInTray(event.payload);
            discordLastPayloadRef.current = "";
        }).then((stop) => { unlisten = stop; }).catch(() => {});
        return () => unlisten?.();
    }, []);

    useEffect(() => {
        if (!isAppLoaded) return;

        const sendPresence = async () => {
            if (Date.now() < discordDisabledUntilRef.current) return;

            if (isInTray || !settings.discordEnabled || !settings.discordClientId?.trim() || !activeTab) {
                if (discordLastPayloadRef.current) {
                    discordLastPayloadRef.current = "";
                    await invoke("clear_discord_presence").catch(() => {});
                }
                return;
            }

            const modeText = formatDiscordMode(activeTab.mode, settings);
            const tabName = settings.discordShowTab && activeTab.name ? `: ${activeTab.name}` : "";
            const details = `${modeText}${tabName}`;
            const stateBase = formatDiscordStats(activeTab, settings);
            const state = isPaused && (settings.discordShowPaused ?? true)
                ? `${formatDiscordStats(activeTab, settings)} / ${settings.appLanguage === "en" ? "Paused" : "Пауза"}`
                : stateBase;
            const smallImage = settings.discordSmallImage?.trim() || activeTab.mode || "";
            const payload = {
                enabled: true,
                clientId: settings.discordClientId.trim(),
                details,
                state,
                activityType: discordActivityTypeForMode(activeTab.mode, settings),
                startTimestampMs: settings.discordShowTimer ? discordSessionStartRef.current : null,
                largeImage: settings.discordLargeImage || "",
                largeText: "Setsuna",
                smallImage,
                smallText: modeText,
                buttonLabel: settings.discordShowButtons ? settings.discordButtonLabel : "",
                buttonUrl: settings.discordShowButtons ? settings.discordButtonUrl : "",
                secondButtonLabel: settings.discordShowButtons ? settings.discordSecondButtonLabel : "",
                secondButtonUrl: settings.discordShowButtons ? settings.discordSecondButtonUrl : "",
            };
            const payloadKey = JSON.stringify(payload);
            if (payloadKey === discordLastPayloadRef.current) return;
            discordLastPayloadRef.current = payloadKey;
            await invoke("update_discord_presence", { payload }).then(() => {
                discordFailureCountRef.current = 0;
            }).catch((error) => {
                console.warn("Discord Rich Presence update failed", error);
                discordFailureCountRef.current += 1;
                discordLastPayloadRef.current = "";
                if (discordFailureCountRef.current >= 3) {
                    discordDisabledUntilRef.current = Date.now() + 60_000;
                    invoke("clear_discord_presence").catch(() => {});
                }
            });
        };

        const initialTimer = window.setTimeout(sendPresence, 220);
        const interval = window.setInterval(sendPresence, 15000);
        return () => {
            window.clearTimeout(initialTimer);
            window.clearInterval(interval);
        };
    }, [
        isAppLoaded,
        isInTray,
        activeTab?.id,
        activeTab?.name,
        activeTab?.mode,
        activeTab?.epub?.progress,
        activeTab?.stats?.chars,
        activeTab?.stats?.words,
        activeTab?.stats?.sentences,
        isPaused,
        settings.discordEnabled,
        settings.discordClientId,
        settings.discordShowTab,
        settings.discordShowStats,
        settings.discordShowChars,
        settings.discordShowWords,
        settings.discordShowSentences,
        settings.discordShowProgress,
        settings.discordShowPaused,
        settings.discordShowTimer,
        settings.discordShowButtons,
        settings.discordTextActivityType,
        settings.discordTextStatus,
        settings.discordCustomTextStatus,
        settings.discordLargeImage,
        settings.discordSmallImage,
        settings.discordButtonLabel,
        settings.discordButtonUrl,
        settings.discordSecondButtonLabel,
        settings.discordSecondButtonUrl,
        settings.appLanguage,
    ]);

    const checkForUpdates = useCallback(async (manual = false) => {
        if (isCheckingUpdateRef.current) return;
        isCheckingUpdateRef.current = true;
        setIsCheckingUpdate(true);
        try {
            const update = await check();
            if (!update) {
                if (manual) {
                    setUpdateDialog({
                        kind: 'none',
                        message: settings.appLanguage === 'en'
                            ? 'You are already on the latest version.'
                            : 'У тебя уже последняя версия.',
                    });
                }
                return;
            }

            const skippedVersion = localStorage.getItem(SKIPPED_UPDATE_VERSION_STORAGE_KEY);
            if (!manual && skippedVersion === update.version) return;
            setUpdateDialog({ kind: 'available', update });
        } catch (error) {
            if (manual) {
                setUpdateDialog({
                    kind: 'error',
                    message: String(error),
                });
            } else {
                console.warn('Update check failed', error);
            }
        } finally {
            isCheckingUpdateRef.current = false;
            setIsCheckingUpdate(false);
        }
    }, [settings.appLanguage]);

    const installUpdate = useCallback(async () => {
        if (!updateDialog || updateDialog.kind !== 'available') return;
        const currentUpdate = updateDialog.update;
        let downloaded = 0;
        let totalBytes = 0;

        setUpdateDialog({
            kind: 'available',
            update: currentUpdate,
            progress: 0,
            message: settings.appLanguage === 'en' ? 'Downloading update...' : 'Скачиваю обновление...',
            busy: true,
        });

        try {
            await currentUpdate.downloadAndInstall((event) => {
                if (event.event === 'Started') {
                    downloaded = 0;
                    totalBytes = event.data.contentLength || 0;
                    setUpdateDialog({
                        kind: 'available',
                        update: currentUpdate,
                        progress: 0,
                        message: settings.appLanguage === 'en' ? 'Downloading update...' : 'Скачиваю обновление...',
                        busy: true,
                    });
                } else if (event.event === 'Progress') {
                    downloaded += event.data.chunkLength;
                    const percent = totalBytes > 0 ? Math.min(100, Math.round((downloaded / totalBytes) * 100)) : undefined;
                    setUpdateDialog({
                        kind: 'available',
                        update: currentUpdate,
                        progress: percent,
                        busy: true,
                        message: percent !== undefined
                            ? `${settings.appLanguage === 'en' ? 'Downloading' : 'Скачивание'} ${percent}%`
                            : settings.appLanguage === 'en' ? 'Downloading update...' : 'Скачиваю обновление...',
                    });
                } else if (event.event === 'Finished') {
                    setUpdateDialog({
                        kind: 'available',
                        update: currentUpdate,
                        progress: 100,
                        message: settings.appLanguage === 'en' ? 'Installing update...' : 'Устанавливаю обновление...',
                        busy: true,
                    });
                }
            });
            await relaunch();
        } catch (error) {
            setUpdateDialog({
                kind: 'error',
                message: String(error),
            });
        }
    }, [settings.appLanguage, updateDialog]);

    const skipCurrentUpdate = useCallback(() => {
        if (!updateDialog || updateDialog.kind !== 'available' || updateDialog.busy) return;
        localStorage.setItem(SKIPPED_UPDATE_VERSION_STORAGE_KEY, updateDialog.update.version);
        setUpdateDialog(null);
    }, [updateDialog]);

    useEffect(() => {
        if (!isAppLoaded || settings.updateAutoCheck === false) return;
        const timer = window.setTimeout(() => {
            checkForUpdates(false);
        }, 2500);
        return () => window.clearTimeout(timer);
    }, [checkForUpdates, isAppLoaded, settings.updateAutoCheck]);

    const refreshCaptureSources = useCallback(async () => {
        setIsCaptureSourceLoading(true);
        try {
            const [localWindows, localProcesses] = await Promise.all([
                invoke<CaptureWindowInfo[]>("get_capture_windows").catch(() => []),
                invoke<any[]>("get_running_processes").catch(() => []),
            ]);
            let remoteSources: CaptureWindowInfo[] = [];

            if (settings.remoteCaptureAgentUrl?.trim() && settings.remoteCaptureAgentToken?.trim()) {
                try {
                    const remote = await invoke<CaptureWindowInfo[]>("list_remote_capture_sources", {
                        url: settings.remoteCaptureAgentUrl.trim(),
                        token: settings.remoteCaptureAgentToken.trim(),
                    });
                    remoteSources = remote.map((source) => ({
                        ...source,
                        sourceType: 'remote',
                        remoteUrl: settings.remoteCaptureAgentUrl?.trim(),
                        remoteToken: settings.remoteCaptureAgentToken?.trim(),
                    }));
                } catch (error) {
                    console.error("Failed to load remote capture windows", error);
                }
            }

            const localByKey = new Map<string, CaptureWindowInfo>();
            (Array.isArray(localWindows) ? localWindows : []).forEach((source) => {
                const key = source.path || `${source.process_name || source.app_name || source.title}-${source.pid || source.id || ""}`;
                localByKey.set(key, { ...source, sourceType: 'local' });
            });
            (Array.isArray(localProcesses) ? localProcesses : []).forEach((proc) => {
                const key = proc.path || `${proc.name}-${proc.pid || ""}`;
                if (!localByKey.has(key)) {
                    localByKey.set(key, {
                        title: proc.path || proc.name,
                        app_name: proc.name,
                        process_name: proc.name,
                        path: proc.path || "",
                        pid: proc.pid,
                        width: 0,
                        height: 0,
                        icon: proc.icon || null,
                        sourceType: 'local',
                    });
                }
            });

            setCaptureSources([
                ...remoteSources,
                ...Array.from(localByKey.values()),
            ]);
        } catch (error) {
            console.error("Failed to load capture windows", error);
            setCaptureSources([]);
        } finally {
            setIsCaptureSourceLoading(false);
        }
    }, [settings.remoteCaptureAgentUrl, settings.remoteCaptureAgentToken]);

    const openCaptureSourcePicker = useCallback(() => {
        setCaptureSourceSearch("");
        setIsCaptureSourcePickerOpen(true);
        refreshCaptureSources();
    }, [refreshCaptureSources]);

    const openJlModeWindow = useCallback(() => {
        const getLastJlLine = () => {
            const active = tabs.find((tab) => tab.id === activeTabIdRef.current);
            const latestLine = active?.lines?.length ? active.lines[active.lines.length - 1] : '';
            const currentLine = removeGarbageTags(latestLine || '').trim();
            if (currentLine) return currentLine;
            return (localStorage.getItem('setsuna-jl-mode-last-line') || '').trim();
        };

        const resendLastLine = () => {
            const lastLine = getLastJlLine();
            if (lastLine.trim()) {
                localStorage.setItem('setsuna-jl-mode-last-line', lastLine);
                invoke("set_jl_mode_line", { text: lastLine }).catch(() => {});
                emit('jl_mode_line', lastLine).catch(() => {});
                emitTo('jl_mode', 'jl_mode_line', lastLine).catch(() => {});
            }
        };

        const lastLine = getLastJlLine();
        if (lastLine.trim()) {
            localStorage.setItem('setsuna-jl-mode-last-line', lastLine);
        }
        invoke("open_jl_mode_window", { initialText: lastLine })
            .then(() => {
                resendLastLine();
                window.setTimeout(resendLastLine, 200);
                window.setTimeout(resendLastLine, 800);
                window.setTimeout(resendLastLine, 1600);
            })
            .catch((err) => {
                setNotice({ title: "Setsuna Flow", message: String(err) });
            });
    }, [tabs]);

    const bindCaptureSourceToActiveTab = useCallback((source: CaptureWindowInfo) => {
        setTabs((prev) =>
            prev.map((tab) =>
                tab.id === activeTabIdRef.current
                    ? {
                          ...tab,
                          captureSource: {
                              name: source.process_name || source.app_name || source.title,
                              active: true,
                              icon: source.icon || undefined,
                              path: source.path || undefined,
                              pid: source.pid,
                              sourceType: source.sourceType || 'local',
                              remoteUrl: source.remoteUrl,
                              remoteToken: source.remoteToken,
                          },
                      }
                    : tab
            )
        );
        setIsCaptureSourcePickerOpen(false);
    }, []);

    const clearCaptureSourceForActiveTab = useCallback(() => {
        setTabs((prev) =>
            prev.map((tab) =>
                tab.id === activeTabIdRef.current ? { ...tab, captureSource: null } : tab
            )
        );
        setIsCaptureSourcePickerOpen(false);
    }, []);

    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            const key = e.key.toLowerCase();
            const code = e.code;
            const isCtrl = e.ctrlKey || e.metaKey;

            if (isCtrl && (code === 'KeyF' || key === 'f' || key === 'а')) {
                e.preventDefault();
                e.stopPropagation();
                setIsSearchOpen(true);
                setTimeout(() => searchInputRef.current?.focus(), 100);
            } else if (e.code === 'Escape' && isSearchOpen) {
                setIsSearchOpen(false);
                setSearchQuery("");
                setSearchResults([]);
                setCurrentSearchIdx(-1);
            } else if (isCtrl && (code === 'KeyZ' || key === 'z' || key === 'я')) {
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
            searchContextRef.current = { tabId: activeTab?.id ?? null, query: '' };
            selectedSearchResultRef.current = null;
            return;
        }

        const results: { lineIdx: number; matchIdx: number }[] = [];
        const lowerQuery = searchQuery.trim().toLocaleLowerCase();
        const previousContext = searchContextRef.current;
        const contextChanged = previousContext.tabId !== activeTab.id || previousContext.query !== lowerQuery;
        const previousSelection = contextChanged ? null : selectedSearchResultRef.current;

        activeTab.lines.forEach((line, lineIdx) => {
            let startIndex = 0;
            const lowerLine = line.toLocaleLowerCase();
            let matchIdx = lowerLine.indexOf(lowerQuery, startIndex);

            while (matchIdx !== -1) {
                results.push({ lineIdx, matchIdx });
                startIndex = matchIdx + lowerQuery.length;
                matchIdx = lowerLine.indexOf(lowerQuery, startIndex);
            }
        });

        searchContextRef.current = { tabId: activeTab.id, query: lowerQuery };
        setSearchResults(results);

        if (results.length > 0) {
            const preservedIndex = previousSelection
                ? results.findIndex((result) => (
                    result.lineIdx === previousSelection.lineIdx && result.matchIdx === previousSelection.matchIdx
                ))
                : -1;
            const nextIndex = preservedIndex >= 0 ? preservedIndex : 0;
            selectedSearchResultRef.current = results[nextIndex];
            setCurrentSearchIdx(nextIndex);
            if (contextChanged || preservedIndex < 0) {
                setSearchTrigger((prev) => prev + 1);
            }
        } else {
            setCurrentSearchIdx(-1);
            selectedSearchResultRef.current = null;
        }
    }, [searchQuery, activeTab?.id, activeTab?.lines]);

    const handleSearchNext = () => {
        if (searchResults.length > 0) {
            setCurrentSearchIdx((prev) => {
                const next = (prev + 1) % searchResults.length;
                selectedSearchResultRef.current = searchResults[next];
                return next;
            });
            setSearchTrigger((prev) => prev + 1);
        }
    };

    const handleSearchPrev = () => {
        if (searchResults.length > 0) {
            setCurrentSearchIdx((prev) => {
                const next = (prev - 1 + searchResults.length) % searchResults.length;
                selectedSearchResultRef.current = searchResults[next];
                return next;
            });
            setSearchTrigger((prev) => prev + 1);
        }
    };
    const diagnosticsTabsRef = useRef(tabs);
    const diagnosticsSettingsRef = useRef(settings);
    const diagnosticsLookupStackRef = useRef(lookupStack);
    const diagnosticsActiveTabIdRef = useRef(activeTabId);

    useEffect(() => {
        try {
            localStorage.setItem('txthk-settings', JSON.stringify(stripRemovedSettings({ ...settings })));
            localStorage.setItem(APP_LANGUAGE_STORAGE_KEY, settings.appLanguage || 'ru');
        } catch (error) {
            console.warn('Failed to persist settings', error);
        }
    }, [settings]);

    useEffect(() => {
        diagnosticsTabsRef.current = tabs;
    }, [tabs]);

    useEffect(() => {
        diagnosticsSettingsRef.current = settings;
    }, [settings]);

    useEffect(() => {
        diagnosticsLookupStackRef.current = lookupStack;
    }, [lookupStack]);

    useEffect(() => {
        diagnosticsActiveTabIdRef.current = activeTabId;
    }, [activeTabId]);

    useEffect(() => {
        const storageSize = (key: string) => {
            try {
                return localStorage.getItem(key)?.length || 0;
            } catch {
                return -1;
            }
        };

        const collect = () => {
            const currentTabs = diagnosticsTabsRef.current || [];
            const currentSettings = diagnosticsSettingsRef.current;
            const currentLookupStack = diagnosticsLookupStackRef.current || [];
            const currentActiveTab =
                currentTabs.find((tab) => tab.id === diagnosticsActiveTabIdRef.current) || null;
            const perfMemory = (performance as any).memory;

            const payload = {
                appLoaded: isAppLoaded,
                tabs: currentTabs.length,
                activeTabId: diagnosticsActiveTabIdRef.current,
                activeTabName: currentActiveTab?.name || "",
                activeTabMode: currentActiveTab?.mode || "text",
                activeTabLines: currentActiveTab?.mode === 'epub'
                    ? currentActiveTab?.epub?.lines?.length || 0
                    : currentActiveTab?.lines?.length || 0,
                totalLines: currentTabs.reduce((sum, tab) => sum + (tab.mode === 'epub' ? (tab.epub?.lines?.length || 0) : (tab.lines?.length || 0)), 0),
                totalChars: currentTabs.reduce(
                    (sum, tab) => {
                        const lines = tab.mode === 'epub' ? (tab.epub?.lines || []) : (tab.lines || []);
                        return sum + lines.reduce((lineSum, line) => lineSum + line.length, 0);
                    },
                    0
                ),
                lookupStack: currentLookupStack.length,
                textOrientation: currentSettings.textOrientation,
                furiganaMode: currentSettings.furiganaMode,
                useClipboard: currentSettings.useClipboard,
                websocketCount: currentSettings.websockets?.length || 0,
                activeWebsocketCount: currentSettings.websockets?.filter((ws: WsConfig) => ws.active).length || 0,
                localStorage: {
                    tabs: storageSize("txthk-tabs"),
                    settings: storageSize("txthk-settings"),
                    furigana: storageSize("furigana"),
                },
                jsHeap: perfMemory
                    ? {
                          used: perfMemory.usedJSHeapSize,
                          total: perfMemory.totalJSHeapSize,
                          limit: perfMemory.jsHeapSizeLimit,
                      }
                    : null,
            };

            invoke("log_frontend_diagnostics", { payload }).catch(() => {});
        };

        const timer = window.setInterval(collect, 10000);
        window.setTimeout(collect, 1500);
        return () => window.clearInterval(timer);
    }, [isAppLoaded]);

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

    const dictImportPromiseRef = useRef<Promise<boolean> | null>(null);
    const runDictImport = useCallback(async (filePath: string | string[]) => {
        const paths = Array.isArray(filePath) ? filePath : [filePath];
        if (paths.length === 0) return false;
        if (dictImportPromiseRef.current) {
            return dictImportPromiseRef.current;
        }
        const task = (async () => {
            setDictImportProgress({
                dict_name: t('app.importWaiting'),
                total_dicts: paths.length,
                current_file: 0,
                total_files: 1,
                words_added: 0,
                status: t('app.importPreparing'),
            });
            try {
                await invoke("import_dictionaries", { paths });
                await syncDictionaries();
                return true;
            } catch (e) {
                alert(t('app.importError', { error: String(e) }));
                return false;
            } finally {
                setDictImportProgress(null);
            }
        })();
        dictImportPromiseRef.current = task;
        try {
            return await task;
        } finally {
            if (dictImportPromiseRef.current === task) dictImportPromiseRef.current = null;
        }
    }, [syncDictionaries]);

    useEffect(() => {
        const showMobileDictionaryCopyProgress = (event: Event) => {
            const total = Math.max(1, Number((event as CustomEvent<unknown>).detail) || 1);
            setDictImportProgress({
                dict_name: t('app.importWaiting'),
                total_dicts: total,
                current_file: 0,
                total_files: total,
                words_added: 0,
                status: t('app.importPreparing'),
            });
        };
        const importMobileDictionaries = (event: Event) => {
            const raw = String((event as CustomEvent<unknown>).detail ?? '');
            try {
                const paths = JSON.parse(raw);
                if (Array.isArray(paths) && paths.length > 0 && paths.every((path) => typeof path === 'string')) {
                    void runDictImport(paths).finally(() => cleanupMobileDictionaries(paths));
                }
            } catch {
                // Ignore malformed data from a third-party Android intent.
            }
        };
        const failMobileDictionaryCopy = (event: Event) => {
            setDictImportProgress(null);
            alert(String((event as CustomEvent<unknown>).detail || t('app.importError', { error: 'unknown error' })));
        };
        const updateCopyProgress = (event: Event) => {
            try { setDictImportProgress(JSON.parse(String((event as CustomEvent).detail))); } catch {}
        };
        window.addEventListener('setsuna-mobile-dictionaries-copy-progress', updateCopyProgress);
        window.addEventListener('setsuna-mobile-dictionaries-copying', showMobileDictionaryCopyProgress);
        window.addEventListener('setsuna-mobile-dictionaries', importMobileDictionaries);
        window.addEventListener('setsuna-mobile-dictionaries-copy-failed', failMobileDictionaryCopy);
        return () => {
            window.removeEventListener('setsuna-mobile-dictionaries-copy-progress', updateCopyProgress);
            window.removeEventListener('setsuna-mobile-dictionaries-copying', showMobileDictionaryCopyProgress);
            window.removeEventListener('setsuna-mobile-dictionaries', importMobileDictionaries);
            window.removeEventListener('setsuna-mobile-dictionaries-copy-failed', failMobileDictionaryCopy);
        };
    }, [runDictImport, t]);

    const importEpubPath = useCallback(async (filePath: string, targetTabId?: number) => {
        void filePath;
        void targetTabId;
        alert(settings.appLanguage === "en"
            ? "EPUB reader is temporarily disabled while reading support is being developed."
            : "EPUB-читалка временно отключена, пока стабилизируем браузер и lookup.");
    }, [settings.appLanguage, switchTab]);

    const epubReloadingRef = useRef<Set<number>>(new Set());
    useEffect(() => {
        if (!activeTab || activeTab.mode !== 'epub') return;
        if (epubReloadingRef.current.has(activeTab.id)) return;
        epubReloadingRef.current.add(activeTab.id);
    }, [activeTab?.id, activeTab?.mode, activeTab?.epub?.path, activeTab?.epub?.chapters?.length, importEpubPath]);

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
                        ? t('app.yomitanOnlySettings')
                        : t('app.yomitanNoDictionary')
                );
                return;
            }

            const imported = await runDictImport(dictionaryFiles);
            if (!imported) return;

            if (settingsFiles.length > 0) {
                alert(t('app.yomitanImportedWithSettings'));
            } else {
                alert(t('app.yomitanImported'));
            }
        } catch (e) {
            alert(t('app.yomitanImportError', { error: String(e) }));
        }
    }, [runDictImport, syncDictionaries]);

    const importDroppedTextFiles = useCallback(async (paths: string[]) => {
        const importedTabs: Tab[] = [];

        for (const path of paths) {
            const rawBytes = await invoke<number[]>("read_file_bytes", { path });
            const bytes = new Uint8Array(rawBytes);
            let content = "";

            if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
                content = new TextDecoder("utf-16le").decode(bytes.subarray(2));
            } else if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
                const swapped = new Uint8Array(bytes.length - 2);
                for (let i = 2; i + 1 < bytes.length; i += 2) {
                    swapped[i - 2] = bytes[i + 1];
                    swapped[i - 1] = bytes[i];
                }
                content = new TextDecoder("utf-16le").decode(swapped);
            } else {
                try {
                    content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
                } catch {
                    content = new TextDecoder("shift-jis").decode(bytes);
                }
            }

            const lines: string[] = [];
            let stats = { ...defaultStats };
            const sourceLines = content.replace(/^\uFEFF/, "").split(/\r?\n/);

            for (let index = 0; index < sourceLines.length; index += 1) {
                let line = sourceLines[index]
                    .replace(/\[(?:%?[A-Za-z][A-Za-z0-9_-]*)(?:\s+[^\]\r\n]*)?\]/g, "")
                    .trim();
                if (!line) continue;

                if (settings.replacements?.length) {
                    for (const rule of settings.replacements) {
                        if (!rule.active || !rule.pattern) continue;
                        try {
                            line = rule.isRegex
                                ? line.replace(new RegExp(rule.pattern, "g"), rule.replacement)
                                : line.split(rule.pattern).join(rule.replacement);
                        } catch {}
                    }
                }

                line = trimRuntimeLine(normalizeIncomingHookText(line, false).trim());
                if (!line) continue;
                lines.push(line);
                const lineStats = calculateStats(line, settings.appLanguage);
                stats = {
                    chars: stats.chars + lineStats.chars,
                    words: stats.words + lineStats.words,
                    sentences: stats.sentences + lineStats.sentences,
                    time: 0,
                };

                if (index > 0 && index % 1000 === 0) {
                    await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
                }
            }

            if (lines.length === 0) continue;
            const id = nextTabId.current++;
            const filename = path.split(/[\\/]/).pop() || `Text ${id}`;
            const name = filename.replace(/\.txt$/i, "");
            importedTabs.push({
                id,
                name,
                lines,
                stats,
                status: "reading",
                speedSamples: [],
                mode: "text",
            });
        }

        if (importedTabs.length > 0) {
            setTabs((previous) => [...previous, ...importedTabs]);
            switchTab(importedTabs[0].id);
        }
    }, [setTabs, settings.appLanguage, settings.replacements, switchTab]);


    useEffect(() => {
        let unlistenProgress: UnlistenFn;
        let unlistenDrag: UnlistenFn;
        let disposed = false;

        listen('import_progress', (e: any) => {
            setDictImportProgress(e.payload);
        }).then((f) => {
            if (disposed) f();
            else unlistenProgress = f;
        });

        listen('tauri://drag-drop', async (event: any) => {
            const paths = event.payload?.paths as string[];
            if (!paths || paths.length === 0) return;

            const textPaths = paths.filter((path) => path.toLowerCase().endsWith('.txt'));
            if (textPaths.length > 0) {
                try {
                    await importDroppedTextFiles(textPaths);
                } catch (error) {
                    alert(settings.appLanguage === "en"
                        ? `Text import failed: ${String(error)}`
                        : `Ошибка импорта текста: ${String(error)}`);
                }
                return;
            }

            const dictionaryPaths = paths.filter((path) => {
                const lower = path.toLowerCase();
                return lower.endsWith('.zip') || lower.endsWith('.jsonl') || lower.endsWith('.jsonl.gz') || lower.endsWith('.tar.xz') || lower.endsWith('.txz') || lower.endsWith('.ifo') || lower.endsWith('.idx') || lower.endsWith('.idx.gz') || lower.endsWith('.dict') || lower.endsWith('.dict.dz') || lower.endsWith('.csv') || lower.endsWith('.tsv') || lower.endsWith('.dsl');
            });
            if (dictionaryPaths.length > 0) {
                await runDictImport(dictionaryPaths);
                return;
            }

            const file = paths[0];
            const lowerFile = file.toLowerCase();

            if (lowerFile.endsWith('.epub')) {
                await importEpubPath(file);
            } else if (lowerFile.endsWith('.json')) {
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
                                        const line = trimRuntimeLine(p.trim());
                                        importedLines.push(line);
                                        const s = calculateStats(line, settings.appLanguage);
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
                                let name = file.split(/[/\\]/).pop()?.replace('.json', '') || t('topbar.import');
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
            }
        }).then((f) => {
            if (disposed) f();
            else unlistenDrag = f;
        });

        return () => {
            disposed = true;
            if (unlistenProgress) unlistenProgress();
            if (unlistenDrag) unlistenDrag();
        };
    }, [runDictImport, importDroppedTextFiles, importEpubPath, switchTab, setTabs, settings.appLanguage]);

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
        const nativeTimer = getMobileFlowTimer();
        if (isPaused && !nativeTimer) {
            setTimerDisplayOffset(0);
            return;
        }

        let pendingSeconds = 0;
        let lastNativeSeconds = nativeTimer?.elapsedSeconds ?? 0;
        const commitElapsed = (seconds: number) => {
            if (seconds <= 0) return;
            setTabs((prev) =>
                prev.map((t) => {
                    if (t.id !== activeTabId) return t;
                    const nextStats = { ...t.stats, time: t.stats.time + seconds };
                    const crossedSampleBoundary = Math.floor(nextStats.time / 15) > Math.floor(t.stats.time / 15);
                    const speedSamples = crossedSampleBoundary
                        ? [
                              ...((t.speedSamples || []).slice(-239)),
                              {
                                  at: Date.now(),
                                  chars: nextStats.chars,
                                  words: nextStats.words,
                                  sentences: nextStats.sentences,
                                  time: nextStats.time,
                              } satisfies ReadingSpeedSample,
                          ]
                        : t.speedSamples;
                    return { ...t, stats: nextStats, speedSamples };
                })
            );
        };

        const interval = window.setInterval(() => {
                if (settings.autoPauseOnIdle) {
                    const idleMs = Math.max(1, settings.autoPauseIdleMinutes || 5) * 60_000;
                    if (Date.now() - lastReadingActivityRef.current >= idleMs) {
                        setIsPaused(true);
                        return;
                    }
                }

                const currentNativeTimer = getMobileFlowTimer();
                if (currentNativeTimer) {
                    pendingSeconds += Math.max(0, currentNativeTimer.elapsedSeconds - lastNativeSeconds);
                    lastNativeSeconds = currentNativeTimer.elapsedSeconds;
                } else {
                    pendingSeconds += 1;
                }
                setTimerDisplayOffset(pendingSeconds);
                // Tabs can contain tens of thousands of lines. Committing once per
                // second forced a full clone, stringify and render of the workspace,
                // eventually exhausting the WebView heap. Keep the live counter light
                // and only fold it into the persisted tab periodically.
                if (pendingSeconds >= 60) {
                    commitElapsed(pendingSeconds);
                    pendingSeconds = 0;
                    setTimerDisplayOffset(0);
                }
            }, 1000);

        return () => {
            window.clearInterval(interval);
            const finalNativeTimer = getMobileFlowTimer();
            if (finalNativeTimer) pendingSeconds += Math.max(0, finalNativeTimer.elapsedSeconds - lastNativeSeconds);
            commitElapsed(pendingSeconds);
            setTimerDisplayOffset(0);
        };
    }, [isPaused, activeTabId, setTabs, settings.autoPauseOnIdle, settings.autoPauseIdleMinutes]);

    const triggerFlash = useCallback(() => {
        setIsFlashing(false);
        setTimeout(() => setIsFlashing(true), 10);
    }, []);

    const handleNewText = useCallback((rawText: string, bypassPause: boolean = false, publishToTextSync: boolean = true, suppliedFurigana?: unknown) => {
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

        cleanText = normalizeIncomingHookText(cleanText, !!settings.removeWhitespace);
        cleanText = trimRuntimeLine(cleanText.trim());
        if (!cleanText) return;

        const hasSuppliedFurigana = suppliedFurigana !== undefined
            && suppliedFurigana !== null
            && (!Array.isArray(suppliedFurigana) || suppliedFurigana.length > 0);
        const enrichExistingLine = () => {
            if (!hasSuppliedFurigana) return;
            const currentTabId = activeTabIdRef.current;
            setTabs((prev) => prev.map((tab) => {
                if (tab.id !== currentTabId) return tab;
                let matchingIndex = -1;
                for (let index = tab.lines.length - 1; index >= 0; index -= 1) {
                    if (removeGarbageTags(tab.lines[index]).trim() === cleanText) {
                        matchingIndex = index;
                        break;
                    }
                }
                if (matchingIndex < 0) return tab;
                const lineFurigana = Array.isArray(tab.lineFurigana)
                    ? [...tab.lineFurigana]
                    : tab.lines.map(() => null);
                lineFurigana[matchingIndex] = suppliedFurigana;
                return { ...tab, lineFurigana };
            }));
        };

        const now = Date.now();
        const recentAt = recentIncomingTextRef.current.get(cleanText);
        if (recentAt && now - recentAt < 800) {
            enrichExistingLine();
            return;
        }
        recentIncomingTextRef.current.set(cleanText, now);
        if (recentIncomingTextRef.current.size > 80) {
            for (const [text, seenAt] of recentIncomingTextRef.current) {
                if (now - seenAt > 5000 || recentIncomingTextRef.current.size > 80) {
                    recentIncomingTextRef.current.delete(text);
                }
            }
        }

        if (settings.requireJapanese && !/[\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FAF]/.test(cleanText)) {
            return;
        }

        if (isPausedRef.current && !bypassPause) {
            triggerFlash();
            return;
        }

        lastReadingActivityRef.current = Date.now();
        try {
            localStorage.setItem('setsuna-jl-mode-last-line', cleanText);
        } catch (error) {
            console.warn('Failed to persist the latest Flow line', error);
        }
        invoke("set_jl_mode_line", { text: cleanText }).catch(() => {});
        emit('jl_mode_line', cleanText).catch(() => {});
        emitTo('jl_mode', 'jl_mode_line', cleanText).catch(() => {});
        void publishToTextSync;

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
                        if (!hasSuppliedFurigana) return t;
                        const lineFurigana = Array.isArray(t.lineFurigana)
                            ? [...t.lineFurigana]
                            : t.lines.map(() => null);
                        lineFurigana[t.lines.length - 1] = suppliedFurigana;
                        return { ...t, lineFurigana };
                    }

                    const nextLines = [...t.lines, cleanText];
                    const previousFurigana = Array.isArray(t.lineFurigana)
                        ? t.lineFurigana
                        : t.lines.map(() => null);
                    const nextFurigana = [...previousFurigana, suppliedFurigana ?? null];
                    return {
                        ...t,
                        lines: nextLines,
                        lineFurigana: nextFurigana,
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
        settings.textSyncServerEnabled,
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

    useEffect(() => {
        const receiveAndroidText = (event: Event) => {
            const text = String((event as CustomEvent<unknown>).detail ?? '').trim();
            if (text) handleNewText(text, true, false);
        };
        window.addEventListener('setsuna-mobile-text', receiveAndroidText);
        return () => window.removeEventListener('setsuna-mobile-text', receiveAndroidText);
    }, [handleNewText]);

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
            title: t('app.clearTabTitle'),
            message: t('app.clearTabMessage'),
            onConfirm: () => {
                setTabs((prev) =>
                    prev.map((t) =>
                        t.id === activeTabIdRef.current ? { ...t, lines: [], stats: defaultStats, speedSamples: [] } : t
                    )
                );
            },
        });
    };

    const handleResetSettings = () => {
        setConfirmDialog({
            title: t('app.resetTitle'),
            message: t('app.resetMessage'),
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
        setTabs((prev) => [...prev, { id: newId, name: t('tabs.newName', { id: newId }), lines: [], stats: defaultStats, speedSamples: [] }]);
        switchTab(newId);
    };

    const openTextHookerWorkspace = () => {
        const current = tabs.find((tab) => tab.id === activeTabIdRef.current);
        const currentIsTextHooker = Boolean(current && (!current.mode || current.mode === "text"));
        if (!currentIsTextHooker) {
            const existing = tabs.find((tab) => !tab.archived && (!tab.mode || tab.mode === "text"));
            if (existing) {
                switchTab(existing.id);
            } else {
                const newId = nextTabId.current++;
                setTabs((prev) => [...prev, {
                    id: newId,
                    name: t('tabs.newName', { id: newId }),
                    lines: [],
                    stats: defaultStats,
                    speedSamples: [],
                    mode: "text",
                }]);
                switchTab(newId);
            }
        }
        setActiveWorkspace("texthooker");
    };

    const openMobileSettingsPanel = (section: string = 'reading') => {
        openTextHookerWorkspace();
        setMobileSettingsRequest((current) => ({ id: current.id + 1, section }));
    };

    const openEpubWorkspace = () => { setLookupStack([]); setActiveWorkspace("epub"); };
    useEffect(() => {
        // Also hide retained native views after a main-page recovery/reload.
        if (YATSU_READER_AVAILABLE && resolvedWorkspace !== "epub") void hideYatsuWorkspace();
    }, [resolvedWorkspace]);
    const openPlayerWorkspace = () => setActiveWorkspace("player");

    const closeTabById = (id: number) => {
        const target = tabs.find((tab) => tab.id === id);
        if (!target) return;
        const visibleTextTabs = tabs.filter((tab) => !tab.archived && (!tab.mode || tab.mode === 'text'));
        if (!target.archived && (!target.mode || target.mode === 'text') && visibleTextTabs.length <= 1) return;

        const targetIndex = tabs.findIndex((tab) => tab.id === id);
        const newTabs = tabs.filter((tab) => tab.id !== id);
        setTabs(newTabs);

        if (activeTabId === id) {
            const candidates = newTabs.filter((tab) => !tab.archived && (!tab.mode || tab.mode === 'text'));
            const next = candidates.find((tab) => tabs.indexOf(tab) >= targetIndex) || candidates[candidates.length - 1];
            if (next) switchTab(next.id);
        }
    };

    const closeTab = (e: React.MouseEvent, id: number) => {
        e.stopPropagation();
        closeTabById(id);
    };

    const archiveTab = (e: React.MouseEvent, id: number) => {
        e.stopPropagation();
        const visibleTabs = tabs.filter((tab) => !tab.archived);
        if (visibleTabs.length <= 1) return;
        setTabs((prev) => prev.map((tab) => tab.id === id ? { ...tab, archived: true } : tab));
        if (activeTabIdRef.current === id) {
            const next = visibleTabs.find((tab) => tab.id !== id) || visibleTabs[0];
            if (next) switchTab(next.id);
        }
    };

    const cycleTabStatus = (e: React.MouseEvent, id: number) => {
        e.stopPropagation();
        const order: NonNullable<Tab["status"]>[] = ["planned", "reading", "paused", "completed"];
        setTabs((prev) => prev.map((tab) => {
            if (tab.id !== id) return tab;
            const currentIndex = Math.max(0, order.indexOf(tab.status || "planned"));
            return { ...tab, status: order[(currentIndex + 1) % order.length] };
        }));
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
                const content = JSON.stringify(exportData, null, 2);
                await invoke("save_sync_file", {
                    path: filePath,
                    content,
                });

                const writtenContent = await invoke<string>("load_sync_file", { path: filePath });
                if (writtenContent !== content) {
                    throw new Error(settings.appLanguage === 'en'
                        ? 'The saved file does not match the exported data.'
                        : 'Сохранённый файл не совпадает с экспортированными данными.');
                }

                const writtenData = JSON.parse(writtenContent);
                const expectedLineCount = countExportedTextLines(exportData);
                const writtenLineCount = countExportedTextLines(writtenData);
                if (writtenLineCount !== expectedLineCount) {
                    throw new Error(settings.appLanguage === 'en'
                        ? `Expected ${expectedLineCount} lines, but the saved file contains ${writtenLineCount}.`
                        : `Ожидалось строк: ${expectedLineCount}, в сохранённом файле: ${writtenLineCount}.`);
                }

                setIsExportModalOpen(false);
                setNotice({
                    title: settings.appLanguage === 'en' ? 'Export complete' : 'Экспорт завершён',
                    message: settings.appLanguage === 'en'
                        ? `${writtenLineCount.toLocaleString('en-US')} lines were written and verified.`
                        : `Записано и проверено строк: ${writtenLineCount.toLocaleString('ru-RU')}.`,
                });
            }
        } catch (error) {
            setNotice({
                title: settings.appLanguage === 'en' ? 'Export failed' : 'Ошибка экспорта',
                message: error instanceof Error ? error.message : String(error),
            });
        }
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
                                    const line = trimRuntimeLine(p.trim());
                                    importedLines.push(line);
                                    const s = calculateStats(line, settings.appLanguage);
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
                    alert(t('app.invalidImportFile'));
                }
            } catch {
                alert(t('app.fileReadError'));
                setJsonImportProgress(null);
            }
        };

        reader.readAsText(file);
        e.target.value = '';
    };

    const handleOpenImport = async () => {
        const selected = await open({
            multiple: false,
            directory: false,
            filters: [
                { name: "Setsuna text", extensions: ["json"] },
                { name: "JSON", extensions: ["json"] },
            ],
        });
        if (!selected || typeof selected !== "string") return;

        const lower = selected.toLowerCase();
        if (lower.endsWith(".epub")) {
            await importEpubPath(selected);
            return;
        }

        if (!lower.endsWith(".json")) return;
        try {
            const content = await invoke<string>("load_sync_file", { path: selected });
            const parsed = JSON.parse(content);
            if (Array.isArray(parsed) && parsed.length > 0 && parsed[0].lines !== undefined) {
                let currentId = nextTabId.current;
                const newTabs = parsed.map((tab: any) => ({ ...tab, id: currentId++ }));
                nextTabId.current = currentId;
                setTabs((prev) => [...prev, ...newTabs]);
                switchTab(newTabs[0].id);
                return;
            }

            if (parsed && parsed["bannou-texthooker-lineData"]) {
                const rawLines = parsed["bannou-texthooker-lineData"];
                const importedLines = rawLines
                    .flatMap((line: any) => String(line?.text || "").split("\n"))
                    .map((line: string) => line.trim())
                    .filter(Boolean);
                let totalChars = 0;
                let totalWords = 0;
                let totalSents = 0;
                importedLines.forEach((line: string) => {
                    const stats = calculateStats(line, settings.appLanguage);
                    totalChars += stats.chars;
                    totalWords += stats.words;
                    totalSents += stats.sentences;
                });
                const newId = nextTabId.current++;
                let name = selected.split(/[/\\]/).pop()?.replace(/\.json$/i, "") || t("topbar.import");
                if (name.length > 20) name = name.substring(0, 20) + "...";
                setTabs((prev) => [...prev, {
                    id: newId,
                    name,
                    lines: importedLines,
                    stats: { chars: totalChars, words: totalWords, sentences: totalSents, time: parsed["bannou-texthooker-timeValue"] || 0 },
                }]);
                switchTab(newId);
            } else {
                alert(t("app.invalidImportFile"));
            }
        } catch {
            alert(t("app.fileReadError"));
        }
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
    const wsUrlsRef = useRef<Record<string, string>>({});
    const wsNextRetryAtRef = useRef<Record<string, number>>({});
    const wsFailureCountRef = useRef<Record<string, number>>({});

    const wsIntentsRef = useRef(wsIntents);

    useEffect(() => {
        wsIntentsRef.current = wsIntents;
    }, [wsIntents]);

    useEffect(() => {
        setWsIntents((prev) => {
            const next = { ...prev };
            const activeSockets = (settings.websockets || []).filter((ws) => ws.active);
            const activeIds = new Set(activeSockets.map((ws) => ws.id));
            const primaryId = settings.primaryWebSocketId && activeIds.has(settings.primaryWebSocketId)
                ? settings.primaryWebSocketId
                : activeSockets[0]?.id;

            Object.keys(next).forEach((id) => {
                if (!activeIds.has(id)) next[id] = false;
            });

            activeSockets.forEach((ws) => {
                if (next[ws.id] === undefined) {
                    next[ws.id] = Boolean(settings.websocketAutoConnect && ws.id === primaryId);
                }
            });
            return next;
        });
    }, [settings.primaryWebSocketId, settings.websocketAutoConnect, settings.websockets]);

    const connectWs = useCallback((wsConfig: WsConfig) => {
        if (!wsConfig.url) return;
        const normalizedUrl = normalizeWebSocketUrl(wsConfig.url);

        try {
            setWsConnecting((prev) => ({ ...prev, [wsConfig.id]: true }));
            const ws = new WebSocket(normalizedUrl);
            wsRefs.current[wsConfig.id] = ws;
            wsUrlsRef.current[wsConfig.id] = normalizedUrl;

            ws.onopen = () => {
                wsFailureCountRef.current[wsConfig.id] = 0;
                wsNextRetryAtRef.current[wsConfig.id] = 0;
                setWsConnecting((prev) => ({ ...prev, [wsConfig.id]: false }));
                setWsStatuses((prev) => ({ ...prev, [wsConfig.id]: true }));
            };

            ws.onclose = () => {
                const failures = (wsFailureCountRef.current[wsConfig.id] || 0) + 1;
                wsFailureCountRef.current[wsConfig.id] = failures;
                const retryDelay = Math.min(60_000, failures <= 1 ? 5_000 : 5_000 * Math.pow(2, failures - 1));
                wsNextRetryAtRef.current[wsConfig.id] = Date.now() + retryDelay;
                setWsConnecting((prev) => ({ ...prev, [wsConfig.id]: false }));
                setWsStatuses((prev) => ({ ...prev, [wsConfig.id]: false }));
                delete wsRefs.current[wsConfig.id];
                delete wsUrlsRef.current[wsConfig.id];
            };

            ws.onerror = () => {
                setWsConnecting((prev) => ({ ...prev, [wsConfig.id]: false }));
                ws.close();
            };

            const receiveWsPayload = (raw: string) => {
                const payload = extractHookPayload(raw);
                if (payload.text) handleNewText(payload.text, false, true, payload.furigana);
            };

            ws.onmessage = (event) => {
                // Android WebView and hook programs do not all agree on the message
                // type. Treat text, Blob and binary frames as the same UTF-8 payload.
                if (typeof event.data === 'string') {
                    receiveWsPayload(event.data);
                } else if (event.data instanceof Blob) {
                    void event.data.text().then(receiveWsPayload).catch(() => undefined);
                } else if (event.data instanceof ArrayBuffer) {
                    receiveWsPayload(new TextDecoder().decode(event.data));
                }
            };
        } catch {
            const failures = (wsFailureCountRef.current[wsConfig.id] || 0) + 1;
            wsFailureCountRef.current[wsConfig.id] = failures;
            wsNextRetryAtRef.current[wsConfig.id] = Date.now() + Math.min(60_000, 5_000 * Math.pow(2, failures - 1));
            setWsConnecting((prev) => ({ ...prev, [wsConfig.id]: false }));
        }
    }, [handleNewText]);

    useEffect(() => {
        const syncWebSockets = () => {
            const activeSockets = (settings.websockets || []).filter((ws) => ws.active);

            Object.keys(wsRefs.current).forEach((id) => {
                const exists = activeSockets.find((w) => w.id === id);
                const normalizedUrl = exists ? normalizeWebSocketUrl(exists.url) : "";
                if (!exists || !wsIntentsRef.current[id] || wsUrlsRef.current[id] !== normalizedUrl) {
                    wsRefs.current[id].close();
                    delete wsRefs.current[id];
                    delete wsUrlsRef.current[id];

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
                const retryAt = wsNextRetryAtRef.current[wsConfig.id] || 0;
                if (wsIntentsRef.current[wsConfig.id] && !wsRefs.current[wsConfig.id] && Date.now() >= retryAt) {
                    connectWs(wsConfig);
                }
            });
        };

        syncWebSockets();
        const interval = setInterval(syncWebSockets, 3000);

        return () => clearInterval(interval);
    }, [settings.websockets, connectWs]);

    const setWsEnabled = (id: string, enabled: boolean) => {
        const next = { ...wsIntentsRef.current, [id]: enabled };
        wsIntentsRef.current = next;
        if (enabled) {
            wsFailureCountRef.current[id] = 0;
            wsNextRetryAtRef.current[id] = 0;
        } else if (wsRefs.current[id]) {
            wsRefs.current[id].close();
            delete wsRefs.current[id];
            delete wsUrlsRef.current[id];
        }
        setWsIntents(next);
    };

    const toggleWs = (id: string) => {
        setWsEnabled(id, !wsIntentsRef.current[id]);
    };

    useEffect(() => {
        return () => {
            Object.values(wsRefs.current).forEach((ws) => ws.close());
            wsRefs.current = {};
            wsUrlsRef.current = {};
        };
    }, []);

    useEffect(() => {
        if (!settings.textSyncServerEnabled) {
            invoke("stop_text_sync_server").catch(() => {});
            return;
        }

        invoke("start_text_sync_server", {
            port: settings.textSyncServerPort || 48732,
            token: settings.textSyncServerToken || undefined,
        }).catch((error) => {
            console.warn("Text sync server start failed", error);
        });

        return () => {
            invoke("stop_text_sync_server").catch(() => {});
        };
    }, [settings.textSyncServerEnabled, settings.textSyncServerPort, settings.textSyncServerToken]);

    const textSyncRemoteSeqRef = useRef(0);
    const textSyncRemoteKeyRef = useRef("");
    const textSyncRemoteBusyRef = useRef(false);
    const textSyncLastPublishedStateRef = useRef("");
    const textSyncLastAppliedRemoteStateRef = useRef("");

    const applyTextSyncStatePayload = useCallback((payload: any) => {
        if (payload?.version !== 1 || !Array.isArray(payload.tabs)) return false;
        const remoteTabs = payload.tabs
            .map((tab: any) => trimTabForRuntime(tab))
            .filter((tab: any) => typeof tab?.id === "number" && Array.isArray(tab?.lines));
        if (remoteTabs.length === 0) return false;

        const remoteActive = remoteTabs.some((tab: Tab) => tab.id === payload.activeTabId)
            ? payload.activeTabId
            : remoteTabs[0].id;
        const remoteStateKey = contentFingerprint({
            version: 1,
            activeTabId: remoteActive,
            isPaused: Boolean(payload.isPaused),
            tabs: remoteTabs,
        });

        textSyncLastAppliedRemoteStateRef.current = remoteStateKey;
        textSyncLastPublishedStateRef.current = remoteStateKey;
        setTabs(remoteTabs);
        setActiveTabId(remoteActive);
        activeTabIdRef.current = remoteActive;
        setIsPaused(Boolean(payload.isPaused));
        nextTabId.current = Math.max(...remoteTabs.map((tab: Tab) => tab.id), 0) + 1;
        return true;
    }, []);

    const textSyncRuntimeTabs = runtimeTabs;

    const textSyncStatePayload = useMemo(() => {
        return {
            version: 1,
            activeTabId,
            isPaused,
            tabs: textSyncRuntimeTabs,
        };
    }, [activeTabId, isPaused, textSyncRuntimeTabs]);

    const textSyncStateKey = useMemo(() => contentFingerprint(textSyncStatePayload), [textSyncStatePayload]);

    const localSyncQueue = useRef(createLatestTaskQueue<Record<string, unknown>>(
        (args) => invoke('publish_text_sync_event', args),
        (error) => { console.warn('Text sync state publish failed', error); textSyncLastPublishedStateRef.current = ''; },
    ));
    const remoteSyncQueue = useRef(createLatestTaskQueue<Record<string, unknown>>(
        (args) => invoke('push_remote_text_sync_event', args),
    ));
    const cloudSyncQueue = useRef(createLatestTaskQueue<Record<string, unknown>>(
        (args) => invoke('push_text_sync_cloud_state', args),
    ));

    useEffect(() => {
        if (!settings.textSyncServerEnabled) return;
        if (textSyncStateKey === textSyncLastAppliedRemoteStateRef.current) return;
        if (textSyncStateKey === textSyncLastPublishedStateRef.current) return;

        const timer = window.setTimeout(() => {
            if (textSyncStateKey === textSyncLastAppliedRemoteStateRef.current) return;
            textSyncLastPublishedStateRef.current = textSyncStateKey;
            void localSyncQueue.current.push({
                kind: "state",
                payload: textSyncStatePayload,
            });
        }, 120);

        return () => window.clearTimeout(timer);
    }, [settings.textSyncServerEnabled, textSyncStateKey, textSyncStatePayload]);

    useEffect(() => {
        const url = settings.textSyncRemoteUrl?.trim() || "";
        const token = settings.textSyncRemoteToken?.trim() || "";
        if (!settings.textSyncRemoteEnabled || !url || !token) return;
        if (textSyncStateKey === textSyncLastAppliedRemoteStateRef.current) return;

        const timer = window.setTimeout(() => {
            if (textSyncStateKey === textSyncLastAppliedRemoteStateRef.current) return;
            void remoteSyncQueue.current.push({
                url,
                token,
                kind: "state",
                payload: textSyncStatePayload,
            });
        }, 180);

        return () => window.clearTimeout(timer);
    }, [
        settings.textSyncRemoteEnabled,
        settings.textSyncRemoteUrl,
        settings.textSyncRemoteToken,
        textSyncStateKey,
        textSyncStatePayload,
    ]);

    useEffect(() => {
        const url = settings.textSyncCloudUrl?.trim() || "";
        const deviceId = settings.textSyncDeviceId?.trim() || settings.textSyncServerToken?.trim() || "setsuna";
        if (!settings.textSyncCloudEnabled || !url) return;
        if (textSyncStateKey === textSyncLastAppliedRemoteStateRef.current) return;

        const timer = window.setTimeout(() => {
            if (textSyncStateKey === textSyncLastAppliedRemoteStateRef.current) return;
            void cloudSyncQueue.current.push({ url, deviceId, stateKey: textSyncStateKey, payload: textSyncStatePayload });
        }, 350);

        return () => window.clearTimeout(timer);
    }, [
        settings.textSyncCloudEnabled,
        settings.textSyncCloudUrl,
        settings.textSyncDeviceId,
        settings.textSyncServerToken,
        textSyncStateKey,
        textSyncStatePayload,
    ]);

    const textSyncCloudBusyRef = useRef(false);
    const textSyncCloudLastRemoteKeyRef = useRef("");

    useEffect(() => {
        const url = settings.textSyncCloudUrl?.trim() || "";
        const deviceId = settings.textSyncDeviceId?.trim() || settings.textSyncServerToken?.trim() || "setsuna";
        if (!settings.textSyncCloudEnabled || !url) return;

        const poll = async () => {
            if (textSyncCloudBusyRef.current) return;
            textSyncCloudBusyRef.current = true;
            try {
                const relay = await invoke<any>("pull_text_sync_cloud_state", { url });
                const remoteDevice = String(relay?.deviceId || "");
                const remoteKey = String(relay?.stateKey || "");
                if (!remoteKey || remoteDevice === deviceId || remoteKey === textSyncCloudLastRemoteKeyRef.current) return;
                textSyncCloudLastRemoteKeyRef.current = remoteKey;
                applyTextSyncStatePayload(relay.payload);
            } catch (error) {
                console.warn("Text sync cloud pull failed", error);
            } finally {
                textSyncCloudBusyRef.current = false;
            }
        };

        poll();
        const interval = window.setInterval(poll, 1200);
        return () => window.clearInterval(interval);
    }, [
        settings.textSyncCloudEnabled,
        settings.textSyncCloudUrl,
        settings.textSyncDeviceId,
        settings.textSyncServerToken,
        applyTextSyncStatePayload,
    ]);

    useEffect(() => {
        const url = settings.textSyncRemoteUrl?.trim() || "";
        const token = settings.textSyncRemoteToken?.trim() || "";
        const enabled = Boolean(settings.textSyncRemoteEnabled && url && token);
        const remoteKey = `${url}|${token}`;

        if (textSyncRemoteKeyRef.current !== remoteKey) {
            textSyncRemoteKeyRef.current = remoteKey;
            textSyncRemoteSeqRef.current = 0;
        }

        if (!enabled) return;

        const poll = async () => {
            if (textSyncRemoteBusyRef.current) return;
            textSyncRemoteBusyRef.current = true;
            try {
                const result = await invoke<{
                    ok: boolean;
                    seq: number;
                    lines: { seq: number; text: string; atMs: number; kind?: string; payload?: any }[];
                }>(
                    "poll_remote_text_sync",
                    { url, token, since: textSyncRemoteSeqRef.current }
                );
                if (typeof result.seq === "number") {
                    textSyncRemoteSeqRef.current = Math.max(textSyncRemoteSeqRef.current, result.seq);
                }
                for (const line of result.lines || []) {
                    textSyncRemoteSeqRef.current = Math.max(textSyncRemoteSeqRef.current, line.seq || 0);
                    if (line?.kind === "state" && line.payload?.version === 1 && Array.isArray(line.payload.tabs)) {
                        applyTextSyncStatePayload(line.payload);
                        continue;
                    }

                    if ((!line?.kind || line.kind === "line") && line?.text) {
                        handleNewText(line.text, false, false);
                    }
                }
            } catch (error) {
                console.warn("Remote text sync poll failed", error);
            } finally {
                textSyncRemoteBusyRef.current = false;
            }
        };

        poll();
        const interval = window.setInterval(poll, 350);
        return () => window.clearInterval(interval);
    }, [
        settings.textSyncRemoteEnabled,
        settings.textSyncRemoteUrl,
        settings.textSyncRemoteToken,
        applyTextSyncStatePayload,
        handleNewText,
    ]);

    useEffect(() => {
        let unlisten: UnlistenFn | undefined;
        listen("text_sync_remote_event", (event: any) => {
            const payload = event?.payload;
            if (payload?.kind === "state") {
                applyTextSyncStatePayload(payload.payload);
            } else if ((!payload?.kind || payload.kind === "line") && payload?.text) {
                handleNewText(payload.text, false, false);
            }
        }).then((fn) => {
            unlisten = fn;
        }).catch((error) => {
            console.warn("Text sync event listener failed", error);
        });

        return () => {
            if (unlisten) unlisten();
        };
    }, [applyTextSyncStatePayload, handleNewText]);

    const replaceLookupStack = useCallback((data: LookupData) => {
        setLookupStack([data]);
    }, []);

    const appendLookupStack = useCallback((data: LookupData) => {
        setLookupStack((prev) => [...prev, data]);
    }, []);

    const replaceLookupStackAt = useCallback((index: number, data: LookupData) => {
        setLookupStack((prev) => [...prev.slice(0, index + 1), data]);
    }, []);

    const sliceLookupStack = useCallback((index: number) => {
        setLookupStack((prev) => prev.slice(0, index + 1));
    }, []);

    const runLookupAt = useCallback((text: string, x: number, y: number, lookupMeta?: Partial<LookupData>) => {
        const lookupText = normalizeLookupText(text);
        if (!lookupText) return;
        invoke('lookup_word', { word: lookupText }).then(async (entries: any) => {
            const localEntries = entries || [];
            const allEntries = localEntries;
            if (allEntries.length > 0) {
                setLookupStack([{
                    rect: new DOMRect(x, y, 0, 0),
                    entries: allEntries,
                    word: lookupText,
                    sentence: lookupText,
                    ...lookupMeta,
                }]);
            }
        }).catch(() => {});
    }, []);

    const runSentenceTokenLookup = useCallback(async (word: string, sentence: string, cursor?: number) => {
        const requestedWord = normalizeLookupText(word);
        if (!requestedWord) return null;
        const requestId = ++sentenceLookupRequestRef.current;
        // Keep the current sheet interactive until the replacement is ready. The
        // old close-first path left the token layer in a dead state on slower phones.
        setMobileLookupNotice('');
        const rect = new DOMRect(window.innerWidth / 2, Math.max(110, window.innerHeight * 0.3), 0, 0);
        try {
            let resolvedWord = requestedWord;
            let localEntries: DictEntry[] = [];
            let match = {
                start: Number.isFinite(cursor) ? Number(cursor) : 0,
                length: Array.from(requestedWord).length,
            };

            // Sentence scanning is authoritative. Like Yomitan, it starts at the
            // selected word boundary and tests progressively shorter source strings,
            // so a tokenizer hint such as 可愛 can still resolve 可愛がりたい -> 可愛がる.
            if (Number.isFinite(cursor) && sentence) {
                try {
                    const rawResult = await invoke<{
                        entries: DictEntry[];
                        start?: number;
                        end?: number;
                        match_start?: number;
                        match_len?: number;
                        word: string;
                    } | null>('scan_cursor', { sentence, cursor });
                    const result = selectActiveLookupResult(rawResult, sentence, settings);
                    if (result) {
                        if (requestId !== sentenceLookupRequestRef.current) return null;
                        resolvedWord = normalizeLookupText(result.word) || requestedWord;
                        localEntries = Array.isArray(result.entries) ? result.entries : [];
                        const start = Number.isFinite(result.match_start)
                            ? Number(result.match_start)
                            : Number(result.start);
                        const length = Number.isFinite(result.match_len)
                            ? Number(result.match_len)
                            : Number(result.end) - start;
                        if (Number.isFinite(start) && Number.isFinite(length) && length > 0) {
                            match = { start, length };
                        }
                    }
                } catch {
                    // Direct lookup below remains useful for incomplete pasted text.
                }
            }

            if (localEntries.length === 0) {
                try {
                    const entries = await invoke<DictEntry[]>('lookup_word', { word: requestedWord });
                    if (requestId !== sentenceLookupRequestRef.current) return null;
                    localEntries = Array.isArray(entries) ? entries : [];
                    resolvedWord = requestedWord;
                } catch {
                    localEntries = [];
                }
            }

            const entries = localEntries;
            if (requestId !== sentenceLookupRequestRef.current) return null;
            if (entries.length === 0) {
                setLookupStack([]);
                setMobileLookupNotice(settings.appLanguage === 'en'
                    ? `No dictionary entry for “${resolvedWord}”. Tap another block or import a larger dictionary.`
                    : `Для «${resolvedWord}» нет статьи. Нажми на соседний блок или импортируй более полный словарь.`);
                return null;
            }

            setMobileLookupNotice('');
            setLookupStack([{
                rect,
                entries,
                word: resolvedWord,
                sentence: sentence || resolvedWord,
            }]);
            return match;
        } catch (error) {
            if (requestId !== sentenceLookupRequestRef.current) return null;
            console.warn('Sentence token lookup failed', error);
            setMobileLookupNotice(settings.appLanguage === 'en'
                ? 'Lookup failed. Check the dictionary database and try again.'
                : 'Лукап не сработал. Проверь базу словарей и попробуй ещё раз.');
            return null;
        }
    }, [settings]);

    useEffect(() => {
        const receiveOverlayLookup = (event: Event) => {
            const text = String((event as CustomEvent<unknown>).detail ?? '').trim();
            if (!text) return;
            runLookupAt(text, window.innerWidth / 2, Math.max(120, window.innerHeight * 0.3));
        };
        window.addEventListener('setsuna-mobile-lookup', receiveOverlayLookup);
        return () => window.removeEventListener('setsuna-mobile-lookup', receiveOverlayLookup);
    }, [runLookupAt]);

    if (!isAppLoaded) {
        return <StartupSplash />;
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
            {splashPhase !== 'hidden' && <StartupSplash leaving={splashPhase === 'leaving'} />}
            <SetupWizard
                isOpen={!isMobileLayout && isFirstRunWizardOpen}
                onClose={closeFirstRunWizard}
                onImportYomitan={handleImportYomitanFromWizard}
                installedDictionariesCount={settings.dictionaries?.length || 0}
                ankiDeck={settings.ankiDeck}
                ankiModel={settings.ankiModel}
                settings={settings}
                onSettingsPatch={(patch) => setSettings((prev) => {
                    const next = { ...prev, ...patch };
                    try {
                        localStorage.setItem('txthk-settings', JSON.stringify(stripRemovedSettings({ ...next })));
                        if (patch.appLanguage === 'ru' || patch.appLanguage === 'en') {
                            localStorage.setItem(APP_LANGUAGE_STORAGE_KEY, patch.appLanguage);
                        }
                    } catch (error) {
                        console.warn('Failed to persist setup wizard settings', error);
                    }
                    return next;
                })}
                onAnkiDeckChange={(deck) => setSettings((prev) => ({ ...prev, ankiDeck: deck }))}
            />
            {floatingBtn && (
                <button
                    onClick={(e) => {
                        e.stopPropagation();
                        runLookupAt(floatingBtn.text, floatingBtn.x, floatingBtn.y);
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
                language={settings.appLanguage}
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

            <ImportProgressModal jsonProgress={jsonImportProgress} dictProgress={dictImportProgress} language={settings.appLanguage} />
            <ConfirmDialogModal dialog={confirmDialog} setDialog={setConfirmDialog} language={settings.appLanguage} />
            <NoticeModal notice={notice} setNotice={setNotice} language={settings.appLanguage} />

            <ExportModal
                isOpen={isExportModalOpen}
                onClose={() => setIsExportModalOpen(false)}
                fileName={exportFileName}
                setFileName={setExportFileName}
                tabs={tabs}
                selection={exportTabsSelection}
                setSelection={setExportTabsSelection}
                onExport={executeExport}
                language={settings.appLanguage}
            />

            {updateDialog && (
                <div
                    onClick={() => (updateDialog.kind !== 'available' || !updateDialog.busy) && setUpdateDialog(null)}
                    style={{
                        position: 'fixed',
                        inset: 0,
                        background: 'rgba(0, 0, 0, 0.55)',
                        zIndex: 13000,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        padding: '24px',
                    }}
                >
                    <div
                        onClick={(e) => e.stopPropagation()}
                        style={{
                            width: 'min(420px, 92vw)',
                            background: 'var(--bg-panel)',
                            border: '1px solid var(--border-main)',
                            borderRadius: '8px',
                            boxShadow: '0 24px 80px rgba(0,0,0,0.45)',
                            padding: '20px',
                            color: 'var(--text-main)',
                        }}
                    >
                        <div style={{ fontWeight: 800, marginBottom: 10 }}>
                            {updateDialog.kind === 'available'
                                ? (settings.appLanguage === 'en' ? 'Update available' : 'Есть обновление')
                                : updateDialog.kind === 'error'
                                    ? (settings.appLanguage === 'en' ? 'Update check failed' : 'Ошибка обновления')
                                    : (settings.appLanguage === 'en' ? 'No updates' : 'Обновлений нет')}
                        </div>
                        {updateDialog.kind === 'available' ? (
                            <>
                                <div style={{ color: 'var(--text-muted)', fontSize: 13, lineHeight: 1.5, marginBottom: 14 }}>
                                    {settings.appLanguage === 'en' ? 'A new Setsuna build is ready.' : 'Новая сборка Setsuna готова к установке.'}
                                    {updateDialog.update.version ? ` ${settings.appLanguage === 'en' ? 'Version' : 'Версия'} ${updateDialog.update.version}.` : ''}
                                </div>
                                {updateDialog.update.body && !updateDialog.busy && (
                                    <div style={{ maxHeight: 120, overflowY: 'auto', whiteSpace: 'pre-wrap', color: 'var(--text-muted)', background: 'var(--bg-side)', border: '1px solid var(--border-main)', borderRadius: 6, padding: 10, fontSize: 12, lineHeight: 1.5, marginBottom: 14 }}>
                                        {updateDialog.update.body}
                                    </div>
                                )}
                                {updateDialog.message && <div style={{ color: 'var(--text-muted)', fontSize: 12, marginBottom: 10 }}>{updateDialog.message}</div>}
                                {updateDialog.progress !== undefined && (
                                    <div style={{ height: 6, background: 'var(--bg-side)', borderRadius: 999, overflow: 'hidden', marginBottom: 14 }}>
                                        <div style={{ width: `${updateDialog.progress}%`, height: '100%', background: 'var(--accent-blue)' }} />
                                    </div>
                                )}
                                <div style={{ display: 'flex', justifyContent: 'flex-end', flexWrap: 'wrap', gap: 10 }}>
                                    <button className="btn-secondary" disabled={updateDialog.busy} onClick={skipCurrentUpdate} style={{ padding: '8px 12px', opacity: updateDialog.busy ? 0.55 : 1 }}>
                                        {settings.appLanguage === 'en' ? 'Skip this version' : 'Пропустить версию'}
                                    </button>
                                    <button className="btn-secondary" disabled={updateDialog.busy} onClick={() => setUpdateDialog(null)} style={{ padding: '8px 12px', opacity: updateDialog.busy ? 0.55 : 1 }}>
                                        {settings.appLanguage === 'en' ? 'Later' : 'Позже'}
                                    </button>
                                    <button className="btn-primary" disabled={updateDialog.busy} onClick={installUpdate} style={{ padding: '8px 12px', opacity: updateDialog.busy ? 0.7 : 1 }}>
                                        {updateDialog.busy
                                            ? (settings.appLanguage === 'en' ? 'Updating...' : 'Обновляю...')
                                            : (settings.appLanguage === 'en' ? 'Install and restart' : 'Установить и перезапустить')}
                                    </button>
                                </div>
                                {!updateDialog.busy && (
                                    <div style={{ color: 'var(--text-muted)', fontSize: 11, marginTop: 12 }}>
                                        {settings.appLanguage === 'en'
                                            ? `Installed: ${releaseInfo.displayVersion}`
                                            : `Установлено: ${releaseInfo.displayVersion}`}
                                    </div>
                                )}
                            </>
                        ) : (
                            <>
                                <div style={{ color: 'var(--text-muted)', fontSize: 13, lineHeight: 1.5, marginBottom: 14 }}>
                                    {updateDialog.message}
                                </div>
                                <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                                    <button className="btn-primary" onClick={() => setUpdateDialog(null)} style={{ padding: '8px 12px' }}>
                                        OK
                                    </button>
                                </div>
                            </>
                        )}
                    </div>
                </div>
            )}

            {isCaptureSourcePickerOpen && (
                <div
                    onClick={() => setIsCaptureSourcePickerOpen(false)}
                    style={{
                        position: 'fixed',
                        inset: 0,
                        background: 'rgba(0, 0, 0, 0.55)',
                        zIndex: 12000,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        padding: '24px',
                    }}
                >
                    <div
                        onClick={(e) => e.stopPropagation()}
                        style={{
                            width: 'min(760px, 96vw)',
                            maxHeight: '82vh',
                            background: 'var(--bg-panel)',
                            border: '1px solid var(--border-main)',
                            borderRadius: '8px',
                            boxShadow: '0 20px 60px rgba(0,0,0,0.45)',
                            display: 'flex',
                            flexDirection: 'column',
                            overflow: 'hidden',
                        }}
                    >
                        <div
                            style={{
                                padding: '16px 18px',
                                borderBottom: '1px solid var(--border-main)',
                                display: 'flex',
                                alignItems: 'center',
                                gap: '12px',
                            }}
                        >
                            <IconPin />
                            <div style={{ flex: 1, minWidth: 0 }}>
                                <div style={{ color: 'var(--text-main)', fontWeight: 700 }}>
                                    {t('capture.bindTitle', { tab: activeTab?.name || '' })}
                                </div>
                                <div
                                    style={{
                                        color: 'var(--text-muted)',
                                        fontSize: '12px',
                                        overflow: 'hidden',
                                        textOverflow: 'ellipsis',
                                        whiteSpace: 'nowrap',
                                    }}
                                >
                                    {activeTab?.captureSource?.name
                                        ? t('capture.current', { source: activeTab.captureSource.name })
                                        : t('capture.notBound')}
                                </div>
                            </div>
                            <button className="modal-btn" onClick={refreshCaptureSources} style={{ background: 'var(--bg-side)', color: 'var(--text-main)', border: '1px solid var(--border-main)', borderRadius: '6px', padding: '8px 12px', cursor: 'pointer', font: 'inherit', fontSize: '12px' }}>
                                {isCaptureSourceLoading ? t('common.loading') : t('common.refresh')}
                            </button>
                            <button className="modal-btn" onClick={() => setIsCaptureSourcePickerOpen(false)} style={{ background: 'var(--bg-side)', color: 'var(--text-main)', border: '1px solid var(--border-main)', borderRadius: '6px', padding: '8px 12px', cursor: 'pointer', font: 'inherit', fontSize: '12px' }}>
                                {t('common.close')}
                            </button>
                        </div>

                        <div style={{ padding: '14px 18px 10px' }}>
                            <input
                                value={captureSourceSearch}
                                onChange={(e) => setCaptureSourceSearch(e.target.value)}
                                placeholder={t('capture.searchPlaceholder')}
                                style={{
                                    width: '100%',
                                    background: 'var(--bg-main)',
                                    color: 'var(--text-main)',
                                    border: '1px solid var(--border-main)',
                                    borderRadius: '6px',
                                    padding: '10px 12px',
                                    outline: 'none',
                                }}
                            />
                        </div>

                        <div style={{ padding: '0 18px 16px', overflowY: 'auto' }}>
                            {activeTab?.captureSource?.name && (
                                <button
                                    onClick={clearCaptureSourceForActiveTab}
                                    className="modal-btn"
                                    style={{ width: '100%', marginBottom: '10px', justifyContent: 'center', background: 'var(--bg-side)', color: 'var(--text-main)', border: '1px solid var(--border-main)', borderRadius: '6px', padding: '8px 12px', cursor: 'pointer', font: 'inherit', fontSize: '12px' }}
                                >
                                    {t('capture.useGlobal')}
                                </button>
                            )}

                            {filteredCaptureSources.length === 0 ? (
                                <div style={{ color: 'var(--text-muted)', padding: '20px 4px' }}>
                                    {isCaptureSourceLoading ? t('common.loading') : t('capture.empty')}
                                </div>
                            ) : (
                                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                                    {filteredCaptureSources.map((source, index) => {
                                        const focused = Boolean(source.is_focused);
                                        const recent = Boolean(source.is_recent);
                                        const isRemote = source.sourceType === 'remote';
                                        const iconSrc = source.icon
                                            ? (source.icon.startsWith('data:') ? source.icon : `data:image/png;base64,${source.icon}`)
                                            : "";
                                        const hasWindow = Boolean(source.width || source.height);
                                        const primaryLabel = hasWindow && source.title
                                            ? source.title
                                            : source.process_name || source.app_name || source.title || source.path;
                                        const secondaryLabel = hasWindow && source.title
                                            ? [source.process_name || source.app_name, source.path].filter(Boolean).join(' · ')
                                            : source.title || source.path;
                                        return (
                                        <div
                                            key={`${source.pid || 'nopid'}-${source.title}-${index}`}
                                            onClick={() => bindCaptureSourceToActiveTab(source)}
                                            role="button"
                                            tabIndex={0}
                                            onKeyDown={(e) => {
                                                if (e.key === 'Enter' || e.key === ' ') bindCaptureSourceToActiveTab(source);
                                            }}
                                            style={{
                                                width: '100%',
                                                textAlign: 'left',
                                                background: 'var(--bg-side)',
                                                color: 'var(--text-main)',
                                                border: '1px solid var(--border-main)',
                                                borderRadius: '8px',
                                                padding: '10px 12px',
                                                display: 'grid',
                                                gridTemplateColumns: '32px 1fr auto',
                                                gap: '10px',
                                                alignItems: 'center',
                                                cursor: 'pointer',
                                                appearance: 'none',
                                                font: 'inherit',
                                            }}
                                        >
                                            <div
                                                style={{
                                                    width: '28px',
                                                    height: '28px',
                                                    borderRadius: '6px',
                                                    background: 'var(--bg-main)',
                                                    display: 'flex',
                                                    alignItems: 'center',
                                                    justifyContent: 'center',
                                                    overflow: 'hidden',
                                                }}
                                            >
                                                {iconSrc ? (
                                                    <img
                                                        src={iconSrc}
                                                        alt=""
                                                        style={{ width: '20px', height: '20px' }}
                                                    />
                                                ) : (
                                                    <IconPin />
                                                )}
                                            </div>
                                            <div style={{ minWidth: 0 }}>
                                                <div
                                                    style={{
                                                        fontWeight: 700,
                                                        overflow: 'hidden',
                                                        textOverflow: 'ellipsis',
                                                        whiteSpace: 'nowrap',
                                                    }}
                                                >
                                                    {primaryLabel}
                                                </div>
                                                <div
                                                    style={{
                                                        color: 'var(--text-muted)',
                                                        fontSize: '12px',
                                                        overflow: 'hidden',
                                                        textOverflow: 'ellipsis',
                                                        whiteSpace: 'nowrap',
                                                    }}
                                                >
                                                    {secondaryLabel}
                                                </div>
                                            </div>
                                            <div
                                                style={{
                                                    color: focused || recent || isRemote ? 'var(--accent-blue)' : 'var(--text-muted)',
                                                    fontSize: '12px',
                                                    whiteSpace: 'nowrap',
                                                }}
                                            >
                                                {isRemote ? 'LAN · ' : ''}
                                                {source.pid ? `PID ${source.pid}` : ''}
                                                {focused ? ` · ${t('capture.focused')}` : ''}
                                                {!focused && recent ? ` · ${t('capture.recent')}` : ''}
                                            </div>
                                        </div>
                                    )})}
                                </div>
                            )}
                        </div>
                    </div>
                </div>
            )}

            <input
                type="file"
                accept=".json,.epub"
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
                    transition: 'all 0.3s cubic-bezier(0.4, 0, 0.2, 1)',
                }}
            >
                {resolvedWorkspace === "hub" ? (
                    <HomeScreen
                        language={settings.appLanguage}
                        wsConnected={Object.values(wsStatuses).some(Boolean)}
                        onTextHooker={openTextHookerWorkspace}
                        onEpub={openEpubWorkspace}
                        onPlayer={openPlayerWorkspace}
                        onAnki={() => isMobileLayout ? openMobileSettingsPanel('anki') : openSettingsPanel('anki-cards')}
                        onSettings={() => isMobileLayout ? openMobileSettingsPanel('reading') : openSettingsPanel()}
                    />
                ) : resolvedWorkspace === "epub" ? (YATSU_READER_AVAILABLE ? (
                    <YatsuWorkspace language={settings.appLanguage} onHome={() => setActiveWorkspace("hub")} />
                ) : (
                    <WorkspaceShell
                        title={settings.appLanguage === "en" ? "EPUB Reader" : "EPUB-ридер"}
                        icon={<IconBookTab />}
                        accent="reader"
                        language={settings.appLanguage}
                        onHome={() => setActiveWorkspace("hub")}
                        onSettings={() => openSettingsPanel('epub-reader')}
                    >
                        <div className="mode-empty-state">
                            <span className="mode-empty-icon"><IconBookTab /></span>
                            <strong>{settings.appLanguage === "en" ? "EPUB Reader" : "EPUB-ридер"}</strong>
                            <span>{settings.appLanguage === "en" ? "The reader workspace is ready for the next implementation step." : "Рабочее пространство ридера готово к следующему этапу реализации."}</span>
                        </div>
                    </WorkspaceShell>
                )) : resolvedWorkspace === "player" ? (
                    <WorkspaceShell
                        title={settings.appLanguage === "en" ? "Anime Player" : "Аниме-плеер"}
                        icon={<IconPlayerTab />}
                        accent="player"
                        language={settings.appLanguage}
                        onHome={() => setActiveWorkspace("hub")}
                        onSettings={() => openSettingsPanel('player-main')}
                    >
                        <PlayerSkeleton
                            language={settings.appLanguage}
                            settings={settings}
                            onClipReady={setPlayerMiningClip}
                        />
                    </WorkspaceShell>
                ) : isMobileLayout ? (
                    <MobileLayout
                        tabs={textHookerTabs}
                        activeTab={activeTabForDisplay}
                        activeTabId={activeTabId}
                        switchTab={switchTab}
                        addNewTab={addNewTab}
                        closeTab={closeTabById}
                        settings={settings}
                        isPaused={isPaused}
                        setIsPaused={setIsPaused}
                        deleteLine={deleteLine}
                        editLine={editLine}
                        searchQuery={searchQuery}
                        searchResults={searchResults}
                        currentSearchIdx={currentSearchIdx}
                        searchTrigger={searchTrigger}
                        onSubmitText={(text: string) => handleNewText(text, true)}
                        onLookupText={(text: string) => runLookupAt(text, window.innerWidth / 2, Math.max(120, window.innerHeight * 0.35))}
                        onLookupSentenceToken={runSentenceTokenLookup}
                        updateSettings={setSettings}
                        setTabs={setTabs}
                        syncDictionaries={syncDictionaries}
                        runDictImport={runDictImport}
                        setConfirmDialog={setConfirmDialog}
                        openImport={handleOpenImport}
                        clearAll={clearAll}
                        openSettings={() => openSettingsPanel()}
                        wsStatuses={wsStatuses}
                        wsConnecting={wsConnecting}
                        wsIntents={wsIntents}
                        toggleWs={toggleWs}
                        setWsEnabled={setWsEnabled}
                        lookupOpen={lookupStack.length > 0}
                        onCloseLookup={() => setLookupStack([])}
                        lookupNotice={mobileLookupNotice}
                        settingsRequest={mobileSettingsRequest}
                    />
                ) : (
                <>
                <TopBar
                    openEpubWorkspace={openEpubWorkspace}
                    tabs={textHookerTabs}
                    activeTabId={activeTabId}
                    switchTab={switchTab}
                    editingTabId={editingTabId}
                    setEditingTabId={setEditingTabId}
                    setTabs={setTabs}
                    closeTab={closeTab}
                    archiveTab={archiveTab}
                    openArchiveSettings={() => openSettingsPanel('archive-main')}
                    cycleTabStatus={cycleTabStatus}
                    addNewTab={addNewTab}
                    settings={{ ...settings, websockets: settings.websockets?.filter((w) => w.active) }}
                    wsStatuses={wsStatuses}
                    wsConnecting={wsConnecting}
                    wsIntents={wsIntents}
                    toggleWs={toggleWs}
                    textSyncServerEnabled={settings.textSyncServerEnabled}
                    textSyncRemoteEnabled={settings.textSyncRemoteEnabled}
                    textSyncRemoteConfigured={Boolean(settings.textSyncRemoteUrl?.trim() && settings.textSyncRemoteToken?.trim())}
                    textSyncCloudEnabled={settings.textSyncCloudEnabled}
                    textSyncCloudConfigured={Boolean(settings.textSyncCloudUrl?.trim())}
                    toggleTextSyncRemote={() => {
                        if (settings.textSyncCloudUrl?.trim()) {
                            setSettings({ ...settings, textSyncCloudEnabled: !settings.textSyncCloudEnabled });
                        } else if (settings.textSyncRemoteUrl?.trim() && settings.textSyncRemoteToken?.trim()) {
                            setSettings({ ...settings, textSyncRemoteEnabled: !settings.textSyncRemoteEnabled });
                        } else {
                            openSettingsPanel('text-src');
                        }
                    }}
                    openTextSyncSettings={() => openSettingsPanel('text-src')}
                    useClipboard={settings.useClipboard}
                    toggleClipboard={() => setSettings({ ...settings, useClipboard: !settings.useClipboard })}
                    openSearch={() => {
                        setIsSearchOpen(true);
                        setTimeout(() => searchInputRef.current?.focus(), 100);
                    }}
                    openImport={handleOpenImport}
                    openExport={openExportModal}
                    activeTab={activeTab}
                    openCaptureSourcePicker={openCaptureSourcePicker}
                    openJlModeWindow={openJlModeWindow}
                    clearAll={clearAll}
                    openHome={() => setActiveWorkspace("hub")}
                    openSettings={() => openSettingsPanel()}
                />

                <main ref={mainContentRef} className="main-content" style={{ flex: 1, minHeight: 0, overflow: 'hidden' }}>
                    <TextContainer
                        contentKey={activeTab?.id ?? activeTabId}
                        lines={activeTab?.lines || EMPTY_LINES}
                        lineFurigana={activeTab?.lineFurigana || []}
                        onDelete={deleteLine}
                        onEdit={editLine}
                        furiganaMode="none"
                        autoScrollOffset={settings?.autoScrollOffset ?? 80}
                        searchQuery={searchQuery}
                        activeSearchLineIdx={searchResults[currentSearchIdx]?.lineIdx ?? -1}
                        searchTrigger={searchTrigger}
                        panelPosition={settings.panelPosition}
                        language={settings.appLanguage}
                        textOrientation={settings.textOrientation}
                    />
                </main>

                <StatsPanel
                    isPaused={isPaused}
                    onTogglePause={() => setIsPaused(!isPaused)}
                    stats={activeTabForDisplay?.stats || defaultStats}
                    speedSamples={activeTab?.speedSamples || []}
                    position={settings.panelPosition}
                    speedMetric={settings.speedMetric}
                    speedTimeframe={settings.speedTimeframe}
                    language={settings.appLanguage}
                    textOrientation={settings.textOrientation}
                />
                </>
                )}

                <SettingsModal
                    isOpen={isSettingsOpen}
                    onClose={() => {
                        setIsSettingsOpen(false);
                        setSettingsInitialSection(null);
                    }}
                    settings={settings}
                    onSettingsChange={setSettings}
                    tabs={textHookerTabs}
                    setTabs={setTabs}
                    syncDictionaries={syncDictionaries}
                    runDictImport={runDictImport}
                    onResetSettings={handleResetSettings}
                    onClearLookup={() => setLookupStack([])}
                    onCheckForUpdates={checkForUpdates}
                    updateChecking={isCheckingUpdate}
                    onOpenArchivedTab={(id) => {
                        setTabs((prev) => prev.map((tab) => tab.id === id ? { ...tab, archived: false } : tab));
                        switchTab(id);
                        setActiveWorkspace("texthooker");
                        setIsSettingsOpen(false);
                        setSettingsInitialSection(null);
                    }}
                    initialSection={settingsInitialSection}
                />

                {resolvedWorkspace !== "hub" && (
                    <LookupSurface
                        mode="internal"
                        stack={lookupStack}
                        onAppend={appendLookupStack}
                        onReplace={replaceLookupStack}
                        onReplaceAt={replaceLookupStackAt}
                        onSlice={sliceLookupStack}
                        settings={settings}
                        playerClip={playerMiningClip}
                        captureSource={resolvedWorkspace === "texthooker" ? (activeTab?.captureSource || null) : null}
                        ankiDeck={isMobileLayout && resolvedWorkspace === "texthooker"
                            ? (activeTab?.ankiDeck || settings.ankiDeck)
                            : settings.ankiDeckMode === 'contextual' && resolvedWorkspace === "texthooker"
                                ? (activeTab?.ankiDeck || settings.ankiDeck)
                                : settings.ankiDeck}
                        onClose={() => setLookupStack([])}
                    />
                )}
            </div>

        </div>
    );
}
