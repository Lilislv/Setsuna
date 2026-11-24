export interface PdfTextItemLike {
    str: string;
    transform: readonly number[];
    width: number;
    height: number;
    hasEOL?: boolean;
}

export interface PdfPositionedSpan {
    str: string;
    startOffset: number;
    endOffset: number;
    /** Viewport-space left (px) */
    left: number;
    /** Viewport-space top (px) */
    top: number;
    /** Viewport-space width (px) */
    width: number;
    /** Viewport-space height / font size (px) */
    height: number;
}

export interface PdfTextLine {
    text: string;
    spans: PdfPositionedSpan[];
}

function isCjkChar(code: number): boolean {
    return (
        (code >= 0x3000 && code <= 0x30ff)
        || (code >= 0x3400 && code <= 0x4dbf)
        || (code >= 0x4e00 && code <= 0x9fff)
        || (code >= 0xf900 && code <= 0xfaff)
        || (code >= 0xff00 && code <= 0xffef)
    );
}

function needsSpaceBetween(prevStr: string, nextStr: string, gapPx: number, fontSize: number): boolean {
    if (!prevStr || !nextStr) return false;
    if (/\s$/.test(prevStr) || /^\s/.test(nextStr)) return false;
    const lastCode = prevStr.codePointAt(prevStr.length - 1) ?? 0;
    const firstCode = nextStr.codePointAt(0) ?? 0;
    if (isCjkChar(lastCode) && isCjkChar(firstCode)) {
        // Avoid spurious spaces between Japanese characters unless gap is huge (e.g. columns)
        return gapPx > fontSize * 1.4;
    }
    return gapPx > Math.max(2, fontSize * 0.22);
}

/**
 * Groups PDF.js text items into reading-order lines with viewport-space bounding boxes
 * and exact character offsets so clicking any span maps cleanly into Setsuna's dictionary lookup.
 */
export function groupPdfTextItemsIntoLines(
    items: readonly PdfTextItemLike[],
    viewportTransform: readonly number[],
): PdfTextLine[] {
    interface RawBox {
        str: string;
        left: number;
        top: number;
        width: number;
        height: number;
        baselineY: number;
    }

    const boxes: RawBox[] = [];
    const [va, vb, vc, vd, ve, vf] = viewportTransform;

    for (const item of items) {
        if (!item.str) continue;
        const t = item.transform;
        if (!t || t.length < 6) continue;
        // Multiply viewportTransform * item.transform
        const tx = va * t[4] + vc * t[5] + ve;
        const ty = vb * t[4] + vd * t[5] + vf;
        const scaleX = Math.hypot(va * t[0] + vc * t[1], vb * t[0] + vd * t[1]);
        const scaleY = Math.hypot(va * t[2] + vc * t[3], vb * t[2] + vd * t[3]);
        const fontHeight = Math.max(6, scaleY || scaleX || Math.abs(item.height) || 12);
        const vpScale = Math.hypot(va, vb) || 1;
        const boxWidth = Math.max(2, Math.abs(item.width) * vpScale);
        boxes.push({
            str: item.str,
            left: tx,
            top: ty - fontHeight * 0.85,
            width: boxWidth,
            height: fontHeight * 1.1,
            baselineY: ty,
        });
    }

    if (boxes.length === 0) return [];

    // Sort top-to-bottom, then left-to-right
    boxes.sort((a, b) => {
        const yDiff = a.baselineY - b.baselineY;
        const tol = Math.max(4, Math.min(a.height, b.height) * 0.45);
        if (Math.abs(yDiff) > tol) return yDiff;
        return a.left - b.left;
    });

    const grouped: RawBox[][] = [];
    for (const box of boxes) {
        const current = grouped[grouped.length - 1];
        if (!current) {
            grouped.push([box]);
            continue;
        }
        const ref = current[0];
        const tol = Math.max(4, Math.min(ref.height, box.height) * 0.48);
        if (Math.abs(box.baselineY - ref.baselineY) <= tol) {
            current.push(box);
        } else {
            grouped.push([box]);
        }
    }

    const lines: PdfTextLine[] = [];
    for (const row of grouped) {
        row.sort((a, b) => a.left - b.left);
        let text = "";
        const spans: PdfPositionedSpan[] = [];
        let prevBox: RawBox | null = null;

        for (const box of row) {
            const clean = box.str;
            if (!clean) continue;
            if (prevBox) {
                const gap = box.left - (prevBox.left + prevBox.width);
                if (needsSpaceBetween(prevBox.str, clean, gap, box.height)) {
                    text += " ";
                }
            }
            const startOffset = text.length;
            text += clean;
            const endOffset = text.length;
            spans.push({
                str: clean,
                startOffset,
                endOffset,
                left: box.left,
                top: box.top,
                width: box.width,
                height: box.height,
            });
            prevBox = box;
        }

        if (text.trim().length > 0) {
            lines.push({ text, spans });
        }
    }

    return lines;
}

/**
 * Estimates character index within a span given click ratio `0..1` and extracts
 * the lookup token + surrounding sentence for Setsuna's dictionary engine.
 */
export function buildPdfLookupTarget(
    lineText: string,
    span: Pick<PdfPositionedSpan, "str" | "startOffset" | "endOffset">,
    clickRatio: number,
): { token: string; sentence: string; cursor: number } | null {
    if (!lineText.trim() || !span.str) return null;
    const clampedRatio = Math.min(0.999, Math.max(0, Number.isFinite(clickRatio) ? clickRatio : 0));
    const localChars = Array.from(span.str);
    if (localChars.length === 0) return null;
    const localCharIdx = Math.min(localChars.length - 1, Math.floor(clampedRatio * localChars.length));
    let utf16LocalOffset = 0;
    for (let i = 0; i < localCharIdx; i++) {
        utf16LocalOffset += localChars[i].length;
    }
    const cursor = Math.min(lineText.length - 1, Math.max(0, span.startOffset + utf16LocalOffset));

    // For ASCII/Latin text, snap token to full word boundaries around cursor
    const ch = lineText[cursor] || "";
    if (/[A-Za-z0-9'-]/.test(ch)) {
        let s = cursor;
        while (s > 0 && /[A-Za-z0-9'-]/.test(lineText[s - 1])) s--;
        let e = cursor + 1;
        while (e < lineText.length && /[A-Za-z0-9'-]/.test(lineText[e])) e++;
        const word = lineText.slice(s, e).trim();
        if (word) {
            return { token: word, sentence: lineText, cursor: s };
        }
    }

    const token = lineText.slice(cursor, cursor + 24).trim() || span.str.trim();
    if (!token) return null;
    return { token, sentence: lineText, cursor };
}

export function buildPdfSearchSnippet(text: string, queryLower: string): string | null {
    const lower = text.toLowerCase();
    const pos = lower.indexOf(queryLower);
    if (pos === -1) return null;
    const start = Math.max(0, pos - 36);
    const end = Math.min(text.length, pos + queryLower.length + 64);
    return `${start > 0 ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`;
}
