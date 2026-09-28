type TextOverlayBridge = {
    status: () => string;
    requestPermission: () => string;
    show: (text: string, optionsJson: string) => string;
    hide: () => string;
    enable?: () => string;
    timerSnapshot?: () => string;
};

declare global {
    interface Window {
        SetsunaTextOverlay?: TextOverlayBridge;
    }
}

const bridge = () => typeof window === 'undefined' ? null : window.SetsunaTextOverlay || null;

export const getMobileFlowTimer = (): { paused: boolean; elapsedSeconds: number } | null => {
    const nativeBridge = bridge();
    if (!nativeBridge?.timerSnapshot) return null;
    return JSON.parse(nativeBridge.timerSnapshot());
};

const parse = <T>(raw: string): T => {
    const value = JSON.parse(raw || '{}');
    if (!value.ok) throw new Error(value.error || 'Setsuna overlay error');
    return value.value as T;
};

export const getMobileOverlayStatus = () => {
    const nativeBridge = bridge();
    return nativeBridge ? parse<{ granted: boolean; dismissed?: boolean }>(nativeBridge.status()) : { granted: false };
};

export const enableMobileOverlay = () => {
    const nativeBridge = bridge();
    if (nativeBridge?.enable) parse(nativeBridge.enable());
};

export const requestMobileOverlayPermission = () => {
    const nativeBridge = bridge();
    if (!nativeBridge) throw new Error('The overlay is available only in the Android Setsuna app.');
    return parse<{ opened: boolean; granted: boolean }>(nativeBridge.requestPermission());
};

export const showMobileOverlay = (text: string, options: Record<string, unknown>) => {
    const nativeBridge = bridge();
    if (!nativeBridge) throw new Error('The overlay is available only in the Android Setsuna app.');
    return parse<{ shown: boolean; dismissed?: boolean }>(nativeBridge.show(text, JSON.stringify(options)));
};

export const hideMobileOverlay = () => {
    const nativeBridge = bridge();
    if (!nativeBridge) return { hidden: true };
    return parse<{ hidden: boolean }>(nativeBridge.hide());
};
