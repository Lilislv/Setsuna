import { useEffect, useRef, useState } from "react";
import type { Tab } from "../utils/constants";
import { normalizeRoomCode } from "../utils/sharedReading";
import type { ShareStatus } from "../utils/useSharedReading";
import "./SharedReadingDialog.css";

// Shared reading: start a broadcast of a tab, see its code and viewers, or join
// someone else's room by code.

interface SharedReadingDialogProps {
    open: boolean;
    tab: Tab | null;
    status: ShareStatus | undefined;
    en: boolean;
    onStart: (tabId: number) => Promise<string>;
    onStop: (tabId: number) => void;
    onJoin: (code: string) => Promise<void>;
    onKeep: (tabId: number) => void;
    onLeave: (tabId: number) => void;
    onClose: () => void;
}

/** Why the room can't work, in plain words (PeerJS error types). */
export const describePeerError = (type: string | undefined, en: boolean) => {
    if (!type) return "";
    const L = (english: string, russian: string) => (en ? english : russian);
    switch (type) {
        case "network":
        case "socket-error":
        case "socket-closed":
        case "server-error":
            return L(
                `Can't reach the PeerJS server (0.peerjs.com), it may be blocked on this network. Try a VPN or another network. [${type}]`,
                `Не получается достучаться до сервера PeerJS (0.peerjs.com), похоже, его блокирует провайдер или сеть. Попробуй с VPN или другой сетью. [${type}]`,
            );
        case "unavailable-id":
            return L(
                `The code is still held by the previous launch; it frees up within a minute. [${type}]`,
                `Код ещё занят прошлым запуском, он освободится в течение минуты. [${type}]`,
            );
        case "browser-incompatible":
            return L(`This system's web view has no WebRTC. [${type}]`, `Встроенный браузер этой системы не поддерживает WebRTC. [${type}]`);
        case "relays":
            return L(
                "None of the public relays used to find each other is reachable from this network. Try a VPN or another network. [relays]",
                "Из этой сети не открывается ни один из публичных серверов, через которые вы находите друг друга. Попробуй с VPN или другой сетью. [relays]",
            );
        case "webrtc":
            return L(
                "The direct connection to the host failed, the network may block it. A VPN on one side often helps. [webrtc]",
                "Прямое соединение с хостом не получилось, его может блокировать сеть. Часто помогает VPN у одного из вас. [webrtc]",
            );
        default:
            return `[${type}]`;
    }
};

const formatCodeInput = (value: string) => {
    const raw = value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6);
    return raw.length > 3 ? `${raw.slice(0, 3)}-${raw.slice(3)}` : raw;
};

export default function SharedReadingDialog({ open, tab, status, en, onStart, onStop, onJoin, onKeep, onLeave, onClose }: SharedReadingDialogProps) {
    const [busy, setBusy] = useState<"start" | "join" | null>(null);
    const [error, setError] = useState("");
    const [code, setCode] = useState("");
    const [copied, setCopied] = useState(false);
    const codeRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        if (!open) return;
        setError("");
        setBusy(null);
        setCopied(false);
        const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [open, onClose]);

    if (!open) return null;

    const share = tab?.shared;
    const L = (english: string, russian: string) => (en ? english : russian);

    const start = async () => {
        if (!tab) return;
        setBusy("start");
        setError("");
        try {
            await onStart(tab.id);
        } catch (e) {
            setError(L("Could not start: ", "Не удалось начать: ") + String((e as Error)?.message || e));
        } finally {
            setBusy(null);
        }
    };

    const join = async () => {
        const normalized = normalizeRoomCode(code);
        if (!normalized) {
            setError(L("The code looks like ABC-123.", "Код выглядит так: ABC-123."));
            codeRef.current?.focus();
            return;
        }
        setBusy("join");
        setError("");
        try {
            await onJoin(normalized);
            setCode("");
            onClose();
        } catch (e) {
            const message = String((e as Error)?.message || e);
            setError(message === "not-found"
                ? L("No host with this code is online. Check the code: the host's Setsuna must be open with the broadcast on.", "Хост с таким кодом не в сети. Проверь код: у хоста должна быть открыта Сецуна с включённым эфиром.")
                : message === "timeout"
                    ? L("Could not reach the host, the network may be in the way. Try again.", "Не удалось соединиться с хостом, возможно, мешает сеть. Попробуй ещё раз.")
                    : message.startsWith("peer:")
                        ? describePeerError(message.slice(5), en)
                        : L("Could not join: ", "Не удалось подключиться: ") + message);
        } finally {
            setBusy(null);
        }
    };

    const copyCode = async () => {
        if (!share) return;
        try {
            await navigator.clipboard.writeText(share.code);
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1800);
        } catch { /* ignore */ }
    };

    const connection = status?.state || "connecting";
    const connectionLabel = connection === "live"
        ? L("On air", "В эфире")
        : connection === "ended"
            ? L("Ended", "Эфир завершён")
            : connection === "offline"
                ? L("No connection, retrying…", "Нет связи, переподключаюсь…")
                : L("Connecting…", "Подключаюсь…");

    return (
        <div className="srd-backdrop" onClick={onClose}>
            <div className="srd" role="dialog" aria-label={L("Shared reading", "Совместное чтение")} onClick={(e) => e.stopPropagation()}>
                <header className="srd-head">
                    <div className="srd-title">{L("Shared reading", "Совместное чтение")}</div>
                    <button type="button" className="srd-close" onClick={onClose} aria-label={L("Close", "Закрыть")}>
                        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M18 6 6 18" /><path d="m6 6 12 12" /></svg>
                    </button>
                </header>

                {tab && share?.role === "host" && (
                    <section className="srd-card is-live">
                        <div className="srd-label">{L("Broadcasting", "Транслируется")} «{tab.name}»</div>
                        <button type="button" className="srd-code" onClick={copyCode} title={L("Copy the code", "Скопировать код")}>
                            <span>{share.code}</span>
                            <small>{copied ? L("Copied", "Скопировано") : L("Copy", "Копировать")}</small>
                        </button>
                        <div className="srd-status">
                            <span className={`srd-dot is-${connection}`} aria-hidden="true" />
                            {connectionLabel}
                            {connection === "live" && <span className="srd-muted"> · {L("viewers", "зрителей")}: {status?.viewers ?? 0}</span>}
                        </div>
                        {connection !== "live" && status?.error && <div className="srd-reason">{describePeerError(status.error, en)}</div>}
                        <p className="srd-hint">{L("Send the code to friends: in Setsuna they open Read together and enter it. Lines go straight from your Setsuna to theirs, so keep it open while you read.", "Отправь код друзьям: в Сецуне они открывают «Читать вместе» и вводят его. Строки идут напрямую из твоей Сецуны к ним, поэтому держи её открытой, пока читаете.")}</p>
                        <div className="srd-actions">
                            <button type="button" className="srd-btn is-danger" onClick={() => onStop(tab.id)}>{L("End broadcast", "Завершить эфир")}</button>
                        </div>
                    </section>
                )}

                {tab && share?.role === "viewer" && (
                    <section className="srd-card is-viewer">
                        <div className="srd-label">{L("You follow", "Ты смотришь")} «{tab.name}» · {share.code}</div>
                        <div className="srd-status">
                            <span className={`srd-dot is-${share.ended ? "ended" : status?.hostOnline ? "live" : connection === "live" ? "away" : connection}`} aria-hidden="true" />
                            {share.ended
                                ? L("The host ended the broadcast", "Хост завершил эфир")
                                : connection === "offline" ? L("The host is away, waiting for them. The text is kept.", "Хост не в сети, жду его. Текст сохранён.")
                                : connection === "connecting" ? L("Looking for the host…", "Ищу хоста…")
                                : connection !== "live" ? connectionLabel
                                    : status?.hostOnline ? L("The host is online", "Хост в сети") : L("The host is away, the text is kept", "Хост не в сети, текст сохранён")}
                        </div>
                        {!share.ended && status?.error && <div className="srd-reason">{describePeerError(status.error, en)}</div>}
                        <p className="srd-hint">{L("The tab is read-only. Look words up and add cards as usual. Keep it to make it your own tab.", "Вкладка только для чтения. Ищи слова и добавляй карточки как обычно. «Сохранить себе» сделает её твоей обычной вкладкой.")}</p>
                        <div className="srd-actions">
                            <button type="button" className="srd-btn is-primary" onClick={() => { onKeep(tab.id); onClose(); }}>{L("Keep a copy", "Сохранить себе")}</button>
                            <button type="button" className="srd-btn is-danger" onClick={() => { onLeave(tab.id); onClose(); }}>{L("Leave", "Выйти")}</button>
                        </div>
                    </section>
                )}

                {tab && !share && !tab.archived && (!tab.mode || tab.mode === "text") && (
                    <section className="srd-card">
                        <div className="srd-label">{L("Broadcast this tab", "Транслировать эту вкладку")}</div>
                        <p className="srd-hint">{L(`Friends will see “${tab.name}” live and look words up in their own Setsuna with their own dictionaries.`, `Друзья увидят «${tab.name}» вживую и смогут искать слова в своей Сецуне, со своими словарями.`)}</p>
                        <div className="srd-actions">
                            <button type="button" className="srd-btn is-primary" disabled={busy !== null} onClick={() => void start()}>
                                {busy === "start" ? L("Starting…", "Запускаю…") : L("Start broadcast", "Начать эфир")}
                            </button>
                        </div>
                    </section>
                )}

                <section className="srd-join">
                    <div className="srd-label">{L("Join a broadcast", "Присоединиться к эфиру")}</div>
                    <div className="srd-join-row">
                        <input
                            ref={codeRef}
                            className="srd-input"
                            value={code}
                            onChange={(e) => setCode(formatCodeInput(e.target.value))}
                            onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Enter") void join(); if (e.key === "Escape") onClose(); }}
                            placeholder="ABC-123"
                            spellCheck={false}
                            autoComplete="off"
                        />
                        <button type="button" className="srd-btn is-primary" disabled={busy !== null || code.replace("-", "").length < 6} onClick={() => void join()}>
                            {busy === "join" ? L("Joining…", "Подключаюсь…") : L("Join", "Войти")}
                        </button>
                    </div>
                </section>

                {error && <div className="srd-error">{error}</div>}

                <p className="srd-foot">
                    {L("Lines go directly between computers (WebRTC) and are not stored anywhere. Public Nostr relays only help you find each other; the connection details are encrypted with the code.", "Строки идут напрямую между компьютерами (WebRTC) и нигде не хранятся. Публичные Nostr-серверы только помогают найти друг друга, данные для соединения зашифрованы кодом.")}
                </p>
            </div>
        </div>
    );
}
