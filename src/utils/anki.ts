type CacheEntry<T> = {
    value: T;
    expiresAt: number;
};
import { fetch as tauriFetch } from '@tauri-apps/plugin-http';
import { SETSUNA_CARD_TEMPLATES, SETSUNA_MODEL_CSS, SETSUNA_TEMPLATE_NAME, isCurrentSetsunaTemplate } from "./ankiCardTemplate";
import { invoke } from '@tauri-apps/api/core';
import { resolveDictionaryAudio, type LocalAudioClip } from './dictionaryAudio';

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

export const SETSUNA_DEFAULT_DECK = "Setsuna";
export const SETSUNA_DEFAULT_MODEL = "Setsuna Japanese";
export const SETSUNA_MODEL_FIELDS = [
    "Expression",
    "ExpressionFurigana",
    "ExpressionReading",
    "MainDefinition",
    "Sentence",
    "SentenceFurigana",
    "Dictionary",
    "ExpressionAudio",
    "PitchPosition",
    "Frequency",
    "DefinitionPicture",
];

export type AnkiSetup = {
    decks: string[];
    models: string[];
    defaultDeck: string;
    defaultModel: string;
    fields: string[];
    createdDeck: boolean;
    createdModel: boolean;
};

const normalizeAnkiFieldName = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, "");

/** Picks Setsuna's fields for Lapis, the generated model, Basic, and custom models. */
export const recommendAnkiFieldSettings = (fields: string[]): Record<string, string> => {
    const find = (...candidates: string[]) => {
        const wanted = candidates.map(normalizeAnkiFieldName);
        return fields.find((field) => wanted.includes(normalizeAnkiFieldName(field))) || "none";
    };
    const wordCandidate = find("Expression", "Word", "Term", "Front");
    const word = wordCandidate !== "none" ? wordCandidate : fields[0] || "none";
    const meaningCandidate = find("MainDefinition", "Definition", "Meaning", "Back");
    const meaning = meaningCandidate !== "none"
        ? meaningCandidate
        : fields.find((field) => field !== word) || "none";
    return {
        ankiFieldWord: word,
        ankiFieldReading: find("ExpressionFurigana", "Reading", "Furigana"),
        ankiFieldMeaning: meaning,
        ankiFieldSentence: find("Sentence"),
        ankiFieldSentenceFurigana: find("SentenceFurigana", "Sentence Furigana", "SelectionFurigana"),
        ankiFieldDict: find("Dictionary", "Source"),
        ankiFieldAudio: find("ExpressionAudio", "Audio"),
        ankiFieldPitch: find("PitchPosition", "Pitch", "PitchAccent"),
        ankiFieldFreq: find("Frequency", "Freq"),
        ankiFieldScreenshot: find("DefinitionPicture", "Picture", "Screenshot", "Image"),
    };
};

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

let setsunaModelChecked = false;

/**
 * Brings an existing "Setsuna Japanese" note type to the current card design.
 * Only Setsuna's own note type is touched, and only when its templates are
 * older; cards keep their fields and review history. Desktop only.
 */
export const upgradeSetsunaModel = async (force = false): Promise<boolean> => {
    if (getAnkiDroidBridge() || (setsunaModelChecked && !force)) return false;
    try {
        const templates = await invokeAnki("modelTemplates", { modelName: SETSUNA_DEFAULT_MODEL }) as Record<string, { Front: string; Back: string }> | null;
        if (!templates) return false;
        setsunaModelChecked = true;
        const current = templates[SETSUNA_TEMPLATE_NAME];
        if (current && isCurrentSetsunaTemplate(current.Front)) return false;
        const fresh = SETSUNA_CARD_TEMPLATES[0];
        // A renamed template can't be updated by name; leave the user's edits alone then.
        const name = current ? SETSUNA_TEMPLATE_NAME : Object.keys(templates)[0];
        if (!name) return false;
        await invokeAnki("updateModelTemplates", { model: { name: SETSUNA_DEFAULT_MODEL, templates: { [name]: { Front: fresh.Front, Back: fresh.Back } } } });
        await invokeAnki("updateModelStyling", { model: { name: SETSUNA_DEFAULT_MODEL, css: SETSUNA_MODEL_CSS } });
        return true;
    } catch (error) {
        console.warn("Could not upgrade the Setsuna note type", error);
        return false;
    }
};

const createSetsunaModel = async () => {
    try {
        await invokeAnki("createModel", {
            modelName: SETSUNA_DEFAULT_MODEL,
            inOrderFields: SETSUNA_MODEL_FIELDS,
            css: SETSUNA_MODEL_CSS,
            cardTemplates: SETSUNA_CARD_TEMPLATES,
        });
        setsunaModelChecked = true;
        return true;
    } catch (error) {
        console.warn("Could not create the default Setsuna model", error);
        return false;
    }
};

/**
 * Makes a blank Anki profile usable without requiring the Lapis note type.
 * Existing profiles are left intact; this only creates the first Setsuna deck
 * and note type when Anki truly has no deck/model at all.
 */
export const ensureSetsunaAnkiSetup = async (): Promise<AnkiSetup> => {
    let decks = await getDecks(true);
    let models = await getModels(true);
    let createdDeck = false;
    let createdModel = false;

    // The Android bridge can read and insert into existing note types, but it
    // intentionally does not expose schema creation. Keep the user's AnkiDroid
    // profile untouched and let the settings screen explain that a model is
    // needed when the profile is completely empty.
    if (getAnkiDroidBridge()) {
        // AnkiDroid creates a missing target deck when the first note is
        // inserted, so a blank profile can still use Setsuna immediately.
        const defaultDeck = decks[0] || SETSUNA_DEFAULT_DECK;
        const defaultModel = models.find((model) => /lapis/i.test(model)) || models[0] || "";
        const fields = defaultModel ? await getModelFields(defaultModel, true) : [];
        return { decks, models, defaultDeck, defaultModel, fields, createdDeck, createdModel };
    }

    if (decks.length === 0) {
        try {
            await invokeAnki("createDeck", { deck: SETSUNA_DEFAULT_DECK });
            createdDeck = true;
        } catch (error) {
            // Another client may have created the first deck between the list
            // and create calls. Refresh below and only fail if it is still empty.
            console.warn("Could not create the default Setsuna deck", error);
        }
        clearAnkiMetaCache();
        decks = await getDecks(true);
    }

    // A clean Anki has Basic and Cloze, which can't hold a mining card: without
    // Lapis, Setsuna's own note type is created (it used to wait for a profile
    // with no note types at all, which never happens).
    if (!findLapisModel(models) && !models.includes(SETSUNA_DEFAULT_MODEL)) {
        createdModel = await createSetsunaModel();
        clearAnkiMetaCache();
        models = await getModels(true);
    } else if (models.includes(SETSUNA_DEFAULT_MODEL)) {
        await upgradeSetsunaModel();
    }

    const defaultDeck = decks.includes(SETSUNA_DEFAULT_DECK)
        ? SETSUNA_DEFAULT_DECK
        : (decks[0] || "");
    const defaultModel = findLapisModel(models)
        || models.find((model) => model === SETSUNA_DEFAULT_MODEL)
        || models[0]
        || "";
    const fields = defaultModel ? await getModelFields(defaultModel, true) : [];

    return {
        decks,
        models,
        defaultDeck,
        defaultModel,
        fields,
        createdDeck,
        createdModel,
    };
};


/** Lapis itself first, then its copies ("Lapis+", …). */
export const findLapisModel = (models: string[]) =>
    models.find((model) => /^lapis$/i.test(model.trim())) || models.find((model) => /lapis/i.test(model)) || "";

/**
 * Picks the note type for the first-run wizard: the one already chosen if it
 * still exists, else Lapis, else Setsuna's own simple type (created if needed).
 * It never replaces Lapis with the simple type: that sent cards to the wrong
 * note type for people who had Lapis set up.
 */
export const ensureSetsunaNoteType = async (current = ""): Promise<{ model: string; fields: string[]; models: string[] }> => {
    let models = await getModels(true);
    const keep = current && models.includes(current) && current !== SETSUNA_DEFAULT_MODEL ? current : "";
    const preferred = keep || findLapisModel(models);
    if (preferred) {
        return { model: preferred, fields: await getModelFields(preferred, true), models };
    }
    if (!models.includes(SETSUNA_DEFAULT_MODEL) && !getAnkiDroidBridge()) {
        await createSetsunaModel();
        clearAnkiMetaCache();
        models = await getModels(true);
    } else {
        await upgradeSetsunaModel();
    }
    const model = models.includes(SETSUNA_DEFAULT_MODEL) ? SETSUNA_DEFAULT_MODEL : (models[0] || "");
    const fields = model ? await getModelFields(model, true) : [];
    return { model, fields, models };
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
            // Final okurigana is a suffix. Its first occurrence may instead be
            // part of the kanji reading, e.g. 祝[いわ]い in お祝い.
            const nextPos = probe === term.length && reading.endsWith(nextLiteral)
                ? reading.length - nextLiteral.length
                : reading.indexOf(nextLiteral, readingIndex);
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
            !/\s$/.test(prev.text)
        ) {
            // Anki treats everything since the last space as the ruby base,
            // including kana: むず 痒[がゆ]い must keep むず outside the ruby.
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

const inlineSceneVideo = (filename: string): string => {
    const src = filename.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return `<video src="${src}" controls playsinline preload="metadata" style="display:block;width:640px;max-width:100%;height:auto;margin:0 auto"></video>`;
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
    // Recognize cards exported before ruby-base separators were corrected.
    if (clean.replace(/\s+/g, '') === expectedLapis.replace(/\s+/g, '')) return true;
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
    const bridge = getAnkiDroidBridge();
    let localAudio: LocalAudioClip | null = null;
    let audioWarning: string | undefined;

    // Cards made with an older copy of Setsuna's note type get the new design too.
    if (!bridge && settings.ankiModel === SETSUNA_DEFAULT_MODEL) await upgradeSetsunaModel();

    // Older settings may contain a model/deck but no field mapping because the
    // profile used to require Lapis. Resolve missing fields at card-add time so
    // a normal Basic or custom note type works immediately as well.
    if (settings.ankiModel) {
        const modelFields = await getModelFields(settings.ankiModel).catch(() => []);
        if (modelFields.length > 0) {
            const recommended = recommendAnkiFieldSettings(modelFields);
            const missing: Record<string, string> = {};
            Object.entries(recommended).forEach(([key, value]) => {
                if (!settings[key] || settings[key] === "none") missing[key] = value;
            });
            if (Object.keys(missing).length > 0) settings = { ...settings, ...missing };
        }
    }

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
    if (!noteData.audioPath && settings.ankiFieldAudio && settings.ankiFieldAudio !== 'none') {
        try {
            const audio = await resolveDictionaryAudio(settings, rawWord, rawReading);
            if (audio.kind !== 'none' && audio.clip) localAudio = audio.clip;
            else if (audio.kind === 'online') noteData = { ...noteData, audioUrl: audio.url };
            else {
                noteData = { ...noteData, audioUrl: undefined };
                audioWarning = settings.appLanguage === 'en' ? 'Card added without audio: no recording found in the selected sources.' : 'Карточка добавлена без озвучки: в выбранных источниках запись не найдена.';
            }
        } catch (error: any) { return { error: error?.message || String(error) }; }
    }
    const sceneField = [settings.ankiFieldAudio, settings.ankiFieldMeaning, settings.ankiFieldSentence]
        .find(field => field && field !== 'none');
    const isVideoClip = noteData.audioMediaType === 'video';
    const clipTargetField = isVideoClip && settings.ankiFieldScreenshot && settings.ankiFieldScreenshot !== 'none'
        ? settings.ankiFieldScreenshot
        : sceneField;
    if (noteData.playerScene && noteData.audioPath && !clipTargetField) {
        return { error: settings.appLanguage === 'en' ? 'Select a screenshot, audio, meaning or sentence field for the clip.' : 'Для клипа выбери поле картинки, озвучки, значения или предложения.' };
    }
    if (localAudio && !bridge) {
        try {
            const storedName = await invokeAnki('storeMediaFile', { filename: localAudio.filename, data: localAudio.data });
            if (typeof storedName !== 'string' || !storedName) throw new Error('Anki did not store the recording');
            fields[settings.ankiFieldAudio] = `${fields[settings.ankiFieldAudio] || ''} [sound:${storedName}]`.trim();
        } catch (error: any) { return { error: error?.message || String(error) }; }
    } else if (noteData.audioPath && clipTargetField) {
        const isVideo = noteData.audioMediaType === 'video';
        const filename = noteData.audioFilename || `setsuna_player_${safeWord}_${Date.now()}${isVideo ? '.webm' : '.mp3'}`;
        try {
            const storedName = await invokeAnki('storeMediaFile', {
                filename,
                path: noteData.audioPath,
                deleteExisting: true,
            });
            if (typeof storedName !== 'string' || !storedName) throw new Error('Anki did not store the clip');
            const media = isVideo ? inlineSceneVideo(storedName) : `[sound:${storedName}]`;
            fields[clipTargetField] = `${fields[clipTargetField] || ""} ${media}`.trim();
        } catch (error: any) {
            return { error: error.message };
        }
    } else if (!localAudio && noteData.audioUrl && settings.ankiFieldAudio && settings.ankiFieldAudio !== 'none') {
        note.audio = [
            {
                url: noteData.audioUrl,
                filename: `txthk_${safeWord}_${Date.now()}.mp3`,
                skipHash: '7e2c2f954ef6051373ba916f000168dc',
                fields: [settings.ankiFieldAudio],
            },
        ];
    }

    const pictureField = settings.ankiFieldScreenshot && settings.ankiFieldScreenshot !== 'none'
        ? settings.ankiFieldScreenshot : noteData.playerScene ? sceneField : null;
    if (noteData.screenshot && pictureField) {
        note.picture = [
            {
                data: noteData.screenshot,
                filename: `txthk_screen_${Date.now()}.jpg`,
                fields: [pictureField],
            },
        ];
    }

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
                audioField: localAudio ? settings.ankiFieldAudio : '',
                audioBase64: localAudio?.data || '',
                audioFilename: localAudio?.filename || '',
            };
            const result = parseBridgeResult<{ result: number | null }>(
                bridge.addNote(JSON.stringify(payload)),
            );
            wordStatusCache.clear();
            return { result: result.result, warning: audioWarning };
        } catch (error: any) {
            return { error: error.message || String(error) };
        }
    }

    // Note IDs are creation timestamps in ms, so a note with an ID after this
    // moment was created by this call.
    const startedAt = Date.now() - 2000;
    const findNoteAddedByThisCall = async (): Promise<number | null> => {
        const wordField = settings.ankiFieldWord && settings.ankiFieldWord !== 'none' ? settings.ankiFieldWord : '';
        if (!wordField || !rawWord) return null;
        try {
            const ids = await invokeAnki('findNotes', {
                query: `deck:"${escapeAnkiQuery(note.deckName)}" "${escapeAnkiQuery(wordField)}:${escapeAnkiQuery(rawWord)}"`,
            });
            const fresh = (Array.isArray(ids) ? ids : []).filter((id: number) => Number(id) >= startedAt);
            return fresh.length ? Number(fresh[fresh.length - 1]) : null;
        } catch {
            return null;
        }
    };

    try {
        const result = await invokeAnki('addNote', { note });
        wordStatusCache.clear();
        return { result, warning: audioWarning };
    } catch (error: any) {
        // A reply can fail (timeout while AnkiConnect downloads audio) after the
        // note was already created. Retrying then produced duplicate cards.
        const addedAnyway = await findNoteAddedByThisCall();
        if (addedAnyway) {
            wordStatusCache.clear();
            return { result: addedAnyway, warning: audioWarning };
        }
        const message = error?.message || String(error);
        if (note.audio?.length && !/timed out|timeout|unavailable/i.test(message)) {
            const audioError = message;
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

/** Attaches a player clip/screenshot (and missing sentence) to the most recently added Anki note. */
export const updateLastNoteWithScene = async (
    settings: any,
    noteData: {
        sentence?: string;
        sentenceFurigana?: string;
        audioPath?: string;
        audioFilename?: string;
        audioMediaType?: string;
        screenshot?: string;
    },
): Promise<{ result?: number; error?: string }> => {
    if (getAnkiDroidBridge()) {
        return {
            error:
                settings.appLanguage === 'en'
                    ? 'Update last card requires desktop AnkiConnect.'
                    : 'Обновление последней карточки доступно только через AnkiConnect на ПК.',
        };
    }

    try {
        const deckQuery = settings.ankiDeck ? `deck:"${escapeAnkiQuery(settings.ankiDeck)}" ` : '';
        let ids: unknown = await invokeAnki('findNotes', { query: `${deckQuery}added:1` });
        if (!Array.isArray(ids) || !ids.length) {
            ids = await invokeAnki('findNotes', { query: `${deckQuery}added:7` });
        }
        if (!Array.isArray(ids) || !ids.length) {
            return {
                error:
                    settings.appLanguage === 'en'
                        ? 'No recently added Anki card found.'
                        : 'Не найдена недавно добавленная карточка в Anki.',
            };
        }

        const noteId = Math.max(...ids.map((id) => Number(id)));
        const infos = await invokeAnki('notesInfo', { notes: [noteId] });
        const info = Array.isArray(infos) ? infos[0] : undefined;
        const noteFields: Record<string, { value?: string }> = info?.fields || {};
        const fieldNames = Object.keys(noteFields);
        if (!fieldNames.length) {
            return {
                error:
                    settings.appLanguage === 'en'
                        ? 'Could not inspect fields of the last Anki note.'
                        : 'Не удалось прочитать поля последней карточки Anki.',
            };
        }

        const recommended = recommendAnkiFieldSettings(fieldNames);
        const resolved = { ...settings };
        for (const [key, value] of Object.entries(recommended)) {
            if (!resolved[key] || resolved[key] === 'none') resolved[key] = value;
        }

        const hasField = (name?: string) => Boolean(name && name !== 'none' && Object.prototype.hasOwnProperty.call(noteFields, name));
        const sceneField = [resolved.ankiFieldAudio, resolved.ankiFieldMeaning, resolved.ankiFieldSentence].find((f) =>
            hasField(f),
        );
        const pictureField = hasField(resolved.ankiFieldScreenshot) ? resolved.ankiFieldScreenshot : sceneField;

        const updatedFields: Record<string, string> = {};
        const currentVal = (field: string) =>
            Object.prototype.hasOwnProperty.call(updatedFields, field)
                ? updatedFields[field]
                : (noteFields[field]?.value ?? '');

        if (
            noteData.sentence &&
            hasField(resolved.ankiFieldSentence) &&
            !normalizeFieldValue(currentVal(resolved.ankiFieldSentence))
        ) {
            updatedFields[resolved.ankiFieldSentence] = shouldUseSentenceFuriganaField(resolved.ankiFieldSentence)
                ? (noteData.sentenceFurigana || noteData.sentence)
                : noteData.sentence;
        }
        if (
            noteData.sentenceFurigana &&
            hasField(resolved.ankiFieldSentenceFurigana) &&
            !normalizeFieldValue(currentVal(resolved.ankiFieldSentenceFurigana))
        ) {
            updatedFields[resolved.ankiFieldSentenceFurigana] = noteData.sentenceFurigana;
        }

        if (noteData.audioPath) {
            const isVideo = noteData.audioMediaType === 'video';
            const targetField = isVideo ? pictureField : sceneField;
            if (targetField) {
                const filename = noteData.audioFilename || `setsuna_player_${Date.now()}${isVideo ? '.webm' : '.mp3'}`;
                const storedName = await invokeAnki('storeMediaFile', {
                    filename,
                    path: noteData.audioPath,
                    deleteExisting: true,
                });
                if (typeof storedName !== 'string' || !storedName) {
                    throw new Error('Anki did not store the clip');
                }
                const media = isVideo ? inlineSceneVideo(storedName) : `[sound:${storedName}]`;
                updatedFields[targetField] = `${currentVal(targetField)} ${media}`.trim();
            }
        }

        if (noteData.screenshot && pictureField) {
            const storedPic = await invokeAnki('storeMediaFile', {
                filename: `setsuna_screen_${Date.now()}.jpg`,
                data: noteData.screenshot,
                deleteExisting: true,
            });
            if (typeof storedPic === 'string' && storedPic) {
                updatedFields[pictureField] = `${currentVal(pictureField)} <img src="${storedPic}">`.trim();
            }
        }

        if (!Object.keys(updatedFields).length) {
            return {
                error:
                    settings.appLanguage === 'en'
                        ? 'No matching fields on the last Anki note.'
                        : 'У последней карточки Anki нет подходящих полей.',
            };
        }

        await invokeAnki('updateNoteFields', { note: { id: noteId, fields: updatedFields } });
        wordStatusCache.clear();
        return { result: noteId };
    } catch (error: any) {
        return { error: error?.message || String(error) };
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
