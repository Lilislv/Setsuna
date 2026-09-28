/** A slow sink retains only its active write and the newest pending snapshot. */
export function createLatestTaskQueue<T>(write: (value: T) => Promise<unknown>, onError: (error: unknown) => void = console.warn) {
    let pending: { value: T } | undefined;
    let running: Promise<void> | undefined;
    return {
        push(value: T) {
            pending = { value };
            if (!running) {
                // Schedule after assigning `running`, including for synchronous failures.
                running = Promise.resolve().then(async () => {
                    try {
                        while (pending) {
                            const next = pending;
                            pending = undefined;
                            try { await write(next.value); } catch (error) { onError(error); }
                        }
                    } finally {
                        // No await between checking pending and becoming idle: a push
                        // in the next microtask must start a new drain.
                        running = undefined;
                    }
                });
            }
            return running;
        },
        get pendingCount() { return Number(Boolean(pending)); },
    };
}

// Change detection only, not an authentication or integrity checksum. Cache
// immutable React arrays/objects weakly so old workspaces remain collectable.
const fingerprints = new WeakMap<object, string>();
export function contentFingerprint(value: unknown): string {
    if (value !== null && typeof value === 'object') {
        const existing = fingerprints.get(value);
        if (existing) return existing;
    }
    let first = 0x811c9dc5;
    let second = 0x9e3779b9;
    const add = (text: string) => {
        for (let i = 0; i < text.length; i++) {
            first = Math.imul(first ^ text.charCodeAt(i), 0x01000193);
            second = Math.imul(second ^ text.charCodeAt(i), 0x5bd1e995);
        }
        first = Math.imul(first ^ text.length, 0x01000193);
        second = Math.imul(second ^ text.length, 0x5bd1e995);
    };
    if (Array.isArray(value)) {
        add(`array:${value.length}`);
        for (const item of value) add(contentFingerprint(item));
    } else if (value !== null && typeof value === 'object') {
        add('object');
        const record = value as Record<string, unknown>;
        for (const key of Object.keys(record).sort()) {
            if (record[key] === undefined) continue; // same semantics as JSON objects
            add(key);
            add(contentFingerprint(record[key]));
        }
    } else {
        add(typeof value);
        add(String(value));
    }
    const result = `${(first >>> 0).toString(16).padStart(8, '0')}${(second >>> 0).toString(16).padStart(8, '0')}`;
    if (value !== null && typeof value === 'object') fingerprints.set(value, result);
    return result;
}
