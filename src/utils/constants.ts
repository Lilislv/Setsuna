import { AppSettings } from "../components/SettingsModal";

export interface TabStats { chars: number; words: number; sentences: number; time: number; }
export interface ReadingSpeedSample {
    at: number;
    chars: number;
    words: number;
    sentences: number;
    time: number;
}
export interface CaptureSourceBinding {
    name: string;
    active: boolean;
    icon?: string;
    path?: string;
    pid?: number;
    sourceType?: 'local' | 'remote';
    remoteUrl?: string;
    remoteToken?: string;
}
export interface EpubBookData {
    title: string;
    path?: string;
    lines: string[];
    html?: string;
    blocks?: EpubContentBlock[];
    chapters?: EpubChapter[];
    progress: number;
}
export type EpubContentBlock =
    | { type: 'text'; text: string; html?: string; id?: string; href?: string }
    | { type: 'image'; src: string; alt?: string; id?: string };
export interface EpubChapter {
    id: string;
    href: string;
    title?: string | null;
    html: string;
    css?: string;
    text?: string;
    body_class?: string | null;
    html_class?: string | null;
}
export interface Tab {
    id: number;
    name: string;
    lines: string[];
    /** Optional furigana markup/tokens supplied by a WebSocket source, aligned with lines. */
    lineFurigana?: unknown[];
    stats: TabStats;
    status?: 'planned' | 'reading' | 'paused' | 'completed';
    archived?: boolean;
    speedSamples?: ReadingSpeedSample[];
    captureSource?: CaptureSourceBinding | null;
    ankiDeck?: string | null;
    mode?: 'text' | 'epub' | 'player';
    readerProgress?: number;
    epub?: EpubBookData;
}
export interface BrowserTab {
    id: string;
    url: string;
    title: string;
    favicon?: string;
}

export interface PlayerMiningClip {
    path?: string;
    filename?: string;
    mediaType?: 'audio' | 'video';
    subtitle: string;
    videoName: string;
    start: number;
    end: number;
    createdAt: number;
}

export const defaultStats: TabStats = { chars: 0, words: 0, sentences: 0, time: 0 };
export const EMPTY_LINES: string[] = [];

export const DEFAULT_SETTINGS: AppSettings = {
    useClipboard: true,
    panelPosition: 'bottom', speedMetric: 'chars', speedTimeframe: 'minute',
    autoPauseOnIdle: false,
    autoPauseIdleMinutes: 5,
    allowManualPaste: true, allowManualPasteDuringPause: true,
    lookupHotkey: 'Shift',
    lookupScale: 1.0, 
    lookupFontSize: 14, 
    lookupTagFontSize: 11, 
    lookupWidth: 380,
    lookupShowTags: true,
    lookupShowAudio: true,
    globalLookupEnabled: false,
    globalLookupRestoreClipboard: true,
    globalLookupShortcut: 'Alt+Q',
    cambridgeApiEnabled: false,
    cambridgeApiKey: '',
    cambridgeApiDictionary: 'english-russian',
    cambridgeApiBaseUrl: 'https://dictionary.cambridge.org/api/v1',
    cambridgeApiOnlyWhenNoLocal: true,
    hookProcesses: [], 
    ankiDeck: '', ankiModel: '',
    ankiDeckMode: 'shared',
    ankiGlobalDeck: '',
    ankiFieldWord: '', ankiFieldReading: '', ankiFieldMeaning: '', ankiFieldSentence: '', ankiFieldSentenceFurigana: '', ankiFieldDict: '',
    ankiFieldAudio: '', ankiFieldPitch: '', ankiFieldFreq: '', ankiFieldScreenshot: '',
    ankiShowButtonNormal: true, ankiShowButtonScreenshot: true,
    dictionaries: [], autoPlayAudio: true, helperUrl: "https://chatgpt.com/", syncPin: '',
    remoteCaptureAgentUrl: '', remoteCaptureAgentToken: '', localCaptureAgentToken: '',
    textSyncServerEnabled: false,
    textSyncServerPort: 48732,
    textSyncServerToken: '',
    textSyncDeviceId: '',
    textSyncCloudEnabled: false,
    textSyncCloudUrl: '',
    accountApiBaseUrl: 'https://setsunalookup.ru/api',
    accountEmail: '',
    accountAccessToken: '',
    accountUserId: '',
    accountDeviceName: '',
    textSyncRemoteEnabled: false,
    textSyncRemoteUrl: '',
    textSyncRemoteToken: '',
    ankiColorNew: '#4CAF50', ankiColorOther: '#4fa6ff', ankiColorSame: '#ff4444',
    ankiAllowDuplicatesOther: true, ankiAllowDuplicatesSame: false,
    fontSize: 26, fontFamily: "'Noto Serif JP', 'Yu Mincho', 'YuMincho', 'Hiragino Mincho ProN', 'BIZ UDPMincho', 'Meiryo', serif", furiganaMode: 'none',
    textOrientation: 'horizontal',
    jlModeFontSize: 42,
    jlModeFontFamily: "'Noto Serif JP', 'Yu Mincho', 'YuMincho', 'Hiragino Mincho ProN', 'BIZ UDPMincho', 'Meiryo', serif",
    jlModeOpacity: 72,
    jlModeTextColor: '#f4f4f4',
    jlModeBackgroundColor: '#050505',
    jlModeBorderColor: '#5f5f5f',
    jlModeAlwaysOnTop: true,
    jlModeShowControls: true,
    jlModePadding: 18,
    jlModeLookupOnClick: true,
    jlModeLookupTrigger: 'click',
    jlModeHoverDelay: 90,
    jlModeBacklogCapacity: 300,
    jlModeHideLookupOnNewText: true,
    jlModeAutoLookupFirstWord: false,
    epubFontSize: 26,
    epubFontFamily: "'Noto Serif JP', 'Yu Mincho', 'YuMincho', 'Hiragino Mincho ProN', 'BIZ UDPMincho', 'Meiryo', serif",
    epubTheme: 'app',
    epubReadingMode: 'paged',
    epubTextOrientation: 'horizontal',
    epubMaxWidth: 880,
    epubLineHeight: 2.05,
    epubParagraphSpacing: 22,
    epubPagePadding: 34,
    epubShowImages: true,
    epubImageMaxWidth: 720,
    playerRewindSeconds: 2,
    playerSubtitleStep: 0.1,
    playerMiningLeadIn: 0.15,
    playerMiningLeadOut: 0.25,
    playerMiningReplayOnMine: true,
    playerMiningPreferVideo: false,
    playerMiningUseClipForAnki: true,
    playerKeyPlayPause: 'Space',
    playerKeyBack: 'ArrowLeft',
    playerKeyForward: 'ArrowRight',
    playerKeyMine: 'm',
    playerKeyOffsetMinus: '[',
    playerKeyOffsetPlus: ']',
    discordEnabled: false,
    discordClientId: '1498569429045215302',
    discordShowTab: true,
    discordShowChars: true,
    discordShowWords: true,
    discordShowSentences: true,
    discordShowStats: true,
    discordShowProgress: true,
    discordShowPaused: true,
    discordShowTimer: true,
    discordShowButtons: false,
    discordTextActivityType: 'playing',
    discordTextStatus: 'reading',
    discordCustomTextStatus: '',
    discordLargeImage: 'setsuna',
    discordSmallImage: '',
    discordButtonLabel: 'Setsuna',
    discordButtonUrl: 'https://github.com/Lilislv/Setsuna',
    discordSecondButtonLabel: '',
    discordSecondButtonUrl: '',
    topbarShowClipboard: true,
    topbarShowWebSockets: true,
    topbarShowSync: true,
    topbarShowCapture: true,
    topbarShowJl: true,
    topbarShowSearch: true,
    topbarShowImport: true,
    topbarShowExport: true,
    topbarShowBrowser: true,
    updateAutoCheck: true,
    appLanguage: 'ru',
    autoScrollOffset: 80,
    theme: 'dark',
    replacements: [], removeWhitespace: false, requireJapanese: false, ignoreDuplicates: true,
    enableTextCleaner: true,
    searchEngine: 'https://duckduckgo.com/?q=',
    websocketAutoConnect: false,
    primaryWebSocketId: 'default',
    websockets: [{ id: 'default', name: 'TextHooker', url: 'ws://localhost:9002', active: true }]
};

export const themes = {
    dark: { '--bg-main': '#1a1a1a', '--bg-topbar': '#141414', '--bg-panel': '#252526', '--bg-side': '#202020', '--text-main': '#d1d1d1', '--text-muted': '#888888', '--border-main': '#3a3a3a', '--border-subtle': '#333333', '--hover-bg': 'rgba(255,255,255,0.05)', '--overlay-bg': 'rgba(0,0,0,0.8)', '--accent-blue': '#4fa6ff' },
    light: { '--bg-main': '#f5f5f5', '--bg-topbar': '#e0e0e0', '--bg-panel': '#ffffff', '--bg-side': '#e8ecef', '--text-main': '#222222', '--text-muted': '#666666', '--border-main': '#cccccc', '--border-subtle': '#bbbbbb', '--hover-bg': 'rgba(0,0,0,0.05)', '--overlay-bg': 'rgba(255,255,255,0.7)', '--accent-blue': '#0066cc' },
    amoled: { '--bg-main': '#000000', '--bg-topbar': '#000000', '--bg-panel': '#0a0a0a', '--bg-side': '#050505', '--text-main': '#e0e0e0', '--text-muted': '#777777', '--border-main': '#1a1a1a', '--border-subtle': '#111111', '--hover-bg': 'rgba(255,255,255,0.08)', '--overlay-bg': 'rgba(0,0,0,0.9)', '--accent-blue': '#4fa6ff' }
};
