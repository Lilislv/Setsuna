type TextCaptureBridge = {
    status: () => string;
    start: (url: string) => string;
    stop: () => string;
};

export type MobileTextCaptureStatus = {
    running: boolean;
    connected: boolean;
    url: string;
    error: string;
};

declare global {
    interface Window {
        SetsunaTextCapture?: TextCaptureBridge;
    }
}

const bridge = () => typeof window === 'undefined' ? null : window.SetsunaTextCapture || null;

const parse = <T>(raw: string): T => {
    const value = JSON.parse(raw || '{}');
    if (!value.ok) throw new Error(value.error || 'Setsuna text source error');
    return value.value as T;
};

export const hasMobileTextCapture = () => Boolean(bridge());

export const getMobileTextCaptureStatus = (): MobileTextCaptureStatus => {
    const nativeBridge = bridge();
    if (!nativeBridge) return { running: false, connected: false, url: '', error: '' };
    return parse<MobileTextCaptureStatus>(nativeBridge.status());
};

export const startMobileTextCapture = (url: string) => {
    const nativeBridge = bridge();
    if (!nativeBridge) throw new Error('The background text source is available only in the Android Setsuna app.');
    return parse<{ started: boolean }>(nativeBridge.start(url));
};

export const stopMobileTextCapture = () => {
    const nativeBridge = bridge();
    if (!nativeBridge) return { stopped: true };
    return parse<{ stopped: boolean }>(nativeBridge.stop());
};
