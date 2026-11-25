import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import type { Tab } from "../../utils/constants";
import type { AppLanguage } from "../../utils/i18n";
import { compareNaturalStrings } from "../epub/epubLibraryModel";
import { checkMokuroStatus, runMokuroOnVolume, type MangaExportResult } from "./mangaApi";
import type { MangaMeta, MangaMokuroStatus } from "./mangaModel";
import "./mangaBatchMokuro.css";

interface MangaBatchMokuroModalProps {
    books: Tab[];
    initialSelectedIds?: number[];
    language: AppLanguage;
    onUpdateMangaMeta?: (tabId: number, meta: MangaMeta) => void;
    onConvertMangaToCbz?: (tabId: number) => Promise<MangaExportResult | null>;
    onSyncNow?: () => void;
    onClose: () => void;
}

type ItemRunState = "pending" | "running" | "converting" | "done" | "skipped" | "cancelled" | "error";

interface LiveMokuroProgress {
    stage: string;
    device: "cuda" | "cpu" | null;
    current: number | null;
    total: number | null;
    percent: number | null;
    eta: string | null;
    line: string;
}

function normalizeFsPath(p: string): string {
    return p.trim().replace(/\\/g, "/").toLowerCase();
}

export default function MangaBatchMokuroModal({
    books,
    initialSelectedIds,
    language,
    onUpdateMangaMeta,
    onConvertMangaToCbz,
    onSyncNow,
    onClose,
}: MangaBatchMokuroModalProps) {
    const isEn = language === "en";

    const sortedBooks = useMemo(
        () => [...books].sort((a, b) => compareNaturalStrings(a.epub?.title || a.name || "", b.epub?.title || b.name || "")),
        [books],
    );

    const [selectedIds, setSelectedIds] = useState<Set<number>>(() => {
        const validIds = new Set(books.map((b) => b.id));
        if (initialSelectedIds && initialSelectedIds.length > 0) {
            const picked = initialSelectedIds.filter((id) => validIds.has(id));
            if (picked.length > 0) return new Set(picked);
        }
        const withoutMokuro = books.filter((b) => !b.epub?.hasMokuro).map((b) => b.id);
        return new Set(withoutMokuro.length > 0 ? withoutMokuro : books.map((b) => b.id));
    });

    const [skipExisting, setSkipExisting] = useState<boolean>(() => {
        if (initialSelectedIds && initialSelectedIds.length > 0) {
            const validIds = new Set(initialSelectedIds);
            const initialBooks = books.filter((b) => validIds.has(b.id));
            if (initialBooks.length > 0 && initialBooks.every((b) => Boolean(b.epub?.hasMokuro))) {
                return false;
            }
        }
        return true;
    });
    const [autoConvertCbz, setAutoConvertCbz] = useState(false);
    const [mokuroStatus, setMokuroStatus] = useState<MangaMokuroStatus | null>(null);

    const [running, setRunning] = useState(false);
    const [stopRequested, setStopRequested] = useState(false);
    const [itemStates, setItemStates] = useState<Record<number, ItemRunState>>({});
    const [itemErrors, setItemErrors] = useState<Record<number, string>>({});
    const [queuePos, setQueuePos] = useState<{ index: number; total: number; title: string } | null>(null);
    const [liveProgress, setLiveProgress] = useState<LiveMokuroProgress | null>(null);
    const [summaryText, setSummaryText] = useState<string | null>(null);

    const cancelRequestedRef = useRef(false);
    const activePathRef = useRef<string | null>(null);

    useEffect(() => {
        let cancelled = false;
        void checkMokuroStatus()
            .then((st) => {
                if (!cancelled) setMokuroStatus(st);
            })
            .catch(() => {
                if (!cancelled) {
                    setMokuroStatus({ available: false, command: null, version: null });
                }
            });
        return () => {
            cancelled = true;
        };
    }, []);

    useEffect(() => {
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                if (!running) onClose();
            }
        };
        window.addEventListener("keydown", onKeyDown, true);
        return () => window.removeEventListener("keydown", onKeyDown, true);
    }, [running, onClose]);

    useEffect(() => {
        let unlisten: (() => void) | null = null;
        void listen<{
            path: string;
            status?: string;
            stage?: string;
            device?: "cuda" | "cpu" | null;
            current?: number | null;
            total?: number | null;
            percent?: number | null;
            eta?: string | null;
            line?: string;
        }>("manga_mokuro_progress", (event) => {
            const p = event.payload;
            const active = activePathRef.current;
            if (!p || !active || normalizeFsPath(p.path) !== normalizeFsPath(active)) return;
            setLiveProgress((prev) => ({
                stage: p.stage || prev?.stage || "running",
                device: p.device ?? prev?.device ?? null,
                current: typeof p.current === "number" ? p.current : (prev?.current ?? null),
                total: typeof p.total === "number" ? p.total : (prev?.total ?? null),
                percent: typeof p.percent === "number" ? p.percent : (prev?.percent ?? null),
                eta: p.eta ?? prev?.eta ?? null,
                line: p.line || prev?.line || "",
            }));
        }).then((fn) => {
            unlisten = fn;
        });
        return () => {
            unlisten?.();
        };
    }, []);

    const unOcrdBooks = useMemo(
        () => sortedBooks.filter((b) => !b.epub?.hasMokuro),
        [sortedBooks],
    );

    const toggleId = useCallback((id: number) => {
        if (running) return;
        setSelectedIds((prev) => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });
    }, [running]);

    const handleStart = useCallback(async () => {
        if (running) return;
        const queue = sortedBooks.filter((b) => selectedIds.has(b.id) && b.epub?.path);
        if (queue.length === 0) return;

        cancelRequestedRef.current = false;
        setStopRequested(false);
        setRunning(true);
        setSummaryText(null);
        setItemErrors({});

        const initialStates: Record<number, ItemRunState> = {};
        for (const item of queue) initialStates[item.id] = "pending";
        setItemStates(initialStates);

        let completedCount = 0;
        let skippedCount = 0;
        let errorCount = 0;
        let cancelledCount = 0;

        for (let i = 0; i < queue.length; i++) {
            const book = queue[i];
            const bookTitle = book.epub?.title || book.name;
            const path = book.epub?.path || "";

            if (cancelRequestedRef.current) {
                for (let j = i; j < queue.length; j++) {
                    const rem = queue[j];
                    setItemStates((prev) => ({ ...prev, [rem.id]: "cancelled" }));
                    cancelledCount += 1;
                }
                break;
            }

            if (skipExisting && book.epub?.hasMokuro) {
                setItemStates((prev) => ({ ...prev, [book.id]: "skipped" }));
                skippedCount += 1;
                continue;
            }

            setQueuePos({ index: i + 1, total: queue.length, title: bookTitle });
            setLiveProgress({
                stage: "starting",
                device: null,
                current: null,
                total: book.epub?.chapterCount || null,
                percent: null,
                eta: null,
                line: "",
            });
            setItemStates((prev) => ({ ...prev, [book.id]: "running" }));
            activePathRef.current = path;

            try {
                const meta = await runMokuroOnVolume(path);
                onUpdateMangaMeta?.(book.id, meta);

                if (autoConvertCbz && onConvertMangaToCbz) {
                    setItemStates((prev) => ({ ...prev, [book.id]: "converting" }));
                    await onConvertMangaToCbz(book.id);
                }

                setItemStates((prev) => ({ ...prev, [book.id]: "done" }));
                completedCount += 1;
            } catch (err) {
                setItemStates((prev) => ({ ...prev, [book.id]: "error" }));
                setItemErrors((prev) => ({ ...prev, [book.id]: String(err) }));
                errorCount += 1;
            } finally {
                activePathRef.current = null;
            }
        }

        setRunning(false);
        setStopRequested(false);
        setQueuePos(null);
        setLiveProgress(null);

        if (autoConvertCbz && completedCount > 0) {
            onSyncNow?.();
        }

        const parts = isEn
            ? [
                `Done: ${completedCount}`,
                skippedCount > 0 ? `skipped: ${skippedCount}` : "",
                errorCount > 0 ? `errors: ${errorCount}` : "",
                cancelledCount > 0 ? `cancelled: ${cancelledCount}` : "",
            ]
            : [
                `Готово: ${completedCount}`,
                skippedCount > 0 ? `пропущено: ${skippedCount}` : "",
                errorCount > 0 ? `ошибок: ${errorCount}` : "",
                cancelledCount > 0 ? `отменено: ${cancelledCount}` : "",
            ];
        setSummaryText(parts.filter(Boolean).join(" · "));
    }, [
        running,
        sortedBooks,
        selectedIds,
        skipExisting,
        autoConvertCbz,
        onUpdateMangaMeta,
        onConvertMangaToCbz,
        onSyncNow,
        isEn,
    ]);

    const handleStopAfterCurrent = useCallback(() => {
        cancelRequestedRef.current = true;
        setStopRequested(true);
    }, []);

    const stageLabel = useMemo(() => {
        if (!liveProgress) return isEn ? "Starting…" : "Запуск…";
        if (liveProgress.stage === "ocr" && liveProgress.current !== null && liveProgress.total) {
            return isEn
                ? `Scanning pages: ${liveProgress.current} / ${liveProgress.total} (${liveProgress.percent ?? 0}%)`
                : `Распознавание страниц: ${liveProgress.current} / ${liveProgress.total} (${liveProgress.percent ?? 0}%)`;
        }
        if (liveProgress.stage === "model_load") {
            return isEn ? "Loading manga-ocr neural model…" : "Загрузка нейросети manga-ocr…";
        }
        if (liveProgress.stage === "detector_init") {
            return isEn ? "Initializing speech-bubble detector…" : "Запуск детектора баблов…";
        }
        if (liveProgress.stage === "downloading") {
            return isEn ? "Downloading OCR weights…" : "Скачивание весов OCR…";
        }
        return isEn ? "Starting mokuro…" : "Запуск mokuro…";
    }, [liveProgress, isEn]);

    const stateLabel = (state: ItemRunState): string => {
        switch (state) {
            case "pending": return isEn ? "Queued" : "В очереди";
            case "running": return isEn ? "OCR…" : "Распознавание…";
            case "converting": return isEn ? "Packing CBZ…" : "В CBZ…";
            case "done": return isEn ? "✓ Done" : "✓ Готово";
            case "skipped": return isEn ? "Skipped" : "Пропущено";
            case "cancelled": return isEn ? "Cancelled" : "Отменено";
            case "error": return isEn ? "Error" : "Ошибка";
        }
    };

    const runnableCount = useMemo(() => {
        let count = 0;
        for (const b of sortedBooks) {
            if (!selectedIds.has(b.id) || !b.epub?.path) continue;
            if (skipExisting && b.epub?.hasMokuro) continue;
            count += 1;
        }
        return count;
    }, [sortedBooks, selectedIds, skipExisting]);

    return (
        <div
            className="epub-modal-backdrop"
            onClick={() => {
                if (!running) onClose();
            }}
        >
            <div
                className="epub-modal-card manga-batch-modal"
                role="dialog"
                aria-modal="true"
                aria-label={isEn ? "Batch Mokuro OCR" : "Пакетное распознавание Mokuro OCR"}
                onClick={(e) => e.stopPropagation()}
            >
                <div className="epub-modal-head">
                    <strong>{isEn ? "Batch Mokuro OCR" : "Прогон Mokuro OCR по томам"}</strong>
                    <button
                        type="button"
                        className="epub-glass-btn epub-glass-circle"
                        disabled={running}
                        title={isEn ? "Close" : "Закрыть"}
                        onClick={onClose}
                    >
                        ×
                    </button>
                </div>

                <p className="manga-batch-desc">
                    {isEn
                        ? "Runs mokuro CLI sequentially on selected volumes right from the library so speech bubbles become clickable."
                        : "Последовательно запускает mokuro CLI на выбранных томах прямо из библиотеки, чтобы баблы и японский текст стали кликабельными."}
                </p>

                <div className="manga-batch-cli-row">
                    <span className="manga-batch-cli-label">mokuro CLI:</span>
                    {mokuroStatus === null ? (
                        <span className="manga-batch-cli-val is-muted">{isEn ? "Checking…" : "Проверка…"}</span>
                    ) : mokuroStatus.available ? (
                        <span className="manga-batch-cli-val is-ok">
                            ✓ {mokuroStatus.command} {mokuroStatus.version ? `(${mokuroStatus.version})` : ""}
                        </span>
                    ) : (
                        <span className="manga-batch-cli-val is-warn">
                            {isEn ? "Not found" : "Не найден"}
                        </span>
                    )}
                </div>

                {mokuroStatus && !mokuroStatus.available && (
                    <div className="manga-batch-hint">
                        <span>{isEn ? "Install once in terminal:" : "Установи один раз в терминале:"}</span>
                        <code>pip install mokuro</code>
                    </div>
                )}

                <div className="manga-batch-options">
                    <label className="manga-batch-checkbox">
                        <input
                            type="checkbox"
                            disabled={running}
                            checked={skipExisting}
                            onChange={(e) => setSkipExisting(e.target.checked)}
                        />
                        <span>
                            {isEn
                                ? "Skip volumes that already have .mokuro"
                                : "Пропускать тома, где уже есть .mokuro"}
                        </span>
                    </label>
                    {onConvertMangaToCbz && (
                        <label className="manga-batch-checkbox">
                            <input
                                type="checkbox"
                                disabled={running}
                                checked={autoConvertCbz}
                                onChange={(e) => setAutoConvertCbz(e.target.checked)}
                            />
                            <span>
                                {isEn
                                    ? "Convert to CBZ after OCR (+ Google Drive sync)"
                                    : "После OCR сразу преобразовать в CBZ (+ синхр. Google Диск)"}
                            </span>
                        </label>
                    )}
                </div>

                {running && queuePos && (
                    <div className="manga-batch-live">
                        <div className="manga-batch-live-head">
                            <span className="manga-batch-live-title">
                                {isEn
                                    ? `Volume ${queuePos.index} of ${queuePos.total}: ${queuePos.title}`
                                    : `Том ${queuePos.index} из ${queuePos.total}: ${queuePos.title}`}
                            </span>
                            <span>{Math.round((queuePos.index / queuePos.total) * 100)}%</span>
                        </div>
                        <div className="manga-batch-track">
                            <div
                                className="manga-batch-fill"
                                style={{ width: `${Math.round(((queuePos.index - 1) / queuePos.total) * 100)}%` }}
                            />
                        </div>
                        <div className="manga-batch-live-sub">
                            <span>{stageLabel}</span>
                            {liveProgress?.device && (
                                <span className={`manga-batch-device-pill is-${liveProgress.device}`}>
                                    {liveProgress.device === "cuda" ? "⚡ GPU (CUDA)" : "CPU"}
                                </span>
                            )}
                        </div>
                        <div className="manga-batch-track is-secondary">
                            <div
                                className={`manga-batch-fill${liveProgress?.percent == null ? " is-indeterminate" : ""}`}
                                style={liveProgress?.percent != null ? { width: `${liveProgress.percent}%` } : undefined}
                            />
                        </div>
                        {liveProgress?.eta && (
                            <div className="manga-batch-live-sub">
                                <span>
                                    {isEn ? `ETA: ~${liveProgress.eta}` : `Осталось примерно: ~${liveProgress.eta}`}
                                </span>
                            </div>
                        )}
                    </div>
                )}

                {summaryText && <div className="manga-batch-summary">{summaryText}</div>}

                <div className="manga-batch-list-head">
                    <span className="manga-batch-list-count">
                        {isEn
                            ? `Selected: ${selectedIds.size} of ${sortedBooks.length}`
                            : `Выбрано: ${selectedIds.size} из ${sortedBooks.length}`}
                    </span>
                    <div className="manga-batch-list-actions">
                        {unOcrdBooks.length > 0 && (
                            <button
                                type="button"
                                className="epub-glass-btn"
                                disabled={running}
                                onClick={() => setSelectedIds(new Set(unOcrdBooks.map((b) => b.id)))}
                            >
                                {isEn
                                    ? `Without Mokuro (${unOcrdBooks.length})`
                                    : `Без Mokuro (${unOcrdBooks.length})`}
                            </button>
                        )}
                        <button
                            type="button"
                            className="epub-glass-btn"
                            disabled={running}
                            onClick={() => setSelectedIds(new Set(sortedBooks.map((b) => b.id)))}
                        >
                            {isEn ? "Select all" : "Все"}
                        </button>
                        <button
                            type="button"
                            className="epub-glass-btn"
                            disabled={running || selectedIds.size === 0}
                            onClick={() => setSelectedIds(new Set())}
                        >
                            {isEn ? "Clear" : "Снять"}
                        </button>
                    </div>
                </div>

                <div className="manga-batch-list">
                    {sortedBooks.map((book) => {
                        const checked = selectedIds.has(book.id);
                        const title = book.epub?.title || book.name;
                        const pages = book.epub?.chapterCount || 0;
                        const hasMokuro = Boolean(book.epub?.hasMokuro);
                        const isCbz = book.epub?.fileExt === "cbz";
                        const state = itemStates[book.id];
                        const errMsg = itemErrors[book.id];

                        return (
                            <label
                                key={book.id}
                                className={`manga-batch-item${checked ? " is-selected" : ""}${state === "running" || state === "converting" ? " is-running" : ""}`}
                            >
                                <div className="manga-batch-item-left">
                                    <input
                                        type="checkbox"
                                        disabled={running}
                                        checked={checked}
                                        onChange={() => toggleId(book.id)}
                                    />
                                    <div className="manga-batch-item-info">
                                        <span className="manga-batch-item-title" title={title}>{title}</span>
                                        <span className="manga-batch-item-meta">
                                            {pages > 0 && <span>{isEn ? `${pages} pp.` : `${pages} стр.`}</span>}
                                        </span>
                                        {errMsg && <span className="manga-batch-item-err">{errMsg}</span>}
                                    </div>
                                </div>
                                <div className="manga-batch-item-right">
                                    {hasMokuro && <span className="manga-batch-tag is-mokuro">MOKURO</span>}
                                    {isCbz && <span className="manga-batch-tag is-cbz">CBZ</span>}
                                    {state && (
                                        <span className={`manga-batch-state is-${state}`}>
                                            {stateLabel(state)}
                                        </span>
                                    )}
                                </div>
                            </label>
                        );
                    })}
                </div>

                <div className="epub-modal-foot">
                    {running ? (
                        <button
                            type="button"
                            className="epub-glass-btn"
                            disabled={stopRequested}
                            onClick={handleStopAfterCurrent}
                        >
                            {stopRequested
                                ? (isEn ? "Stopping after current volume…" : "Остановка после текущего тома…")
                                : (isEn ? "Stop after current" : "Остановить после текущего")}
                        </button>
                    ) : (
                        <>
                            <button type="button" className="epub-glass-btn" onClick={onClose}>
                                {isEn ? "Close" : "Закрыть"}
                            </button>
                            <button
                                type="button"
                                className="btn-primary"
                                disabled={runnableCount === 0 || (mokuroStatus !== null && !mokuroStatus.available)}
                                onClick={() => void handleStart()}
                            >
                                {isEn
                                    ? `Run Mokuro OCR (${runnableCount})`
                                    : `Запустить Mokuro OCR (${runnableCount})`}
                            </button>
                        </>
                    )}
                </div>
            </div>
        </div>
    );
}
