import { useMemo, useState } from "react";
import type { Tab } from "../../utils/constants";
import { getTranslator, type AppLanguage } from "../../utils/i18n";
import { IconBookTab, IconClose, IconImport, IconSearch } from "../../components/Icons";

type LibraryLangFilter = "all" | "ja" | "en";
type LibrarySort = "recent" | "title" | "progress";

const UNKNOWN_AUTHOR_KEY = "__unknown__";

interface EpubLibraryProps {
    books: Tab[];
    coversByPath: Record<string, string | null>;
    language: AppLanguage;
    isMobile: boolean;
    onOpenFile: () => void;
    onSelectBook: (tabId: number) => void;
    onRemoveBook: (tabId: number) => void;
}

export default function EpubLibrary({
    books,
    coversByPath,
    language,
    isMobile,
    onOpenFile,
    onSelectBook,
    onRemoveBook,
}: EpubLibraryProps) {
    const t = getTranslator(language);
    const [query, setQuery] = useState("");
    const [langFilter, setLangFilter] = useState<LibraryLangFilter>("all");
    const [authorFilter, setAuthorFilter] = useState<string>("all");
    const [sortBy, setSortBy] = useState<LibrarySort>("recent");

    const activeBooks = useMemo(
        () => books.filter((tab) => !tab.archived),
        [books],
    );

    const { authors, hasUnknownAuthor } = useMemo(() => {
        const set = new Set<string>();
        let unknown = false;
        for (const book of activeBooks) {
            const author = book.epub?.author?.trim();
            if (author) set.add(author);
            else unknown = true;
        }
        return {
            authors: Array.from(set).sort((a, b) => a.localeCompare(b, language)),
            hasUnknownAuthor: unknown,
        };
    }, [activeBooks, language]);

    const filteredBooks = useMemo(() => {
        const q = query.trim().toLowerCase();
        const list = activeBooks.filter((book) => {
            const bookLang = book.epub?.language === "ja" ? "ja" : "en";
            if (langFilter !== "all" && bookLang !== langFilter) return false;

            const author = book.epub?.author?.trim() || "";
            if (authorFilter === UNKNOWN_AUTHOR_KEY) {
                if (author) return false;
            } else if (authorFilter !== "all" && author !== authorFilter) {
                return false;
            }

            if (q) {
                const title = (book.epub?.title || book.name || "").toLowerCase();
                if (!title.includes(q) && !author.toLowerCase().includes(q)) return false;
            }
            return true;
        });

        return [...list].sort((a, b) => {
            if (sortBy === "title") {
                const titleA = a.epub?.title || a.name || "";
                const titleB = b.epub?.title || b.name || "";
                return titleA.localeCompare(titleB, language);
            }
            if (sortBy === "progress") {
                return (b.epub?.progress || 0) - (a.epub?.progress || 0);
            }
            return (b.epub?.lastOpenedAt || b.id) - (a.epub?.lastOpenedAt || a.id);
        });
    }, [activeBooks, query, langFilter, authorFilter, sortBy, language]);

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
                        {t("epub.booksCount", { count: filteredBooks.length })}
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

            <div className="epub-library-filters">
                <div className="epub-library-search-wrap">
                    <span className="epub-library-search-icon" aria-hidden="true"><IconSearch /></span>
                    <input
                        type="search"
                        className="epub-library-search"
                        value={query}
                        onChange={(event) => setQuery(event.target.value)}
                        placeholder={t("epub.searchLibrary")}
                        aria-label={t("epub.searchLibrary")}
                    />
                </div>

                <div className="epub-library-filter-controls">
                    <div className="epub-segmented" role="group" aria-label={t("epub.allLanguages")}>
                        {(["all", "ja", "en"] as const).map((code) => (
                            <button
                                key={code}
                                type="button"
                                className={`epub-seg-btn${langFilter === code ? " is-active" : ""}`}
                                onClick={() => setLangFilter(code)}
                            >
                                {code === "all" ? t("epub.allLanguages") : code.toUpperCase()}
                            </button>
                        ))}
                    </div>

                    <select
                        className="epub-library-select"
                        aria-label={t("epub.allAuthors")}
                        value={authorFilter}
                        onChange={(event) => setAuthorFilter(event.target.value)}
                    >
                        <option value="all">{t("epub.allAuthors")}</option>
                        {authors.map((author) => (
                            <option key={author} value={author}>{author}</option>
                        ))}
                        {hasUnknownAuthor && authors.length > 0 && (
                            <option value={UNKNOWN_AUTHOR_KEY}>{t("epub.unknownAuthor")}</option>
                        )}
                    </select>

                    <select
                        className="epub-library-select"
                        aria-label={t("epub.sortRecent")}
                        value={sortBy}
                        onChange={(event) => setSortBy(event.target.value as LibrarySort)}
                    >
                        <option value="recent">{t("epub.sortRecent")}</option>
                        <option value="title">{t("epub.sortTitle")}</option>
                        <option value="progress">{t("epub.sortProgress")}</option>
                    </select>
                </div>
            </div>

            {filteredBooks.length === 0 ? (
                <div className="epub-library-empty-filter">
                    <span>{t("epub.noMatches")}</span>
                </div>
            ) : (
                <div className="epub-library-grid">
                    {filteredBooks.map((book, cardIdx) => {
                        const progress = Math.round(Math.min(1, Math.max(0, book.epub?.progress || 0)) * 100);
                        const bookLang = book.epub?.language === "ja" ? "JA" : "EN";
                        const chaptersCount = book.epub?.chapterCount || 0;
                        const title = book.epub?.title || book.name;
                        const author = book.epub?.author?.trim() || "";
                        const coverSrc = book.epub?.path ? coversByPath[book.epub.path] : null;

                        return (
                            <div
                                key={book.id}
                                className="epub-book-card"
                                style={{ ["--i" as string]: cardIdx }}
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
                                <div className="epub-book-cover-wrap">
                                    {coverSrc ? (
                                        <img
                                            className="epub-book-cover-img"
                                            src={coverSrc}
                                            alt={title}
                                            loading="lazy"
                                        />
                                    ) : (
                                        <div className="epub-book-cover-fallback" aria-hidden="true">
                                            <span className="epub-cover-fallback-icon"><IconBookTab /></span>
                                            <span className="epub-cover-fallback-title">{title}</span>
                                        </div>
                                    )}
                                    <div className="epub-book-cover-overlay">
                                        <span className="epub-badge epub-badge-glass">{bookLang}</span>
                                        <button
                                            type="button"
                                            className="epub-cover-remove-btn"
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

                                <div className="epub-book-card-body">
                                    <div className="epub-book-card-title" title={title}>{title}</div>
                                    {author && (
                                        <div className="epub-book-card-author" title={author}>{author}</div>
                                    )}

                                    <div className="epub-progress-track" aria-hidden="true">
                                        <div className="epub-progress-fill" style={{ width: `${progress}%` }} />
                                    </div>

                                    <div className="epub-book-card-meta">
                                        <span>{t("epub.progress", { percent: progress })}</span>
                                        {chaptersCount > 0 && (
                                            <span>{t("epub.chaptersCount", { count: chaptersCount })}</span>
                                        )}
                                    </div>
                                </div>
                            </div>
                        );
                    })}
                </div>
            )}
        </div>
    );
}
