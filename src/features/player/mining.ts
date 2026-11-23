import { invoke } from "@tauri-apps/api/core";
import type { AppSettings } from "../../components/SettingsModal";
import { addNote } from "../../utils/anki";
import { escapeCardText, clipInterval, type PlayerScene } from "./model";

export const subtitleScenes = new WeakMap<Element, PlayerScene>();

type Clip = { filename: string; path: string; media_type: string };

export async function addPlayerNote(
    settings: AppSettings,
    note: Parameters<typeof addNote>[1],
    scene: PlayerScene,
    withFrame = false,
    exactRange = false,
) {
    let clip: Clip | undefined;
    try {
        if (settings.playerMiningUseClipForAnki !== false) {
            const video = !scene.audioOnly && (settings.playerCardFormat ?? "video") === "video";
            const interval = exactRange
                ? { start: scene.start, end: scene.end }
                : clipInterval(
                      scene,
                      video ? (settings.playerSceneLeadIn ?? 5) : (settings.playerMiningLeadIn ?? 0.15),
                      settings.playerMiningLeadOut ?? 0.25,
                  );
            clip = await invoke<Clip>("extract_player_clip", {
                sourcePath: scene.source,
                ...interval,
                preferVideo: video,
                ...(scene.audioTrack !== undefined ? { audioTrack: scene.audioTrack } : {}),
            });
        }
        const autoFrame = clip?.media_type === "video";
        const frame =
            !scene.audioOnly && (withFrame || autoFrame)
                ? await invoke<string>("player_scene_frame", {
                      source: scene.source,
                      time: (scene.start + scene.end) / 2,
                  })
                : undefined;
        return await addNote(settings, {
            ...note,
            sentence: escapeCardText(note.sentence || ""),
            sentenceFurigana: escapeCardText(note.sentenceFurigana || note.sentence || ""),
            audioPath: clip?.path,
            audioFilename: clip?.filename,
            audioMediaType: clip?.media_type,
            screenshot: frame,
            playerScene: true,
        });
    } catch (error) {
        return { error: String(error) };
    } finally {
        if (clip) await invoke("discard_player_clip", { filename: clip.filename }).catch(console.warn);
    }
}
