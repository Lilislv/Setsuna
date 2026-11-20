import { invoke } from '@tauri-apps/api/core';

export interface LineWordStats {
    words: number;
    sentences: number;
}

interface CachedLineStats extends LineWordStats {
    chars: number;
}

const countChars = (line: string) => line.replace(/[^\p{L}\p{N}]/gu, '').length;

const MAX_CACHE = 250_000;
const BATCH = 2_000;
const cache = new Map<string, CachedLineStats>();

/**
 * Sums cached word/sentence counts for `lines`. Lines not counted yet are
 * returned in `missing` (deduplicated) so the caller can fetch them.
 */
export function sumLineStats(lines: string[]): LineWordStats & { chars: number; missing: string[] } {
    let words = 0;
    let sentences = 0;
    let chars = 0;
    const missing = new Set<string>();
    for (const line of lines) {
        const stats = cache.get(line);
        if (stats) {
            words += stats.words;
            sentences += stats.sentences;
            chars += stats.chars;
        } else if (line.trim()) {
            missing.add(line);
        }
    }
    return { words, sentences, chars, missing: Array.from(missing) };
}

/** Counts lines with the native Japanese-aware counter and caches the result. */
export async function countLineStats(lines: string[]): Promise<void> {
    for (let start = 0; start < lines.length; start += BATCH) {
        const chunk = lines.slice(start, start + BATCH);
        const results = await invoke<LineWordStats[]>('count_text_stats', { lines: chunk });
        if (cache.size + chunk.length > MAX_CACHE) cache.clear();
        chunk.forEach((line, index) => {
            const result = results[index];
            if (result) cache.set(line, { words: result.words, sentences: result.sentences, chars: countChars(line) });
        });
    }
}
