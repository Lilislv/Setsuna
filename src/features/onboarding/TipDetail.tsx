import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import "./onboarding.css";

type TipDetailProps = {
    title: string;
    /** Paragraphs; a line starting with "## " is a subheading, "• " a list item. */
    paragraphs: string[];
    language: string;
    portalTarget?: Element | null;
    onClose: () => void;
};

/** The long explanation behind a tip's "More" button, in the same glass card as the mode introductions. */
export default function TipDetail({ title, paragraphs, language, portalTarget, onClose }: TipDetailProps) {
    const isEn = language === "en";
    const closeRef = useRef<HTMLButtonElement>(null);

    useEffect(() => {
        // Long texts scroll: start at the top, not at the focused button below.
        closeRef.current?.focus({ preventScroll: true });
        const onKey = (event: KeyboardEvent) => {
            if (event.key !== "Escape" && event.key !== "Enter") return;
            event.preventDefault();
            event.stopImmediatePropagation();
            onClose();
        };
        window.addEventListener("keydown", onKey, true);
        return () => window.removeEventListener("keydown", onKey, true);
    }, [onClose]);

    const blocks: Array<{ kind: "h" | "p" | "ul"; items: string[] }> = [];
    paragraphs.forEach((line) => {
        if (line.startsWith("## ")) blocks.push({ kind: "h", items: [line.slice(3)] });
        else if (line.startsWith("• ")) {
            const last = blocks[blocks.length - 1];
            if (last?.kind === "ul") last.items.push(line.slice(2));
            else blocks.push({ kind: "ul", items: [line.slice(2)] });
        } else blocks.push({ kind: "p", items: [line] });
    });

    return createPortal(
        <div className="onb-backdrop onb-detail-backdrop" onClick={onClose}>
            <div className="onb-intro onb-detail" role="dialog" aria-modal="true" aria-labelledby="onb-detail-title" onClick={(event) => event.stopPropagation()}>
                <div className="onb-intro-kicker">{isEn ? "More about" : "Подробнее"}</div>
                <h2 id="onb-detail-title" className="onb-intro-title">{title}</h2>
                <div className="onb-detail-body">
                    {blocks.map((block, index) => block.kind === "h"
                        ? <h3 key={index} className="onb-detail-h">{block.items[0]}</h3>
                        : block.kind === "ul"
                            ? <ul key={index} className="onb-detail-list">{block.items.map((item, itemIndex) => <li key={itemIndex}>{item}</li>)}</ul>
                            : <p key={index}>{block.items[0]}</p>)}
                </div>
                <div className="onb-intro-actions">
                    <button type="button" ref={closeRef} className="onb-btn is-primary" onClick={onClose}>{isEn ? "Back to the tip" : "Вернуться к подсказке"}</button>
                </div>
            </div>
        </div>,
        portalTarget?.isConnected ? portalTarget : document.body,
    );
}
