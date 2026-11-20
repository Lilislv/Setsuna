/**
 * Many Japanese fonts (MS Gothic, Meiryo, some HG fonts, ...) ship full-width
 * Cyrillic glyphs, so Russian text set in them looks letter-spaced:
 * "п е р е е з ж а т ь". For such fonts we put a small face in front of the
 * stack that covers only the Cyrillic block (unicode-range) with the system UI
 * font; kana, kanji and Latin still come from the chosen font.
 */
export const CYRILLIC_FACE = 'Setsuna Cyrillic';

const CYRILLIC_RANGE = 'U+0400-052F, U+1C80-1C8F, U+2DE0-2DFF, U+A640-A69F';
const FACE_CSS = `
@font-face {
    font-family: "${CYRILLIC_FACE}";
    font-weight: 100 549;
    src: local("Segoe UI"), local("SegoeUI"), local("Roboto"), local("Roboto-Regular"), local("Noto Sans"), local("Arial"), local("ArialMT");
    unicode-range: ${CYRILLIC_RANGE};
}
@font-face {
    font-family: "${CYRILLIC_FACE}";
    font-weight: 550 1000;
    src: local("Segoe UI Bold"), local("SegoeUI-Bold"), local("Roboto Bold"), local("Roboto-Bold"), local("Noto Sans Bold"), local("Arial Bold"), local("Arial-BoldMT");
    unicode-range: ${CYRILLIC_RANGE};
}`;

let faceInstalled = false;
function ensureCyrillicFace() {
    if (faceInstalled || typeof document === 'undefined') return;
    faceInstalled = true;
    const style = document.createElement('style');
    style.id = 'setsuna-cyrillic-face';
    style.textContent = FACE_CSS;
    document.head.appendChild(style);
}

const fullWidthCache = new Map<string, boolean>();
let measureContext: CanvasRenderingContext2D | null | undefined;

/** True when the first available font of `stack` draws Cyrillic at about 1em per letter. */
export function hasFullWidthCyrillic(stack: string): boolean {
    const cached = fullWidthCache.get(stack);
    if (cached !== undefined) return cached;
    if (measureContext === undefined) {
        measureContext = typeof document === 'undefined'
            ? null
            : document.createElement('canvas').getContext('2d');
    }
    let result = false;
    if (measureContext) {
        // A narrow and a wide letter: proportional fonts differ a lot, full-width
        // fonts draw both at ~1em.
        measureContext.font = `100px ${stack}`;
        const narrow = measureContext.measureText('г').width;
        const wide = measureContext.measureText('ш').width;
        result = narrow > 85 && Math.abs(wide - narrow) < 6;
    }
    fullWidthCache.set(stack, result);
    return result;
}

/** Returns `stack` with the Cyrillic face in front when the font needs it. */
export function withReadableCyrillic(stack: string): string {
    if (!stack || stack.includes(CYRILLIC_FACE) || !hasFullWidthCyrillic(stack)) return stack;
    ensureCyrillicFace();
    return `"${CYRILLIC_FACE}", ${stack}`;
}
