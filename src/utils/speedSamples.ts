import type { ReadingSpeedSample } from './constants';

/** Samples are taken every 15 s of reading time; keep the most recent span dense. */
const MAX_SAMPLES = 1200;
const DENSE_TAIL = 480; // ~2 h at 15 s

/**
 * Appends a sample and, when the history grows too long, thins out the older
 * part (keeps every other sample) so the whole reading history of a tab stays
 * available at decreasing resolution instead of being cut off after an hour.
 */
export function appendSpeedSample(samples: ReadingSpeedSample[], sample: ReadingSpeedSample): ReadingSpeedSample[] {
    const next = [...samples, sample];
    if (next.length <= MAX_SAMPLES) return next;
    const head = next.slice(0, next.length - DENSE_TAIL).filter((_, index) => index % 2 === 0);
    return [...head, ...next.slice(next.length - DENSE_TAIL)];
}

export type SpeedMetric = 'chars' | 'words' | 'sentences';

export interface SpeedPoint {
    /** Reading-timer seconds at the end of the window. */
    time: number;
    /** Speed in metric units per minute. */
    perMinute: number;
}

/**
 * Speed curve over the last `rangeSeconds` of reading time. Each point is the
 * speed over a sliding window (~1 min of reading) so single quiet intervals do
 * not make the curve jagged. `current` is the reading time right now.
 */
export function speedCurve(
    samples: ReadingSpeedSample[],
    current: { time: number; chars: number; words: number; sentences: number },
    metric: SpeedMetric,
    rangeSeconds: number | null,
) {
    const all = [...samples.filter((sample) => sample.time < current.time), { ...current, at: Date.now() }]
        .sort((a, b) => a.time - b.time);
    const from = rangeSeconds == null ? -Infinity : current.time - rangeSeconds;
    const inRange = all.filter((sample) => sample.time >= from);
    // Include the sample just before the range so the first interval is complete.
    const before = [...all].reverse().find((sample) => sample.time < from);
    const series = before ? [before, ...inRange] : inRange;

    const value = (sample: { chars: number; words: number; sentences: number }) => sample[metric];
    const windowSeconds = Math.max(60, Math.min(600, (rangeSeconds ?? current.time) / 40));
    const points: SpeedPoint[] = [];
    for (let index = 1; index < series.length; index += 1) {
        const end = series[index];
        let startIndex = index - 1;
        while (startIndex > 0 && end.time - series[startIndex].time < windowSeconds) startIndex -= 1;
        const start = series[startIndex];
        const deltaTime = end.time - start.time;
        if (deltaTime <= 0) continue;
        const delta = Math.max(0, value(end) - value(start));
        points.push({ time: end.time, perMinute: (delta / deltaTime) * 60 });
    }

    const first = series[0];
    const last = series[series.length - 1];
    const spanSeconds = first && last ? Math.max(0, last.time - first.time) : 0;
    const read = first && last ? Math.max(0, value(last) - value(first)) : 0;
    const averagePerMinute = spanSeconds > 0 ? (read / spanSeconds) * 60 : 0;
    const speeds = points.map((point) => point.perMinute);
    return {
        points,
        read,
        spanSeconds,
        averagePerMinute,
        peakPerMinute: speeds.length ? Math.max(...speeds) : 0,
        lowPerMinute: speeds.length ? Math.min(...speeds) : 0,
    };
}
