type TextOverlayBridge = {
    status: () => string;
    requestPermission: () => string;
    show: (text: string, optionsJson: string) => string;
    hide: () => string;
};

declare global {
    interface Window {
        SetsunaTextOverlay?: TextOverlayBridge;
    }
}

const bridge = () => typeof window === 'undefined' ? null : window.SetsunaTextOverlay || null;

const parse = <T>(raw: string): T => {
    const value = JSON.parse(raw || '{}');
    if (!value.ok) throw new Error(value.error || 'Setsuna overlay error');
    return value.value as T;
};

export const getMobileOverlayStatus = () => {
    const nativeBridge = bridge();
    return nativeBridge ? parse<{ granted: boolean }>(nativeBridge.status()) : { granted: false };
};

export const requestMobileOverlayPermission = () => {
    const nativeBridge = bridge();
    if (!nativeBridge) throw new Error('The overlay is available only in the Android Setsuna app.');
    return parse<{ opened: boolean; granted: boolean }>(nativeBridge.requestPermission());
};

export const showMobileOverlay = (text: string, options: Record<string, unknown>) => {
    const nativeBridge = bridge();
    if (!nativeBridge) throw new Error('The overlay is available only in the Android Setsuna app.');
    return parse<{ shown: boolean }>(nativeBridge.show(text, JSON.stringify(options)));
};

export const hideMobileOverlay = () => {
    const nativeBridge = bridge();
    if (!nativeBridge) return { hidden: true };
    return parse<{ hidden: boolean }>(nativeBridge.hide());
};
