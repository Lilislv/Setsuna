import { useEffect, type RefObject } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import type Hls from "hls.js";
import { isMobileMediaPath, mobileMediaUrl } from "./mobileMedia";
import { androidMediaUrl, isAndroidFolderPath } from "./androidFolders";

export function usePlayerSource(
    video: RefObject<HTMLVideoElement | null>,
    source: string,
    onError: (message: string) => void,
) {
    useEffect(() => {
        const element = video.current;
        if (!source || !element) return;
        let closed = false;
        let stream: Hls | undefined;
        if (source.startsWith("https:") && /\.m3u8(?:$|[?#])/i.test(source)) {
            void import("hls.js")
                .then(({ default: Hls }) => {
                    if (closed) return;
                    if (Hls.isSupported()) {
                        stream = new Hls();
                        stream.on(Hls.Events.ERROR, (_, data) => {
                            if (data.fatal) onError("HLS · " + data.details);
                        });
                        stream.loadSource(source);
                        stream.attachMedia(element);
                    } else {
                        element.src = source;
                    }
                })
                .catch((error) => {
                    if (!closed) onError(String(error));
                });
        } else {
            const isDirectUrl = /^(?:https?|blob):/i.test(source);
            if (isAndroidFolderPath(source)) {
                // Local media server (other origin): CORS keeps frames readable for Anki screenshots.
                element.crossOrigin = "anonymous";
                const url = androidMediaUrl(source);
                if (!url) onError("This episode is not available any more. Refresh the library.");
                else element.src = url;
            } else {
                element.removeAttribute("crossorigin");
                element.src = isMobileMediaPath(source) ? mobileMediaUrl(source) : isDirectUrl ? source : convertFileSrc(source);
            }
        }
        return () => {
            closed = true;
            stream?.destroy();
            element.removeAttribute("src");
            element.load();
        };
    }, [source, video, onError]);
}
