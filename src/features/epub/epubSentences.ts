export type SentenceRange = { start: number; end: number; text: string };

export type EpubSentenceItem = {
    key: string;
    paragraphIndex: number;
    sentenceIndex: number;
    text: string;
    html: string;
};

const JA_CLOSERS = "」』）)】》〉〕］｝\"'”’";
const JA_QUOTE_OR_PAREN_CLOSERS = "」』）)";
const JA_OPEN_TO_CLOSE: Record<string, string> = {
    "（": "）",
    "(": ")",
    "『": "』",
    "【": "】",
    "《": "》",
    "〔": "〕",
};
const JA_QUOTE_CONTINUATION = new Set([
    "と",
    "っ",
    "、",
    "，",
    "の",
    "を",
    "が",
    "は",
    "に",
    "で",
    "も",
    "へ",
    "や",
    "な",
    "か",
    "し",
    "だ",
    "て",
    "ば",
    "よ",
    "ね",
    "さ",
    "ぞ",
    "ぜ",
    "わ",
    "。",
    "・",
]);

const EN_CLOSERS = "\"'”’)\\]}";
const EN_QUOTES = "\"'”’";
const EN_ABBREVIATIONS = new Set([
    "mr",
    "mrs",
    "ms",
    "dr",
    "prof",
    "sr",
    "jr",
    "st",
    "vs",
    "etc",
    "no",
    "fig",
    "vol",
    "p",
    "pp",
]);

function isJapaneseTerminator(ch: string): boolean {
    return ch === "。" || ch === "！" || ch === "？" || ch === "!" || ch === "?";
}

function isDigit(ch: string | undefined): boolean {
    return Boolean(ch && ch >= "0" && ch <= "9");
}

function isLetter(ch: string | undefined): boolean {
    return Boolean(ch && /[A-Za-z]/.test(ch));
}

function isInlineSpace(ch: string | undefined): boolean {
    return Boolean(ch && ch !== "\n" && /\s/.test(ch));
}

/**
 * Splits plain paragraph text into `[start, end)` sentence ranges in a language-aware way.
 */
export function splitTextIntoSentenceRanges(text: string, language: "ja" | "en"): SentenceRange[] {
    if (!text || !text.trim()) return [];

    const ranges: SentenceRange[] = [];
    const len = text.length;
    let start = 0;

    while (start < len && /\s/.test(text[start])) start += 1;

    const pushSlice = (rawStart: number, rawEnd: number) => {
        let s = rawStart;
        let e = rawEnd;
        while (s < e && /\s/.test(text[s])) s += 1;
        while (e > s && /\s/.test(text[e - 1])) e -= 1;
        if (e > s) {
            ranges.push({ start: s, end: e, text: text.slice(s, e) });
        }
    };

    if (language === "ja") {
        let i = start;
        const bracketStack: string[] = [];
        while (i < len) {
            const ch = text[i];
            if (ch === "\n") {
                pushSlice(start, i);
                bracketStack.length = 0;
                start = i + 1;
                while (start < len && /\s/.test(text[start])) start += 1;
                i = start;
                continue;
            }
            if (bracketStack.length > 0 && ch === bracketStack[bracketStack.length - 1]) {
                bracketStack.pop();
                i += 1;
                continue;
            }
            const expectedClose = JA_OPEN_TO_CLOSE[ch];
            if (expectedClose && text.indexOf(expectedClose, i + 1) >= 0) {
                bracketStack.push(expectedClose);
                i += 1;
                continue;
            }
            if (isJapaneseTerminator(ch)) {
                if (bracketStack.length > 0) {
                    i += 1;
                    continue;
                }
                let end = i + 1;
                while (end < len && (isJapaneseTerminator(text[end]) || text[end] === "…")) {
                    end += 1;
                }
                let consumedQuoteOrParen = false;
                while (end < len && JA_CLOSERS.includes(text[end])) {
                    if (JA_QUOTE_OR_PAREN_CLOSERS.includes(text[end])) {
                        consumedQuoteOrParen = true;
                    }
                    end += 1;
                }
                if (consumedQuoteOrParen) {
                    let nextIdx = end;
                    while (nextIdx < len && isInlineSpace(text[nextIdx])) nextIdx += 1;
                    if (nextIdx < len && text[nextIdx] !== "\n" && JA_QUOTE_CONTINUATION.has(text[nextIdx])) {
                        i = end;
                        continue;
                    }
                }
                pushSlice(start, end);
                start = end;
                while (start < len && /\s/.test(text[start])) start += 1;
                i = start;
                continue;
            }
            if (
                bracketStack.length === 0
                && (ch === "」" || ch === "』")
                && (text[i + 1] === "「" || text[i + 1] === "『")
            ) {
                const end = i + 1;
                pushSlice(start, end);
                start = end;
                i = start;
                continue;
            }
            i += 1;
        }
    } else {
        let i = start;
        let parenDepth = 0;
        while (i < len) {
            const ch = text[i];
            if (ch === "\n") {
                pushSlice(start, i);
                parenDepth = 0;
                start = i + 1;
                while (start < len && /\s/.test(text[start])) start += 1;
                i = start;
                continue;
            }
            if (ch === "(" && text.indexOf(")", i + 1) >= 0) {
                parenDepth += 1;
                i += 1;
                continue;
            }
            if (ch === ")" && parenDepth > 0) {
                parenDepth -= 1;
                i += 1;
                continue;
            }
            if (ch === "." || ch === "!" || ch === "?" || ch === "…") {
                if (parenDepth > 0) {
                    i += 1;
                    continue;
                }
                if (ch === ".") {
                    // Decimal number like 3.14
                    if (isDigit(text[i - 1]) && isDigit(text[i + 1])) {
                        i += 1;
                        continue;
                    }
                    // Dotted abbreviation like e.g. or i.e. or J.K.
                    if (isLetter(text[i - 1]) && text[i + 1] && isLetter(text[i + 1])) {
                        i += 1;
                        continue;
                    }
                    // Single letter initial like "J. K." or known title abbreviation like "Dr. Smith"
                    const wordMatch = text.slice(start, i).match(/([A-Za-z]+)$/);
                    const prevWord = wordMatch?.[1] || "";
                    if (prevWord) {
                        const lower = prevWord.toLowerCase();
                        let afterDot = i + 1;
                        while (afterDot < len && EN_CLOSERS.includes(text[afterDot])) afterDot += 1;
                        let nextNonSpace = afterDot;
                        while (nextNonSpace < len && /\s/.test(text[nextNonSpace])) nextNonSpace += 1;
                        const nextChar = text[nextNonSpace];
                        if (EN_ABBREVIATIONS.has(lower)) {
                            i += 1;
                            continue;
                        }
                        if (prevWord.length === 1 && nextChar && /[A-Z]/.test(nextChar)) {
                            i += 1;
                            continue;
                        }
                    }
                }

                let end = i + 1;
                while (end < len && (text[end] === "." || text[end] === "!" || text[end] === "?" || text[end] === "…")) {
                    end += 1;
                }
                const isEllipsis = ch === "…" || (ch === "." && end - i >= 2);
                let consumedQuote = false;
                while (end < len && EN_CLOSERS.includes(text[end])) {
                    if (EN_QUOTES.includes(text[end])) consumedQuote = true;
                    end += 1;
                }
                if (end === len || /\s/.test(text[end])) {
                    let nextIdx = end;
                    while (nextIdx < len && isInlineSpace(text[nextIdx])) nextIdx += 1;
                    if (nextIdx < len && text[nextIdx] !== "\n") {
                        const nextChar = text[nextIdx];
                        // English dialogue attribution: `"Wait!" she shouted.` / `"Why?" he asked.`
                        if (consumedQuote && (ch === "!" || ch === "?" || isEllipsis) && /[a-z]/.test(nextChar)) {
                            i = end;
                            continue;
                        }
                        // Mid-sentence ellipsis: `Wait... really?`
                        if (!consumedQuote && isEllipsis && /[a-z]/.test(nextChar)) {
                            i = end;
                            continue;
                        }
                    }
                    pushSlice(start, end);
                    start = end;
                    while (start < len && /\s/.test(text[start])) start += 1;
                    i = start;
                    continue;
                }
            }
            i += 1;
        }
    }

    if (start < len) {
        pushSlice(start, len);
    }

    return ranges;
}

const ENTITY_MAP: Record<string, string> = {
    "&amp;": "&",
    "&lt;": "<",
    "&gt;": ">",
    "&quot;": '"',
    "&#39;": "'",
    "&apos;": "'",
    "&nbsp;": " ",
};

function decodeHtmlText(raw: string): string {
    return raw.replace(/&(?:#(\d+)|#x([0-9a-fA-F]+)|[a-zA-Z]+);/g, (full, dec, hex) => {
        if (dec) {
            const cp = Number.parseInt(dec, 10);
            return Number.isFinite(cp) ? String.fromCodePoint(cp) : full;
        }
        if (hex) {
            const cp = Number.parseInt(hex, 16);
            return Number.isFinite(cp) ? String.fromCodePoint(cp) : full;
        }
        return ENTITY_MAP[full] ?? full;
    });
}

function escapeHtmlAttr(value: string): string {
    return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeHtmlBody(value: string): string {
    return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const BLOCK_TAGS = new Set([
    "p",
    "div",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "li",
    "ul",
    "ol",
    "dl",
    "dt",
    "dd",
    "blockquote",
    "section",
    "article",
    "aside",
    "header",
    "footer",
    "nav",
    "figure",
    "figcaption",
    "pre",
    "table",
    "thead",
    "tbody",
    "tfoot",
    "tr",
    "td",
    "th",
]);

const VOID_TAGS = new Set(["br", "hr", "img", "wbr", "meta", "link", "input", "source", "col"]);
const RUBY_SKIP_TAGS = new Set(["rt", "rp", "rtc"]);

function buildPerSentenceHtml(
    segments: string[],
    ranges: SentenceRange[],
    language: "ja" | "en",
): string[] {
    if (ranges.length === 0) return [];

    type OpenTag = { seq: number; name: string; openTag: string };
    const perSentenceParts: string[][] = ranges.map(() => []);
    const sentOpenStacks: OpenTag[][] = ranges.map(() => []);
    const globalStack: OpenTag[] = [];
    let nextSeq = 1;
    let rtDepth = 0;
    let charOffset = 0;
    let rIdx = 0;
    let lastActiveSentence = -1;

    const ensureSentenceTags = (sIdx: number) => {
        const stack = sentOpenStacks[sIdx];
        for (const tag of globalStack) {
            if (!stack.some((t) => t.seq === tag.seq)) {
                perSentenceParts[sIdx].push(tag.openTag);
                stack.push(tag);
            }
        }
    };

    const closeSeqEverywhere = (seq: number) => {
        for (let sIdx = 0; sIdx < sentOpenStacks.length; sIdx++) {
            const stack = sentOpenStacks[sIdx];
            const pos = stack.findIndex((t) => t.seq === seq);
            if (pos < 0) continue;
            while (stack.length > pos) {
                const closed = stack.pop()!;
                perSentenceParts[sIdx].push(`</${closed.name}>`);
            }
        }
    };

    for (const seg of segments) {
        if (!seg) continue;
        if (seg.startsWith("<")) {
            const closeMatch = seg.match(/^<\/([a-zA-Z0-9:-]+)\s*>/);
            if (closeMatch) {
                const tagName = closeMatch[1].toLowerCase();
                if (RUBY_SKIP_TAGS.has(tagName)) {
                    if (lastActiveSentence >= 0) {
                        const stack = sentOpenStacks[lastActiveSentence];
                        const pos = stack.map((t) => t.name).lastIndexOf(tagName);
                        if (pos >= 0) {
                            while (stack.length > pos) {
                                const closed = stack.pop()!;
                                perSentenceParts[lastActiveSentence].push(`</${closed.name}>`);
                            }
                        }
                    }
                    rtDepth = Math.max(0, rtDepth - 1);
                }
                for (let k = globalStack.length - 1; k >= 0; k--) {
                    if (globalStack[k].name === tagName) {
                        const removed = globalStack.splice(k, globalStack.length - k);
                        for (let r = removed.length - 1; r >= 0; r--) {
                            closeSeqEverywhere(removed[r].seq);
                        }
                        break;
                    }
                }
                continue;
            }

            const openMatch = seg.match(/^<([a-zA-Z0-9:-]+)/);
            if (!openMatch) continue;
            const tagName = openMatch[1].toLowerCase();
            if (tagName === "br") {
                if (rtDepth === 0) charOffset += 1;
                continue;
            }
            if (BLOCK_TAGS.has(tagName) || VOID_TAGS.has(tagName) || /\/>$/.test(seg)) {
                continue;
            }
            if (RUBY_SKIP_TAGS.has(tagName)) {
                rtDepth += 1;
                if (lastActiveSentence >= 0) {
                    const rtTag: OpenTag = { seq: nextSeq++, name: tagName, openTag: seg };
                    globalStack.push(rtTag);
                    ensureSentenceTags(lastActiveSentence);
                    continue;
                }
            }
            globalStack.push({ seq: nextSeq++, name: tagName, openTag: seg });
            continue;
        }

        if (rtDepth > 0) {
            if (lastActiveSentence >= 0) {
                perSentenceParts[lastActiveSentence].push(seg);
            }
            continue;
        }

        const decoded = decodeHtmlText(seg);
        if (!decoded) continue;
        const segStart = charOffset;
        const segEnd = segStart + decoded.length;
        charOffset = segEnd;

        let cursor = segStart;
        while (rIdx < ranges.length && ranges[rIdx].end <= cursor) {
            rIdx += 1;
        }
        while (cursor < segEnd) {
            while (rIdx < ranges.length && ranges[rIdx].end <= cursor) {
                rIdx += 1;
            }
            const active = ranges[rIdx];
            if (!active || active.start >= segEnd) break;
            if (active.start > cursor) {
                cursor = Math.min(active.start, segEnd);
                continue;
            }
            const sliceEnd = Math.min(active.end, segEnd);
            let sliceText = decoded.slice(cursor - segStart, sliceEnd - segStart);
            if (sliceText) {
                if (language === "en" && perSentenceParts[rIdx].length === 0) {
                    sliceText = sliceText.replace(/^\s+/, "");
                }
                if (sliceText) {
                    ensureSentenceTags(rIdx);
                    perSentenceParts[rIdx].push(escapeHtmlBody(sliceText));
                    lastActiveSentence = rIdx;
                }
            }
            cursor = sliceEnd;
        }
    }

    for (let sIdx = 0; sIdx < sentOpenStacks.length; sIdx++) {
        const stack = sentOpenStacks[sIdx];
        while (stack.length > 0) {
            const closed = stack.pop()!;
            perSentenceParts[sIdx].push(`</${closed.name}>`);
        }
    }

    return perSentenceParts.map((parts) => parts.join("").trim());
}

type HtmlToken =
    | { kind: "block-open" | "block-close" | "br" | "void-break" | "inline-void" | "rt-text" | "comment"; raw: string }
    | {
        kind: "inline-open";
        raw: string;
        name: string;
        pairIdx: number;
        firstChar: number;
        lastChar: number;
        hasBreak: boolean;
        containedSentence: number;
    }
    | { kind: "inline-close"; raw: string; name: string }
    | { kind: "text"; raw: string; decoded: string; charStart: number; charEnd: number };

function findContainingSentence(firstChar: number, lastChar: number, ranges: SentenceRange[]): number {
    if (firstChar >= lastChar) return -1;
    let lo = 0;
    let hi = ranges.length - 1;
    while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const r = ranges[mid];
        if (lastChar <= r.start) {
            hi = mid - 1;
        } else if (firstChar >= r.end) {
            lo = mid + 1;
        } else {
            return firstChar >= r.start && lastChar <= r.end ? mid : -1;
        }
    }
    return -1;
}

/**
 * Wraps sanitized paragraph HTML into contiguous
 * `<span class="epub-sentence" data-sentence-key="P:S" data-sentence-parity="0|1">...</span>` spans.
 * Inline tags that live completely inside one sentence (such as `<ruby>…</ruby>`, `<em>`,
 * emphasis `<span>`, etc.) stay INSIDE the sentence span so sentences never fragment at furigana,
 * while inline tags crossing sentence boundaries (such as multi-sentence `<mark>` highlights)
 * remain properly nested with matching `data-sentence-key` spans inside them.
 */
export function wrapParagraphHtmlSentences(
    html: string,
    paragraphIndex: number,
    language: "ja" | "en",
): { html: string; sentences: EpubSentenceItem[] } {
    if (!html) return { html: "", sentences: [] };

    const segments = html.split(/(<[^>]+>)/g);
    const tokens: HtmlToken[] = [];
    type StackEntry = { tokenIdx: number; name: string };
    const inlineStack: StackEntry[] = [];
    let fullText = "";
    let rtDepth = 0;

    const markStackBreak = () => {
        for (const entry of inlineStack) {
            const tok = tokens[entry.tokenIdx];
            if (tok.kind === "inline-open") tok.hasBreak = true;
        }
    };

    const recordStackChars = (charStart: number, charEnd: number) => {
        if (charStart >= charEnd) return;
        for (const entry of inlineStack) {
            const tok = tokens[entry.tokenIdx];
            if (tok.kind === "inline-open") {
                if (charStart < tok.firstChar) tok.firstChar = charStart;
                if (charEnd > tok.lastChar) tok.lastChar = charEnd;
            }
        }
    };

    for (const seg of segments) {
        if (!seg) continue;
        if (seg.startsWith("<")) {
            const closeMatch = seg.match(/^<\/([a-zA-Z0-9:-]+)\s*>/);
            if (closeMatch) {
                const tagName = closeMatch[1].toLowerCase();
                if (RUBY_SKIP_TAGS.has(tagName)) {
                    rtDepth = Math.max(0, rtDepth - 1);
                }
                if (BLOCK_TAGS.has(tagName)) {
                    markStackBreak();
                    tokens.push({ kind: "block-close", raw: seg });
                } else {
                    const closeIdx = tokens.length;
                    tokens.push({ kind: "inline-close", raw: seg, name: tagName });
                    let matchPos = -1;
                    for (let k = inlineStack.length - 1; k >= 0; k--) {
                        if (inlineStack[k].name === tagName) {
                            matchPos = k;
                            break;
                        }
                    }
                    if (matchPos >= 0) {
                        const hadUnclosedInner = matchPos < inlineStack.length - 1;
                        const matched = inlineStack[matchPos];
                        inlineStack.splice(matchPos);
                        const openTok = tokens[matched.tokenIdx];
                        if (openTok.kind === "inline-open") {
                            openTok.pairIdx = closeIdx;
                            if (hadUnclosedInner) {
                                openTok.hasBreak = true;
                                markStackBreak();
                            }
                        }
                    } else {
                        markStackBreak();
                    }
                }
                continue;
            }

            const openMatch = seg.match(/^<([a-zA-Z0-9:-]+)/);
            if (!openMatch) {
                tokens.push({ kind: "comment", raw: seg });
                continue;
            }
            const tagName = openMatch[1].toLowerCase();
            if (tagName === "br") {
                if (rtDepth === 0) {
                    fullText += "\n";
                }
                markStackBreak();
                tokens.push({ kind: "br", raw: seg });
                continue;
            }
            const isSelfClosing = VOID_TAGS.has(tagName) || /\/>$/.test(seg);
            if (isSelfClosing) {
                if (tagName === "wbr") {
                    tokens.push({ kind: "inline-void", raw: seg });
                } else {
                    markStackBreak();
                    tokens.push({ kind: "void-break", raw: seg });
                }
                continue;
            }
            if (BLOCK_TAGS.has(tagName)) {
                markStackBreak();
                tokens.push({ kind: "block-open", raw: seg });
                continue;
            }
            if (RUBY_SKIP_TAGS.has(tagName)) {
                rtDepth += 1;
            }
            const openIdx = tokens.length;
            tokens.push({
                kind: "inline-open",
                raw: seg,
                name: tagName,
                pairIdx: -1,
                firstChar: Infinity,
                lastChar: -1,
                hasBreak: false,
                containedSentence: -1,
            });
            inlineStack.push({ tokenIdx: openIdx, name: tagName });
            continue;
        }

        if (rtDepth > 0) {
            tokens.push({ kind: "rt-text", raw: seg });
            continue;
        }
        const decoded = decodeHtmlText(seg);
        if (!decoded) continue;
        const charStart = fullText.length;
        fullText += decoded;
        const charEnd = fullText.length;
        recordStackChars(charStart, charEnd);
        tokens.push({ kind: "text", raw: seg, decoded, charStart, charEnd });
    }

    const ranges = splitTextIntoSentenceRanges(fullText, language);
    if (ranges.length === 0) {
        return { html, sentences: [] };
    }

    const sentenceHtmlList = buildPerSentenceHtml(segments, ranges, language);
    const sentences: EpubSentenceItem[] = ranges.map((range, sentenceIndex) => ({
        key: `${paragraphIndex}:${sentenceIndex}`,
        paragraphIndex,
        sentenceIndex,
        text: range.text,
        html: sentenceHtmlList[sentenceIndex] || escapeHtmlBody(range.text),
    }));

    // Classify balanced inline tags that fit cleanly within a single sentence
    for (const tok of tokens) {
        if (tok.kind === "inline-open" && tok.pairIdx >= 0 && !tok.hasBreak && tok.firstChar < tok.lastChar) {
            tok.containedSentence = findContainingSentence(tok.firstChar, tok.lastChar, ranges);
        }
    }

    const out: string[] = [];
    let activeSentenceIdx: number | null = null;
    let insideContainedDepth = 0;
    let rIdx = 0;

    const openSentence = (sIdx: number) => {
        if (activeSentenceIdx === sIdx) return;
        if (activeSentenceIdx !== null) {
            out.push("</span>");
        }
        const key = escapeHtmlAttr(sentences[sIdx].key);
        const parity = sIdx % 2;
        out.push(`<span class="epub-sentence" data-sentence-key="${key}" data-sentence-parity="${parity}">`);
        activeSentenceIdx = sIdx;
    };

    const closeSentence = () => {
        if (activeSentenceIdx !== null) {
            out.push("</span>");
            activeSentenceIdx = null;
        }
    };

    for (const tok of tokens) {
        if (insideContainedDepth > 0) {
            if (tok.kind === "inline-open") insideContainedDepth += 1;
            else if (tok.kind === "inline-close") insideContainedDepth -= 1;
            out.push(tok.raw);
            continue;
        }

        switch (tok.kind) {
            case "block-open":
            case "block-close":
            case "br":
            case "void-break":
                closeSentence();
                out.push(tok.raw);
                break;
            case "inline-open":
                if (tok.containedSentence >= 0) {
                    openSentence(tok.containedSentence);
                    insideContainedDepth = 1;
                    out.push(tok.raw);
                } else {
                    closeSentence();
                    out.push(tok.raw);
                }
                break;
            case "inline-close":
                closeSentence();
                out.push(tok.raw);
                break;
            case "inline-void":
            case "rt-text":
            case "comment":
                out.push(tok.raw);
                break;
            case "text": {
                let cursor = tok.charStart;
                while (rIdx < ranges.length && ranges[rIdx].end <= cursor) {
                    rIdx += 1;
                }
                while (cursor < tok.charEnd) {
                    while (rIdx < ranges.length && ranges[rIdx].end <= cursor) {
                        rIdx += 1;
                    }
                    const active = ranges[rIdx];
                    if (!active || active.start >= tok.charEnd) {
                        closeSentence();
                        out.push(escapeHtmlBody(tok.decoded.slice(cursor - tok.charStart)));
                        break;
                    }
                    if (active.start > cursor) {
                        const gapEnd = Math.min(active.start, tok.charEnd);
                        closeSentence();
                        out.push(escapeHtmlBody(tok.decoded.slice(cursor - tok.charStart, gapEnd - tok.charStart)));
                        cursor = gapEnd;
                    }
                    if (cursor < tok.charEnd) {
                        const sliceEnd = Math.min(active.end, tok.charEnd);
                        const sliceText = tok.decoded.slice(cursor - tok.charStart, sliceEnd - tok.charStart);
                        if (sliceText) {
                            openSentence(rIdx);
                            out.push(escapeHtmlBody(sliceText));
                        }
                        cursor = sliceEnd;
                    }
                }
                break;
            }
        }
    }

    closeSentence();

    return {
        html: out.join(""),
        sentences,
    };
}

/**
 * Formats selected sentence keys in reading order into clean clipboard text:
 * sentences from the same paragraph join naturally (`""` for JA, `" "` for EN),
 * and separate paragraphs join with `"\n"`.
 */
export function formatSelectedSentencesForCopy(
    selectedKeys: readonly string[],
    sentenceByKey: ReadonlyMap<string, EpubSentenceItem>,
    language: "ja" | "en",
): string {
    const seen = new Set<string>();
    const items: EpubSentenceItem[] = [];
    for (const key of selectedKeys) {
        if (seen.has(key)) continue;
        seen.add(key);
        const item = sentenceByKey.get(key);
        if (item && item.text.trim()) items.push(item);
    }
    if (items.length === 0) return "";

    items.sort((a, b) =>
        a.paragraphIndex !== b.paragraphIndex
            ? a.paragraphIndex - b.paragraphIndex
            : a.sentenceIndex - b.sentenceIndex,
    );

    const paragraphs: string[] = [];
    let currentParaIdx = items[0].paragraphIndex;
    let currentGroup: string[] = [];
    const inlineJoiner = language === "ja" ? "" : " ";

    for (const item of items) {
        if (item.paragraphIndex !== currentParaIdx) {
            paragraphs.push(currentGroup.join(inlineJoiner));
            currentGroup = [];
            currentParaIdx = item.paragraphIndex;
        }
        currentGroup.push(item.text.trim());
    }
    if (currentGroup.length > 0) {
        paragraphs.push(currentGroup.join(inlineJoiner));
    }
    return paragraphs.join("\n");
}
