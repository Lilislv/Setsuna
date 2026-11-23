import { useEffect, useState } from "react";
import { IconClose } from "../../components/Icons";
import { getTranslator, type AppLanguage } from "../../utils/i18n";
import { renderQuoteCardDataUrl } from "./epubQuoteCard";

interface EpubQuoteModalProps {
    open: boolean;
    quote: string;
    bookTitle: string;
    author?: string;
    chapterTitle?: string;
    coverDataUrl?: string | null;
    fontFamily: string;
    initialTheme?: "dark" | "paper" | "sepia" | "black";
    language: AppLanguage;
    onClose: () => void;
}

export default function EpubQuoteModal({
    open,
    quote,
    bookTitle,
    author,
    chapterTitle,
    coverDataUrl,
    fontFamily,
    initialTheme = "dark",
    language,
    onClose,
}: EpubQuoteModalProps) {
    const t = getTranslator(language);
    const [theme, setTheme] = useState<"dark" | "paper" | "sepia" | "black">(initialTheme);
    const [dataUrl, setDataUrl] = useState<string>("");
    const [copied, setCopied] = useState(false);

    useEffect(() => {
        if (!open) return;
        setTheme(initialTheme);
        setCopied(false);
    }, [open, initialTheme]);

    useEffect(() => {
        if (!open || !quote.trim()) return;
        let cancelled = false;
        void renderQuoteCardDataUrl({
            quote,
            bookTitle,
            author,
            chapterTitle,
            coverDataUrl,
            fontFamily,
            theme,
        }).then((url) => {
            if (!cancelled) setDataUrl(url);
        });
        return () => {
            cancelled = true;
        };
    }, [open, quote, bookTitle, author, chapterTitle, coverDataUrl, fontFamily, theme]);

    useEffect(() => {
        if (!open) return;
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                onClose();
            }
        };
        window.addEventListener("keydown", onKeyDown, true);
        return () => window.removeEventListener("keydown", onKeyDown, true);
    }, [open, onClose]);

    if (!open) return null;

    const handleDownload = () => {
        if (!dataUrl) return;
        const link = document.createElement("a");
        link.href = dataUrl;
        const safeName = bookTitle.replace(/[^a-zA-Z0-9\u3040-\u9fffа-яА-Я_-]+/g, "_").slice(0, 40) || "quote";
        link.download = `${safeName}-quote.png`;
        link.click();
    };

    const handleCopy = async () => {
        if (!dataUrl) return;
        try {
            const res = await fetch(dataUrl);
            const blob = await res.blob();
            await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1800);
        } catch {
            handleDownload();
        }
    };

    return (
        <div className="epub-modal-backdrop" onClick={onClose}>
            <div className="epub-modal-card epub-quote-modal" onClick={(e) => e.stopPropagation()}>
                <div className="epub-modal-head">
                    <strong>{t("epub.quoteImage")}</strong>
                    <button type="button" className="epub-glass-btn epub-glass-circle" aria-label={t("common.close")} onClick={onClose}>
                        <IconClose />
                    </button>
                </div>

                <div className="epub-quote-preview-wrap">
                    {dataUrl && <img src={dataUrl} alt={quote} className="epub-quote-preview-img" />}
                </div>

                <div className="epub-quote-controls">
                    <div className="epub-segmented">
                        {(["dark", "paper", "sepia", "black"] as const).map((th) => (
                            <button
                                key={th}
                                type="button"
                                className={`epub-seg-btn${theme === th ? " is-active" : ""}`}
                                onClick={() => setTheme(th)}
                            >
                                {th === "dark" ? t("epub.themeDark")
                                    : th === "paper" ? t("epub.themePaper")
                                        : th === "sepia" ? t("epub.themeSepia")
                                            : t("epub.themeBlack")}
                            </button>
                        ))}
                    </div>

                    <div className="epub-quote-actions">
                        <button type="button" className="epub-glass-btn" onClick={() => void handleCopy()}>
                            {copied ? t("epub.copied") : t("epub.copyImage")}
                        </button>
                        <button type="button" className="btn-primary" onClick={handleDownload}>
                            {t("epub.downloadImage")}
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
}
