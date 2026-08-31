type MobileFileBridge = { selectDictionaries: () => string };

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
