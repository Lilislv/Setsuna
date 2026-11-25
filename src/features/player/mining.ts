import { invoke } from "@tauri-apps/api/core";
import type { AppSettings } from "../../components/SettingsModal";
import { addNote, updateLastNoteWithScene } from "../../utils/anki";
import { escapeCardText, clipInterval, type PlayerScene } from "./model";

export const subtitleScenes = new WeakMap<Element, PlayerScene>();

type Clip = { filename: string; path: string; media_type: string };

async function extractSceneClipAndFrame(
    settings: AppSettings,
    scene: PlayerScene,
    withFrame = false,
    exactRange = false,
) {
    let clip: Clip | undefined;
    if (settings.playerMiningUseClipForAnki !== false) {
        const video = !scene.audioOnly && (settings.playerCardFormat ?? "video") === "video";
        const interval = exactRange
            ? { start: scene.start, end: scene.end }
            : clipInterval(scene, settings.playerClipPadStart, settings.playerClipPadEnd);
        clip = await invoke<Clip>("extract_player_clip", {
            sourcePath: scene.source,
            ...interval,
            preferVideo: video,
            ...(scene.audioTrack !== undefined ? { audioTrack: scene.audioTrack } : {}),
            ...(video && settings.playerVideoQuality ? { videoQuality: settings.playerVideoQuality } : {}),
        });
    }
    const frame =
        !scene.audioOnly && withFrame && clip?.media_type !== "video"
            ? await invoke<string>("player_scene_frame", {
                  source: scene.source,
                  time: (scene.start + scene.end) / 2,
              })
            : undefined;
    return { clip, frame };
}

export async function addPlayerNote(
    settings: AppSettings,
    note: Parameters<typeof addNote>[1],
    scene: PlayerScene,
    withFrame = false,
    exactRange = false,
) {
    let clip: Clip | undefined;
    try {
        const extracted = await extractSceneClipAndFrame(settings, scene, withFrame, exactRange);
        clip = extracted.clip;
        return await addNote(settings, {
            ...note,
            sentence: escapeCardText(note.sentence || ""),
            sentenceFurigana: escapeCardText(note.sentenceFurigana || note.sentence || ""),
            audioPath: clip?.path,
            audioFilename: clip?.filename,
            audioMediaType: clip?.media_type,
            screenshot: extracted.frame,
            playerScene: true,
        });
    } catch (error) {
        return { error: String(error) };
    } finally {
        if (clip) await invoke("discard_player_clip", { filename: clip.filename }).catch(console.warn);
    }
}

export async function updateLastPlayerNote(
    settings: AppSettings,
    note: { sentence?: string; sentenceFurigana?: string },
    scene: PlayerScene,
    withFrame = true,
    exactRange = false,
) {
    let clip: Clip | undefined;
    try {
        const extracted = await extractSceneClipAndFrame(settings, scene, withFrame, exactRange);
        clip = extracted.clip;
        return await updateLastNoteWithScene(settings, {
            sentence: escapeCardText(note.sentence || ""),
            sentenceFurigana: escapeCardText(note.sentenceFurigana || note.sentence || ""),
            audioPath: clip?.path,
            audioFilename: clip?.filename,
            audioMediaType: clip?.media_type,
            screenshot: extracted.frame,
        });
    } catch (error) {
        return { error: String(error) };
    } finally {
        if (clip) await invoke("discard_player_clip", { filename: clip.filename }).catch(console.warn);
    }
}
