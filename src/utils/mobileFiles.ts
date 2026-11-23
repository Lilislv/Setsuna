type MobileFileBridge = {
    selectDictionaries: () => string;
    selectEpub?: () => string;
    captureScreen?: () => string;
    cleanupDictionaries?: (paths: string) => string;
    cleanupEpub?: (path: string) => string;
};

declare global {
    interface Window { SetsunaMobileFiles?: MobileFileBridge }
}

export const cleanupMobileDictionaries = (paths: string[]) => {
    window.SetsunaMobileFiles?.cleanupDictionaries?.(JSON.stringify(paths));
};

export const openMobileDictionaryPicker = () => {
    const bridge = typeof window === 'undefined' ? null : window.SetsunaMobileFiles;
    if (!bridge) return false;
    const result = JSON.parse(bridge.selectDictionaries() || '{}');
    if (!result.ok) throw new Error(result.error || 'Unable to open the dictionary picker.');
    return true;
};

export const openMobileEpubPicker = () => {
    const bridge = typeof window === 'undefined' ? null : window.SetsunaMobileFiles;
    if (!bridge?.selectEpub) return false;
    const result = JSON.parse(bridge.selectEpub() || '{}');
    if (!result.ok) throw new Error(result.error || 'Unable to open the EPUB picker.');
    return true;
};

export const cleanupMobileEpub = (path: string) => {
    window.SetsunaMobileFiles?.cleanupEpub?.(path);
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
