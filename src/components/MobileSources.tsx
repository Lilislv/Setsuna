import { useState } from "react";
import { addWsSource, removeWsSource, updateWsSource, type WsSource } from "../utils/mobileSources";

// Phone settings → Text source: every saved WebSocket source with its own
// switch, a main source, editing and removal. Connecting/disconnecting is done
// by AppLayout (native background service vs. in-app socket).

export type SourceState = "on" | "pending" | "off";

type Props = {
    isEn: boolean;
    sources: WsSource[];
    primaryId: string;
    stateOf: (id: string) => SourceState;
    /** Error text of one source (native service), if any. */
    errorOf: (id: string) => string;
    /** True when this source is held by the Android background service. */
    isBackground: (id: string) => boolean;
    hasBackgroundService: boolean;
    onChange: (patch: { websockets?: WsSource[]; primaryWebSocketId?: string }) => void;
    onConnect: (id: string, sources?: WsSource[]) => void;
    onDisconnect: (id: string) => void;
};

export default function MobileSources({ isEn, sources, primaryId, stateOf, errorOf, isBackground, hasBackgroundService, onChange, onConnect, onDisconnect }: Props) {
    const L = (en: string, ru: string) => (isEn ? en : ru);
    const [adding, setAdding] = useState(sources.length === 0);
    const [draftName, setDraftName] = useState("");
    const [draftUrl, setDraftUrl] = useState("");
    const [editingId, setEditingId] = useState<string | null>(null);
    const [editName, setEditName] = useState("");
    const [editUrl, setEditUrl] = useState("");
    const [confirmRemove, setConfirmRemove] = useState<string | null>(null);

    const add = (connect: boolean) => {
        if (!draftUrl.trim()) return;
        const result = addWsSource(sources, draftUrl, draftName);
        const patch: { websockets: WsSource[]; primaryWebSocketId?: string } = { websockets: result.list };
        if (!primaryId || !sources.some((source) => source.id === primaryId)) patch.primaryWebSocketId = result.id;
        onChange(patch);
        if (connect) onConnect(result.id, result.list);
        setDraftName("");
        setDraftUrl("");
        setAdding(false);
    };

    const startEdit = (source: WsSource) => {
        setEditingId(source.id);
        setEditName(source.name);
        setEditUrl(source.url);
    };

    const saveEdit = () => {
        if (!editingId || !editUrl.trim()) return;
        const before = sources.find((source) => source.id === editingId);
        const list = updateWsSource(sources, editingId, { name: editName, url: editUrl });
        onChange({ websockets: list });
        // A new address only takes effect on a fresh connection.
        if (before && before.url !== list.find((source) => source.id === editingId)?.url && stateOf(editingId) !== "off") {
            onDisconnect(editingId);
            onConnect(editingId, list);
        }
        setEditingId(null);
    };

    const remove = (id: string) => {
        if (stateOf(id) !== "off") onDisconnect(id);
        const result = removeWsSource(sources, primaryId, id);
        onChange({ websockets: result.list, primaryWebSocketId: result.primaryId });
        setConfirmRemove(null);
    };

    const label = (state: SourceState, id: string) => {
        const error = errorOf(id);
        if (state === "on") return L("Receiving text", "Принимаю текст");
        if (state === "pending") return error || L("Connecting…", "Подключаюсь…");
        return L("Off", "Выключен");
    };

    return (
        <div className="mobile-settings-section m-sources">
            <div className="mobile-section-title">{L("Text sources", "Источники текста")}</div>
            <div className="mobile-settings-note">
                {L(
                    "A texthooker on a PC or Steam Deck (Agent, Textractor, LunaTranslator) sends lines over WebSocket on the same Wi-Fi. Add as many sources as you like and switch each one on or off.",
                    "Текстхукер на ПК или Steam Deck (Agent, Textractor, LunaTranslator) отправляет строки по WebSocket в той же сети Wi-Fi. Добавь сколько угодно источников и включай каждый отдельно.",
                )}
                {hasBackgroundService && (
                    <>
                        {" "}
                        {L(
                            "The main source (★) keeps receiving in the background; the others work while Setsuna is open.",
                            "Основной источник (★) принимает текст и в фоне, остальные — пока Setsuna открыта.",
                        )}
                    </>
                )}
            </div>

            {sources.length > 0 && (
                <div className="m-source-list">
                    {sources.map((source) => {
                        const state = stateOf(source.id);
                        const isPrimary = source.id === primaryId;
                        if (editingId === source.id) {
                            return (
                                <div key={source.id} className="m-source-item is-editing">
                                    <label className="m-source-field">
                                        <span>{L("Name", "Название")}</span>
                                        <input type="text" value={editName} onChange={(e) => setEditName(e.target.value)} placeholder={L("PC, Steam Deck…", "ПК, Steam Deck…")} />
                                    </label>
                                    <label className="m-source-field">
                                        <span>{L("Address", "Адрес")}</span>
                                        <input type="text" inputMode="url" autoCapitalize="none" autoCorrect="off" spellCheck={false} value={editUrl} onChange={(e) => setEditUrl(e.target.value)} placeholder="ws://192.168.0.40:9003" />
                                    </label>
                                    <div className="mobile-settings-actions two">
                                        <button type="button" className="mobile-action primary" disabled={!editUrl.trim()} onClick={saveEdit}>{L("Save", "Сохранить")}</button>
                                        <button type="button" className="mobile-action" onClick={() => setEditingId(null)}>{L("Cancel", "Отмена")}</button>
                                    </div>
                                </div>
                            );
                        }
                        return (
                            <div key={source.id} className={`m-source-item is-${state}`}>
                                <div className="m-source-main">
                                    <span className={`mobile-ws-dot ${state}`} aria-hidden="true" />
                                    <div className="m-source-text">
                                        <strong>
                                            {source.name || source.url}
                                            {isPrimary && <span className="m-source-primary" title={L("Main source", "Основной источник")}>★</span>}
                                        </strong>
                                        <small>{source.url}</small>
                                        <small className={`m-source-state is-${state}`}>
                                            {label(state, source.id)}
                                            {state !== "off" && isBackground(source.id) ? L(" · in background", " · в фоне") : ""}
                                        </small>
                                    </div>
                                    <label className="mobile-overlay-toggle" aria-label={state === "off" ? L("Connect", "Подключить") : L("Disconnect", "Отключить")}>
                                        <input
                                            type="checkbox"
                                            checked={state !== "off"}
                                            onChange={(e) => (e.target.checked ? onConnect(source.id) : onDisconnect(source.id))}
                                        />
                                        <span />
                                    </label>
                                </div>
                                {confirmRemove === source.id ? (
                                    <div className="m-source-actions">
                                        <span className="m-source-confirm">{L("Remove this source?", "Удалить источник?")}</span>
                                        <button type="button" className="m-source-btn danger" onClick={() => remove(source.id)}>{L("Remove", "Удалить")}</button>
                                        <button type="button" className="m-source-btn" onClick={() => setConfirmRemove(null)}>{L("Cancel", "Отмена")}</button>
                                    </div>
                                ) : (
                                    <div className="m-source-actions">
                                        {!isPrimary && (
                                            <button type="button" className="m-source-btn" title={L("Make this the main source", "Сделать основным источником")} onClick={() => onChange({ primaryWebSocketId: source.id })}>
                                                ★ {L("Main", "Основной")}
                                            </button>
                                        )}
                                        <button type="button" className="m-source-btn" onClick={() => startEdit(source)}>✎ {L("Edit", "Изменить")}</button>
                                        <button type="button" className="m-source-btn danger" onClick={() => setConfirmRemove(source.id)}>{L("Remove", "Удалить")}</button>
                                    </div>
                                )}
                            </div>
                        );
                    })}
                </div>
            )}

            {adding ? (
                <div className="m-source-item is-editing">
                    <label className="m-source-field">
                        <span>{L("Address", "Адрес")}</span>
                        <input type="text" inputMode="url" autoCapitalize="none" autoCorrect="off" spellCheck={false} value={draftUrl} onChange={(e) => setDraftUrl(e.target.value)} placeholder="ws://192.168.0.40:9003" />
                    </label>
                    <label className="m-source-field">
                        <span>{L("Name (optional)", "Название (необязательно)")}</span>
                        <input type="text" value={draftName} onChange={(e) => setDraftName(e.target.value)} placeholder={L("PC, Steam Deck…", "ПК, Steam Deck…")} />
                    </label>
                    <div className="mobile-settings-actions two">
                        <button type="button" className="mobile-action primary" disabled={!draftUrl.trim()} onClick={() => add(true)}>{L("Add and connect", "Добавить и подключить")}</button>
                        <button type="button" className="mobile-action" disabled={!draftUrl.trim() && sources.length === 0} onClick={() => (draftUrl.trim() ? add(false) : setAdding(false))}>
                            {draftUrl.trim() ? L("Just add", "Только добавить") : L("Cancel", "Отмена")}
                        </button>
                    </div>
                </div>
            ) : (
                <button type="button" className="mobile-action" data-coach="m-source-add" onClick={() => setAdding(true)}>+ {L("Add a source by address", "Добавить источник по адресу")}</button>
            )}
        </div>
    );
}
