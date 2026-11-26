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
    isVertical?: boolean;
}

export type PdfFitMode = "fit-width" | "fit-page" | "custom";
export type PdfColorTheme = "original" | "sepia" | "dark" | "eink";
export type PdfLayoutMode = "paged" | "spread" | "scroll";

function isCjkChar(code: number): boolean {
    return (
        (code >= 0x3000 && code <= 0x30ff)
        || (code >= 0x3400 && code <= 0x4dbf)
        || (code >= 0x4e00 && code <= 0x9fff)
        || (code >= 0xf900 && code <= 0xfaff)
        || (code >= 0xff00 && code <= 0xffef)
    );
}

function hasCjkText(str: string): boolean {
    for (const ch of str) {
        if (isCjkChar(ch.codePointAt(0) ?? 0)) return true;
    }
    return false;
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

export function clampPdfPage(page: number, numPages: number): number {
    if (!Number.isFinite(numPages) || numPages <= 0) return 1;
    if (!Number.isFinite(page)) return 1;
    return Math.min(Math.floor(numPages), Math.max(1, Math.floor(page)));
}

export function computePdfFitScale(
    pageWidth: number,
    pageHeight: number,
    availWidth: number,
    availHeight: number,
    fitMode: PdfFitMode,
    customScale: number,
    rotationDeg = 0,
): number {
    const safeCustom = Math.min(3.0, Math.max(0.4, Number.isFinite(customScale) ? customScale : 1));
    if (fitMode === "custom") return safeCustom;

    const normRot = ((rotationDeg % 360) + 360) % 360;
    const swapped = normRot === 90 || normRot === 270;
    const effW = Math.max(1, swapped ? pageHeight : pageWidth);
    const effH = Math.max(1, swapped ? pageWidth : pageHeight);
    const wScale = Math.max(200, availWidth) / effW;
    if (fitMode === "fit-width") {
        return Math.min(2.6, Math.max(0.4, wScale));
    }
    const hScale = Math.max(200, availHeight) / effH;
    return Math.min(2.6, Math.max(0.4, Math.min(wScale, hScale)));
}

export function computePinchScale(
    startDist: number,
    currentDist: number,
    startScale: number,
): number {
    if (!Number.isFinite(startDist) || startDist <= 4 || !Number.isFinite(currentDist)) {
        return startScale;
    }
    const ratio = currentDist / startDist;
    return Math.min(3.0, Math.max(0.5, Math.round(startScale * ratio * 100) / 100));
}

interface RawBox {
    str: string;
    left: number;
    top: number;
    width: number;
    height: number;
    baselineY: number;
    centerX: number;
    rotatedVertical: boolean;
}

function detectVerticalJapaneseLayout(boxes: readonly RawBox[]): boolean {
    if (boxes.length < 4) return false;
    let cjkCount = 0;
    let shortCjkItems = 0;
    let rotatedVerticalCount = 0;
    let verticalStepPairs = 0;
    let horizontalStepPairs = 0;

    for (let i = 0; i < boxes.length; i++) {
        const b = boxes[i];
        const trimmed = b.str.trim();
        if (!trimmed) continue;
        if (b.rotatedVertical) rotatedVerticalCount++;
        if (hasCjkText(trimmed)) {
            cjkCount++;
            if (Array.from(trimmed).length <= 2) {
                shortCjkItems++;
            }
        }
        if (i > 0) {
            const prev = boxes[i - 1];
            const dx = Math.abs(b.centerX - prev.centerX);
            const dy = Math.abs(b.baselineY - prev.baselineY);
            const tol = Math.max(5, Math.min(b.height, prev.height) * 0.6);
            if (dx <= tol && dy > tol * 0.4 && dy < b.height * 3.5) {
                verticalStepPairs++;
            } else if (dy <= tol && dx > tol * 0.4) {
                horizontalStepPairs++;
            }
        }
    }

    if (cjkCount < Math.max(3, Math.floor(boxes.length * 0.35))) return false;
    if (rotatedVerticalCount >= Math.max(3, Math.floor(cjkCount * 0.4))) return true;
    return shortCjkItems >= Math.max(4, Math.floor(cjkCount * 0.5))
        && verticalStepPairs > horizontalStepPairs * 1.4;
}

/**
 * Groups PDF.js text items into reading-order lines with viewport-space bounding boxes
 * and exact character offsets so clicking any span maps cleanly into Setsuna's dictionary lookup.
 * Automatically detects vertical-rl Japanese columns and orders them right-to-left, top-to-bottom.
 */
export function groupPdfTextItemsIntoLines(
    items: readonly PdfTextItemLike[],
    viewportTransform: readonly number[],
): PdfTextLine[] {
    const boxes: RawBox[] = [];
    const [va, vb, vc, vd, ve, vf] = viewportTransform;

    for (const item of items) {
        if (!item.str) continue;
        const t = item.transform;
        if (!t || t.length < 6) continue;
        const tx = va * t[4] + vc * t[5] + ve;
        const ty = vb * t[4] + vd * t[5] + vf;
        const m00 = va * t[0] + vc * t[1];
        const m01 = vb * t[0] + vd * t[1];
        const m10 = va * t[2] + vc * t[3];
        const m11 = vb * t[2] + vd * t[3];
        const scaleX = Math.hypot(m00, m01);
        const scaleY = Math.hypot(m10, m11);
        const fontHeight = Math.max(6, scaleY || scaleX || Math.abs(item.height) || 12);
        const vpScale = Math.hypot(va, vb) || 1;
        const rotatedVertical = Math.abs(m01) > Math.abs(m00) * 1.5;
        const rawSpanWidth = Math.max(2, Math.abs(item.width) * vpScale);
        const boxWidth = rotatedVertical ? fontHeight : rawSpanWidth;
        const boxHeight = rotatedVertical ? Math.max(fontHeight, rawSpanWidth) : fontHeight * 1.1;
        const top = rotatedVertical ? ty : ty - fontHeight * 0.85;

        boxes.push({
            str: item.str,
            left: tx,
            top,
            width: boxWidth,
            height: boxHeight,
            baselineY: ty,
            centerX: tx + boxWidth * 0.5,
            rotatedVertical,
        });
    }

    if (boxes.length === 0) return [];

    if (detectVerticalJapaneseLayout(boxes)) {
        // Vertical Japanese PDF: group by X column (right-to-left), sort top-to-bottom within each column
        const sorted = [...boxes].sort((a, b) => {
            const xDiff = b.centerX - a.centerX;
            const tol = Math.max(6, Math.min(a.width, b.width) * 0.65);
            if (Math.abs(xDiff) > tol) return xDiff;
            return a.top - b.top;
        });

        const columns: RawBox[][] = [];
        for (const box of sorted) {
            const current = columns[columns.length - 1];
            if (!current) {
                columns.push([box]);
                continue;
            }
            const ref = current[0];
            const tol = Math.max(6, Math.min(ref.width, box.width) * 0.7);
            if (Math.abs(box.centerX - ref.centerX) <= tol) {
                current.push(box);
            } else {
                columns.push([box]);
            }
        }

        const lines: PdfTextLine[] = [];
        for (const col of columns) {
            col.sort((a, b) => a.top - b.top);
            let text = "";
            const spans: PdfPositionedSpan[] = [];
            for (const box of col) {
                const clean = box.str;
                if (!clean) continue;
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
            }
            if (text.trim().length > 0) {
                lines.push({ text, spans, isVertical: true });
            }
        }
        return lines;
    }

    // Horizontal layout: sort top-to-bottom, then left-to-right
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
            lines.push({ text, spans, isVertical: false });
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
