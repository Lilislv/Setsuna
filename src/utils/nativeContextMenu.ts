// The WebView's own right-click menu (Back, Reload, Save as, Print, Inspect)
// makes no sense in Setsuna. It stays available in text fields, where copy and
// paste are useful, and with Shift held, for debugging. Setsuna's own context
// menus are React handlers and are not affected.
const isEditable = (target: EventTarget | null) => {
    const element = target instanceof Element ? target : null;
    if (!element) return false;
    if (element.closest('input, textarea, select, [contenteditable="true"], [contenteditable=""]')) return true;
    return Boolean((element as HTMLElement).isContentEditable);
};

let installed = false;

export const disableNativeContextMenu = () => {
    if (installed || typeof document === 'undefined') return;
    installed = true;
    document.addEventListener('contextmenu', (event) => {
        if (event.shiftKey || isEditable(event.target)) return;
        event.preventDefault();
    });
};
