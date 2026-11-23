import type { EpubHighlight } from "./epubModel";

function escapeRegExp(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Safely wraps plain-text occurrences of saved highlights inside sanitized
 * paragraph HTML with `<mark class="epub-hl epub-hl-{color}">`.
 * Splits on HTML tags (`<...>`) so attributes and markup are never altered.
 */
export function applyParagraphHighlights(
    html: string,
    highlights: readonly EpubHighlight[],
): string {
    if (!html || highlights.length === 0) return html;

    let result = html;
    for (const hl of highlights) {
        const needle = hl.text.trim();
        if (needle.length < 1) continue;
        const regex = new RegExp(escapeRegExp(needle));
        const segments = result.split(/(<[^>]+>)/g);
        let replaced = false;
        let insideMark = 0;

        for (let i = 0; i < segments.length; i++) {
            const seg = segments[i];
            if (seg.startsWith("<")) {
                if (/^<mark\b/i.test(seg)) insideMark += 1;
                else if (/^<\/mark>/i.test(seg)) insideMark = Math.max(0, insideMark - 1);
                continue;
            }
            if (insideMark > 0 || replaced || !seg) continue;
            if (regex.test(seg)) {
                segments[i] = seg.replace(
                    regex,
                    (match) => `<mark class="epub-hl epub-hl-${hl.color}" data-hl-id="${hl.id}">${match}</mark>`,
                );
                replaced = true;
            }
        }
        if (replaced) {
            result = segments.join("");
        }
    }
    return result;
}
