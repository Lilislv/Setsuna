type CacheEntry<T> = {
    value: T;
    expiresAt: number;
};
import { fetch as tauriFetch } from '@tauri-apps/plugin-http';
import { invoke } from '@tauri-apps/api/core';

type AnkiDroidBridge = {
    isAvailable: () => string;
    requestPermission: () => string;
    getDecks: () => string;
    getModels: () => string;
    getModelFields: (modelName: string) => string;
    addNote: (noteJson: string) => string;
};

declare global {
    interface Window {
        SetsunaAnkiDroid?: AnkiDroidBridge;
    }
}

const ANKI_URL = 'http://127.0.0.1:8765';
const META_TTL_MS = 60_000;
const STATUS_TTL_MS = 15_000;

const cache = {
    decks: null as CacheEntry<string[]> | null,
    models: null as CacheEntry<string[]> | null,
    fieldsByModel: new Map<string, CacheEntry<string[]>>(),
};

const inflight = {
    decks: null as Promise<string[]> | null,
    models: null as Promise<string[]> | null,
    fieldsByModel: new Map<string, Promise<string[]>>(),
};

const isFresh = <T>(entry: CacheEntry<T> | null): entry is CacheEntry<T> => {
    return !!entry && Date.now() < entry.expiresAt;
};

const wordStatusCache = new Map<string, CacheEntry<'green' | 'red' | 'blue'>>();

const getAnkiDroidBridge = (): AnkiDroidBridge | null => {
    if (typeof window === "undefined") return null;
    return window.SetsunaAnkiDroid || null;
};

const parseBridgeResult = <T>(raw: string): T => {
    const parsed = JSON.parse(raw || "{}");
    if (!parsed.ok) {
        throw new Error(parsed.error || "AnkiDroid bridge error");
    }
    return parsed.value as T;
};

export const getAnkiBackend = () => {
    return getAnkiDroidBridge() ? "ankidroid" : "ankiconnect";
};

export const getAnkiDroidStatus = async () => {
    const bridge = getAnkiDroidBridge();
    if (!bridge) return null;
    return parseBridgeResult<{
        available: boolean;
        packageName: string | null;
        permissionGranted: boolean;
        specVersion: number;
    }>(bridge.isAvailable());
};

export const requestAnkiDroidPermission = async () => {
    const bridge = getAnkiDroidBridge();
    if (!bridge) return null;
    return parseBridgeResult<{ requested: boolean; permissionGranted: boolean }>(bridge.requestPermission());
};

export const invokeAnki = async (action: string, params: any = {}) => {
    if (typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window) {
        return invoke<any>('anki_request', { action, params });
    }

    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 4000);
    try {
        const request = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window ? tauriFetch : globalThis.fetch;
        const response = await request(ANKI_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action, version: 6, params }),
            signal: controller.signal,
        });

        if (!response.ok) throw new Error(`AnkiConnect HTTP ${response.status}`);
        const json = await response.json();
        if (json.error) throw new Error(json.error);
        return json.result;
    } catch (e) {
        console.error('AnkiConnect error:', e);
        throw e;
    } finally {
        window.clearTimeout(timeout);
    }
};

export const clearAnkiMetaCache = () => {
    cache.decks = null;
    cache.models = null;
    cache.fieldsByModel.clear();

    inflight.decks = null;
    inflight.models = null;
    inflight.fieldsByModel.clear();
    wordStatusCache.clear();
};

export const browseAnkiCards = async (deckName: string, fieldName: string, word: string) => {
    if (getAnkiDroidBridge()) {
        throw new Error("AnkiDroid does not support opening the desktop card browser");
    }
    if (!fieldName || fieldName === "none" || !word) return [];
    const deckQuery = deckName ? `deck:"${escapeAnkiQuery(deckName)}" ` : "";
    return invokeAnki("guiBrowse", {
        query: `${deckQuery}"${fieldName}:${escapeAnkiQuery(word)}"`,
    });
};

export const getDecks = async (forceRefresh = false): Promise<string[]> => {
    const bridge = getAnkiDroidBridge();
    if (bridge) {
        return parseBridgeResult<string[]>(bridge.getDecks());
    }

    if (!forceRefresh && isFresh(cache.decks)) {
        return cache.decks.value;
    }

    if (!forceRefresh && inflight.decks) {
        return inflight.decks;
    }

    inflight.decks = (async () => {
        const decks = await invokeAnki('deckNames');
        cache.decks = {
            value: Array.isArray(decks) ? decks : [],
            expiresAt: Date.now() + META_TTL_MS,
        };
        inflight.decks = null;
        return cache.decks.value;
    })().catch((err) => {
        inflight.decks = null;
        throw err;
    });

    return inflight.decks;
};

export const getModels = async (forceRefresh = false): Promise<string[]> => {
    const bridge = getAnkiDroidBridge();
    if (bridge) {
        return parseBridgeResult<string[]>(bridge.getModels());
    }

    if (!forceRefresh && isFresh(cache.models)) {
        return cache.models.value;
    }

    if (!forceRefresh && inflight.models) {
        return inflight.models;
    }

    inflight.models = (async () => {
        const models = await invokeAnki('modelNames');
        cache.models = {
            value: Array.isArray(models) ? models : [],
            expiresAt: Date.now() + META_TTL_MS,
        };
        inflight.models = null;
        return cache.models.value;
    })().catch((err) => {
        inflight.models = null;
        throw err;
    });

    return inflight.models;
};

export const getModelFields = async (
    modelName: string,
    forceRefresh = false
): Promise<string[]> => {
    if (!modelName) return [];

    const bridge = getAnkiDroidBridge();
    if (bridge) {
        return parseBridgeResult<string[]>(bridge.getModelFields(modelName));
    }

    const cached = cache.fieldsByModel.get(modelName) || null;
    if (!forceRefresh && isFresh(cached)) {
        return cached.value;
    }

    const running = inflight.fieldsByModel.get(modelName);
    if (!forceRefresh && running) {
        return running;
    }

    const promise = (async () => {
        const fields = await invokeAnki('modelFieldNames', { modelName });
        const safeFields = Array.isArray(fields) ? fields : [];

        cache.fieldsByModel.set(modelName, {
            value: safeFields,
            expiresAt: Date.now() + META_TTL_MS,
        });

        inflight.fieldsByModel.delete(modelName);
        return safeFields;
    })().catch((err) => {
        inflight.fieldsByModel.delete(modelName);
        throw err;
    });

    inflight.fieldsByModel.set(modelName, promise);
    return promise;
};


const isKanjiChar = (char: string): boolean => {
    return /[\u3400-\u9fff\uf900-\ufaff]/.test(char);
};

type FuriganaChunk = {
    text: string;
    reading: string | null;
};

export const splitJapaneseFurigana = (term: string, reading: string): FuriganaChunk[] => {
    if (!term || !reading || term === reading) {
        return [{ text: term || "", reading: null }];
    }

    const chunks: FuriganaChunk[] = [];
    let termIndex = 0;
    let readingIndex = 0;

    while (termIndex < term.length) {
        const current = term[termIndex];

        if (!isKanjiChar(current)) {
            let literal = "";

            while (termIndex < term.length && !isKanjiChar(term[termIndex])) {
                const ch = term[termIndex];
                literal += ch;

                if (readingIndex < reading.length && reading[readingIndex] === ch) {
                    readingIndex += 1;
                }

                termIndex += 1;
            }

            if (literal) {
                chunks.push({ text: literal, reading: null });
            }

            continue;
        }

        let kanjiBlock = "";
        while (termIndex < term.length && isKanjiChar(term[termIndex])) {
            kanjiBlock += term[termIndex];
            termIndex += 1;
        }

        let nextLiteral = "";
        let probe = termIndex;
        while (probe < term.length && !isKanjiChar(term[probe])) {
            nextLiteral += term[probe];
            probe += 1;
        }

        let blockReading = "";

        if (nextLiteral) {
            const nextPos = reading.indexOf(nextLiteral, readingIndex);
            if (nextPos >= readingIndex) {
                blockReading = reading.slice(readingIndex, nextPos);
                readingIndex = nextPos;
            } else {
                blockReading = reading.slice(readingIndex);
                readingIndex = reading.length;
            }
        } else {
            blockReading = reading.slice(readingIndex);
            readingIndex = reading.length;
        }

        chunks.push({ text: kanjiBlock, reading: blockReading || null });
    }

    return chunks.filter((chunk) => chunk.text.length > 0);
};

export const formatLapisFurigana = (term: string, reading: string): string => {
    const chunks = splitJapaneseFurigana(term, reading);
    const parts: string[] = [];

    chunks.forEach((chunk, index) => {
        const prev = chunks[index - 1];

        if (
            chunk.reading &&
            prev &&
            !prev.reading &&
            prev.text.length > 0 &&
            !/^[ぁ-ゖァ-ヺーの]+$/.test(prev.text)
        ) {
            parts.push(" ");
        }

        if (chunk.reading) {
            parts.push(`${chunk.text}[${chunk.reading}]`);
        } else {
            parts.push(chunk.text);
        }
    });

    return parts.join("").replace(/\s+/g, " ").trim();
};

const extractReadingFromLapis = (value: string): string => {
    if (!value) return "";
    const readings = Array.from(value.matchAll(/\[([^\]]+)\]/g)).map((m) => m[1]);
    return readings.join("");
};

const normalizeFieldValue = (value: any): string => {
    if (value === null || value === undefined) return "";
    return String(value).replace(/<[^>]*>/g, "").trim();
};

const escapeAnkiQuery = (value: string): string => {
    return String(value || "").replace(/\\/g, "\\\\").replace(/"/g, '\\"');
};

const makePairKey = (word: string, reading?: string | null): string => {
    return `${word || ""}__${reading || ""}`;
};

const isSameReading = (
    fieldValue: string,
    expectedWord: string,
    expectedReading: string,
): boolean => {
    if (!expectedReading) return true;

    const clean = normalizeFieldValue(fieldValue);
    const expectedLapis = formatLapisFurigana(expectedWord, expectedReading);

    if (clean === expectedReading) return true;
    if (clean === expectedLapis) return true;
    if (clean.includes(`[${expectedReading}]`)) return true;
    if (extractReadingFromLapis(clean) === expectedReading) return true;

    return false;
};

const shouldUseLapisFuriganaField = (fieldName: string | undefined): boolean => {
    if (!fieldName) return false;
    return /furigana/i.test(fieldName);
};

const shouldUseSentenceFuriganaField = (fieldName: string | undefined): boolean => {
    if (!fieldName) return false;
    return /furigana|sentencefurigana/i.test(fieldName);
};

type AnkiCheckPair = {
    word: string;
    reading?: string | null;
};

export const addNote = async (settings: any, noteData: any) => {
    const fields: Record<string, string> = {};

    const rawWord = noteData.word || "";
    const rawReading = noteData.rawReading || noteData.reading || "";
    const lapisFurigana =
        noteData.lapisExpression || formatLapisFurigana(rawWord, rawReading);

    if (settings.ankiFieldWord && settings.ankiFieldWord !== "none") {
        fields[settings.ankiFieldWord] = rawWord;
    }

    if (settings.ankiFieldReading && settings.ankiFieldReading !== "none") {
        fields[settings.ankiFieldReading] = shouldUseLapisFuriganaField(settings.ankiFieldReading)
            ? lapisFurigana
            : rawReading;
    }

    if (settings.ankiFieldMeaning && settings.ankiFieldMeaning !== 'none') {
        fields[settings.ankiFieldMeaning] = noteData.meaning || '';
    }
    if (settings.ankiFieldSentence && settings.ankiFieldSentence !== 'none') {
        fields[settings.ankiFieldSentence] = shouldUseSentenceFuriganaField(settings.ankiFieldSentence)
            ? (noteData.sentenceFurigana || noteData.sentence || '')
            : (noteData.sentence || '');
    }
    if (settings.ankiFieldSentenceFurigana && settings.ankiFieldSentenceFurigana !== 'none') {
        fields[settings.ankiFieldSentenceFurigana] = noteData.sentenceFurigana || noteData.sentence || '';
    }
    if (settings.ankiFieldDict && settings.ankiFieldDict !== 'none') {
        fields[settings.ankiFieldDict] = noteData.dictionary || '';
    }
    if (settings.ankiFieldPitch && settings.ankiFieldPitch !== 'none') {
        fields[settings.ankiFieldPitch] = noteData.pitch || '';
    }
    if (settings.ankiFieldFreq && settings.ankiFieldFreq !== 'none') {
        fields[settings.ankiFieldFreq] = noteData.frequency || '';
    }

    const note: any = {
        deckName: settings.ankiDeck,
        modelName: settings.ankiModel,
        fields,
        options: {
            allowDuplicate: true,
        },
    };

    const safeWord = String(rawWord || "clip").replace(/[\\/:*?"<>|\s]+/g, "_").slice(0, 48);
    if (noteData.audioPath && settings.ankiFieldAudio && settings.ankiFieldAudio !== 'none') {
        const filename = noteData.audioFilename || `setsuna_player_${safeWord}_${Date.now()}${noteData.audioMediaType === 'video' ? '.mp4' : '.mp3'}`;
        try {
            await invokeAnki('storeMediaFile', {
                filename,
                path: noteData.audioPath,
                deleteExisting: true,
            });
            fields[settings.ankiFieldAudio] = `${fields[settings.ankiFieldAudio] || ""} [sound:${filename}]`.trim();
        } catch (error: any) {
            return { error: error.message };
        }
    } else if (noteData.audioUrl && settings.ankiFieldAudio && settings.ankiFieldAudio !== 'none') {
        note.audio = [
            {
                url: noteData.audioUrl,
                filename: `txthk_${safeWord}_${Date.now()}.mp3`,
                skipHash: '7e2c2f954ef6051373ba916f000168dc',
                fields: [settings.ankiFieldAudio],
            },
        ];
    }

    if (
        noteData.screenshot &&
        settings.ankiFieldScreenshot &&
        settings.ankiFieldScreenshot !== 'none'
    ) {
        note.picture = [
            {
                data: noteData.screenshot,
                filename: `txthk_screen_${Date.now()}.jpg`,
                fields: [settings.ankiFieldScreenshot],
            },
        ];
    }

    const bridge = getAnkiDroidBridge();
    if (bridge) {
        try {
            const payload = {
                deckName: note.deckName,
                modelName: note.modelName,
                fields,
                tags: note.tags || [],
                screenshotField:
                    noteData.screenshot &&
                    settings.ankiFieldScreenshot &&
                    settings.ankiFieldScreenshot !== "none"
                        ? settings.ankiFieldScreenshot
                        : "",
                screenshotBase64: noteData.screenshot || "",
            };
            const result = parseBridgeResult<{ result: number | null }>(
                bridge.addNote(JSON.stringify(payload)),
            );
            wordStatusCache.clear();
            return { result: result.result };
        } catch (error: any) {
            return { error: error.message || String(error) };
        }
    }

    try {
        const result = await invokeAnki('addNote', { note });
        wordStatusCache.clear();
        return { result };
    } catch (error: any) {
        if (note.audio?.length) {
            const audioError = error?.message || String(error);
            delete note.audio;
            try {
                const result = await invokeAnki('addNote', { note });
                wordStatusCache.clear();
                return {
                    result,
                    warning: `Audio was skipped because AnkiConnect could not download it: ${audioError}`,
                };
            } catch (retryError: any) {
                return { error: retryError.message || String(retryError) };
            }
        }
        return { error: error.message };
    }
};

export const checkWordsStatusMulti = async (
    deckName: string,
    fieldName: string,
    readingFieldOrWords: string | null | string[],
    pairsMaybe?: AnkiCheckPair[],
) => {
    const readingField =
        Array.isArray(readingFieldOrWords) ? null : readingFieldOrWords;

    const pairs: AnkiCheckPair[] = Array.isArray(readingFieldOrWords)
        ? readingFieldOrWords.map((word) => ({ word, reading: "" }))
        : (pairsMaybe || []);

    const statuses: Record<string, 'green' | 'red' | 'blue'> = {};
    const now = Date.now();
    const unresolvedPairs: AnkiCheckPair[] = [];

    pairs.forEach((pair) => {
        const pairKey = makePairKey(pair.word, pair.reading);
        const cached = wordStatusCache.get(`${deckName}|${fieldName}|${readingField || ''}|${pairKey}`);
        if (cached && cached.expiresAt > now) {
            statuses[pairKey] = cached.value;
        } else {
            statuses[pairKey] = 'green';
            unresolvedPairs.push(pair);
        }
    });

    if (getAnkiDroidBridge()) {
        return statuses;
    }

    if (!deckName || !fieldName || unresolvedPairs.length === 0) {
        return statuses;
    }

    try {
        const uniqueWords = Array.from(new Set(unresolvedPairs.map((pair) => pair.word).filter(Boolean)));

        if (uniqueWords.length === 0) return statuses;

        const queryByWords = uniqueWords
            .map((word) => `"${fieldName}:${escapeAnkiQuery(word)}"`)
            .join(' OR ');

        const findResults = await invokeAnki('multi', {
            actions: [
                { action: 'findNotes', params: { query: `deck:"${escapeAnkiQuery(deckName)}" (${queryByWords})` } },
                { action: 'findNotes', params: { query: `-deck:"${escapeAnkiQuery(deckName)}" (${queryByWords})` } },
            ],
        });
        const unwrapMultiResult = (value: any) => value && typeof value === 'object' && !Array.isArray(value) && 'result' in value
            ? value.result
            : value;
        const sameResult = unwrapMultiResult(findResults?.[0]) || [];
        const otherResult = unwrapMultiResult(findResults?.[1]) || [];

        const noteGroups = [otherResult, sameResult].filter((ids) => Array.isArray(ids) && ids.length > 0);
        const infoResults = noteGroups.length > 0
            ? await invokeAnki('multi', {
                actions: noteGroups.map((ids) => ({ action: 'notesInfo', params: { notes: ids } })),
            })
            : [];
        let infoIndex = 0;

        const applyMatches = (
            notesInfo: any[],
            status: 'red' | 'blue',
        ) => {
            if (!Array.isArray(notesInfo)) return;

            notesInfo.forEach((info: any) => {
                const noteWord = normalizeFieldValue(info.fields?.[fieldName]?.value);
                const noteReading = readingField
                    ? normalizeFieldValue(info.fields?.[readingField]?.value)
                    : "";

                unresolvedPairs.forEach((pair) => {
                    if (pair.word !== noteWord) return;

                    const key = makePairKey(pair.word, pair.reading);

                    if (pair.reading && readingField && !isSameReading(noteReading, pair.word, pair.reading)) {
                        return;
                    }

                    if (status === 'red' || statuses[key] === 'green') {
                        statuses[key] = status;
                    }
                });
            });
        };

        if (otherResult.length > 0) applyMatches(unwrapMultiResult(infoResults?.[infoIndex++]) || [], 'blue');
        if (sameResult.length > 0) applyMatches(unwrapMultiResult(infoResults?.[infoIndex++]) || [], 'red');

        unresolvedPairs.forEach((pair) => {
            const pairKey = makePairKey(pair.word, pair.reading);
            wordStatusCache.set(`${deckName}|${fieldName}|${readingField || ''}|${pairKey}`, {
                value: statuses[pairKey],
                expiresAt: Date.now() + STATUS_TTL_MS,
            });
        });
        if (wordStatusCache.size > 2000) {
            for (const [key, entry] of wordStatusCache) {
                if (entry.expiresAt <= Date.now() || wordStatusCache.size > 1500) {
                    wordStatusCache.delete(key);
                }
            }
        }

        return statuses;
    } catch (e) {
        console.error('Anki duplicate check failed:', e);
        const errState: Record<string, 'green'> = {};
        pairs.forEach((pair) => {
            errState[makePairKey(pair.word, pair.reading)] = 'green';
        });
        return errState;
    }
};
