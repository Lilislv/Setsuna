// In-app hover lookups are not visible in the diagnostics log otherwise. The periodic
// frontend snapshot includes these counters, so a "lookup stopped working" report
// shows whether scans fail, hang or never start.

export interface LookupStats {
    scans: number;
    found: number;
    failed: number;
    slow: number;
    inFlight: number;
    lastMs: number;
    maxMs: number;
    lastAt: number;
    lastError?: string;
}

const stats: LookupStats = { scans: 0, found: 0, failed: 0, slow: 0, inFlight: 0, lastMs: 0, maxMs: 0, lastAt: 0 };

export const lookupStats = (): LookupStats => ({ ...stats });

/** Times one backend scan; `found` tells whether it produced entries. */
export async function trackLookup<T>(scan: () => Promise<T>, found: (result: T) => boolean): Promise<T> {
    const started = performance.now();
    stats.scans += 1;
    stats.inFlight += 1;
    stats.lastAt = Date.now();
    try {
        const result = await scan();
        if (found(result)) stats.found += 1;
        return result;
    } catch (error) {
        stats.failed += 1;
        stats.lastError = String(error).slice(0, 200);
        throw error;
    } finally {
        const ms = Math.round(performance.now() - started);
        stats.inFlight -= 1;
        stats.lastMs = ms;
        stats.maxMs = Math.max(stats.maxMs, ms);
        if (ms > 1500) stats.slow += 1;
    }
}
