type MobileFileBridge = {
    selectDictionaries: () => string;
    captureScreen?: () => string;
};

declare global {
    interface Window { SetsunaMobileFiles?: MobileFileBridge }
}

export const openMobileDictionaryPicker = () => {
    const bridge = typeof window === 'undefined' ? null : window.SetsunaMobileFiles;
    if (!bridge) return false;
    const result = JSON.parse(bridge.selectDictionaries() || '{}');
    if (!result.ok) throw new Error(result.error || 'Unable to open the dictionary picker.');
    return true;
};

export const hasMobileScreenCapture = () => Boolean(
    typeof window !== 'undefined' && window.SetsunaMobileFiles?.captureScreen,
);

export const captureMobileScreen = async () => {
    const bridge = typeof window === 'undefined' ? null : window.SetsunaMobileFiles;
    if (!bridge?.captureScreen) return null;
    const result = JSON.parse(bridge.captureScreen() || '{}');
    if (!result.ok) throw new Error(result.error || 'Unable to capture the Setsuna window.');
    return typeof result.value === 'string' && result.value ? result.value : null;
};
