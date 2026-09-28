// Window dimensions describe available space, not the platform. A narrow desktop
// WebView must keep mouse lookup and the desktop controls.
export const isMobilePlatform = (): boolean => {
    if (typeof navigator === 'undefined') return false;
    return /Android|iPhone|iPad|iPod/i.test(navigator.userAgent)
        || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
};
