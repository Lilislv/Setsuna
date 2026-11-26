import { useCallback, useEffect, useState } from "react";
import CoachTour from "./CoachTour";
import TourHelpButton from "./TourHelpButton";
import ModeIntro from "./ModeIntro";
import { modeTips } from "./guides";
import { introSeen, markIntroSeen, ONBOARDING_RESET_EVENT, type OnboardingMode } from "./onboardingStore";

type OnboardingLayerProps = {
    mode: OnboardingMode;
    language: string;
    /** Show button tips after the introduction (phones get their own set, see mobileGuides). */
    tips: boolean;
};

/**
 * Contextual onboarding for one mode: its introduction on the first visit, then
 * tips for its buttons. Nothing runs for modes the user never opens.
 */
export default function OnboardingLayer({ mode, language, tips }: OnboardingLayerProps) {
    const [intro, setIntro] = useState(() => !introSeen(mode));
    // "Later" on the introduction postpones the button tips to the next visit.
    const [tipsLater, setTipsLater] = useState(false);

    useEffect(() => {
        setIntro(!introSeen(mode));
        setTipsLater(false);
    }, [mode]);

    useEffect(() => {
        const onReset = () => {
            setIntro(!introSeen(mode));
            setTipsLater(false);
        };
        window.addEventListener(ONBOARDING_RESET_EVENT, onReset);
        return () => window.removeEventListener(ONBOARDING_RESET_EVENT, onReset);
    }, [mode]);

    const closeIntro = useCallback(() => {
        markIntroSeen(mode);
        setIntro(false);
    }, [mode]);

    if (intro) {
        return (
            <ModeIntro
                mode={mode}
                language={language}
                onClose={() => { setTipsLater(true); closeIntro(); }}
                onShowButtons={tips ? closeIntro : undefined}
            />
        );
    }
    const steps = modeTips(mode, language);
    return (
        <>
            <CoachTour steps={steps} language={language} active={tips && !tipsLater} delayMs={900} watch surface={`mode:${mode}`} />
            {/* TextHooker has its "?" in the top bar; the reader and the player get a corner button. */}
            {tips && mode !== "texthooker" && steps.length > 0 && <TourHelpButton surface={`mode:${mode}`} language={language} floating />}
        </>
    );
}
