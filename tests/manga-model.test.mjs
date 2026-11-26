import test from "node:test";
import assert from "node:assert/strict";
import {
    applyBlockTextOverrides,
    buildSpreadPairs,
    cleanMangaSeries,
    cleanMangaTitle,
    computeBubbleCropRect,
    computeBubbleLineHeight,
    computeFittedBubbleFontPx,
    countMangaBlocksChars,
    DEFAULT_MANGA_PREFS,
    detectBubbleParagraphGaps,
    extractVolumeNumberFromBook,
    extractVolumeNumberFromText,
    findSpreadIndexForPage,
    fitMangaPage,
    formatVolumeTitleWithSeries,
    inferBookCatalogQuery,
    isMangaFileExtension,
    isMangaTabData,
    joinMokuroLines,
    needsMangaTitleCleanup,
    normalizeOcrServerUrl,
    placeBubbleLines,
    prepareBubbleDisplayLines,
    resolveMobileOcrChain,
} from "../src/features/manga/mangaModel.ts";

test("placeBubbleLines puts each OCR column where Mokuro found it", () => {
    const block = {
        box: [200, 100, 330, 300],
        vertical: true,
        fontSize: 30,
        lines: ["フォス！", "", "いるんだろ！"],
        linesCoords: [
            [[290, 100], [330, 100], [330, 220], [290, 220]],
            [[0, 0], [0, 0], [0, 0], [0, 0]],
            [[200, 180], [236, 180], [236, 300], [200, 300]],
        ],
    };
    const placed = placeBubbleLines(block);
    assert.equal(placed.length, 2);
    assert.deepEqual(
        placed.map(({ text, offset, left, top, width, height }) => ({ text, offset, left, top, width, height })),
        [
            { text: "フォス！", offset: 0, left: (90 / 130) * 100, top: 0, width: (40 / 130) * 100, height: 60 },
            { text: "いるんだろ！", offset: 4, left: 0, top: 40, width: (36 / 130) * 100, height: 60 },
        ],
    );
    assert.equal(placed[0].fontPx, 30);
    assert.equal(placed[1].fontPx, 20);
    assert.equal(placeBubbleLines({ ...block, linesCoords: undefined }), null);
    assert.equal(placeBubbleLines({ ...block, lines: ["明日は雨"] }), null);
});

test("joinMokuroLines joins Japanese lines without spaces and English lines with spaces", () => {
    assert.equal(joinMokuroLines(["お前", "何してるんだ！？"]), "お前何してるんだ！？");
    assert.equal(joinMokuroLines(["What are", "you doing?"]), "What are you doing?");
    assert.equal(joinMokuroLines(["  ", "記憶の", "片隅  "]), "記憶の片隅");
});

test("buildSpreadPairs respects single, webtoon, and 2-page spread with cover offset", () => {
    assert.deepEqual(buildSpreadPairs(5, "single", true), [[0], [1], [2], [3], [4]]);
    assert.deepEqual(buildSpreadPairs(5, "spread", true), [[0], [1, 2], [3, 4]]);
    assert.deepEqual(buildSpreadPairs(5, "spread", false), [[0, 1], [2, 3], [4]]);
    assert.equal(findSpreadIndexForPage([[0], [1, 2], [3, 4]], 2), 1);
    assert.equal(findSpreadIndexForPage([[0], [1, 2], [3, 4]], 3), 2);
});

test("computeBubbleCropRect expands around bubble and clamps to page bounds", () => {
    const rect = computeBubbleCropRect([10, 20, 90, 220], 1000, 1400);
    assert.equal(rect.x, 0);
    assert.equal(rect.y, 0);
    assert.ok(rect.width >= 500 && rect.width <= 1000);
    assert.ok(rect.height >= 420 && rect.height <= 1400);

    const centerRect = computeBubbleCropRect([460, 600, 540, 800], 1000, 1400);
    assert.ok(centerRect.x > 0 && centerRect.x + centerRect.width <= 1000);
    assert.ok(centerRect.y > 0 && centerRect.y + centerRect.height <= 1400);
});

test("manga page frame preserves OCR coordinates on portrait, landscape, spread and zoom", () => {
    assert.deepEqual(fitMangaPage(1000, 1500, 360, 700, "height", false, 1), { width: 360, height: 540 });
    assert.deepEqual(fitMangaPage(1000, 1500, 700, 360, "height", false, 1), { width: 240, height: 360 });
    assert.deepEqual(fitMangaPage(1000, 1500, 608, 700, "width", true, 2), { width: 600, height: 900 });
    assert.deepEqual(fitMangaPage(1000, 1500, 360, 700, "original", false, 1), { width: 1000, height: 1500 });
});

test("countMangaBlocksChars and applyBlockTextOverrides handle edits cleanly", () => {
    const blocks = [
        { box: [0, 0, 100, 200], vertical: true, fontSize: 22, lines: ["今日 は", "いい天気"] },
    ];
    assert.equal(countMangaBlocksChars(blocks), 7);
    const patched = applyBlockTextOverrides(blocks, { 0: "明日は雨" });
    assert.deepEqual(patched[0].lines, ["明日は雨"]);
    assert.equal(countMangaBlocksChars(patched), 4);
});

test("isMangaFileExtension and isMangaTabData recognize manga formats", () => {
    assert.equal(isMangaFileExtension("cbz"), true);
    assert.equal(isMangaFileExtension(".mokuro"), true);
    assert.equal(isMangaFileExtension("epub"), false);
    assert.equal(isMangaTabData({ format: "manga" }), true);
    assert.equal(isMangaTabData({ fileExt: "cbz" }), true);
    assert.equal(isMangaTabData({ fileExt: "epub" }), false);
});

test("computeFittedBubbleFontPx keeps every column and character inside the OCR box", () => {
    // Real Houseki no Kuni v01 p.11 block: ["おまえの", "仕事が"], box 84x138, OCR font 38
    const vertical = { box: [172, 208, 256, 346], vertical: true, fontSize: 38, lines: ["おまえの", "仕事が"] };
    const v = computeFittedBubbleFontPx(vertical);
    assert.ok(v * 4 <= 138, "longest line fits the column height");
    assert.ok(v * 2 * 1.15 <= 84 + 0.001, "both columns fit the box width");
    assert.ok(v <= 38);

    const horizontal = { box: [0, 0, 200, 40], vertical: false, fontSize: 60, lines: ["Hello there"] };
    const h = computeFittedBubbleFontPx(horizontal);
    assert.ok(h * 1.15 <= 40 + 0.001);
    assert.ok(h * 11 <= 200);

    const tiny = { box: [0, 0, 2, 2], vertical: true, fontSize: 30, lines: ["あいうえお"] };
    assert.equal(computeFittedBubbleFontPx(tiny), 4);
});

test("normalizeOcrServerUrl normalizes scheme and trailing slashes", () => {
    assert.equal(normalizeOcrServerUrl(""), "");
    assert.equal(normalizeOcrServerUrl("   "), "");
    assert.equal(normalizeOcrServerUrl("192.168.1.42:47123/"), "http://192.168.1.42:47123");
    assert.equal(normalizeOcrServerUrl("https://my-pc.local:8443///"), "https://my-pc.local:8443");
});

test("resolveMobileOcrChain routes across PC Wi-Fi, offline ONNX, and ML Kit", () => {
    assert.deepEqual(
        resolveMobileOcrChain({ mobileEngine: "auto", remoteUrl: "" }, false),
        ["mlkit"],
    );
    assert.deepEqual(
        resolveMobileOcrChain({ mobileEngine: "auto", remoteUrl: "" }, true),
        ["onnx", "mlkit"],
    );
    assert.deepEqual(
        resolveMobileOcrChain({ mobileEngine: "auto", remoteUrl: "192.168.0.15:47123" }, true),
        ["remote", "onnx", "mlkit"],
    );
    assert.deepEqual(
        resolveMobileOcrChain({ mobileEngine: "remote", remoteUrl: "" }, true),
        ["remote"],
    );
    assert.deepEqual(
        resolveMobileOcrChain({ mobileEngine: "onnx", remoteUrl: "192.168.0.15:47123" }, false),
        ["onnx"],
    );
    assert.deepEqual(
        resolveMobileOcrChain({ mobileEngine: "mlkit", remoteUrl: "192.168.0.15:47123" }, true),
        ["mlkit"],
    );
});

test("cleanMangaTitle and cleanMangaSeries strip site prefixes, pack ranges, and mokuro hashes", () => {
    assert.equal(needsMangaTitleCleanup("DLraw.net_Houseki no Kuni vol 01-09 — Houseki no Kuni 01"), true);
    assert.equal(needsMangaTitleCleanup("setsuna-mokuro-45edeb3ef1f72dea0c9a"), true);
    assert.equal(needsMangaTitleCleanup("book_1795545399615"), true);
    assert.equal(needsMangaTitleCleanup("book 1795545399615"), true);
    assert.equal(needsMangaTitleCleanup("宝石の国 第01巻"), false);
    assert.equal(DEFAULT_MANGA_PREFS.bgTheme, "dark");

    assert.equal(
        cleanMangaTitle("DLraw.net_Houseki no Kuni vol 01-09 — Houseki_no_Kuni_v01"),
        "Houseki no Kuni v01",
    );
    assert.equal(
        cleanMangaTitle("DLraw.net_Houseki no Kuni vol 01-09 — 01"),
        "Houseki no Kuni 01",
    );
    assert.equal(
        cleanMangaTitle("setsuna-mokuro-45edeb3ef1f72dea0c9a — Houseki no Kuni 02"),
        "Houseki no Kuni 02",
    );
    assert.equal(
        cleanMangaTitle("setsuna-mokuro-45edeb3ef1f72dea0c9a", "D:/Manga/[DLraw] Houseki_no_Kuni_03.cbz"),
        "Houseki no Kuni 03",
    );
    assert.equal(
        cleanMangaTitle("DLraw", "D:/Manga/DLraw.net_Houseki no Kuni v02"),
        "Houseki no Kuni v02",
    );
    assert.equal(cleanMangaSeries("DLraw.net_Houseki no Kuni vol 01-09"), "Houseki no Kuni");
    assert.equal(cleanMangaSeries("setsuna-mokuro-45edeb3ef1f72dea0c9a"), undefined);
});

test("inferBookCatalogQuery and formatVolumeTitleWithSeries derive queries and rename volumes", () => {
    assert.equal(
        inferBookCatalogQuery({
            title: "Houseki no Kuni v03",
            series: "DLraw.net_Houseki no Kuni vol 01-09",
            path: "D:/Manga/Houseki_no_Kuni_03.cbz",
        }),
        "Houseki no Kuni",
    );
    assert.equal(
        inferBookCatalogQuery({
            title: "setsuna-mokuro-deadbeef12345678",
            path: "C:/Manga/[Raw] Yotsubato!_v04.cbz",
        }),
        "Yotsubato!",
    );
    assert.equal(formatVolumeTitleWithSeries("宝石の国", "Houseki no Kuni v01", 1), "宝石の国 01");
    assert.equal(formatVolumeTitleWithSeries("宝石の国", "Houseki no Kuni 12", null), "宝石の国 12");
    assert.equal(formatVolumeTitleWithSeries("よつばと!", "Oneshot", null), "よつばと!");
    assert.equal(
        formatVolumeTitleWithSeries("宝石の国", "book_1795545399615", null, "D:/Manga/DLraw.net_Houseki no Kuni v02"),
        "宝石の国 02",
    );
    assert.equal(extractVolumeNumberFromText("DLraw.net_Houseki no Kuni v02"), 2);
    assert.equal(extractVolumeNumberFromText("宝石の国（０３）"), 3);
    assert.equal(extractVolumeNumberFromText("宝石の国2"), 2);
    assert.equal(extractVolumeNumberFromText("book_1795545399615"), null);
    assert.equal(inferBookCatalogQuery({ title: "宝石の国2" }), "宝石の国");
    assert.equal(inferBookCatalogQuery({ title: "宝石の国(9)" }), "宝石の国");
    assert.equal(inferBookCatalogQuery({ title: "宝石の国(02) 特装版" }), "宝石の国");
    assert.equal(inferBookCatalogQuery({ title: "宝石の国（１３）" }), "宝石の国");
    assert.equal(
        extractVolumeNumberFromBook({ title: "Houseki no Kuni", path: "D:/Manga/DLraw.net_Houseki no Kuni v02" }),
        2,
    );
});

test("prepareBubbleDisplayLines preserves line breaks and exact joinMokuroLines offsets", () => {
    const jp = prepareBubbleDisplayLines(["遠い未来、", "僕らは「宝石」になった。", "  ", "果てなき戦い。"]);
    assert.deepEqual(
        jp.map((l) => ({ text: l.text, offset: l.offset, appendSpace: l.appendSpace })),
        [
            { text: "遠い未来、", offset: 0, appendSpace: false },
            { text: "僕らは「宝石」になった。", offset: 5, appendSpace: false },
            { text: "果てなき戦い。", offset: 17, appendSpace: false },
        ],
    );
    assert.equal(
        jp.map((l) => l.text + (l.appendSpace ? " " : "")).join(""),
        joinMokuroLines(["遠い未来、", "僕らは「宝石」になった。", "  ", "果てなき戦い。"]),
    );

    const en = prepareBubbleDisplayLines(["What are", "you doing?"]);
    assert.deepEqual(
        en.map((l) => ({ text: l.text, offset: l.offset, appendSpace: l.appendSpace })),
        [
            { text: "What are", offset: 0, appendSpace: true },
            { text: "you doing?", offset: 9, appendSpace: false },
        ],
    );
    assert.equal(en.map((l) => l.text + (l.appendSpace ? " " : "")).join(""), "What are you doing?");
});

test("computeFittedBubbleFontPx wraps long single-line text in large boxes and computes line height & paragraph gaps", () => {
    const longSingleLine = {
        box: [100, 100, 760, 420],
        vertical: false,
        fontSize: 28,
        lines: ["遠い未来、僕らは「宝石」になった。粉々になっても再生する不死のカラダを持つ宝石28人と、彼らを装飾品にしようと襲いかかる月人との果てなき戦い。"],
    };
    const fs = computeFittedBubbleFontPx(longSingleLine);
    assert.ok(fs > 12 && fs <= 28, `expected readable wrapped font > 12, got ${fs}`);

    const multiLineBlurb = {
        box: [100, 100, 760, 460],
        vertical: false,
        fontSize: 24,
        lines: [
            "遠い未来、僕らは「宝石」になった――。",
            "粉々になっても再生する不死のカラダを持つ宝石28人と、",
            "彼らを装飾品にしようと襲いかかる月人との果てなき戦い。",
            "強くてもろくて美しい、",
            "宝石たちの新感覚アクション・バトル・ファンタジー。",
        ],
        linesCoords: [
            [[100, 105], [700, 105], [700, 135], [100, 135]],
            [[100, 185], [700, 185], [700, 210], [100, 210]],
            [[100, 230], [700, 230], [700, 255], [100, 255]],
            [[100, 275], [700, 275], [700, 300], [100, 300]],
            [[100, 320], [700, 320], [700, 345], [100, 345]],
        ],
    };
    const blurbFs = computeFittedBubbleFontPx(multiLineBlurb);
    const lh = computeBubbleLineHeight(multiLineBlurb, blurbFs);
    assert.ok(lh >= 1.4 && lh <= 1.75, `expected expanded line height for spacious blurb, got ${lh}`);
    assert.deepEqual(detectBubbleParagraphGaps(multiLineBlurb), [false, true, false, false, false]);

    const evenLines = {
        vertical: false,
        lines: ["a", "b", "c"],
        linesCoords: [
            [[0, 10], [10, 10], [10, 20], [0, 20]],
            [[0, 40], [10, 40], [10, 50], [0, 50]],
            [[0, 70], [10, 70], [10, 80], [0, 80]],
        ],
    };
    assert.deepEqual(detectBubbleParagraphGaps(evenLines), [false, false, false]);
    assert.deepEqual(detectBubbleParagraphGaps({ vertical: false, lines: ["a", "b", "c"] }), [false, false, false]);
});
