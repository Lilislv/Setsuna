import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { isMobilePlatform } from "../../utils/platform";

function release(token: string) {
    if (isMobilePlatform()) return Promise.resolve();
    return invoke("release_player_video", { token }).catch(console.warn);
}

// Each conversion belongs to one mounted episode. Leaving it cancels an unfinished encode.
export function useCompatibleVideo(source: string, report: (message: string) => void) {
    const active = useRef("");
    const [copy, setCopy] = useState("");
    const [busy, setBusy] = useState(false);
    const [failed, setFailed] = useState(false);
    const cancel = () => {
        const token = active.current;
        active.current = "";
        if (token) void release(token);
        setBusy(false);
    };
    useEffect(
        () => () => {
            const token = active.current;
            active.current = "";
            if (token) void release(token);
        },
        [source],
    );
    const prepare = async () => {
        if (active.current || isMobilePlatform()) return;
        const token = crypto.randomUUID();
        active.current = token;
        setBusy(true);
        try {
            const path = await invoke<string>("prepare_player_video", { source, token });
            if (active.current !== token) {
                void release(token);
                return;
            }
            setCopy(path);
            setFailed(false);
            report("");
        } catch (error) {
            if (active.current === token) {
                active.current = "";
                report(String(error));
            }
        } finally {
            if (active.current === token || !active.current) setBusy(false);
        }
    };
    return { copy, busy, failed: failed && !copy, setFailed, prepare, cancel };
}
