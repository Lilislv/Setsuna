import { useEffect, useRef, useState } from "react";
import { writeText as writeClipboardText } from "@tauri-apps/plugin-clipboard-manager";
import type { Tab } from "../utils/constants";
import { isMobilePlatform } from "../utils/platform";
import {
    RECENT_HISTORY_LINES,
    SHARED_PROFILE_COLORS,
    mergeSharedLines,
    normalizeRoomCode,
    type MemberActivity,
    type SharedHistoryMode,
    type SharedProfile,
} from "../utils/sharedReading";
import type { ShareStatus } from "../utils/useSharedReading";
import "./SharedReadingDialog.css";

// Shared reading: start a broadcast of a tab, see its code and viewers, or join
// someone else's room by code.

interface SharedReadingDialogProps {
    open: boolean;
    tab: Tab | null;
    status: ShareStatus | undefined;
    profile: SharedProfile;
    en: boolean;
    matchingSavedTab?: Tab | null;
    onUpdateProfile: (profile: SharedProfile) => void;
    onStart: (tabId: number, opts?: { historyMode?: SharedHistoryMode; shareScreenshots?: boolean }) => Promise<string>;
    onStop: (tabId: number) => void;
    onJoin: (code: string) => Promise<void>;
    onKeep: (tabId: number) => void;
    onMergeIntoSaved?: (viewerTabId: number, targetTabId: number) => void;
    onLeave: (tabId: number) => void;
    onSetLocked: (tabId: number, locked: boolean) => void;
    onSetShareScreenshots: (tabId: number, enabled: boolean) => void;
    onKick: (tabId: number, peerId: string) => void;
    onSetSyncTimer: (tabId: number, sync: boolean) => void;
    onClose: () => void;
}

/** Why the room can't work, in plain words (Nostr relay / WebRTC errors). */
export const describePeerError = (type: string | undefined, en: boolean) => {
    if (!type) return "";
    const L = (english: string, russian: string) => (en ? english : russian);
    switch (type) {
        case "network":
        case "socket-error":
        case "socket-closed":
        case "server-error":
        case "relays":
            return L(
                "None of the public Nostr relays used to find each other is reachable from this network. Try a VPN or another network. [relays]",
                "Из этой сети не открывается ни один из публичных Nostr-серверов, через которые вы находите друг друга. Попробуй с VPN или другой сетью. [relays]",
            );
        case "browser-incompatible":
            return L(
                `This web view has no WebRTC support. [${type}]`,
                `Встроенный браузер этой системы не поддерживает WebRTC. [${type}]`,
            );
        case "webrtc":
            return L(
                "The direct P2P WebRTC connection failed — a strict NAT or firewall may block it. A VPN on one side often helps. [webrtc]",
                "Прямое P2P-соединение WebRTC не получилось — мешает строгий NAT или провайдер. Часто помогает VPN у одного из вас. [webrtc]",
            );
        default:
            return `[${type}]`;
    }
};

const formatCodeInput = (value: string) => {
    const raw = value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6);
    return raw.length > 3 ? `${raw.slice(0, 3)}-${raw.slice(3)}` : raw;
};

const activityText = (activity: MemberActivity, en: boolean) => {
    switch (activity) {
        case "wait":
            return en ? "✋ asks to wait" : "✋ просит подождать";
        case "lookup":
            return en ? "🔍 looking up a word" : "🔍 смотрит слово";
        case "ready":
            return en ? "✓ ready" : "✓ готов";
        default:
            return en ? "reading" : "читает";
    }
};

export default function SharedReadingDialog({
    open,
    tab,
    status,
    profile,
    en,
    matchingSavedTab,
    onUpdateProfile,
    onStart,
    onStop,
    onJoin,
    onKeep,
    onMergeIntoSaved,
    onLeave,
    onSetLocked,
    onSetShareScreenshots,
    onKick,
    onSetSyncTimer,
    onClose,
}: SharedReadingDialogProps) {
    const isMobile = isMobilePlatform();
    const [busy, setBusy] = useState<"start" | "join" | null>(null);
    const [error, setError] = useState("");
    const [code, setCode] = useState("");
    const [copied, setCopied] = useState<"code" | "invite" | null>(null);
    const [historyMode, setHistoryMode] = useState<SharedHistoryMode>("recent");
    const [shareShots, setShareShots] = useState(() => !isMobile);
    const [nameInput, setNameInput] = useState(profile.name);
    const codeRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        if (!open) return;
        setError("");
        setBusy(null);
        setCopied(null);
        setNameInput(profile.name);
        const onKey = (event: KeyboardEvent) => {
            if (event.key === "Escape") onClose();
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [open, onClose, profile.name]);

    if (!open) return null;

    const share = tab?.shared;
    const L = (english: string, russian: string) => (en ? english : russian);

    const commitProfileName = () => {
        const trimmed = nameInput.trim().slice(0, 24);
        const nextName = trimmed || (en ? "Reader" : "Читатель");
        setNameInput(nextName);
        if (nextName !== profile.name) {
            onUpdateProfile({ ...profile, name: nextName });
        }
    };

    const start = async () => {
        if (!tab) return;
        commitProfileName();
        setBusy("start");
        setError("");
        try {
            await onStart(tab.id, { historyMode, shareScreenshots: isMobile ? false : shareShots });
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
        commitProfileName();
        setBusy("join");
        setError("");
        try {
            await onJoin(normalized);
            setCode("");
            onClose();
        } catch (e) {
            const message = String((e as Error)?.message || e);
            setError(
                message === "not-found"
                    ? L(
                          "No host with this code is online. Check the code: the host's Setsuna must be open with the broadcast on.",
                          "Хост с таким кодом не в сети. Проверь код: у хоста должна быть открыта Сецуна с включённым эфиром.",
                      )
                    : message === "timeout"
                      ? L(
                            "Could not reach the host, the network may be in the way. Try again.",
                            "Не удалось соединиться с хостом, возможно, мешает сеть. Попробуй ещё раз.",
                        )
                      : message.startsWith("peer:")
                        ? describePeerError(message.slice(5), en)
                        : L("Could not join: ", "Не удалось подключиться: ") + message,
            );
        } finally {
            setBusy(null);
        }
    };

    const copyText = async (text: string, kind: "code" | "invite") => {
        try {
            try {
                await writeClipboardText(text);
            } catch {
                await navigator.clipboard.writeText(text);
            }
            setCopied(kind);
            window.setTimeout(() => setCopied(null), 1800);
        } catch {
            /* ignore */
        }
    };

    const connection = status?.state || "connecting";
    const connectionLabel =
        connection === "live"
            ? L("On air", "В эфире")
            : connection === "ended"
              ? L("Ended", "Эфир завершён")
              : connection === "offline"
                ? L("No connection, retrying…", "Нет связи, переподключаюсь…")
                : L("Connecting…", "Подключаюсь…");

    const members = status?.members || [];
    const guestMembers = members.filter((m) => m.role === "viewer");
    const relays = status?.relays;

    return (
        <div className="srd-backdrop" onClick={onClose}>
            <div className="srd" role="dialog" aria-label={L("Shared reading", "Совместное чтение")} onClick={(e) => e.stopPropagation()}>
                <header className="srd-head">
                    <div className="srd-title">{L("Shared reading", "Совместное чтение")}</div>
                    <button type="button" className="srd-close" onClick={onClose} aria-label={L("Close", "Закрыть")}>
                        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                            <path d="M18 6 6 18" />
                            <path d="m6 6 12 12" />
                        </svg>
                    </button>
                </header>

                <section className="srd-profile">
                    <div className="srd-profile-top">
                        <span className="srd-label">{L("Your nickname", "Твоё имя в комнате")}</span>
                        <div className="srd-colors" role="radiogroup" aria-label={L("Badge color", "Цвет метки")}>
                            {SHARED_PROFILE_COLORS.map((color) => (
                                <button
                                    key={color}
                                    type="button"
                                    className={`srd-color-dot${profile.color.toLowerCase() === color ? " is-active" : ""}`}
                                    style={{ background: color }}
                                    onClick={() => onUpdateProfile({ ...profile, color })}
                                    aria-label={color}
                                />
                            ))}
                        </div>
                    </div>
                    <input
                        className="srd-name-input"
                        value={nameInput}
                        maxLength={24}
                        placeholder={L("Nickname", "Никнейм")}
                        onChange={(e) => setNameInput(e.target.value)}
                        onBlur={commitProfileName}
                        onKeyDown={(e) => {
                            e.stopPropagation();
                            if (e.key === "Enter") commitProfileName();
                        }}
                    />
                </section>

                {tab && share?.role === "host" && (
                    <section className="srd-card is-live">
                        <div className="srd-card-head-row">
                            <div className="srd-label">
                                {L("Broadcasting", "Транслируется")} «{tab.name}»
                            </div>
                            {relays && (
                                <span className="srd-relay-pill" title={L("Connected discovery relays", "Подключённые релеи")}>
                                    {L("Relays", "Релеи")}: {relays.open}/{relays.total}
                                </span>
                            )}
                        </div>
                        <button type="button" className="srd-code" onClick={() => void copyText(share.code, "code")} title={L("Copy the code", "Скопировать код")}>
                            <span>{share.code}</span>
                            <small>{copied === "code" ? L("Copied", "Скопировано") : L("Copy", "Копировать")}</small>
                        </button>
                        <div className="srd-status">
                            <span className={`srd-dot is-${connection}`} aria-hidden="true" />
                            {connectionLabel}
                            {connection === "live" && (
                                <span className="srd-muted">
                                    {" "}
                                    · {L("viewers", "участников")}: {guestMembers.length}
                                </span>
                            )}
                            {share.locked && <span className="srd-badge-warn">🔒 {L("Locked", "Вход закрыт")}</span>}
                        </div>
                        {connection !== "live" && status?.error && <div className="srd-reason">{describePeerError(status.error, en)}</div>}

                        <div className="srd-toggles">
                            {!isMobile && (
                                <label className="srd-toggle">
                                    <input
                                        type="checkbox"
                                        checked={share.shareScreenshots !== false}
                                        onChange={(e) => onSetShareScreenshots(tab.id, e.target.checked)}
                                    />
                                    <span>{L("Share game screenshots for friends' Anki cards", "Делиться скриншотами игры для Anki друзей")}</span>
                                </label>
                            )}
                            <label className="srd-toggle">
                                <input
                                    type="checkbox"
                                    checked={Boolean(share.locked)}
                                    onChange={(e) => onSetLocked(tab.id, e.target.checked)}
                                />
                                <span>{L("Lock room (block new joins)", "Закрыть вход по коду")}</span>
                            </label>
                        </div>

                        {guestMembers.length > 0 && (
                            <div className="srd-members">
                                <div className="srd-label">{L("In this room", "Сейчас в комнате")}</div>
                                {guestMembers.map((member) => (
                                    <div key={member.id} className="srd-member-row">
                                        <span className="srd-member-dot" style={{ background: member.color }} />
                                        <span className="srd-member-name">{member.name}</span>
                                        <span className={`srd-member-state is-${member.activity}`}>
                                            {activityText(member.activity, en)}
                                        </span>
                                        <button
                                            type="button"
                                            className="srd-kick-btn"
                                            onClick={() => onKick(tab.id, member.id)}
                                            title={L("Remove from room", "Исключить из комнаты")}
                                            aria-label={L("Remove from room", "Исключить из комнаты")}
                                        >
                                            ×
                                        </button>
                                    </div>
                                ))}
                            </div>
                        )}

                        <div className="srd-actions">
                            <button
                                type="button"
                                className="srd-btn"
                                onClick={() =>
                                    void copyText(
                                        en
                                            ? `Join me reading «${tab.name}» in Setsuna! Room code: ${share.code}`
                                            : `Читаем вместе «${tab.name}» в Сецуне! Код комнаты: ${share.code}`,
                                        "invite",
                                    )
                                }
                            >
                                {copied === "invite" ? L("Invite copied!", "Приглашение скопировано!") : L("Copy Discord invite", "Приглашение для Discord")}
                            </button>
                            <button type="button" className="srd-btn is-danger" onClick={() => onStop(tab.id)}>
                                {L("End broadcast", "Завершить эфир")}
                            </button>
                        </div>
                    </section>
                )}

                {tab && share?.role === "viewer" && (
                    <section className="srd-card is-viewer">
                        <div className="srd-card-head-row">
                            <div className="srd-label">
                                {L("You follow", "Ты смотришь")} «{tab.name}» · {share.code}
                            </div>
                            {relays && (
                                <span className="srd-relay-pill" title={L("Connected discovery relays", "Подключённые релеи")}>
                                    {L("Relays", "Релеи")}: {relays.open}/{relays.total}
                                </span>
                            )}
                        </div>
                        <div className="srd-status">
                            <span
                                className={`srd-dot is-${share.ended ? "ended" : status?.hostOnline ? "live" : connection === "live" ? "away" : connection}`}
                                aria-hidden="true"
                            />
                            {share.ended
                                ? status?.kickedReason === "kicked"
                                    ? L("The host removed you from the room", "Хост исключил тебя из комнаты")
                                    : status?.kickedReason === "locked"
                                      ? L("This room is locked by the host", "Вход в комнату закрыт хостом")
                                      : L("The host ended the broadcast", "Хост завершил эфир")
                                : connection === "offline"
                                  ? L("The host is away, waiting for them. The text is kept.", "Хост не в сети, жду его. Текст сохранён.")
                                  : connection === "connecting"
                                    ? L("Looking for the host…", "Ищу хоста…")
                                    : connection !== "live"
                                      ? connectionLabel
                                      : status?.hostOnline
                                        ? L(
                                              `${status.hostName || "Host"} is online`,
                                              `Хост (${status.hostName || "ведущий"}) в сети`,
                                          )
                                        : L("The host is away, the text is kept", "Хост не в сети, текст сохранён")}
                        </div>
                        {!share.ended && status?.error && <div className="srd-reason">{describePeerError(status.error, en)}</div>}

                        {!share.ended && (
                            <div className="srd-toggles">
                                <label className="srd-toggle">
                                    <input
                                        type="checkbox"
                                        checked={share.syncTimer !== false}
                                        onChange={(e) => onSetSyncTimer(tab.id, e.target.checked)}
                                    />
                                    <span>{L("Sync reading timer with host", "Синхронизировать таймер чтения с хостом")}</span>
                                </label>
                                <div className="srd-hint">
                                    {status?.shareScreenshots
                                        ? L("✓ Host shares game screenshots for your Anki cards.", "✓ Хост делится скриншотами игры для твоих карточек Anki.")
                                        : L("Host has Anki screenshot sharing disabled.", "У хоста отключена передача скриншотов для Anki.")}
                                </div>
                            </div>
                        )}

                        {!share.ended && members.length > 0 && (
                            <div className="srd-members">
                                <div className="srd-label">{L("In this room", "Сейчас в комнате")}</div>
                                {members.map((member) => (
                                    <div key={member.id} className="srd-member-row">
                                        <span className="srd-member-dot" style={{ background: member.color }} />
                                        <span className="srd-member-name">
                                            {member.name}
                                            {member.role === "host" ? ` (${L("host", "хост")})` : ""}
                                        </span>
                                        <span className={`srd-member-state is-${member.activity}`}>
                                            {activityText(member.activity, en)}
                                        </span>
                                    </div>
                                ))}
                            </div>
                        )}

                        <p className="srd-hint">
                            {L(
                                "The tab stays synced while reading. Look words up, ask the host to wait, or point out a line. Keep it to turn it into your own tab.",
                                "Вкладка синхронизируется с хостом. Можно искать слова, просить подождать, указывать на строки и добавлять карточки. «Сохранить себе» превратит её в обычную вкладку.",
                            )}
                        </p>
                        <div className="srd-actions">
                            {matchingSavedTab && onMergeIntoSaved && (
                                <button
                                    type="button"
                                    className="srd-btn is-primary"
                                    onClick={() => {
                                        onMergeIntoSaved(tab.id, matchingSavedTab.id);
                                        onClose();
                                    }}
                                >
                                    {L(`Update “${matchingSavedTab.name}”`, `Обновить «${matchingSavedTab.name}»`)}
                                </button>
                            )}
                            <button
                                type="button"
                                className={`srd-btn${matchingSavedTab ? "" : " is-primary"}`}
                                onClick={() => {
                                    onKeep(tab.id);
                                    onClose();
                                }}
                            >
                                {matchingSavedTab
                                    ? L("Save as new", "Сохранить как новую")
                                    : L("Keep a copy", "Сохранить себе")}
                            </button>
                            <button
                                type="button"
                                className="srd-btn is-danger"
                                onClick={() => {
                                    onLeave(tab.id);
                                    onClose();
                                }}
                            >
                                {L("Leave", "Выйти")}
                            </button>
                        </div>
                    </section>
                )}

                {tab && !share && !tab.archived && (!tab.mode || tab.mode === "text") && (
                    <section className="srd-card">
                        <div className="srd-label">{L("Broadcast this tab", "Транслировать эту вкладку")}</div>
                        <p className="srd-hint">
                            {L(
                                `Friends will see “${tab.name}” live and look words up in their own Setsuna with their own dictionaries.`,
                                `Друзья увидят «${tab.name}» вживую и смогут искать слова в своей Сецуне, со своими словарями.`,
                            )}
                        </p>

                        <div className="srd-history-picker">
                            <span className="srd-label">{L("What history to send", "Сколько строк отправить гостям")}</span>
                            <div className="srd-segmented" role="radiogroup">
                                {(
                                    [
                                        ["new", L("New only", "Только новые")],
                                        ["recent", L(`Last ${RECENT_HISTORY_LINES}`, `Последние ${RECENT_HISTORY_LINES}`)],
                                        ["all", L("Whole tab", "Вся вкладка")],
                                    ] as const
                                ).map(([mode, label]) => (
                                    <button
                                        key={mode}
                                        type="button"
                                        className={historyMode === mode ? "is-active" : ""}
                                        onClick={() => setHistoryMode(mode)}
                                    >
                                        {label}
                                    </button>
                                ))}
                            </div>
                        </div>

                        {!isMobile && (
                            <label className="srd-toggle">
                                <input
                                    type="checkbox"
                                    checked={shareShots}
                                    onChange={(e) => setShareShots(e.target.checked)}
                                />
                                <span>{L("Share game screenshots for friends' Anki cards", "Делиться скриншотами игры для Anki друзей")}</span>
                            </label>
                        )}

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
                            onKeyDown={(e) => {
                                e.stopPropagation();
                                if (e.key === "Enter") void join();
                                if (e.key === "Escape") onClose();
                            }}
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
                    {L(
                        "Lines go directly between computers (WebRTC) and are not stored anywhere. Public Nostr relays only help you find each other; the connection details are encrypted with the code.",
                        "Строки идут напрямую между компьютерами (WebRTC) и нигде не хранятся. Публичные Nostr-серверы только помогают найти друг друга, данные для соединения зашифрованы кодом.",
                    )}
                </p>
            </div>
        </div>
    );
}

interface SharedStreamEndedModalProps {
    viewerTab: Tab | null;
    matchingSavedTab: Tab | null;
    kickedReason?: "kicked" | "locked";
    en: boolean;
    onMergeIntoSaved: (viewerTabId: number, targetTabId: number) => void;
    onKeepAsNew: (viewerTabId: number) => void;
    onDiscard: (viewerTabId: number) => void;
    onDismiss: () => void;
}

export function SharedStreamEndedModal({
    viewerTab,
    matchingSavedTab,
    kickedReason,
    en,
    onMergeIntoSaved,
    onKeepAsNew,
    onDiscard,
    onDismiss,
}: SharedStreamEndedModalProps) {
    useEffect(() => {
        if (!viewerTab) return;
        const onKey = (event: KeyboardEvent) => {
            if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                onDismiss();
            }
        };
        window.addEventListener("keydown", onKey, true);
        return () => window.removeEventListener("keydown", onKey, true);
    }, [viewerTab, onDismiss]);

    if (!viewerTab) return null;

    const L = (english: string, russian: string) => (en ? english : russian);
    const mergedPreview = matchingSavedTab
        ? mergeSharedLines(matchingSavedTab.lines, viewerTab.lines)
        : null;

    const titleText =
        kickedReason === "kicked"
            ? L("Removed from room", "Тебя исключили из комнаты")
            : L("Shared reading ended", "Совместное чтение завершено");

    return (
        <div className="srd-backdrop" onClick={onDismiss}>
            <div
                className="srd"
                role="dialog"
                aria-label={titleText}
                onClick={(e) => e.stopPropagation()}
            >
                <header className="srd-head">
                    <div className="srd-title">{titleText}</div>
                    <button type="button" className="srd-close" onClick={onDismiss} aria-label={L("Close", "Закрыть")}>
                        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                            <path d="M18 6 6 18" />
                            <path d="m6 6 12 12" />
                        </svg>
                    </button>
                </header>

                {matchingSavedTab ? (
                    <section className="srd-card is-viewer">
                        <div className="srd-label">
                            {L("Found your saved tab from earlier", "Найдена твоя ранее сохранённая вкладка")}
                        </div>
                        <p className="srd-hint">
                            {L(
                                `Tab “${matchingSavedTab.name}” belongs to this same stream. Update it without duplicating lines, or save this session as a separate tab.`,
                                `Вкладка «${matchingSavedTab.name}» уже связана с этим эфиром — даже если её переименовывали. Можно дописать в неё новые строки без дубликатов или сохранить как отдельную вкладку.`,
                            )}
                        </p>
                        {mergedPreview && (
                            <div className="srd-ended-meta">
                                {mergedPreview.addedCount > 0
                                    ? L(
                                          `+${mergedPreview.addedCount} new lines (${viewerTab.lines.length} in this stream)`,
                                          `Новых строк: +${mergedPreview.addedCount} (всего в эфире: ${viewerTab.lines.length})`,
                                      )
                                    : L(
                                          "All stream lines are already in your saved tab.",
                                          "Все строки этого эфира уже есть в твоей сохранённой вкладке.",
                                      )}
                            </div>
                        )}
                        <div className="srd-actions">
                            <button
                                type="button"
                                className="srd-btn is-primary"
                                onClick={() => onMergeIntoSaved(viewerTab.id, matchingSavedTab.id)}
                            >
                                {L(`Update “${matchingSavedTab.name}”`, `Обновить «${matchingSavedTab.name}»`)}
                            </button>
                            <button
                                type="button"
                                className="srd-btn"
                                onClick={() => onKeepAsNew(viewerTab.id)}
                            >
                                {L("Save as new", "Сохранить как новую")}
                            </button>
                            <button
                                type="button"
                                className="srd-btn is-danger"
                                onClick={() => onDiscard(viewerTab.id)}
                            >
                                {L("Discard temporary", "Удалить временную")}
                            </button>
                        </div>
                    </section>
                ) : viewerTab.lines.length === 0 ? (
                    <section className="srd-card is-viewer">
                        <div className="srd-label">
                            {L("The host ended the broadcast", "Хост завершил эфир")}
                        </div>
                        <p className="srd-hint">
                            {L(
                                "No lines arrived in this tab, so there is nothing to keep. If lines never showed up while the room said LIVE, the two devices probably couldn't connect directly: try the same Wi-Fi network.",
                                "В эту вкладку не пришло ни одной строки, сохранять нечего. Если строки так и не появлялись, устройства, скорее всего, не смогли соединиться напрямую: попробуй подключить их к одной сети Wi-Fi.",
                            )}
                        </p>
                        <div className="srd-actions">
                            <button type="button" className="srd-btn is-primary" onClick={() => onDiscard(viewerTab.id)}>
                                {L("Close the tab", "Закрыть вкладку")}
                            </button>
                        </div>
                    </section>
                ) : (
                    <section className="srd-card is-viewer">
                        <div className="srd-label">
                            {L(`Keep tab “${viewerTab.name}”?`, `Оставить вкладку «${viewerTab.name}» у себя?`)}
                        </div>
                        <p className="srd-hint">
                            {L(
                                `Recorded lines: ${viewerTab.lines.length}. Saving turns it into your own editable tab (and future streams from this host can update it automatically).`,
                                `Получено строк: ${viewerTab.lines.length}. Если оставить у себя, вкладка станет обычной (и при следующем эфире от этого хоста её можно будет просто обновить).`,
                            )}
                        </p>
                        <div className="srd-actions">
                            <button
                                type="button"
                                className="srd-btn is-primary"
                                onClick={() => onKeepAsNew(viewerTab.id)}
                            >
                                {L("Keep tab", "Оставить себе")}
                            </button>
                            <button
                                type="button"
                                className="srd-btn is-danger"
                                onClick={() => onDiscard(viewerTab.id)}
                            >
                                {L("Discard temporary", "Удалить временную")}
                            </button>
                        </div>
                    </section>
                )}

                <div className="srd-ended-footer">
                    <span className="srd-hint">
                        {L(
                            "If you close this window, the temporary tab stays open until you decide.",
                            "Если закрыть это окно, вкладка останется висеть как временная — сохранить или удалить её можно позже.",
                        )}
                    </span>
                    <button type="button" className="srd-btn" onClick={onDismiss}>
                        {L("Decide later", "Решу позже")}
                    </button>
                </div>
            </div>
        </div>
    );
}
