import type { EpubAlignedCue, EpubAlignedParagraph, EpubAudioAlignment } from "./epubApi";

const AUDIO_LINKS_KEY = "setsuna-epub-audio-links-v1";

export interface EpubBookAudioConfig {
    audioPath: string;
    audioName: string;
    srtPath?: string;
    srtName?: string;
    cuePath?: string;
    cueName?: string;
    lastTimeSec: number;
    playbackRate: number;
    autoFollow: boolean;
    autoPauseOnLookup: boolean;
    skipSeconds: number;
    updatedAt: number;
}

export const DEFAULT_AUDIO_PREFS = {
    playbackRate: 1.0,
    autoFollow: true,
    autoPauseOnLookup: true,
    skipSeconds: 5,
};

export function makeBookAudioKey(title: string): string {
    return title.normalize("NFKC").replace(/\s+/g, "").toLowerCase();
}

export function loadBookAudioConfig(bookKey: string): EpubBookAudioConfig | null {
    if (!bookKey) return null;
    try {
        const raw = localStorage.getItem(AUDIO_LINKS_KEY);
        if (!raw) return null;
        const map = JSON.parse(raw) as Record<string, EpubBookAudioConfig>;
        const found = map[bookKey];
        return found && typeof found === "object" ? found : null;
    } catch {
        return null;
    }
}

export function saveBookAudioConfig(bookKey: string, config: EpubBookAudioConfig | null): void {
    if (!bookKey) return;
    try {
        const raw = localStorage.getItem(AUDIO_LINKS_KEY);
        const map: Record<string, EpubBookAudioConfig> = raw ? JSON.parse(raw) : {};
        if (!config) {
            delete map[bookKey];
        } else {
            map[bookKey] = { ...config, updatedAt: Date.now() };
        }
        localStorage.setItem(AUDIO_LINKS_KEY, JSON.stringify(map));
    } catch {
        // Ignore storage errors
    }
}

export function findAlignedCueAtTime(cues: readonly EpubAlignedCue[], timeSec: number): EpubAlignedCue | null {
    if (cues.length === 0 || !Number.isFinite(timeSec) || timeSec < 0) return null;
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
    if (candidate >= 0 && timeSec <= cues[candidate].endSec + 0.12) {
        return cues[candidate];
    }
    return null;
}

/**
 * Finds the best audio timestamp for a given `(chapterIndex, paragraphIndex)`.
 * Falls back to the nearest aligned paragraph in the same chapter if exact paragraph is unaligned.
 */
export function findTimestampForParagraph(
    paragraphs: readonly EpubAlignedParagraph[],
    chapterIndex: number,
    paragraphIndex: number,
): EpubAlignedParagraph | null {
    if (paragraphs.length === 0) return null;
    let exact: EpubAlignedParagraph | null = null;
    let nearestInChapter: EpubAlignedParagraph | null = null;
    let bestDist = Number.POSITIVE_INFINITY;

    for (const p of paragraphs) {
        if (p.chapterIndex !== chapterIndex) continue;
        if (p.paragraphIndex === paragraphIndex) {
            exact = p;
            break;
        }
        const dist = Math.abs(p.paragraphIndex - paragraphIndex);
        if (dist < bestDist) {
            bestDist = dist;
            nearestInChapter = p;
        }
    }
    return exact || nearestInChapter;
}

function formatSrtTimestamp(sec: number): string {
    const clamped = Math.max(0, Number.isFinite(sec) ? sec : 0);
    const totalMs = Math.round(clamped * 1000);
    const ms = totalMs % 1000;
    const totalSec = Math.floor(totalMs / 1000);
    const s = totalSec % 60;
    const totalMin = Math.floor(totalSec / 60);
    const m = totalMin % 60;
    const h = Math.floor(totalMin / 60);
    const p2 = (n: number) => String(n).padStart(2, "0");
    const p3 = (n: number) => String(n).padStart(3, "0");
    return `${p2(h)}:${p2(m)}:${p2(s)},${p3(ms)}`;
}

export function formatAlignmentAsSrt(alignment: EpubAudioAlignment): string {
    return alignment.cues
        .map((cue, idx) =>
            `${idx + 1}\n${formatSrtTimestamp(cue.startSec)} --> ${formatSrtTimestamp(cue.endSec)}\n${cue.text}\n`,
        )
        .join("\n");
}
