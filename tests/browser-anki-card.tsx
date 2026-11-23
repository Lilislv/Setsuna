import { SETSUNA_CARD_TEMPLATES, SETSUNA_MODEL_CSS } from '../src/utils/ankiCardTemplate';

// Renders Setsuna's Anki note type the way Anki does (field substitution,
// furigana filter, night mode) to check the card design in a browser.

const picture = `data:image/svg+xml;utf8,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360"><defs><linearGradient id="g" x1="0" x2="1" y1="0" y2="1"><stop offset="0" stop-color="#1d3b2f"/><stop offset="1" stop-color="#0b1712"/></linearGradient></defs><rect width="640" height="360" fill="url(#g)"/><text x="40" y="80" fill="#9fe0b9" font-size="34" font-family="sans-serif">VN screenshot</text></svg>')}`;

const definition = `<div style="margin-bottom: 15px;"><div style="margin-bottom: 6px;"><span style="background-color: #0f06e5; color: #fff; padding: 2px 6px; border-radius: 3px; font-size: 11px; font-weight: bold;">JMdict (Russian)</span></div><div style="padding-left: 10px; border-left: 2px solid #444; color: #ccc;">быть ясным (ярким); быть бодрым, с ясной головой</div></div><div style="margin-bottom: 15px;"><div style="margin-bottom: 6px;"><span style="background-color: #16a34a; color: #fff; padding: 2px 6px; border-radius: 3px; font-size: 11px; font-weight: bold;">JMdict Extra</span></div><div style="padding-left: 10px; border-left: 2px solid #444; color: #ccc;"><ol><li>to be clear (of a sight, sound, colour); to be bright</li><li>to be clear-headed; to be alert; to be wide awake</li><li>to look upbeat; to be perky</li></ol></div></div>`;

const notes: Record<string, string>[] = [
    {
        Expression: '冴える', ExpressionFurigana: '冴[さ]える', ExpressionReading: '',
        MainDefinition: definition,
        Sentence: '普段の起床時間より三十分早かったが、妙に目がさえてしまった。',
        SentenceFurigana: '', Dictionary: 'JMdict (Russian)', ExpressionAudio: '[sound:x.mp3]',
        PitchPosition: '<b>アクセント辞典</b>: [2]',
        Frequency: '<b>VN Freq</b>: 4903<br><b>JPDB</b>: 8964',
        DefinitionPicture: `<img src="${picture}">`,
    },
    {
        Expression: '馳せる', ExpressionFurigana: '馳[は]せる', ExpressionReading: '',
        MainDefinition: definition, Sentence: '過去へ馳せる夢', SentenceFurigana: '', Dictionary: '',
        ExpressionAudio: '', PitchPosition: '[0]', Frequency: '', DefinitionPicture: '',
    },
];

const furigana = (value: string) => value.replace(/ ?([^ >\[]+?)\[([^\]]+)\]/g, '<ruby>$1<rt>$2</rt></ruby>');
const stripHtml = (value: string) => value.replace(/<[^>]*>/g, '');
const sound = (value: string) => value.replace(/\[sound:[^\]]+\]/g, '<a class="replay-button soundLink" href="#"><svg viewBox="0 0 64 64" width="40" height="40"><circle cx="32" cy="32" r="29"/><path d="M56.502,32.301l-37.502,20.101l0.329,-40.804l37.173,20.703Z"/></svg></a>');

const render = (template: string, note: Record<string, string>) => {
    let out = template;
    for (let i = 0; i < 3; i++) {
        out = out.replace(/\{\{#(\w+)\}\}([\s\S]*?)\{\{\/\1\}\}/g, (_, f, body) => (note[f]?.trim() ? body : ''));
        out = out.replace(/\{\{\^(\w+)\}\}([\s\S]*?)\{\{\/\1\}\}/g, (_, f, body) => (note[f]?.trim() ? '' : body));
    }
    return out
        .replace(/\{\{text:(\w+)\}\}/g, (_, f) => stripHtml(note[f] || ''))
        .replace(/\{\{furigana:(\w+)\}\}/g, (_, f) => furigana(note[f] || ''))
        .replace(/\{\{(\w+)\}\}/g, (_, f) => sound(note[f] || ''));
};

const style = document.createElement('style');
style.textContent = `${SETSUNA_MODEL_CSS}\nbody{margin:0;display:grid;grid-template-columns:1fr 1fr;gap:0}iframe{width:100%;height:760px;border:0;border-bottom:4px solid #000}`;
document.head.appendChild(style);

const params = new URLSearchParams(location.search);
const noteIndex = Number(params.get('note') || 0);
const template = SETSUNA_CARD_TEMPLATES[0];

const frame = (side: 'Front' | 'Back', night: boolean) => {
    const iframe = document.createElement('iframe');
    document.body.appendChild(iframe);
    const doc = iframe.contentDocument!;
    const html = render(template[side], notes[noteIndex]);
    doc.open();
    doc.write(`<!doctype html><html class="${night ? 'night_mode' : ''}"><head><meta charset="utf-8"><style>${SETSUNA_MODEL_CSS}</style></head><body class="${night ? 'night_mode' : ''}"><div class="card${night ? ' nightMode' : ''}">${html}</div></body></html>`);
    doc.close();
};

frame('Front', true);
frame('Back', true);
frame('Front', false);
frame('Back', false);
