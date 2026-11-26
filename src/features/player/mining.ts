import { invoke } from "@tauri-apps/api/core";
import type { AppSettings } from "../../components/SettingsModal";
import { addNote, updateLastNoteWithScene } from "../../utils/anki";
import { isMobilePlatform } from "../../utils/platform";
import { escapeCardText, clipInterval, type PlayerScene } from "./model";
import { captureFrame, recordSceneClip, type RecordedClip } from "./mobileClip";
import { isMobileMediaPath, mobileMediaUrl } from "./mobileMedia";
import { androidMediaUrl, isAndroidFolderPath } from "./androidFolders";

export const subtitleScenes = new WeakMap<Element, PlayerScene>();

type Clip = { filename: string; path: string; media_type: string };

async function discardClip(clip?: Clip) {
    if (clip) await invoke("discard_player_clip", { filename: clip.filename }).catch(console.warn);
}

function randomHex() {
    return Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => b.toString(16).padStart(2, "0")).join("");
}

// Phone: no FFmpeg, so the scene is recorded in the WebView (same interval and
// quality presets as desktop) and handed to Anki as base64.
async function recordMobileScene(settings: AppSettings, scene: PlayerScene, withFrame: boolean, exactRange: boolean) {
    const url = isMobileMediaPath(scene.source)
        ? mobileMediaUrl(scene.source)
        : isAndroidFolderPath(scene.source)
          ? androidMediaUrl(scene.source)
          : /^blob:/.test(scene.source) ? scene.source : "";
    if (!url) return { recorded: undefined, frame: undefined };
    const middle = (scene.start + scene.end) / 2;
    if (settings.playerMiningUseClipForAnki === false) {
        return { recorded: undefined, frame: withFrame && !scene.audioOnly ? await captureFrame(url, middle) : undefined };
    }
    const interval = exactRange
        ? { start: scene.start, end: scene.end }
        : clipInterval(scene, settings.playerClipPadStart, settings.playerClipPadEnd);
    const video = !scene.audioOnly && (settings.playerCardFormat ?? "video") === "video";
    const recorded: RecordedClip = await recordSceneClip(url, interval.start, interval.end, {
        withVideo: video,
        quality: settings.playerVideoQuality,
    });
    const frame = withFrame && !scene.audioOnly && recorded.mediaType !== "video" ? await captureFrame(url, middle) : undefined;
    return { recorded, frame };
}

function mobileClipFields(recorded?: RecordedClip) {
    if (!recorded) return {};
    return {
        clipBase64: recorded.base64,
        clipFilename: `setsuna_clip_${randomHex()}.${recorded.extension}`,
        clipMediaType: recorded.mediaType,
    };
}

async function extractSceneClipAndFrame(
    settings: AppSettings,
    scene: PlayerScene,
    withFrame = false,
    exactRange = false,
) {
    if (isMobilePlatform()) return { clip: undefined, frame: undefined };
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
    try {
        const frame =
            !scene.audioOnly && withFrame && clip?.media_type !== "video"
                ? await invoke<string>("player_scene_frame", {
                      source: scene.source,
                      time: (scene.start + scene.end) / 2,
                  })
                : undefined;
        return { clip, frame };
    } catch (error) {
        await discardClip(clip);
        throw error;
    }
}

export async function addPlayerNote(
    settings: AppSettings,
    note: Parameters<typeof addNote>[1],
    scene: PlayerScene,
    withFrame = false,
    exactRange = false,
) {
    if (isMobilePlatform()) {
        try {
            const { recorded, frame } = await recordMobileScene(settings, scene, withFrame, exactRange);
            return await addNote(settings, {
                ...note,
                sentence: escapeCardText(note.sentence || ""),
                sentenceFurigana: escapeCardText(note.sentenceFurigana || note.sentence || ""),
                ...mobileClipFields(recorded),
                screenshot: frame || note.screenshot,
                playerScene: true,
            });
        } catch (error) {
            return { error: String(error) };
        }
    }
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
        await discardClip(clip);
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
        await discardClip(clip);
    }
}
