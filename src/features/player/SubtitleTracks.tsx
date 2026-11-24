import { readWebText, type WebTrack } from "./webMedia";
import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { fileName, isJapaneseSubtitlePath, subtitleExtensions } from "./localMedia";
import { decodeSubtitleBytes, parseSubtitleFile, type Cue } from "./model";

type Track = { index: number; tags?: { title?: string; language?: string } };
type Props = {
    source: string;
    webTracks: WebTrack[];
    primaryFile?: string;
    translationFile?: string;
    en: boolean;
    onPrimary: (cues: Cue[]) => void;
    onTranslation: (cues: Cue[]) => void;
    report: (s: string) => void;
};

export function SubtitleTracks({
    source,
    webTracks,
    primaryFile,
    translationFile,
    en,
    onPrimary,
    onTranslation,
    report,
}: Props) {
    const [tracks, setTracks] = useState<Track[]>([]);
    const [names, setNames] = useState(["", ""]);
    const versions = useRef([0, 0]);
    const chosen = useRef([false, false]);
    const text = (english: string, russian: string) => (en ? english : russian);
    const load = async (slot: number, choice: string, available = tracks) => {
        chosen.current[slot] = true;
        const version = ++versions.current[slot];
        const setCues = slot === 0 ? onPrimary : onTranslation;
        let label = "";
        try {
            let cues: Cue[] = [];
            if (choice === "file" || choice.startsWith("local:")) {
                const path = choice.startsWith("local:")
                    ? choice.slice(6)
                    : await open({
                          multiple: false,
                          filters: [{ name: text("Subtitles", "Субтитры"), extensions: subtitleExtensions }],
                      });
                if (!path || typeof path !== "string") return;
                label = fileName(path);
                const bytes = await invoke<ArrayBuffer>("player_read_local_subtitle", { path });
                cues = parseSubtitleFile(decodeSubtitleBytes(new Uint8Array(bytes)), path);
            } else if (choice.startsWith("web:")) {
                const track = webTracks[Number(choice.slice(4))];
                const response = await readWebText(track.url);
                label = track.label || track.language || "CC";
                cues = parseSubtitleFile(response.text, new URL(response.url).pathname);
            } else if (choice !== "") {
                const index = Number(choice);
                const track = available.find((t) => t.index === index);
                label = track?.tags?.title || track?.tags?.language || "#" + index;
                cues = parseSubtitleFile(await invoke("player_subtitle_text", { source, index }), "embedded.vtt");
            }
            if (version !== versions.current[slot]) return;
            if (choice !== "" && !cues.length)
                throw new Error(text("No timed text found", "В дорожке нет текстовых реплик"));
            setCues(cues);
            setNames((prev) => prev.map((name, i) => (i === slot ? label : name)));
        } catch (error) {
            if (version === versions.current[slot]) report(String(error));
        }
    };

    useEffect(() => {
        let live = true;

        if (webTracks.length && !primaryFile) {
            let index = webTracks.findIndex((t) => /^ja(?:-|$)/i.test(t.language));
            if (index < 0) index = 0;
            void load(0, "web:" + index);
        }
        if (source)
            void invoke<Track[]>("player_subtitle_tracks", { source })
                .then((list) => {
                    if (!live) return;
                    setTracks(list);
                    const japanese = list.find((track) => /^(ja|jpn)$/i.test(track.tags?.language || ""));
                    const autoPick = !webTracks.length && !primaryFile && !chosen.current[0];
                    const primary = autoPick ? japanese || list[0] : undefined;
                    if (primary) void load(0, String(primary.index), list);
                    if (
                        !translationFile &&
                        !chosen.current[1] &&
                        (primaryFile
                            ? isJapaneseSubtitlePath(primaryFile)
                            : Boolean(primary && primary === japanese))
                    ) {
                        const preferred = en ? /^(en|eng)$/i : /^(ru|rus)$/i;
                        const translation =
                            list.find((track) => preferred.test(track.tags?.language || "")) ||
                            list.find((track) => /^(en|eng|ru|rus)$/i.test(track.tags?.language || ""));
                        if (translation) void load(1, String(translation.index), list);
                    }
                })
                .catch(() => {
                    /* External subtitle files also work without ffprobe. */
                });
        return () => {
            live = false;
        };
    }, [source, webTracks]);
    useEffect(
        () => () => {
            versions.current = versions.current.map((n) => n + 1);
        },
        [],
    );
    useEffect(() => {
        if (primaryFile) void load(0, "local:" + primaryFile);
    }, [primaryFile]);
    useEffect(() => {
        if (translationFile) void load(1, "local:" + translationFile);
    }, [translationFile]);

    return (
        <div className="sp-tracks">
            {[text("Subtitles", "Субтитры"), text("Translation", "Перевод")].map((label, i) => (
                <label key={i}>
                    {label}
                    <select value="current" onChange={(e) => void load(i, e.target.value)}>
                        <option hidden value="current">
                            {names[i] || text("Choose track…", "Выбрать дорожку…")}
                        </option>
                        <option value="file">{text("Open file…", "Из файла…")}</option>
                        {webTracks.map((track, index) => (
                            <option key={track.url} value={"web:" + index}>
                                {track.label || track.language || "CC"}
                            </option>
                        ))}
                        {tracks.map((track) => (
                            <option key={track.index} value={track.index}>
                                #{track.index} {track.tags?.language} {track.tags?.title}
                            </option>
                        ))}
                        <option value="">{text("Off", "Выключить")}</option>
                    </select>
                </label>
            ))}
        </div>
    );
}
