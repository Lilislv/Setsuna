import { useEffect, useRef, useState } from "react";
import { getBookSyncKey } from "../epub/epubSyncModel";
import { fetchRemotePcMokuroStatus, requestRemotePcMokuro, type RemoteMokuroJobState } from "./mangaApi";
import { loadMangaOcrPrefs, normalizeOcrServerUrl } from "./mangaModel";

export default function RemoteMokuroControls({ title, isEn }: { title: string; isEn: boolean }) {
    const [{ remoteUrl, remoteToken }] = useState(loadMangaOcrPrefs);
    const url = normalizeOcrServerUrl(remoteUrl);
    const token = remoteToken.trim();
    const [convert, setConvert] = useState(true);
    const [sending, setSending] = useState(false);
    const [job, setJob] = useState<RemoteMokuroJobState | null>(null);
    const [error, setError] = useState("");
    const generation = useRef(0);
    const [refresh, setRefresh] = useState(0);
    const bookKey = getBookSyncKey(title);

    useEffect(() => {
        if (!url || !token) return;
        let cancelled = false;
        let timer: number | undefined;
        const poll = async () => {
            const version = generation.current;
            try {
                const current = await fetchRemotePcMokuroStatus(url, token);
                if (cancelled || version !== generation.current) return;
                setJob(current);
                setError("");
                if (["queued", "running", "converting"].includes(current.state)) {
                    timer = window.setTimeout(poll, 2200);
                }
            } catch (err) {
                if (!cancelled && version === generation.current) setError(String(err));
            }
        };
        void poll();
        return () => { cancelled = true; window.clearTimeout(timer); };
    }, [url, token, refresh]);

    const submit = async () => {
        generation.current++;
        setSending(true);
        setError("");
        try {
            setJob(await requestRemotePcMokuro(url, token, title, bookKey, convert));
            setRefresh(value => value + 1);
        } catch (err) {
            setError(String(err));
        } finally {
            setSending(false);
        }
    };
    const active = job && ["queued", "running", "converting"].includes(job.state);
    const labels = isEn
        ? { idle: "", queued: "Queued on PC", running: "Recognizing on PC", converting: "Packing CBZ", done: "OCR complete on PC", error: "OCR failed on PC" }
        : { idle: "", queued: "В очереди на ПК", running: "Распознавание на ПК", converting: "Упаковка CBZ", done: "OCR на ПК завершён", error: "Ошибка OCR на ПК" };
    return (
        <div className="manga-mokuro-box">
            {(!token || !url) ? (
                <div className="manga-mokuro-hint">{isEn
                    ? "For full-volume Mokuro, set the PC server address and a matching access token in Manga & OCR settings."
                    : "Для Mokuro всего тома укажи адрес ПК и одинаковый токен на обоих устройствах в настройках «Манга и OCR»."}</div>
            ) : (
                <>
                    <label><input type="checkbox" checked={convert} onChange={e => setConvert(e.target.checked)} /> {isEn
                        ? "Pack CBZ for Drive sync (when enabled on PC)"
                        : "Упаковать CBZ для Drive (если синхронизация включена на ПК)"}</label>
                    <button type="button" className="manga-btn" disabled={sending || Boolean(active) || !bookKey} onClick={() => void submit()}>
                        {isEn ? "Run Mokuro on PC" : "Запустить Mokuro на ПК"}
                    </button>
                    {job && (active || job.bookKey === bookKey) && <div role="status">
                        {labels[job.state]}{job.bookKey !== bookKey ? ` · ${job.title}` : ""}
                        {job.state === "running" && job.total ? ` · ${job.current ?? 0}/${job.total}` : ""}
                        {job.error ? ` · ${job.error}` : ""}
                    </div>}
                    {error && <div className="manga-mokuro-error" role="status">
                        {error}{" "}<button type="button" className="manga-btn" onClick={() => setRefresh(v => v + 1)}>
                            {isEn ? "Check status" : "Проверить статус"}
                        </button>
                    </div>}
                </>
            )}
        </div>
    );
}
