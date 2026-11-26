import { useEffect, useRef, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { IconClose, IconPlayerTab, IconSearch } from "../../components/Icons";
import { rankPosters, type Poster, type PosterSearch, type TitleHint } from "./posterModel";
import { createLocalPoster, deleteLocalPoster, isLocalPoster, readLocalPoster } from "./localPoster";
import TourHelpButton from "../onboarding/TourHelpButton";

let tmdbToken = "";

export function LibraryDialog({
    title,
    en,
    onClose,
    children,
    wide = false,
    showHelp = true,
}: {
    title: string;
    en: boolean;
    onClose: () => void;
    children: ReactNode;
    wide?: boolean;
    showHelp?: boolean;
}) {
    const dialog = useRef<HTMLDialogElement>(null);
    useEffect(() => {
        const element = dialog.current;
        element?.showModal();
        return () => element?.close();
    }, []);
    const handleBackdropMouseDown = (event: React.MouseEvent<HTMLDialogElement>) => {
        if (event.target !== event.currentTarget) return;
        if (event.clientX === 0 && event.clientY === 0) return;
        const rect = event.currentTarget.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) return;
        if (
            event.clientX < rect.left ||
            event.clientX > rect.right ||
            event.clientY < rect.top ||
            event.clientY > rect.bottom
        ) {
            onClose();
        }
    };
    return (
        <dialog
            ref={dialog}
            className={wide ? "sp-library-dialog is-wide" : "sp-library-dialog"}
            aria-label={title}
            onMouseDown={handleBackdropMouseDown}
            onCancel={(event) => {
                event.preventDefault();
                onClose();
            }}
        >
            <header className="sp-dialog-head">
                <h2>{title}</h2>
                <div className="sp-dialog-head-actions">
                    {showHelp && (
                        <TourHelpButton surface="mode:player" language={en ? "en" : "ru"} className="sp-dialog-help" />
                    )}
                    <button aria-label={en ? "Close" : "Закрыть"} onClick={onClose}>
                        <IconClose />
                    </button>
                </div>
            </header>
            {children}
        </dialog>
    );
}

export function PosterArt({ poster, label }: { poster?: Poster; label: string }) {
    const [failedUrl, setFailedUrl] = useState("");
    const [localImage, setLocalImage] = useState<{ key: string; url: string }>();
    const imageUrl = poster?.imageUrl || "";
    const local = isLocalPoster(poster);
    useEffect(() => {
        if (!poster || !local) return;
        let cancelled = false;
        let objectUrl = "";
        void readLocalPoster(poster)
            .then((blob) => {
                if (cancelled || !blob) return;
                objectUrl = URL.createObjectURL(blob);
                setLocalImage({ key: imageUrl, url: objectUrl });
            })
            .catch(console.warn);
        return () => {
            cancelled = true;
            if (objectUrl) URL.revokeObjectURL(objectUrl);
        };
    }, [imageUrl, local]);
    const resolvedUrl = local ? (localImage?.key === imageUrl ? localImage.url : "") : imageUrl;
    const show = !!resolvedUrl && failedUrl !== resolvedUrl;
    return (
        <div className="sp-poster-art" data-has-image={!!show}>
            {show ? (
                <img
                    src={resolvedUrl}
                    alt=""
                    loading="lazy"
                    decoding="async"
                    referrerPolicy="no-referrer"
                    onError={() => setFailedUrl(resolvedUrl)}
                />
            ) : (
                <div className="sp-poster-placeholder" aria-hidden="true">
                    <IconPlayerTab />
                    <span>{label}</span>
                </div>
            )}
        </div>
    );
}

export function PosterSource({ poster }: { poster: Poster }) {
    if (isLocalPoster(poster)) return <span className="sp-poster-source">{poster.source}</span>;
    return (
        <button
            type="button"
            className="sp-poster-source"
            title={poster.attribution || poster.source}
            onClick={() => {
                if (poster.pageUrl.startsWith("https://")) void openUrl(poster.pageUrl).catch(console.warn);
            }}
        >
            {poster.source} ↗
        </button>
    );
}

export function PosterPicker({
    initial,
    selected,
    en,
    onChoose,
    onClose,
}: {
    initial: TitleHint;
    selected?: Poster;
    en: boolean;
    onChoose: (poster?: Poster) => void;
    onClose: () => void;
}) {
    const [query, setQuery] = useState(initial.title);
    const [year, setYear] = useState(String(initial.year || ""));
    const [token, setToken] = useState(tmdbToken);
    const [source, setSource] = useState("");
    const [search, setSearch] = useState<PosterSearch>({ candidates: [], unavailable: [] });
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const [hasSearched, setHasSearched] = useState(false);
    const [importing, setImporting] = useState(false);
    const [importError, setImportError] = useState("");
    const fileInput = useRef<HTMLInputElement>(null);
    const localRequest = useRef(0);
    const request = useRef(0);
    const chooseFile = async (file: File) => {
        const id = ++localRequest.current;
        setImporting(true);
        setImportError("");
        let poster: Poster | undefined;
        try {
            poster = await createLocalPoster(file, initial);
            if (id !== localRequest.current) {
                await deleteLocalPoster(poster);
                return;
            }
            onChoose(poster);
        } catch (failure) {
            if (poster) void deleteLocalPoster(poster).catch(console.warn);
            if (id === localRequest.current) {
                const reason = failure instanceof Error ? failure.message : "";
                setImportError(
                    reason === "format"
                        ? en
                            ? "Choose a JPG, PNG or WebP image."
                            : "Выбери изображение JPG, PNG или WebP."
                        : reason === "size"
                          ? en
                              ? "Image is too large. Choose a file under 20 MB and 40 megapixels."
                              : "Изображение слишком большое. Выбери файл до 20 МБ и 40 мегапикселей."
                          : en
                            ? "Could not read or save the cover. Try another image or check available storage."
                            : "Не удалось прочитать или сохранить обложку. Попробуй другое изображение или проверь свободное место.",
                );
            }
        } finally {
            if (id === localRequest.current) setImporting(false);
        }
    };
    useEffect(
        () => () => {
            localRequest.current++;
        },
        [],
    );
    const runSearch = async () => {
        const name = query.trim();
        if (!name) return;
        const id = ++request.current;
        const releaseYear = Number(year);
        setBusy(true);
        setError("");
        setSource("");
        tmdbToken = token.trim();
        try {
            const response = await invoke<PosterSearch>("player_search_posters", {
                query: name,
                year: releaseYear || null,
                token: tmdbToken || null,
                language: en ? "en" : "ru",
            });
            if (id !== request.current) return;
            setSearch({ ...response, candidates: rankPosters(response.candidates, name, releaseYear) });
            setHasSearched(true);
        } catch (failure) {
            if (id === request.current) setError(String(failure));
        } finally {
            if (id === request.current) setBusy(false);
        }
    };
    useEffect(() => {
        // Start after the dialog mounts, with one network request in React Strict Mode.
        const timer = window.setTimeout(() => void runSearch(), 0);
        return () => {
            window.clearTimeout(timer);
            request.current++;
        };
    }, []);
    const sources = [...new Set(search.candidates.map((poster) => poster.source))];
    const tmdbUsed =
        token.trim() ||
        search.candidates.some((poster) => poster.source === "TMDB") ||
        search.unavailable.includes("TMDB");
    const candidates = source ? search.candidates.filter((poster) => poster.source === source) : search.candidates;

    return (
        <LibraryDialog title={en ? "Choose a poster" : "Выбрать обложку"} en={en} onClose={onClose} wide>
            <div className="sp-dialog-actions">
                <input
                    ref={fileInput}
                    type="file"
                    accept="image/jpeg,image/png,image/webp"
                    hidden
                    onChange={(event) => {
                        const file = event.target.files?.[0];
                        event.target.value = "";
                        if (file) void chooseFile(file);
                    }}
                />
                <button type="button" disabled={importing} onClick={() => fileInput.current?.click()}>
                    {en ? "From file…" : "Из файла…"}
                </button>
                {importing && <span role="status">{en ? "Saving cover…" : "Сохранение обложки…"}</span>}
                {importError && <span role="alert">{importError}</span>}
            </div>
            <form
                className="sp-poster-search"
                onSubmit={(event) => {
                    event.preventDefault();
                    void runSearch();
                }}
            >
                <label>
                    {en ? "Title" : "Название"}
                    <input
                        autoFocus
                        value={query}
                        required
                        maxLength={150}
                        onChange={(event) => setQuery(event.target.value)}
                    />
                </label>
                <label>
                    {en ? "Year" : "Год"}
                    <input
                        type="number"
                        min={1900}
                        max={2099}
                        value={year}
                        onChange={(event) => setYear(event.target.value)}
                    />
                </label>
                <button type="submit" className="sp-library-primary" disabled={busy || !query.trim()}>
                    <IconSearch /> {en ? "Search" : "Найти"}
                </button>
                <details className="sp-poster-tmdb">
                    <summary>{en ? "Add TMDB source" : "Подключить TMDB"}</summary>
                    <label>
                        {en ? "TMDB API Read Access Token" : "Токен чтения API TMDB"}
                        <input
                            type="password"
                            value={token}
                            autoComplete="off"
                            maxLength={2048}
                            onChange={(event) => setToken(event.target.value)}
                        />
                    </label>
                    <p>
                        {en
                            ? "Used for this session. To use TMDB on every launch, set SETSUNA_TMDB_TOKEN."
                            : "Токен действует до закрытия приложения. Для постоянного доступа задай SETSUNA_TMDB_TOKEN."}
                    </p>
                </details>
            </form>
            {sources.length > 1 && (
                <div className="sp-library-tabs">
                    {["", ...sources].map((item) => (
                        <button key={item} aria-pressed={item === source} onClick={() => setSource(item)}>
                            {item || (en ? "All sources" : "Все источники")}
                        </button>
                    ))}
                </div>
            )}
            <div className="sp-poster-results" aria-busy={busy}>
                {busy && <p role="status">{en ? "Searching catalogs…" : "Поиск по каталогам…"}</p>}
                {error && <p role="alert">{error}</p>}
                {!busy && hasSearched && !candidates.length && (
                    <p>
                        {en
                            ? "No posters found. Try the original title or a different spelling."
                            : "Обложек не найдено. Попробуй оригинальное название или другое написание."}
                    </p>
                )}
                {search.unavailable.length > 0 && (
                    <p className="sp-library-muted">
                        {en ? "Unavailable right now" : "Сейчас недоступны"} · {search.unavailable.join(", ")}
                    </p>
                )}
                <div className="sp-poster-options">
                    {candidates.map((poster) => (
                        <article key={poster.id} title={poster.attribution}>
                            <button
                                className="sp-poster-choice"
                                onClick={() => onChoose(poster)}
                                aria-label={(en ? "Use cover for " : "Выбрать обложку ") + poster.title}
                            >
                                <PosterArt poster={poster} label={poster.title} />
                                <strong>{poster.title}</strong>
                                {poster.year && <span>{poster.year}</span>}
                            </button>
                            <PosterSource poster={poster} />
                        </article>
                    ))}
                </div>
            </div>
            {tmdbUsed && (
                <div className="sp-poster-credits">
                    <button
                        type="button"
                        aria-label="The Movie Database"
                        onClick={() => void openUrl("https://www.themoviedb.org").catch(console.warn)}
                    >
                        <img
                            width="40"
                            src="https://upload.wikimedia.org/wikipedia/commons/8/89/Tmdb.new.logo.svg"
                            alt="TMDB"
                            referrerPolicy="no-referrer"
                        />
                    </button>
                    <div>
                        This product uses the TMDB API but is not endorsed or certified by TMDB.
                        <button
                            className="sp-credit-link"
                            type="button"
                            onClick={() =>
                                void openUrl("https://commons.wikimedia.org/wiki/File:Tmdb.new.logo.svg").catch(
                                    console.warn,
                                )
                            }
                        >
                            Travis Bell · CC BY-SA 4.0
                        </button>
                    </div>
                </div>
            )}
            {selected && (
                <footer className="sp-dialog-actions">
                    <button onClick={() => onChoose(undefined)}>
                        {en ? "Reset to folder title" : "Сбросить обложку и название"}
                    </button>
                </footer>
            )}
        </LibraryDialog>
    );
}
