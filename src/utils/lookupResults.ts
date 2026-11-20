/** Drops inline readings emitted by some games, e.g. 幽(かす)かに -> 幽かに (mirrors Rust `strip_inline_furigana`). */
export function stripInlineFurigana(text: string): string {
    return text.replace(/([㐀-䶿一-龯々ヵヶ\u{20000}-\u{323af}])(?:\(([ぁ-ゟァ-ヺー]{1,16})\)|（([ぁ-ゟァ-ヺー]{1,16})）)/gu, '$1');
}

/** Reconcile source selection with enabled dictionaries, using Rust code-point offsets. */
export function selectActiveLookupResult(result: any, sentence: string, settings: any) {
    if (!result) return null;
    const entries = (result.entries || []).filter((entry: any) => {
        const dictionary = settings?.dictionaries?.find((item: any) => item.name === entry.dict_name);
        return dictionary?.active !== false;
    });
    if (!entries.length) return null;
    const start = Number(result.match_start ?? result.start ?? 0);
    const originalLength = Number(result.match_len ?? (result.end - start));
    const sourceLength = entries.reduce((longest: number, entry: any) => Math.max(longest, Number(entry.source_length) || 0), 0);
    const length = sourceLength > 0 ? Math.min(sourceLength, originalLength) : originalLength;
    if (!Number.isFinite(start) || !Number.isFinite(length) || length <= 0) return null;
    return { ...result, entries, match_start: start, match_len: length, start, end: start + length,
        word: stripInlineFurigana(Array.from(sentence).slice(start, start + length).join('')) };
}
