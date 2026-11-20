/**
 * Overlay-style scrollbars: every scroll area keeps its scrollbar invisible
 * until it is scrolled (wheel, keys, touch) or the pointer comes close to its
 * right edge to grab it. While the thumb is being dragged it stays visible.
 * Styling lives in styles/design.css (`.is-scrolling`, `.is-near-scrollbar`).
 */
const HIDE_DELAY_MS = 900;
const EDGE_PX = 18;

let installed = false;

const isScrollable = (element: HTMLElement) => {
    if (element.scrollHeight <= element.clientHeight + 1 && element.scrollWidth <= element.clientWidth + 1) return false;
    const style = getComputedStyle(element);
    return /(auto|scroll|overlay)/.test(style.overflowY) || /(auto|scroll|overlay)/.test(style.overflowX);
};

export function installAutoHideScrollbars() {
    if (installed || typeof document === 'undefined') return;
    installed = true;

    const timers = new WeakMap<Element, number>();
    const flash = (element: Element) => {
        element.classList.add('is-scrolling');
        window.clearTimeout(timers.get(element));
        timers.set(element, window.setTimeout(() => element.classList.remove('is-scrolling'), HIDE_DELAY_MS));
    };

    document.addEventListener('scroll', (event) => {
        const target = event.target === document ? document.scrollingElement : event.target;
        if (target instanceof Element) flash(target);
    }, { capture: true, passive: true });

    let near: HTMLElement | null = null;
    let dragging: HTMLElement | null = null;
    let pointerX = 0;
    let pointerY = 0;
    let scheduled = false;

    const setNear = (element: HTMLElement | null) => {
        if (element === near) return;
        if (near && near !== dragging) near.classList.remove('is-near-scrollbar');
        element?.classList.add('is-near-scrollbar');
        near = element;
    };

    const check = () => {
        scheduled = false;
        let node = document.elementFromPoint(pointerX, pointerY) as HTMLElement | null;
        let found: HTMLElement | null = null;
        while (node && node !== document.documentElement) {
            if (node instanceof HTMLElement && isScrollable(node)) {
                const rect = node.getBoundingClientRect();
                const nearRight = pointerX >= rect.right - EDGE_PX && pointerX <= rect.right;
                const nearBottom = pointerY >= rect.bottom - EDGE_PX && pointerY <= rect.bottom && node.scrollWidth > node.clientWidth + 1;
                if (nearRight || nearBottom) found = node;
                break;
            }
            node = node.parentElement;
        }
        setNear(found);
    };

    document.addEventListener('pointermove', (event) => {
        pointerX = event.clientX;
        pointerY = event.clientY;
        if (!scheduled) {
            scheduled = true;
            requestAnimationFrame(check);
        }
    }, { passive: true });

    document.addEventListener('pointerdown', () => {
        if (near) dragging = near;
    }, { capture: true, passive: true });

    const endDrag = () => {
        const element = dragging;
        dragging = null;
        if (element && element !== near) element.classList.remove('is-near-scrollbar');
    };
    document.addEventListener('pointerup', endDrag, { capture: true, passive: true });
    window.addEventListener('blur', endDrag);
    document.addEventListener('pointerleave', () => { if (!dragging) setNear(null); });
}
