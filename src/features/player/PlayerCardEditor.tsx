import { useEffect, useRef, useState } from "react";
import type { PlayerScene } from "./model";
import { formatClock } from "./model";

export type SceneDraft = { word: string; sentence: string; meaning: string; scene: PlayerScene };

export function PlayerCardEditor({
    draft,
    en,
    onClose,
    onSave,
}: {
    draft: SceneDraft;
    en: boolean;
    onClose: () => void;
    onSave: (draft: SceneDraft) => Promise<string | undefined>;
}) {
    const dialog = useRef<HTMLDialogElement>(null);
    const [value, setValue] = useState(draft);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState("");
    useEffect(() => {
        dialog.current?.showModal();
    }, []);
    return (
        <dialog
            className="sp-editor"
            ref={dialog}
            onCancel={(e) => {
                e.preventDefault();
                if (!saving) onClose();
            }}
        >
            <form
                onSubmit={async (e) => {
                    e.preventDefault();
                    if (saving || !value.word.trim() || value.scene.end <= value.scene.start) return;
                    setSaving(true);
                    try {
                        const failure = await onSave(value);
                        if (failure) setError(failure);
                        else onClose();
                    } finally {
                        setSaving(false);
                    }
                }}
            >
                <strong>{en ? "Anki card" : "Карточка Anki"}</strong>
                <label>
                    {en ? "Word or expression" : "Слово или выражение"}
                    <input
                        required
                        autoFocus
                        value={value.word}
                        onChange={(e) => setValue({ ...value, word: e.target.value })}
                    />
                </label>
                <label>
                    {en ? "Subtitle" : "Реплика"}
                    <textarea
                        value={value.sentence}
                        onChange={(e) => setValue({ ...value, sentence: e.target.value })}
                    />
                </label>
                <label>
                    {en ? "Meaning or translation" : "Значение или перевод"}
                    <textarea
                        value={value.meaning}
                        onChange={(e) => setValue({ ...value, meaning: e.target.value })}
                    />
                </label>
                <div className="sp-interval">
                    {(["start", "end"] as const).map((key, i) => (
                        <label key={key}>
                            {(en ? ["Clip start", "Clip end"] : ["Начало клипа", "Конец клипа"])[i]} ·{" "}
                            {formatClock(value.scene[key])}
                            <input
                                required
                                type="number"
                                min={0}
                                max={value.scene.duration}
                                step="any"
                                value={value.scene[key]}
                                onChange={(e) =>
                                    setValue({
                                        ...value,
                                        scene: { ...value.scene, [key]: Number(e.target.value) },
                                    })
                                }
                            />
                        </label>
                    ))}
                </div>
                {error && <output role="alert">{error}</output>}
                <footer>
                    <button type="button" disabled={saving} onClick={onClose}>
                        {en ? "Cancel" : "Отмена"}
                    </button>
                    <button disabled={saving || value.scene.end <= value.scene.start}>
                        {saving ? "…" : en ? "Add to Anki" : "Добавить в Anki"}
                    </button>
                </footer>
            </form>
        </dialog>
    );
}
