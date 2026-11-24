import {
    useCallback,
    useEffect,
    useMemo,
    useRef,
    useState,
    type CSSProperties,
    type TouchEvent as ReactTouchEvent,
    type WheelEvent as ReactWheelEvent,
} from "react";
import { listen } from "@tauri-apps/api/event";
import { open, save } from "@tauri-apps/plugin-dialog";
import { TokenizedLine } from "../../components/TextContainer";
import type { AppSettings } from "../../components/SettingsModal";
import { IconSettings } from "../../components/Icons";
import type { AppLanguage } from "../../utils/i18n";
import { setMobileVolumePagingEnabled } from "../../utils/mobileFiles";
import {
    attachMokuroOverlay,
    checkMokuroStatus,
    exportMangaMobileCbz,
    loadMangaOverrides,
    loadMangaPage,
    runMokuroOnVolume,
    saveMangaOverride,
} from "./mangaApi";
import {
    applyBlockTextOverrides,
    buildSpreadPairs,
    computeBubbleCropRect,
    computeFittedBubbleFontPx,
    findSpreadIndexForPage,
    joinMokuroLines,
    loadMangaPrefs,
    saveMangaPrefs,
    type MangaCropMode,
    type MangaMeta,
    type MangaMokuroStatus,
    type MangaOverlayMode,
    type MangaPagePayload,
    type MangaReaderPrefs,
    type MangaSpreadMode,
    type MokuroBlock,
} from "./mangaModel";
import {
    detectAndroidPageBlocksMlKit,
    getAndroidMangaOcrStatus,
    hasAndroidMangaOcrBridge,
    loadMangaOcrPrefs,
    normalizeOcrServerUrl,
    recognizeMangaCrop,
} from "./mangaOcr";
import "./manga.css";

const MAX_CACHED_PAGES = 18;

type LookupMatch = { start: number; length: number };
type LookupTokenHandler = (
    token: string,
    sentence: string,
    cursor: number,
    boundaries?: number[],
    lemma?: string,
) => LookupMatch | null | void | Promise<LookupMatch | null | void>;

interface MangaReaderProps {
    tabId: number;
    mangaPath: string;
    meta: MangaMeta;
    initialPage: number;
    settings: AppSettings;
    language: AppLanguage;
    isMobile: boolean;
    lookupOpen?: boolean;
    onBackToLibrary: () => void;
    onMetaUpdated: (meta: MangaMeta) => void;
    onProgressChange: (pageIndex: number, progress: number) => void;
    onRecordReadingStats?: (deltaChars: number, deltaSeconds: number) => void;
    onLookupToken?: LookupTokenHandler;
    onAnkiScreenshot?: (dataUrl: string | null) => void;
    onCloseLookup?: () => void;
    onMobileImmersiveChange?: (immersive: boolean) => void;
}

async function renderMangaCropDataUrl(
    imageSrc: string,
    box: [number, number, number, number] | null,
    cropMode: MangaCropMode,
): Promise<string | null> {
    if (!imageSrc) return null;
    return new Promise((resolve) => {
        const img = new Image();
        img.onload = () => {
            try {
                const natW = img.naturalWidth || 1;
                const natH = img.naturalHeight || 1;
                const rect = cropMode === "bubble" && box
                    ? computeBubbleCropRect(box, natW, natH)
                    : { x: 0, y: 0, width: natW, height: natH };
                const maxSide = 1400;
                const scale = Math.min(1, maxSide / Math.max(rect.width, rect.height));
                const outW = Math.max(1, Math.round(rect.width * scale));
                const outH = Math.max(1, Math.round(rect.height * scale));
                const canvas = document.createElement("canvas");
                canvas.width = outW;
                canvas.height = outH;
                const ctx = canvas.getContext("2d");
                if (!ctx) {
                    resolve(null);
                    return;
                }
                ctx.drawImage(img, rect.x, rect.y, rect.width, rect.height, 0, 0, outW, outH);
                resolve(canvas.toDataURL("image/jpeg", 0.86));
            } catch {
                resolve(null);
            }
        };
        img.onerror = () => resolve(null);
        img.src = imageSrc;
    });
}

async function cropExactRegionBase64(
    imageSrc: string,
    box: [number, number, number, number],
    maxSide = 768,
): Promise<string | null> {
    if (!imageSrc) return null;
    return new Promise((resolve) => {
        const img = new Image();
        img.onload = () => {
            try {
                const natW = img.naturalWidth || 1;
                const natH = img.naturalHeight || 1;
                const x1 = Math.max(0, Math.min(natW - 1, Math.floor(box[0])));
                const y1 = Math.max(0, Math.min(natH - 1, Math.floor(box[1])));
                const x2 = Math.max(x1 + 1, Math.min(natW, Math.ceil(box[2])));
                const y2 = Math.max(y1 + 1, Math.min(natH, Math.ceil(box[3])));
                const rw = Math.max(1, x2 - x1);
                const rh = Math.max(1, y2 - y1);
                const scale = Math.min(1, maxSide / Math.max(rw, rh));
                const outW = Math.max(1, Math.round(rw * scale));
                const outH = Math.max(1, Math.round(rh * scale));
                const canvas = document.createElement("canvas");
                canvas.width = outW;
                canvas.height = outH;
                const ctx = canvas.getContext("2d");
                if (!ctx) {
                    resolve(null);
                    return;
                }
                ctx.fillStyle = "#ffffff";
                ctx.fillRect(0, 0, outW, outH);
                ctx.drawImage(img, x1, y1, rw, rh, 0, 0, outW, outH);
                const dataUrl = canvas.toDataURL("image/jpeg", 0.92);
                const comma = dataUrl.indexOf(",");
                resolve(comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl);
            } catch {
                resolve(null);
            }
        };
        img.onerror = () => resolve(null);
        img.src = imageSrc;
    });
}

async function imageToScaledBase64(
    imageSrc: string,
    maxSide = 1600,
): Promise<{ base64: string; scaleX: number; scaleY: number } | null> {
    if (!imageSrc) return null;
    return new Promise((resolve) => {
        const img = new Image();
        img.onload = () => {
            try {
                const natW = img.naturalWidth || 1;
                const natH = img.naturalHeight || 1;
                const scale = Math.min(1, maxSide / Math.max(natW, natH));
                const outW = Math.max(1, Math.round(natW * scale));
                const outH = Math.max(1, Math.round(natH * scale));
                const canvas = document.createElement("canvas");
                canvas.width = outW;
                canvas.height = outH;
                const ctx = canvas.getContext("2d");
                if (!ctx) {
                    resolve(null);
                    return;
                }
                ctx.drawImage(img, 0, 0, outW, outH);
                const dataUrl = canvas.toDataURL("image/jpeg", 0.9);
                const comma = dataUrl.indexOf(",");
                resolve({
                    base64: comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl,
                    scaleX: natW / outW,
                    scaleY: natH / outH,
                });
            } catch {
                resolve(null);
            }
        };
        img.onerror = () => resolve(null);
        img.src = imageSrc;
    });
}

function formatOcrEngineLabel(engine: string, device: string | null | undefined, isEn: boolean): string {
    if (engine === "pc-local" || engine === "remote-pc") {
        return device === "cuda" ? (isEn ? "PC ⚡ GPU" : "ПК ⚡ GPU") : (isEn ? "PC OCR" : "ПК OCR");
    }
    if (engine === "onnx") return "ONNX INT8";
    if (engine === "mlkit") return "ML Kit";
    return engine;
}

export default function MangaReader({
    tabId,
    mangaPath,
    meta,
    initialPage,
    settings,
    language,
    isMobile,
    lookupOpen = false,
    onBackToLibrary,
    onMetaUpdated,
    onProgressChange,
    onRecordReadingStats,
    onLookupToken,
    onAnkiScreenshot,
    onCloseLookup,
    onMobileImmersiveChange,
}: MangaReaderProps) {
    const isEn = language === "en";
    const [prefs, setPrefs] = useState<MangaReaderPrefs>(() => {
        const loaded = loadMangaPrefs();
        return isMobile && loaded.spreadMode === "spread"
            ? { ...loaded, spreadMode: "single" }
            : loaded;
    });
    const [currentPage, setCurrentPage] = useState(() =>
        Math.max(0, Math.min(Math.max(0, meta.pageCount - 1), initialPage)),
    );
    const [zoom, setZoom] = useState(1);
    const [controlsOpen, setControlsOpen] = useState(false);
    const [mokuroModalOpen, setMokuroModalOpen] = useState(false);
    const [chromeVisible, setChromeVisible] = useState(true);
    const [pagesByIndex, setPagesByIndex] = useState<Record<number, MangaPagePayload>>({});
    const [overrides, setOverrides] = useState<Record<number, Record<number, string>>>({});
    const [activeBubble, setActiveBubble] = useState<{ pageIndex: number; blockIndex: number } | null>(null);
    const [editingBubble, setEditingBubble] = useState<{
        pageIndex: number;
        blockIndex: number;
        text: string;
    } | null>(null);

    // Mokuro CLI integration (Desktop)
    const [mokuroStatus, setMokuroStatus] = useState<MangaMokuroStatus | null>(null);
    const [mokuroRunning, setMokuroRunning] = useState(false);
    const [mokuroProgress, setMokuroProgress] = useState<{
        stage: string;
        device: "cuda" | "cpu" | null;
        current: number | null;
        total: number | null;
        percent: number | null;
        eta: string | null;
        line: string;
    } | null>(null);
    const [mokuroError, setMokuroError] = useState<string | null>(null);
    const [exportingCbz, setExportingCbz] = useState(false);
    const [exportStatus, setExportStatus] = useState<{ ok: boolean; message: string } | null>(null);

    // Interactive on-demand OCR crop tool & ML Kit mobile auto-scan
    const [cropToolActive, setCropToolActive] = useState(false);
    const [cropDrag, setCropDrag] = useState<{
        pageIndex: number;
        startX: number;
        startY: number;
        curX: number;
        curY: number;
    } | null>(null);
    const [ocrBusy, setOcrBusy] = useState<string | null>(null);
    const [ocrError, setOcrError] = useState<string | null>(null);
    const [ocrResult, setOcrResult] = useState<{
        pageIndex: number;
        box: [number, number, number, number];
        text: string;
        engine: string;
        device?: string | null;
        elapsedMs: number;
    } | null>(null);
    const [sessionBlocksByPage, setSessionBlocksByPage] = useState<Record<number, MokuroBlock[]>>({});
    const [mobileOcrReady, setMobileOcrReady] = useState<{
        onnxReady: boolean;
        onnxDownloading: boolean;
        hasRemote: boolean;
    } | null>(null);

    const pageCacheRef = useRef<Map<number, MangaPagePayload>>(new Map());
    const loadingSetRef = useRef<Set<number>>(new Set());
    const highWaterPageRef = useRef<number>(initialPage);
    const pageEnteredAtRef = useRef<number>(Date.now());
    const touchStartRef = useRef<{ x: number; y: number; time: number } | null>(null);
    const viewportRef = useRef<HTMLDivElement>(null);

    // Once the dictionary popup closes, drop the pinned bubble (CSS :hover still
    // keeps it visible if the pointer is actually over it).
    const prevLookupOpenRef = useRef(lookupOpen);
    useEffect(() => {
        if (prevLookupOpenRef.current && !lookupOpen) setActiveBubble(null);
        prevLookupOpenRef.current = lookupOpen;
    }, [lookupOpen]);

    const updatePrefs = useCallback((patch: Partial<MangaReaderPrefs>) => {
        setPrefs((prev) => {
            const next = { ...prev, ...patch };
            saveMangaPrefs(next);
            return next;
        });
    }, []);

    // Reset caches when switching volume
    useEffect(() => {
        pageCacheRef.current.clear();
        loadingSetRef.current.clear();
        setPagesByIndex({});
        const clamped = Math.max(0, Math.min(Math.max(0, meta.pageCount - 1), initialPage));
        setCurrentPage(clamped);
        highWaterPageRef.current = clamped;
        pageEnteredAtRef.current = Date.now();
        setActiveBubble(null);
        setEditingBubble(null);
        setSessionBlocksByPage({});
        setOcrResult(null);
        setOcrError(null);
        setExportStatus(null);
        setCropToolActive(false);
        setZoom(1);
        void loadMangaOverrides(mangaPath).then(setOverrides).catch(() => setOverrides({}));
    }, [tabId, mangaPath]);

    // Refresh page cache when mokuro overlay gets newly attached/generated
    const mokuroKey = `${meta.hasMokuro}|${meta.mokuroPath || ""}`;
    useEffect(() => {
        pageCacheRef.current.clear();
        loadingSetRef.current.clear();
        setPagesByIndex({});
    }, [mokuroKey]);

    // Sync mobile immersive bar visibility
    useEffect(() => {
        onMobileImmersiveChange?.(isMobile && !chromeVisible);
        return () => onMobileImmersiveChange?.(false);
    }, [isMobile, chromeVisible, onMobileImmersiveChange]);

    // Android hardware volume-key paging
    useEffect(() => {
        if (!isMobile || settings.epubVolumeKeyPaging === false) return;
        setMobileVolumePagingEnabled(true);
        return () => setMobileVolumePagingEnabled(false);
    }, [isMobile, settings.epubVolumeKeyPaging]);

    const spreadPairs = useMemo(
        () => buildSpreadPairs(meta.pageCount, isMobile && prefs.spreadMode === "spread" ? "single" : prefs.spreadMode, prefs.coverOffset),
        [meta.pageCount, prefs.spreadMode, prefs.coverOffset, isMobile],
    );

    const currentSpreadIdx = useMemo(
        () => findSpreadIndexForPage(spreadPairs, currentPage),
        [spreadPairs, currentPage],
    );

    const visiblePages = useMemo(() => {
        if (prefs.spreadMode === "webtoon") {
            const start = Math.max(0, currentPage - 1);
            const end = Math.min(meta.pageCount - 1, currentPage + 4);
            const list: number[] = [];
            for (let i = start; i <= end; i += 1) list.push(i);
            return list;
        }
        return spreadPairs[currentSpreadIdx] || [0];
    }, [prefs.spreadMode, spreadPairs, currentSpreadIdx, currentPage, meta.pageCount]);

    const ensurePageLoaded = useCallback((pageIdx: number) => {
        if (pageIdx < 0 || pageIdx >= meta.pageCount) return;
        if (pageCacheRef.current.has(pageIdx) || loadingSetRef.current.has(pageIdx)) return;
        loadingSetRef.current.add(pageIdx);
        void loadMangaPage(mangaPath, pageIdx)
            .then((payload) => {
                pageCacheRef.current.set(pageIdx, payload);
                while (pageCacheRef.current.size > MAX_CACHED_PAGES) {
                    const oldest = pageCacheRef.current.keys().next().value;
                    if (typeof oldest === "number" && !visiblePages.includes(oldest)) {
                        pageCacheRef.current.delete(oldest);
                    } else {
                        break;
                    }
                }
                setPagesByIndex((prev) => ({ ...prev, [pageIdx]: payload }));
            })
            .catch(() => {})
            .finally(() => {
                loadingSetRef.current.delete(pageIdx);
            });
    }, [mangaPath, meta.pageCount, visiblePages]);

    // Load visible pages + prefetch next 2 and previous 1
    useEffect(() => {
        const toLoad = new Set<number>(visiblePages);
        const maxVisible = visiblePages[visiblePages.length - 1] ?? currentPage;
        const minVisible = visiblePages[0] ?? currentPage;
        toLoad.add(maxVisible + 1);
        toLoad.add(maxVisible + 2);
        if (minVisible > 0) toLoad.add(minVisible - 1);
        for (const idx of toLoad) {
            ensurePageLoaded(idx);
        }
    }, [visiblePages, currentPage, ensurePageLoaded]);

    // Report progress & monotonic reading stats
    useEffect(() => {
        const maxPage = Math.max(1, meta.pageCount - 1);
        const progress = meta.pageCount <= 1 ? 1 : Math.max(0, Math.min(1, currentPage / maxPage));
        onProgressChange(currentPage, progress);

        if (currentPage > highWaterPageRef.current && onRecordReadingStats) {
            const elapsedSec = Math.max(1, Math.min(120, Math.round((Date.now() - pageEnteredAtRef.current) / 1000)));
            let deltaChars = 0;
            for (let p = highWaterPageRef.current; p < currentPage; p += 1) {
                deltaChars += meta.pages[p]?.charCount || 0;
            }
            highWaterPageRef.current = currentPage;
            if (deltaChars > 0 || elapsedSec >= 2) {
                onRecordReadingStats(deltaChars, elapsedSec);
            }
        }
        pageEnteredAtRef.current = Date.now();
    }, [currentPage, meta.pageCount, meta.pages, onProgressChange, onRecordReadingStats]);

    const goNext = useCallback(() => {
        setActiveBubble(null);
        setEditingBubble(null);
        if (prefs.spreadMode === "webtoon") {
            setCurrentPage((p) => Math.min(meta.pageCount - 1, p + 1));
            return;
        }
        const nextIdx = Math.min(spreadPairs.length - 1, currentSpreadIdx + 1);
        const target = spreadPairs[nextIdx]?.[0];
        if (typeof target === "number") setCurrentPage(target);
    }, [prefs.spreadMode, meta.pageCount, spreadPairs, currentSpreadIdx]);

    const goPrev = useCallback(() => {
        setActiveBubble(null);
        setEditingBubble(null);
        if (prefs.spreadMode === "webtoon") {
            setCurrentPage((p) => Math.max(0, p - 1));
            return;
        }
        const prevIdx = Math.max(0, currentSpreadIdx - 1);
        const target = spreadPairs[prevIdx]?.[0];
        if (typeof target === "number") setCurrentPage(target);
    }, [prefs.spreadMode, spreadPairs, currentSpreadIdx]);

    // Listen for Android volume keys
    useEffect(() => {
        if (!isMobile || settings.epubVolumeKeyPaging === false) return;
        const onVolKey = (ev: Event) => {
            const dir = (ev as CustomEvent<string>).detail;
            if (dir === "next") goNext();
            else if (dir === "prev") goPrev();
        };
        window.addEventListener("setsuna-volume-key", onVolKey);
        return () => window.removeEventListener("setsuna-volume-key", onVolKey);
    }, [isMobile, settings.epubVolumeKeyPaging, goNext, goPrev]);

    // Keyboard navigation
    useEffect(() => {
        const onKeyDown = (event: KeyboardEvent) => {
            if (editingBubble) return;
            const target = event.target as HTMLElement | null;
            if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) return;

            if (event.key === "ArrowLeft") {
                event.preventDefault();
                if (prefs.rtl) goNext();
                else goPrev();
            } else if (event.key === "ArrowRight") {
                event.preventDefault();
                if (prefs.rtl) goPrev();
                else goNext();
            } else if (event.key === " " || event.key === "PageDown") {
                event.preventDefault();
                goNext();
            } else if (event.key === "PageUp") {
                event.preventDefault();
                goPrev();
            } else if (event.key === "Home") {
                event.preventDefault();
                setCurrentPage(0);
            } else if (event.key === "End") {
                event.preventDefault();
                setCurrentPage(Math.max(0, meta.pageCount - 1));
            } else if (event.key.toLowerCase() === "o" && !event.ctrlKey && !event.altKey) {
                const order: MangaOverlayMode[] = ["hover", "outline", "readable"];
                const next = order[(order.indexOf(prefs.overlayMode) + 1) % order.length];
                updatePrefs({ overlayMode: next });
            } else if (event.key.toLowerCase() === "d" && !event.ctrlKey && !event.altKey && !isMobile) {
                updatePrefs({ spreadMode: prefs.spreadMode === "spread" ? "single" : "spread" });
            } else if (event.key.toLowerCase() === "c" && !event.ctrlKey && !event.altKey) {
                updatePrefs({ coverOffset: !prefs.coverOffset });
            } else if (event.key.toLowerCase() === "s" && !event.ctrlKey && !event.altKey) {
                setCropToolActive((v) => !v);
            } else if (event.key === "Escape") {
                if (cropToolActive) setCropToolActive(false);
                else if (ocrResult || ocrError) {
                    setOcrResult(null);
                    setOcrError(null);
                }
            } else if (event.key === "=" || event.key === "+") {
                setZoom((z) => Math.min(3, Number((z + 0.15).toFixed(2))));
            } else if (event.key === "-") {
                setZoom((z) => Math.max(0.5, Number((z - 0.15).toFixed(2))));
            } else if (event.key === "0") {
                setZoom(1);
            }
        };
        window.addEventListener("keydown", onKeyDown);
        return () => window.removeEventListener("keydown", onKeyDown);
    }, [editingBubble, cropToolActive, ocrResult, ocrError, prefs.rtl, prefs.overlayMode, prefs.spreadMode, prefs.coverOffset, isMobile, meta.pageCount, goNext, goPrev, updatePrefs]);

    // Check mokuro CLI availability when opening the OCR modal on desktop, or ONNX/ML Kit status on mobile
    useEffect(() => {
        if (!mokuroModalOpen) return;
        setExportStatus(null);
        if (!isMobile) {
            void checkMokuroStatus().then(setMokuroStatus).catch(() => {});
        } else {
            const p = loadMangaOcrPrefs();
            const hasRemote = normalizeOcrServerUrl(p.remoteUrl).length > 0;
            void getAndroidMangaOcrStatus()
                .then((st) =>
                    setMobileOcrReady({
                        onnxReady: st.onnxReady,
                        onnxDownloading: st.onnxDownloading,
                        hasRemote,
                    }),
                )
                .catch(() => setMobileOcrReady({ onnxReady: false, onnxDownloading: false, hasRemote }));
        }
    }, [mokuroModalOpen, isMobile]);

    // Listen to mokuro CLI progress events (real-time CR/LF tqdm updates + GPU/CPU detection)
    useEffect(() => {
        if (isMobile) return;
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
            if (!p || p.path !== mangaPath) return;
            setMokuroProgress((prev) => ({
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
    }, [mangaPath, isMobile]);

    // Prepare Anki panel crop whenever the user interacts with a bubble
    const prepareAnkiPanelCrop = useCallback(
        (page: MangaPagePayload, block: MokuroBlock) => {
            if (!onAnkiScreenshot) return;
            void renderMangaCropDataUrl(page.imageSrc, block.box, prefs.cropMode).then((dataUrl) => {
                if (dataUrl) onAnkiScreenshot(dataUrl);
            });
        },
        [onAnkiScreenshot, prefs.cropMode],
    );

    // Clear manga screenshot when unmounting reader
    useEffect(() => {
        return () => {
            onAnkiScreenshot?.(null);
        };
    }, [onAnkiScreenshot]);

    const handleAttachMokuroFile = useCallback(async () => {
        try {
            const selected = await open({
                multiple: false,
                directory: false,
                filters: [{ name: "Mokuro OCR (.mokuro)", extensions: ["mokuro", "gz"] }],
            });
            const mpath = typeof selected === "string" ? selected.trim() : "";
            if (!mpath) return;
            setMokuroError(null);
            const updated = await attachMokuroOverlay(mangaPath, mpath);
            onMetaUpdated(updated);
            setMokuroModalOpen(false);
        } catch (error) {
            setMokuroError(String(error));
        }
    }, [mangaPath, onMetaUpdated]);

    const handleRunMokuroCli = useCallback(async () => {
        if (mokuroRunning) return;
        setMokuroRunning(true);
        setMokuroError(null);
        setMokuroProgress({
            stage: "starting",
            device: null,
            current: null,
            total: meta.pageCount,
            percent: null,
            eta: null,
            line: "",
        });
        try {
            const updated = await runMokuroOnVolume(mangaPath);
            onMetaUpdated(updated);
            setMokuroModalOpen(false);
        } catch (error) {
            setMokuroError(String(error));
        } finally {
            setMokuroRunning(false);
        }
    }, [mokuroRunning, mangaPath, meta.pageCount, onMetaUpdated]);

    const handleExportMobileCbz = useCallback(async () => {
        if (exportingCbz) return;
        try {
            const safeTitle = (meta.title || "manga").replace(/[\\/:*?"<>|]/g, "_").trim() || "manga";
            const outputPath = await save({
                defaultPath: `${safeTitle}.cbz`,
                filters: [{ name: "Comic Book Archive (.cbz)", extensions: ["cbz"] }],
            });
            const target = typeof outputPath === "string" ? outputPath.trim() : "";
            if (!target) return;
            setExportingCbz(true);
            setExportStatus(null);
            const res = await exportMangaMobileCbz(mangaPath, target);
            const mb = (res.bytes / (1024 * 1024)).toFixed(1);
            setExportStatus({
                ok: true,
                message: isEn
                    ? `Packed ${res.pageCount} pages (${mb} MB)${res.hasMokuro ? " with .mokuro OCR embedded" : " (images only)"}.`
                    : `Упаковано ${res.pageCount} стр. (${mb} МБ)${res.hasMokuro ? " · слой .mokuro встроен" : " · только картинки"}.`,
            });
        } catch (error) {
            setExportStatus({
                ok: false,
                message: String(error),
            });
        } finally {
            setExportingCbz(false);
        }
    }, [exportingCbz, meta.title, mangaPath, isEn]);

    const handleRunBubbleCropOcr = useCallback(
        async (page: MangaPagePayload, box: [number, number, number, number]) => {
            setCropToolActive(false);
            setOcrError(null);
            setOcrResult(null);
            setOcrBusy(isEn ? "Recognizing bubble…" : "Распознавание бабла…");
            prepareAnkiPanelCrop(page, {
                box,
                vertical: (box[3] - box[1]) > (box[2] - box[0]) * 1.1,
                fontSize: 32,
                lines: [],
            });
            try {
                const base64 = await cropExactRegionBase64(page.imageSrc, box, 768);
                if (!base64) throw new Error(isEn ? "Failed to crop image region." : "Не удалось вырезать область.");
                const res = await recognizeMangaCrop(base64, loadMangaOcrPrefs(), isMobile);
                setOcrResult({
                    pageIndex: page.index,
                    box,
                    text: res.text.trim(),
                    engine: res.engine,
                    device: res.device,
                    elapsedMs: res.elapsedMs,
                });
            } catch (error) {
                setOcrError(error instanceof Error ? error.message : String(error));
            } finally {
                setOcrBusy(null);
            }
        },
        [isEn, isMobile, prepareAnkiPanelCrop],
    );

    const handleAutoScanPage = useCallback(async () => {
        const page = pagesByIndex[currentPage];
        if (!page || !hasAndroidMangaOcrBridge()) return;
        setMokuroModalOpen(false);
        setOcrError(null);
        setOcrResult(null);
        setOcrBusy(isEn ? "Scanning page with ML Kit…" : "Поиск баблов на странице (ML Kit)…");
        try {
            const scaled = await imageToScaledBase64(page.imageSrc, 1600);
            if (!scaled) throw new Error("Failed to prepare page image.");
            const detected = await detectAndroidPageBlocksMlKit(scaled.base64);
            if (!detected.blocks || detected.blocks.length === 0) {
                setOcrError(isEn ? "No Japanese text detected on this page." : "Текст на этой странице не найден.");
                return;
            }
            const ocrPrefs = loadMangaOcrPrefs();
            const status = await getAndroidMangaOcrStatus().catch(() => ({
                onnxReady: false,
                onnxDownloading: false,
                onnxSizeBytes: 0,
                mlkitReady: true,
            }));
            const canRefine = ocrPrefs.autoRefineMlKitWithOnnx &&
                (status.onnxReady || normalizeOcrServerUrl(ocrPrefs.remoteUrl).length > 0 || ocrPrefs.mobileEngine === "remote" || ocrPrefs.mobileEngine === "onnx");

            const capped = detected.blocks.slice(0, 24);
            const built: MokuroBlock[] = [];
            for (let i = 0; i < capped.length; i += 1) {
                const blk = capped[i];
                const natBox: [number, number, number, number] = [
                    Math.round(blk.box[0] * scaled.scaleX),
                    Math.round(blk.box[1] * scaled.scaleY),
                    Math.round(blk.box[2] * scaled.scaleX),
                    Math.round(blk.box[3] * scaled.scaleY),
                ];
                let text = blk.text;
                if (canRefine) {
                    setOcrBusy(
                        isEn
                            ? `Refining bubble ${i + 1} / ${capped.length}…`
                            : `Уточнение бабла ${i + 1} / ${capped.length}…`,
                    );
                    const cropB64 = await cropExactRegionBase64(page.imageSrc, natBox, 512);
                    if (cropB64) {
                        const refined = await recognizeMangaCrop(cropB64, ocrPrefs, true).catch(() => null);
                        if (refined?.text?.trim()) text = refined.text.trim();
                    }
                }
                const bw = Math.max(12, natBox[2] - natBox[0]);
                const bh = Math.max(12, natBox[3] - natBox[1]);
                built.push({
                    box: natBox,
                    vertical: blk.vertical,
                    fontSize: Math.max(20, Math.min(48, Math.round((blk.vertical ? bw : bh) * 0.48))),
                    lines: [text],
                });
            }
            setSessionBlocksByPage((prev) => ({
                ...prev,
                [currentPage]: built,
            }));
        } catch (error) {
            setOcrError(error instanceof Error ? error.message : String(error));
        } finally {
            setOcrBusy(null);
        }
    }, [pagesByIndex, currentPage, isEn]);

    const handlePinOcrResultAsBubble = useCallback(() => {
        if (!ocrResult || !ocrResult.text.trim()) return;
        const { pageIndex, box, text } = ocrResult;
        const bw = Math.max(12, box[2] - box[0]);
        const bh = Math.max(12, box[3] - box[1]);
        const vertical = bh > bw * 1.1;
        const newBlock: MokuroBlock = {
            box,
            vertical,
            fontSize: Math.max(22, Math.min(48, Math.round((vertical ? bw : bh) * 0.48))),
            lines: text.split(/\r?\n/).map((s) => s.trim()).filter(Boolean),
        };
        setSessionBlocksByPage((prev) => ({
            ...prev,
            [pageIndex]: [...(prev[pageIndex] || []), newBlock],
        }));
        setOcrResult(null);
    }, [ocrResult]);

    const handleSaveBubbleEdit = useCallback(async () => {
        if (!editingBubble) return;
        const { pageIndex, blockIndex, text } = editingBubble;
        if (pageIndex < 0) {
            setOcrResult((prev) => (prev ? { ...prev, text } : prev));
            setEditingBubble(null);
            return;
        }
        const payload = pagesByIndex[pageIndex];
        const baseCount = payload?.blocks?.length ?? 0;
        if (blockIndex >= baseCount) {
            const localIdx = blockIndex - baseCount;
            setSessionBlocksByPage((prev) => {
                const arr = [...(prev[pageIndex] || [])];
                if (arr[localIdx]) {
                    const lines = text.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
                    arr[localIdx] = { ...arr[localIdx], lines: lines.length > 0 ? lines : [text] };
                }
                return { ...prev, [pageIndex]: arr };
            });
            setEditingBubble(null);
            return;
        }
        try {
            await saveMangaOverride(mangaPath, pageIndex, blockIndex, text);
            setOverrides((prev) => {
                const pageMap = { ...(prev[pageIndex] || {}) };
                if (text.trim()) pageMap[blockIndex] = text.trim();
                else delete pageMap[blockIndex];
                return { ...prev, [pageIndex]: pageMap };
            });
            setEditingBubble(null);
        } catch {
            // Keep open on error
        }
    }, [editingBubble, mangaPath, pagesByIndex]);

    const handleWheel = useCallback((event: ReactWheelEvent<HTMLDivElement>) => {
        if (event.ctrlKey) {
            event.preventDefault();
            const delta = event.deltaY < 0 ? 0.12 : -0.12;
            setZoom((z) => Math.max(0.5, Math.min(3, Number((z + delta).toFixed(2)))));
        }
    }, []);

    const handleTouchStart = useCallback((event: ReactTouchEvent<HTMLDivElement>) => {
        if (event.touches.length !== 1) return;
        const touch = event.touches[0];
        touchStartRef.current = { x: touch.clientX, y: touch.clientY, time: Date.now() };
    }, []);

    const handleTouchEnd = useCallback((event: ReactTouchEvent<HTMLDivElement>) => {
        const start = touchStartRef.current;
        touchStartRef.current = null;
        if (!start || event.changedTouches.length !== 1 || zoom > 1.05 || prefs.spreadMode === "webtoon") return;
        const touch = event.changedTouches[0];
        const dx = touch.clientX - start.x;
        const dy = touch.clientY - start.y;
        const dt = Date.now() - start.time;
        if (dt < 450 && Math.abs(dx) > 48 && Math.abs(dx) > Math.abs(dy) * 1.35) {
            if (dx > 0) {
                if (prefs.rtl) goNext();
                else goPrev();
            } else {
                if (prefs.rtl) goPrev();
                else goNext();
            }
        }
    }, [zoom, prefs.spreadMode, prefs.rtl, goNext, goPrev]);

    const handleStageClick = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
        const target = event.target as HTMLElement | null;
        if (target?.closest(".manga-bubble, .manga-bubble-edit-btn, .manga-edit-popover, button, input")) {
            return;
        }
        setActiveBubble(null);
        if (lookupOpen) {
            onCloseLookup?.();
            return;
        }
        if (controlsOpen) {
            setControlsOpen(false);
            return;
        }
        if (prefs.spreadMode === "webtoon") {
            if (isMobile) setChromeVisible((v) => !v);
            return;
        }
        const rect = event.currentTarget.getBoundingClientRect();
        const relX = (event.clientX - rect.left) / Math.max(1, rect.width);
        if (relX < 0.28) {
            if (prefs.rtl) goNext();
            else goPrev();
        } else if (relX > 0.72) {
            if (prefs.rtl) goPrev();
            else goNext();
        } else if (isMobile) {
            setChromeVisible((v) => !v);
        }
    }, [lookupOpen, onCloseLookup, controlsOpen, prefs.spreadMode, prefs.rtl, isMobile, goNext, goPrev]);

    const orderedDisplayPages = useMemo(() => {
        if (prefs.spreadMode === "spread" && prefs.rtl && visiblePages.length === 2) {
            // In RTL spread, first page goes on the RIGHT, second page on the LEFT
            return [visiblePages[1], visiblePages[0]];
        }
        return visiblePages;
    }, [prefs.spreadMode, prefs.rtl, visiblePages]);

    const pct = meta.pageCount <= 1 ? 100 : Math.round((currentPage / (meta.pageCount - 1)) * 100);

    const renderPageCard = (pageIdx: number) => {
        const payload = pagesByIndex[pageIdx];
        if (!payload) {
            return (
                <div key={pageIdx} className="manga-page-placeholder">
                    <span>{isEn ? `Loading page ${pageIdx + 1}…` : `Загрузка стр. ${pageIdx + 1}…`}</span>
                </div>
            );
        }

        const effectiveBlocks = applyBlockTextOverrides(payload.blocks, overrides[pageIdx]);
        const extraBlocks = sessionBlocksByPage[pageIdx] || [];
        const renderBlocks = extraBlocks.length > 0 ? [...effectiveBlocks, ...extraBlocks] : effectiveBlocks;
        const natW = payload.width || 1000;
        const natH = payload.height || 1400;
        const activeCrop = cropDrag && cropDrag.pageIndex === pageIdx ? cropDrag : null;

        return (
            <div
                key={pageIdx}
                className={`manga-page-frame fit-${prefs.fitMode}${prefs.dimBackground ? " is-dimmed" : ""}`}
                style={{
                    aspectRatio: `${natW} / ${natH}`,
                    ...(zoom !== 1 ? { transform: `scale(${zoom})`, transformOrigin: "center top" } : {}),
                }}
            >
                <img
                    src={payload.imageSrc}
                    alt={`Page ${pageIdx + 1}`}
                    className="manga-page-img"
                    draggable={false}
                />
                {renderBlocks.length > 0 && (
                    <div
                        className={`manga-overlay-layer mode-${prefs.overlayMode}`}
                        style={{ ["--manga-font-scale" as string]: String(prefs.fontScale) } as CSSProperties}
                    >
                        {renderBlocks.map((block, bIdx) => {
                            const [x1, y1, x2, y2] = block.box;
                            const leftPct = (x1 / natW) * 100;
                            const topPct = (y1 / natH) * 100;
                            const widthPct = Math.max(1.5, ((x2 - x1) / natW) * 100);
                            const heightPct = Math.max(1.5, ((y2 - y1) / natH) * 100);
                            const sentence = joinMokuroLines(block.lines);
                            const isActive =
                                activeBubble?.pageIndex === pageIdx && activeBubble?.blockIndex === bIdx;
                            const fittedPx = computeFittedBubbleFontPx(block) * prefs.fontScale;
                            const relFontCqw = Math.max(0.6, Math.min(6.5, (fittedPx / natW) * 100));

                            return (
                                <div
                                    key={bIdx}
                                    className={`manga-bubble${block.vertical ? " is-vertical" : " is-horizontal"}${isActive ? " is-active" : ""}`}
                                    style={{
                                        left: `${leftPct}%`,
                                        top: `${topPct}%`,
                                        width: `${widthPct}%`,
                                        height: `${heightPct}%`,
                                        fontSize: `${relFontCqw}cqw`,
                                    }}
                                    onMouseEnter={() => {
                                        if (!isMobile) setActiveBubble({ pageIndex: pageIdx, blockIndex: bIdx });
                                        prepareAnkiPanelCrop(payload, block);
                                    }}
                                    onMouseLeave={() => {
                                        if (isMobile || lookupOpen) return;
                                        setActiveBubble((prev) =>
                                            prev?.pageIndex === pageIdx && prev?.blockIndex === bIdx ? null : prev,
                                        );
                                    }}
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        setActiveBubble({ pageIndex: pageIdx, blockIndex: bIdx });
                                        prepareAnkiPanelCrop(payload, block);
                                    }}
                                >
                                    <div className="manga-bubble-text text-line">
                                        <TokenizedLine
                                            text={sentence}
                                            searchQuery=""
                                            furiganaMode="none"
                                            onLookupToken={onLookupToken
                                                ? (token, sent, cursor, boundaries, lemma) => {
                                                    prepareAnkiPanelCrop(payload, block);
                                                    return onLookupToken(token, sent, cursor, boundaries, lemma);
                                                }
                                                : undefined}
                                        />
                                    </div>
                                    {isActive && (
                                        <button
                                            type="button"
                                            className="manga-bubble-edit-btn"
                                            title={isEn ? "Fix OCR text" : "Исправить опечатку OCR"}
                                            onClick={(e) => {
                                                e.stopPropagation();
                                                setEditingBubble({
                                                    pageIndex: pageIdx,
                                                    blockIndex: bIdx,
                                                    text: sentence,
                                                });
                                            }}
                                        >
                                            ✎
                                        </button>
                                    )}
                                </div>
                            );
                        })}
                    </div>
                )}
                {cropToolActive && (
                    <div
                        className="manga-crop-overlay"
                        onClick={(e) => e.stopPropagation()}
                        onPointerDown={(e) => {
                            e.stopPropagation();
                            e.currentTarget.setPointerCapture(e.pointerId);
                            const rect = e.currentTarget.getBoundingClientRect();
                            const relX = Math.max(0, Math.min(1, (e.clientX - rect.left) / Math.max(1, rect.width)));
                            const relY = Math.max(0, Math.min(1, (e.clientY - rect.top) / Math.max(1, rect.height)));
                            setCropDrag({ pageIndex: pageIdx, startX: relX, startY: relY, curX: relX, curY: relY });
                        }}
                        onPointerMove={(e) => {
                            if (!cropDrag || cropDrag.pageIndex !== pageIdx) return;
                            const rect = e.currentTarget.getBoundingClientRect();
                            const relX = Math.max(0, Math.min(1, (e.clientX - rect.left) / Math.max(1, rect.width)));
                            const relY = Math.max(0, Math.min(1, (e.clientY - rect.top) / Math.max(1, rect.height)));
                            setCropDrag((prev) => (prev ? { ...prev, curX: relX, curY: relY } : null));
                        }}
                        onPointerUp={(e) => {
                            e.stopPropagation();
                            if (e.currentTarget.hasPointerCapture(e.pointerId)) {
                                e.currentTarget.releasePointerCapture(e.pointerId);
                            }
                            const drag = cropDrag;
                            setCropDrag(null);
                            if (!drag || drag.pageIndex !== pageIdx) return;
                            const minX = Math.min(drag.startX, drag.curX);
                            const maxX = Math.max(drag.startX, drag.curX);
                            const minY = Math.min(drag.startY, drag.curY);
                            const maxY = Math.max(drag.startY, drag.curY);
                            if (maxX - minX < 0.015 || maxY - minY < 0.015) return;
                            const box: [number, number, number, number] = [
                                Math.round(minX * natW),
                                Math.round(minY * natH),
                                Math.round(maxX * natW),
                                Math.round(maxY * natH),
                            ];
                            void handleRunBubbleCropOcr(payload, box);
                        }}
                        onPointerCancel={() => setCropDrag(null)}
                    >
                        {activeCrop ? (
                            <div
                                className="manga-crop-rect"
                                style={{
                                    left: `${Math.min(activeCrop.startX, activeCrop.curX) * 100}%`,
                                    top: `${Math.min(activeCrop.startY, activeCrop.curY) * 100}%`,
                                    width: `${Math.abs(activeCrop.curX - activeCrop.startX) * 100}%`,
                                    height: `${Math.abs(activeCrop.curY - activeCrop.startY) * 100}%`,
                                }}
                            />
                        ) : (
                            <div className="manga-crop-hint">
                                {isEn ? "Drag over any speech bubble to OCR" : "Обведи любой бабл для распознавания"}
                            </div>
                        )}
                    </div>
                )}
            </div>
        );
    };

    const overlayLabel = prefs.overlayMode === "hover"
        ? (isEn ? "Hover" : "Скрыт")
        : prefs.overlayMode === "outline"
            ? (isEn ? "Boxes" : "Рамки")
            : (isEn ? "Text" : "Текст");

    const cycleOverlayMode = () => {
        const order: MangaOverlayMode[] = ["hover", "outline", "readable"];
        updatePrefs({ overlayMode: order[(order.indexOf(prefs.overlayMode) + 1) % order.length] });
    };

    const cycleSpreadMode = () => {
        const order: MangaSpreadMode[] = isMobile
            ? ["single", "webtoon"]
            : ["single", "spread", "webtoon"];
        updatePrefs({ spreadMode: order[(order.indexOf(prefs.spreadMode) + 1) % order.length] });
    };

    return (
        <div className={`manga-reader-root${isMobile ? " is-mobile" : ""}`}>
            {/* Top floating bar */}
            <header className={`manga-topbar${!chromeVisible && isMobile ? " is-hidden" : ""}`}>
                <div className="manga-topbar-left">
                    <button
                        type="button"
                        className="manga-btn manga-btn-icon"
                        onClick={onBackToLibrary}
                        title={isEn ? "Back to library" : "В библиотеку"}
                        aria-label={isEn ? "Back to library" : "В библиотеку"}
                    >
                        ←
                    </button>
                    <span className="manga-title" title={meta.title}>{meta.title}</span>
                    <button
                        type="button"
                        className={`manga-badge-btn${meta.hasMokuro ? " is-mokuro" : " is-raw"}`}
                        onClick={() => setMokuroModalOpen(true)}
                        title={meta.hasMokuro
                            ? (isEn ? "Mokuro OCR active (click to manage)" : "Слой Mokuro активен (нажми для управления)")
                            : (isEn ? "No .mokuro OCR yet — click to run or attach" : "Нет .mokuro — нажми, чтобы распознать или прикрепить")}
                    >
                        {meta.hasMokuro ? "MOKURO" : (isEn ? "+ OCR" : "+ OCR")}
                    </button>
                </div>

                <div className="manga-topbar-right">
                    <button
                        type="button"
                        className={`manga-btn${cropToolActive ? " is-active" : ""}`}
                        onClick={() => setCropToolActive((v) => !v)}
                        title={isEn ? "Select bubble area to OCR (S)" : "Обвести бабл для OCR (S)"}
                    >
                        ✂ OCR
                    </button>

                    <button
                        type="button"
                        className="manga-btn"
                        onClick={cycleSpreadMode}
                        title={isEn ? "Page layout (D)" : "Режим страниц (D)"}
                    >
                        {prefs.spreadMode === "spread"
                            ? (isEn ? "2p" : "2 стр")
                            : prefs.spreadMode === "webtoon"
                                ? (isEn ? "Strip" : "Лента")
                                : (isEn ? "1p" : "1 стр")}
                    </button>

                    {!isMobile && prefs.spreadMode === "spread" && (
                        <button
                            type="button"
                            className={`manga-btn${prefs.coverOffset ? " is-active" : ""}`}
                            onClick={() => updatePrefs({ coverOffset: !prefs.coverOffset })}
                            title={isEn ? "Cover page offset (C)" : "Сдвиг обложки для разворота (C)"}
                        >
                            {isEn ? "Cover" : "Обложка"}
                        </button>
                    )}

                    <button
                        type="button"
                        className="manga-btn"
                        onClick={() => updatePrefs({ rtl: !prefs.rtl })}
                        title={isEn ? "Reading direction" : "Направление чтения"}
                    >
                        {prefs.rtl ? "RTL ←" : "LTR →"}
                    </button>

                    <button
                        type="button"
                        className={`manga-btn${prefs.overlayMode !== "hover" ? " is-active" : ""}`}
                        onClick={cycleOverlayMode}
                        title={isEn ? "OCR overlay visibility (O)" : "Отображение слоя текста (O)"}
                    >
                        {overlayLabel}
                    </button>

                    <button
                        type="button"
                        className={`manga-btn manga-btn-icon${controlsOpen ? " is-active" : ""}`}
                        onClick={() => setControlsOpen((v) => !v)}
                        title={isEn ? "Manga reader settings" : "Настройки читалки манги"}
                        aria-label={isEn ? "Settings" : "Настройки"}
                    >
                        <IconSettings />
                    </button>
                </div>
            </header>

            {/* Settings popover */}
            {controlsOpen && (
                <div className="manga-popover" onClick={(e) => e.stopPropagation()}>
                    <div className="manga-popover-row">
                        <span>{isEn ? "Fit" : "Масштаб"}</span>
                        <div className="manga-seg">
                            {(["height", "width", "original"] as const).map((mode) => (
                                <button
                                    key={mode}
                                    type="button"
                                    className={prefs.fitMode === mode ? "is-active" : ""}
                                    onClick={() => updatePrefs({ fitMode: mode })}
                                >
                                    {mode === "height"
                                        ? (isEn ? "Height" : "Высота")
                                        : mode === "width"
                                            ? (isEn ? "Width" : "Ширина")
                                            : "1:1"}
                                </button>
                            ))}
                        </div>
                    </div>

                    <div className="manga-popover-row">
                        <span>{isEn ? "Zoom" : "Зум"} ({Math.round(zoom * 100)}%)</span>
                        <div className="manga-seg">
                            <button type="button" onClick={() => setZoom((z) => Math.max(0.5, Number((z - 0.15).toFixed(2))))}>−</button>
                            <button type="button" onClick={() => setZoom(1)}>100%</button>
                            <button type="button" onClick={() => setZoom((z) => Math.min(3, Number((z + 0.15).toFixed(2))))}>+</button>
                        </div>
                    </div>

                    <div className="manga-popover-row">
                        <span>{isEn ? "OCR font" : "Шрифт OCR"} ({Math.round(prefs.fontScale * 100)}%)</span>
                        <input
                            type="range"
                            min={0.75}
                            max={1.6}
                            step={0.05}
                            value={prefs.fontScale}
                            onChange={(e) => updatePrefs({ fontScale: Number(e.target.value) })}
                        />
                    </div>

                    <div className="manga-popover-row">
                        <span>{isEn ? "Anki picture" : "Картинка в Anki"}</span>
                        <div className="manga-seg">
                            <button
                                type="button"
                                className={prefs.cropMode === "bubble" ? "is-active" : ""}
                                onClick={() => updatePrefs({ cropMode: "bubble" })}
                            >
                                {isEn ? "Panel crop" : "Кроп кадра"}
                            </button>
                            <button
                                type="button"
                                className={prefs.cropMode === "full" ? "is-active" : ""}
                                onClick={() => updatePrefs({ cropMode: "full" })}
                            >
                                {isEn ? "Full page" : "Вся стр."}
                            </button>
                        </div>
                    </div>

                    <label className="manga-popover-check">
                        <input
                            type="checkbox"
                            checked={prefs.dimBackground}
                            onChange={(e) => updatePrefs({ dimBackground: e.target.checked })}
                        />
                        <span>{isEn ? "Slightly dim bright white pages" : "Слегка приглушить яркость белых страниц"}</span>
                    </label>

                    <div className="manga-popover-actions">
                        <button
                            type="button"
                            className="manga-primary-btn"
                            onClick={() => {
                                setControlsOpen(false);
                                setMokuroModalOpen(true);
                            }}
                        >
                            {meta.hasMokuro
                                ? (isEn ? "Manage .mokuro OCR" : "Управление .mokuro OCR")
                                : (isEn ? "Add / Generate .mokuro OCR" : "Создать / прикрепить .mokuro")}
                        </button>
                    </div>
                    {!isMobile && (
                        <button
                            type="button"
                            className="manga-btn"
                            disabled={exportingCbz}
                            onClick={() => {
                                setControlsOpen(false);
                                void handleExportMobileCbz();
                            }}
                        >
                            {exportingCbz
                                ? (isEn ? "Packing .cbz…" : "Упаковка .cbz…")
                                : (isEn ? "Pack .cbz for Phone" : "Упаковать для телефона (.cbz)")}
                        </button>
                    )}
                </div>
            )}

            {/* Main page viewport */}
            <div
                ref={viewportRef}
                className={`manga-viewport mode-${prefs.spreadMode}`}
                onWheel={handleWheel}
                onTouchStart={handleTouchStart}
                onTouchEnd={handleTouchEnd}
                onClick={handleStageClick}
            >
                <div className={`manga-spread-stage mode-${prefs.spreadMode}`}>
                    {orderedDisplayPages.map((idx) => renderPageCard(idx))}
                </div>
            </div>

            {/* Inline OCR typo editor modal */}
            {editingBubble && (
                <div className="manga-modal-backdrop" onClick={() => setEditingBubble(null)}>
                    <div className="manga-modal" onClick={(e) => e.stopPropagation()}>
                        <h3>{isEn ? "Fix OCR text in bubble" : "Исправить текст OCR в бабле"}</h3>
                        <textarea
                            className="manga-edit-textarea"
                            rows={4}
                            autoFocus
                            value={editingBubble.text}
                            onChange={(e) => setEditingBubble({ ...editingBubble, text: e.target.value })}
                        />
                        <div className="manga-modal-footer">
                            <button type="button" className="manga-btn" onClick={() => setEditingBubble(null)}>
                                {isEn ? "Cancel" : "Отмена"}
                            </button>
                            <button type="button" className="manga-primary-btn" onClick={() => void handleSaveBubbleEdit()}>
                                {isEn ? "Save" : "Сохранить"}
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* Mokuro OCR manager / CLI runner modal */}
            {mokuroModalOpen && (
                <div className="manga-modal-backdrop" onClick={() => !mokuroRunning && setMokuroModalOpen(false)}>
                    <div className="manga-modal" onClick={(e) => e.stopPropagation()}>
                        <h3>{isEn ? "Mokuro OCR Text Layer" : "Слой текста Mokuro OCR"}</h3>
                        <p className="manga-modal-desc">
                            {mokuroRunning
                                ? (isEn
                                    ? "Recognizing speech bubbles and Japanese text in this volume. When finished, clickable text overlays will activate automatically."
                                    : "Идёт распознавание баблов и японского текста в этом томе. После завершения кликабельный слой текста подключится автоматически.")
                                : meta.hasMokuro
                                    ? (isEn
                                        ? `Active .mokuro layer (${meta.totalChars.toLocaleString()} chars across ${meta.pageCount} pages). Hover any speech bubble and hold Shift to look up words.`
                                        : `Слой .mokuro подключён (${meta.totalChars.toLocaleString("ru-RU")} зн. на ${meta.pageCount} стр.). Наведи курсор на бабл с Shift (или тапни на телефоне) для словаря.`)
                                    : (isEn
                                        ? "This manga currently has raw images without a .mokuro overlay. You can attach an existing .mokuro file or generate one right here via mokuro CLI."
                                        : "Сейчас в этом томе только картинки без .mokuro-слоя. Можно прикрепить готовый файл .mokuro или запустить генерацию прямо отсюда через mokuro CLI.")}
                        </p>

                        {!isMobile && (
                            <div className="manga-mokuro-box">
                                <div className="manga-mokuro-status">
                                    <span>mokuro CLI:</span>
                                    {mokuroStatus === null ? (
                                        <span className="is-muted">{isEn ? "Checking…" : "Проверка…"}</span>
                                    ) : mokuroStatus.available ? (
                                        <span className="is-ok">
                                            ✓ {mokuroStatus.command} {mokuroStatus.version ? `(${mokuroStatus.version})` : ""}
                                        </span>
                                    ) : (
                                        <span className="is-warn">
                                            {isEn ? "Not found" : "Не установлен"}
                                        </span>
                                    )}
                                </div>

                                {mokuroStatus && !mokuroStatus.available && (
                                    <div className="manga-mokuro-hint">
                                        {isEn ? "Install once in terminal:" : "Установи один раз в терминале:"}
                                        <code>pip install mokuro</code>
                                    </div>
                                )}

                                {mokuroRunning && (
                                    <div className="manga-mokuro-progress">
                                        <div className="manga-mokuro-progress-head">
                                            <span>
                                                {mokuroProgress?.stage === "ocr" && mokuroProgress.current !== null && mokuroProgress.total
                                                    ? (isEn
                                                        ? `Scanning pages: ${mokuroProgress.current} / ${mokuroProgress.total} (${mokuroProgress.percent ?? 0}%)`
                                                        : `Распознавание страниц: ${mokuroProgress.current} / ${mokuroProgress.total} (${mokuroProgress.percent ?? 0}%)`)
                                                    : mokuroProgress?.stage === "model_load"
                                                        ? (isEn ? "Loading manga-ocr neural model…" : "Загрузка нейросети manga-ocr…")
                                                        : mokuroProgress?.stage === "detector_init"
                                                            ? (isEn ? "Initializing speech-bubble detector…" : "Запуск детектора баблов…")
                                                            : mokuroProgress?.stage === "downloading"
                                                                ? (isEn ? "Downloading OCR weights…" : "Скачивание весов OCR…")
                                                                : (isEn ? "Starting mokuro…" : "Запуск mokuro…")}
                                            </span>
                                            {mokuroProgress?.device && (
                                                <span className={`manga-device-pill is-${mokuroProgress.device}`}>
                                                    {mokuroProgress.device === "cuda" ? "⚡ GPU (CUDA)" : "CPU"}
                                                </span>
                                            )}
                                        </div>
                                        <div className="manga-progress-track">
                                            <div
                                                className={`manga-progress-fill${mokuroProgress?.percent == null ? " is-indeterminate" : ""}`}
                                                style={mokuroProgress?.percent != null ? { width: `${mokuroProgress.percent}%` } : undefined}
                                            />
                                        </div>
                                        {mokuroProgress?.eta && (
                                            <div className="manga-mokuro-eta">
                                                {isEn ? `Estimated time left: ~${mokuroProgress.eta}` : `Осталось примерно: ~${mokuroProgress.eta}`}
                                            </div>
                                        )}
                                    </div>
                                )}

                                {mokuroError && <div className="manga-mokuro-error">{mokuroError}</div>}
                                {exportStatus && (
                                    <div className={exportStatus.ok ? "manga-export-ok" : "manga-mokuro-error"}>
                                        {exportStatus.message}
                                    </div>
                                )}
                            </div>
                        )}

                        {isMobile && (
                            <div className="manga-mokuro-box">
                                <div className="manga-mokuro-status">
                                    <span>{isEn ? "On-device OCR:" : "OCR на телефоне:"}</span>
                                    <span className={mobileOcrReady?.onnxReady ? "is-ok" : "is-muted"}>
                                        {mobileOcrReady?.onnxReady
                                            ? "ML Kit + ONNX INT8"
                                            : mobileOcrReady?.onnxDownloading
                                                ? (isEn ? "ML Kit · ONNX downloading…" : "ML Kit · ONNX скачивается…")
                                                : "ML Kit"}
                                        {mobileOcrReady?.hasRemote ? (isEn ? " + PC Wi-Fi" : " + ПК Wi-Fi") : ""}
                                    </span>
                                </div>
                                <div className="manga-mokuro-hint">
                                    {isEn
                                        ? "Use ✂ OCR to draw over any bubble, or scan all bubbles on the current page. Configure ONNX INT8 (~117 MB) and PC Wi-Fi GPU in Settings → EPUB & Manga → Manga & OCR."
                                        : "Нажми ✂ OCR, чтобы обвести бабл вручную, или найди все баблы на странице через ML Kit. Модель ONNX (~117 МБ) и адрес ПК Wi-Fi настраиваются в Настройках → EPUB → Манга и OCR."}
                                </div>
                            </div>
                        )}

                        <div className="manga-modal-footer">
                            {isMobile && hasAndroidMangaOcrBridge() && (
                                <button
                                    type="button"
                                    className="manga-primary-btn"
                                    disabled={Boolean(ocrBusy) || !pagesByIndex[currentPage]}
                                    onClick={() => void handleAutoScanPage()}
                                >
                                    {isEn ? "Scan page bubbles (ML Kit)" : "Найти баблы на стр. (ML Kit)"}
                                </button>
                            )}
                            {isMobile && (
                                <button
                                    type="button"
                                    className="manga-btn"
                                    onClick={() => {
                                        setMokuroModalOpen(false);
                                        setCropToolActive(true);
                                    }}
                                >
                                    {isEn ? "✂ Crop bubble" : "✂ Обвести бабл"}
                                </button>
                            )}
                            {!isMobile && (
                                <button
                                    type="button"
                                    className="manga-btn"
                                    disabled={mokuroRunning || exportingCbz}
                                    onClick={() => void handleExportMobileCbz()}
                                >
                                    {exportingCbz
                                        ? (isEn ? "Packing .cbz…" : "Упаковка .cbz…")
                                        : (isEn ? "Pack .cbz for Phone" : "Упаковать для телефона (.cbz)")}
                                </button>
                            )}
                            {!isMobile && (
                                <button
                                    type="button"
                                    className="manga-btn"
                                    disabled={mokuroRunning}
                                    onClick={() => void handleAttachMokuroFile()}
                                >
                                    {isEn ? "Attach .mokuro file" : "Прикрепить .mokuro"}
                                </button>
                            )}
                            {!isMobile && (
                                <button
                                    type="button"
                                    className="manga-primary-btn"
                                    disabled={mokuroRunning || !mokuroStatus?.available}
                                    onClick={() => void handleRunMokuroCli()}
                                >
                                    {mokuroRunning
                                        ? (isEn ? "Running OCR…" : "Распознавание…")
                                        : (isEn ? "Generate .mokuro" : "Распознать том (mokuro)")}
                                </button>
                            )}
                            <button
                                type="button"
                                className="manga-btn"
                                disabled={mokuroRunning}
                                onClick={() => setMokuroModalOpen(false)}
                            >
                                {isEn ? "Close" : "Закрыть"}
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* Floating OCR result bar for on-demand bubble crop / ML Kit scan */}
            {(ocrBusy || ocrError || ocrResult) && (
                <div className="manga-ocr-result-bar" onClick={(e) => e.stopPropagation()}>
                    {ocrBusy ? (
                        <div className="manga-ocr-result-busy">
                            <span className="manga-ocr-spinner" aria-hidden="true" />
                            <span>{ocrBusy}</span>
                        </div>
                    ) : ocrError ? (
                        <div className="manga-ocr-result-row">
                            <span className="manga-mokuro-error">{ocrError}</span>
                            <button
                                type="button"
                                className="manga-btn"
                                onClick={() => setOcrError(null)}
                            >
                                ×
                            </button>
                        </div>
                    ) : ocrResult && (
                        <div className="manga-ocr-result-row">
                            <span className="manga-ocr-engine-pill">
                                {formatOcrEngineLabel(ocrResult.engine, ocrResult.device, isEn)} · {ocrResult.elapsedMs}ms
                            </span>
                            <div className="manga-ocr-result-text text-line">
                                {ocrResult.text ? (
                                    <TokenizedLine
                                        text={ocrResult.text}
                                        searchQuery=""
                                        furiganaMode="none"
                                        onLookupToken={onLookupToken}
                                    />
                                ) : (
                                    <span style={{ opacity: 0.6 }}>
                                        {isEn ? "(no text detected)" : "(текст не найден)"}
                                    </span>
                                )}
                            </div>
                            <div className="manga-ocr-result-actions">
                                <button
                                    type="button"
                                    className="manga-btn"
                                    title={isEn ? "Crop another bubble (S)" : "Обвести другой бабл (S)"}
                                    onClick={() => setCropToolActive(true)}
                                >
                                    ✂
                                </button>
                                {ocrResult.text && (
                                    <button
                                        type="button"
                                        className="manga-btn"
                                        title={isEn ? "Pin as bubble on page" : "Закрепить как бабл на странице"}
                                        onClick={handlePinOcrResultAsBubble}
                                    >
                                        + {isEn ? "Bubble" : "Бабл"}
                                    </button>
                                )}
                                <button
                                    type="button"
                                    className="manga-btn"
                                    title={isEn ? "Edit OCR text" : "Исправить текст"}
                                    onClick={() =>
                                        setEditingBubble({
                                            pageIndex: -1,
                                            blockIndex: 0,
                                            text: ocrResult.text,
                                        })
                                    }
                                >
                                    ✎
                                </button>
                                <button
                                    type="button"
                                    className="manga-btn"
                                    title={isEn ? "Dismiss" : "Закрыть"}
                                    onClick={() => setOcrResult(null)}
                                >
                                    ×
                                </button>
                            </div>
                        </div>
                    )}
                </div>
            )}

            {/* Bottom slim scrubber bar */}
            <footer className={`manga-bottombar${!chromeVisible && isMobile ? " is-hidden" : ""}`}>
                <button
                    type="button"
                    className="manga-btn"
                    onClick={prefs.rtl ? goNext : goPrev}
                    disabled={prefs.rtl ? currentPage >= meta.pageCount - 1 : currentPage <= 0}
                >
                    ‹
                </button>
                <input
                    type="range"
                    className={`manga-scrubber${prefs.rtl ? " is-rtl" : ""}`}
                    min={0}
                    max={Math.max(0, meta.pageCount - 1)}
                    value={currentPage}
                    onChange={(e) => setCurrentPage(Number(e.target.value))}
                    aria-label={isEn ? "Page" : "Страница"}
                />
                <button
                    type="button"
                    className="manga-btn"
                    onClick={prefs.rtl ? goPrev : goNext}
                    disabled={prefs.rtl ? currentPage <= 0 : currentPage >= meta.pageCount - 1}
                >
                    ›
                </button>
                <span className="manga-page-readout">
                    {currentPage + 1} / {meta.pageCount} · {pct}%
                    {meta.totalChars > 0 && !isMobile ? ` · ${meta.totalChars.toLocaleString("ru-RU")} зн.` : ""}
                </span>
            </footer>
        </div>
    );
}
