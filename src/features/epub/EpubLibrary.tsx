import type { Tab } from "../../utils/constants";
import { getTranslator, type AppLanguage } from "../../utils/i18n";
import { IconBookTab, IconClose, IconImport } from "../../components/Icons";

interface EpubLibraryProps {
    books: Tab[];
    language: AppLanguage;
    isMobile: boolean;
    onOpenFile: () => void;
    onSelectBook: (tabId: number) => void;
    onRemoveBook: (tabId: number) => void;
}

export default function EpubLibrary({
    books,
    language,
    isMobile,
    onOpenFile,
    onSelectBook,
    onRemoveBook,
}: EpubLibraryProps) {
    const t = getTranslator(language);
    const activeBooks = books.filter((tab) => !tab.archived);

    if (activeBooks.length === 0) {
        if (isMobile) {
            return (
                <div className="m-empty">
                    <div className="m-empty-icon"><IconBookTab /></div>
                    <strong>{t("epub.emptyTitle")}</strong>
                    <span>{t("epub.emptyHint")}</span>
                    <div className="m-empty-actions">
                        <button type="button" className="m-pill-button primary" onClick={onOpenFile}>
                            {t("epub.openFile")}
                        </button>
                    </div>
                </div>
            );
        }

        return (
            <div className="mode-empty-state">
                <span className="mode-empty-icon"><IconBookTab /></span>
                <strong>{t("epub.emptyTitle")}</strong>
                <span>{t("epub.emptyHint")}</span>
                <button type="button" className="btn-primary" onClick={onOpenFile} style={{ marginTop: 8 }}>
                    <IconImport /> {t("epub.openFile")}
                </button>
            </div>
        );
    }

    return (
        <div className={`epub-library${isMobile ? " is-mobile" : ""}`}>
            <div className="epub-library-head">
                <div className="epub-library-title-group">
                    <h2 className="epub-library-title">{t("epub.library")}</h2>
                    <span className="epub-library-count">
                        {t("epub.booksCount", { count: activeBooks.length })}
                    </span>
                </div>
                <button
                    type="button"
                    className={isMobile ? "m-pill-button primary" : "btn-primary"}
                    onClick={onOpenFile}
                >
                    <IconImport /> {t("epub.openFile")}
                </button>
            </div>

            <div className="epub-library-grid">
                {activeBooks.map((book) => {
                    const progress = Math.round(Math.min(1, Math.max(0, book.epub?.progress || 0)) * 100);
                    const bookLang = book.epub?.language === "ja" ? "JA" : "EN";
                    const chaptersCount = book.epub?.chapterCount || 0;
                    const charsRead = book.stats?.chars || 0;

                    return (
                        <div
                            key={book.id}
                            className="epub-book-card"
                            role="button"
                            tabIndex={0}
                            onClick={() => onSelectBook(book.id)}
                            onKeyDown={(event) => {
                                if (event.key === "Enter" || event.key === " ") {
                                    event.preventDefault();
                                    onSelectBook(book.id);
                                }
                            }}
                        >
                            <div className="epub-book-card-top">
                                <div className="epub-book-card-title">{book.epub?.title || book.name}</div>
                                <div className="epub-book-card-actions">
                                    <span className="epub-badge">{bookLang}</span>
                                    <button
                                        type="button"
                                        className="epub-icon-btn is-danger"
                                        title={t("epub.removeBook")}
                                        aria-label={t("epub.removeBook")}
                                        onClick={(event) => {
                                            event.stopPropagation();
                                            onRemoveBook(book.id);
                                        }}
                                    >
                                        <IconClose />
                                    </button>
                                </div>
                            </div>

                            <div className="epub-progress-track" aria-hidden="true">
                                <div className="epub-progress-fill" style={{ width: `${progress}%` }} />
                            </div>

                            <div className="epub-book-card-meta">
                                <span>
                                    {t("epub.progress", { percent: progress })}
                                    {chaptersCount > 0 ? ` · ${t("epub.chaptersCount", { count: chaptersCount })}` : ""}
                                </span>
                                {charsRead > 0 && (
                                    <span>
                                        {charsRead.toLocaleString(language === "en" ? "en-US" : "ru-RU")}
                                    </span>
                                )}
                            </div>
                        </div>
                    );
                })}
            </div>
        </div>
    );
}
