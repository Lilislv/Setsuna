// Remembers which mode introductions and button tips a user has already seen.
// Tips are contextual: a mode's introduction and its button tour run the first
// time that mode is opened, never for modes the user does not use.

export type OnboardingMode = "texthooker" | "epub" | "player";

type OnboardingState = {
    intros: Partial<Record<OnboardingMode, true>>;
    tips: Record<string, true>;
};

const STORAGE_KEY = "setsuna-onboarding";
export const ONBOARDING_RESET_EVENT = "setsuna:onboarding-reset";

const empty = (): OnboardingState => ({ intros: {}, tips: {} });

const read = (): OnboardingState => {
    try {
        const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
        if (!parsed || typeof parsed !== "object") return empty();
        return {
            intros: parsed.intros && typeof parsed.intros === "object" ? parsed.intros : {},
            tips: parsed.tips && typeof parsed.tips === "object" ? parsed.tips : {},
        };
    } catch {
        return empty();
    }
};

const write = (state: OnboardingState) => {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch {
        // Storage can be unavailable; tips then simply show again next time.
    }
};

export const introSeen = (mode: OnboardingMode): boolean => Boolean(read().intros[mode]);

export const markIntroSeen = (mode: OnboardingMode) => {
    const state = read();
    state.intros[mode] = true;
    write(state);
};

export const tipSeen = (id: string): boolean => Boolean(read().tips[id]);

export const markTipsSeen = (ids: string[]) => {
    if (ids.length === 0) return;
    const state = read();
    ids.forEach((id) => { state.tips[id] = true; });
    write(state);
};

/** Shows every introduction and tip again (Settings → "Show tips again"). */
export const resetOnboarding = () => {
    write(empty());
    try {
        window.dispatchEvent(new Event(ONBOARDING_RESET_EVENT));
    } catch {
        // Non-browser test environment.
    }
};
