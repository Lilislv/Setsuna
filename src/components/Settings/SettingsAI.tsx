import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import type { AppSettings } from "../SettingsModal";
import {
    AI_DEFAULT_MODEL,
    aiModelReady,
    fetchAiStatus,
    formatBytes,
    readAiPromptSettings,
    type AiDownloadEvent,
    type AiStatus,
} from "../../utils/aiAssistant";

interface SettingsAIProps {
    settings: AppSettings;
    updateSetting: <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => void;
    highlighted: boolean;
}

const stageLabel = (stage: AiDownloadEvent["stage"], en: boolean) => {
    switch (stage) {
        case "runtime": return en ? "Downloading llama.cpp" : "Скачиваю llama.cpp";
        case "model": return en ? "Downloading the model" : "Скачиваю модель";
        case "verify": return en ? "Checking the file" : "Проверяю файл";
        case "extract": return en ? "Unpacking" : "Распаковываю";
        case "move": return en ? "Moving the model" : "Переношу модель";
        default: return "";
    }
};

export default function SettingsAI({ settings, updateSetting, highlighted }: SettingsAIProps) {
    const en = settings.appLanguage === "en";
    const modelId = settings.aiModel || AI_DEFAULT_MODEL;
    const [status, setStatus] = useState<AiStatus | null>(null);
    const [progress, setProgress] = useState<AiDownloadEvent | null>(null);
    const [error, setError] = useState("");
    const [moving, setMoving] = useState(false);
    const prompt = readAiPromptSettings(settings);
    const [customDraft, setCustomDraft] = useState(settings.aiCustomPrompt || "");
    const customTimer = useRef<number | null>(null);
    useEffect(() => { setCustomDraft(settings.aiCustomPrompt || ""); }, [settings.aiCustomPrompt]);
    const commitCustom = (value: string) => {
        if (customTimer.current) window.clearTimeout(customTimer.current);
        customTimer.current = null;
        if (value !== (settings.aiCustomPrompt || "")) updateSetting("aiCustomPrompt", value);
    };
    const changeCustom = (value: string) => {
        setCustomDraft(value);
        if (customTimer.current) window.clearTimeout(customTimer.current);
        customTimer.current = window.setTimeout(() => commitCustom(value), 600);
    };

    const refresh = useCallback(() => {
        fetchAiStatus().then(setStatus).catch((e) => setError(String(e)));
    }, []);

    useEffect(() => {
        refresh();
        let unlisten: (() => void) | undefined;
        let disposed = false;
        listen<AiDownloadEvent>("ai://download", (event) => {
            const payload = event.payload;
            if (payload.stage === "done" || payload.stage === "cancelled" || payload.stage === "error" || payload.stage === "moved") {
                setProgress(null);
                if (payload.stage === "error") setError(payload.error || (en ? "Download failed" : "Не удалось скачать"));
                refresh();
            } else {
                setProgress(payload);
            }
        }).then((fn) => {
            if (disposed) fn();
            else unlisten = fn;
        });
        return () => {
            disposed = true;
            unlisten?.();
        };
    }, [refresh, en]);

    const model = status?.models.find((m) => m.id === modelId);
    const ready = aiModelReady(status, modelId);
    const downloading = Boolean(progress) || Boolean(status?.downloading);

    const startDownload = () => {
        setError("");
        setProgress({ stage: "runtime", received: 0, total: 0 });
        invoke("ai_download_model", { modelId })
            .then(() => window.dispatchEvent(new CustomEvent("setsuna:ai-status-changed")))
            .catch(() => {});
    };

    const remove = () => {
        const ok = window.confirm(en
            ? `Delete ${model?.name || "the model"} (${formatBytes(model?.sizeBytes || 0)})?`
            : `Удалить ${model?.name || "модель"} (${formatBytes(model?.sizeBytes || 0)})?`);
        if (!ok) return;
        invoke("ai_delete_model", { modelId })
            .then(() => {
                window.dispatchEvent(new CustomEvent("setsuna:ai-status-changed"));
                refresh();
            })
            .catch((e) => setError(String(e)));
    };

    const chooseFolder = async (useDefault: boolean) => {
        let dir: string | null = null;
        if (!useDefault) {
            const picked = await openDialog({ directory: true, multiple: false, defaultPath: status?.modelsDir || undefined, title: en ? "Folder for AI models" : "Папка для моделей ИИ" });
            if (!picked || Array.isArray(picked)) return;
            dir = picked;
        }
        setError("");
        setMoving(true);
        try {
            await invoke<string>("ai_set_models_dir", { dir });
            window.dispatchEvent(new CustomEvent("setsuna:ai-status-changed"));
        } catch (e) {
            setError(String(e));
        } finally {
            setMoving(false);
            setProgress(null);
            refresh();
        }
    };
    const customFolder = Boolean(status && status.modelsDir && status.defaultModelsDir && status.modelsDir !== status.defaultModelsDir);

    const percent = progress && progress.total > 0 ? Math.min(100, (progress.received / progress.total) * 100) : 0;

    return (
        <div className="tab-content-anim">
            <div id="ai-main" className={`modern-card ${highlighted ? "card-highlighted" : ""}`} style={{ background: "var(--bg-panel)", border: "1px solid var(--border-main)" }}>
                <div className="card-label" style={{ color: "var(--text-main)", display: "flex", alignItems: "center", gap: 8 }}>
                    {en ? "AI explanations" : "ИИ-объяснения"}
                    <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: 0.4, padding: "2px 6px", borderRadius: 999, background: "rgba(245, 158, 11, 0.16)", color: "#f59e0b" }}>
                        {en ? "TEST" : "ТЕСТ"}
                    </span>
                </div>
                <div style={{ color: "var(--text-muted)", fontSize: 12, lineHeight: 1.55, marginBottom: 10 }}>
                    {en
                        ? "A local neural network explains Japanese and English lines in your language: translation, meaning and key grammar. It runs on your computer without the internet and is downloaded separately."
                        : "Локальная нейросеть объясняет японские и английские строки на твоём языке: перевод, смысл и ключевую грамматику. Работает на твоём компьютере без интернета и скачивается отдельно."}
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 11px", marginBottom: 16, borderRadius: 8, background: "rgba(245, 158, 11, 0.1)", border: "1px solid rgba(245, 158, 11, 0.28)", fontSize: 12, color: "#fbbf24", lineHeight: 1.45 }}>
                    {en
                        ? "Experimental test feature — may not make it into the final release or may change significantly."
                        : "Экспериментальная тестовая функция — может не добраться до финального релиза или сильно измениться."}
                </div>

                {status && !status.supported ? (
                    <div style={{ color: "var(--text-muted)", fontSize: 13 }}>
                        {en ? "Not available on this platform yet. For now it works on Windows and Linux." : "На этой платформе пока недоступно. Сейчас работает на Windows и Linux."}
                    </div>
                ) : (
                    <>
                        <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 14px", border: "1px solid var(--border-main)", borderRadius: 10, background: "var(--bg-main)", marginBottom: 14 }}>
                            <div style={{ flex: 1, minWidth: 0 }}>
                                <div style={{ color: "var(--text-main)", fontSize: 14, fontWeight: 600 }}>{model?.name || "Gemma 4 E4B"}</div>
                                <div style={{ color: "var(--text-muted)", fontSize: 12, marginTop: 2 }}>
                                    {progress && (downloading || moving) && (progress.stage === "move" || !ready)
                                        ? `${stageLabel(progress.stage, en)}${progress.total > 0 ? ` · ${formatBytes(progress.received)} / ${formatBytes(progress.total)}` : ""}`
                                        : ready
                                        ? (en ? `Ready · ${formatBytes(model?.sizeBytes || 0)} on disk` : `Готова · ${formatBytes(model?.sizeBytes || 0)} на диске`)
                                        : downloading && progress
                                            ? `${stageLabel(progress.stage, en)}${progress.total > 0 ? ` · ${formatBytes(progress.received)} / ${formatBytes(progress.total)}` : ""}`
                                            : (en
                                                ? `${formatBytes(model?.sizeBytes || 4977171584)} · about 5 GB of RAM or video memory while it works`
                                                : `${formatBytes(model?.sizeBytes || 4977171584)} · во время работы занимает около 5 ГБ памяти или видеопамяти`)}
                                </div>
                                {(downloading || (moving && progress)) && (
                                    <div style={{ marginTop: 8, height: 4, borderRadius: 4, background: "var(--border-main)", overflow: "hidden" }}>
                                        <div style={{ width: `${percent}%`, height: "100%", background: "var(--accent-blue)", transition: "width 0.25s" }} />
                                    </div>
                                )}
                            </div>
                            {moving ? null : ready ? (
                                <button type="button" className="btn-primary" onClick={remove} style={{ background: "transparent", border: "1px solid var(--border-main)", color: "#ff6b6b" }}>
                                    {en ? "Delete" : "Удалить"}
                                </button>
                            ) : downloading ? (
                                <button type="button" className="btn-primary" onClick={() => invoke("ai_cancel_download").catch(() => {})} style={{ background: "transparent", border: "1px solid var(--border-main)", color: "var(--text-main)" }}>
                                    {en ? "Cancel" : "Отмена"}
                                </button>
                            ) : (
                                <button type="button" className="btn-primary" onClick={startDownload}>
                                    {(model?.partialBytes || 0) > 0 ? (en ? "Resume" : "Продолжить") : (en ? "Download" : "Скачать")}
                                </button>
                            )}
                        </div>

                        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
                            <div style={{ flex: 1, minWidth: 0 }}>
                                <div style={{ color: "var(--text-muted)", fontSize: 12 }}>{en ? "Model folder" : "Папка модели"}</div>
                                <div title={status?.modelsDir || ""} style={{ color: "var(--text-main)", fontSize: 12.5, marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                                    {status?.modelsDir || "…"}
                                </div>
                            </div>
                            {customFolder && (
                                <button type="button" className="btn-secondary" disabled={moving || downloading} onClick={() => void chooseFolder(true)}>
                                    {en ? "Default" : "По умолчанию"}
                                </button>
                            )}
                            <button type="button" className="btn-secondary" disabled={moving || downloading} onClick={() => void chooseFolder(false)}>
                                {moving ? (en ? "Moving…" : "Переношу…") : (en ? "Change…" : "Изменить…")}
                            </button>
                        </div>
                        <div style={{ color: "var(--text-muted)", fontSize: 11.5, lineHeight: 1.5, marginBottom: 18 }}>
                            {en
                                ? "Any folder on your PC, for example on a bigger drive. An already downloaded model is moved there."
                                : "Любая папка на компьютере, например на диске побольше. Уже скачанная модель переедет туда."}
                        </div>

                        {error && (
                            <div style={{ color: "#ff8a8a", fontSize: 12, marginBottom: 14, whiteSpace: "pre-wrap" }}>{error}</div>
                        )}

                        <div className="card-label" style={{ color: "var(--text-main)", marginTop: 4 }}>{en ? "How to explain" : "Как объяснять"}</div>
                        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "12px 16px", alignItems: "end" }}>
                            <label style={{ color: "var(--text-muted)", fontSize: 12 }}>
                                {en ? "Explain in" : "Язык объяснения"}
                                <select className="modern-select" value={prompt.explainLanguage} onChange={(e) => updateSetting("aiExplainLanguage", e.target.value as AppSettings["aiExplainLanguage"])} style={{ marginTop: 6 }}>
                                    <option value="ru">Русский</option>
                                    <option value="uk">Українська</option>
                                    <option value="ja">{en ? "日本語 (easy Japanese)" : "日本語 (простой японский)"}</option>
                                    <option value="en">English</option>
                                </select>
                            </label>
                            <label style={{ color: "var(--text-muted)", fontSize: 12 }}>
                                {en ? "Text language" : "Язык текста"}
                                <select className="modern-select" value={prompt.sourceLanguage} onChange={(e) => updateSetting("aiSourceLanguage", e.target.value as AppSettings["aiSourceLanguage"])} style={{ marginTop: 6 }}>
                                    <option value="auto">{en ? "Detect" : "Определять"}</option>
                                    <option value="ja">{en ? "Japanese" : "Японский"}</option>
                                    <option value="en">{en ? "English (early alpha)" : "Английский (ранняя альфа)"}</option>
                                </select>
                            </label>
                            <label style={{ color: "var(--text-muted)", fontSize: 12 }}>
                                {en ? "Explanation" : "Объяснение"}
                                <select className="modern-select" value={prompt.detail} onChange={(e) => updateSetting("aiDetail", e.target.value as AppSettings["aiDetail"])} style={{ marginTop: 6 }}>
                                    <option value="detailed">{en ? "Detailed" : "Подробное"}</option>
                                    <option value="brief">{en ? "Brief" : "Краткое"}</option>
                                </select>
                            </label>
                            <label style={{ gridColumn: "1 / -1", color: "var(--text-muted)", fontSize: 12 }}>
                                {en ? "Your own instructions (optional)" : "Свои указания (необязательно)"}
                                <textarea
                                    className="modern-input"
                                    value={customDraft}
                                    rows={3}
                                    maxLength={2000}
                                    onChange={(e) => changeCustom(e.target.value)}
                                    onBlur={(e) => commitCustom(e.target.value)}
                                    placeholder={en
                                        ? "For example: I'm around JLPT N3, explain keigo in detail, add a casual version of the phrase."
                                        : "Например: мой уровень около N3, подробно объясняй кэйго, добавляй разговорный вариант фразы."}
                                    style={{ marginTop: 6, width: "100%", minHeight: 74, resize: "vertical", fontFamily: "inherit", lineHeight: 1.45, boxSizing: "border-box" }}
                                />
                            </label>
                            <label className="checkbox-label" style={{ gridColumn: "1 / -1", opacity: ready ? 1 : 0.5 }}>
                                <input type="checkbox" disabled={!ready} checked={settings.aiLineButtons !== false && ready} onChange={(e) => updateSetting("aiLineButtons", e.target.checked)} />
                                {en ? "Show the explain buttons next to lines in the reader" : "Показывать кнопки объяснения у строк в читалке"}
                            </label>
                            <button type="button" className="btn-primary" disabled={!ready} onClick={() => window.dispatchEvent(new CustomEvent("setsuna:open-ai-panel"))} style={{ gridColumn: "1 / -1", justifySelf: "start", padding: "9px 14px" }}>
                                {en ? "Open AI chat" : "Открыть чат с ИИ"}
                            </button>
                        </div>
                        <div style={{ color: "var(--text-muted)", fontSize: 11.5, lineHeight: 1.5, marginTop: 14 }}>
                            {en
                                ? "Hover a line: the sparkle button explains it, the checklist button lets you pick several lines to explain together. Answers open in the AI panel next to the text: every tab has its own chat with the whole history, and there is one general chat for any language question (the AI button in the top island)."
                                : "Наведи на строку: кнопка со звёздочкой объясняет её, кнопка со списком позволяет выбрать несколько строк и объяснить их вместе. Ответы открываются в панели ИИ справа от текста: у каждой вкладки свой чат со всей историей, плюс один общий чат для любых вопросов по языку (кнопка «ИИ» в верхнем островке)."}
                        </div>
                    </>
                )}
            </div>
        </div>
    );
}
