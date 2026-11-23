export interface SubtitleCue {
    index: number;
    startSec: number;
    endSec: number;
    text: string;
}

function parseTimestamp(raw: string): number | null {
    const clean = raw.trim().replace(",", ".");
    const parts = clean.split(":");
    if (parts.length < 2 || parts.length > 3) return null;
    const nums = parts.map((p) => Number(p));
    if (nums.some((n) => !Number.isFinite(n) || n < 0)) return null;
    if (nums.length === 3) {
        return nums[0] * 3600 + nums[1] * 60 + nums[2];
    }
    return nums[0] * 60 + nums[1];
}

function stripSubtitleMarkup(text: string): string {
    return text
        .replace(/<[^>]+>/g, "")
        .replace(/\{\\[^}]*\}/g, "")
        .replace(/\s+/g, " ")
        .trim();
}

/**
 * Parses both SRT and WebVTT subtitle files into sorted cues.
 */
export function parseSubtitles(raw: string): SubtitleCue[] {
    const normalized = raw
        .replace(/^\uFEFF/, "")
        .replace(/\r\n/g, "\n")
        .replace(/\r/g, "\n");
    const blocks = normalized.split(/\n{2,}/);
    const cues: SubtitleCue[] = [];

    for (const block of blocks) {
        const lines = block
            .split("\n")
            .map((l) => l.trim())
            .filter((l) => l.length > 0);
        if (lines.length === 0) continue;
        if (/^(WEBVTT|NOTE|STYLE|REGION)\b/i.test(lines[0])) continue;

        const arrowIdx = lines.findIndex((l) => l.includes("-->"));
        if (arrowIdx < 0) continue;

        const timingLine = lines[arrowIdx];
        const arrowPos = timingLine.indexOf("-->");
        const startRaw = timingLine.slice(0, arrowPos).trim();
        const endRaw = timingLine
            .slice(arrowPos + 3)
            .trim()
            .split(/\s+/)[0] || "";

        const startSec = parseTimestamp(startRaw);
        const endSec = parseTimestamp(endRaw);
        if (startSec === null || endSec === null || endSec < startSec) continue;

        const textLines = lines.slice(arrowIdx + 1);
        const text = stripSubtitleMarkup(textLines.join(" "));
        if (!text) continue;

        cues.push({
            index: cues.length,
            startSec,
            endSec,
            text,
        });
    }

    cues.sort((a, b) => a.startSec - b.startSec || a.endSec - b.endSec);
    return cues.map((cue, idx) => ({ ...cue, index: idx }));
}

/**
 * Binary searches for the active subtitle cue at `timeSec`. Returns -1 if none active.
 */
export function findActiveCueIndex(cues: readonly SubtitleCue[], timeSec: number): number {
    if (cues.length === 0 || !Number.isFinite(timeSec) || timeSec < 0) return -1;
    let lo = 0;
    let hi = cues.length - 1;
    let candidate = -1;
    while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (cues[mid].startSec <= timeSec) {
            candidate = mid;
            lo = mid + 1;
        } else {
            hi = mid - 1;
        }
    }
    if (candidate >= 0 && timeSec <= cues[candidate].endSec + 0.05) {
        return candidate;
    }
    return -1;
}

function normalizeForMatch(text: string): string {
    return text
        .normalize("NFKC")
        .toLowerCase()
        .replace(/[\s「」『』（）()【】\[\]、。.,!?！？・…―─\-'"‘’“”]/g, "");
}

/**
 * Finds the EPUB paragraph whose text best matches a spoken subtitle cue.
 * Searches near `hintIndex` first for fast, accurate sequential audiobook tracking.
 */
export function matchCueToParagraphIndex(
    cueText: string,
    paragraphs: ReadonlyArray<{ index: number; text: string }>,
    hintIndex?: number,
): number | null {
    const needle = normalizeForMatch(cueText);
    if (needle.length < 3 || paragraphs.length === 0) return null;

    const scoreParagraph = (paraText: string): number => {
        const hay = normalizeForMatch(paraText);
        if (!hay) return 0;
        if (hay.includes(needle)) return 100 + needle.length;
        if (needle.includes(hay) && hay.length >= 4) return 80 + hay.length;

        // Character bigram overlap for slight transcription/ruby differences
        const step = needle.length >= 8 ? 2 : 1;
        let hits = 0;
        let total = 0;
        for (let i = 0; i + 2 <= needle.length; i += step) {
            total += 1;
            if (hay.includes(needle.slice(i, i + 2))) hits += 1;
        }
        const ratio = total > 0 ? hits / total : 0;
        return ratio >= 0.6 ? Math.round(ratio * 70) : 0;
    };

    let bestIndex: number | null = null;
    let bestScore = 0;

    // Prioritize nearby paragraphs when hintIndex is supplied
    const order: number[] = [];
    if (typeof hintIndex === "number" && hintIndex >= 0 && hintIndex < paragraphs.length) {
        const radius = 24;
        const start = Math.max(0, hintIndex - 6);
        const end = Math.min(paragraphs.length - 1, hintIndex + radius);
        for (let i = start; i <= end; i++) order.push(i);
        for (let i = 0; i < paragraphs.length; i++) {
            if (i < start || i > end) order.push(i);
        }
    } else {
        for (let i = 0; i < paragraphs.length; i++) order.push(i);
    }

    for (const pos of order) {
        const p = paragraphs[pos];
        const score = scoreParagraph(p.text);
        if (score > bestScore) {
            bestScore = score;
            bestIndex = p.index;
            if (score >= 100) break;
        }
    }

    return bestScore >= 42 ? bestIndex : null;
}

export function formatAudioTime(seconds: number): string {
    if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
    const total = Math.floor(seconds);
    const hrs = Math.floor(total / 3600);
    const mins = Math.floor((total % 3600) / 60);
    const secs = total % 60;
    const pad = (n: number) => String(n).padStart(2, "0");
    return hrs > 0 ? `${hrs}:${pad(mins)}:${pad(secs)}` : `${mins}:${pad(secs)}`;
}
