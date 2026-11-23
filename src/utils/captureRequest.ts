import type { CaptureSourceBinding } from "./constants";

// Lets the lookup popup ask the main window to pick a screenshot process when
// a card with a screenshot is added and nothing is chosen yet. The main window
// opens its process picker, binds the choice to the tab and returns it, so the
// card is added right away. Other windows have no handler and keep the old hint.

type Handler = () => Promise<CaptureSourceBinding | null>;

let handler: Handler | null = null;

export const registerCaptureSourceRequest = (next: Handler) => {
    handler = next;
    return () => { if (handler === next) handler = null; };
};

export const canRequestCaptureSource = () => handler !== null;

export const requestCaptureSource = (): Promise<CaptureSourceBinding | null> =>
    handler ? handler() : Promise.resolve(null);
