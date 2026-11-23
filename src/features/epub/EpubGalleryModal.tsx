import { useEffect, useState } from "react";
import { IconClose } from "../../components/Icons";
import { getTranslator, type AppLanguage } from "../../utils/i18n";
import { loadEpubGallery } from "./epubApi";
import type { EpubGalleryImage } from "./epubModel";

interface EpubGalleryModalProps {
    open: boolean;
    bookPath: string;
    bookTitle: string;
    language: AppLanguage;
    onClose: () => void;
    onJumpToImage: (chapterIndex: number, paragraphIndex: number) => void;
}

export default function EpubGalleryModal({
    open,
    bookPath,
    bookTitle,
    language,
    onClose,
    onJumpToImage,
}: EpubGalleryModalProps) {
    const t = getTranslator(language);
    const [images, setImages] = useState<EpubGalleryImage[]>([]);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [activeIdx, setActiveIdx] = useState<number | null>(null);

    useEffect(() => {
        if (!open || !bookPath) return;
        let cancelled = false;
        setLoading(true);
        setError(null);
        setActiveIdx(null);
        loadEpubGallery(bookPath)
            .then((list) => {
                if (!cancelled) {
                    setImages(list);
                    setLoading(false);
                }
            })
            .catch((err) => {
                if (!cancelled) {
                    setError(String(err));
                    setLoading(false);
                }
            });
        return () => {
            cancelled = true;
        };
    }, [open, bookPath]);

    useEffect(() => {
        if (!open) return;
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                if (activeIdx !== null) setActiveIdx(null);
                else onClose();
            } else if (activeIdx !== null && event.key === "ArrowLeft") {
                event.preventDefault();
                setActiveIdx((prev) => (prev !== null ? Math.max(0, prev - 1) : null));
            } else if (activeIdx !== null && event.key === "ArrowRight") {
                event.preventDefault();
                setActiveIdx((prev) => (prev !== null ? Math.min(images.length - 1, prev + 1) : null));
            }
        };
        window.addEventListener("keydown", onKeyDown, true);
        return () => window.removeEventListener("keydown", onKeyDown, true);
    }, [open, activeIdx, images.length, onClose]);

    if (!open) return null;

    const activeImage = activeIdx !== null ? images[activeIdx] : null;

    return (
        <div className="epub-modal-backdrop" onClick={onClose}>
            <div className="epub-modal-card epub-gallery-modal" onClick={(e) => e.stopPropagation()}>
                <div className="epub-modal-head">
                    <div>
                        <strong>{t("epub.gallery")}</strong>
                        <span className="epub-modal-sub"> · {bookTitle}</span>
                    </div>
                    <button type="button" className="epub-glass-btn epub-glass-circle" aria-label={t("common.close")} onClick={onClose}>
                        <IconClose />
                    </button>
                </div>

                {loading ? (
                    <div className="epub-gallery-state">{t("epub.galleryLoading")}</div>
                ) : error ? (
                    <div className="epub-gallery-state">{error}</div>
                ) : images.length === 0 ? (
                    <div className="epub-gallery-state">{t("epub.galleryEmpty")}</div>
                ) : activeImage ? (
                    <div className="epub-gallery-lightbox">
                        <div className="epub-gallery-lightbox-stage">
                            <button
                                type="button"
                                className="epub-glass-btn epub-glass-circle"
                                disabled={activeIdx === 0}
                                onClick={() => setActiveIdx((prev) => (prev !== null ? Math.max(0, prev - 1) : 0))}
                            >
                                ‹
                            </button>
                            <img src={activeImage.src} alt={activeImage.alt || ""} className="epub-gallery-lightbox-img" />
                            <button
                                type="button"
                                className="epub-glass-btn epub-glass-circle"
                                disabled={activeIdx === images.length - 1}
                                onClick={() => setActiveIdx((prev) => (prev !== null ? Math.min(images.length - 1, prev + 1) : 0))}
                            >
                                ›
                            </button>
                        </div>
                        <div className="epub-gallery-lightbox-bar">
                            <span>
                                {(activeIdx ?? 0) + 1} / {images.length}
                                {activeImage.chapterTitle ? ` · ${activeImage.chapterTitle}` : ""}
                            </span>
                            <div className="epub-gallery-lightbox-btns">
                                <button type="button" className="epub-glass-btn" onClick={() => setActiveIdx(null)}>
                                    {language === "en" ? "Back to grid" : "К сетке"}
                                </button>
                                <button
                                    type="button"
                                    className="btn-primary"
                                    onClick={() => {
                                        onJumpToImage(activeImage.chapterIndex, activeImage.paragraphIndex);
                                        onClose();
                                    }}
                                >
                                    {t("epub.jumpToChapter")}
                                </button>
                            </div>
                        </div>
                    </div>
                ) : (
                    <div className="epub-gallery-grid">
                        {images.map((img, idx) => (
                            <button
                                key={`${img.chapterIndex}-${img.paragraphIndex}-${idx}`}
                                type="button"
                                className="epub-gallery-thumb"
                                onClick={() => setActiveIdx(idx)}
                            >
                                <img src={img.src} alt={img.alt || ""} loading="lazy" />
                                <span className="epub-gallery-thumb-cap">
                                    {img.chapterTitle || `#${img.chapterIndex + 1}`}
                                </span>
                            </button>
                        ))}
                    </div>
                )}
            </div>
        </div>
    );
}
