/** Character-anchored scanning, following Yomitan's TextSourceRange.hasSameStart
 * and TextSourceGenerator's forward/backward caret hit test. */
export type HoverTextPoint = { container: Element; node: Text; offset: number; text: string; rect: DOMRect };
const excluded = 'rt, rp, button, input, textarea, select, [contenteditable="true"]';
export function scanTextNodes(container: Element): Text[] {
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
        acceptNode: node => node.parentElement?.closest(excluded) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
    });
    const nodes: Text[] = [];
    for (let node = walker.nextNode(); node; node = walker.nextNode()) nodes.push(node as Text);
    return nodes;
}
function characterStart(text: string, offset: number) {
    if (offset > 0 && offset < text.length && /[\uDC00-\uDFFF]/.test(text[offset]) && /[\uD800-\uDBFF]/.test(text[offset - 1])) return offset - 1;
    return offset;
}
export function findHoverTextPoint(x: number, y: number): HoverTextPoint | null {
    const element = document.elementFromPoint(x, y);
    if (!element || element.closest(excluded)) return null;
    const container = element.closest('.text-line, .dict-meaning, .dict-header');
    if (!container) return null;
    const hit = (node: Text, position: number): HoverTextPoint | null => {
        if (!container.contains(node) || node.parentElement?.closest(excluded)) return null;
        const text = node.data; const offset = characterStart(text, position);
        const code = text.codePointAt(offset);
        if (code === undefined || /\s/.test(String.fromCodePoint(code))) return null;
        const range = document.createRange();
        range.setStart(node, offset); range.setEnd(node, offset + (code > 0xffff ? 2 : 1));
        for (const rect of range.getClientRects()) {
            if (rect.width > 0 && rect.height > 0 && x >= rect.left && x < rect.right && y >= rect.top && y < rect.bottom) {
                return { container, node, offset, text, rect };
            }
        }
        return null;
    };
    const position = (document as any).caretPositionFromPoint?.(x, y);
    const range = position ? null : document.caretRangeFromPoint?.(x, y);
    const node = position?.offsetNode || range?.startContainer;
    const offset = position?.offset ?? range?.startOffset ?? 0;
    if (node?.nodeType === Node.TEXT_NODE) {
        const result = hit(node, offset) || (offset > 0 ? hit(node, offset - 1) : null);
        if (result) return result;
    }
    // Some vertical/ruby layouts have no useful caret. Only examine text nodes
    // intersecting the pointer, and require an actual character hit (no 24px snap).
    for (const candidate of scanTextNodes(container)) {
        const range = document.createRange(); range.selectNodeContents(candidate);
        if (![...range.getClientRects()].some(r => x >= r.left && x < r.right && y >= r.top && y < r.bottom)) continue;
        for (let i = 0; i < candidate.length; i += (candidate.data.codePointAt(i)! > 0xffff ? 2 : 1)) {
            const result = hit(candidate, i); if (result) return result;
        }
    }
    return null;
}
export function sameHoverTextPoint(a: HoverTextPoint, b: HoverTextPoint): boolean {
    return a.container === b.container && a.node === b.node && a.offset === b.offset && a.text === b.text;
}

/** One active lookup and one newest pending character; obsolete replies never publish. */
export function createHoverScanQueue<T>(same: (a: T, b: T) => boolean, search: (target: T, isCurrent: () => boolean) => Promise<void>) {
    let version = 0; let last: T | null = null; let pending: { target: T; version: number } | null = null;
    let running = false; let disposed = false;
    const drain = async () => {
        if (running) return;
        running = true;
        try {
            while (pending && !disposed) {
                const next = pending; pending = null;
                try { await search(next.target, () => !disposed && version === next.version); }
                catch (error) { console.warn('Hover scan failed', error); }
            }
        } finally { running = false; }
    };
    return {
        request(target: T | null) {
            if (disposed || (target !== null && last !== null && same(last, target))) return;
            last = target; version++;
            pending = target === null ? null : { target, version };
            void drain();
        },
        dispose() { disposed = true; version++; last = null; pending = null; },
    };
}

export function selectScanRange(nodes: Text[], start: number, length: number) {
    const selection = window.getSelection(); if (!selection) return;
    selection.removeAllRanges(); if (length <= 0) return;
    const range = document.createRange(); let offset = 0; let started = false;
    for (const node of nodes) {
        if (!started && start < offset + node.length) { range.setStart(node, start - offset); started = true; }
        if (started && start + length <= offset + node.length) {
            range.setEnd(node, start + length - offset); selection.addRange(range); return;
        }
        offset += node.length;
    }
}
