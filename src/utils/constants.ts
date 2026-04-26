import { AppSettings } from "../components/SettingsModal";

export interface TabStats { chars: number; words: number; sentences: number; time: number; }
export interface Tab { id: number; name: string; lines: string[]; stats: TabStats; }
export interface BrowserTab {
    id: string;
    url: string;
    title: string;
    favicon?: string;
}

export const defaultStats: TabStats = { chars: 0, words: 0, sentences: 0, time: 0 };
export const EMPTY_LINES: string[] = [];

export const DEFAULT_SETTINGS: AppSettings = {
    useClipboard: true,
    panelPosition: 'bottom', speedMetric: 'chars', speedTimeframe: 'minute',
    allowManualPaste: true, allowManualPasteDuringPause: true,
    lookupHotkey: 'Shift',
    lookupScale: 1.0, 
    lookupFontSize: 14, 
    lookupTagFontSize: 11, 
    lookupWidth: 380,
    lookupShowTags: true,
    lookupShowAudio: true,
    hookProcesses: [], 
    ankiDeck: '', ankiModel: '', 
    ankiFieldWord: '', ankiFieldReading: '', ankiFieldMeaning: '', ankiFieldSentence: '', ankiFieldDict: '',
    ankiFieldAudio: '', ankiFieldPitch: '', ankiFieldFreq: '', ankiFieldScreenshot: '',
    ankiShowButtonNormal: true, ankiShowButtonScreenshot: true,
    dictionaries: [], autoPlayAudio: true, helperUrl: "https://chatgpt.com/", syncPin: '',
    ankiColorNew: '#4CAF50', ankiColorOther: '#4fa6ff', ankiColorSame: '#ff4444',
    ankiAllowDuplicatesOther: true, ankiAllowDuplicatesSame: false,
    fontSize: 26, fontFamily: "'Noto Serif JP', 'Yu Gothic', sans-serif", furiganaMode: 'none',
    appLanguage: 'ru',
    autoScrollOffset: 80,
    theme: 'dark',
    replacements: [], removeWhitespace: false, requireJapanese: false, ignoreDuplicates: true,
    enableTextCleaner: true,
    searchEngine: 'https://duckduckgo.com/?q=',
    websockets: [{ id: 'default', name: 'TextHooker', url: 'ws://localhost:9002', active: true }]
};

export const themes = {
    dark: { '--bg-main': '#1a1a1a', '--bg-topbar': '#141414', '--bg-panel': '#252526', '--bg-side': '#202020', '--text-main': '#d1d1d1', '--text-muted': '#888888', '--border-main': '#3a3a3a', '--border-subtle': '#333333', '--hover-bg': 'rgba(255,255,255,0.05)', '--overlay-bg': 'rgba(0,0,0,0.8)', '--accent-blue': '#4fa6ff' },
    light: { '--bg-main': '#f5f5f5', '--bg-topbar': '#e0e0e0', '--bg-panel': '#ffffff', '--bg-side': '#e8ecef', '--text-main': '#222222', '--text-muted': '#666666', '--border-main': '#cccccc', '--border-subtle': '#bbbbbb', '--hover-bg': 'rgba(0,0,0,0.05)', '--overlay-bg': 'rgba(255,255,255,0.7)', '--accent-blue': '#0066cc' },
    amoled: { '--bg-main': '#000000', '--bg-topbar': '#000000', '--bg-panel': '#0a0a0a', '--bg-side': '#050505', '--text-main': '#e0e0e0', '--text-muted': '#777777', '--border-main': '#1a1a1a', '--border-subtle': '#111111', '--hover-bg': 'rgba(255,255,255,0.08)', '--overlay-bg': 'rgba(0,0,0,0.9)', '--accent-blue': '#4fa6ff' }
};