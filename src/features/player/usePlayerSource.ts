import { useEffect, type RefObject } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import type Hls from "hls.js";

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
            element.src = source.startsWith("https:") ? source : convertFileSrc(source);
        }
        return () => {
            closed = true;
            stream?.destroy();
            element.removeAttribute("src");
            element.load();
        };
    }, [source, video, onError]);
}
