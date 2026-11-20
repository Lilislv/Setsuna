/**
 * Fonts draw Japanese glyphs at different sizes inside the same em box, so
 * 28px in one font can look noticeably smaller than 28px in another. This
 * measures the real ink size of a few kana/kanji in the chosen font and in a
 * reference font, and returns the scale that makes them look the same size.
 */
const SAMPLE = 'あいうえおかさなはまらわんアイウ漢字語';
const PROBE_PX = 100;
const cache = new Map<string, number>();
let canvas: HTMLCanvasElement | null = null;

/** Average visual size of the sample glyphs: geometric mean of ink width × height. */
const inkSize = (family: string) => {
    canvas = canvas || document.createElement('canvas');
    const context = canvas.getContext('2d');
    if (!context) return 0;
    context.font = `${PROBE_PX}px ${family}`;
    let total = 0;
    let count = 0;
    for (const glyph of SAMPLE) {
        const metrics = context.measureText(glyph);
        const height = (metrics.actualBoundingBoxAscent || 0) + (metrics.actualBoundingBoxDescent || 0);
        const width = (metrics.actualBoundingBoxLeft || 0) + (metrics.actualBoundingBoxRight || 0);
        if (height > 0 && width > 0) {
            total += Math.sqrt(height * width);
            count += 1;
        }
    }
    return count ? total / count : 0;
};

const ensureLoaded = async (family: string) => {
    try { await document.fonts.load(`${PROBE_PX}px ${family}`, SAMPLE); } catch {}
};

/** The already measured factor for this pair, if any (no font loading). */
export function cachedGlyphScale(family: string, referenceFamily: string): number | undefined {
    return cache.get(`${family}|${referenceFamily}`);
}

export async function glyphScaleFor(family: string, referenceFamily: string): Promise<number> {
    const key = `${family}|${referenceFamily}`;
    const cached = cache.get(key);
    if (cached !== undefined) return cached;
    await Promise.all([ensureLoaded(family), ensureLoaded(referenceFamily)]);
    const target = inkSize(family);
    const reference = inkSize(referenceFamily);
    let scale = target > 0 && reference > 0 ? reference / target : 1;
    scale = Math.min(1.35, Math.max(0.85, scale));
    if (Math.abs(scale - 1) < 0.05) scale = 1;
    cache.set(key, scale);
    return scale;
}
