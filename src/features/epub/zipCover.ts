// Reads a cover out of a zip-based book (CBZ/ZIP manga, EPUB) through byte-range
// reads only: the central directory comes from the file tail, then just the
// cover entry is fetched. Used for books that live on Drive and are not downloaded.

const TAIL_BYTES = 66_000;
const MAX_CENTRAL_DIR_BYTES = 4 * 1024 * 1024;
const MAX_COVER_BYTES = 12 * 1024 * 1024;
const IMAGE_RE = /\.(jpe?g|png|webp|gif|avif|bmp)$/i;

export interface ZipEntry {
    name: string;
    method: number;
    compressedSize: number;
    localOffset: number;
}

export type RangeReader = (start: number, end: number) => Promise<Uint8Array>;

function u16(b: Uint8Array, at: number): number {
    return b[at] | (b[at + 1] << 8);
}

function u32(b: Uint8Array, at: number): number {
    return (b[at] | (b[at + 1] << 8) | (b[at + 2] << 16)) + b[at + 3] * 0x1000000;
}

/** Parses the central directory from the last bytes of a zip file. */
export function parseZipTail(tail: Uint8Array, fileSize: number): { cdOffset: number; cdSize: number } | null {
    for (let i = tail.length - 22; i >= 0; i -= 1) {
        if (u32(tail, i) !== 0x06054b50) continue;
        const cdSize = u32(tail, i + 12);
        const cdOffset = u32(tail, i + 16);
        if (cdOffset === 0xffffffff || cdSize === 0xffffffff) return null; // zip64
        if (cdOffset + cdSize > fileSize) return null;
        return { cdOffset, cdSize };
    }
    return null;
}

export function parseCentralDirectory(cd: Uint8Array): ZipEntry[] {
    const entries: ZipEntry[] = [];
    const decoder = new TextDecoder();
    let at = 0;
    while (at + 46 <= cd.length && u32(cd, at) === 0x02014b50) {
        const method = u16(cd, at + 10);
        const compressedSize = u32(cd, at + 20);
        const nameLen = u16(cd, at + 28);
        const extraLen = u16(cd, at + 30);
        const commentLen = u16(cd, at + 32);
        const localOffset = u32(cd, at + 42);
        const name = decoder.decode(cd.subarray(at + 46, at + 46 + nameLen));
        entries.push({ name, method, compressedSize, localOffset });
        at += 46 + nameLen + extraLen + commentLen;
    }
    return entries;
}

function naturalCompare(a: string, b: string): number {
    return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
}

/** Same choice as the native reader: an embedded custom cover, else the first page. */
export function pickMangaCoverEntry(entries: ZipEntry[]): ZipEntry | null {
    for (const ext of ["jpg", "png", "webp"]) {
        const custom = entries.find((e) => e.name === `.setsuna-cover.${ext}`);
        if (custom) return custom;
    }
    const pages = entries
        .filter((e) => IMAGE_RE.test(e.name) && !e.name.endsWith("/"))
        .filter((e) => !e.name.startsWith("__MACOSX/") && !e.name.split("/").some((part) => part.startsWith(".")))
        .sort((a, b) => naturalCompare(a.name, b.name));
    return pages[0] || null;
}

function resolveHref(base: string, href: string): string {
    const parts = base.split("/").slice(0, -1);
    for (const piece of decodeURIComponent(href.split("#")[0]).split("/")) {
        if (piece === "..") parts.pop();
        else if (piece && piece !== ".") parts.push(piece);
    }
    return parts.join("/");
}

function attr(tag: string, name: string): string | null {
    const match = new RegExp(`\\s${name}\\s*=\\s*(["'])(.*?)\\1`, "i").exec(tag);
    return match ? match[2] : null;
}

/** Cover image path inside an EPUB, from its OPF package document. */
export function findEpubCoverPath(opfPath: string, opf: string): string | null {
    const items = Array.from(opf.matchAll(/<(?:\w+:)?item\b[^>]*>/gi)).map((m) => m[0]);
    const byProperty = items.find((tag) => /\bcover-image\b/i.test(attr(tag, "properties") || ""));
    let href = byProperty ? attr(byProperty, "href") : null;
    if (!href) {
        const meta = Array.from(opf.matchAll(/<(?:\w+:)?meta\b[^>]*>/gi))
            .map((m) => m[0])
            .find((tag) => (attr(tag, "name") || "").toLowerCase() === "cover");
        const id = meta ? attr(meta, "content") : null;
        const item = id ? items.find((tag) => attr(tag, "id") === id) : null;
        href = item ? attr(item, "href") : null;
    }
    if (!href) {
        const guess = items.find((tag) => /image\//i.test(attr(tag, "media-type") || "")
            && /cover/i.test(`${attr(tag, "id") || ""} ${attr(tag, "href") || ""}`));
        href = guess ? attr(guess, "href") : null;
    }
    return href ? resolveHref(opfPath, href) : null;
}

async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
    const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function readEntry(read: RangeReader, entry: ZipEntry): Promise<Uint8Array> {
    if (entry.compressedSize > MAX_COVER_BYTES) throw new Error("cover too large");
    const slack = 30 + 1024 + entry.name.length * 4;
    let chunk = await read(entry.localOffset, entry.localOffset + slack + entry.compressedSize);
    if (u32(chunk, 0) !== 0x04034b50) throw new Error("bad zip entry");
    const start = 30 + u16(chunk, 26) + u16(chunk, 28);
    if (start + entry.compressedSize > chunk.length) {
        chunk = await read(entry.localOffset, entry.localOffset + start + entry.compressedSize);
    }
    const data = chunk.subarray(start, start + entry.compressedSize);
    if (entry.method === 0) return data;
    if (entry.method === 8) return inflateRaw(data);
    throw new Error(`zip method ${entry.method}`);
}

function mimeFor(name: string): string {
    const ext = (name.split(".").pop() || "").toLowerCase();
    if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
    return `image/${ext || "jpeg"}`;
}

function toDataUrl(bytes: Uint8Array, mime: string): string {
    let binary = "";
    for (let i = 0; i < bytes.length; i += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    }
    return `data:${mime};base64,${btoa(binary)}`;
}

/** Finds and decodes the cover of a zip-based book using byte-range reads only. */
export async function readZipBookCover(read: RangeReader, size: number, kind: "manga" | "epub"): Promise<string | null> {
    const tailStart = Math.max(0, size - TAIL_BYTES);
    const tail = await read(tailStart, size);
    const loc = parseZipTail(tail, size);
    if (!loc || loc.cdSize > MAX_CENTRAL_DIR_BYTES) return null;
    const cd = loc.cdOffset >= tailStart
        ? tail.subarray(loc.cdOffset - tailStart, loc.cdOffset - tailStart + loc.cdSize)
        : await read(loc.cdOffset, loc.cdOffset + loc.cdSize);
    const entries = parseCentralDirectory(cd);
    let entry: ZipEntry | null = null;
    if (kind === "manga") {
        entry = pickMangaCoverEntry(entries);
    } else {
        const container = entries.find((e) => e.name === "META-INF/container.xml");
        if (!container) return null;
        const containerXml = new TextDecoder().decode(await readEntry(read, container));
        const rootfile = /<(?:\w+:)?rootfile\b[^>]*>/i.exec(containerXml)?.[0];
        const opfPath = rootfile ? attr(rootfile, "full-path") : null;
        const opfEntry = opfPath ? entries.find((e) => e.name === opfPath) : null;
        if (!opfPath || !opfEntry) return null;
        const coverPath = findEpubCoverPath(opfPath, new TextDecoder().decode(await readEntry(read, opfEntry)));
        entry = coverPath ? entries.find((e) => e.name === coverPath) || null : null;
    }
    if (!entry || !IMAGE_RE.test(entry.name)) return null;
    const bytes = await readEntry(read, entry);
    return toDataUrl(bytes, mimeFor(entry.name));
}
