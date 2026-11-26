import { useState } from "react";

// Phone settings → Google Drive → dictionaries. Two plain scenarios instead of
// a grid of numbers: get the whole collection saved from the PC onto the phone
// (main), or save the phone's collection to the cloud (rare, behind a toggle).

export type DictTransferPhase = "preparing" | "transfer" | "checking" | "done";

export type DictTransfer = {
    operation: "upload" | "download";
    phase: DictTransferPhase;
    transferred: number;
    total: number;
    percent: number;
    speed: number;
    eta: number;
    elapsed: number;
};

type Props = {
    isEn: boolean;
    busy: boolean;
    phoneBytes: number | null;
    phoneFreeBytes: number | null;
    cloudBytes: number | null;
    cloudUpdatedAt?: string;
    cloudFreeBytes: number | null;
    cloudUnlimited?: boolean;
    transfer: DictTransfer | null;
    formatBytes: (value?: number | string | null) => string;
    formatDuration: (seconds: number) => string;
    onDownload: () => void;
    onUpload: () => void;
};

const STEPS: DictTransferPhase[] = ["preparing", "transfer", "checking", "done"];

export default function MobileDictionarySync(props: Props) {
    const { isEn, busy, phoneBytes, phoneFreeBytes, cloudBytes, cloudUpdatedAt, cloudFreeBytes, cloudUnlimited, transfer, formatBytes, formatDuration } = props;
    const L = (en: string, ru: string) => (isEn ? en : ru);
    const [confirm, setConfirm] = useState<"download" | "upload" | null>(null);
    const [showUpload, setShowUpload] = useState(false);

    const hasCloud = cloudBytes != null && cloudBytes > 0;
    const hasPhone = phoneBytes != null && phoneBytes > 64 * 1024;
    const needForDownload = hasCloud ? cloudBytes! + Math.max(32 * 1024 * 1024, cloudBytes! * 0.02) : 0;
    const phoneHasRoom = phoneFreeBytes == null || !hasCloud || phoneFreeBytes >= needForDownload;
    const cloudHasRoom = cloudUnlimited || cloudFreeBytes == null || phoneBytes == null
        || cloudFreeBytes + (cloudBytes || 0) >= phoneBytes + Math.max(32 * 1024 * 1024, phoneBytes * 0.02);
    const updated = cloudUpdatedAt ? new Date(cloudUpdatedAt).toLocaleString(isEn ? "en-US" : "ru-RU", { dateStyle: "medium", timeStyle: "short" }) : "";

    const stepLabel = (step: DictTransferPhase, op: "upload" | "download") => {
        if (step === "preparing") return L("Preparing", "Подготовка");
        if (step === "transfer") return op === "download" ? L("Downloading", "Скачивание") : L("Uploading", "Загрузка");
        if (step === "checking") return op === "download" ? L("Checking & installing", "Проверка и установка") : L("Finishing", "Завершение");
        return L("Done", "Готово");
    };

    return (
        <section className="mobile-drive-block m-dict-sync">
            <div className="mobile-drive-block-head">
                <div>
                    <strong>{L("Dictionaries", "Словари")}</strong>
                    <span>
                        {L(
                            "All your Yomitan dictionaries travel as one file. On the PC, open Settings → Google Drive → Dictionary database → Upload to Drive once, then download it here — no need to import each dictionary on the phone.",
                            "Все словари Yomitan переносятся одним файлом. На ПК один раз открой Настройки → Google Drive → База словарей → «Загрузить в Drive» и скачай здесь, тогда не придётся импортировать каждый словарь на телефоне.",
                        )}
                    </span>
                </div>
            </div>

            <div className="m-dict-places">
                <div className={`m-dict-place${hasCloud ? "" : " is-empty"}`}>
                    <span className="m-dict-place-icon" aria-hidden="true">☁</span>
                    <span className="m-dict-place-name">{L("In the cloud", "В облаке")}</span>
                    <strong>{hasCloud ? formatBytes(cloudBytes) : L("nothing yet", "пока нет")}</strong>
                    <small>{hasCloud ? (updated ? L(`saved ${updated}`, `сохранено ${updated}`) : "") : L("save them from the PC", "сохрани их с ПК")}</small>
                </div>
                <span className="m-dict-arrow" aria-hidden="true">→</span>
                <div className="m-dict-place">
                    <span className="m-dict-place-icon" aria-hidden="true">▯</span>
                    <span className="m-dict-place-name">{L("On this phone", "На телефоне")}</span>
                    <strong>{phoneBytes != null ? formatBytes(phoneBytes) : "—"}</strong>
                    <small>{phoneFreeBytes != null ? L(`${formatBytes(phoneFreeBytes)} free`, `свободно ${formatBytes(phoneFreeBytes)}`) : ""}</small>
                </div>
            </div>

            {transfer && (
                <div className={`m-dict-progress${transfer.phase === "done" ? " is-done" : ""}`} role="status" aria-live="polite">
                    <ol className="m-dict-steps">
                        {STEPS.map((step) => {
                            const index = STEPS.indexOf(step);
                            const current = STEPS.indexOf(transfer.phase);
                            return (
                                <li key={step} className={index < current ? "is-past" : index === current ? "is-current" : ""}>
                                    {stepLabel(step, transfer.operation)}
                                </li>
                            );
                        })}
                    </ol>
                    <div className="mobile-drive-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(transfer.percent)}>
                        <span style={{ width: `${Math.max(0, Math.min(100, transfer.percent))}%` }} />
                    </div>
                    <div className="mobile-drive-transfer-meta">
                        <span>{formatBytes(transfer.transferred)} / {transfer.total ? formatBytes(transfer.total) : "—"}</span>
                        {transfer.phase === "transfer" && transfer.speed > 0 && <span>{formatBytes(transfer.speed)}/s</span>}
                        <span>
                            {transfer.phase === "transfer" && transfer.eta > 0
                                ? L(`${formatDuration(transfer.eta)} left`, `осталось ${formatDuration(transfer.eta)}`)
                                : transfer.phase === "checking"
                                    ? L("checking the file, a minute or two…", "проверяю файл, минуту-две…")
                                    : L(`took ${formatDuration(transfer.elapsed)}`, `прошло ${formatDuration(transfer.elapsed)}`)}
                        </span>
                    </div>
                    {transfer.phase !== "done" && (
                        <div className="m-dict-hint">{L("Keep Setsuna open until it finishes.", "Не закрывай Setsuna, пока не закончится.")}</div>
                    )}
                </div>
            )}

            {confirm === "download" ? (
                <div className="m-dict-confirm">
                    <p>
                        {L(
                            `The dictionaries on this phone${hasPhone ? ` (${formatBytes(phoneBytes)})` : ""} will be replaced by the ones from the cloud (${formatBytes(cloudBytes)}). It needs about ${formatBytes(needForDownload)} of free space. Wi-Fi is better: it's a big file.`,
                            `Словари на телефоне${hasPhone ? ` (${formatBytes(phoneBytes)})` : ""} заменятся словарями из облака (${formatBytes(cloudBytes)}). Нужно примерно ${formatBytes(needForDownload)} свободного места. Лучше по Wi-Fi: файл большой.`,
                        )}
                    </p>
                    <div className="mobile-settings-actions two">
                        <button type="button" className="mobile-action primary" onClick={() => { setConfirm(null); props.onDownload(); }}>{L("Download", "Скачать")}</button>
                        <button type="button" className="mobile-action" onClick={() => setConfirm(null)}>{L("Cancel", "Отмена")}</button>
                    </div>
                </div>
            ) : (
                <>
                    <button
                        type="button"
                        className="mobile-action primary m-dict-main"
                        disabled={busy || !hasCloud || !phoneHasRoom}
                        onClick={() => setConfirm("download")}
                    >
                        ↓ {hasCloud
                            ? L(`Download dictionaries to the phone · ${formatBytes(cloudBytes)}`, `Скачать словари на телефон · ${formatBytes(cloudBytes)}`)
                            : L("Download dictionaries to the phone", "Скачать словари на телефон")}
                    </button>
                    {hasCloud && !phoneHasRoom && (
                        <div className="mobile-drive-warning">
                            {L(
                                `Not enough space on the phone: about ${formatBytes(needForDownload)} is needed, ${formatBytes(phoneFreeBytes)} is free.`,
                                `На телефоне мало места: нужно около ${formatBytes(needForDownload)}, свободно ${formatBytes(phoneFreeBytes)}.`,
                            )}
                        </div>
                    )}
                </>
            )}

            <button type="button" className="m-dict-more" aria-expanded={showUpload} onClick={() => setShowUpload((open) => !open)}>
                {showUpload ? "▾" : "▸"} {L("Save the phone's dictionaries to the cloud", "Сохранить словари телефона в облако")}
            </button>
            {showUpload && (
                confirm === "upload" ? (
                    <div className="m-dict-confirm">
                        <p>
                            {hasCloud
                                ? L(
                                    `The copy in the cloud (${formatBytes(cloudBytes)}) will be replaced by the phone's (${formatBytes(phoneBytes)}). The PC will download this one next time.`,
                                    `Копия в облаке (${formatBytes(cloudBytes)}) заменится словарями с телефона (${formatBytes(phoneBytes)}). ПК в следующий раз скачает именно её.`,
                                )
                                : L(`The phone's dictionaries (${formatBytes(phoneBytes)}) will be saved to your Google Drive.`, `Словари телефона (${formatBytes(phoneBytes)}) сохранятся в твой Google Drive.`)}
                        </p>
                        <div className="mobile-settings-actions two">
                            <button type="button" className="mobile-action primary" onClick={() => { setConfirm(null); props.onUpload(); }}>{L("Save", "Сохранить")}</button>
                            <button type="button" className="mobile-action" onClick={() => setConfirm(null)}>{L("Cancel", "Отмена")}</button>
                        </div>
                    </div>
                ) : (
                    <div className="m-dict-upload">
                        <div className="mobile-settings-note">
                            {L(
                                "Only needed if you imported dictionaries on the phone and want them on other devices. Usually the PC does this.",
                                "Нужно, только если ты импортировал словари на телефоне и хочешь перенести их на другие устройства. Обычно это делается с ПК.",
                            )}
                        </div>
                        <button type="button" className="mobile-action" disabled={busy || !hasPhone || !cloudHasRoom} onClick={() => setConfirm("upload")}>
                            ↑ {L(`Save to Google Drive · ${formatBytes(phoneBytes)}`, `Сохранить в Google Drive · ${formatBytes(phoneBytes)}`)}
                        </button>
                        {!cloudHasRoom && (
                            <div className="mobile-drive-warning">{L("Not enough free space in Google Drive.", "В Google Drive недостаточно места.")}</div>
                        )}
                    </div>
                )
            )}
        </section>
    );
}
