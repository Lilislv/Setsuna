import { useState } from "react";
import type { Tab } from "../utils/constants";
import type { MemberActivity } from "../utils/sharedReading";
import type { ShareStatus } from "../utils/useSharedReading";
import "./SharedReadingBar.css";

interface SharedReadingBarProps {
    tab: Tab;
    status: ShareStatus | undefined;
    viewerActivity: MemberActivity;
    en: boolean;
    matchingSavedTabName?: string | null;
    onMergeIntoSaved?: () => void;
    onOpenDialog: () => void;
    onToggleWait: () => void;
    onToggleSyncTimer: () => void;
    onKeepCopy: () => void;
    onLeave: () => void;
    onJumpToLine: (lineIndex: number) => void;
    onDismissSpotlight: () => void;
}

const activityBadge = (activity: MemberActivity, en: boolean) => {
    switch (activity) {
        case "wait":
            return { icon: "✋", title: en ? "Asks to wait" : "Просит подождать" };
        case "lookup":
            return { icon: "🔍", title: en ? "Looking up a word" : "Смотрит слово" };
        case "ready":
            return { icon: "✓", title: en ? "Ready" : "Готов" };
        default:
            return null;
    }
};

export default function SharedReadingBar({
    tab,
    status,
    viewerActivity,
    en,
    matchingSavedTabName,
    onMergeIntoSaved,
    onOpenDialog,
    onToggleWait,
    onToggleSyncTimer,
    onKeepCopy,
    onLeave,
    onJumpToLine,
    onDismissSpotlight,
}: SharedReadingBarProps) {
    const [collapsed, setCollapsed] = useState(false);
    const [copied, setCopied] = useState(false);

    const share = tab.shared;
    if (!share) return null;

    const L = (enText: string, ruText: string) => (en ? enText : ruText);
    const isHost = share.role === "host";
    const ended = Boolean(share.ended);
    const connection = status?.state || "connecting";
    const members = status?.members || [];
    const guests = members.filter((m) => m.role === "viewer");
    const waitingMembers = guests.filter((m) => m.activity === "wait");
    const lookupMembers = guests.filter((m) => m.activity === "lookup");
    const syncTimer = share.syncTimer !== false;
    const spotlight = status?.spotlight;

    const copyCode = async () => {
        try {
            await navigator.clipboard.writeText(share.code);
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1500);
        } catch {
            // ignore
        }
    };

    const statusLabel = ended
        ? status?.kickedReason === "kicked"
            ? L("Removed", "Исключён")
            : L("Ended", "Эфир завершён")
        : isHost
          ? connection === "live"
              ? `LIVE · ${share.code}`
              : `${share.code}`
          : connection === "live" && status?.hostOnline
            ? status.hostName || share.code
            : connection === "offline"
              ? L("Host away", "Хост отошёл")
              : L("Connecting…", "Поиск…");

    const dotClass = ended
        ? "is-ended"
        : isHost
          ? connection === "live"
              ? "is-host"
              : "is-away"
          : status?.hostOnline && connection === "live"
            ? "is-live"
            : "is-away";

    if (collapsed) {
        return (
            <div className="srb-wrap">
                <div className="srb is-collapsed">
                    <button type="button" className="srb-status" onClick={onOpenDialog} title={L("Open shared reading settings", "Открыть «Читать вместе»")}>
                        <span className={`srb-dot ${dotClass}`} />
                        <span>{statusLabel}</span>
                        {waitingMembers.length > 0 && <span className="srb-wait-pill">✋ {waitingMembers.length}</span>}
                    </button>
                    <button
                        type="button"
                        className="srb-icon-btn"
                        onClick={() => setCollapsed(false)}
                        title={L("Expand bar", "Развернуть панель")}
                        aria-label={L("Expand bar", "Развернуть панель")}
                    >
                        ▾
                    </button>
                </div>
            </div>
        );
    }

    return (
        <div className="srb-wrap">
            <div className={`srb${waitingMembers.length > 0 && isHost ? " has-wait" : ""}`}>
                <button
                    type="button"
                    className="srb-status"
                    onClick={onOpenDialog}
                    title={L("Room info & participants", "Настройки комнаты и участники")}
                >
                    <span className={`srb-dot ${dotClass}`} />
                    <span>{statusLabel}</span>
                </button>

                {isHost && (
                    <button
                        type="button"
                        className="srb-copy-btn"
                        onClick={() => void copyCode()}
                        title={L("Copy room code", "Скопировать код комнаты")}
                    >
                        {copied ? L("Copied", "Скопир.") : L("Copy", "Код")}
                    </button>
                )}

                {!ended && members.length > 0 && (
                    <div className="srb-members" aria-label={L("Participants", "Участники")}>
                        {members.slice(0, 4).map((member) => {
                            const badge = activityBadge(member.activity, en);
                            return (
                                <span
                                    key={member.id}
                                    className={`srb-member${member.activity === "wait" ? " is-wait" : ""}${member.activity === "lookup" ? " is-lookup" : ""}`}
                                    title={
                                        badge
                                            ? `${member.name} — ${badge.title}`
                                            : member.name
                                    }
                                >
                                    <i style={{ background: member.color }} />
                                    <span>{member.name}</span>
                                    {badge && <em>{badge.icon}</em>}
                                </span>
                            );
                        })}
                        {members.length > 4 && <span className="srb-more">+{members.length - 4}</span>}
                    </div>
                )}

                {isHost && !ended && waitingMembers.length > 0 && (
                    <span className="srb-alert is-wait">
                        ✋{" "}
                        {waitingMembers.length === 1
                            ? L(`${waitingMembers[0].name}: wait`, `${waitingMembers[0].name} просит подождать`)
                            : L(`${waitingMembers.length} waiting`, `Ждут: ${waitingMembers.length}`)}
                    </span>
                )}

                {isHost && !ended && waitingMembers.length === 0 && lookupMembers.length > 0 && (
                    <span className="srb-alert is-lookup">
                        🔍{" "}
                        {lookupMembers.length === 1
                            ? L(`${lookupMembers[0].name} reading word…`, `${lookupMembers[0].name} смотрит слово`)
                            : L(`${lookupMembers.length} in lookup`, `${lookupMembers.length} в словаре`)}
                    </span>
                )}

                {!isHost && !ended && (
                    <div className="srb-controls">
                        <button
                            type="button"
                            className={`srb-action${viewerActivity === "wait" ? " is-wait" : viewerActivity === "ready" ? " is-ready" : ""}`}
                            onClick={onToggleWait}
                            title={L("Ask the host to wait / mark ready (Alt+W)", "Попросить хоста подождать / «Готов» (Alt+W)")}
                        >
                            {viewerActivity === "wait"
                                ? `✋ ${L("Waiting… (Ready)", "Ждите… (Готов)")}`
                                : viewerActivity === "ready"
                                  ? `✓ ${L("Ready!", "Готов!")}`
                                  : `✋ ${L("Wait", "Подожди")}`}
                        </button>
                        <button
                            type="button"
                            className={`srb-timer-pill${syncTimer ? " is-synced" : ""}`}
                            onClick={onToggleSyncTimer}
                            title={
                                syncTimer
                                    ? L("Timer follows the host. Click to control manually.", "Таймер синхронизирован с хостом. Нажми для ручного режима.")
                                    : L("Manual timer mode. Click to follow the host's timer.", "Ручной таймер. Нажми, чтобы синхронизировать с хостом.")
                            }
                        >
                            ⏱ {syncTimer ? L("Host", "С хостом") : L("Own", "Свой")}
                        </button>
                    </div>
                )}

                {!isHost && ended && (
                    <div className="srb-controls">
                        {matchingSavedTabName && onMergeIntoSaved ? (
                            <>
                                <button type="button" className="srb-action is-primary" onClick={onMergeIntoSaved}>
                                    {L(`Update “${matchingSavedTabName}”`, `Обновить «${matchingSavedTabName}»`)}
                                </button>
                                <button type="button" className="srb-action" onClick={onKeepCopy}>
                                    {L("Save as new", "Как новую")}
                                </button>
                            </>
                        ) : (
                            <button type="button" className="srb-action is-primary" onClick={onKeepCopy}>
                                {L("Keep copy", "Сохранить себе")}
                            </button>
                        )}
                        <button type="button" className="srb-action is-danger" onClick={onLeave}>
                            {L("Close", "Закрыть")}
                        </button>
                    </div>
                )}

                <button
                    type="button"
                    className="srb-icon-btn"
                    onClick={() => setCollapsed(true)}
                    title={L("Collapse bar", "Свернуть панель")}
                    aria-label={L("Collapse bar", "Свернуть панель")}
                >
                    ▴
                </button>
            </div>

            {spotlight && (
                <div className="srb-spotlight" style={{ borderColor: `color-mix(in srgb, ${spotlight.byColor} 55%, var(--line))` }}>
                    <button
                        type="button"
                        className="srb-spotlight-jump"
                        onClick={() => onJumpToLine(spotlight.lineIndex)}
                        title={L("Jump to pointed line", "Перейти к отмеченной строке")}
                    >
                        <span className="srb-spotlight-badge" style={{ background: spotlight.byColor }} />
                        <strong>{spotlight.byName}:</strong>
                        <span className="srb-spotlight-text">«{spotlight.snippet}»</span>
                        <small>{L("Jump →", "Перейти →")}</small>
                    </button>
                    <button
                        type="button"
                        className="srb-icon-btn"
                        onClick={onDismissSpotlight}
                        aria-label={L("Dismiss", "Скрыть")}
                    >
                        ×
                    </button>
                </div>
            )}
        </div>
    );
}
