import React, { useEffect, useState } from "react";
import { invoke } from '@tauri-apps/api/core';
import { useMemo, useRef } from "react";
import { AppSettings } from "./SettingsModal";
import { checkWordsStatusMulti, addNote, browseAnkiCards } from "../utils/anki";
import { captureMobileScreen, hasMobileScreenCapture } from "../utils/mobileFiles";
import { getTranslator } from "../utils/i18n";
import { CaptureSourceBinding, PlayerMiningClip } from "../utils/constants";


export interface DeinflectReason { rule: any; desc: any; in_suffix?: string; out_suffix?: string; }
export interface FrequencyData { dict_name: string; display_value: string; value: number; }
export interface PitchData { dict_name: string; reading: string; position: number; }
export interface PronunciationData { dict_name: string; reading: string; ipa: string; tags: string; }
export interface DictEntry {
    term: string; reading: string; definition?: string; definitions?: string[]; dict_name: string;
    tags: string; deinflection_reasons: DeinflectReason[]; frequencies: FrequencyData[]; pitches: PitchData[]; pronunciations: PronunciationData[]; source_length: number;
}
export interface LookupData {
    rect: DOMRect;
    entries: DictEntry[];
    word: string;
    sentence: string;
    isKanjiLookup?: boolean;
    source?: 'internal' | 'external';
    screenPoint?: { x: number; y: number };
    externalScreenshot?: string | null;
}
export type LookupScreenshotSource =
    | { kind: 'internal' }
    | { kind: 'process'; captureSource: CaptureSourceBinding }
    | { kind: 'region'; dataUrl: string }
    | { kind: 'none' };

export interface LookuperProps {
    stack?: LookupData[]; 
    onAppend?: (data: LookupData) => void; 
    onReplace?: (data: LookupData) => void;
    onReplaceAt?: (index: number, data: LookupData) => void;
    onSlice?: (idx: number) => void; 
    settings?: AppSettings; 
    playerClip?: PlayerMiningClip | null;
    captureSource?: CaptureSourceBinding | null;
    screenshotSource?: LookupScreenshotSource;
    ankiDeck?: string;
    onClose?: () => void;
}

type LookupScanTarget = {
    container: Element;
    scope: string;
    word: string;
    start: number;
    len: number;
};

export const IconAudio = () => <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M11 5L6 9H2v6h4l5 4V5z"></path><path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"></path></svg>;
export const IconAudioOff = () => <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M11 5L6 9H2v6h4l5 4V5z"></path><line x1="23" y1="9" x2="17" y2="15"></line><line x1="17" y1="9" x2="23" y2="15"></line></svg>;
export const IconCamera = () => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"></path><circle cx="12" cy="13" r="4"></circle></svg>;
export const IconEye = () => <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>;

const LOOKUP_FONT_STACK = '"Segoe UI", "Noto Sans JP", "Yu Gothic UI", "Yu Gothic", "Meiryo", "BIZ UDPGothic", Arial, sans-serif';

const normalizeSpacedCyrillic = (value: string) => value
    .split('\n')
    .map((line) => {
        const cyrillicLetters = line.match(/[\u0400-\u04FF]/g)?.length || 0;
        const spacedSingleLetters = line.match(/(?:^|\s)[\u0400-\u04FF](?=\s|[.,;:)\]])/g)?.length || 0;
        if (cyrillicLetters < 6 || spacedSingleLetters < Math.max(3, Math.floor(cyrillicLetters * 0.45))) {
            return line;
        }
        return line
            .replace(/([\u0400-\u04FF])\s+(?=[\u0400-\u04FF])/g, '$1')
            .replace(/([,;:])(?=\S)/g, '$1 ')
            .replace(/\(\s+/g, '(')
            .replace(/\s+\)/g, ')');
    })
    .join('\n');

const EN_PARTS_OF_SPEECH = [
    'auxiliary verb', 'phrasal verb', 'adjective', 'adverb', 'article',
    'conjunction', 'determiner', 'exclamation', 'interjection', 'noun',
    'number', 'particle', 'phrase', 'prefix', 'preposition', 'pronoun',
    'suffix', 'verb'
];

const decodeBasicEntities = (value: string) => value
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&apos;/gi, "'");

const extractLeadingIpaText = (value: string) => {
    const readings: string[] = [];
    let rest = value.trimStart();
    while (rest.startsWith('/')) {
        const end = rest.indexOf('/', 1);
        if (end < 0) break;
        const ipa = rest.slice(1, end).trim();
        if (ipa) readings.push(`/${ipa}/`);
        rest = rest.slice(end + 1).trimStart();
        if (rest.startsWith(',') || rest.startsWith(';')) rest = rest.slice(1).trimStart();
    }
    return { readings, rest: rest.trim() };
};

const splitEnglishLabels = (value: string) => {
    const labels: string[] = [];
    let rest = value.trim();
    const lower = rest.toLowerCase();
    const pos = EN_PARTS_OF_SPEECH.find(p => lower === p || lower.startsWith(`${p} `));
    if (pos) {
        labels.push(pos);
        rest = rest.slice(pos.length).trim();
    }
    while (rest.startsWith('(')) {
        const end = rest.indexOf(')');
        if (end < 0) break;
        const label = rest.slice(1, end).trim();
        if (!label || label.length > 48) break;
        labels.push(label);
        rest = rest.slice(end + 1).trim();
    }
    return { labels, rest };
};

const cleanupLegacyEnglishDefinition = (dictName: string, raw: string) => {
    const trimmed = raw.trim();
    if (!trimmed || /^[\[{]/.test(trimmed)) return raw;

    const likelyLegacyEnglish = /freedict|wikdict|english-русский|eng-rus|en-ru/i.test(dictName)
        || /^\/[^/]+\/(?:\s*[,;]\s*\/[^/]+\/)*/.test(trimmed)
        || /<\/?(?:div|font|ol|li|br)\b/i.test(trimmed);
    if (!likelyLegacyEnglish) return raw;

    let text = decodeBasicEntities(trimmed)
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/(?:div|p|li|ol|ul)>/gi, '\n')
        .replace(/<li\b[^>]*>/gi, '\n- ')
        .replace(/<[^>]+>/g, '')
        .replace(/竊陳|竊陳|/g, ' ');

    const lines = text.split('\n').map(line => line.replace(/\s+/g, ' ').trim()).filter(Boolean);
    if (lines.length === 0) return raw;

    const firstIpa = extractLeadingIpaText(lines[0]);
    const formatted: string[] = [];
    if (firstIpa.readings.length > 0) {
        formatted.push(firstIpa.readings.join(' '));
        lines[0] = firstIpa.rest;
    }

    const first = lines.shift() || '';
    const { labels, rest } = splitEnglishLabels(first);
    labels.forEach(label => formatted.push(`[${label}]`));
    if (rest) formatted.push(rest.replace(/\s-\s/g, '\n=> '));
    lines.forEach(line => formatted.push(line.replace(/\s-\s/g, '\n=> ')));

    return formatted.filter(Boolean).join('\n');
};

export const SCRenderer = ({ node, onLookup }: { node: any; onLookup: (e: React.MouseEvent, word: string, isKanji?: boolean) => void }): any => {
    if (node === null || node === undefined) return null;
    
    if (typeof node === 'string') {
        const parts = normalizeSpacedCyrillic(node).replace(/\\n/g, '\n').split('\n');
        if (parts.length === 1) return parts[0];
        return ( <>{parts.map((part, i) => <React.Fragment key={i}>{part}{i < parts.length - 1 && <br />}</React.Fragment>)}</> );
    }

    if (typeof node === 'number') return String(node);
    if (Array.isArray(node)) return <>{node.map((n, i) => <SCRenderer key={i} node={n} onLookup={onLookup} />)}</>;

    if (typeof node === 'object') {
        if (node.type === 'structured-content') return <SCRenderer node={node.content} onLookup={onLookup} />;
        if (node.type === 'text') return <SCRenderer node={node.text} onLookup={onLookup} />;

        const Tag: any = node.tag || 'span';
        const style: React.CSSProperties = { ...node.style };
        style.letterSpacing = 0;
        style.fontKerning = 'normal';

        const dataProps: any = {};
        if (node.data) { Object.entries(node.data).forEach(([key, val]) => { dataProps[`data-${key}`] = val; }); }

        let content = null;
        if (node.content !== undefined) content = <SCRenderer node={node.content} onLookup={onLookup} />;
        else if (node.text !== undefined) content = <SCRenderer node={node.text} onLookup={onLookup} />;

        if (Tag === 'a') {
            const href = node.href || '';
            const query = href.replace('?query=', '');
            return (
                <a
                    style={{ ...style, color: 'var(--accent-blue)', textDecoration: 'none', cursor: 'pointer', borderBottom: '1px solid rgba(79, 166, 255, 0.4)', display: 'inline-block', marginRight: '12px', marginBottom: '4px', lineHeight: '1.4' }}
                    onClick={(e) => { e.preventDefault(); e.stopPropagation(); const targetWord = query || (typeof node.content === 'string' ? node.content : ''); if (targetWord) onLookup(e, decodeURIComponent(targetWord)); }}
                    {...dataProps}
                >
                    {content}
                </a>
            );
        }

        const safeTags = ['span', 'div', 'p', 'ul', 'ol', 'li', 'table', 'tr', 'td', 'th', 'b', 'i', 'u', 'strong', 'em', 'ruby', 'rt', 'rp', 'br', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'dl', 'dt', 'dd', 'details', 'summary', 'code', 'blockquote'];
        if (safeTags.includes(Tag as string)) {
            if (Tag === 'br') return <br />;
            if (Tag === 'ul' || Tag === 'ol') { style.paddingLeft = style.paddingLeft || '24px'; style.margin = style.margin || '6px 0'; }
            if (Tag === 'li') { style.display = 'list-item'; style.marginBottom = '4px'; }
            if (['div', 'p', 'table', 'dl'].includes(Tag as string)) { style.display = style.display || 'block'; style.marginBottom = style.marginBottom || '4px'; }
            if (Tag === 'details') { style.display = 'block'; style.marginBottom = style.marginBottom || '6px'; }
            if (Tag === 'summary') { style.cursor = 'pointer'; style.color = style.color || 'var(--text-muted)'; }
            if (Tag === 'blockquote') { style.margin = style.margin || '6px 0 6px 12px'; style.paddingLeft = style.paddingLeft || '10px'; style.borderLeft = style.borderLeft || '2px solid var(--border-main)'; }
            // @ts-ignore
            return <Tag style={style} {...dataProps}>{content}</Tag>;
        }
        return <span style={style} {...dataProps}>{content}</span>;
    }
    return null;
};

export const isKanaChar = (char: string) => /[\u3040-\u309F\u30A0-\u30FF]/.test(char);
export const isKanjiChar = (char: string) => /[\u3400-\u4DBF\u4E00-\u9FAF々]/.test(char);
export const kataToHira = (text: string) => Array.from(text).map((char) => {
    const code = char.charCodeAt(0);
    if (code >= 0x30A1 && code <= 0x30F6) return String.fromCharCode(code - 0x60);
    return char;
}).join('');

export const splitOkurigana = (term: string, reading: string) => {
    if (!term || !reading || term === reading) {
        return [{ text: term, reading: null as string | null }];
    }

    const termChars = Array.from(term);
    const hasKanji = termChars.some(isKanjiChar);
    const hasLatinOrDigit = /[A-Za-z0-9Ａ-Ｚａ-ｚ０-９]/.test(term);
    if (hasKanji && hasLatinOrDigit) {
        return [{ text: term, reading: kataToHira(reading) }];
    }

    const chunks: { text: string; reading: string | null }[] = [];
    const normalizedReading = kataToHira(reading);
    let termIndex = 0;
    let readingIndex = 0;

    while (termIndex < termChars.length) {
        const current = termChars[termIndex];

        if (!isKanjiChar(current)) {
            let literal = "";

            while (termIndex < termChars.length && !isKanjiChar(termChars[termIndex])) {
                const char = termChars[termIndex];
                literal += char;

                if (
                    readingIndex < normalizedReading.length &&
                    kataToHira(char) === normalizedReading[readingIndex]
                ) {
                    readingIndex += 1;
                }

                termIndex += 1;
            }

            chunks.push({ text: literal, reading: null });
            continue;
        }

        let kanjiBlock = "";
        while (termIndex < termChars.length && isKanjiChar(termChars[termIndex])) {
            kanjiBlock += termChars[termIndex];
            termIndex += 1;
        }

        let nextLiteral = "";
        let probe = termIndex;
        while (probe < termChars.length && !isKanjiChar(termChars[probe])) {
            nextLiteral += termChars[probe];
            probe += 1;
        }

        const normalizedNextLiteral = kataToHira(nextLiteral);
        let blockReading = "";

        if (normalizedNextLiteral) {
            const isTrailingLiteral = probe >= termChars.length;
            const searchFrom = Math.min(
                normalizedReading.length,
                readingIndex + (isTrailingLiteral ? 0 : 1)
            );
            const nextPos = isTrailingLiteral
                ? normalizedReading.lastIndexOf(normalizedNextLiteral)
                : normalizedReading.indexOf(normalizedNextLiteral, searchFrom);
            if (nextPos >= readingIndex) {
                blockReading = normalizedReading.slice(readingIndex, nextPos);
                readingIndex = nextPos;
            } else {
                blockReading = normalizedReading.slice(readingIndex);
                readingIndex = normalizedReading.length;
            }
        } else {
            blockReading = normalizedReading.slice(readingIndex);
            readingIndex = normalizedReading.length;
        }

        chunks.push({ text: kanjiBlock, reading: blockReading || null });
    }

    return chunks.filter((chunk) => chunk.text.length > 0);
};

export const getMoras = (text: string) => {
    const moras: string[] = [];
    for (const char of text) {
        if (/[ゃゅょャュョぁぃぅぇぉァィゥェォ]/.test(char)) {
            if (moras.length > 0) moras[moras.length - 1] += char;
            else moras.push(char);
        } else { moras.push(char); }
    }
    return moras;
};

export const PitchGraph = ({ reading, position }: { reading: string, position: number }) => {
    if (!reading) return null;
    const moras = getMoras(reading);
    if (moras.length === 0) return null;
    
    const stepX = 22; const highY = 5; const lowY = 18;
    const svgWidth = (moras.length + 1) * stepX + 10;

    const points = moras.map((_, i) => {
        let isHigh = false;
        if (position === 0) isHigh = i > 0;
        else if (position === 1) isHigh = i === 0;
        else isHigh = i > 0 && i < position;
        return { x: i * stepX + 11, y: isHigh ? highY : lowY, isHigh };
    });

    const joshiHigh = position === 0;
    const joshiPoint = { x: moras.length * stepX + 11, y: joshiHigh ? highY : lowY, isHigh: joshiHigh };

    let pathD = `M ${points[0].x} ${points[0].y}`;
    for (let i = 1; i < points.length; i++) pathD += ` L ${points[i].x} ${points[i].y}`;
    pathD += ` L ${joshiPoint.x} ${joshiPoint.y}`;

    return (
        <div style={{ display: 'inline-flex', flexDirection: 'column', alignItems: 'flex-start', margin: '0 10px', verticalAlign: 'middle', fontFamily: 'sans-serif' }}>
            <svg width={svgWidth} height="24" viewBox={`0 0 ${svgWidth} 24`} xmlns="http://www.w3.org/2000/svg" style={{ overflow: 'visible' }}>
                <path d={pathD} stroke="var(--accent-blue)" strokeWidth="2" fill="none" />
                {points.map((p, i) => <circle key={i} cx={p.x} cy={p.y} r="3" fill={p.isHigh ? 'var(--accent-blue)' : 'var(--bg-main)'} stroke="var(--accent-blue)" strokeWidth="2" />)}
                <circle cx={joshiPoint.x} cy={joshiPoint.y} r="3" fill="var(--bg-main)" stroke="var(--accent-blue)" strokeWidth="2" strokeDasharray="2 2" />
            </svg>
            <div style={{ display: 'flex', color: 'var(--text-muted)', fontSize: '13px', marginTop: '2px' }}>
                {moras.map((m, i) => <div key={i} style={{ width: stepX, textAlign: 'center' }}>{m}</div>)}
            </div>
        </div>
    );
};

export const isDictActive = (dictName: string, settings: any) => {
    if (!settings?.dictionaries || settings.dictionaries.length === 0) return true;
    const found = settings.dictionaries.find((d: any) => d.name === dictName);
    if (found) return found.active;
    return true; 
};

export const getDictOrder = (dictName: string, settings: any) => {
    if (!settings?.dictionaries) return 999;
    const idx = settings.dictionaries.findIndex((d: any) => d.name === dictName);
    return idx === -1 ? 999 : idx;
};

const isCambridgeCandidate = (word: string) => /^[A-Za-z][A-Za-z'’-]*(?: [A-Za-z][A-Za-z'’-]*)?$/.test(word.trim());

const normalizeCambridgeWord = (word: string) => word.trim().replace(/’/g, "'").toLowerCase();

const extractEnglishWordAtCursor = (sentence: string, cursor: number) => {
    const isChar = (ch: string) => /[A-Za-z'’-]/.test(ch);
    let probe = Math.max(0, Math.min(cursor, sentence.length - 1));
    if (!isChar(sentence.charAt(probe)) && probe > 0 && isChar(sentence.charAt(probe - 1))) {
        probe -= 1;
    }
    if (!isChar(sentence.charAt(probe))) return null;

    let start = probe;
    while (start > 0 && isChar(sentence.charAt(start - 1))) start -= 1;
    let end = probe + 1;
    while (end < sentence.length && isChar(sentence.charAt(end))) end += 1;

    while (start < end && /['’ー-]/.test(sentence.charAt(start))) start += 1;
    while (end > start && /['’ー-]/.test(sentence.charAt(end - 1))) end -= 1;

    const word = sentence.slice(start, end);
    if (!isCambridgeCandidate(word)) return null;
    return { word, start, len: end - start };
};

export const groupDictionaryEntries = (entries: any[], settings: any, isKanjiLookup: boolean = false) => {
    const groupedMap = new Map<string, any>();
    
    (entries || []).forEach(ent => {
        const key = `${ent.term || ""}|${ent.reading || ""}`;
        if (!groupedMap.has(key)) {
            groupedMap.set(key, { 
                term: ent.term || "", reading: ent.reading || "", reasons: ent.deinflection_reasons || [], 
                dictionaries: {}, frequencies: [], pitches: [], pronunciations: [], source_length: ent.source_length || 0
            });
        }
        const existing = groupedMap.get(key);
        
        if (ent.frequencies) {
            ent.frequencies.forEach((f: any) => {
                if (isDictActive(f.dict_name, settings) && !existing.frequencies.some((xf:any) => xf.dict_name === f.dict_name && xf.display_value === f.display_value)) {
                    existing.frequencies.push(f);
                }
            });
        }
        if (ent.pitches) {
            ent.pitches.forEach((p: any) => {
                if (isDictActive(p.dict_name, settings) && !existing.pitches.some((xp:any) => xp.dict_name === p.dict_name && xp.reading === p.reading && xp.position === p.position)) {
                    existing.pitches.push(p);
                }
            });
        }
        if (ent.pronunciations) {
            ent.pronunciations.forEach((p: PronunciationData) => {
                if (isDictActive(p.dict_name, settings) && !existing.pronunciations.some((xp: PronunciationData) => xp.dict_name === p.dict_name && xp.reading === p.reading && xp.ipa === p.ipa && xp.tags === p.tags)) {
                    existing.pronunciations.push(p);
                }
            });
        }

        if (!isDictActive(ent.dict_name, settings)) return;

        const dictSetting = settings?.dictionaries?.find((d: any) => d.name === ent.dict_name);
        if (dictSetting && dictSetting.allowDeinflect === false && ent.deinflection_reasons && ent.deinflection_reasons.length > 0) return;

        const isKanjidic = ent.dict_name.toUpperCase().includes("KANJI");
        if (!isKanjiLookup && isKanjidic) return;
        if (isKanjiLookup && !isKanjidic) return;

        // Desktop backend returns `definition` (a single JSON/text string); the mobile
        // backend returns `definitions` (an array of plain-text strings). Support both,
        // otherwise every mobile entry is dropped and the popup renders empty.
        const defList: any[] = Array.isArray(ent.definitions)
            ? ent.definitions
            : (ent.definition && typeof ent.definition === 'string' ? [ent.definition] : []);
        if (defList.length > 0) {
            if (!existing.dictionaries[ent.dict_name]) existing.dictionaries[ent.dict_name] = [];
            defList.forEach((def: any) => {
                if (typeof def === 'string' && def.trim() !== "") {
                    existing.dictionaries[ent.dict_name].push({ definition: def, tags: ent.tags || [] });
                }
            });
        }
    });

    const groupedEntries = Array.from(groupedMap.values()).map(group => {
        const cleanDictionaries: Record<string, {content: any, tags: string[]}[]> = {};
        let totalDefs = 0;
        const sortedDictNames = Object.keys(group.dictionaries).sort((a, b) => getDictOrder(a, settings) - getDictOrder(b, settings));

        for (const dictName of sortedDictNames) {
            const defArray = group.dictionaries[dictName];
            const defs: {content: any, tags: string[]}[] = [];
            
            defArray.forEach((item: any) => {
                let parsedContent = item.definition;
                try { parsedContent = JSON.parse(item.definition); } catch {}
                if (typeof parsedContent === 'string') {
                    parsedContent = cleanupLegacyEnglishDefinition(dictName, parsedContent);
                }
                let tagsArr: string[] = [];
                if (Array.isArray(item.tags)) tagsArr = item.tags;
                else if (typeof item.tags === 'string') tagsArr = item.tags.split(' ').filter(Boolean);
                defs.push({ content: parsedContent, tags: tagsArr });
            });

            const uniqueDefsMap = new Map();
            defs.forEach(d => {
                const contentStr = JSON.stringify(d.content);
                if (!uniqueDefsMap.has(contentStr)) {
                    uniqueDefsMap.set(contentStr, { ...d, tags: [...d.tags] });
                } else {
                    const existing = uniqueDefsMap.get(contentStr);
                    d.tags.forEach((t: string) => { if (!existing.tags.includes(t)) existing.tags.push(t); });
                }
            });

            cleanDictionaries[dictName] = Array.from(uniqueDefsMap.values());
            totalDefs += uniqueDefsMap.size;
        }
        
        let bestFreq: number | null = null;
        (group.frequencies || []).forEach((f: FrequencyData) => { if (bestFreq === null || f.value < bestFreq) bestFreq = f.value; });

        return { ...group, cleanDictionaries, totalDefs, bestFreq, uniquePitches: group.pitches };
    }).filter(g => Object.keys(g.cleanDictionaries).length > 0 || g.frequencies.length > 0 || g.uniquePitches.length > 0 || g.pronunciations.length > 0);

    groupedEntries.sort((a, b) => {
        if (a.source_length !== b.source_length) return b.source_length - a.source_length;
        const aFirstDict = Object.keys(a.cleanDictionaries)[0] || "";
        const bFirstDict = Object.keys(b.cleanDictionaries)[0] || "";
        const orderDiff = getDictOrder(aFirstDict, settings) - getDictOrder(bFirstDict, settings);
        if (orderDiff !== 0) return orderDiff;
        if (a.bestFreq !== null && b.bestFreq !== null) return a.bestFreq - b.bestFreq;
        if (a.bestFreq !== null) return -1;
        if (b.bestFreq !== null) return 1;
        return b.totalDefs - a.totalDefs;
    });

    return groupedEntries;
};

export const LookupEntryItem = ({ group, settings, sentence, onWordLookup, activeGrammarDesc, setActiveGrammarDesc, playAudio, audioFailed, playingAudio, isKanjidic, ankiStatus, onStatusChange, captureSource, playerClip, lookupData, screenshotSource }: any) => {
    const [isAdding, setIsAdding] = useState(false);

    const fSize = Math.max(settings?.lookupFontSize || 17, 16);
    const tagSize = Math.max(settings?.lookupTagFontSize || 12, 11);

    const lang = settings?.appLanguage || 'ru';
    const t = getTranslator(lang);
    const getLoc = (val: any) => {
        if (!val) return "";
        if (typeof val === 'string') return val;
        if (typeof val === 'object') return val[lang] || val['ru'] || val['en'] || "";
        return "";
    };

    const filteredReasons = group.reasons.filter((r: DeinflectReason, _: number, arr: DeinflectReason[]) => {
        const getRuLoc = (val: any) => typeof val === 'object' ? (val.ru || "") : String(val || "");
        const hasObligation = arr.some((x: DeinflectReason) => getRuLoc(x.rule).includes('Необходимость'));
        if (hasObligation && getRuLoc(r.rule) === 'Отрицание') return false;
        return true;
    });

    const nodeToHtml = (node: any): string => {
        try {
            if (node === null || node === undefined) return '';
            if (typeof node === 'string') return node.replace(/\\n/g, '\n').replace(/\n/g, '<br/>');
            if (typeof node === 'number') return String(node);
            if (Array.isArray(node)) return node.map(nodeToHtml).join('');
            
            if (typeof node === 'object') {
                if (node.type === 'structured-content') return nodeToHtml(node.content);
                if (node.type === 'text') return nodeToHtml(node.text);
                
                const Tag = node.tag || 'span';
                let styleStr = '';
                if (node.style) {
                    styleStr = Object.entries(node.style).map(([k, v]) => `${k.replace(/[A-Z]/g, m => `-${m.toLowerCase()}`)}:${v}`).join(';');
                }
                const styleAttr = styleStr ? ` style="${styleStr}"` : '';
                
                let contentHtml = '';
                if (node.content !== undefined) contentHtml = nodeToHtml(node.content);
                else if (node.text !== undefined) contentHtml = nodeToHtml(node.text);
                
                const safeTags = ['span', 'div', 'p', 'ul', 'ol', 'li', 'table', 'tr', 'td', 'th', 'b', 'i', 'u', 'strong', 'em', 'ruby', 'rt', 'rp', 'br', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'dl', 'dt', 'dd', 'a', 'details', 'summary', 'code', 'blockquote'];
                if (safeTags.includes(Tag as string)) {
                    if (Tag === 'br') return '<br/>';
                    return `<${Tag}${styleAttr}>${contentHtml}</${Tag}>`;
                }
                return `<span${styleAttr}>${contentHtml}</span>`;
            }
        } catch(e) {}
        return '';
    };

    const nodeToText = (node: any): string => {
        if (node === null || node === undefined) return '';
        if (typeof node === 'string' || typeof node === 'number') return String(node).replace(/\\n/g, '\n');
        if (Array.isArray(node)) return node.map(nodeToText).filter(Boolean).join(' ');
        if (typeof node === 'object') return nodeToText(node.content ?? node.text ?? '');
        return '';
    };

    const handleAddToAnki = async (dictName: string, cleanDictionaries: any, withScreenshot: boolean = false) => {
        setIsAdding(true);
        let formattedMeaning = "";
        
        if (cleanDictionaries) {
            formattedMeaning = Object.entries(cleanDictionaries).map(([dName, defs]) => {
                const color = settings?.dictionaries?.find((d: any) => d.name === dName)?.color || '#4fa6ff';
                
                const defsHtml = (defs as any[]).map((d, j) => {
                    const numHtml = (defs as any[]).length > 1 ? `<span style="color:#888;margin-right:6px;font-weight:bold;">${j + 1}.</span>` : '';
                    const tagsHtml = d.tags && d.tags.length > 0 
                        ? `<div style="margin-bottom:4px;">${d.tags.map((t:string)=>`<span style="border:1px solid #555;border-radius:3px;padding:0 4px;font-size:11px;color:#aaa;">${t}</span>`).join(' ')}</div>` 
                        : '';

                    let contentHtml = "";
                    if (Array.isArray(d.content) && d.content.length > 1) {
                        contentHtml = `<div style="display:flex;flex-direction:column;gap:6px;">${d.content.map((n:any)=>`<div><span style="color:#4fa6ff;margin-right:6px;">▪</span>${nodeToHtml(n)}</div>`).join('')}</div>`;
                    } else {
                        contentHtml = nodeToHtml(Array.isArray(d.content) ? d.content[0] : d.content);
                    }

                    return `<div style="margin-bottom: 8px; display: flex; align-items: flex-start;">${numHtml}<div>${tagsHtml}<div style="line-height:1.4;">${contentHtml}</div></div></div>`;
                }).join('');

                return `<div style="margin-bottom: 15px;"><div style="margin-bottom: 6px;"><span style="background-color: ${color}; color: #fff; padding: 2px 6px; border-radius: 3px; font-size: 11px; font-weight: bold;">${dName}</span></div><div style="padding-left: 10px; border-left: 2px solid #444; color: #ccc;">${defsHtml}</div></div>`;
            }).join('');
        }

        let pitchText = "";
        if (group.uniquePitches && group.uniquePitches.length > 0) {
            pitchText = group.uniquePitches.map((p: any) => `<b>${p.dict_name}</b>: [${p.position}]`).join('<br>');
        }

        let freqText = "";
        if (group.frequencies && group.frequencies.length > 0) {
            freqText = group.frequencies.map((f: any) => `<b>${f.dict_name}</b>: ${f.display_value}`).join('<br>');
        }

        const plainReading = group.reading || group.term;
        const audioUrl = `https://assets.languagepod101.com/dictionary/japanese/audiomp3.php?kanji=${encodeURIComponent(group.term)}&kana=${encodeURIComponent(group.reading || group.term)}`;

        let screenshotData = null;

        let activeProcs: any[] = [];
        if (captureSource?.name) {
            activeProcs.push({
                name: captureSource.name,
                path: captureSource.path || "",
                pid: captureSource.pid,
                sourceType: captureSource.sourceType || "local",
                remoteUrl: captureSource.remoteUrl,
                remoteToken: captureSource.remoteToken,
            });
        } else if (Array.isArray(settings?.hookProcesses)) {
            activeProcs.push(...settings.hookProcesses.filter((p: any) => p.active).map((p: any) => ({ name: p.name, path: p.path || "", pid: p.pid })));
        } else if (typeof settings?.hookProcesses === 'string') {
            activeProcs.push(...settings.hookProcesses.split(',').map((p: string) => p.trim()).filter(Boolean));
        }

        // Screenshot capture errors should stop note creation before Anki is called.
        if (withScreenshot) {
            try {
                let b64: string | null = null;
                if (lookupData?.source === 'external') {
                    if (screenshotSource?.kind === 'region') {
                        b64 = screenshotSource.dataUrl || null;
                    } else if (screenshotSource?.kind === 'process' && screenshotSource.captureSource) {
                        const source = screenshotSource.captureSource;
                        const selectedProcess = [{
                            name: source.name,
                            path: source.path || '',
                            pid: source.pid,
                            sourceType: source.sourceType || 'local',
                            remoteUrl: source.remoteUrl,
                            remoteToken: source.remoteToken,
                        }];
                        b64 = source.sourceType === 'remote' && source.remoteUrl && source.remoteToken && source.pid
                            ? await invoke<string | null>('take_remote_capture_screenshot', {
                                  url: source.remoteUrl,
                                  token: source.remoteToken,
                                  pid: source.pid,
                              })
                            : await invoke<string | null>('take_smart_screenshot', { processes: selectedProcess });
                    } else {
                        alert(settings?.appLanguage === 'en'
                            ? 'Choose a screenshot process or select a screen area first.'
                            : 'Сначала выбери процесс для скриншота или выдели область экрана.');
                        setIsAdding(false);
                        return;
                    }
                } else {
                    if (hasMobileScreenCapture()) {
                        document.documentElement.classList.add('setsuna-capture-clean');
                        try {
                            await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
                            b64 = await captureMobileScreen();
                        } finally {
                            document.documentElement.classList.remove('setsuna-capture-clean');
                        }
                    } else {
                        if (activeProcs.length === 0) {
                            alert(t('anki.noProcesses'));
                            setIsAdding(false);
                            return;
                        }
                        const remoteSource = activeProcs.find((proc: any) => proc.sourceType === "remote" && proc.remoteUrl && proc.remoteToken && proc.pid);
                        b64 = remoteSource
                            ? await invoke<string | null>('take_remote_capture_screenshot', {
                                url: remoteSource.remoteUrl,
                                token: remoteSource.remoteToken,
                                pid: remoteSource.pid,
                            })
                            : await invoke<string | null>('take_smart_screenshot', { processes: activeProcs });
                    }
                }
                if (b64) {
                    screenshotData = b64;
                } else {
                    alert(t('anki.processNotFound'));
                    setIsAdding(false);
                    return;
                }
            } catch (e) {
                console.error("Screenshot failed:", e);
                alert(t('anki.screenshotError', { error: String(e) }));
                setIsAdding(false);
                return;
            }
        }

        const freshPlayerClip = settings?.playerMiningUseClipForAnki !== false && playerClip && Date.now() - playerClip.createdAt < 10 * 60 * 1000 ? playerClip : null;
        const sentenceFurigana = sentence;
        const res = await addNote(settings, { 
            word: group.term, reading: plainReading, meaning: formattedMeaning, sentence: sentence, 
            sentenceFurigana,
            dictionary: dictName, pitch: pitchText, frequency: freqText, audioUrl: freshPlayerClip?.path ? undefined : audioUrl,
            audioPath: freshPlayerClip?.path,
            audioFilename: freshPlayerClip?.filename,
            audioMediaType: freshPlayerClip?.mediaType,
            playerSubtitle: freshPlayerClip?.subtitle,
            screenshot: screenshotData
        });
        
        if (!res.error) {
            onStatusChange(group.term, group.reading, 'red');
        } else {
            alert(t('anki.addError', { error: res.error }));
        }
        setIsAdding(false);
    };

    const firstDictName = Object.keys(group.cleanDictionaries)[0] || 'Unknown';
    const colorNew = settings?.ankiColorNew || '#4CAF50';
    const colorOther = settings?.ankiColorOther || 'var(--accent-blue)';
    const colorSame = settings?.ankiColorSame || '#ff4444';
    const allowOther = settings?.ankiAllowDuplicatesOther ?? true;
    const allowSame = settings?.ankiAllowDuplicatesSame ?? false;

    const borderColor = ankiStatus === 'red' ? colorSame : ankiStatus === 'blue' ? colorOther : ankiStatus === 'green' ? colorNew : 'var(--border-main)';
    const isBtnDisabled = isAdding || (ankiStatus === 'red' && !allowSame) || (ankiStatus === 'blue' && !allowOther);
    const tooltipText = ankiStatus === 'red' ? t('anki.inDeck') : ankiStatus === 'blue' ? t('anki.inOtherDeck') : t('anki.add');
    const cardExists = ankiStatus === 'red' || ankiStatus === 'blue';
    const openExistingCard = async () => {
        if (!cardExists || !settings?.ankiFieldWord) return;
        try {
            await browseAnkiCards(
                ankiStatus === 'red' ? (settings.ankiDeck || '') : '',
                settings.ankiFieldWord,
                group.term,
            );
        } catch (error) {
            alert(String(error));
        }
    };

    const renderAnkiButton = () => {
        const hasAnki = Boolean(settings?.ankiDeck && settings?.ankiModel);
        const showNormal = settings?.ankiShowButtonNormal ?? true;
        const showScreen = settings?.ankiShowButtonScreenshot ?? true;

        const baseBtnStyle = {
            flexShrink: 0, background: 'var(--bg-main)', border: 'none',
            color: (isBtnDisabled && hasAnki) ? 'var(--text-muted)' : 'var(--text-main)', 
            padding: '2px 10px', height: '28px',
            cursor: (isBtnDisabled && hasAnki) ? 'default' : 'pointer', fontSize: '18px', 
            fontWeight: 'normal', transition: '0.2s', display: 'flex', 
            alignItems: 'center', justifyContent: 'center', gap: '4px'
        };

        return (
            <div style={{ display: 'flex', marginLeft: '10px', border: '1px solid var(--border-main)', borderLeft: `4px solid ${hasAnki ? borderColor : 'var(--border-main)'}`, borderRadius: '4px', overflow: 'hidden' }}>
                {showNormal && (
                    <button 
                        onClick={() => {
                            if (!hasAnki) { alert(t('anki.configure')); return; }
                            handleAddToAnki(firstDictName, group.cleanDictionaries, false);
                        }} 
                        disabled={isBtnDisabled && hasAnki} title={hasAnki ? tooltipText : t('anki.configure')}
                        style={{ ...baseBtnStyle, borderRight: showScreen ? '1px solid var(--border-main)' : 'none' }}
                    >
                        {isAdding ? '...' : '+'}
                    </button>
                )}
                {showScreen && (
                    <button 
                        onClick={() => {
                            if (!hasAnki) { alert(t('anki.configure')); return; }
                            handleAddToAnki(firstDictName, group.cleanDictionaries, true);
                        }} 
                        disabled={isBtnDisabled && hasAnki} title={hasAnki ? t('anki.addScreenshot') : t('anki.configure')}
                        style={{ ...baseBtnStyle }}
                    >
                        {isAdding ? '...' : <><span style={{fontSize: '16px', marginTop:'-2px'}}>+</span><IconCamera /></>}
                    </button>
                )}
                <button
                    type="button"
                    onClick={openExistingCard}
                    disabled={!cardExists}
                    title={cardExists
                        ? (lang === 'en' ? 'Open card in Anki' : 'Открыть карточку в Anki')
                        : (ankiStatus === 'loading'
                            ? (lang === 'en' ? 'Checking Anki...' : 'Проверяю Anki...')
                            : (lang === 'en' ? 'Card is not in Anki' : 'Карточки нет в Anki'))}
                    aria-label={lang === 'en' ? 'Open card in Anki' : 'Открыть карточку в Anki'}
                    style={{
                        ...baseBtnStyle,
                        borderLeft: '1px solid var(--border-main)',
                        padding: '2px 8px',
                        cursor: cardExists ? 'pointer' : 'default',
                        opacity: cardExists ? 1 : 0.45,
                    }}
                >
                    <IconEye />
                </button>
            </div>
        );
    };

    return (
        <div className="dict-entry-container" style={{ paddingBottom: '10px' }}>
            {!isKanjidic && settings?.lookupShowTags !== false && filteredReasons && filteredReasons.length > 0 && (
                <div style={{ marginBottom: '12px' }}>
                    <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                        {filteredReasons.map((r: DeinflectReason, rIdx: number) => {
                            const reasonStr = getLoc(r.rule);
                            const descStr = getLoc(r.desc);
                            return (
                                <span key={rIdx} onClick={() => setActiveGrammarDesc(activeGrammarDesc === descStr ? null : descStr)} style={{ backgroundColor: 'var(--bg-side)', color: 'var(--text-main)', padding: '3px 8px', borderRadius: '4px', fontSize: `${tagSize}px`, fontWeight: 'bold', border: '1px solid var(--border-main)', cursor: 'pointer', transition: '0.2s' }}>« {reasonStr}</span>
                            );
                        })}
                    </div>
                    {activeGrammarDesc && <div style={{ marginTop: '6px', padding: '8px 10px', backgroundColor: 'var(--hover-bg)', color: 'var(--text-main)', fontSize: `${fSize * 0.85}px`, borderRadius: '4px', borderLeft: '3px solid var(--accent-blue)', lineHeight: '1.5', whiteSpace: 'pre-wrap' }}>{activeGrammarDesc}</div>}
                </div>
            )}

            {isKanjidic ? (
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: '20px', padding: '5px 0' }}>
                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '10px', minWidth: '70px' }}>
                        <div style={{ fontSize: `${fSize * 4}px`, lineHeight: '1', color: 'var(--text-main)', fontWeight: 'normal', textShadow: '0 2px 4px rgba(0,0,0,0.2)' }}>{group.term}</div>
                        {settings?.lookupShowTags !== false && group.cleanDictionaries[firstDictName]?.[0]?.tags?.length > 0 && (
                            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px', justifyContent: 'center' }}>
                                {group.cleanDictionaries[firstDictName][0].tags.map((t: string, tidx: number) => <span key={tidx} style={{ backgroundColor: 'var(--bg-side)', color: 'var(--text-muted)', padding: '2px 6px', borderRadius: '4px', fontSize: `${tagSize}px`, border: '1px solid var(--border-main)' }}>{t}</span>)}
                            </div>
                        )}
                    </div>
                    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '12px' }}>
                        <div style={{ display: 'flex', justifyContent: 'flex-end', width: '100%' }}>
                            <span style={{ backgroundColor: settings?.dictionaries?.find((d:any)=>d.name===firstDictName)?.color || 'var(--accent-blue)', color: '#fff', padding: '2px 6px', borderRadius: '3px', fontSize: `${tagSize}px`, fontWeight: 'bold', display: 'flex', alignItems: 'center' }}>{firstDictName}</span>
                            {renderAnkiButton()}
                        </div>
                        <div style={{ display: 'grid', gridTemplateColumns: '70px 1fr', gap: '10px', fontSize: `${fSize}px` }}>
                            <div style={{ color: 'var(--text-muted)' }}>{t("lookup.meaning")}</div>
                            <div style={{ color: 'var(--text-main)', lineHeight: '1.4', wordBreak: 'break-word' }}>
                                {(group.cleanDictionaries[firstDictName] || []).map((d: any, idx: number) => (
                                    <React.Fragment key={idx}>
                                        {Array.isArray(d.content) ? (
                                            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                                                {d.content.map((n: any, j: number) => (
                                                    <div key={j}>
                                                        {d.content.length > 1 && <span style={{color: 'var(--accent-blue)', marginRight: '6px'}}>▪</span>}
                                                        <SCRenderer node={n} onLookup={onWordLookup} />
                                                    </div>
                                                ))}
                                            </div>
                                        ) : <SCRenderer node={d.content} onLookup={onWordLookup} />}
                                    </React.Fragment>
                                ))}
                            </div>
                            <div style={{ color: 'var(--text-muted)' }}>{t("lookup.readings")}</div>
                            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                                {(() => {
                                    const readings = (group.reading || "").split(' ').filter(Boolean);
                                    const onyomi = readings.filter((r: string) => r.match(/[ア-ン]/));
                                    const kunyomi = readings.filter((r: string) => !r.match(/[ア-ン]/));
                                    return (
                                        <>
                                            {onyomi.length > 0 && <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '8px' }}><span style={{ backgroundColor: 'var(--bg-side)', color: 'var(--text-muted)', border: '1px solid var(--border-main)', padding: '2px 4px', borderRadius: '3px', fontSize: `${tagSize - 1}px` }}>音</span>{onyomi.map((r: string, rIdx: number) => <span key={rIdx} style={{ color: '#ffb74d' }}>{r}</span>)}</div>}
                                            {kunyomi.length > 0 && <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '8px' }}><span style={{ backgroundColor: 'var(--bg-side)', color: 'var(--text-muted)', border: '1px solid var(--border-main)', padding: '2px 4px', borderRadius: '3px', fontSize: `${tagSize - 1}px` }}>訓</span>{kunyomi.map((r: string, rIdx: number) => <span key={rIdx} style={{ color: '#81c784' }}>{r}</span>)}</div>}
                                        </>
                                    );
                                })()}
                            </div>
                        </div>
                    </div>
                </div>
            ) : (
                <div className="dict-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'nowrap', marginBottom: '10px' }}>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', flex: 1, minWidth: 0 }}>
                        <div style={{ display: 'flex', alignItems: 'baseline', flexWrap: 'wrap', gap: '6px' }}>
                            <span style={{ fontSize: `${fSize * 2.0}px`, lineHeight: '1.45', fontWeight: 700, color: 'var(--text-main)', fontFamily: '"BIZ UDPGothic", "BIZ UDGothic", "Meiryo", "Noto Sans JP", "Yu Gothic UI", sans-serif', letterSpacing: 0 }}>
                                {splitOkurigana(group.term, group.reading).map((chunk, i) => {
                                    if (!chunk.reading) {
                                        return <span key={i}>{Array.from(chunk.text).map((c: any, j) => {
                                            const isKanji = /[\u4e00-\u9faf]/.test(c);
                                            return isKanji ? <span key={j} onClick={(e) => onWordLookup(e, c, true)} style={{ cursor: 'pointer', borderBottom: '1px dashed var(--text-muted)', paddingBottom: '1px' }}>{c}</span> : <span key={j}>{c}</span>;
                                        })}</span>;
                                    }
                                    return (
                                        <ruby key={i} style={{ rubyPosition: 'over', WebkitRubyPosition: 'over', marginRight: 0 }}>
                                            {Array.from(chunk.text).map((c: any, j) => {
                                                const isKanji = /[\u4e00-\u9faf]/.test(c);
                                                return isKanji ? <span key={j} onClick={(e) => onWordLookup(e, c, true)} style={{ cursor: 'pointer', borderBottom: '1px dashed var(--text-muted)', paddingBottom: '1px' }}>{c}</span> : <span key={j}>{c}</span>;
                                            })}
                                            <rt style={{ fontSize: `${Math.max(10, fSize * 0.48)}px`, color: 'var(--text-muted)', fontWeight: 600, userSelect: 'none', letterSpacing: 0, lineHeight: 1, textAlign: 'center', fontFamily: '"BIZ UDPGothic", "BIZ UDGothic", "Meiryo", "Noto Sans JP", "Yu Gothic UI", sans-serif' }}>{chunk.reading}</rt>
                                        </ruby>
                                    );
                                })}
                            </span>
                        </div>

                        {settings?.lookupShowTags !== false && group.uniquePitches && group.uniquePitches.length > 0 && (
                            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '10px', marginTop: '4px' }}>
                                {group.uniquePitches.map((pitch: any, pIdx: number) => <PitchGraph key={pIdx} reading={pitch.reading} position={pitch.position} />)}
                            </div>
                        )}

                        {settings?.lookupShowTags !== false && group.frequencies && group.frequencies.length > 0 && (
                            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px', marginTop: '4px' }}>
                                {group.frequencies.map((freq: FrequencyData, fIdx: number) => (
                                    <span key={fIdx} style={{ backgroundColor: 'rgba(76, 175, 80, 0.1)', color: '#4CAF50', padding: '2px 6px', borderRadius: '3px', fontSize: `${tagSize}px`, border: '1px solid rgba(76, 175, 80, 0.2)' }}>{freq.dict_name}: {freq.display_value}</span>
                                ))}
                            </div>
                        )}

                        {group.pronunciations && group.pronunciations.length > 0 && (
                            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px', marginTop: '4px' }}>
                                {group.pronunciations.map((pronunciation: PronunciationData, pIdx: number) => (
                                    <span key={pIdx} style={{ backgroundColor: 'rgba(79, 166, 255, 0.1)', color: 'var(--accent-blue)', padding: '2px 6px', borderRadius: '3px', fontSize: `${tagSize}px`, border: '1px solid rgba(79, 166, 255, 0.25)' }} title={pronunciation.dict_name}>
                                        {pronunciation.tags ? `${pronunciation.tags} ` : ''}{pronunciation.ipa}
                                    </span>
                                ))}
                            </div>
                        )}
                    </div>
                    
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexShrink: 0 }}>
                        {settings?.lookupShowAudio !== false && (
                            <button 
                                onClick={(e) => playAudio(group.term, group.reading, e)} title={audioFailed[`${group.term}-${group.reading}`] ? t("lookup.audioUnavailable") : t("lookup.playAudio")}
                                style={{ 
                                    background: 'transparent', border: 'none', cursor: audioFailed[`${group.term}-${group.reading}`] ? 'default' : 'pointer', 
                                    padding: '4px', opacity: playingAudio === `${group.term}-${group.reading}` ? 1 : 0.6,
                                    transform: playingAudio === `${group.term}-${group.reading}` ? 'scale(1.1)' : 'scale(1)',
                                    transition: 'all 0.2s', color: audioFailed[`${group.term}-${group.reading}`] ? '#ff4444' : 'var(--text-main)',
                                    display: 'flex', alignItems: 'center', justifyContent: 'center'
                                }}
                                onMouseOver={(e) => { if (!audioFailed[`${group.term}-${group.reading}`]) e.currentTarget.style.opacity = '1'; }}
                                onMouseOut={(e) => { if (playingAudio !== `${group.term}-${group.reading}`) e.currentTarget.style.opacity = '0.6'; }}
                            >
                                {audioFailed[`${group.term}-${group.reading}`] ? <IconAudioOff /> : <IconAudio />}
                            </button>
                        )}
                        {renderAnkiButton()}
                    </div>
                </div>
            )}
            
            {!isKanjidic && Object.entries(group.cleanDictionaries).map(([dictName, defs], dictIdx) => {
                const definitions = defs as {content: any, tags: string[]}[];
                const dictColor = settings?.dictionaries?.find((d: any) => d.name === dictName)?.color || 'var(--accent-blue)';
                return (
                    <div key={dictIdx} className="dict-meaning" style={{ marginTop: dictIdx > 0 ? '12px' : '0', paddingTop: dictIdx > 0 ? '12px' : '0', borderTop: dictIdx > 0 ? '1px solid var(--border-main)' : 'none', fontSize: `${fSize}px`, fontFamily: LOOKUP_FONT_STACK, letterSpacing: 0 }}>
                        <div style={{ marginBottom: '8px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                            <span style={{ backgroundColor: dictColor, color: '#fff', padding: '2px 6px', borderRadius: '3px', fontSize: `${tagSize}px`, fontWeight: 'bold', display: 'inline-block' }}>{dictName}</span>
                        </div>
                        {definitions.map((def, j) => (
                            <div key={j} className="dict-def-item" style={{ marginBottom: j < definitions.length - 1 ? '10px' : '0', display: 'flex', alignItems: 'flex-start' }}>
                                {definitions.length > 1 && <span className="dict-def-index" style={{ marginRight: '6px', color: 'var(--text-muted)', fontSize: `${fSize * 0.9}px`, marginTop: '2px' }}>{j + 1}.</span>}
                                <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', width: '100%' }}>
                                    {settings?.lookupShowTags !== false && def.tags && def.tags.length > 0 && (
                                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px' }}>
                                            {def.tags.map((t: string, tidx: number) => <span key={tidx} style={{ color: 'var(--text-muted)', fontSize: `${tagSize}px`, border: '1px solid var(--border-main)', borderRadius: '3px', padding: '0px 4px' }}>{t}</span>)}
                                        </div>
                                    )}
                                    <div style={{ lineHeight: '1.55', wordBreak: 'break-word', color: 'var(--text-main)' }}>
                                        {Array.isArray(def.content) ? (
                                            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                                                {def.content.map((n: any, idx: number) => (
                                                    <div key={idx}>
                                                        {def.content.length > 1 && <span style={{color: 'var(--accent-blue)', marginRight: '6px'}}>▪</span>}
                                                        <SCRenderer node={n} onLookup={onWordLookup} />
                                                    </div>
                                                ))}
                                            </div>
                                        ) : <SCRenderer node={def.content} onLookup={onWordLookup} />}
                                    </div>
                                </div>
                            </div>
                        ))}
                    </div>
                );
            })}
        </div>
    );
};

export default function Lookuper({ stack = [], onAppend, onReplace, onReplaceAt, onSlice, settings: baseSettings, captureSource, playerClip, screenshotSource = { kind: 'internal' }, ankiDeck, onClose }: LookuperProps) {
  const settings = useMemo(
      () => baseSettings ? { ...baseSettings, ankiDeck: ankiDeck || baseSettings.ankiDeck } : baseSettings,
      [baseSettings, ankiDeck],
  );
  const [activeGrammarDesc, setActiveGrammarDesc] = useState<string | null>(null);
  const [playingAudio, setPlayingAudio] = useState<string | null>(null);
  const [audioFailed, setAudioFailed] = useState<Record<string, boolean>>({});
  const [ankiStatuses, setAnkiStatuses] = useState<Record<string, 'green' | 'red' | 'blue' | 'loading'>>({});
  const previousPopupKeysRef = useRef<string[]>([]);
  const cambridgeCacheRef = useRef<Map<string, { expiresAt: number; entries: DictEntry[] }>>(new Map());
  const cambridgePendingRef = useRef<Map<string, Promise<DictEntry[]>>>(new Map());
  const lastShownScanTargetRef = useRef<LookupScanTarget | null>(null);
  const lastEnglishRequestTargetRef = useRef<LookupScanTarget | null>(null);

  const fetchCambridgeEntries = async (word: string): Promise<DictEntry[]> => {
      if (!settings?.cambridgeApiEnabled || !settings.cambridgeApiKey?.trim()) return [];
      if (!isCambridgeCandidate(word)) return [];

      const dictionaryCode = settings.cambridgeApiDictionary || "english-russian";
      const baseUrl = settings.cambridgeApiBaseUrl || "https://dictionary.cambridge.org/api/v1";
      const normalizedWord = normalizeCambridgeWord(word);
      const cacheKey = `${baseUrl}|${dictionaryCode}|${normalizedWord}`;
      const now = Date.now();
      const cached = cambridgeCacheRef.current.get(cacheKey);
      if (cached && cached.expiresAt > now) return cached.entries;

      const pending = cambridgePendingRef.current.get(cacheKey);
      if (pending) return pending;

      const request = invoke<DictEntry[]>("lookup_cambridge_api", {
          word: normalizedWord,
          config: {
              enabled: true,
              apiKey: settings.cambridgeApiKey,
              dictionaryCode,
              baseUrl,
          },
      }).then((entries) => {
          const safeEntries = entries || [];
          cambridgeCacheRef.current.set(cacheKey, {
              expiresAt: Date.now() + 12 * 60 * 60 * 1000,
              entries: safeEntries,
          });
          if (cambridgeCacheRef.current.size > 250) {
              const firstKey = cambridgeCacheRef.current.keys().next().value;
              if (firstKey) cambridgeCacheRef.current.delete(firstKey);
          }
          return safeEntries;
      }).catch(() => {
          cambridgeCacheRef.current.set(cacheKey, {
              expiresAt: Date.now() + 5 * 60 * 1000,
              entries: [],
          });
          return [];
      }).finally(() => {
          cambridgePendingRef.current.delete(cacheKey);
      });

      cambridgePendingRef.current.set(cacheKey, request);
      return request;
  };

  const mergeCambridgeEntries = async (word: string, localEntries: DictEntry[]) => {
      if ((settings?.cambridgeApiOnlyWhenNoLocal ?? true) && localEntries.length > 0) {
          return localEntries;
      }
      const apiEntries = await fetchCambridgeEntries(word);
      if (apiEntries.length === 0) return localEntries;
      return [...localEntries, ...apiEntries];
  };

  useEffect(() => {
    setActiveGrammarDesc(null);

    if (!(stack.length > 0 && settings?.ankiDeck && settings?.ankiFieldWord && settings.ankiFieldWord !== 'none')) {
        setAnkiStatuses({});
        return;
    }

    let cancelled = false;
    const current = stack[stack.length - 1];
    const uniquePairs = Array.from(
        new Map(
            (current.entries || [])
                .filter((entry) => entry?.term)
                .map((entry) => {
                    const word = entry.term || "";
                    const reading = entry.reading || "";
                    return [`${word}__${reading}`, { word, reading }];
                })
        ).values()
    );

    const loadingStatus: Record<string, 'green' | 'red' | 'blue' | 'loading'> = {};
    uniquePairs.forEach(({ word, reading }) => {
        loadingStatus[`${word}__${reading || ""}`] = 'loading';
    });
    setAnkiStatuses(loadingStatus);

    const timer = setTimeout(() => {
        checkWordsStatusMulti(
            settings.ankiDeck,
            settings.ankiFieldWord,
            settings.ankiFieldReading && settings.ankiFieldReading !== 'none' ? settings.ankiFieldReading : null,
            uniquePairs
        ).then((res) => {
            if (!cancelled) {
                setAnkiStatuses(res as Record<string, 'green' | 'red' | 'blue' | 'loading'>);
            }
        }).catch(() => {
            if (!cancelled) {
                const errRes: Record<string, 'green'> = {};
                uniquePairs.forEach(({ word, reading }) => {
                    errRes[`${word}__${reading || ""}`] = 'green';
                });
                setAnkiStatuses(errRes);
            }
        });
    }, 40);

    return () => {
        cancelled = true;
        clearTimeout(timer);
    };
  }, [stack, settings?.ankiDeck, settings?.ankiFieldWord, settings?.ankiFieldReading]);

  const popupScrollKey = useMemo(() => {
      return stack.map((data) => {
          const firstEntry = data.entries?.[0];
          return [
              data.word || "",
              firstEntry?.term || "",
              firstEntry?.reading || "",
              data.entries?.length || 0,
          ].join("__");
      }).join("||");
  }, [stack]);

  useEffect(() => {
      const previousKeys = previousPopupKeysRef.current;
      const nextKeys = stack.map((data) => {
          const firstEntry = data.entries?.[0];
          return [
              data.word || "",
              firstEntry?.term || "",
              firstEntry?.reading || "",
              data.entries?.length || 0,
          ].join("__");
      });

      previousPopupKeysRef.current = nextKeys;
      requestAnimationFrame(() => {
          nextKeys.forEach((key, index) => {
              if (previousKeys[index] === key) return;
              const popup = document.querySelector<HTMLElement>(`.dict-popup[data-popup-index="${index}"]`);
              if (popup) popup.scrollTop = 0;
          });
      });
  }, [popupScrollKey, stack]);

  const updateSingleStatus = (term: string, reading: string, status: 'green'|'red'|'blue') => { 
      const key = `${term}__${reading || ""}`;
      setAnkiStatuses(prev => ({ ...prev, [key]: status })); 
  };

  const playAudio = (term: string, reading: string, e?: React.MouseEvent) => {
      if (e) e.stopPropagation();
      const audioKey = `${term}-${reading}`;
      if (audioFailed[audioKey]) return; 
      
      setPlayingAudio(audioKey);
      const url = `https://assets.languagepod101.com/dictionary/japanese/audiomp3.php?kanji=${encodeURIComponent(term)}&kana=${encodeURIComponent(reading || term)}`;
      
      const audio = new Audio(url);
      audio.addEventListener('loadedmetadata', () => {
          if (audio.duration > 3.5) { setAudioFailed(prev => ({ ...prev, [audioKey]: true })); setPlayingAudio(null); } 
          else { audio.play().catch(() => { setAudioFailed(prev => ({ ...prev, [audioKey]: true })); setPlayingAudio(null); }); }
      });
      audio.addEventListener('error', () => { setAudioFailed(prev => ({ ...prev, [audioKey]: true })); setPlayingAudio(null); });
      audio.addEventListener('ended', () => setPlayingAudio(null));
  };

  useEffect(() => {
      if (settings?.autoPlayAudio && stack.length > 0) {
          const latestData = stack[stack.length - 1];
          const firstValidEntry = latestData.entries.find(e => isDictActive(e.dict_name, settings) && !e.dict_name.toUpperCase().includes("KANJI"));
          if (firstValidEntry) playAudio(firstValidEntry.term, firstValidEntry.reading);
      }
  }, [stack.length, settings?.autoPlayAudio]);

  useEffect(() => {
      const LOOKUP_CONTEXT_RADIUS = 600;
      let debounceTimer: any = null;
      let lastScanAt = 0;
      let scanSerial = 0;
      let scanInFlight = false;
      let hotkeyHeld = false;
      let queuedScan: { x: number; y: number } | null = null;
      const lastMouse = { x: 0, y: 0 };

      const isSameScanTarget = (left: LookupScanTarget | null, right: LookupScanTarget) => Boolean(
          left
          && left.container === right.container
          && left.scope === right.scope
          && left.word === right.word
          && left.start === right.start
          && left.len === right.len
      );

      const hotkey = String(settings?.lookupHotkey || "Shift");
      const hotkeyParts = hotkey.split("+").map((part) => part.trim()).filter(Boolean);
      const isModifier = (part: string) => /^(ctrl|control|alt|shift)$/i.test(part);
      const triggerKey = hotkeyParts.find((part) => !isModifier(part)) || "";
      const expectsCtrl = hotkeyParts.some((part) => /^(ctrl|control)$/i.test(part));
      const expectsAlt = hotkeyParts.some((part) => /^alt$/i.test(part));
      const expectsShift = hotkeyParts.some((part) => /^shift$/i.test(part));
      const modifierStateMatches = (event: KeyboardEvent | MouseEvent) =>
          event.ctrlKey === expectsCtrl && event.altKey === expectsAlt && event.shiftKey === expectsShift;
      const normalizedCode = (code: string) => code.toLowerCase().replace(/^key/, "").replace(/^digit/, "");
      const keyboardHotkeyMatches = (event: KeyboardEvent) => {
          if (hotkey === "__disabled__" || !modifierStateMatches(event)) return false;
          if (!triggerKey) return expectsCtrl || expectsAlt || expectsShift;
          return normalizedCode(event.code) === normalizedCode(triggerKey);
      };

      const scheduleScan = (x: number, y: number, immediate = false) => {
          lastMouse.x = x;
          lastMouse.y = y;
          const now = Date.now();
          if (scanInFlight) {
              queuedScan = { x, y };
              return;
          }
          clearTimeout(debounceTimer);
          const throttleDelay = immediate ? 0 : Math.max(0, 16 - (now - lastScanAt));
          debounceTimer = setTimeout(() => scan(x, y), throttleDelay);
      };

      const finishScan = () => {
          scanInFlight = false;
          const next = queuedScan;
          queuedScan = null;
          if (next && hotkeyHeld) {
              scheduleScan(next.x, next.y, true);
          }
      };

      const handleMouseMove = (e: MouseEvent) => {
          lastMouse.x = e.clientX;
          lastMouse.y = e.clientY;
          hotkeyHeld = triggerKey ? hotkeyHeld && modifierStateMatches(e) : modifierStateMatches(e);
          if (!hotkeyHeld) return;
          scheduleScan(e.clientX, e.clientY);
      };

      const handleKeyDown = (e: KeyboardEvent) => {
          if (e.repeat) return;
          const target = e.target as HTMLElement | null;
          if (target && (
              target.tagName === "INPUT"
              || target.tagName === "TEXTAREA"
              || target.isContentEditable
              || target.closest('[data-shortcut-recorder="true"]')
          )) return;
          hotkeyHeld = keyboardHotkeyMatches(e);
          if (!hotkeyHeld) return;
          e.preventDefault();
          e.stopPropagation();
          scheduleScan(lastMouse.x, lastMouse.y, true);
      };

      const handleKeyUp = () => {
          hotkeyHeld = false;
          queuedScan = null;
          lastShownScanTargetRef.current = null;
          lastEnglishRequestTargetRef.current = null;
      };

      const scan = async (x: number, y: number) => {
          if (scanInFlight) return;
          scanInFlight = true;
          lastScanAt = Date.now();
          const mySerial = ++scanSerial;
          let range = null;
          let exactOffset = -1;
          let textNode: Node | null = null;

          if (document.caretRangeFromPoint) {
              range = document.caretRangeFromPoint(x, y);
          } else if ((document as any).caretPositionFromPoint) {
              const pos = (document as any).caretPositionFromPoint(x, y);
              if (pos && pos.offsetNode) {
                  range = document.createRange();
                  range.setStart(pos.offsetNode, pos.offset);
                  range.collapse(true);
              }
          }

          const pointElement = document.elementFromPoint(x, y);
          let container: Element | null = null;

          if (range?.startContainer?.nodeType === Node.TEXT_NODE) {
              textNode = range.startContainer;
              exactOffset = range.startOffset;
              
              if (exactOffset > 0 && exactOffset <= (textNode.nodeValue?.length || 0)) {
                  const testRange = document.createRange();
                  testRange.setStart(textNode, exactOffset - 1);
                  testRange.setEnd(textNode, exactOffset);
                  const rect = testRange.getBoundingClientRect();
                  if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) {
                      exactOffset = exactOffset - 1;
                  }
              }
              container = textNode.parentElement?.closest('.text-line, .dict-meaning, .dict-header') || null;
          }

          if (!container && pointElement) {
              container = pointElement.closest('.text-line, .dict-meaning, .dict-header');
          }

          if (!container) { finishScan(); return; }

          if (textNode?.parentElement?.tagName === 'RT' || textNode?.parentElement?.tagName === 'RP') { finishScan(); return; }

          let isInsidePopup = false;
          let popupIndex = -1;

          let node = (textNode || container) as Node | null;
          while (node) {
              if (node.nodeType === 1) {
                  const el = node as Element;
                  if (el.classList?.contains('dict-popup')) {
                      isInsidePopup = true;
                      popupIndex = parseInt(el.getAttribute('data-popup-index') || '-1');
                      break;
                  }
              }
              node = node.parentNode;
          }

          const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
              acceptNode: (n) => {
                  const p = n.parentElement;
                  if (p?.tagName === 'RT' || p?.tagName === 'RP') return NodeFilter.FILTER_REJECT;
                  return NodeFilter.FILTER_ACCEPT;
              }
          });

          let sentence = "";
          let cursorIndex = -1;
          const textNodes: Node[] = [];

          let currentNode = walker.nextNode();
          while (currentNode) {
              textNodes.push(currentNode);
              if (currentNode === textNode) {
                  cursorIndex = sentence.length + exactOffset;
              }
              sentence += currentNode.nodeValue || "";
              currentNode = walker.nextNode();
          }

          const findNearestTextChar = (exhaustive: boolean) => {
              let currentLen = 0;
              let bestDistance = Number.POSITIVE_INFINITY;
              let bestInside = false;
              let bestIndex = -1;
              let bestNode: Node | null = null;
              let bestOffset = -1;

              const rectDistance = (rect: DOMRect) => {
                  if (rect.width <= 0 || rect.height <= 0) return { inside: false, distance: Number.POSITIVE_INFINITY };
                  const inside = x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
                  const dx = x < rect.left ? rect.left - x : x > rect.right ? x - rect.right : 0;
                  const dy = y < rect.top ? rect.top - y : y > rect.bottom ? y - rect.bottom : 0;
                  return { inside, distance: inside ? 0 : Math.hypot(dx, dy) };
              };

              for (const node of textNodes) {
                  const value = node.nodeValue || "";
                  let startOffset = 0;
                  let endOffset = value.length;

                  if (!exhaustive) {
                      if (node !== textNode || exactOffset < 0) {
                          currentLen += value.length;
                          continue;
                      }
                      startOffset = Math.max(0, exactOffset - 4);
                      endOffset = Math.min(value.length, exactOffset + 4);
                  }

                  for (let i = startOffset; i < endOffset; i++) {
                      const charRange = document.createRange();
                      charRange.setStart(node, i);
                      charRange.setEnd(node, i + 1);
                      const rects = Array.from(charRange.getClientRects());
                      for (const rect of rects) {
                          const { inside, distance } = rectDistance(rect);
                          const isBetter = (inside && !bestInside) || (inside === bestInside && distance < bestDistance);
                          if (isBetter) {
                              bestInside = inside;
                              bestDistance = distance;
                              bestIndex = currentLen + i;
                              bestNode = node;
                              bestOffset = i;
                          }
                      }
                      if (bestInside) break;
                  }
                  currentLen += value.length;
                  if (bestInside) break;
              }

              if (bestIndex < 0 || (!bestInside && bestDistance > 24)) return null;
              return { index: bestIndex, node: bestNode, offset: bestOffset };
          };

          const nearbyChar = findNearestTextChar(false);
          if (nearbyChar) {
              cursorIndex = nearbyChar.index;
              textNode = nearbyChar.node;
              exactOffset = nearbyChar.offset;
          }

          if (cursorIndex === -1) {
              const fallbackChar = findNearestTextChar(true);
              if (fallbackChar) {
                  cursorIndex = fallbackChar.index;
                  textNode = fallbackChar.node;
                  exactOffset = fallbackChar.offset;
              }
          }

          if (cursorIndex === -1 || !sentence) { finishScan(); return; }

          const fullSentence = sentence;
          const sentenceBaseOffset = Math.max(0, cursorIndex - LOOKUP_CONTEXT_RADIUS);
          const sentenceEnd = Math.min(fullSentence.length, cursorIndex + LOOKUP_CONTEXT_RADIUS);
          sentence = fullSentence.slice(sentenceBaseOffset, sentenceEnd);
          cursorIndex -= sentenceBaseOffset;

          const showLookup = (res: any, word: string, matchStart: number, matchLen: number) => {
              const originalMatchStart = sentenceBaseOffset + matchStart;
              const shownTarget: LookupScanTarget = {
                  container,
                  scope: isInsidePopup ? `popup:${popupIndex}` : "main",
                  word,
                  start: originalMatchStart,
                  len: matchLen,
              };
              if (isSameScanTarget(lastShownScanTargetRef.current, shownTarget)) return;
              lastShownScanTargetRef.current = shownTarget;

              const rects = range?.getClientRects() || [];
              let finalRect = rects.length > 0 ? rects[0] : new DOMRect(x, y, 0, 0);
              if (textNode && exactOffset >= 0) {
                  const charRange = document.createRange();
                  charRange.setStart(textNode, exactOffset);
                  charRange.setEnd(textNode, Math.min(exactOffset + 1, textNode.nodeValue?.length || 0));
                  const charRects = charRange.getClientRects();
                  if (charRects.length > 0) finalRect = charRects[0];
              }

              const parentLookup = isInsidePopup ? stack[popupIndex] : undefined;
              const data: LookupData = {
                  rect: finalRect,
                  entries: res.entries,
                  word,
                  sentence,
                  source: parentLookup?.source,
                  screenPoint: parentLookup?.screenPoint,
                  externalScreenshot: parentLookup?.externalScreenshot,
              };

              const sel = window.getSelection();
              if (sel) {
                  sel.removeAllRanges();
                  const r = document.createRange();

                  let currentLen = 0;
                  let startNode = null; let startOffset = 0;
                  let endNode = null; let endOffset = 0;

                  const hlWalker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
                      acceptNode: (n) => {
                          if (n.parentElement?.tagName === 'RT' || n.parentElement?.tagName === 'RP') return NodeFilter.FILTER_REJECT;
                          return NodeFilter.FILTER_ACCEPT;
                      }
                  });

                  let hlNode = hlWalker.nextNode();
                  while (hlNode) {
                      const nodeLen = hlNode.nodeValue?.length || 0;
                      if (!startNode && currentLen + nodeLen > originalMatchStart) {
                          startNode = hlNode;
                          startOffset = originalMatchStart - currentLen;
                      }
                      if (startNode && currentLen + nodeLen >= originalMatchStart + matchLen) {
                          endNode = hlNode;
                          endOffset = originalMatchStart + matchLen - currentLen;
                          break;
                      }
                      currentLen += nodeLen;
                      hlNode = hlWalker.nextNode();
                  }

                  if (startNode && endNode) {
                      r.setStart(startNode, startOffset);
                      r.setEnd(endNode, endOffset);
                      sel.addRange(r);
                  }
              }

              if (isInsidePopup && onReplaceAt) {
                  onReplaceAt(popupIndex, data);
              } else if (!isInsidePopup && onReplace) {
                  onReplace(data);
              }
          };

          try {
              // Let the native scanner try the whole sentence first. It knows about
              // inflections, idioms and phrasal verbs (for example, closed up ->
              // close up). Looking up the hovered English token first made an exact
              // `closed` entry hide the more useful phrase match.
              const res = await invoke<any>("scan_cursor", { sentence, cursor: cursorIndex });
              if (mySerial !== scanSerial) return;

              if (res && res.entries && res.entries.length > 0) {
                  const entries = await mergeCambridgeEntries(res.word, res.entries);
                  if (mySerial !== scanSerial) return;
                  showLookup({ ...res, entries }, res.word, res.match_start, res.match_len);
                  return;
              }

              // Cambridge remains a fallback for English words which are not in the
              // local database. This path deliberately runs after sentence scanning.
              const english = extractEnglishWordAtCursor(sentence, cursorIndex);
              if (english) {
                  const query = normalizeCambridgeWord(english.word);
                  const requestTarget: LookupScanTarget = {
                      container,
                      scope: isInsidePopup ? `popup:${popupIndex}` : "main",
                      word: query,
                      start: sentenceBaseOffset + english.start,
                      len: english.len,
                  };
                  if (isSameScanTarget(lastEnglishRequestTargetRef.current, requestTarget)) return;
                  lastEnglishRequestTargetRef.current = requestTarget;
                  const localEntries = await invoke<DictEntry[]>("lookup_word", { word: query }).catch(() => []);
                  const entries = await mergeCambridgeEntries(query, localEntries);
                  if (mySerial !== scanSerial) return;
                  if (entries.length > 0) {
                      showLookup({ entries }, english.word, english.start, english.len);
                      return;
                  }
              }
          } catch (e) {
              const english = extractEnglishWordAtCursor(sentence, cursorIndex);
              if (english) {
                  const entries = await fetchCambridgeEntries(english.word);
                  if (mySerial !== scanSerial) return;
                  if (entries.length > 0) {
                      showLookup({ entries }, english.word, english.start, english.len);
                  }
              }
          } finally {
              finishScan();
          }
      };

      window.addEventListener('mousemove', handleMouseMove);
      window.addEventListener('keydown', handleKeyDown, { capture: true });
      window.addEventListener('keyup', handleKeyUp, { capture: true });
      return () => {
          window.removeEventListener('mousemove', handleMouseMove);
          window.removeEventListener('keydown', handleKeyDown, { capture: true });
          window.removeEventListener('keyup', handleKeyUp, { capture: true });
          clearTimeout(debounceTimer);
      };
  }, [
      settings?.lookupHotkey,
      settings?.cambridgeApiEnabled,
      settings?.cambridgeApiKey,
      settings?.cambridgeApiDictionary,
      settings?.cambridgeApiBaseUrl,
      settings?.cambridgeApiOnlyWhenNoLocal,
      onReplace,
      onReplaceAt,
      stack,
  ]);

  const handleWordLookup = async (e: React.MouseEvent, word: string, isKanji: boolean = false) => {
      e.stopPropagation();
      e.preventDefault();
      if (onAppend) {
          try {
              const localEntries: DictEntry[] = await invoke("lookup_word", { word });
              const entries = await mergeCambridgeEntries(word, localEntries || []);
              if (entries && entries.length > 0) {
                  const target = (e.target as HTMLElement);
                  const parentLookup = stack[stack.length - 1];
                  onAppend({
                      rect: target.getBoundingClientRect(),
                      entries,
                      word,
                      sentence: parentLookup?.sentence || "",
                      isKanjiLookup: isKanji,
                      source: parentLookup?.source,
                      screenPoint: parentLookup?.screenPoint,
                      externalScreenshot: parentLookup?.externalScreenshot,
                  });
              }
          } catch (err) {}
      }
  };

  const groupedStack = useMemo(() => {
      return (stack || []).map((data) => {
          let groupedEntries = groupDictionaryEntries(data.entries, settings, data.isKanjiLookup);
          const hasDefinitions = groupedEntries.some((group) => Object.keys(group.cleanDictionaries || {}).length > 0);
          const sourceHasDefinitions = (data.entries || []).some((entry) => typeof entry.definition === "string" && entry.definition.trim() !== "");

          if ((!hasDefinitions || groupedEntries.length === 0) && sourceHasDefinitions) {
              groupedEntries = groupDictionaryEntries(data.entries, { ...settings, dictionaries: [] }, data.isKanjiLookup);
          }

          return { data, groupedEntries };
      });
  }, [stack, settings]);

  if (!stack || stack.length === 0) return null;

  // On phones, render the lookup as a bottom sheet (leaves the tapped word visible above).
  const isMobileSheet = typeof window !== 'undefined' && window.innerWidth <= 760;

  return (
    <>
        {isMobileSheet && <div className="dict-mobile-scrim" aria-hidden="true" />}
        {groupedStack.map(({ data, groupedEntries }, index) => {
            if (groupedEntries.length === 0) return null;
            if (isMobileSheet && index !== groupedStack.length - 1) return null;

            const scale = settings?.lookupScale || 1.0;
            const baseWidth = settings?.lookupWidth || 420;
            const scaledWidth = baseWidth * scale;
            const margin = 10;

            const browserContainer = document.getElementById('native-browser-container');
            const browserRect = browserContainer?.getBoundingClientRect();
            const browserIsVisible = !!browserRect && browserRect.width > 20 && browserRect.height > 20;
            const rightLimit = browserIsVisible ? Math.max(margin + scaledWidth, browserRect.left - margin) : window.innerWidth - margin;

            let left = (data.rect?.left || 0) + (index * 15);
            if (left + scaledWidth > rightLimit) {
                left = (data.rect?.right || data.rect?.left || 0) - scaledWidth - (index * 15);
            }
            left = Math.max(margin, Math.min(left, rightLimit - scaledWidth));

            const spaceBelow = window.innerHeight - (data.rect?.bottom || 0);
            const spaceAbove = data.rect?.top || 0;

            let popupStyle: React.CSSProperties = {
                position: 'fixed',
                left,
                zIndex: 10000 + index,
                width: `${baseWidth}px`,
                zoom: scale,
                fontFamily: LOOKUP_FONT_STACK,
                fontSize: `${Math.max(settings?.lookupFontSize || 17, 16)}px`,
                lineHeight: 1.55,
                letterSpacing: 0,
                fontKerning: 'normal',
                fontSynthesis: 'none',
            };

            if (spaceBelow >= 450 * scale || spaceBelow > spaceAbove) {
                popupStyle.top = ((data.rect?.bottom || 0) + 5 + (index * 15)) / scale;
                popupStyle.maxHeight = Math.max(160, (spaceBelow / scale) - 10);
            } else {
                popupStyle.bottom = (window.innerHeight - (data.rect?.top || 0) + 5 - (index * 15)) / scale;
                popupStyle.maxHeight = Math.max(160, (spaceAbove / scale) - 10);
            }

            if (isMobileSheet) {
                popupStyle = {
                    position: 'fixed',
                    left: 0,
                    right: 0,
                    bottom: 0,
                    top: 'auto',
                    width: '100%',
                    maxHeight: '80vh',
                    zIndex: 10000 + index,
                    fontFamily: LOOKUP_FONT_STACK,
                    fontSize: `${Math.max(settings?.lookupFontSize || 17, 16)}px`,
                    lineHeight: 1.55,
                    letterSpacing: 0,
                    fontKerning: 'normal',
                    fontSynthesis: 'none',
                };
            }

            return (
                <div key={index} className={isMobileSheet ? "dict-popup dict-mobile-sheet" : "dict-popup"} data-popup-index={index} style={popupStyle} onClick={(e) => {
                    e.stopPropagation();
                    if (onSlice && stack.length > index + 1) onSlice(index);
                }}>
                    {isMobileSheet && onClose && (
                        <button
                            type="button"
                            className="dict-mobile-close"
                            aria-label={settings?.appLanguage === 'en' ? 'Close lookup' : 'Закрыть лукап'}
                            onClick={(event) => {
                                event.stopPropagation();
                                onClose();
                            }}
                        >
                            ×
                        </button>
                    )}
                    {groupedEntries.map((group, i) => (
                        <LookupEntryItem 
                            key={i} group={group} settings={settings} sentence={data.sentence} onWordLookup={handleWordLookup}
                            activeGrammarDesc={activeGrammarDesc} setActiveGrammarDesc={setActiveGrammarDesc}
                            playAudio={playAudio} audioFailed={audioFailed} playingAudio={playingAudio}
                            isKanjidic={Object.keys(group.cleanDictionaries)[0]?.toUpperCase().includes("KANJI")}
                            ankiStatus={ankiStatuses[`${group.term}__${group.reading || ""}`] || 'loading'} onStatusChange={updateSingleStatus}
                            captureSource={captureSource}
                            playerClip={playerClip}
                            lookupData={data}
                            screenshotSource={screenshotSource}
                        />
                    ))}
                </div>
            );
        })}
    </>
  );
}
