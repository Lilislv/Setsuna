import { normalizeWebSocketUrl } from "./appRuntime";

// The phone's list of text sources is the same `settings.websockets` list the
// desktop uses. These helpers change it without touching other entries.

export type WsSource = { id: string; name: string; url: string; active: boolean };

export const sameWsUrl = (a: string, b: string) =>
    normalizeWebSocketUrl(a || "").replace(/\/+$/, "").toLowerCase() === normalizeWebSocketUrl(b || "").replace(/\/+$/, "").toLowerCase();

const newSourceId = () => `ws-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

/** Name for an address without one: "192.168.0.40:9003". */
export const defaultSourceName = (url: string) => {
    try {
        const parsed = new URL(normalizeWebSocketUrl(url));
        return parsed.port ? `${parsed.hostname}:${parsed.port}` : parsed.hostname;
    } catch {
        return url;
    }
};

/** Adds an address unless it is already in the list; returns the list and the entry's id. */
export function addWsSource(list: WsSource[], url: string, name?: string): { list: WsSource[]; id: string; added: boolean } {
    const normalized = normalizeWebSocketUrl(url);
    const existing = list.find((source) => sameWsUrl(source.url, normalized));
    if (existing) {
        return {
            list: existing.active ? list : list.map((source) => (source.id === existing.id ? { ...source, active: true } : source)),
            id: existing.id,
            added: false,
        };
    }
    const id = newSourceId();
    return {
        list: [...list, { id, name: (name || "").trim() || defaultSourceName(normalized), url: normalized, active: true }],
        id,
        added: true,
    };
}

export function updateWsSource(list: WsSource[], id: string, patch: Partial<Omit<WsSource, "id">>): WsSource[] {
    return list.map((source) => {
        if (source.id !== id) return source;
        const next = { ...source, ...patch };
        if (patch.url !== undefined) next.url = normalizeWebSocketUrl(patch.url);
        if (patch.name !== undefined) next.name = patch.name.trim() || defaultSourceName(next.url);
        return next;
    });
}

/** Removes an entry; the main source moves to the next remaining one. */
export function removeWsSource(list: WsSource[], primaryId: string | undefined, id: string): { list: WsSource[]; primaryId: string } {
    const next = list.filter((source) => source.id !== id);
    const keep = primaryId && primaryId !== id && next.some((source) => source.id === primaryId);
    return { list: next, primaryId: keep ? primaryId! : (next[0]?.id ?? "") };
}

export const primaryWsSource = (list: WsSource[], primaryId?: string) =>
    list.find((source) => source.id === primaryId) || list[0] || null;
