// Setsuna's own Anki note type, used when the profile has no Lapis (a clean
// Anki install). The layout follows what people expect from a mining card: a
// big word on the front; furigana, pitch accent, audio and the screenshot on
// the back, then the sentence and the dictionary entries.
//
// Field names match what Setsuna fills for Lapis, so the same field mapping
// works for both. Bump SETSUNA_TEMPLATE_VERSION when the templates change:
// existing copies of the note type are upgraded in place (see anki.ts).

export const SETSUNA_TEMPLATE_VERSION = 3;
export const SETSUNA_TEMPLATE_NAME = "Setsuna card";
const MARKER = `<!-- setsuna-card:v${SETSUNA_TEMPLATE_VERSION} -->`;

export const isCurrentSetsunaTemplate = (front: string) => front.includes(MARKER);

const FRONT = `${MARKER}
<div class="ss-front">
  <div class="ss-word ss-word-front">{{Expression}}</div>
</div>`;

// Reading, pitch and sentence highlight are drawn by a small script; the raw
// values sit in hidden elements so quotes or HTML in a field can't break it.
const SCRIPT = `<script>
(function () {
  var text = function (id) { var el = document.getElementById(id); return el ? (el.textContent || "").trim() : ""; };
  var KANJI = /[\\u3400-\\u9fff\\uf900-\\ufaff々〆ヶ]/;
  var SMALL = "ゃゅょぁぃぅぇぉゎャュョァィゥェォヮ";

  // Reading: the reading field, else the kana from "冴[さ]える", else a kana-only word.
  var reading = text("ss-src-reading");
  if (!reading) {
    var furi = text("ss-src-furi");
    if (furi) reading = furi.replace(/\\s+/g, "").replace(/[\\u3400-\\u9fff\\uf900-\\ufaff々〆ヶ]+\\[([^\\]]*)\\]/g, "$1");
    if (!furi || /\\[|\\]/.test(reading)) reading = "";
  }
  if (!reading) { var word = text("ss-src-word"); if (word && !KANJI.test(word)) reading = word; }
  if (KANJI.test(reading)) reading = "";

  // Pitch numbers from "アクセント辞典: [2]", "[0][3]" or a bare "2".
  var pitchText = text("ss-src-pitch");
  var nums = [];
  (pitchText.match(/\\[(\\d+)\\]/g) || []).forEach(function (m) { var n = parseInt(m.slice(1), 10); if (nums.indexOf(n) < 0) nums.push(n); });
  if (!nums.length && /^\\s*\\d+\\s*$/.test(pitchText)) nums.push(parseInt(pitchText, 10));

  var box = document.getElementById("ss-reading");
  if (box && reading) {
    var morae = [];
    for (var i = 0; i < reading.length; i++) {
      var ch = reading[i];
      if (morae.length && SMALL.indexOf(ch) >= 0) morae[morae.length - 1] += ch; else morae.push(ch);
    }
    var html = "";
    if (nums.length) {
      var n = nums[0];
      var high = function (i) { return n === 0 ? i > 0 : n === 1 ? i === 0 : i >= 1 && i < n; };
      for (var j = 0; j < morae.length; j++) {
        var cls = "ss-mora";
        if (high(j)) cls += " is-high";
        if (j > 0 && high(j) && !high(j - 1)) cls += " is-rise";
        if (n > 0 && j === n - 1) cls += " is-drop";
        html += '<span class="' + cls + '">' + morae[j] + "</span>";
      }
      html += nums.map(function (x) { return '<span class="ss-pitch-num">' + x + "</span>"; }).join("");
    } else {
      html = morae.join("");
    }
    box.innerHTML = html;
    box.style.display = "";
  }

  // Highlight the word in the sentence (plain sentences only; ruby is left alone).
  var sentence = document.getElementById("ss-sentence");
  var target = text("ss-src-word");
  if (sentence && target && !sentence.querySelector("ruby, b, strong, mark")) {
    var plain = sentence.textContent || "";
    var stems = [target, reading];
    if (target.length > 1) stems.push(target.slice(0, -1));
    if (reading && reading.length > 2) stems.push(reading.slice(0, -1));
    var found = "";
    for (var s = 0; s < stems.length; s++) { if (stems[s] && plain.indexOf(stems[s]) >= 0) { found = stems[s]; break; } }
    if (found) {
      var esc = function (v) { return v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); };
      var at = plain.indexOf(found);
      sentence.innerHTML = esc(plain.slice(0, at)) + '<span class="ss-hl">' + esc(found) + "</span>" + esc(plain.slice(at + found.length));
    }
  }
})();
</script>`;

const BACK = `${MARKER}
<div id="answer"></div>
<div class="ss-src" hidden>
  <span id="ss-src-word">{{text:Expression}}</span>
  <span id="ss-src-furi">{{text:ExpressionFurigana}}</span>
  <span id="ss-src-reading">{{text:ExpressionReading}}</span>
  <span id="ss-src-pitch">{{text:PitchPosition}}</span>
</div>
<div class="ss-head{{#DefinitionPicture}} has-picture{{/DefinitionPicture}}">
  <div class="ss-wordbox">
    <div class="ss-word">{{#ExpressionFurigana}}{{furigana:ExpressionFurigana}}{{/ExpressionFurigana}}{{^ExpressionFurigana}}{{Expression}}{{/ExpressionFurigana}}</div>
    <div class="ss-reading" id="ss-reading" style="display:none"></div>
    {{#ExpressionAudio}}<div class="ss-audio">{{ExpressionAudio}}</div>{{/ExpressionAudio}}
  </div>
  {{#DefinitionPicture}}<div class="ss-picture">{{DefinitionPicture}}</div>{{/DefinitionPicture}}
</div>
{{#Sentence}}<div class="ss-sentence" id="ss-sentence">{{Sentence}}</div>{{/Sentence}}
{{#MainDefinition}}<div class="ss-definition">{{MainDefinition}}</div>{{/MainDefinition}}
{{#Frequency}}<details class="ss-freq"><summary>Частотность · Frequency</summary><div>{{Frequency}}</div></details>{{/Frequency}}
${SCRIPT}`;

export const SETSUNA_MODEL_CSS = `/* setsuna-card:v${SETSUNA_TEMPLATE_VERSION} */
.card {
  --ss-bg: #f6f6f4; --ss-panel: #ffffff; --ss-text: #1f1f1f; --ss-muted: #77777a;
  --ss-line: #dddddd; --ss-accent: #2f6fd6; --ss-hl: rgba(47,111,214,0.14);
  font-family: "Noto Sans JP", "Yu Gothic UI", "Hiragino Sans", "Meiryo", sans-serif;
  font-size: 20px; line-height: 1.5; text-align: center;
  color: var(--ss-text); background: var(--ss-bg);
  margin: 0; padding: 24px 16px 40px;
}
.card.nightMode, .night_mode .card {
  --ss-bg: #2c2c2c; --ss-panel: #262626; --ss-text: #ececec; --ss-muted: #9a9a9a;
  --ss-line: #3d3d3d; --ss-accent: #8ab8ff; --ss-hl: rgba(138,184,255,0.16);
}
.ss-front { display: flex; align-items: center; justify-content: center; min-height: 40vh; }
.ss-word { font-size: clamp(40px, 9vw, 84px); line-height: 1.35; font-weight: 400; color: var(--ss-text); }
.ss-word-front { font-size: clamp(48px, 12vw, 104px); }
.ss-head { max-width: 980px; margin: 0 auto 22px; display: grid; gap: 16px; align-items: stretch; }
.ss-head.has-picture { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); }
.ss-wordbox { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 6px; padding: 18px 14px; border-radius: 14px; background: var(--ss-panel); }
.ss-head .ss-word { color: var(--ss-accent); }
.ss-word ruby rt { font-size: 0.36em; color: var(--ss-accent); opacity: 0.85; }
.ss-reading { display: inline-flex; align-items: flex-start; gap: 0; font-size: 28px; color: var(--ss-accent); letter-spacing: 0.02em; }
.ss-mora { padding: 4px 1px 0; border-top: 2px solid transparent; }
.ss-mora.is-high { border-top-color: currentColor; }
.ss-mora.is-rise { border-left: 2px solid currentColor; }
.ss-mora.is-drop { border-right: 2px solid currentColor; }
.ss-pitch-num { margin-left: 8px; align-self: center; min-width: 18px; padding: 0 5px; border-radius: 6px; background: var(--ss-text); color: var(--ss-bg); font-size: 14px; line-height: 20px; font-weight: 700; }
.ss-audio { margin-top: 4px; }
.ss-audio .replay-button svg { width: 38px; height: 38px; }
.ss-audio .replay-button svg circle { fill: var(--ss-text); }
.ss-audio .replay-button svg path { fill: var(--ss-bg); }
.ss-picture { display: flex; align-items: center; justify-content: center; border-radius: 14px; overflow: hidden; background: var(--ss-panel); }
.ss-picture img, .ss-picture video { display: block; max-width: 100%; max-height: 300px; object-fit: contain; border-radius: 10px; }
.ss-sentence { max-width: 980px; margin: 0 auto 22px; font-size: clamp(24px, 4.2vw, 38px); line-height: 1.55; }
.ss-hl { color: var(--ss-accent); background: var(--ss-hl); border-radius: 6px; padding: 0 2px; }
.ss-definition { max-width: 980px; margin: 0 auto; padding: 16px 18px; border-left: 4px solid var(--ss-line); border-radius: 4px 12px 12px 4px; background: var(--ss-panel); text-align: left; font-size: 19px; }
.card:not(.nightMode) .ss-definition [style*="color: #ccc"] { color: #333 !important; }
.card:not(.nightMode) .ss-definition [style*="border-left: 2px solid #444"] { border-left-color: #ddd !important; }
.ss-freq { max-width: 980px; margin: 14px auto 0; text-align: left; color: var(--ss-muted); font-size: 14px; }
.ss-freq summary { cursor: pointer; }
.ss-freq div { margin-top: 6px; line-height: 1.6; }
@media (max-width: 640px) {
  .ss-head.has-picture { grid-template-columns: 1fr; }
  .card { padding: 14px 10px 30px; }
}
`;

export const SETSUNA_CARD_TEMPLATES = [
    { Name: SETSUNA_TEMPLATE_NAME, Front: FRONT, Back: BACK },
];
