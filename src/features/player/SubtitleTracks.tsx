import { readWebText, type WebTrack } from "./webMedia";
import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { decodeSubtitleBytes, parseSubtitleFile, type Cue } from "./model";

type Track = { index: number; tags?: { title?: string; language?: string } };
type Props = {
    source: string;
    webTracks: WebTrack[];
    en: boolean;
    onPrimary: (cues: Cue[]) => void;
    onTranslation: (cues: Cue[]) => void;
    report: (s: string) => void;
};

export function SubtitleTracks({ source, webTracks, en, onPrimary, onTranslation, report }: Props) {
    const [tracks, setTracks] = useState<Track[]>([]);
    const [names, setNames] = useState(["", ""]);
    const versions = useRef([0, 0]);
    const text = (english: string, russian: string) => (en ? english : russian);
    const load = async (slot: number, choice: string, available = tracks) => {
        const version = ++versions.current[slot];
        const setCues = slot === 0 ? onPrimary : onTranslation;
        let label = "";
        try {
            let cues: Cue[] = [];
            if (choice === "file") {
                const path = await open({
                    multiple: false,
                    filters: [{ name: text("Subtitles", "Субтитры"), extensions: ["srt", "vtt", "ass", "ssa"] }],
                });
                if (!path || typeof path !== "string") return;
                label = path.split(/[\\/]/).pop() || path;
                const bytes = await invoke<number[]>("read_file_bytes", { path });
                cues = parseSubtitleFile(decodeSubtitleBytes(Uint8Array.from(bytes)), path);
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
        const initialVersion = versions.current[0];
        if (webTracks.length) {
            let index = webTracks.findIndex((t) => /^ja(?:-|$)/i.test(t.language));
            if (index < 0) index = 0;
            void load(0, "web:" + index);
        }
        if (source)
            void invoke<Track[]>("player_subtitle_tracks", { source })
                .then((list) => {
                    if (!live) return;
                    setTracks(list);
                    if (!webTracks.length && list.length && initialVersion === versions.current[0]) {
                        const selected = list.find((t) => /^(ja|jpn)$/i.test(t.tags?.language || "")) || list[0];
                        void load(0, String(selected.index), list);
                    }
                })
                .catch(() => {
                    /* External subtitle files also work without ffprobe. */
                });
        return () => {
            live = false;
            versions.current = versions.current.map((n) => n + 1);
        };
    }, [source, webTracks]);

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
