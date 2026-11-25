export type Cue = {
    id: number;
    start: number;
    end: number;
    text: string;
};

const pad2 = (value: number) => value.toString().padStart(2, "0");

export const formatClock = (seconds: number) => {
    if (!Number.isFinite(seconds) || seconds <= 0) return "00:00";
    const total = Math.floor(seconds);
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    return h > 0 ? `${h}:${pad2(m)}:${pad2(s)}` : `${pad2(m)}:${pad2(s)}`;
};

const parseTimestamp = (value: string) => {
    const clean = value.trim().replace(",", ".");
    const parts = clean.split(":");
    if (parts.length < 2 || parts.length > 3 || parts.some((p) => !/^\d+(?:\.\d+)?$/.test(p))) return NaN;
    const sec = Number(parts.pop() || 0);
    const min = Number(parts.pop() || 0);
    const hour = Number(parts.pop() || 0);
    return hour * 3600 + min * 60 + sec;
};

export function decodeSubtitleBytes(bytes: Uint8Array) {
    if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder("utf-16le").decode(bytes);
    if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder("utf-16be").decode(bytes);
    try {
        return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
        return new TextDecoder("shift_jis").decode(bytes);
    }
}

export function escapeCardText(text: string) {
    return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\r?\n/g, "<br>");
}

function assDialogueText(value: string) {
    let drawing = false;
    let text = "";
    for (const match of value.matchAll(/\{([^}]*)\}|([^{]+|\{)/g)) {
        if (match[1] !== undefined) {
            for (const command of match[1].matchAll(/\\p\s*(\d+)/gi)) {
                drawing = Number(command[1]) > 0;
            }
        } else if (!drawing) {
            text += match[2];
        }
    }
    return text
        .replace(/\\[Nn]/g, "\n")
        .replace(/\\h/g, " ")
        .trim();
}

const parseSrtOrVtt = (text: string): Cue[] => {
    const blocks = text
        .replace(/\r/g, "")
        .replace(/^WEBVTT[^\n]*\n/i, "")
        .split(/\n[ \t]*\n/)
        .map((block) => block.trim())
        .filter(Boolean);

    return blocks.flatMap((block, index) => {
        const lines = block
            .split("\n")
            .map((line) => line.trim())
            .filter(Boolean);
        const timeIndex = lines.findIndex((line) => line.includes("-->"));
        if (timeIndex < 0) return [];
        const [startRaw, endRaw] = lines[timeIndex].split("-->").map((part) => part.trim().split(/\s+/)[0]);
        const body = lines
            .slice(timeIndex + 1)
            .join("\n")
            .replace(/<[^>]+>/g, "")
            .replace(
                /&(lt|gt|amp|nbsp);/g,
                (_, name: string) =>
                    ({ lt: "<", gt: ">", amp: "&", nbsp: " " })[name as "lt" | "gt" | "amp" | "nbsp"],
            )
            .trim();
        if (!body) return [];
        return [{ id: index, start: parseTimestamp(startRaw), end: parseTimestamp(endRaw), text: body }];
    });
};

const parseAss = (text: string): Cue[] => {
    const lines = text.replace(/\r/g, "").split("\n");
    let format: string[] = [];
    const cues: Cue[] = [];

    lines.forEach((line) => {
        if (line.startsWith("Format:")) {
            format = line
                .slice(7)
                .split(",")
                .map((part) => part.trim().toLowerCase());
            return;
        }
        if (!line.startsWith("Dialogue:")) return;
        const raw = line.slice(9);
        const textIndex = format.indexOf("text");
        const startIndex = format.indexOf("start");
        const endIndex = format.indexOf("end");
        const minParts = Math.max(textIndex, startIndex, endIndex);
        const parts = raw.split(",", minParts + 1);
        if (textIndex < 0 || startIndex < 0 || endIndex < 0 || parts.length <= minParts) return;
        const prefix = parts.slice(0, textIndex);
        const cueText = raw.split(",").slice(textIndex).join(",");
        const body = assDialogueText(cueText);
        if (!body) return;
        cues.push({
            id: cues.length,
            start: parseTimestamp(prefix[startIndex]?.trim() || "0"),
            end: parseTimestamp(prefix[endIndex]?.trim() || "0"),
            text: body,
        });
    });

    return cues;
};

export function parseSubtitleFile(text: string, name: string): Cue[] {
    const raw = text.replace(/^\uFEFF/, "");
    const cues = /\.(ass|ssa)$/i.test(name) ? parseAss(raw) : parseSrtOrVtt(raw);
    const seen = new Set<string>();
    return cues
        .filter((cue) => {
            if (!Number.isFinite(cue.start) || !Number.isFinite(cue.end) || cue.end <= cue.start) return false;
            const key = JSON.stringify([cue.start, cue.end, cue.text]);
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        })
        .sort((a, b) => a.start - b.start || a.end - b.end);
}

// Positive offset displays subtitles earlier. Convert back to the media clock for every seek and export.
export type PlayerScene = {
    source: string;
    start: number;
    end: number;
    duration: number;
    audioOnly?: boolean;
    audioTrack?: number;
};

export function sceneForCue(source: string, cue: Cue, offset: number, duration: number): PlayerScene | undefined {
    if (!source || !(duration > 0)) return;
    const start = Math.max(0, cue.start - offset);
    const end = Math.min(duration, cue.end - offset);
    if (end > start) return { source, start, end, duration };
}

export const scenePaddingSeconds = 0.5;

export function clipInterval(
    scene: PlayerScene,
    padStart = scenePaddingSeconds,
    padEnd = scenePaddingSeconds,
) {
    const before = Math.max(0, Number.isFinite(padStart) ? padStart : scenePaddingSeconds);
    const after = Math.max(0, Number.isFinite(padEnd) ? padEnd : scenePaddingSeconds);
    return {
        start: Math.max(0, scene.start - before),
        end: Math.min(scene.duration, scene.end + after),
    };
}

export function cueAt(cues: Cue[], time: number) {
    return cues.find((cue) => cue.start <= time && time < cue.end);
}

export function previousCue(cues: Cue[], time: number) {
    for (let i = cues.length - 1; i >= 0; i--) {
        if (cues[i].start <= time) return cues[i];
    }
}

function previousCueIndex(cues: Cue[], time: number) {
    for (let i = cues.length - 1; i >= 0; i--) {
        if (cues[i].start < time) return i;
    }
    return -1;
}

export function nextCue(
    cues: Cue[],
    time: number,
    direction: -1 | 1,
    offset: number,
    duration: number,
    anchorIndex?: number,
) {
    let baseIndex =
        anchorIndex !== undefined && anchorIndex >= 0 && anchorIndex < cues.length ? anchorIndex : -1;
    if (baseIndex < 0) {
        const active = cueAt(cues, time);
        if (active) {
            baseIndex = cues.indexOf(active);
        } else if (direction > 0) {
            // Frame-timebase rounding can place currentTime just shy of target.start right after a seek.
            baseIndex = cues.findIndex((c) => Math.abs(c.start - time) <= 0.05);
        }
    }
    if (baseIndex >= 0) {
        const baseStart = cues[baseIndex].start;
        for (let i = baseIndex + direction; i >= 0 && i < cues.length; i += direction) {
            const cue = cues[i];
            if (Math.abs(cue.start - baseStart) < 0.05) continue;
            if (cue.end > offset && cue.start < duration + offset) return cue;
        }
        return undefined;
    }
    const first =
        direction > 0 ? cues.findIndex((cue) => cue.start > time) : previousCueIndex(cues, time);
    for (let i = first; i >= 0 && i < cues.length; i += direction) {
        const cue = cues[i];
        if (cue.end > offset && cue.start < duration + offset) return cue;
    }
}

/** Replays the active line if well past its start, otherwise jumps to the previous cue. */
export function replayOrPreviousCue(
    cues: Cue[],
    clock: number,
    offset: number,
    duration: number,
    restartThreshold = 0.6,
): { cue?: Cue; replayed: boolean } {
    const active = cueAt(cues, clock);
    if (
        active &&
        clock - active.start > restartThreshold &&
        active.end > offset &&
        active.start < duration + offset
    ) {
        return { cue: active, replayed: true };
    }
    return { cue: nextCue(cues, clock, -1, offset, duration), replayed: false };
}

/** Snaps subtitle offset so the target previous or next cue starts right at `mediaTime`. */
export function syncOffsetToCue(
    cues: Cue[],
    mediaTime: number,
    offset: number,
    direction: -1 | 1,
    duration: number,
): { cue: Cue; offset: number } | undefined {
    const clock = mediaTime + offset;
    let target: Cue | undefined;
    if (direction === -1) {
        const active = cueAt(cues, clock);
        target = active && clock - active.start > 0.15 ? active : nextCue(cues, clock, -1, offset, duration);
    } else {
        target =
            cues.find((c) => c.start > clock + 0.05 && c.end > offset && c.start < duration + offset) ||
            cues.find((c) => c.start > clock);
    }
    if (!target) return undefined;
    return { cue: target, offset: Number((target.start - mediaTime).toFixed(2)) };
}

/** Removes regex-matched stage directions / sound effects and drops cues that become empty. */
export function filterCuesByRegex(cues: Cue[], pattern?: string): Cue[] {
    if (!pattern || !pattern.trim()) return cues;
    let regex: RegExp;
    try {
        regex = new RegExp(pattern, "gu");
    } catch {
        return cues;
    }
    const cleaned: Cue[] = [];
    for (const cue of cues) {
        const text = cue.text
            .replace(regex, "")
            .replace(/[ \t]{2,}/g, " ")
            .replace(/\n{2,}/g, "\n")
            .trim();
        if (text) cleaned.push(text === cue.text ? cue : { ...cue, text });
    }
    return cleaned;
}

/** Delay in milliseconds before auto-resuming from subtitle auto-pause, or null for manual resume. */
export function autoPauseResumeDelayMs(
    cue: Cue,
    mode: "manual" | "fixed" | "dynamic",
    fixedSec = 2.5,
    msPerChar = 160,
): number | null {
    if (mode === "manual") return null;
    if (mode === "fixed") {
        return Math.max(400, Math.round((Number.isFinite(fixedSec) ? fixedSec : 2.5) * 1000));
    }
    const chars = cue.text.replace(/\s+/g, "").length;
    const perChar = Number.isFinite(msPerChar) ? msPerChar : 160;
    return Math.max(1200, Math.min(12000, Math.round(chars * perChar + 600)));
}
