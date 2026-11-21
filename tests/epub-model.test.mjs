import { test } from "node:test";
import assert from "node:assert/strict";
import {
    computeBookProgress,
    detectEpubLanguage,
    detectEpubLanguageFromSample,
    formatCountedThrough,
    isParagraphAlreadyCounted,
    parseCountedThrough,
    parseEpubLanguageTag,
    resolveEpubHrefTarget,
    resolveEpubOrientation,
} from "../src/features/epub/epubModel.ts";

test("A1: parses dc:language tags and falls back to kana/kanji ratio", () => {
    assert.equal(parseEpubLanguageTag("ja"), "ja");
    assert.equal(parseEpubLanguageTag("ja-JP"), "ja");
    assert.equal(parseEpubLanguageTag("JPN"), "ja");
    assert.equal(parseEpubLanguageTag("en-GB"), "en");
    assert.equal(parseEpubLanguageTag("eng"), "en");
    assert.equal(parseEpubLanguageTag("fr"), null);

    assert.equal(detectEpubLanguageFromSample("吾輩は猫である。名前はまだ無い。"), "ja");
    // Kanji only (Chinese) must not be classified as Japanese
    assert.equal(detectEpubLanguageFromSample("天地玄黄宇宙洪荒日月盈昃"), "en");
    assert.equal(detectEpubLanguageFromSample("Call me Ishmael. Some years ago..."), "en");

    // First recognized metadata entry wins
    assert.equal(detectEpubLanguage(["de", "ja-JP", "en"], "English text"), "ja");

    // Mislabelled `en` tag on overwhelmingly Japanese text with kana trusts the text
    const jpNovel = "これは日本語の小説です。ひらがなとカタカナがたくさん入っています。静かな夜に物語が始まります。";
    assert.equal(detectEpubLanguage(["en"], jpNovel), "ja");

    // English text with a few Japanese loanwords stays `en`
    const enNovel = "She smiled and said こんにちは before walking back across the crowded London bridge.";
    assert.equal(detectEpubLanguage(["en"], enNovel), "en");
});

test("A2: English books stay horizontal; Japanese books follow auto/horizontal/vertical", () => {
    // English book ignores vertical global setting, book default, and per-book override
    assert.equal(resolveEpubOrientation("en", "vertical", true), "horizontal");
    assert.equal(resolveEpubOrientation("en", "auto", true), "horizontal");
    assert.equal(resolveEpubOrientation("en", "horizontal", true, "vertical"), "horizontal");

    // Japanese book with auto follows book's own direction
    assert.equal(resolveEpubOrientation("ja", "auto", true), "vertical");
    assert.equal(resolveEpubOrientation("ja", "auto", false), "horizontal");

    // Forced global setting overrides book default
    assert.equal(resolveEpubOrientation("ja", "vertical", false), "vertical");
    assert.equal(resolveEpubOrientation("ja", "horizontal", true), "horizontal");

    // Per-book override takes precedence over global setting
    assert.equal(resolveEpubOrientation("ja", "horizontal", false, "vertical"), "vertical");
    assert.equal(resolveEpubOrientation("ja", "vertical", true, "horizontal"), "horizontal");
    assert.equal(resolveEpubOrientation("ja", "horizontal", true, "auto"), "vertical");
});

test("book progress and countedThrough helpers clamp and compare monotonically", () => {
    assert.equal(computeBookProgress(0, 0, 0.5), 0);
    assert.equal(computeBookProgress(0, 4, 0.5), 0.125);
    assert.equal(computeBookProgress(3, 4, 1), 1);
    assert.equal(computeBookProgress(10, 4, 2), 1);

    assert.equal(parseCountedThrough("bad"), null);
    assert.deepEqual(parseCountedThrough("2:15"), { chapterIndex: 2, paragraphIndex: 15 });
    assert.equal(formatCountedThrough(2, 15), "2:15");

    assert.equal(isParagraphAlreadyCounted(undefined, 0, 0), false);
    assert.equal(isParagraphAlreadyCounted("2:5", 1, 99), true);
    assert.equal(isParagraphAlreadyCounted("2:5", 2, 5), true);
    assert.equal(isParagraphAlreadyCounted("2:5", 2, 6), false);
    assert.equal(isParagraphAlreadyCounted("2:5", 3, 0), false);
});

test("resolves internal EPUB href links with fragments", () => {
    const chapters = [
        { index: 0, href: "OEBPS/Text/ch1.xhtml" },
        { index: 1, href: "OEBPS/Text/ch2.xhtml" },
    ];
    assert.deepEqual(resolveEpubHrefTarget("OEBPS/Text/ch2.xhtml#sec-3", chapters), {
        chapterIndex: 1,
        fragment: "sec-3",
    });
    assert.deepEqual(resolveEpubHrefTarget("OEBPS/Text/ch1.xhtml", chapters), {
        chapterIndex: 0,
        fragment: undefined,
    });
    assert.equal(resolveEpubHrefTarget("OEBPS/Text/missing.xhtml", chapters), null);
});
