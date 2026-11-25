import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Tab } from "../../utils/constants";
import type { EpubBookMetaPatch } from "../epub/EpubLibrary";
import { IconClose, IconSearch } from "../../components/Icons";
import { MOBILE_BACK_PRIORITY, useMobileBackHandler } from "../../utils/mobileBack";
import {
    fetchCatalogCoverDataUri,
    fetchCatalogSeriesVolumes,
    searchMangaCatalog,
    type CatalogVolumeCover,
    type MangaCatalogCandidate,
} from "./mangaApi";
import {
    extractVolumeNumberFromBook,
    extractVolumeNumberFromText,
    formatVolumeTitleWithSeries,
    inferBookCatalogQuery,
} from "./mangaModel";
import "./catalogPicker.css";

export interface CatalogApplyItem {
    tabId: number;
    patch: EpubBookMetaPatch;
    coverDataUrl?: string | null;
}

interface CatalogPickerModalProps {
    book: Tab;
    siblingBooks: Tab[];
    language: "ru" | "en";
    initialQueryHint?: string;
    importBanner?: string;
    skipLabel?: string;
    onClose: () => void;
    onApply: (
        updates: CatalogApplyItem[],
        fallbackCoverDataUrl?: string | null,
    ) => void;
}

function readImageFileAsDataUrl(file: File): Promise<string> {
    if (!/^image\/(jpeg|png|webp)$/i.test(file.type)) {
        return Promise.reject(new Error("format"));
    }
    if (file.size > 20 * 1024 * 1024) {
        return Promise.reject(new Error("size"));
    }
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ""));
        reader.onerror = () => reject(new Error("read"));
        reader.readAsDataURL(file);
    });
}

function extractNumericCatalogId(candidateId: string, prefix: string): string | null {
    return candidateId.startsWith(prefix) ? candidateId.slice(prefix.length) : null;
}

function volumeMatches(a: number | null | undefined, b: number | null | undefined): boolean {
    return typeof a === "number" && typeof b === "number" && Math.abs(a - b) < 1e-4;
}

export default function CatalogPickerModal({
    book,
    siblingBooks,
    language,
    initialQueryHint,
    importBanner,
    skipLabel,
    onClose,
    onApply,
}: CatalogPickerModalProps) {
    const isEn = language === "en";
    const [query, setQuery] = useState(() => {
        const direct = inferBookCatalogQuery({
            title: book.epub?.title || book.name,
            series: book.epub?.series,
            path: book.epub?.path,
        });
        if (direct) return direct;
        return initialQueryHint
            ? inferBookCatalogQuery({ title: initialQueryHint, path: initialQueryHint })
            : "";
    });
    const [script, setScript] = useState<"native" | "romaji">("native");
    const [applyTitle, setApplyTitle] = useState(true);
    const [applyCover, setApplyCover] = useState(true);
    const [applySiblings, setApplySiblings] = useState(siblingBooks.length > 0);
    const [candidates, setCandidates] = useState<MangaCatalogCandidate[]>([]);
    const [unavailable, setUnavailable] = useState<string[]>([]);
    const [searching, setSearching] = useState(false);
    const [applying, setApplying] = useState(false);
    const [hasSearched, setHasSearched] = useState(false);
    const [error, setError] = useState("");

    // Step 2: per-volume cover & title picker after choosing a series
    const detectedBookVol = useMemo(
        () =>
            extractVolumeNumberFromBook({
                title: book.epub?.title,
                name: book.name,
                seriesPosition: book.epub?.seriesPosition,
                path: book.epub?.path,
            }) ?? extractVolumeNumberFromText(initialQueryHint),
        [book, initialQueryHint],
    );
    const [selectedSeries, setSelectedSeries] = useState<MangaCatalogCandidate | null>(null);
    const [seriesVolumes, setSeriesVolumes] = useState<CatalogVolumeCover[]>([]);
    const [volumesLoading, setVolumesLoading] = useState(false);
    const [selectedImageUrl, setSelectedImageUrl] = useState<string>("");
    const [failedCoverUrls, setFailedCoverUrls] = useState<Record<string, true>>({});
    const [manualVolInput, setManualVolInput] = useState<string>(() =>
        detectedBookVol !== null ? String(detectedBookVol) : "",
    );

    const fileInputRef = useRef<HTMLInputElement>(null);
    const reqIdRef = useRef(0);
    const volReqIdRef = useRef(0);

    const seriesCandidates = useMemo(
        () => candidates.filter((c) => typeof c.volumeNumber !== "number" || c.volumeNumber <= 0),
        [candidates],
    );
    const directVolumeCandidates = useMemo(
        () => candidates.filter((c) => typeof c.volumeNumber === "number" && c.volumeNumber > 0),
        [candidates],
    );

    const markCoverFailed = useCallback((url: string) => {
        if (!url) return;
        setFailedCoverUrls((prev) => (prev[url] ? prev : { ...prev, [url]: true }));
        setSelectedImageUrl((prev) => (prev === url && selectedSeries ? selectedSeries.imageUrl : prev));
    }, [selectedSeries]);

    const runSearch = useCallback(async (q: string) => {
        const trimmed = q.trim();
        if (!trimmed) return;
        const id = ++reqIdRef.current;
        setSearching(true);
        setError("");
        setFailedCoverUrls({});
        try {
            const res = await searchMangaCatalog(trimmed);
            if (id !== reqIdRef.current) return;
            setCandidates(res.candidates);
            setUnavailable(res.unavailable);
            setHasSearched(true);
        } catch (err) {
            if (id !== reqIdRef.current) return;
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            if (id === reqIdRef.current) setSearching(false);
        }
    }, []);

    useEffect(() => {
        if (query.trim()) {
            const timer = window.setTimeout(() => void runSearch(query), 0);
            return () => {
                window.clearTimeout(timer);
                reqIdRef.current += 1;
            };
        }
        return () => {
            reqIdRef.current += 1;
        };
    }, []);

    useEffect(() => {
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key !== "Escape") return;
            event.preventDefault();
            event.stopPropagation();
            if (selectedSeries) {
                volReqIdRef.current += 1;
                setSelectedSeries(null);
                setSeriesVolumes([]);
            } else {
                onClose();
            }
        };
        window.addEventListener("keydown", onKeyDown, true);
        return () => window.removeEventListener("keydown", onKeyDown, true);
    }, [onClose, selectedSeries]);

    useMobileBackHandler(Boolean(selectedSeries), MOBILE_BACK_PRIORITY.MODAL + 5, () => {
        volReqIdRef.current += 1;
        setSelectedSeries(null);
        setSeriesVolumes([]);
        setError("");
    });
    useMobileBackHandler(!selectedSeries, MOBILE_BACK_PRIORITY.MODAL, () => {
        onClose();
    });

    const openSeriesStep = useCallback(
        async (
            candidate: MangaCatalogCandidate,
            overrideVol?: number | null,
            overrideImageUrl?: string,
            seedVolumes?: CatalogVolumeCover[],
        ) => {
            const effectiveVol = overrideVol ?? detectedBookVol ?? extractVolumeNumberFromText(query);
            setSelectedSeries(candidate);
            setSelectedImageUrl(overrideImageUrl || candidate.imageUrl);
            setSeriesVolumes(seedVolumes ?? []);
            setFailedCoverUrls({});
            setError("");
            setManualVolInput(effectiveVol !== null ? String(effectiveVol) : "");

            const reqId = ++volReqIdRef.current;
            setVolumesLoading(true);
            try {
                const vols = await fetchCatalogSeriesVolumes({
                    title: candidate.title,
                    nativeTitle: candidate.nativeTitle,
                    anilistId: extractNumericCatalogId(candidate.id, "anilist:manga:"),
                    malId: extractNumericCatalogId(candidate.id, "jikan:manga:"),
                    format: candidate.format,
                    targetVolume: effectiveVol !== null ? String(effectiveVol) : undefined,
                });
                if (reqId !== volReqIdRef.current) return;
                const byVol = new Map<string, CatalogVolumeCover>();
                for (const v of vols) byVol.set(v.volume, v);
                for (const s of seedVolumes ?? []) {
                    if (!byVol.has(s.volume)) byVol.set(s.volume, s);
                }
                const mergedVols = Array.from(byVol.values()).sort(
                    (a, b) => (a.volumeNumber ?? Number.MAX_SAFE_INTEGER) - (b.volumeNumber ?? Number.MAX_SAFE_INTEGER),
                );
                setSeriesVolumes(mergedVols);
                if (!overrideImageUrl && effectiveVol !== null) {
                    const matched = mergedVols.find((v) => volumeMatches(v.volumeNumber, effectiveVol));
                    if (matched) setSelectedImageUrl(matched.imageUrl);
                }
            } catch {
                // Keep seeded / series covers as fallback if per-volume fetch fails
            } finally {
                if (reqId === volReqIdRef.current) setVolumesLoading(false);
            }
        },
        [detectedBookVol, query],
    );

    const normalizeDirectSeriesCandidate = useCallback((candidate: MangaCatalogCandidate): MangaCatalogCandidate => {
        const cleanBase = inferBookCatalogQuery({ title: candidate.title }) || candidate.title;
        const lowerBase = cleanBase.toLowerCase();
        const matchedSeries = seriesCandidates.find(
            (s) => s.nativeTitle?.trim() === cleanBase || s.title.trim().toLowerCase() === lowerBase,
        );
        if (matchedSeries) return matchedSeries;
        return {
            ...candidate,
            title: cleanBase,
            nativeTitle: cleanBase,
            volume: null,
            volumeNumber: null,
        };
    }, [seriesCandidates]);

    const parsedManualVol = useMemo(() => {
        const cleaned = manualVolInput.trim().replace(",", ".");
        if (!cleaned) return null;
        const n = Number(cleaned);
        return Number.isFinite(n) && n > 0 && n < 5000 ? n : null;
    }, [manualVolInput]);

    const chosenSeriesName = useMemo(() => {
        if (!selectedSeries) return "";
        return script === "native" && selectedSeries.nativeTitle?.trim()
            ? selectedSeries.nativeTitle.trim()
            : selectedSeries.title.trim();
    }, [selectedSeries, script]);

    const applyCandidateSelection = async (
        seriesCandidate: MangaCatalogCandidate,
        overrideImageUrl?: string,
        overrideVol?: number | null,
        volsForSiblings?: CatalogVolumeCover[],
    ) => {
        if (applying) return;
        setApplying(true);
        setError("");
        try {
            const downloadCache = new Map<string, Promise<string>>();
            const fetchCachedCover = (url: string) => {
                let pending = downloadCache.get(url);
                if (!pending) {
                    pending = fetchCatalogCoverDataUri(url);
                    downloadCache.set(url, pending);
                }
                return pending;
            };

            const seriesName =
                script === "native" && seriesCandidate.nativeTitle?.trim()
                    ? seriesCandidate.nativeTitle.trim()
                    : seriesCandidate.title.trim();
            const primaryImageUrl = overrideImageUrl || selectedImageUrl || seriesCandidate.imageUrl;
            const effectivePrimaryVol = overrideVol !== undefined ? overrideVol : parsedManualVol;
            const volumePool = volsForSiblings ?? seriesVolumes;
            const targets = applySiblings && siblingBooks.length > 0 ? [book, ...siblingBooks] : [book];

            const updates: CatalogApplyItem[] = await Promise.all(
                targets.map(async (item) => {
                    const isPrimary = item.id === book.id;
                    const itemVol = isPrimary
                        ? effectivePrimaryVol
                        : extractVolumeNumberFromBook({
                            title: item.epub?.title,
                            name: item.name,
                            seriesPosition: item.epub?.seriesPosition,
                            path: item.epub?.path,
                        });

                    const patch: EpubBookMetaPatch = {};
                    if (applyTitle) {
                        patch.series = seriesName;
                        if (itemVol !== null) {
                            patch.seriesPosition = itemVol;
                        }
                        patch.title = formatVolumeTitleWithSeries(
                            seriesName,
                            item.epub?.title || item.name || "",
                            itemVol,
                            item.epub?.path,
                        );
                        if (seriesCandidate.author) patch.author = seriesCandidate.author;
                    }

                    let coverDataUrl: string | null | undefined;
                    if (applyCover) {
                        const volMatch =
                            itemVol !== null
                                ? volumePool.find((v) => volumeMatches(v.volumeNumber, itemVol))
                                : undefined;
                        const coverUrl = isPrimary
                            ? primaryImageUrl
                            : volMatch?.imageUrl || primaryImageUrl;
                        if (coverUrl) {
                            coverDataUrl = await fetchCachedCover(coverUrl).catch(() => null);
                        }
                    }

                    return { tabId: item.id, patch, coverDataUrl };
                }),
            );

            const primaryCover = updates.find((u) => u.tabId === book.id)?.coverDataUrl ?? null;
            onApply(updates, primaryCover);
            onClose();
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setApplying(false);
        }
    };

    const handleApplySelection = (overrideImageUrl?: string, overrideVol?: number | null) => {
        if (!selectedSeries) return Promise.resolve();
        return applyCandidateSelection(selectedSeries, overrideImageUrl, overrideVol);
    };

    const handleLocalCover = async (file: File) => {
        setError("");
        try {
            const dataUrl = await readImageFileAsDataUrl(file);
            onApply([{ tabId: book.id, patch: {}, coverDataUrl: dataUrl }], dataUrl);
            onClose();
        } catch (err) {
            const code = err instanceof Error ? err.message : "";
            setError(
                code === "format"
                    ? isEn ? "Choose a JPG, PNG or WebP file." : "Выбери файл JPG, PNG или WebP."
                    : code === "size"
                      ? isEn ? "Image exceeds 20 MB." : "Файл больше 20 МБ."
                      : isEn ? "Failed to read image file." : "Не удалось прочитать изображение.",
            );
        }
    };

    const visibleSeriesVolumes = useMemo(
        () => seriesVolumes.filter((v) => !failedCoverUrls[v.imageUrl]),
        [seriesVolumes, failedCoverUrls],
    );
    const showSeriesFallbackCard = Boolean(
        selectedSeries
        && !failedCoverUrls[selectedSeries.imageUrl]
        && !visibleSeriesVolumes.some((v) => v.imageUrl === selectedSeries.imageUrl),
    );

    const selectedSeriesAlt =
        selectedSeries && script === "native" && selectedSeries.nativeTitle && selectedSeries.nativeTitle !== selectedSeries.title
            ? selectedSeries.title
            : selectedSeries?.nativeTitle && script === "romaji" && selectedSeries.nativeTitle !== selectedSeries.title
              ? selectedSeries.nativeTitle
              : "";

    const previewTitle = selectedSeries
        ? formatVolumeTitleWithSeries(
            chosenSeriesName,
            book.epub?.title || book.name || "",
            parsedManualVol,
            book.epub?.path,
        )
        : "";

    return (
        <div className="epub-modal-backdrop" onClick={onClose}>
            <div
                className="epub-modal-card mcp-modal"
                role="dialog"
                aria-modal="true"
                aria-label={isEn ? "Find title & cover" : "Поиск тайтла и обложки"}
                onClick={(e) => e.stopPropagation()}
            >
                <div className="epub-modal-head">
                    <div className="mcp-head-title-wrap">
                        {selectedSeries && (
                            <button
                                type="button"
                                className="epub-glass-btn"
                                onClick={() => {
                                    volReqIdRef.current += 1;
                                    setSelectedSeries(null);
                                    setSeriesVolumes([]);
                                    setError("");
                                }}
                            >
                                ← {isEn ? "Back" : "Назад"}
                            </button>
                        )}
                        <strong>
                            {selectedSeries
                                ? (isEn ? "Choose volume cover & title" : "Выбери обложку тома и название")
                                : (isEn ? "Find title & cover" : "Найти тайтл и обложку")}
                        </strong>
                    </div>
                    <div className="mcp-head-actions">
                        {skipLabel && (
                            <button type="button" className="epub-glass-btn" onClick={onClose}>
                                {skipLabel}
                            </button>
                        )}
                        <button
                            type="button"
                            className="epub-glass-btn epub-glass-circle"
                            onClick={onClose}
                            aria-label={isEn ? "Close" : "Закрыть"}
                        >
                            <IconClose />
                        </button>
                    </div>
                </div>

                {importBanner && <div className="mcp-import-banner">{importBanner}</div>}

                {!selectedSeries ? (
                    <>
                        <form
                            className="mcp-search-row"
                            onSubmit={(e) => {
                                e.preventDefault();
                                void runSearch(query);
                            }}
                        >
                            <input
                                type="search"
                                className="epub-bookmark-input"
                                autoFocus
                                value={query}
                                onChange={(e) => setQuery(e.target.value)}
                                placeholder={isEn ? "Title from folder / filename…" : "Название из папки или файла…"}
                            />
                            <button type="submit" className="btn-primary" disabled={searching || !query.trim()}>
                                <IconSearch /> {searching ? (isEn ? "Searching…" : "Поиск…") : isEn ? "Search" : "Найти"}
                            </button>
                            <input
                                ref={fileInputRef}
                                type="file"
                                accept="image/jpeg,image/png,image/webp"
                                hidden
                                onChange={(e) => {
                                    const f = e.target.files?.[0];
                                    e.target.value = "";
                                    if (f) void handleLocalCover(f);
                                }}
                            />
                            <button
                                type="button"
                                className="epub-glass-btn"
                                onClick={() => fileInputRef.current?.click()}
                            >
                                {isEn ? "From file…" : "Из файла…"}
                            </button>
                        </form>

                        <div className="mcp-controls-bar">
                            <div className="mcp-toggles">
                                <label>
                                    <input
                                        type="checkbox"
                                        checked={applyTitle}
                                        onChange={(e) => setApplyTitle(e.target.checked)}
                                    />
                                    {isEn ? "Title & series" : "Название и серия"}
                                </label>
                                <label>
                                    <input
                                        type="checkbox"
                                        checked={applyCover}
                                        onChange={(e) => setApplyCover(e.target.checked)}
                                    />
                                    {isEn ? "Cover" : "Обложка"}
                                </label>
                                {siblingBooks.length > 0 && (
                                    <label>
                                        <input
                                            type="checkbox"
                                            checked={applySiblings}
                                            onChange={(e) => setApplySiblings(e.target.checked)}
                                        />
                                        {isEn
                                            ? `All ${siblingBooks.length + 1} volumes in series`
                                            : `Все тома серии (${siblingBooks.length + 1})`}
                                    </label>
                                )}
                            </div>

                            <div className="mcp-script-switch" role="group" aria-label={isEn ? "Title language" : "Язык названия"}>
                                <button
                                    type="button"
                                    className={script === "native" ? "is-active" : ""}
                                    onClick={() => setScript("native")}
                                >
                                    日本語
                                </button>
                                <button
                                    type="button"
                                    className={script === "romaji" ? "is-active" : ""}
                                    onClick={() => setScript("romaji")}
                                >
                                    Romaji
                                </button>
                            </div>
                        </div>

                        {error && <div className="mcp-error" role="alert">{error}</div>}
                        {unavailable.length > 0 && candidates.length === 0 && !error && (
                            <div className="mcp-error">
                                {isEn ? `Unavailable: ${unavailable.join(", ")}` : `Недоступно: ${unavailable.join(", ")}`}
                            </div>
                        )}

                        <div className="mcp-results-scroll">
                            {seriesCandidates.length > 0 && (
                                <div className="mcp-results">
                                    {seriesCandidates.map((c) => {
                                        const primary = script === "native" && c.nativeTitle ? c.nativeTitle : c.title;
                                        const secondary = script === "native" && c.nativeTitle && c.nativeTitle !== c.title ? c.title : "";
                                        return (
                                            <button
                                                key={c.id}
                                                type="button"
                                                className="mcp-card"
                                                onClick={() => void openSeriesStep(c)}
                                            >
                                                <img
                                                    className="mcp-card-img"
                                                    src={c.imageUrl}
                                                    alt={primary}
                                                    loading="lazy"
                                                    referrerPolicy="no-referrer"
                                                />
                                                <div className="mcp-card-meta">
                                                    <div className="mcp-card-title">{primary}</div>
                                                    {secondary && <div className="mcp-card-sub">{secondary}</div>}
                                                    {c.author && <div className="mcp-card-sub">{c.author}</div>}
                                                    <div className="mcp-card-badges">
                                                        {c.year && <span>{c.year}</span>}
                                                        <span>{c.format}</span>
                                                        <span>{c.source}</span>
                                                        <span>{isEn ? "Volumes →" : "Тома →"}</span>
                                                    </div>
                                                </div>
                                            </button>
                                        );
                                    })}
                                </div>
                            )}

                            {directVolumeCandidates.length > 0 && (
                                <>
                                    <div className="mcp-vol-section-head">
                                        <span>
                                            {isEn
                                                ? "Volume covers (Apple Books JP — click to preview, double-click to apply)"
                                                : "Обложки по томам (Apple Books JP — клик открыть, двойной клик применить)"}
                                        </span>
                                    </div>
                                    <div className="mcp-volumes-grid-inline">
                                        {directVolumeCandidates.map((c) => {
                                            const volLabel = c.volume || String(c.volumeNumber);
                                            const directSeries = normalizeDirectSeriesCandidate(c);
                                            const baseTitle = inferBookCatalogQuery({ title: c.title }) || c.title;
                                            const appleVolPool: CatalogVolumeCover[] = directVolumeCandidates
                                                .filter(
                                                    (v) =>
                                                        typeof v.volumeNumber === "number"
                                                        && (inferBookCatalogQuery({ title: v.title }) || v.title) === baseTitle,
                                                )
                                                .map((v) => ({
                                                    volume: v.volume || String(v.volumeNumber),
                                                    volumeNumber: v.volumeNumber,
                                                    title: v.title,
                                                    imageUrl: v.imageUrl,
                                                    source: v.source,
                                                }));
                                            return (
                                                <button
                                                    key={c.id}
                                                    type="button"
                                                    className="mcp-vol-card"
                                                    disabled={applying}
                                                    onClick={() =>
                                                        void openSeriesStep(
                                                            directSeries,
                                                            c.volumeNumber ?? null,
                                                            c.imageUrl,
                                                            appleVolPool,
                                                        )
                                                    }
                                                    onDoubleClick={() =>
                                                        void applyCandidateSelection(
                                                            directSeries,
                                                            c.imageUrl,
                                                            c.volumeNumber ?? null,
                                                            appleVolPool,
                                                        )
                                                    }
                                                >
                                                    <img
                                                        src={c.imageUrl}
                                                        alt={c.title}
                                                        loading="lazy"
                                                        referrerPolicy="no-referrer"
                                                    />
                                                    <div className="mcp-vol-cap">
                                                        <strong>{isEn ? `Vol. ${volLabel}` : `Том ${volLabel}`}</strong>
                                                        <span>{c.title}</span>
                                                    </div>
                                                </button>
                                            );
                                        })}
                                    </div>
                                </>
                            )}

                            {!searching && hasSearched && candidates.length === 0 && (
                                <div className="mcp-empty">
                                    {isEn ? "Nothing found. Try a shorter query." : "Ничего не найдено. Попробуй сократить запрос."}
                                </div>
                            )}
                        </div>
                    </>
                ) : (
                    <>
                        <div className="mcp-series-summary">
                            <div className="mcp-series-summary-text">
                                <div className="mcp-series-summary-title">{chosenSeriesName}</div>
                                {selectedSeriesAlt && <div className="mcp-series-summary-sub">{selectedSeriesAlt}</div>}
                            </div>
                            <div className="mcp-script-switch" role="group" aria-label={isEn ? "Title language" : "Язык названия"}>
                                <button
                                    type="button"
                                    className={script === "native" ? "is-active" : ""}
                                    onClick={() => setScript("native")}
                                >
                                    日本語
                                </button>
                                <button
                                    type="button"
                                    className={script === "romaji" ? "is-active" : ""}
                                    onClick={() => setScript("romaji")}
                                >
                                    Romaji
                                </button>
                            </div>
                        </div>

                        <div className="mcp-controls-bar">
                            <div className="mcp-toggles">
                                <label>
                                    <input
                                        type="checkbox"
                                        checked={applyTitle}
                                        onChange={(e) => setApplyTitle(e.target.checked)}
                                    />
                                    {isEn ? "Title & series" : "Название и серия"}
                                </label>
                                <label>
                                    <input
                                        type="checkbox"
                                        checked={applyCover}
                                        onChange={(e) => setApplyCover(e.target.checked)}
                                    />
                                    {isEn ? "Cover" : "Обложка"}
                                </label>
                                {siblingBooks.length > 0 && (
                                    <label>
                                        <input
                                            type="checkbox"
                                            checked={applySiblings}
                                            onChange={(e) => setApplySiblings(e.target.checked)}
                                        />
                                        {isEn
                                            ? `Match each of ${siblingBooks.length + 1} volumes`
                                            : `Подобрать для всех томов (${siblingBooks.length + 1})`}
                                    </label>
                                )}
                            </div>

                            {(!applySiblings || siblingBooks.length === 0) && (
                                <div className="mcp-vol-input-row">
                                    <span>{isEn ? "Vol.:" : "Том:"}</span>
                                    <input
                                        type="number"
                                        step="any"
                                        min={1}
                                        className="mcp-vol-num-input"
                                        value={manualVolInput}
                                        placeholder="—"
                                        onChange={(e) => setManualVolInput(e.target.value)}
                                    />
                                    {applyTitle && (
                                        <span className="mcp-preview-pill" title={previewTitle}>
                                            → {previewTitle}
                                        </span>
                                    )}
                                </div>
                            )}
                        </div>

                        {error && <div className="mcp-error" role="alert">{error}</div>}

                        <div className="mcp-volumes-grid">
                            {showSeriesFallbackCard && selectedSeries && (
                                <button
                                    type="button"
                                    className={`mcp-vol-card${selectedImageUrl === selectedSeries.imageUrl ? " is-selected" : ""}`}
                                    onClick={() => setSelectedImageUrl(selectedSeries.imageUrl)}
                                    onDoubleClick={() => void handleApplySelection(selectedSeries.imageUrl, parsedManualVol)}
                                >
                                    <img
                                        src={selectedSeries.imageUrl}
                                        alt={chosenSeriesName}
                                        loading="lazy"
                                        referrerPolicy="no-referrer"
                                        onError={() => markCoverFailed(selectedSeries.imageUrl)}
                                    />
                                    <div className="mcp-vol-cap">
                                        <strong>{isEn ? "Series cover" : "Общая обложка"}</strong>
                                        <span>{selectedSeries.source}</span>
                                    </div>
                                </button>
                            )}

                            {visibleSeriesVolumes.map((vol) => {
                                const isChosen = selectedImageUrl === vol.imageUrl;
                                const isDetected = volumeMatches(vol.volumeNumber, parsedManualVol);
                                return (
                                    <button
                                        key={`${vol.source}-${vol.volume}`}
                                        type="button"
                                        className={`mcp-vol-card${isChosen ? " is-selected" : ""}${isDetected ? " is-detected" : ""}`}
                                        title={vol.title || `${isEn ? "Volume" : "Том"} ${vol.volume}`}
                                        onClick={() => {
                                            setSelectedImageUrl(vol.imageUrl);
                                            if (typeof vol.volumeNumber === "number" && (!applySiblings || siblingBooks.length === 0)) {
                                                setManualVolInput(String(vol.volumeNumber));
                                            }
                                        }}
                                        onDoubleClick={() => {
                                            const nextVol = typeof vol.volumeNumber === "number" ? vol.volumeNumber : parsedManualVol;
                                            void handleApplySelection(vol.imageUrl, nextVol);
                                        }}
                                    >
                                        <img
                                            src={vol.imageUrl}
                                            alt={vol.title || vol.volume}
                                            loading="lazy"
                                            referrerPolicy="no-referrer"
                                            onError={() => markCoverFailed(vol.imageUrl)}
                                        />
                                        <div className="mcp-vol-cap">
                                            <strong>
                                                {isEn ? `Vol. ${vol.volume}` : `Том ${vol.volume}`}
                                            </strong>
                                            <span className="mcp-vol-source">{vol.title || vol.source}</span>
                                        </div>
                                    </button>
                                );
                            })}

                            {volumesLoading && (
                                <div className="mcp-vol-loading">
                                    {isEn ? "Loading individual volume covers…" : "Поиск обложек по томам (Apple Books / MangaDex)…"}
                                </div>
                            )}

                            {!volumesLoading && visibleSeriesVolumes.length === 0 && (
                                <div className="mcp-vol-loading">
                                    {isEn
                                        ? "No separate volume covers loaded — series cover will be used."
                                        : "Отдельные обложки томов не загрузились — можно использовать общую обложку или загрузить файл."}
                                </div>
                            )}
                        </div>

                        <div className="epub-modal-foot">
                            <button type="button" className="epub-glass-btn" onClick={() => {
                                volReqIdRef.current += 1;
                                setSelectedSeries(null);
                                setSeriesVolumes([]);
                            }}>
                                ← {isEn ? "Back" : "Назад"}
                            </button>
                            <button
                                type="button"
                                className="btn-primary"
                                disabled={applying}
                                onClick={() => void handleApplySelection()}
                            >
                                {applying
                                    ? (isEn ? "Applying…" : "Применение…")
                                    : (isEn ? "Apply" : "Применить")}
                            </button>
                        </div>
                    </>
                )}
            </div>
        </div>
    );
}
