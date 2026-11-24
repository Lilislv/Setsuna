import test from "node:test";
import assert from "node:assert/strict";
import {
    applyBlockTextOverrides,
    buildSpreadPairs,
    computeBubbleCropRect,
    computeFittedBubbleFontPx,
    countMangaBlocksChars,
    findSpreadIndexForPage,
    isMangaFileExtension,
    isMangaTabData,
    joinMokuroLines,
} from "../src/features/manga/mangaModel.ts";

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
