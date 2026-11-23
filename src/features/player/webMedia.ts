import { invoke } from "@tauri-apps/api/core";

export type WebTrack = { url: string; language: string; label: string };

export function readWebText(url: string) {
    return invoke<{ url: string; text: string }>("player_web_text", { url });
}

export function webVideoPage(html: string, pageUrl: string) {
    // Template contents stay inert. Only explicit media URLs reach the player.
    const template = document.createElement("template");
    template.innerHTML = html;
    const root = template.content;
    const https = (src: string | null | undefined, base: string): string => {
        if (!src) return "";
        try {
            const url = new URL(src, base);
            return url.protocol === "https:" && !url.username && !url.password ? url.href : "";
        } catch {
            return "";
        }
    };
    const base = https(root.querySelector("base[href]")?.getAttribute("href"), pageUrl) || pageUrl;
    for (const video of root.querySelectorAll("video")) {
        const sources = [video, ...video.querySelectorAll("source")]
            .map((el) => https(el.getAttribute("src"), base))
            .filter(Boolean);
        if (!sources.length) continue;
        const tracks = [...video.querySelectorAll("track[src]")]
            .filter((el) => ["", "captions", "subtitles"].includes(el.getAttribute("kind") || ""))
            .map((el) => ({
                url: https(el.getAttribute("src"), base),
                language: el.getAttribute("srclang") || "",
                label: el.getAttribute("label") || "",
            }))
            .filter((t) => t.url);
        return { source: sources[0], tracks };
    }
    return null;
}
