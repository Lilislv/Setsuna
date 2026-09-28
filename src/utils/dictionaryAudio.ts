import { invoke } from '@tauri-apps/api/core';

export type LocalAudioClip = { data: string; mimeType: string; filename: string; source: string; speaker: string; display: string; reading: string };
export type DictionaryAudioSettings = {
    dictionaryAudioSource?: 'online' | 'local' | 'local-first' | 'online-first';
    localAudioDatabasePath?: string;
    localAudioPreferredSource?: string;
};
export type DictionaryAudio = { kind: 'local'; clip: LocalAudioClip } | { kind: 'online'; url: string; clip?: LocalAudioClip } | { kind: 'none' };

export const onlineAudioUrl = (term: string, reading: string) =>
    `https://assets.languagepod101.com/dictionary/japanese/audiomp3.php?kanji=${encodeURIComponent(term)}&kana=${encodeURIComponent(reading || term)}`;

export async function resolveDictionaryAudio(settings: DictionaryAudioSettings, term: string, reading: string): Promise<DictionaryAudio> {
    const mode = settings.dictionaryAudioSource || 'online';
    if (mode === 'online-first') {
        // Fetch and validate the recording itself: this service can return a
        // playable "not found" MP3 with HTTP 200. Reuse the checked bytes in Anki.
        const clip = await invoke<LocalAudioClip | null>('lookup_online_audio', { term, reading }).catch(() => null);
        if (clip) return { kind: 'online', url: onlineAudioUrl(term, reading), clip };
    }
    if (mode !== 'online') {
        if (!settings.localAudioDatabasePath?.trim()) throw new Error('Выберите локальную базу озвучки в настройках Anki / Select a local audio database in Anki settings');
        const clip = await invoke<LocalAudioClip | null>('lookup_local_audio', {
            path: settings.localAudioDatabasePath, term, reading,
            preferredSource: settings.localAudioPreferredSource || null,
        });
        if (clip) return { kind: 'local', clip };
        if (mode === 'local' || mode === 'online-first') return { kind: 'none' };
    }
    return { kind: 'online', url: onlineAudioUrl(term, reading) };
}

/** Release the object URL as soon as this preview stops or is replaced. */
export function audioPreviewUrl(audio: Exclude<DictionaryAudio, { kind: 'none' }>): { url: string; dispose: () => void } {
    if (audio.kind === 'online' && !audio.clip) return { url: audio.url, dispose: () => {} };
    const clip = audio.clip!;
    const binary = atob(clip.data);
    const bytes = Uint8Array.from(binary, ch => ch.charCodeAt(0));
    const url = URL.createObjectURL(new Blob([bytes], { type: clip.mimeType }));
    return { url, dispose: () => URL.revokeObjectURL(url) };
}
