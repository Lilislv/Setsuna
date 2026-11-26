import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";

const bundle = await build({
    stdin: {
        contents: "export * from './src/features/epub/epubSentences';",
        resolveDir: process.cwd(),
        loader: "ts",
    },
    bundle: true,
    write: false,
    format: "esm",
    platform: "node",
});

const mod = await import(
    `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`
);

const {
    formatSelectedSentencesForCopy,
    splitTextIntoSentenceRanges,
    wrapParagraphHtmlSentences,
} = mod;

test("splitTextIntoSentenceRanges splits Japanese sentences including dialogue and punctuation", () => {
    const ja = "スバルは息をついた。本当に大丈夫なのか！？「行こう」「うん！」……そう呟いた。";
    const res = splitTextIntoSentenceRanges(ja, "ja");
    assert.deepEqual(
        res.map((r) => r.text),
        ["スバルは息をついた。", "本当に大丈夫なのか！？", "「行こう」", "「うん！」", "……そう呟いた。"],
    );
});

test("splitTextIntoSentenceRanges keeps Japanese inline quotes, thoughts, and parentheticals intact", () => {
    const ja = "「待って！」と彼女は叫んだ。『痛み？』と思った。（本当に！？）と考えた。次の文だ。";
    const res = splitTextIntoSentenceRanges(ja, "ja");
    assert.deepEqual(
        res.map((r) => r.text),
        [
            "「待って！」と彼女は叫んだ。",
            "『痛み？』と思った。",
            "（本当に！？）と考えた。",
            "次の文だ。",
        ],
    );
});

test("splitTextIntoSentenceRanges splits English sentences while protecting abbreviations, decimals, and dialogue tags", () => {
    const en = 'Dr. Smith checked 3.14 meters! "Wait!" she shouted. "Why?" he asked. Was it ready? "Yes," he said. Everything worked.';
    const res = splitTextIntoSentenceRanges(en, "en");
    assert.deepEqual(
        res.map((r) => r.text),
        [
            "Dr. Smith checked 3.14 meters!",
            '"Wait!" she shouted.',
            '"Why?" he asked.',
            "Was it ready?",
            '"Yes," he said.',
            "Everything worked.",
        ],
    );
});

test("wrapParagraphHtmlSentences wraps entire <ruby> elements inside ONE contiguous sentence span", () => {
    const html = "<p>暗い、鮮血の<ruby>絨毯<rt>じゅうたん</rt></ruby>を敷き詰めた床を踏みつける。<ruby>彼<rt>かれ</rt></ruby>は笑った！</p>";
    const wrapped = wrapParagraphHtmlSentences(html, 4, "ja");
    assert.equal(wrapped.sentences.length, 2);
    assert.equal(wrapped.sentences[0].key, "4:0");
    assert.equal(wrapped.sentences[0].text, "暗い、鮮血の絨毯を敷き詰めた床を踏みつける。");
    assert.equal(wrapped.sentences[0].html, "暗い、鮮血の<ruby>絨毯<rt>じゅうたん</rt></ruby>を敷き詰めた床を踏みつける。");
    assert.equal(wrapped.sentences[1].key, "4:1");
    assert.equal(wrapped.sentences[1].text, "彼は笑った！");
    assert.equal(wrapped.sentences[1].html, "<ruby>彼<rt>かれ</rt></ruby>は笑った！");
    assert.equal(
        wrapped.html,
        '<p><span class="epub-sentence" data-sentence-key="4:0" data-sentence-parity="0">暗い、鮮血の<ruby>絨毯<rt>じゅうたん</rt></ruby>を敷き詰めた床を踏みつける。</span><span class="epub-sentence" data-sentence-key="4:1" data-sentence-parity="1"><ruby>彼<rt>かれ</rt></ruby>は笑った！</span></p>',
    );
});

test("wrapParagraphHtmlSentences splits lines separated by <br/> cleanly", () => {
    const html = "<p>一行目の台詞<br/>二行目の台詞</p>";
    const wrapped = wrapParagraphHtmlSentences(html, 7, "ja");
    assert.deepEqual(
        wrapped.sentences.map((s) => s.text),
        ["一行目の台詞", "二行目の台詞"],
    );
    assert.equal(
        wrapped.html,
        '<p><span class="epub-sentence" data-sentence-key="7:0" data-sentence-parity="0">一行目の台詞</span><br/><span class="epub-sentence" data-sentence-key="7:1" data-sentence-parity="1">二行目の台詞</span></p>',
    );
});

test("wrapParagraphHtmlSentences preserves highlight <mark> tags cleanly without crossing elements", () => {
    const html = '<p><mark class="epub-hl epub-hl-amber" data-hl-id="h1">First sentence. Second</mark> sentence.</p>';
    const wrapped = wrapParagraphHtmlSentences(html, 2, "en");
    assert.deepEqual(
        wrapped.sentences.map((s) => s.text),
        ["First sentence.", "Second sentence."],
    );
    assert.equal(wrapped.sentences[0].html, '<mark class="epub-hl epub-hl-amber" data-hl-id="h1">First sentence.</mark>');
    assert.equal(wrapped.sentences[1].html, '<mark class="epub-hl epub-hl-amber" data-hl-id="h1">Second</mark> sentence.');
    assert.equal(
        wrapped.html,
        '<p><mark class="epub-hl epub-hl-amber" data-hl-id="h1"><span class="epub-sentence" data-sentence-key="2:0" data-sentence-parity="0">First sentence.</span> <span class="epub-sentence" data-sentence-key="2:1" data-sentence-parity="1">Second</span></mark><span class="epub-sentence" data-sentence-key="2:1" data-sentence-parity="1"> sentence.</span></p>',
    );
});

test("formatSelectedSentencesForCopy sorts out-of-order picks and joins same/different paragraphs properly", () => {
    const map = new Map([
        ["1:0", { key: "1:0", paragraphIndex: 1, sentenceIndex: 0, text: "First." }],
        ["1:1", { key: "1:1", paragraphIndex: 1, sentenceIndex: 1, text: "Second." }],
        ["3:0", { key: "3:0", paragraphIndex: 3, sentenceIndex: 0, text: "Third." }],
    ]);
    assert.equal(formatSelectedSentencesForCopy(["3:0", "1:1", "1:0", "1:1"], map, "en"), "First. Second.\nThird.");

    const jaMap = new Map([
        ["0:0", { key: "0:0", paragraphIndex: 0, sentenceIndex: 0, text: "一文目。" }],
        ["0:1", { key: "0:1", paragraphIndex: 0, sentenceIndex: 1, text: "二文目。" }],
        ["2:0", { key: "2:0", paragraphIndex: 2, sentenceIndex: 0, text: "次の段落。" }],
    ]);
    assert.equal(formatSelectedSentencesForCopy(["2:0", "0:0", "0:1"], jaMap, "ja"), "一文目。二文目。\n次の段落。");
});
