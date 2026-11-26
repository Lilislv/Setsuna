import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import type { OnboardingMode } from "./onboardingStore";
import { modeGuide } from "./guides";
import "./onboarding.css";

type ModeIntroProps = {
    mode: OnboardingMode;
    language: string;
    onClose: () => void;
    /** First visit: offers the button tour. From the mode menu's "?": only a close button. */
    onShowButtons?: () => void;
};

/** Glass card that explains what a mode is for, shown on its first visit or from "?" on the home screen. */
export default function ModeIntro({ mode, language, onClose, onShowButtons }: ModeIntroProps) {
    const isEn = language === "en";
    const guide = modeGuide(mode, language);
    const primaryRef = useRef<HTMLButtonElement>(null);

    useEffect(() => {
        primaryRef.current?.focus();
        const onKey = (event: KeyboardEvent) => {
            if (event.key !== "Escape") return;
            event.preventDefault();
            event.stopPropagation();
            event.stopImmediatePropagation();
            onClose();
        };
        window.addEventListener("keydown", onKey, true);
        return () => window.removeEventListener("keydown", onKey, true);
    }, [onClose]);

    // Portal: animated parents (the home screen) create their own stacking context.
    return createPortal(
        <div className="onb-backdrop" onClick={onClose}>
            <div
                className={`onb-intro onb-intro-${mode}`}
                role="dialog"
                aria-modal="true"
                aria-labelledby="onb-intro-title"
                onClick={(event) => event.stopPropagation()}
            >
                <div className="onb-intro-kicker">{isEn ? "New mode" : "Новый режим"}</div>
                <h2 id="onb-intro-title" className="onb-intro-title">{guide.title}</h2>
                <p className="onb-intro-lead">{guide.lead}</p>
                <ol className="onb-intro-points">
                    {guide.points.map((point, index) => (
                        <li key={index}>
                            <span className="onb-intro-num" aria-hidden="true">{index + 1}</span>
                            <span>{point}</span>
                        </li>
                    ))}
                </ol>
                <div className="onb-intro-actions">
                    {onShowButtons ? (
                        <>
                            <button type="button" className="onb-btn" onClick={onClose}>{isEn ? "Later" : "Позже"}</button>
                            <button type="button" ref={primaryRef} className="onb-btn is-primary" onClick={onShowButtons}>
                                {isEn ? "Show the buttons" : "Показать кнопки"}
                            </button>
                        </>
                    ) : (
                        <button type="button" ref={primaryRef} className="onb-btn is-primary" onClick={onClose}>{isEn ? "Got it" : "Понятно"}</button>
                    )}
                </div>
            </div>
        </div>,
        document.body,
    );
}
