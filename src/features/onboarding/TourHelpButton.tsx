import { useEffect, useState, type CSSProperties, type ReactElement } from "react";
import { createPortal } from "react-dom";
import { replayTips } from "./CoachTour";
import "./onboarding.css";

type TourHelpButtonProps = {
    /** The surface whose tips to show again (CoachTour `surface`). */
    surface: string;
    language: string;
    className?: string;
    /** Floating in the window's bottom-left corner instead of inside a toolbar. */
    floating?: boolean;
};

const label = (en: boolean) => (en ? "Show the tips for this screen again" : "Показать подсказки этого экрана заново");

/** "?" that replays the tips of the screen it sits on. */
export default function TourHelpButton({ surface, language, className = "", floating = false }: TourHelpButtonProps) {
    const en = language === "en";
    const button = (style?: CSSProperties) => (
        <button
            type="button"
            className={`onb-help-btn${floating ? " is-floating" : ""}${className ? ` ${className}` : ""}`}
            style={style}
            onClick={(event) => { event.stopPropagation(); replayTips(surface); }}
            title={label(en)}
            aria-label={label(en)}
        >
            ?
        </button>
    );
    if (!floating) return button();
    return <FloatingHelp render={button} />;
}

/** Bottom-left corner, lifted above the player's control bar when it is there. */
function FloatingHelp({ render }: { render: (style?: CSSProperties) => ReactElement }) {
    const [bottom, setBottom] = useState(14);
    useEffect(() => {
        const update = () => {
            const transport = document.querySelector(".sp-transport");
            const rect = transport?.getBoundingClientRect();
            setBottom(rect && rect.height > 0 ? Math.max(14, window.innerHeight - rect.top + 10) : 14);
        };
        update();
        const timer = window.setInterval(update, 1000);
        window.addEventListener("resize", update);
        return () => { window.clearInterval(timer); window.removeEventListener("resize", update); };
    }, []);
    return createPortal(render({ bottom }), document.body);
}
