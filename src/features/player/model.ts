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

const stripAssTags = (value: string) =>
    value
        .replace(/\{[^}]*\}/g, "")
        .replace(/\\N/g, "\n")
        .replace(/\\n/g, "\n")
        .trim();

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
        const body = stripAssTags(cueText);
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
    return cues
        .filter((cue) => Number.isFinite(cue.start) && Number.isFinite(cue.end) && cue.end > cue.start)
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

export function clipInterval(scene: PlayerScene, leadIn: number, leadOut: number) {
    return {
        start: Math.max(0, scene.start - Math.max(0, leadIn)),
        end: Math.min(scene.duration, scene.end + Math.max(0, leadOut)),
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
