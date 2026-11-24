import { useCallback, useEffect, useState } from "react";
import {
    checkMangaOcrRemoteHealth,
    getMangaOcrServerStatus,
    startMangaOcrServer,
    stopMangaOcrServer,
    type MangaOcrServerStatus,
} from "./mangaApi";
import {
    cancelAndroidOnnxDownload,
    deleteAndroidOnnxModel,
    getAndroidMangaOcrStatus,
    hasAndroidMangaOcrBridge,
    loadMangaOcrPrefs,
    normalizeOcrServerUrl,
    saveMangaOcrPrefs,
    startAndroidOnnxDownload,
    type AndroidMangaOcrStatus,
    type MangaMobileOcrEngine,
    type MangaOcrDownloadEvent,
    type MangaOcrPrefs,
} from "./mangaOcr";

interface SettingsMangaOcrProps {
    language: "ru" | "en";
    isMobile: boolean;
}

function formatMb(bytes: number): string {
    if (!bytes || bytes <= 0) return "0 МБ";
    return `${(bytes / (1024 * 1024)).toFixed(1)}`;
}

export default function SettingsMangaOcr({ language, isMobile }: SettingsMangaOcrProps) {
    const isEn = language === "en";
    const [prefs, setPrefs] = useState<MangaOcrPrefs>(() => loadMangaOcrPrefs());

    // Desktop LAN server state
    const [serverStatus, setServerStatus] = useState<MangaOcrServerStatus | null>(null);
    const [serverBusy, setServerBusy] = useState(false);
    const [serverError, setServerError] = useState<string | null>(null);
    const [copiedUrl, setCopiedUrl] = useState(false);

    // Mobile ONNX / ML Kit / Remote test state
    const [androidStatus, setAndroidStatus] = useState<AndroidMangaOcrStatus | null>(null);
    const [downloadEvent, setDownloadEvent] = useState<MangaOcrDownloadEvent | null>(null);
    const [remoteCheckStatus, setRemoteCheckStatus] = useState<{
        ok: boolean;
        message: string;
    } | null>(null);
    const [remoteChecking, setRemoteChecking] = useState(false);

    const patchPrefs = useCallback((patch: Partial<MangaOcrPrefs>) => {
        setPrefs((prev) => {
            const next = { ...prev, ...patch };
            saveMangaOcrPrefs(next);
            return next;
        });
    }, []);

    const refreshDesktopStatus = useCallback(async () => {
        if (isMobile) return;
        try {
            const st = await getMangaOcrServerStatus();
            setServerStatus(st);
            setServerError(st.error || null);
        } catch (err) {
            setServerError(String(err));
        }
    }, [isMobile]);

    const refreshAndroidStatus = useCallback(async () => {
        if (!isMobile || !hasAndroidMangaOcrBridge()) return;
        try {
            const st = await getAndroidMangaOcrStatus();
            setAndroidStatus(st);
        } catch {
            // Ignore bridge errors when unavailable
        }
    }, [isMobile]);

    useEffect(() => {
        void refreshDesktopStatus();
        void refreshAndroidStatus();
    }, [refreshDesktopStatus, refreshAndroidStatus]);

    useEffect(() => {
        if (!isMobile) return;
        const onDownloadProgress = (ev: Event) => {
            const raw = (ev as CustomEvent<string>).detail;
            try {
                const parsed = typeof raw === "string"
                    ? (JSON.parse(raw) as MangaOcrDownloadEvent)
                    : (raw as unknown as MangaOcrDownloadEvent);
                setDownloadEvent(parsed);
                if (parsed.status === "done" || parsed.status === "cancelled" || parsed.status === "error") {
                    void refreshAndroidStatus();
                }
            } catch {
                // Ignore malformed progress events
            }
        };
        window.addEventListener("setsuna-manga-ocr-download", onDownloadProgress);
        return () => window.removeEventListener("setsuna-manga-ocr-download", onDownloadProgress);
    }, [isMobile, refreshAndroidStatus]);

    const handleToggleServer = async () => {
        if (serverBusy) return;
        setServerBusy(true);
        setServerError(null);
        try {
            if (serverStatus?.running) {
                const st = await stopMangaOcrServer();
                setServerStatus(st);
                patchPrefs({ pcServerEnabled: false });
            } else {
                const st = await startMangaOcrServer(prefs.pcServerPort, prefs.pcServerToken || undefined);
                setServerStatus(st);
                patchPrefs({ pcServerEnabled: true });
            }
        } catch (err) {
            setServerError(String(err));
        } finally {
            setServerBusy(false);
        }
    };

    const handleCopyUrl = () => {
        if (!serverStatus?.url) return;
        void navigator.clipboard?.writeText(serverStatus.url).then(() => {
            setCopiedUrl(true);
            window.setTimeout(() => setCopiedUrl(false), 1800);
        });
    };

    const handleTestRemote = async () => {
        const url = normalizeOcrServerUrl(prefs.remoteUrl);
        if (!url) {
            setRemoteCheckStatus({
                ok: false,
                message: isEn ? "Enter your PC's Wi-Fi OCR address first." : "Сначала введи Wi-Fi адрес ПК.",
            });
            return;
        }
        setRemoteChecking(true);
        setRemoteCheckStatus(null);
        try {
            const health = await checkMangaOcrRemoteHealth(url, prefs.remoteToken || undefined);
            const devLabel = health.device === "cuda"
                ? "⚡ GPU (CUDA)"
                : health.device === "cpu"
                    ? "CPU"
                    : (isEn ? "ready" : "готов");
            setRemoteCheckStatus({
                ok: true,
                message: isEn
                    ? `Connected · PC engine ${devLabel}`
                    : `Подключено · ПК (${devLabel})`,
            });
        } catch (err) {
            setRemoteCheckStatus({
                ok: false,
                message: String(err),
            });
        } finally {
            setRemoteChecking(false);
        }
    };

    const handleStartDownload = () => {
        try {
            setDownloadEvent({
                status: "downloading",
                file: "vocab.txt",
                downloadedBytes: 0,
                totalBytes: 116_674_624,
                percent: 0,
            });
            startAndroidOnnxDownload();
            void refreshAndroidStatus();
        } catch (err) {
            setDownloadEvent({
                status: "error",
                file: "",
                downloadedBytes: 0,
                totalBytes: 116_674_624,
                percent: 0,
                error: String(err),
            });
        }
    };

    const isDownloading = Boolean(
        androidStatus?.onnxDownloading || downloadEvent?.status === "downloading",
    );

    if (!isMobile) {
        return (
            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                <div
                    id="epub-manga"
                    className="modern-card"
                    style={{ background: "var(--bg-panel)", border: "1px solid var(--border-main)" }}
                >
                    <div
                        style={{
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "space-between",
                            gap: 10,
                            marginBottom: 8,
                        }}
                    >
                        <div className="card-label" style={{ color: "var(--text-main)", marginBottom: 0 }}>
                            {isEn ? "Manga OCR Wi-Fi Server for Android (PC GPU)" : "Wi-Fi OCR-сервер для телефона (ПК GPU)"}
                        </div>
                        <span
                            style={{
                                fontSize: 11.5,
                                fontWeight: 700,
                                padding: "3px 9px",
                                borderRadius: 999,
                                background: serverStatus?.running
                                    ? "rgba(56, 189, 128, 0.16)"
                                    : "rgba(255, 255, 255, 0.06)",
                                border: `1px solid ${serverStatus?.running ? "rgba(56, 189, 128, 0.45)" : "rgba(255, 255, 255, 0.12)"}`,
                                color: serverStatus?.running ? "#7ee3b4" : "var(--text-muted)",
                            }}
                        >
                            {serverStatus?.running
                                ? serverStatus.device === "cuda"
                                    ? (isEn ? "Running · ⚡ GPU (CUDA)" : "Работает · ⚡ GPU (CUDA)")
                                    : serverStatus.device === "cpu"
                                        ? (isEn ? "Running · CPU" : "Работает · CPU")
                                        : (isEn ? "Running (warming GPU…)" : "Работает (прогрев GPU…)")
                                : (isEn ? "Stopped" : "Остановлен")}
                        </span>
                    </div>

                    <p style={{ margin: "0 0 12px", fontSize: 12.5, lineHeight: 1.5, color: "var(--text-muted)" }}>
                        {isEn
                            ? "Keep Setsuna running on your PC in the same Wi-Fi network so your phone can send cropped bubbles to your GPU (manga-ocr) with desktop accuracy and zero phone battery drain."
                            : "Когда ПК и телефон в одной Wi-Fi сети, телефон отправляет обведённые баблы на твою видеокарту (manga-ocr) — точность как на ПК и нулевой расход батареи телефона."}
                    </p>

                    {serverStatus && !serverStatus.available && (
                        <div
                            style={{
                                marginBottom: 12,
                                padding: "8px 10px",
                                borderRadius: 8,
                                background: "rgba(245, 158, 11, 0.12)",
                                border: "1px solid rgba(245, 158, 11, 0.35)",
                                fontSize: 12,
                                color: "#fcd34d",
                            }}
                        >
                            {isEn
                                ? "Python package `manga-ocr` was not detected. Install via `pip install mokuro` (or `pip install manga-ocr`)."
                                : "Python-пакет `manga-ocr` не найден. Установи `pip install mokuro` (или `pip install manga-ocr`)."}
                        </div>
                    )}

                    <div style={{ display: "grid", gridTemplateColumns: "140px 1fr", gap: "12px 14px", marginBottom: 12 }}>
                        <label style={{ color: "var(--text-muted)", fontSize: 12 }}>
                            {isEn ? "Port" : "Порт"}
                            <input
                                type="number"
                                min={1024}
                                max={65535}
                                className="modern-input"
                                value={prefs.pcServerPort}
                                onChange={(e) => patchPrefs({ pcServerPort: Number(e.target.value) || 47123 })}
                                style={{ marginTop: 6 }}
                            />
                        </label>
                        <label style={{ color: "var(--text-muted)", fontSize: 12 }}>
                            {isEn ? "Access token (optional)" : "Токен доступа (необязательно)"}
                            <input
                                type="text"
                                className="modern-input"
                                placeholder={isEn ? "Leave empty on trusted home Wi-Fi" : "Можно оставить пустым в домашней сети"}
                                value={prefs.pcServerToken}
                                onChange={(e) => patchPrefs({ pcServerToken: e.target.value })}
                                style={{ marginTop: 6 }}
                            />
                        </label>
                    </div>

                    <label className="checkbox-label" style={{ marginBottom: 12 }}>
                        <input
                            type="checkbox"
                            checked={prefs.pcServerEnabled}
                            onChange={(e) => patchPrefs({ pcServerEnabled: e.target.checked })}
                        />
                        {isEn
                            ? "Auto-start LAN OCR server when Setsuna launches"
                            : "Запускать Wi-Fi OCR-сервер автоматически при старте Setsuna"}
                    </label>

                    <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                        <button
                            type="button"
                            className="btn-primary"
                            disabled={serverBusy || (serverStatus !== null && !serverStatus.available)}
                            onClick={() => void handleToggleServer()}
                            style={{ padding: "8px 14px", fontSize: 12.5 }}
                        >
                            {serverBusy
                                ? (isEn ? "Please wait…" : "Секунду…")
                                : serverStatus?.running
                                    ? (isEn ? "Stop Wi-Fi OCR server" : "Остановить OCR-сервер")
                                    : (isEn ? "Start Wi-Fi OCR server" : "Запустить OCR-сервер")}
                        </button>

                        {serverStatus?.running && serverStatus.url && (
                            <div
                                style={{
                                    display: "inline-flex",
                                    alignItems: "center",
                                    gap: 8,
                                    padding: "6px 10px",
                                    borderRadius: 8,
                                    background: "rgba(79, 166, 255, 0.12)",
                                    border: "1px solid rgba(79, 166, 255, 0.35)",
                                    fontSize: 12.5,
                                    fontFamily: "Consolas, monospace",
                                    color: "#9ed0ff",
                                }}
                            >
                                <span>{serverStatus.url}</span>
                                <button
                                    type="button"
                                    onClick={handleCopyUrl}
                                    style={{
                                        border: "none",
                                        background: "rgba(255, 255, 255, 0.12)",
                                        color: "#eef1f5",
                                        borderRadius: 6,
                                        padding: "2px 8px",
                                        fontSize: 11.5,
                                        cursor: "pointer",
                                    }}
                                >
                                    {copiedUrl ? (isEn ? "Copied!" : "Скопировано!") : (isEn ? "Copy" : "Копировать")}
                                </button>
                            </div>
                        )}
                    </div>

                    {serverError && (
                        <div style={{ marginTop: 10, fontSize: 12, color: "#fca5a5" }}>{serverError}</div>
                    )}
                </div>

                <div
                    className="modern-card"
                    style={{ background: "var(--bg-panel)", border: "1px solid var(--border-main)" }}
                >
                    <div className="card-label" style={{ color: "var(--text-main)" }}>
                        {isEn ? "Portable .cbz Export & Offline Android OCR" : "Перенос манги на телефон (.cbz) и мобильный OCR"}
                    </div>
                    <p style={{ margin: 0, fontSize: 12.5, lineHeight: 1.55, color: "var(--text-muted)" }}>
                        {isEn
                            ? "Open any volume with .mokuro OCR in Setsuna and click “Pack .cbz for Phone” inside the MOKURO dialog to bundle all pages and OCR into one .cbz file. On Android, Setsuna also includes built-in Google ML Kit Japanese, an optional ~117 MB offline INT8 manga-ocr ONNX model, and this PC Wi-Fi client."
                            : "Открой любой распознанный том в Setsuna и нажми «Упаковать для телефона (.cbz)» в окне MOKURO — картинки и слой .mokuro соберутся в один файл. В Android-версии также доступны встроенный Google ML Kit (японский), загрузка оффлайн-модели manga-ocr (ONNX INT8, ~117 МБ) и подключение к этому ПК-серверу по Wi-Fi."}
                    </p>
                </div>
            </div>
        );
    }

    // Android UI
    return (
        <div id="epub-manga" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            <div className="modern-card" style={{ background: "var(--bg-panel)", border: "1px solid var(--border-main)" }}>
                <div className="card-label" style={{ color: "var(--text-main)" }}>
                    {isEn ? "Manga Bubble OCR Engine (Android)" : "Движок OCR манги (Android)"}
                </div>
                <label style={{ color: "var(--text-muted)", fontSize: 12, display: "block", marginBottom: 10 }}>
                    {isEn ? "Preferred recognition order" : "Режим распознавания"}
                    <select
                        className="modern-select"
                        value={prefs.mobileEngine}
                        onChange={(e) => patchPrefs({ mobileEngine: e.target.value as MangaMobileOcrEngine })}
                        style={{ marginTop: 6 }}
                    >
                        <option value="auto">
                            {isEn ? "Auto (PC Wi-Fi → Offline ONNX → ML Kit)" : "Авто (ПК Wi-Fi → Оффлайн ONNX → ML Kit)"}
                        </option>
                        <option value="onnx">
                            {isEn ? "Offline manga-ocr ONNX INT8 only" : "Только оффлайн manga-ocr ONNX INT8"}
                        </option>
                        <option value="mlkit">
                            {isEn ? "Google ML Kit Japanese only (instant)" : "Только Google ML Kit (мгновенно)"}
                        </option>
                        <option value="remote">
                            {isEn ? "PC Wi-Fi GPU server only" : "Только ПК по Wi-Fi"}
                        </option>
                    </select>
                </label>

                <label className="checkbox-label">
                    <input
                        type="checkbox"
                        checked={prefs.autoRefineMlKitWithOnnx}
                        onChange={(e) => patchPrefs({ autoRefineMlKitWithOnnx: e.target.checked })}
                    />
                    {isEn
                        ? "When auto-scanning full pages with ML Kit, refine bubbles via ONNX / PC GPU"
                        : "При авто-поиске баблов через ML Kit уточнять текст через ONNX / ПК GPU"}
                </label>
            </div>

            {/* Offline ONNX INT8 model downloader */}
            <div className="modern-card" style={{ background: "var(--bg-panel)", border: "1px solid var(--border-main)" }}>
                <div
                    style={{
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        gap: 8,
                        marginBottom: 8,
                    }}
                >
                    <div className="card-label" style={{ color: "var(--text-main)", marginBottom: 0 }}>
                        {isEn ? "Offline manga-ocr Model (ONNX INT8, ~117 MB)" : "Оффлайн модель manga-ocr (ONNX INT8, ~117 МБ)"}
                    </div>
                    <span
                        style={{
                            fontSize: 11.5,
                            fontWeight: 700,
                            padding: "2px 8px",
                            borderRadius: 999,
                            background: androidStatus?.onnxReady ? "rgba(56, 189, 128, 0.16)" : "rgba(255, 255, 255, 0.06)",
                            color: androidStatus?.onnxReady ? "#7ee3b4" : "var(--text-muted)",
                        }}
                    >
                        {androidStatus?.onnxReady
                            ? (isEn ? `Ready (${formatMb(androidStatus.onnxSizeBytes)} MB)` : `Готова (${formatMb(androidStatus.onnxSizeBytes)} МБ)`)
                            : isDownloading
                                ? (isEn ? "Downloading…" : "Загрузка…")
                                : (isEn ? "Not downloaded" : "Не скачана")}
                    </span>
                </div>

                <p style={{ margin: "0 0 10px", fontSize: 12, lineHeight: 1.45, color: "var(--text-muted)" }}>
                    {isEn
                        ? "Runs the exact manga-ocr neural network offline on your phone (~0.4–0.9s per cropped bubble). Handles vertical text & ignores furigana much better than ML Kit."
                        : "Запускает нейросеть manga-ocr оффлайн прямо на телефоне (~0.4–0.9 сек на бабл). Идеально игнорирует фуригану и читает вертикальный текст."}
                </p>

                {isDownloading && downloadEvent && (
                    <div style={{ marginBottom: 10 }}>
                        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11.5, marginBottom: 4, color: "var(--text-main)" }}>
                            <span>{downloadEvent.file || (isEn ? "Downloading weights…" : "Загрузка весов…")}</span>
                            <span>
                                {formatMb(downloadEvent.downloadedBytes)} / {formatMb(downloadEvent.totalBytes)} МБ ({Math.round(downloadEvent.percent)}%)
                            </span>
                        </div>
                        <div className="manga-progress-track">
                            <div className="manga-progress-fill" style={{ width: `${Math.round(downloadEvent.percent)}%` }} />
                        </div>
                    </div>
                )}

                {downloadEvent?.status === "error" && downloadEvent.error && (
                    <div style={{ marginBottom: 10, fontSize: 12, color: "#fca5a5" }}>{downloadEvent.error}</div>
                )}

                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                    {!isDownloading && !androidStatus?.onnxReady && (
                        <button type="button" className="btn-primary" onClick={handleStartDownload} style={{ padding: "8px 12px", fontSize: 12.5 }}>
                            {isEn ? "Download ONNX model (~117 MB)" : "Скачать ONNX модель (~117 МБ)"}
                        </button>
                    )}
                    {isDownloading && (
                        <button type="button" className="manga-btn" onClick={cancelAndroidOnnxDownload}>
                            {isEn ? "Cancel download" : "Отменить загрузку"}
                        </button>
                    )}
                    {androidStatus?.onnxReady && !isDownloading && (
                        <button
                            type="button"
                            className="manga-btn"
                            onClick={() => {
                                deleteAndroidOnnxModel();
                                void refreshAndroidStatus();
                            }}
                        >
                            {isEn ? "Delete model files" : "Удалить модель"}
                        </button>
                    )}
                </div>
            </div>

            {/* PC Wi-Fi server connection */}
            <div className="modern-card" style={{ background: "var(--bg-panel)", border: "1px solid var(--border-main)" }}>
                <div className="card-label" style={{ color: "var(--text-main)" }}>
                    {isEn ? "PC Wi-Fi OCR Server (RTX GPU)" : "Wi-Fi OCR-сервер на ПК (видеокарта)"}
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr", gap: 10, marginBottom: 10 }}>
                    <label style={{ color: "var(--text-muted)", fontSize: 12 }}>
                        {isEn ? "PC URL (shown in PC Setsuna → Settings → Manga & OCR)" : "Адрес ПК (показан в Setsuna на ПК → Настройки → Манга и OCR)"}
                        <input
                            type="text"
                            className="modern-input"
                            placeholder="http://192.168.1.42:47123"
                            value={prefs.remoteUrl}
                            onChange={(e) => patchPrefs({ remoteUrl: e.target.value })}
                            style={{ marginTop: 6 }}
                        />
                    </label>
                    <label style={{ color: "var(--text-muted)", fontSize: 12 }}>
                        {isEn ? "Token (if set on PC)" : "Токен (если задан на ПК)"}
                        <input
                            type="text"
                            className="modern-input"
                            value={prefs.remoteToken}
                            onChange={(e) => patchPrefs({ remoteToken: e.target.value })}
                            style={{ marginTop: 6 }}
                        />
                    </label>
                </div>

                <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                    <button
                        type="button"
                        className="btn-primary"
                        disabled={remoteChecking}
                        onClick={() => void handleTestRemote()}
                        style={{ padding: "8px 12px", fontSize: 12.5 }}
                    >
                        {remoteChecking ? (isEn ? "Checking…" : "Проверка…") : (isEn ? "Test connection" : "Проверить связь")}
                    </button>
                    {remoteCheckStatus && (
                        <span style={{ fontSize: 12, color: remoteCheckStatus.ok ? "#7ee3b4" : "#fca5a5" }}>
                            {remoteCheckStatus.message}
                        </span>
                    )}
                </div>
            </div>
        </div>
    );
}
