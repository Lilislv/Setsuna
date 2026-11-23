import { useEffect, useState } from 'react';
import { countLineStats, sumLineStats } from './textStats';

/**
 * Per-calendar-day reading totals (system date, not the tab timer), kept
 * both per tab and across all tabs. Stored locally on this device.
 */
export interface DayCounts {
    chars: number;
    words: number;
    sentences: number;
    lines: number;
    seconds: number;
}

export interface DayRecord {
    total: DayCounts;
    tabs: Record<string, DayCounts>;
}

type Store = Record<string, DayRecord>;

const STORAGE_KEY = 'setsuna-daily-stats';
const KEEP_DAYS = 400;
const listeners = new Set<() => void>();
let store: Store | null = null;
let saveTimer = 0;

export const emptyCounts = (): DayCounts => ({ chars: 0, words: 0, sentences: 0, lines: 0, seconds: 0 });

/** Local calendar date as YYYY-MM-DD. */
export const dayKey = (date = new Date()) => {
    const pad = (value: number) => String(value).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
};

const load = (): Store => {
    if (store) return store;
    try {
        const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
        store = parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
        store = {};
    }
    return store as Store;
};

const persist = () => {
    window.clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => {
        const data = load();
        const keys = Object.keys(data).sort();
        for (const key of keys.slice(0, Math.max(0, keys.length - KEEP_DAYS))) delete data[key];
        try { localStorage.setItem(STORAGE_KEY, JSON.stringify(data)); } catch {}
    }, 800);
    listeners.forEach((listener) => listener());
};

const add = (tabId: number | string, delta: Partial<DayCounts>) => {
    const data = load();
    const key = dayKey();
    const day = data[key] || (data[key] = { total: emptyCounts(), tabs: {} });
    const tab = day.tabs[String(tabId)] || (day.tabs[String(tabId)] = emptyCounts());
    for (const field of Object.keys(delta) as (keyof DayCounts)[]) {
        const value = delta[field] || 0;
        day.total[field] += value;
        tab[field] += value;
    }
    persist();
};

/** Records a newly hooked line. Words/sentences come from the native counter. */
export const recordDailyLine = (tabId: number | string, line: string, chars: number) => {
    add(tabId, { chars, lines: 1 });
    void countLineStats([line])
        .then(() => {
            const { words, sentences } = sumLineStats([line]);
            if (words || sentences) add(tabId, { words, sentences });
        })
        .catch(() => {});
};

/** Records reading-timer seconds for the active tab. */
export const recordDailySeconds = (tabId: number | string, seconds: number) => {
    if (seconds > 0) add(tabId, { seconds });
};

/** Records EPUB/book reading characters directly into daily stats. */
export const recordDailyChars = (tabId: number | string, chars: number) => {
    if (chars > 0) add(tabId, { chars: Math.round(chars) });
};

export const getDay = (key = dayKey()): DayRecord => load()[key] || { total: emptyCounts(), tabs: {} };

/** The last `count` days, oldest first, including today. */
export const getRecentDays = (count: number) => {
    const days: { key: string; date: Date; record: DayRecord }[] = [];
    const today = new Date();
    for (let offset = count - 1; offset >= 0; offset -= 1) {
        const date = new Date(today.getFullYear(), today.getMonth(), today.getDate() - offset);
        const key = dayKey(date);
        days.push({ key, date, record: getDay(key) });
    }
    return days;
};

/** Re-renders the caller whenever daily totals change. */
export const useDailyStatsVersion = () => {
    const [version, setVersion] = useState(0);
    useEffect(() => {
        const listener = () => setVersion((value) => value + 1);
        listeners.add(listener);
        return () => { listeners.delete(listener); };
    }, []);
    return version;
};
