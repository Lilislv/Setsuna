import { useEffect, useRef } from "react";

export const MOBILE_BACK_PRIORITY = {
    WORKSPACE: 20,
    SUBVIEW: 40,
    READER_OVERLAY: 60,
    MODAL: 80,
    POPUP: 100,
} as const;

type BackHandlerEntry = {
    id: number;
    priority: number;
    handler: () => boolean | void;
};

const handlers = new Map<number, BackHandlerEntry>();
let nextHandlerId = 1;

export function registerMobileBackHandler(
    priority: number,
    handler: () => boolean | void,
): () => void {
    const id = nextHandlerId++;
    handlers.set(id, { id, priority, handler });
    return () => {
        handlers.delete(id);
    };
}

export function dispatchMobileBack(): boolean {
    if (typeof document !== "undefined") {
        const fontPickerClose = document.querySelector<HTMLButtonElement>(
            ".font-picker-overlay .font-picker-close",
        );
        if (fontPickerClose) {
            fontPickerClose.click();
            return true;
        }
    }

    const ordered = Array.from(handlers.values()).sort(
        (a, b) => b.priority - a.priority || b.id - a.id,
    );
    for (const entry of ordered) {
        if (entry.handler() !== false) {
            return true;
        }
    }
    return false;
}

export function resetMobileBackHandlersForTest(): void {
    handlers.clear();
    nextHandlerId = 1;
}

export function useMobileBackHandler(
    active: boolean,
    priority: number,
    handler: () => boolean | void,
): void {
    const handlerRef = useRef(handler);
    handlerRef.current = handler;

    useEffect(() => {
        if (!active) return;
        return registerMobileBackHandler(priority, () => handlerRef.current());
    }, [active, priority]);
}

if (typeof window !== "undefined") {
    (
        window as unknown as { __setsunaHandleAndroidBack?: () => boolean }
    ).__setsunaHandleAndroidBack = dispatchMobileBack;
}
