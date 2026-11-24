import type { Poster, TitleHint } from "./posterModel";

const prefix = "setsuna-local-poster:";
const database = "setsuna.player.local-posters";
const store = "images";

export function isLocalPoster(poster?: Poster): boolean {
    return !!poster?.imageUrl.startsWith(prefix);
}

async function withStore<T>(
    mode: IDBTransactionMode,
    action: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(database, 1);
        request.onupgradeneeded = () => request.result.createObjectStore(store);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
    try {
        return await new Promise<T>((resolve, reject) => {
            const transaction = db.transaction(store, mode);
            const request = action(transaction.objectStore(store));
            transaction.oncomplete = () => resolve(request.result);
            transaction.onerror = () => reject(transaction.error || request.error);
            transaction.onabort = () => reject(transaction.error || new Error("Cover storage was interrupted"));
        });
    } finally {
        db.close();
    }
}

export async function readLocalPoster(poster: Poster): Promise<Blob | undefined> {
    if (!isLocalPoster(poster)) return undefined;
    return withStore<Blob | undefined>("readonly", (store) => store.get(poster.imageUrl.slice(prefix.length)));
}

/** Call after successfully persisting a replacement/reset of the poster metadata. */
export async function deleteLocalPoster(poster?: Poster): Promise<void> {
    if (!isLocalPoster(poster)) return;
    await withStore("readwrite", (store) => store.delete(poster!.imageUrl.slice(prefix.length)));
}

export async function createLocalPoster(file: File, title: TitleHint): Promise<Poster> {
    if (!/^(image\/(jpeg|png|webp))$/i.test(file.type)) throw new Error("format");
    if (!file.size || file.size > 20 * 1024 * 1024) throw new Error("size");
    const url = URL.createObjectURL(file);
    const image = new Image();
    try {
        await new Promise<void>((resolve, reject) => {
            image.onload = () => resolve();
            image.onerror = () => reject(new Error("decode"));
            image.src = url;
        });
        const width = image.naturalWidth;
        const height = image.naturalHeight;
        if (!width || !height || width * height > 40_000_000) throw new Error("size");
        const scale = Math.min(1, 1000 / Math.max(width, height));
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(width * scale));
        canvas.height = Math.max(1, Math.round(height * scale));
        const context = canvas.getContext("2d");
        if (!context) throw new Error("decode");
        context.fillStyle = "#fff";
        context.fillRect(0, 0, canvas.width, canvas.height);
        context.drawImage(image, 0, 0, canvas.width, canvas.height);
        const blob = await new Promise<Blob>((resolve, reject) => {
            canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("decode"))), "image/jpeg", 0.85);
        });
        if (blob.size > 1024 * 1024) throw new Error("size");
        const id = crypto.randomUUID();
        await withStore("readwrite", (store) => store.put(blob, id));
        return {
            id,
            title: title.title,
            year: title.year,
            kind: "image",
            source: "Local",
            imageUrl: prefix + id,
            pageUrl: "",
        };
    } finally {
        image.onload = null;
        image.onerror = null;
        URL.revokeObjectURL(url);
    }
}
