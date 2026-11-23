import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import {
    DRIVE_SHARE_SCOPE,
    cleanupUnusedDictionaryParts,
    deleteDriveFile,
    listDictionaryParts,
    getAccessTokenInfo,
    listDictionaryShares,
    loadStoredGoogleRefreshToken,
    type DictionaryShareFile,
} from "../../utils/gdrive";
import "./DictionaryShare.css";

// Share dictionaries through the sharer's Google Drive and receive them by a
// code. See src-tauri/src/dictionary_share.rs.

type Tab = "share" | "receive" | "mine";

interface DictionaryShareProps {
    language: "ru" | "en";
    dictionaries: { name: string }[];
    initialSelection?: string[];
    initialTab?: Tab;
    onClose: () => void;
    syncDictionaries: () => Promise<void>;
}

const formatSize = (bytes?: number | string) => {
    const value = Number(bytes || 0);
    if (value >= 1e9) return `${(value / 1e9).toFixed(1)} GB`;
    if (value >= 1e6) return `${(value / 1e6).toFixed(1)} MB`;
    return `${Math.max(1, Math.round(value / 1e3))} KB`;
};

const copy = (text: string) => writeText(text).catch(() => navigator.clipboard?.writeText(text));

export default function DictionaryShare({ language, dictionaries, initialSelection = [], initialTab = "share", onClose, syncDictionaries }: DictionaryShareProps) {
    const en = language === "en";
    const [tab, setTab] = useState<Tab>(initialTab);
    const [selected, setSelected] = useState<string[]>(initialSelection.length ? initialSelection : []);
    const [title, setTitle] = useState("");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const [result, setResult] = useState<{ code: string; sizeBytes: number; uploadedBytes?: number; reused?: number; count?: number } | null>(null);
    const [copied, setCopied] = useState("");
    const [code, setCode] = useState("");
    const [received, setReceived] = useState<number | null>(null);
    const [shares, setShares] = useState<DictionaryShareFile[] | null>(null);
    const [partsInfo, setPartsInfo] = useState<{ count: number; bytes: number } | null>(null);
    // Receive: the code's contents, listed before anything big is downloaded.
    const [inspected, setInspected] = useState<null | { code: string; format: number; title?: string; dictionaries: { name: string; rows: number; sizeBytes: number }[] }>(null);
    const [inspecting, setInspecting] = useState(false);
    const [picked, setPicked] = useState<string[]>([]);

    const names = useMemo(() => dictionaries.map((d) => d.name), [dictionaries]);
    const allSelected = selected.length === names.length && names.length > 0;

    const explain = (raw: unknown) => {
        const message = String(raw);
        if (message.includes("DRIVE_SCOPE_MISSING")) {
            return en
                ? "Setsuna needs permission to create the shared file in your Google Drive. Open Settings → Google Drive, sign out and sign in again, and allow it."
                : "Setsuna нужно разрешение создавать файл для раздачи в твоём Google Drive. Открой Настройки → Google Drive, выйди и войди снова, и разреши доступ.";
        }
        if (message.includes("SHARE_CODE_INVALID")) return en ? "This doesn't look like a share code." : "Это не похоже на код раздачи.";
        if (message.includes("SHARE_CODE_NOT_FOUND")) {
            return en
                ? "Nothing found for this code. The file may have been deleted, or the code was copied incompletely."
                : "По этому коду ничего не нашлось. Возможно, файл удалили или код скопирован не полностью.";
        }
        return message;
    };

    const driveToken = async () => {
        const refresh = await loadStoredGoogleRefreshToken().catch(() => null);
        if (!refresh) {
            throw new Error(en
                ? "Connect Google Drive first: Settings → Google Drive → Sign in."
                : "Сначала подключи Google Drive: Настройки → Google Drive → Войти.");
        }
        const info = await getAccessTokenInfo(refresh);
        if (!info.scopes.includes(DRIVE_SHARE_SCOPE)) throw new Error("DRIVE_SCOPE_MISSING");
        return info.token;
    };

    const share = async () => {
        if (!selected.length || busy) return;
        setBusy(true);
        setError("");
        setResult(null);
        try {
            const token = await driveToken();
            const label = title.trim() || (selected.length === 1 ? selected[0] : `${selected[0]} +${selected.length - 1}`);
            const ordered = names.filter((name) => selected.includes(name));
            const response = await invoke<{ code: string; sizeBytes: number; uploadedBytes: number; reused: number; count: number }>("share_dictionaries", { token, names: ordered, title: label });
            setResult(response);
        } catch (e) {
            setError(explain(e instanceof Error ? e.message : e));
        } finally {
            setBusy(false);
        }
    };

    // Look the code up as soon as it looks complete: only the small list is fetched.
    useEffect(() => {
        const value = code.trim();
        if (value.length < 20) { setInspected(null); return; }
        if (inspected?.code === value) return;
        let cancelled = false;
        const timer = window.setTimeout(async () => {
            setInspecting(true);
            setError("");
            try {
                const info = await invoke<{ format: number; title?: string; dictionaries: { name: string; rows: number; sizeBytes: number }[] }>("inspect_shared_dictionaries", { code: value });
                if (cancelled) return;
                setInspected({ code: value, ...info });
                setPicked(info.dictionaries.map((d) => d.name));
            } catch (e) {
                if (!cancelled) { setInspected(null); setError(explain(e)); }
            } finally {
                if (!cancelled) setInspecting(false);
            }
        }, 350);
        return () => { cancelled = true; window.clearTimeout(timer); };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [code]);

    const receive = async () => {
        if (!code.trim() || busy) return;
        const listed = inspected && inspected.dictionaries.length > 0;
        if (listed && picked.length === 0) return;
        setBusy(true);
        setError("");
        setReceived(null);
        try {
            const count = await invoke<number>("receive_shared_dictionaries", { code: code.trim(), names: listed ? picked : null });
            await syncDictionaries().catch(() => {});
            setReceived(count);
            setCode("");
            setInspected(null);
        } catch (e) {
            setError(explain(e));
        } finally {
            setBusy(false);
        }
    };

    useEffect(() => {
        if (tab !== "mine" || shares !== null) return;
        let cancelled = false;
        (async () => {
            try {
                const token = await driveToken();
                const [files, parts] = await Promise.all([listDictionaryShares(token), listDictionaryParts(token)]);
                if (!cancelled) {
                    setShares(files);
                    setPartsInfo({ count: parts.length, bytes: parts.reduce((sum, part) => sum + Number(part.size || 0), 0) });
                }
            } catch (e) {
                if (!cancelled) { setShares([]); setError(explain(e instanceof Error ? e.message : e)); }
            }
        })();
        return () => { cancelled = true; };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [tab, shares]);

    const removeShare = async (file: DictionaryShareFile) => {
        const ok = window.confirm(en
            ? `Stop sharing and delete "${file.name}" from your Google Drive? The code will stop working.`
            : `Прекратить раздачу и удалить «${file.name}» с твоего Google Drive? Код перестанет работать.`);
        if (!ok) return;
        try {
            const token = await driveToken();
            await deleteDriveFile(token, file.id);
            setShares((prev) => (prev || []).filter((f) => f.id !== file.id));
            // Parts no other share uses are deleted too, freeing Drive space.
            await cleanupUnusedDictionaryParts(token);
            const parts = await listDictionaryParts(token);
            setPartsInfo({ count: parts.length, bytes: parts.reduce((sum, part) => sum + Number(part.size || 0), 0) });
        } catch (e) {
            setError(explain(e instanceof Error ? e.message : e));
        }
    };

    const doCopy = (text: string) => { void copy(text); setCopied(text); window.setTimeout(() => setCopied(""), 1600); };

    return (
        <div className="modal-overlay dshare-overlay" onClick={() => !busy && onClose()}>
            <div className="modern-modal dshare" onClick={(e) => e.stopPropagation()} role="dialog" aria-label={en ? "Share dictionaries" : "Обмен словарями"}>
                <header className="dshare-head">
                    <strong>{en ? "Share dictionaries" : "Обмен словарями"}</strong>
                    <button type="button" className="dshare-close" onClick={onClose} disabled={busy} aria-label={en ? "Close" : "Закрыть"}>✕</button>
                </header>
                <nav className="dshare-tabs">
                    {(["share", "receive", "mine"] as Tab[]).map((key) => (
                        <button key={key} type="button" className={tab === key ? "is-active" : ""} disabled={busy} onClick={() => { setTab(key); setError(""); }}>
                            {key === "share" ? (en ? "Share" : "Поделиться") : key === "receive" ? (en ? "Enter a code" : "Получить по коду") : (en ? "My shares" : "Мои раздачи")}
                        </button>
                    ))}
                </nav>

                {tab === "share" && (
                    result ? (
                        <div className="dshare-body">
                            <p className="dshare-lead">{en ? "Done! Send this code to a friend:" : "Готово! Отправь этот код другу:"}</p>
                            <div className="dshare-code">
                                <code>{result.code}</code>
                                <button type="button" className="btn-primary" onClick={() => doCopy(result.code)}>{copied === result.code ? (en ? "Copied" : "Скопировано") : (en ? "Copy" : "Копировать")}</button>
                            </div>
                            <p className="dshare-muted">
                                {en
                                    ? `They enter it in Setsuna → Dictionaries → Share → Enter a code and pick what they need. ${result.count ?? ''} dictionaries, ${formatSize(result.sizeBytes)} compressed${result.reused ? `; ${result.reused} were already in your Drive and reused, only ${formatSize(result.uploadedBytes || 0)} was uploaded` : ''}. Delete the share in "My shares" to stop sharing.`
                                    : `Друг вводит его в Setsuna → Словари → Обмен → «Получить по коду» и выбирает нужное. Словарей: ${result.count ?? ''}, в сжатом виде ${formatSize(result.sizeBytes)}${result.reused ? `; ${result.reused} уже были у тебя на Drive и взяты готовыми, загружено только ${formatSize(result.uploadedBytes || 0)}` : ''}. Чтобы прекратить раздачу, удали её в «Мои раздачи».`}
                            </p>
                            <button type="button" className="dshare-link" onClick={() => setResult(null)}>{en ? "Share something else" : "Поделиться ещё"}</button>
                        </div>
                    ) : (
                        <div className="dshare-body">
                            <div className="dshare-list-head">
                                <span>{en ? `Picked: ${selected.length}` : `Выбрано: ${selected.length}`}</span>
                                <button type="button" className="dshare-link" disabled={busy} onClick={() => setSelected(allSelected ? [] : names)}>
                                    {allSelected ? (en ? "Clear" : "Снять всё") : (en ? "All (whole database)" : "Все (вся база)")}
                                </button>
                            </div>
                            <div className="dshare-list">
                                {names.length === 0 && <div className="dshare-muted">{en ? "No dictionaries installed." : "Словарей нет."}</div>}
                                {names.map((name) => (
                                    <label key={name} className="checkbox-label">
                                        <input type="checkbox" disabled={busy} checked={selected.includes(name)} onChange={(e) => setSelected((prev) => e.target.checked ? [...prev, name] : prev.filter((n) => n !== name))} />
                                        <span>{name}</span>
                                    </label>
                                ))}
                            </div>
                            <input className="modern-input" value={title} disabled={busy} onChange={(e) => setTitle(e.target.value)} placeholder={en ? "Name for the pack (optional)" : "Название пакета (необязательно)"} />
                            <button type="button" className="btn-primary dshare-main" disabled={!selected.length || busy} onClick={share}>
                                {busy ? (en ? "Preparing…" : "Готовлю…") : (en ? "Create a code" : "Создать код")}
                            </button>
                            <p className="dshare-muted">
                                {en
                                    ? "The pack is uploaded to your Google Drive and anyone with the code can download it. Share only dictionaries whose license allows it."
                                    : "Пакет загрузится на твой Google Drive, скачать его сможет любой, у кого есть код. Делись только словарями, лицензия которых это разрешает."}
                            </p>
                        </div>
                    )
                )}

                {tab === "receive" && (
                    <div className="dshare-body">
                        <p className="dshare-lead">{en ? "Paste the code (or the Google Drive link) you got:" : "Вставь код (или ссылку Google Drive), который тебе прислали:"}</p>
                        <input className="modern-input dshare-code-input" value={code} disabled={busy} onChange={(e) => setCode(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void receive(); }} placeholder="1AbC…" autoFocus spellCheck={false} />
                        {inspecting && <div className="dshare-muted">{en ? "Reading the list…" : "Смотрю, что внутри…"}</div>}
                        {inspected && inspected.dictionaries.length > 0 && (
                            <>
                                <div className="dshare-list-head">
                                    <span>{inspected.title ? `${inspected.title} · ` : ""}{en ? `Picked ${picked.length} of ${inspected.dictionaries.length}` : `Выбрано ${picked.length} из ${inspected.dictionaries.length}`}</span>
                                    <button type="button" className="dshare-link" disabled={busy} onClick={() => setPicked(picked.length === inspected.dictionaries.length ? [] : inspected.dictionaries.map((d) => d.name))}>
                                        {picked.length === inspected.dictionaries.length ? (en ? "Clear" : "Снять всё") : (en ? "All" : "Все")}
                                    </button>
                                </div>
                                <div className="dshare-list">
                                    {inspected.dictionaries.map((d) => (
                                        <label key={d.name} className="checkbox-label dshare-row">
                                            <input type="checkbox" disabled={busy} checked={picked.includes(d.name)} onChange={(e) => setPicked((prev) => e.target.checked ? [...prev, d.name] : prev.filter((n) => n !== d.name))} />
                                            <span>{d.name}</span>
                                            <em>{formatSize(d.sizeBytes)}</em>
                                        </label>
                                    ))}
                                </div>
                            </>
                        )}
                        {inspected && inspected.dictionaries.length === 0 && (
                            <div className="dshare-muted">{en ? "An older share: its list isn't available, everything in it will be downloaded." : "Раздача старого формата: список недоступен, скачается всё, что в ней есть."}</div>
                        )}
                        <button type="button" className="btn-primary dshare-main" disabled={!code.trim() || busy || inspecting || (Boolean(inspected?.dictionaries.length) && picked.length === 0)} onClick={receive}>
                            {busy
                                ? (en ? "Downloading…" : "Скачиваю…")
                                : inspected?.dictionaries.length
                                    ? (en
                                        ? `Download ${picked.length} · ${formatSize(inspected.dictionaries.filter((d) => picked.includes(d.name)).reduce((sum, d) => sum + d.sizeBytes, 0))}`
                                        : `Скачать ${picked.length} · ${formatSize(inspected.dictionaries.filter((d) => picked.includes(d.name)).reduce((sum, d) => sum + d.sizeBytes, 0))}`)
                                    : (en ? "Download dictionaries" : "Скачать словари")}
                        </button>
                        {received !== null && (
                            <p className="dshare-ok">{en ? "Dictionaries installed." : "Словари установлены."}</p>
                        )}
                        <p className="dshare-muted">{en ? "No Google sign-in is needed to receive. Dictionaries with the same name are replaced." : "Чтобы получить словари, входить в Google не нужно. Словари с тем же названием заменятся новыми."}</p>
                    </div>
                )}

                {tab === "mine" && (
                    <div className="dshare-body">
                        {shares === null && <div className="dshare-muted">{en ? "Loading…" : "Загружаю…"}</div>}
                        {shares && shares.length === 0 && !error && <div className="dshare-muted">{en ? "You haven't shared anything yet." : "Ты пока ничем не делился."}</div>}
                        {partsInfo && partsInfo.count > 0 && (
                            <div className="dshare-muted">
                                {en
                                    ? `Dictionaries in your Drive: ${partsInfo.count}, ${formatSize(partsInfo.bytes)}. Each is stored once and shared by all your codes.`
                                    : `Словарей у тебя на Drive: ${partsInfo.count}, занимают ${formatSize(partsInfo.bytes)}. Каждый хранится один раз и используется всеми твоими кодами.`}
                            </div>
                        )}
                        {shares?.map((file) => (
                            <div key={file.id} className="dshare-share">
                                <div className="dshare-share-main">
                                    <strong title={file.description || file.name}>{file.name.replace(/ — Setsuna\.setsuna-dicts(\.gz|\.json)?$/, "")}</strong>
                                    <span>{(file.description || "").replace(/^Setsuna dictionaries: /, "") || formatSize(file.size)}{file.createdTime ? ` · ${new Date(file.createdTime).toLocaleDateString(en ? "en-GB" : "ru-RU")}` : ""}</span>
                                </div>
                                <button type="button" onClick={() => doCopy(file.id)}>{copied === file.id ? (en ? "Copied" : "Скопировано") : (en ? "Copy code" : "Код")}</button>
                                <button type="button" className="is-danger" onClick={() => removeShare(file)}>{en ? "Delete" : "Удалить"}</button>
                            </div>
                        ))}
                    </div>
                )}

                {error && <div className="dshare-error">{error}</div>}
            </div>
        </div>
    );
}
