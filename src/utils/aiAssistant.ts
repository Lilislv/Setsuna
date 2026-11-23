import { invoke } from "@tauri-apps/api/core";

// Local AI explanations (desktop). See src-tauri/src/ai_assistant.rs.

export const AI_DEFAULT_MODEL = "gemma-4-e4b";

export type AiExplainLanguage = "ru" | "uk" | "ja" | "en";
export type AiSourceLanguage = "auto" | "ja" | "en";
export type AiDetail = "detailed" | "brief";
/** @deprecated kept for older settings; use AiExplainLanguage */
export type AiLanguage = AiExplainLanguage;

export type AiPromptSettings = {
    explainLanguage: AiExplainLanguage;
    sourceLanguage: AiSourceLanguage;
    detail: AiDetail;
    customPrompt: string;
};

export type AiModelStatus = {
    id: string;
    name: string;
    sizeBytes: number;
    installed: boolean;
    partialBytes: number;
};

export type AiStatus = {
    supported: boolean;
    runtimeInstalled: boolean;
    models: AiModelStatus[];
    running: string | null;
    downloading: boolean;
    modelsDir: string;
    defaultModelsDir: string;
};

export type AiDownloadEvent = {
    stage: "runtime" | "model" | "verify" | "extract" | "move" | "moved" | "done" | "cancelled" | "error";
    received: number;
    total: number;
    error?: string | null;
};

export type AiExplainRequest = {
    tabId: number | string | null;
    tabName: string;
    lines: string[];
};

export const formatBytes = (bytes: number) => {
    if (!Number.isFinite(bytes) || bytes <= 0) return "0 MB";
    if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
    return `${Math.max(1, Math.round(bytes / 1e6))} MB`;
};

export const fetchAiStatus = () => invoke<AiStatus>("ai_status");

export const aiModelReady = (status: AiStatus | null, modelId: string) =>
    Boolean(status?.runtimeInstalled && status.models.some((model) => model.id === modelId && model.installed));

/** Reads the prompt options from settings (older builds stored only `aiLanguage`). */
export const readAiPromptSettings = (settings: Record<string, any>): AiPromptSettings => {
    const languages: AiExplainLanguage[] = ["ru", "uk", "ja", "en"];
    const explain = languages.includes(settings.aiExplainLanguage) ? settings.aiExplainLanguage
        : languages.includes(settings.aiLanguage) ? settings.aiLanguage : "ru";
    return {
        explainLanguage: explain,
        sourceLanguage: ["ja", "en"].includes(settings.aiSourceLanguage) ? settings.aiSourceLanguage : "auto",
        detail: settings.aiDetail === "brief" ? "brief" : "detailed",
        customPrompt: typeof settings.aiCustomPrompt === "string" ? settings.aiCustomPrompt.trim() : "",
    };
};

const JAPANESE_RE = /[぀-ヿ㐀-鿿]/;
export const detectSourceLanguage = (lines: string[], preferred: AiSourceLanguage): "ja" | "en" =>
    preferred !== "auto" ? preferred : lines.some((line) => JAPANESE_RE.test(line)) ? "ja" : "en";

// The persona and language live in the system prompt; the answer layout is part
// of each explanation request only. Otherwise the model also "translated and
// broke down" plain follow-up questions.
const SYSTEM_PROMPTS: Record<AiExplainLanguage, string> = {
    ru: [
        "Ты — дружелюбный репетитор японского и английского для человека, который читает визуальные новеллы и книги.",
        "Отвечай только по-русски.",
        "Когда тебя просят объяснить строки, следуй формату из запроса.",
        "На обычные вопросы отвечай обычным разговорным текстом, без шаблона «Перевод / Смысл / Разбор».",
        "Не выдумывай: если не уверен, так и скажи. Не используй ромадзи.",
    ].join(" "),
    uk: [
        "Ти — привітний репетитор японської та англійської для людини, яка читає візуальні новели та книжки.",
        "Відповідай лише українською.",
        "Коли тебе просять пояснити рядки, дотримуйся формату із запиту.",
        "На звичайні питання відповідай звичайним розмовним текстом, без шаблону «Переклад / Сенс / Розбір».",
        "Не вигадуй: якщо не впевнений, так і скажи. Не використовуй ромадзі.",
    ].join(" "),
    ja: [
        "あなたは、ビジュアルノベルや本を読んでいる学習者を助ける、やさしい先生です。",
        "かならず、やさしい日本語だけで答えてください。ほかの言語はつかわないでください。",
        "みじかい文で、むずかしい言葉をつかわずに説明してください。むずかしい漢字には読みをつけてください（例：分析（ぶんせき））。",
        "行の説明をたのまれたときは、たのまれた形にしたがってください。ふつうの質問には、形をつかわずにふつうに答えてください。",
        "わからないことは、わからないと言ってください。",
    ].join(""),
    en: [
        "You are a friendly Japanese and English tutor for someone reading visual novels and books.",
        "Answer only in English.",
        "When asked to explain lines, follow the format given in the request.",
        "Answer ordinary questions in plain conversational text, without the Translation / Meaning / Breakdown layout.",
        "Don't make things up: say so when you are unsure. Don't use romaji.",
    ].join(" "),
};

const CUSTOM_PROMPT_LABEL: Record<AiExplainLanguage, string> = {
    ru: "Дополнительные указания от пользователя (соблюдай их):",
    uk: "Додаткові вказівки від користувача (дотримуйся їх):",
    ja: "ユーザーからのおねがい（まもってください）：",
    en: "Extra instructions from the user (follow them):",
};

export const aiSystemPrompt = (prompt: AiPromptSettings, memory = "") => [
    SYSTEM_PROMPTS[prompt.explainLanguage],
    prompt.customPrompt ? `${CUSTOM_PROMPT_LABEL[prompt.explainLanguage]}\n${prompt.customPrompt}` : "",
    memory,
].filter(Boolean).join("\n\n");

// The answer layout is given as a literal skeleton with headings: a small model
// copies a skeleton reliably, while a description of the format ("Translation —
// a natural translation") got treated as text to write about.
type Source = "ja" | "en";
type Format = {
    work: string;
    head: (many: boolean) => string;
    detailed: (source: Source, many: boolean) => string;
    brief: (source: Source, many: boolean) => string;
};

const FORMATS: Record<AiExplainLanguage, Format> = {
    ru: {
        work: "Произведение",
        head: (many) => (many ? "Объясни эти строки вместе, как одну сцену:" : "Объясни строку:"),
        detailed: (source, many) => [
            "Ответь строго по шаблону ниже. Заголовки оставь как есть, текст в квадратных скобках замени своим. Пиши по-русски.",
            "",
            "### Перевод",
            many ? "[естественный перевод каждой строки по порядку, каждая с новой строки]" : "[естественный перевод, как в хорошей локализации]",
            "",
            "### Смысл",
            "[что на самом деле сказано: подтекст, тон, эмоции, намёки, кто к кому обращается — 2–4 предложения]",
            "",
            "### Слова и грамматика",
            source === "ja"
                ? "- **[слово или конструкция из оригинала]**（[чтение хираганой]） — [что значит именно здесь]"
                : "- **[слово, идиома или фразовый глагол из оригинала]** — [что значит именно здесь]",
            "[3–6 таких пунктов: то, без чего фразу не понять]",
        ].join("\n"),
        brief: (_source, many) => [
            "Ответь кратко строго по шаблону ниже. Заголовки оставь как есть, текст в квадратных скобках замени своим. Пиши по-русски.",
            "",
            "### Перевод",
            many ? "[перевод каждой строки по порядку]" : "[естественный перевод]",
            "",
            "### Смысл",
            "[одно-два предложения о подтексте и тоне]",
        ].join("\n"),
    },
    uk: {
        work: "Твір",
        head: (many) => (many ? "Поясни ці рядки разом, як одну сцену:" : "Поясни рядок:"),
        detailed: (source, many) => [
            "Відповідай строго за шаблоном нижче. Заголовки залиш як є, текст у квадратних дужках заміни своїм. Пиши українською.",
            "",
            "### Переклад",
            many ? "[природний переклад кожного рядка по черзі, кожен з нового рядка]" : "[природний переклад, як у гарній локалізації]",
            "",
            "### Сенс",
            "[що насправді сказано: підтекст, тон, емоції, натяки, хто до кого звертається — 2–4 речення]",
            "",
            "### Слова і граматика",
            source === "ja"
                ? "- **[слово або конструкція з оригіналу]**（[читання хіраґаною]） — [що означає саме тут]"
                : "- **[слово, ідіома або фразове дієслово з оригіналу]** — [що означає саме тут]",
            "[3–6 таких пунктів: те, без чого фразу не зрозуміти]",
        ].join("\n"),
        brief: (_source, many) => [
            "Відповідай коротко строго за шаблоном нижче. Заголовки залиш як є, текст у квадратних дужках заміни своїм. Пиши українською.",
            "",
            "### Переклад",
            many ? "[переклад кожного рядка по черзі]" : "[природний переклад]",
            "",
            "### Сенс",
            "[одне-два речення про підтекст і тон]",
        ].join("\n"),
    },
    ja: {
        work: "作品",
        head: (many) => (many ? "この行を、ひとつの場面としてまとめて説明してください：" : "この文を説明してください："),
        detailed: (source, many) => [
            "下の形のとおりに答えてください。見出しはそのまま使い、［ ］の中をあなたの言葉にかえてください。やさしい日本語だけで書いてください。",
            "",
            source === "ja" ? "### やさしい日本語で言いかえると" : "### やさしい日本語にすると",
            many ? "［一行ずつ、やさしい日本語で。順番どおりに、一行ごとに改行］" : "「［やさしい日本語で言いかえた文］」",
            "",
            "### 言葉の説明",
            source === "ja"
                ? "- **［むずかしい言葉］**（［よみ］）：［やさしい説明］"
                : "- **［英語の言葉や言いかた］**：［やさしい日本語で、ここでの意味］",
            "［このような説明を3〜6こ］",
            "",
            "### 文のポイント",
            "**［いちばん大事な部分］**",
            "→ ［どういう意味か、どんな気持ちや場面かを、やさしく説明］",
        ].join("\n"),
        brief: (source, many) => [
            "下の形のとおりに、みじかく答えてください。見出しはそのまま使い、［ ］の中をあなたの言葉にかえてください。",
            "",
            source === "ja" ? "### やさしい日本語で言いかえると" : "### やさしい日本語にすると",
            many ? "［一行ずつ、やさしい日本語で］" : "「［やさしい日本語で言いかえた文］」",
            "",
            "### 文のポイント",
            "→ ［気持ちや場面を1〜2文で］",
        ].join("\n"),
    },
    en: {
        work: "Work",
        head: (many) => (many ? "Explain these lines together as one scene:" : "Explain this line:"),
        detailed: (source, many) => [
            "Answer strictly with the template below. Keep the headings as they are and replace the text in square brackets with your own. Write in English.",
            "",
            source === "ja" ? "### Translation" : "### In simpler words",
            many
                ? (source === "ja" ? "[a natural translation of each line in order, one per line]" : "[each line in simpler English, in order, one per line]")
                : (source === "ja" ? "[a natural translation, like a good localization]" : "[the same idea in simpler English]"),
            "",
            "### Meaning",
            "[what is really being said: subtext, tone, emotion, hints, who is speaking to whom — 2–4 sentences]",
            "",
            "### Words and grammar",
            source === "ja"
                ? "- **[word or construction from the original]** ([reading in hiragana]) — [what it means here]"
                : "- **[word, idiom or phrasal verb from the original]** — [what it means here]",
            "[3–6 such points: what you need to understand the line]",
        ].join("\n"),
        brief: (source, many) => [
            "Answer briefly, strictly with the template below. Keep the headings and replace the text in square brackets.",
            "",
            source === "ja" ? "### Translation" : "### In simpler words",
            many ? "[each line in order]" : "[one natural sentence]",
            "",
            "### Meaning",
            "[one or two sentences about subtext and tone]",
        ].join("\n"),
    },
};

export const aiExplainPrompt = (request: AiExplainRequest, prompt: AiPromptSettings) => {
    const format = FORMATS[prompt.explainLanguage];
    const source = detectSourceLanguage(request.lines, prompt.sourceLanguage);
    const many = request.lines.length > 1;
    const title = request.tabName.trim();
    const body = many ? request.lines.map((line, index) => `${index + 1}. ${line}`).join("\n") : request.lines[0] || "";
    // The text first and the template last: small models follow what they read last.
    return [
        title ? `${format.work}: ${title}\n` : "",
        format.head(many),
        "",
        body,
        "",
        prompt.detail === "brief" ? format.brief(source, many) : format.detailed(source, many),
    ].filter((part, index) => part !== "" || index > 0).join("\n");
};

// ---------------------------------------------------------------------------
// Tab memory: names and terms of a work that every explanation in that tab uses.
// ---------------------------------------------------------------------------

export type AiMemoryItem = { id: string; term: string; reading?: string; note: string; auto?: boolean };

const MEMORY_LABEL: Record<AiExplainLanguage, string> = {
    ru: "Что уже известно об этом произведении (имена, места, термины). Используй это, когда объясняешь, и называй персонажей так же:",
    uk: "Що вже відомо про цей твір (імена, місця, терміни). Використовуй це, коли пояснюєш, і називай персонажів так само:",
    ja: "この作品について、わかっていること（名前・場所・ことば）。説明するときに使ってください：",
    en: "What is already known about this work (names, places, terms). Use it when explaining and call the characters the same way:",
};

/** The memory block appended to a tab chat's system prompt (newest entries win when it's long). */
export const aiMemoryPrompt = (items: AiMemoryItem[], language: AiExplainLanguage, limit = 60) => {
    const usable = items.filter((item) => item.term.trim()).slice(0, limit);
    if (!usable.length) return "";
    const lines = usable.map((item) => `- ${item.term.trim()}${item.reading?.trim() ? `（${item.reading.trim()}）` : ""}${item.note.trim() ? ` — ${item.note.trim()}` : ""}`);
    return `${MEMORY_LABEL[language]}\n${lines.join("\n")}`;
};

const NOTE_LANGUAGE: Record<AiExplainLanguage, string> = { ru: "Russian", uk: "Ukrainian", ja: "simple Japanese", en: "English" };

export const AI_MEMORY_SYSTEM = "You extract proper names and special terms from fiction. You answer with a JSON array only, without any other text.";

/** Asks the model for the names and terms in some explained lines. */
export const aiMemoryExtractPrompt = (title: string, passages: string[], known: string[], language: AiExplainLanguage) => [
    `Below are lines${title.trim() ? ` from "${title.trim()}"` : ""} with explanations.`,
    "List the character names, nicknames, places, organizations and special terms of this story that appear in them. Skip ordinary words and generic titles like 先生 or 神父 unless they are used as a name.",
    known.length ? `Already known, do not repeat: ${known.join(", ")}` : "",
    `Answer with a JSON array only: [{"term": "the name exactly as written in the original text", "reading": "reading in hiragana for Japanese, otherwise empty", "note": "who or what it is, in ${NOTE_LANGUAGE[language]}, under 12 words"}]`,
    "If there is nothing new, answer [].",
    "",
    "Text:",
    passages.join("\n\n"),
].filter(Boolean).join("\n");

/** Reads the model's JSON answer, tolerating code fences and chatter around it. */
export const parseAiMemoryItems = (text: string): Array<{ term: string; reading: string; note: string }> => {
    const start = text.indexOf("[");
    const end = text.lastIndexOf("]");
    if (start < 0 || end <= start) return [];
    try {
        const data = JSON.parse(text.slice(start, end + 1));
        if (!Array.isArray(data)) return [];
        return data
            .filter((item) => item && typeof item.term === "string" && item.term.trim())
            .map((item) => ({
                term: String(item.term).trim().slice(0, 60),
                reading: typeof item.reading === "string" ? item.reading.trim().slice(0, 60) : "",
                note: typeof item.note === "string" ? item.note.trim().slice(0, 160) : "",
            }));
    } catch {
        return [];
    }
};
