export interface QuoteCardOptions {
    quote: string;
    bookTitle: string;
    author?: string;
    chapterTitle?: string;
    coverDataUrl?: string | null;
    fontFamily: string;
    theme: "dark" | "paper" | "sepia" | "black";
    vertical?: boolean;
}

const THEME_PALETTES = {
    dark: { bg: "#141821", card: "rgba(25, 30, 42, 0.88)", border: "rgba(255,255,255,0.14)", text: "#f2f4f8", muted: "#9aa5bc", accent: "#6aa9ff" },
    paper: { bg: "#f4f1ea", card: "rgba(255, 254, 250, 0.92)", border: "rgba(24,28,36,0.12)", text: "#1c2026", muted: "#5f6876", accent: "#2867b2" },
    sepia: { bg: "#efe5cf", card: "rgba(247, 239, 222, 0.92)", border: "rgba(58,45,25,0.14)", text: "#2c2317", muted: "#6d5c45", accent: "#9a6324" },
    black: { bg: "#050608", card: "rgba(14, 16, 22, 0.9)", border: "rgba(255,255,255,0.12)", text: "#f0f2f5", muted: "#8c96a8", accent: "#67c587" },
};

function wrapLines(ctx: CanvasRenderingContext2D, text: string, maxWidth: number, maxLines: number): string[] {
    const paragraphs = text.replace(/\r\n/g, "\n").split("\n").filter((p) => p.trim().length > 0);
    const lines: string[] = [];

    for (const para of paragraphs) {
        let current = "";
        for (const ch of para) {
            const candidate = current + ch;
            if (ctx.measureText(candidate).width > maxWidth && current.length > 0) {
                lines.push(current);
                current = ch === " " ? "" : ch;
                if (lines.length >= maxLines) break;
            } else {
                current = candidate;
            }
        }
        if (lines.length >= maxLines) break;
        if (current) lines.push(current);
        if (lines.length >= maxLines) break;
    }

    if (lines.length === maxLines) {
        const last = lines[maxLines - 1];
        if (!last.endsWith("…")) {
            lines[maxLines - 1] = last.slice(0, Math.max(1, last.length - 1)) + "…";
        }
    }
    return lines;
}

function loadImage(src: string): Promise<HTMLImageElement | null> {
    return new Promise((resolve) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => resolve(null);
        img.src = src;
    });
}

function drawRoundedRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
}

export async function renderQuoteCardDataUrl(options: QuoteCardOptions): Promise<string> {
    const width = 1200;
    const height = 680;
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas 2D context unavailable");

    const palette = THEME_PALETTES[options.theme] || THEME_PALETTES.dark;

    // Base fill
    ctx.fillStyle = palette.bg;
    ctx.fillRect(0, 0, width, height);

    // Optional blurred cover backdrop
    const coverImg = options.coverDataUrl ? await loadImage(options.coverDataUrl) : null;
    if (coverImg) {
        ctx.save();
        ctx.filter = "blur(36px) saturate(1.2)";
        ctx.globalAlpha = options.theme === "paper" || options.theme === "sepia" ? 0.22 : 0.34;
        const scale = Math.max(width / coverImg.width, height / coverImg.height) * 1.15;
        const dw = coverImg.width * scale;
        const dh = coverImg.height * scale;
        ctx.drawImage(coverImg, (width - dw) / 2, (height - dh) / 2, dw, dh);
        ctx.restore();
    }

    // Subtle glass frame
    const pad = 56;
    drawRoundedRect(ctx, pad, pad, width - pad * 2, height - pad * 2, 28);
    ctx.fillStyle = palette.card;
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = palette.border;
    ctx.stroke();

    // Accent bar & quote mark
    ctx.fillStyle = palette.accent;
    drawRoundedRect(ctx, pad + 42, pad + 44, 6, 48, 3);
    ctx.fill();

    // Quote text
    const quoteFontSize = options.quote.length > 200 ? 28 : options.quote.length > 100 ? 34 : 40;
    const lineHeight = Math.round(quoteFontSize * 1.55);
    ctx.font = `500 ${quoteFontSize}px ${options.fontFamily}`;
    ctx.fillStyle = palette.text;
    ctx.textBaseline = "top";

    const textMaxWidth = width - pad * 2 - (coverImg ? 250 : 120);
    const lines = wrapLines(ctx, options.quote.trim(), textMaxWidth, 8);
    const textBlockHeight = lines.length * lineHeight;
    const textStartY = pad + Math.max(64, Math.floor((height - pad * 2 - 130 - textBlockHeight) / 2));

    lines.forEach((line, idx) => {
        ctx.fillText(line, pad + 68, textStartY + idx * lineHeight);
    });

    // Optional mini cover on right
    if (coverImg) {
        const thumbW = 132;
        const thumbH = 190;
        const thumbX = width - pad - thumbW - 44;
        const thumbY = pad + 56;
        ctx.save();
        drawRoundedRect(ctx, thumbX, thumbY, thumbW, thumbH, 12);
        ctx.clip();
        const s = Math.max(thumbW / coverImg.width, thumbH / coverImg.height);
        const tw = coverImg.width * s;
        const th = coverImg.height * s;
        ctx.drawImage(coverImg, thumbX + (thumbW - tw) / 2, thumbY + (thumbH - th) / 2, tw, th);
        ctx.restore();
        ctx.save();
        drawRoundedRect(ctx, thumbX, thumbY, thumbW, thumbH, 12);
        ctx.strokeStyle = palette.border;
        ctx.lineWidth = 1.5;
        ctx.stroke();
        ctx.restore();
    }

    // Attribution footer
    const footerY = height - pad - 74;
    ctx.strokeStyle = palette.border;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(pad + 68, footerY - 18);
    ctx.lineTo(width - pad - 44, footerY - 18);
    ctx.stroke();

    ctx.font = `600 21px "Segoe UI", system-ui, sans-serif`;
    ctx.fillStyle = palette.text;
    ctx.fillText(options.bookTitle.slice(0, 68), pad + 68, footerY);

    const subParts = [options.author, options.chapterTitle].filter(Boolean);
    if (subParts.length > 0) {
        ctx.font = `400 16px "Segoe UI", system-ui, sans-serif`;
        ctx.fillStyle = palette.muted;
        ctx.fillText(subParts.join(" · ").slice(0, 88), pad + 68, footerY + 28);
    }

    ctx.font = `600 14px "Segoe UI", system-ui, sans-serif`;
    ctx.fillStyle = palette.muted;
    ctx.textAlign = "right";
    ctx.fillText("SETSUNA", width - pad - 44, footerY + 28);

    return canvas.toDataURL("image/png");
}
