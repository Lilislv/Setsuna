import type { ShareStatus } from "../utils/useSharedReading";

// What a shared tab's badge may honestly claim. "LIVE" only when lines can
// actually flow: the host is on air, or a viewer hears the host right now.

export type SharedBadgeKind = "live-host" | "live-viewer" | "pending" | "offline" | "ended";

export type SharedBadge = { kind: SharedBadgeKind; label: string; title: string };

type SharedTabLike = {
    shared?: { role: "host" | "viewer"; code: string; ended?: boolean } | null;
};

export function sharedBadge(tab: SharedTabLike | undefined, status: ShareStatus | undefined, isEn: boolean): SharedBadge | null {
    const share = tab?.shared;
    if (!share) return null;
    const ended = share.ended || status?.state === "ended";
    if (ended) {
        return { kind: "ended", label: isEn ? "Ended" : "Завершён", title: isEn ? "The broadcast has ended" : "Эфир завершён" };
    }
    const state = status?.state ?? "connecting";
    if (share.role === "host") {
        if (state === "live") {
            const viewers = status?.viewers ?? 0;
            return {
                kind: "live-host",
                label: "LIVE",
                title: isEn ? `On air, code ${share.code} · viewers: ${viewers}` : `В эфире, код ${share.code} · зрителей: ${viewers}`,
            };
        }
        if (state === "offline") {
            return { kind: "offline", label: isEn ? "No network" : "Нет связи", title: isEn ? "Can't reach the relays; retrying" : "Нет связи с серверами-посредниками, пробую снова" };
        }
        return { kind: "pending", label: isEn ? "Starting…" : "Запуск…", title: isEn ? "Opening the room" : "Открываю комнату" };
    }
    if (state === "live" && status?.hostOnline) {
        return { kind: "live-viewer", label: "LIVE", title: isEn ? `Following ${share.code}` : `Смотришь эфир ${share.code}` };
    }
    if (state === "offline") {
        return { kind: "offline", label: isEn ? "Host away" : "Хост не в сети", title: isEn ? "The host is not connected right now" : "Хост сейчас не подключён" };
    }
    if (state === "live") {
        return { kind: "pending", label: isEn ? "Waiting…" : "Жду хоста", title: isEn ? "Connected to the room, waiting for the host" : "Подключено к комнате, жду хоста" };
    }
    return { kind: "pending", label: isEn ? "Connecting…" : "Подключение…", title: isEn ? `Looking for room ${share.code}` : `Ищу комнату ${share.code}` };
}

/** Class for the `.tab-live` pill / island dot. */
export const sharedBadgeClass = (badge: SharedBadge) =>
    badge.kind === "live-host" ? "is-host"
        : badge.kind === "live-viewer" ? "is-viewer"
            : badge.kind === "ended" ? "is-ended"
                : badge.kind === "offline" ? "is-offline" : "is-pending";
