import { test } from "node:test";
import assert from "node:assert/strict";
import {
    computeBookProgress,
    computeWeightedBookProgress,
    detectEpubLanguage,
    detectEpubLanguageFromSample,
    formatCountedThrough,
    isParagraphAlreadyCounted,
    isSupportedBookPath,
    parseCountedThrough,
    parseEpubLanguageTag,
    resolveEpubHrefTarget,
    resolveEpubOrientation,
} from "../src/features/epub/epubModel.ts";
import {
    buildLibraryGroups,
    buildTitleSortKey,
    compareBooks,
    compareNaturalStrings,
    DEFAULT_LIBRARY_PREFS,
    inferBookSeries,
    parseKanjiNumeral,
    parseRomanNumeral,
    resolveBookStatus,
} from "../src/features/epub/epubLibraryModel.ts";
import { applyParagraphHighlights } from "../src/features/epub/epubHighlightDom.ts";
import {
    computeChapterParagraphDelta,
    computeReadingStreak,
    DEFAULT_EPUB_GOALS,
    evaluateGoalProgress,
} from "../src/features/epub/epubTracker.ts";
import {
    mergeEpubBookEntries,
    mergeManifestWithLocalTabs,
} from "../src/features/epub/epubSyncModel.ts";
import {
    buildPortableEpubBackup,
    mergePortableEpubBackup,
    parsePortableEpubBackup,
} from "../src/features/epub/epubBackup.ts";
import {
    findActiveCueIndex,
    formatAudioTime,
    matchCueToParagraphIndex,
    parseSubtitles,
} from "../src/features/epub/epubSubtitles.ts";

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

test("recognizes supported book file formats (epub, txt, htmlz)", () => {
    assert.equal(isSupportedBookPath("C:/Books/novel.epub"), true);
    assert.equal(isSupportedBookPath("C:/Books/webnovel.TXT"), true);
    assert.equal(isSupportedBookPath("archive.htmlz"), true);
    assert.equal(isSupportedBookPath("notes.pdf"), false);
    assert.equal(isSupportedBookPath("backup.json"), false);
});


test("character-weighted book progress reflects real chapter sizes", () => {
    // 1,000-char prologue + 99,000-char main chapter: finishing prologue is ~1%, not 50%
    const chapters = [{ charCount: 1000 }, { charCount: 99000 }];
    assert.ok(Math.abs(computeWeightedBookProgress(0, chapters, 1) - 0.01) < 1e-6);
    assert.ok(Math.abs(computeWeightedBookProgress(1, chapters, 0.5) - 0.505) < 1e-6);
    // Falls back gracefully when charCount is missing
    assert.equal(computeWeightedBookProgress(0, [{}, {}], 1), 0.5);
});

test("natural title sorting handles Arabic, Japanese kanji numerals, Roman numerals, 上中下, and NFKC", () => {
    assert.equal(parseKanjiNumeral("一"), 1);
    assert.equal(parseKanjiNumeral("十"), 10);
    assert.equal(parseKanjiNumeral("十一"), 11);
    assert.equal(parseKanjiNumeral("二十"), 20);
    assert.equal(parseRomanNumeral("IV"), 4);
    assert.equal(parseRomanNumeral("Ⅸ"), 9);

    // Japanese kanji volume numbers
    const jpVols = ["物語 第二十巻", "物語 第四巻", "物語 第十一巻", "物語 第一巻", "物語 第三巻", "物語 第十巻", "物語 第二巻"];
    const sortedJp = [...jpVols].sort((a, b) => compareNaturalStrings(a, b, "ru"));
    assert.deepEqual(sortedJp, [
        "物語 第一巻",
        "物語 第二巻",
        "物語 第三巻",
        "物語 第四巻",
        "物語 第十巻",
        "物語 第十一巻",
        "物語 第二十巻",
    ]);

    // Roman numerals (including Unicode variants)
    const romans = ["Story X", "Story Ⅸ", "Story V", "Story Ⅳ", "Story II", "Story I", "Story VI", "Story III"];
    const sortedRomans = [...romans].sort((a, b) => compareNaturalStrings(a, b, "ru"));
    assert.deepEqual(sortedRomans, [
        "Story I",
        "Story II",
        "Story III",
        "Story Ⅳ",
        "Story V",
        "Story VI",
        "Story Ⅸ",
        "Story X",
    ]);

    // 上 / 中 / 下 part markers
    const parts = ["小説 下", "小説 上", "小説 中"];
    assert.deepEqual([...parts].sort((a, b) => compareNaturalStrings(a, b, "ru")), ["小説 上", "小説 中", "小説 下"]);

    const parenParts = ["作品(下)", "作品(中)", "作品(上)"];
    assert.deepEqual([...parenParts].sort((a, b) => compareNaturalStrings(a, b, "ru")), ["作品(上)", "作品(中)", "作品(下)"]);

    // Mixed fullwidth digits and inconsistent spaces (Re:Zero case)
    const rezero = [
        "Re：ゼロから始める異世界生活 10",
        "Re：ゼロから始める異世界生活 6",
        "Re：ゼロから始める異世界生活5",
        "Re：ゼロから始める異世界生活 4",
        "Re：ゼロから始める異世界生活3",
        "Re：ゼロから始める異世界生活2",
        "Re：ゼロから始める異世界生活 １",
    ];
    assert.deepEqual([...rezero].sort((a, b) => compareNaturalStrings(a, b, "ru")), [
        "Re：ゼロから始める異世界生活 １",
        "Re：ゼロから始める異世界生活2",
        "Re：ゼロから始める異世界生活3",
        "Re：ゼロから始める異世界生活 4",
        "Re：ゼロから始める異世界生活5",
        "Re：ゼロから始める異世界生活 6",
        "Re：ゼロから始める異世界生活 10",
    ]);

    // Ordinary words containing 一, 上, 中, 下, or leading English "I" must NOT be mangled
    assert.equal(buildTitleSortKey("中学校の一日"), "中学校の一日");
    assert.equal(buildTitleSortKey("上下関係"), "上下関係");
    assert.equal(buildTitleSortKey("I Am a Cat"), "IAmaCat");
});

test("series inference, explicit seriesPosition priority, and library grouping", () => {
    assert.equal(inferBookSeries("Re：ゼロから始める異世界生活 1"), "Re:ゼロから始める異世界生活");
    assert.equal(inferBookSeries("Re：ゼロから始める異世界生活2"), "Re:ゼロから始める異世界生活");
    assert.equal(inferBookSeries("本好きの下剋上 第一巻"), "本好きの下剋上");
    assert.equal(inferBookSeries("Mushoku Tensei Vol. 12"), "Mushoku Tensei");

    const mkBook = (id, title, epubExtra = {}) => ({
        id,
        name: title,
        lines: [],
        stats: { chars: 0, words: 0, sentences: 0, time: 0 },
        mode: "epub",
        epub: { title, lines: [], progress: 0, ...epubExtra },
    });

    // Explicit seriesPosition overrides conflicting title number
    const b1 = mkBook(1, "Saga: Finale 99", { series: "Saga", seriesPosition: 1, totalChars: 10000, progress: 1 });
    const b2 = mkBook(2, "Saga: Prologue 1", { series: "Saga", seriesPosition: 2, totalChars: 10000, progress: 0.5 });
    const b3 = mkBook(3, "Saga: Side Story", { series: "Saga", totalChars: 10000, progress: 0 });

    const groups = buildLibraryGroups(
        [b3, b2, b1],
        [b3, b2, b1],
        { ...DEFAULT_LIBRARY_PREFS, groupBy: "series", sortBy: "title", sortDir: "asc" },
        "ru",
        { noSeries: "No series", noAuthor: "No author" },
    );
    assert.equal(groups.length, 1);
    assert.deepEqual(groups[0].books.map((b) => b.id), [1, 2, 3]);
    assert.ok(Math.abs(groups[0].aggregateProgress - 0.5) < 1e-6);

    // Comparator anti-symmetry & reflexivity
    assert.equal(compareBooks(b1, b1, "title", "asc", "ru"), 0);
    assert.equal(
        Math.sign(compareBooks(b1, b2, "title", "asc", "ru", [b1, b2], true)),
        -Math.sign(compareBooks(b2, b1, "title", "asc", "ru", [b1, b2], true)),
    );
    assert.equal(resolveBookStatus(b1), "completed");
    assert.equal(resolveBookStatus(b2), "reading");
    assert.equal(resolveBookStatus(b3), "unread");
});

test("highlight DOM injection preserves HTML tags and ruby markup", () => {
    const html = `<p>彼女は<ruby>静<rt>しず</rt></ruby>かに微笑んだ。</p>`;
    const out = applyParagraphHighlights(html, [
        { id: "h1", chapterIndex: 0, paragraphIndex: 0, text: "微笑んだ", color: "amber", createdAt: 1 },
    ]);
    assert.equal(
        out,
        `<p>彼女は<ruby>静<rt>しず</rt></ruby>かに<mark class="epub-hl epub-hl-amber" data-hl-id="h1">微笑んだ</mark>。</p>`,
    );
});

test("EPUB reading tracker skip threshold, goal progress light, and streaks", () => {
    const paragraphs = [
        { index: 0, text: "あ".repeat(100) },
        { index: 1, text: "い".repeat(400) },
        { index: 2, text: "う".repeat(3000) },
    ];
    // Normal step within threshold (400 <= 2700)
    assert.equal(computeChapterParagraphDelta(paragraphs, 0, 1, 2700), 400);
    // Large chapter skip exceeding threshold returns null (not counted)
    assert.equal(computeChapterParagraphDelta(paragraphs, 0, 2, 2700), null);

    // Goal progress light states
    assert.equal(evaluateGoalProgress(0, 0, DEFAULT_EPUB_GOALS, true).status, "off");
    assert.equal(evaluateGoalProgress(500, 120, DEFAULT_EPUB_GOALS, false).status, "behind");
    assert.equal(evaluateGoalProgress(2500, 600, DEFAULT_EPUB_GOALS, false).status, "mid");
    assert.equal(evaluateGoalProgress(5000, 1800, DEFAULT_EPUB_GOALS, false).status, "done");

    // Streak calculation
    const streak = computeReadingStreak([
        { key: "2026-11-19", chars: 200, seconds: 120 },
        { key: "2026-11-20", chars: 0, seconds: 0 },
        { key: "2026-11-21", chars: 500, seconds: 300 },
        { key: "2026-11-22", chars: 800, seconds: 400 },
        { key: "2026-11-23", chars: 0, seconds: 0 }, // today not read yet -> streak still 2 from yesterday
    ]);
    assert.deepEqual(streak, { current: 2, best: 2 });
});


test("EPUB Drive sync merges newer phone reading position, union-merges annotations, and creates cloud-only books", () => {
    const pcEntry = {
        bookKey: "re:ゼロから始める異世界生活1",
        title: "Re：ゼロから始める異世界生活 1",
        chapterIndex: 3,
        chapterOffset: 0.2,
        progress: 0.15,
        lastOpenedAt: 1000,
        updatedAt: 1000,
        bookmarks: [{ id: "bm-pc", label: "PC mark", chapterIndex: 2, paragraphIndex: 4, excerpt: "pc", createdAt: 900 }],
        highlights: [{ id: "hl-pc", chapterIndex: 2, paragraphIndex: 4, text: "abc", color: "amber", createdAt: 950 }],
        notes: [],
        stats: { chars: 4000, words: 0, sentences: 0, time: 600 },
        driveFileId: "drive-file-1",
        fileExt: "epub",
    };
    const phoneEntry = {
        bookKey: "re:ゼロから始める異世界生活1",
        title: "Re：ゼロから始める異世界生活 1",
        chapterIndex: 7,
        chapterOffset: 0.65,
        progress: 0.42,
        lastOpenedAt: 5000,
        updatedAt: 5000,
        bookmarks: [{ id: "bm-phone", label: "Phone mark", chapterIndex: 7, paragraphIndex: 10, excerpt: "ph", createdAt: 4900 }],
        highlights: [],
        notes: [{ id: "n-phone", title: "Note", body: "Great scene", createdAt: 4800, updatedAt: 4800 }],
        stats: { chars: 9500, words: 0, sentences: 0, time: 1400 },
    };

    const { merged, localChanged, remoteChanged } = mergeEpubBookEntries(pcEntry, phoneEntry);
    assert.equal(localChanged, true);
    assert.equal(remoteChanged, true);
    // Phone read more recently -> PC jumps to phone's chapter 7 / 42%
    assert.equal(merged.chapterIndex, 7);
    assert.equal(merged.chapterOffset, 0.65);
    assert.equal(merged.progress, 0.42);
    // Union-merged annotations from both PC and phone
    assert.equal(merged.bookmarks.length, 2);
    assert.equal(merged.highlights.length, 1);
    assert.equal(merged.notes.length, 1);
    // Monotonic max stats & preserved Drive file ID
    assert.equal(merged.stats.chars, 9500);
    assert.equal(merged.driveFileId, "drive-file-1");

    // Manifest merge adds a remote-only cloud book onto a fresh device
    let nextId = 10;
    const remoteManifest = {
        schemaVersion: 1,
        updatedAt: 6000,
        books: {
            "re:ゼロから始める異世界生活2": {
                bookKey: "re:ゼロから始める異世界生活2",
                title: "Re：ゼロから始める異世界生活 2",
                chapterIndex: 4,
                chapterOffset: 0.5,
                progress: 0.3,
                lastOpenedAt: 5500,
                updatedAt: 5500,
                driveFileId: "drive-file-2",
                fileExt: "epub",
            },
        },
    };
    const res = mergeManifestWithLocalTabs([], remoteManifest, () => nextId++);
    assert.equal(res.localChanged, true);
    assert.equal(res.nextTabs.length, 1);
    assert.equal(res.nextTabs[0].epub.cloudOnly, true);
    assert.equal(res.nextTabs[0].epub.chapterIndex, 4);
    assert.equal(res.nextTabs[0].epub.driveFileId, "drive-file-2");
});

test("parseSubtitles parses SRT and WebVTT, binary-searches active cues, and matches Japanese EPUB paragraphs", () => {
    const srt = `1
00:00:01,500 --> 00:00:04,200
<i>プロローグ『始まりの余熱』</i>

2
00:00:05,000 --> 00:00:09,500
――これは本気でヤバい。
`;
    const cues = parseSubtitles(srt);
    assert.equal(cues.length, 2);
    assert.equal(cues[0].startSec, 1.5);
    assert.equal(cues[0].text, "プロローグ『始まりの余熱』");
    assert.equal(findActiveCueIndex(cues, 0.5), -1);
    assert.equal(findActiveCueIndex(cues, 2.0), 0);
    assert.equal(findActiveCueIndex(cues, 6.2), 1);

    const vtt = `WEBVTT

NOTE intro comment

00:12.000 --> 00:15.500 align:center
固い地べたの感触を顔面に味わい
`;
    const vttCues = parseSubtitles(vtt);
    assert.equal(vttCues.length, 1);
    assert.equal(vttCues[0].startSec, 12);
    assert.equal(vttCues[0].endSec, 15.5);

    const paragraphs = [
        { index: 0, text: "プロローグ『始まりの余熱』" },
        { index: 1, text: "――これは本気でヤバい。" },
        { index: 2, text: "固い地べたの感触を顔面に味わい、彼は自分がうつ伏せに倒れたのだと気付いた。" },
    ];
    assert.equal(matchCueToParagraphIndex(cues[1].text, paragraphs, 0), 1);
    assert.equal(matchCueToParagraphIndex(vttCues[0].text, paragraphs, 1), 2);
    assert.equal(formatAudioTime(65), "1:05");
    assert.equal(formatAudioTime(3665), "1:01:05");
});

test("portable EPUB JSON backup exports, parses, merges progress/shelves/bookmarks, and retains unmatched books", () => {
    const localTabs = [
        {
            id: 1,
            name: "Re:Zero 1",
            mode: "epub",
            lines: [],
            stats: { chars: 1200, words: 0, sentences: 0, time: 60 },
            epub: {
                title: "Re:Zero 1",
                series: "Re:Zero",
                shelves: ["Favorites"],
                chapterIndex: 2,
                chapterOffset: 0.25,
                progress: 0.12,
                lastOpenedAt: 1000,
                syncUpdatedAt: 1000,
                bookmarks: [{ id: "b1", label: "Start", chapterIndex: 1, paragraphIndex: 0, excerpt: "a", createdAt: 100 }],
                highlights: [],
                notes: [],
                lines: [],
            },
        },
    ];

    const backup = buildPortableEpubBackup(localTabs, ["Favorites", "JLPT N1"]);
    const raw = JSON.stringify(backup);
    const parsed = parsePortableEpubBackup(raw);
    assert.equal(parsed.schemaVersion, 1);
    assert.equal(parsed.books.length, 1);
    assert.deepEqual(parsed.customShelves, ["Favorites", "JLPT N1"]);

    // Simulate importing a backup with newer progress on Book 1 + a second book not yet on this device
    parsed.books[0].chapterIndex = 6;
    parsed.books[0].chapterOffset = 0.8;
    parsed.books[0].progress = 0.55;
    parsed.books[0].updatedAt = 5000;
    parsed.books[0].shelves = ["Reading Club"];
    parsed.books[0].bookmarks = [
        { id: "b2", label: "Climax", chapterIndex: 6, paragraphIndex: 12, excerpt: "b", createdAt: 200 },
    ];
    parsed.books.push({
        bookKey: "mushokutensei1",
        title: "Mushoku Tensei 1",
        chapterIndex: 4,
        chapterOffset: 0.5,
        progress: 0.35,
        lastOpenedAt: 4000,
        updatedAt: 4000,
        shelves: ["Isekai"],
    });

    const merged = mergePortableEpubBackup(localTabs, parsed);
    assert.equal(merged.updatedBooks, 1);
    assert.equal(merged.unmatchedEntries.length, 1);
    assert.equal(merged.unmatchedEntries[0].title, "Mushoku Tensei 1");
    assert.equal(merged.nextTabs[0].epub.chapterIndex, 6);
    assert.equal(merged.nextTabs[0].epub.progress, 0.55);
    assert.equal(merged.nextTabs[0].epub.bookmarks.length, 2);
    assert.ok(merged.nextTabs[0].epub.shelves.includes("Favorites"));
    assert.ok(merged.nextTabs[0].epub.shelves.includes("Reading Club"));
    assert.ok(merged.mergedShelves.includes("Isekai"));
});
