import { readWebText, type WebTrack } from "./webMedia";
import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { isMobilePlatform } from "../../utils/platform";
import { fileName, subtitleExtensions } from "./localMedia";
import { decodeSubtitleBytes, parseSubtitleFile, type Cue } from "./model";
import { isMobileMediaPath, mobileFileFor } from "./mobileMedia";
import { isAndroidFolderPath, readAndroidFileBytes } from "./androidFolders";

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
    const mobileSubInputRef = useRef<HTMLInputElement>(null);
    const mobilePick = useRef<{ slot: number; version: number } | undefined>(undefined);
    const text = (english: string, russian: string) => (en ? english : russian);
    const load = async (slot: number, choice: string, available = tracks) => {
        chosen.current[slot] = true;
        const version = ++versions.current[slot];
        const setCues = slot === 0 ? onPrimary : onTranslation;
        let label = "";
        try {
            let cues: Cue[] = [];
            if (choice === "file" && isMobilePlatform()) {
                mobilePick.current = { slot, version };
                mobileSubInputRef.current?.click();
                return;
            }
            if (choice === "file" || choice.startsWith("local:")) {
                const path = choice.startsWith("local:")
                    ? choice.slice(6)
                    : await open({
                          multiple: false,
                          filters: [{ name: text("Subtitles", "Субтитры"), extensions: subtitleExtensions }],
                      });
                if (!path || typeof path !== "string") return;
                label = fileName(path);
                const picked = isMobileMediaPath(path) ? mobileFileFor(path) : undefined;
                const bytes = picked
                    ? await picked.arrayBuffer()
                    : isAndroidFolderPath(path)
                      ? readAndroidFileBytes(path)
                      : await invoke<ArrayBuffer>("player_read_local_subtitle", { path });
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
        if (source && !isMobilePlatform() && !source.startsWith("blob:") && !isMobileMediaPath(source) && !isAndroidFolderPath(source))
            void invoke<Track[]>("player_subtitle_tracks", { source })
                .then((list) => {
                    if (!live) return;
                    setTracks(list);
                    const japanese = list.find((track) => /^(ja|jpn)$/i.test(track.tags?.language || ""));
                    const autoPick = !webTracks.length && !primaryFile && !chosen.current[0];
                    const primary = autoPick ? japanese || list[0] : undefined;
                    if (primary) void load(0, String(primary.index), list);
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
            <input
                ref={mobileSubInputRef}
                type="file"
                accept=".srt,.vtt,.ass,.ssa,text/vtt,application/x-subrip"
                style={{ display: "none" }}
                onChange={async (e) => {
                    const file = e.currentTarget.files?.[0];
                    e.currentTarget.value = "";
                    if (!file) return;
                    const pick = mobilePick.current;
                    mobilePick.current = undefined;
                    if (!pick) return;
                    const { slot, version } = pick;
                    try {
                        const buf = await file.arrayBuffer();
                        if (version !== versions.current[slot]) return;
                        const cues = parseSubtitleFile(decodeSubtitleBytes(new Uint8Array(buf)), file.name);
                        if (!cues.length) throw new Error(text("No timed text found", "В дорожке нет текстовых реплик"));
                        (slot === 0 ? onPrimary : onTranslation)(cues);
                        setNames((prev) => prev.map((name, i) => (i === slot ? file.name : name)));
                    } catch (err) {
                        if (version === versions.current[slot]) report(String(err));
                    }
                }}
            />
            {[text("Subtitles", "Субтитры"), text("Translation", "Перевод")].map((label, i) => (
                <label key={i}>
                    {label}
                    <select value="current" onChange={(e) => void load(i, e.target.value)}>
                        <option hidden value="current">
                            {names[i] || (i === 1 ? text("Off", "Выключено") : text("Choose track…", "Выбрать дорожку…"))}
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
