import { useEffect, useRef, useState } from "react";

export interface EpubGlassOption {
    value: string;
    label: string;
}

interface EpubGlassSelectProps {
    value: string;
    options: EpubGlassOption[];
    onChange: (value: string) => void;
    onOpenChange?: (open: boolean) => void;
    ariaLabel: string;
    className?: string;
    align?: "left" | "right";
    disabled?: boolean;
    title?: string;
}

export default function EpubGlassSelect({
    value,
    options,
    onChange,
    onOpenChange,
    ariaLabel,
    className = "",
    align = "left",
    disabled = false,
    title,
}: EpubGlassSelectProps) {
    const [open, setOpen] = useState(false);
    const rootRef = useRef<HTMLDivElement>(null);

    const activeOption = options.find((opt) => opt.value === value) || options[0];

    useEffect(() => {
        onOpenChange?.(open);
    }, [open, onOpenChange]);

    useEffect(() => () => onOpenChange?.(false), [onOpenChange]);

    useEffect(() => {
        if (!open) return;
        const handlePointerDown = (event: MouseEvent) => {
            if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
                setOpen(false);
            }
        };
        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                setOpen(false);
            }
        };
        window.addEventListener("mousedown", handlePointerDown);
        window.addEventListener("keydown", handleKeyDown, { capture: true });
        return () => {
            window.removeEventListener("mousedown", handlePointerDown);
            window.removeEventListener("keydown", handleKeyDown, { capture: true });
        };
    }, [open]);

    return (
        <div ref={rootRef} className={`epub-glass-select${open ? " is-open" : ""}${className ? ` ${className}` : ""}`}>
            <button
                type="button"
                className="epub-glass-select-trigger"
                aria-haspopup="listbox"
                aria-expanded={open}
                aria-label={ariaLabel}
                title={title}
                disabled={disabled}
                onClick={(event) => {
                    event.stopPropagation();
                    if (!disabled) setOpen((prev) => !prev);
                }}
            >
                <span className="epub-glass-select-label">{activeOption?.label || ""}</span>
                <svg
                    className="epub-glass-select-chevron"
                    width="12"
                    height="12"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.4"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                >
                    <polyline points="6 9 12 15 18 9" />
                </svg>
            </button>

            {open && (
                <div
                    className={`epub-glass-select-menu${align === "right" ? " is-right" : ""}`}
                    role="listbox"
                    aria-label={ariaLabel}
                    onClick={(event) => event.stopPropagation()}
                >
                    {options.map((opt) => {
                        const selected = opt.value === value;
                        return (
                            <button
                                key={opt.value}
                                type="button"
                                role="option"
                                aria-selected={selected}
                                className={`epub-glass-select-option${selected ? " is-selected" : ""}`}
                                onClick={() => {
                                    onChange(opt.value);
                                    setOpen(false);
                                }}
                            >
                                <span className="epub-glass-select-option-text">{opt.label}</span>
                                {selected && (
                                    <svg
                                        className="epub-glass-select-check"
                                        width="13"
                                        height="13"
                                        viewBox="0 0 24 24"
                                        fill="none"
                                        stroke="currentColor"
                                        strokeWidth="2.6"
                                        strokeLinecap="round"
                                        strokeLinejoin="round"
                                        aria-hidden="true"
                                    >
                                        <polyline points="20 6 9 17 4 12" />
                                    </svg>
                                )}
                            </button>
                        );
                    })}
                </div>
            )}
        </div>
    );
}
