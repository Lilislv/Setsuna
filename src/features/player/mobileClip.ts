// Phone-side replacement for the desktop FFmpeg clip: a hidden <video> plays the
// scene once (silently, audio is routed into the recorder only) and MediaRecorder
// captures it as WebM, sized like the desktop quality presets.

export type ClipQuality = "tiny" | "compact" | "balanced" | "high";

export interface RecordedClip {
    base64: string;
    mime: string;
    extension: "webm" | "mp4" | "ogg" | "m4a";
    mediaType: "video" | "audio";
    frame?: string;
}

const PROFILES: Record<ClipQuality, { width: number; fps: number; video: number; audio: number }> = {
    tiny: { width: 480, fps: 18, video: 300_000, audio: 32_000 },
    compact: { width: 640, fps: 24, video: 520_000, audio: 48_000 },
    balanced: { width: 720, fps: 30, video: 900_000, audio: 48_000 },
    high: { width: 960, fps: 30, video: 1_600_000, audio: 64_000 },
};

export function clipMimeType(video: boolean, supported: (type: string) => boolean): string | null {
    const candidates = video
        ? ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm", "video/mp4"]
        : ["audio/webm;codecs=opus", "audio/ogg;codecs=opus", "audio/webm", "audio/mp4"];
    return candidates.find(supported) || null;
}

export function clipExtension(mime: string, video: boolean): RecordedClip["extension"] {
    if (mime.includes("mp4")) return video ? "mp4" : "m4a";
    if (mime.startsWith("audio/ogg")) return "ogg";
    return "webm";
}

function once(target: EventTarget, event: string, timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
        const timer = window.setTimeout(() => {
            target.removeEventListener(event, done);
            reject(new Error(`Timed out waiting for ${event}`));
        }, timeoutMs);
        const done = () => {
            window.clearTimeout(timer);
            resolve();
        };
        target.addEventListener(event, done, { once: true });
    });
}

async function seekTo(media: HTMLVideoElement, time: number) {
    const target = Math.max(0, time);
    if (Math.abs(media.currentTime - target) < 0.01 && media.readyState >= 2) return;
    const seeked = once(media, "seeked", 15_000);
    media.currentTime = target;
    await seeked;
}

async function blobToBase64(blob: Blob): Promise<string> {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let binary = "";
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(binary);
}

/** Records [start, end] of a media URL. `withVideo` false gives an audio-only clip. */
export async function recordSceneClip(
    url: string,
    start: number,
    end: number,
    options: { withVideo: boolean; quality?: ClipQuality; frameAt?: number },
): Promise<RecordedClip> {
    if (typeof MediaRecorder === "undefined") throw new Error("MediaRecorder is not available");
    const length = Math.max(0.2, end - start);
    const media = document.createElement("video");
    // Library folders stream from the app's local server (another origin).
    if (/^http:\/\/127\.0\.0\.1:/.test(url)) media.crossOrigin = "anonymous";
    media.playsInline = true;
    media.preload = "auto";
    media.style.cssText = "position:fixed;left:-4px;top:-4px;width:2px;height:2px;opacity:0;pointer-events:none";
    document.body.appendChild(media);
    const audioContext = new AudioContext();
    let recorder: MediaRecorder | undefined;
    let raf = 0;
    try {
        media.src = url;
        await once(media, "loadedmetadata", 15_000);
        const withVideo = options.withVideo && media.videoWidth > 0;
        const profile = PROFILES[options.quality || "balanced"];
        const mime = clipMimeType(withVideo, (type) => MediaRecorder.isTypeSupported(type));
        if (!mime) throw new Error("This device cannot record clips");

        await seekTo(media, start);

        // Audio goes only into the recorder: the hidden element stays silent.
        const source = audioContext.createMediaElementSource(media);
        const audioOut = audioContext.createMediaStreamDestination();
        source.connect(audioOut);
        if (audioContext.state === "suspended") await audioContext.resume().catch(() => {});

        const tracks: MediaStreamTrack[] = [...audioOut.stream.getAudioTracks()];
        let canvas: HTMLCanvasElement | undefined;
        let draw: (() => void) | undefined;
        if (withVideo) {
            const scale = Math.min(1, profile.width / media.videoWidth);
            canvas = document.createElement("canvas");
            canvas.width = Math.max(2, Math.round((media.videoWidth * scale) / 2) * 2);
            canvas.height = Math.max(2, Math.round((media.videoHeight * scale) / 2) * 2);
            const ctx = canvas.getContext("2d");
            if (!ctx) throw new Error("Canvas is not available");
            draw = () => ctx.drawImage(media, 0, 0, canvas!.width, canvas!.height);
            draw();
            tracks.unshift(...canvas.captureStream(profile.fps).getVideoTracks());
        }

        const chunks: Blob[] = [];
        recorder = new MediaRecorder(new MediaStream(tracks), {
            mimeType: mime,
            audioBitsPerSecond: profile.audio,
            ...(withVideo ? { videoBitsPerSecond: profile.video } : {}),
        });
        recorder.ondataavailable = (event) => {
            if (event.data.size) chunks.push(event.data);
        };
        const stopped = once(recorder, "stop", (length + 20) * 1000);

        let frame: string | undefined;
        const frameAt = options.frameAt;
        const loop = () => {
            draw?.();
            if (canvas && frameAt !== undefined && !frame && media.currentTime >= frameAt) {
                frame = canvas.toDataURL("image/jpeg", 0.86);
            }
            if (media.currentTime >= end || media.ended) {
                media.pause();
                if (recorder?.state === "recording") recorder.stop();
                return;
            }
            raf = requestAnimationFrame(loop);
        };
        recorder.start(250);
        await media.play();
        raf = requestAnimationFrame(loop);
        await stopped;
        cancelAnimationFrame(raf);
        if (canvas && frameAt !== undefined && !frame) frame = canvas.toDataURL("image/jpeg", 0.86);

        const blob = new Blob(chunks, { type: mime.split(";")[0] });
        if (!blob.size) throw new Error("The recorded clip is empty");
        return {
            base64: await blobToBase64(blob),
            mime: mime.split(";")[0],
            extension: clipExtension(mime, withVideo),
            mediaType: withVideo ? "video" : "audio",
            frame,
        };
    } finally {
        cancelAnimationFrame(raf);
        if (recorder && recorder.state !== "inactive") recorder.stop();
        media.pause();
        media.removeAttribute("src");
        media.load();
        media.remove();
        void audioContext.close().catch(() => {});
    }
}

/** A single still frame (JPEG data URL) of a media URL. */
export async function captureFrame(url: string, time: number, maxWidth = 960): Promise<string | undefined> {
    const media = document.createElement("video");
    if (/^http:\/\/127\.0\.0\.1:/.test(url)) media.crossOrigin = "anonymous";
    media.muted = true;
    media.playsInline = true;
    media.preload = "auto";
    try {
        media.src = url;
        await once(media, "loadedmetadata", 15_000);
        if (!media.videoWidth) return undefined;
        await seekTo(media, time);
        const scale = Math.min(1, maxWidth / media.videoWidth);
        const canvas = document.createElement("canvas");
        canvas.width = Math.round(media.videoWidth * scale);
        canvas.height = Math.round(media.videoHeight * scale);
        canvas.getContext("2d")?.drawImage(media, 0, 0, canvas.width, canvas.height);
        return canvas.toDataURL("image/jpeg", 0.86);
    } finally {
        media.removeAttribute("src");
        media.load();
    }
}
