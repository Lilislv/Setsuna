import { invoke } from '@tauri-apps/api/core';

type FontSettings = {
    customFontData?: string;
    customFontFamily?: string;
    customFontPath?: string;
};

const STYLE_ID = 'setsuna-custom-font';
let loadSerial = 0;

const dataUrlFromBytes = (bytes: number[], path: string) => {
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    const extension = (path.split('.').pop() || 'ttf').toLowerCase();
    const mime = extension === 'woff2' ? 'font/woff2' : extension === 'woff' ? 'font/woff' : extension === 'otf' ? 'font/otf' : 'font/ttf';
    return `data:${mime};base64,${btoa(binary)}`;
};

/** Installs the selected font in every Tauri WebView that renders text. */
export const applyCustomFont = (settings: FontSettings | null | undefined) => {
    const existing = document.getElementById(STYLE_ID);
    if (!settings?.customFontData || !settings.customFontFamily) {
        existing?.remove();
        return;
    }

    const formatToken = settings.customFontData.match(/^data:font\/([^;,]+)/i)?.[1]?.toLowerCase() || 'ttf';
    const format = formatToken === 'ttf' ? 'truetype' : formatToken === 'otf' ? 'opentype' : formatToken;
    const style = existing || document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `@font-face { font-family: "${settings.customFontFamily.replace(/"/g, '')}"; src: url("${settings.customFontData}") format("${format}"); font-display: swap; }`;
    if (!existing) document.head.appendChild(style);
};

/** Applies embedded data immediately, or restores a selected file from disk. */
export const loadCustomFont = async (settings: FontSettings | null | undefined) => {
    const serial = ++loadSerial;
    if (settings?.customFontData) {
        applyCustomFont(settings);
        return;
    }
    if (!settings?.customFontPath || !settings.customFontFamily) {
        applyCustomFont(settings);
        return;
    }
    try {
        const bytes = await invoke<number[]>('read_file_bytes', { path: settings.customFontPath });
        if (serial !== loadSerial) return;
        applyCustomFont({ ...settings, customFontData: dataUrlFromBytes(bytes, settings.customFontPath) });
    } catch {
        if (serial === loadSerial) applyCustomFont(null);
    }
};
