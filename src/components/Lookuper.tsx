import React, { useEffect, useState } from "react";
import { invoke } from '@tauri-apps/api/core';
import { AppSettings } from "./SettingsModal";
import { checkWordsStatusMulti, addNote } from "../utils/anki";


export interface DeinflectReason { rule: any; desc: any; }
export interface FrequencyData { dict_name: string; display_value: string; value: number; }
export interface PitchData { dict_name: string; reading: string; position: number; }
export interface DictEntry { 
    term: string; reading: string; definition: string; dict_name: string; 
    tags: string; deinflection_reasons: DeinflectReason[]; frequencies: FrequencyData[]; pitches: PitchData[]; source_length: number; 
}
export interface LookupData { rect: DOMRect; entries: DictEntry[]; word: string; sentence: string; isKanjiLookup?: boolean; }
interface LookuperProps { 
    stack?: LookupData[]; 
    onAppend?: (data: LookupData) => void; 
    onReplace?: (data: LookupData) => void;
    onReplaceAt?: (index: number, data: LookupData) => void;
    onSlice?: (idx: number) => void; 
    settings?: AppSettings; 
}

export const IconAudio = () => <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M11 5L6 9H2v6h4l5 4V5z"></path><path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"></path></svg>;
export const IconAudioOff = () => <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M11 5L6 9H2v6h4l5 4V5z"></path><line x1="23" y1="9" x2="17" y2="15"></line><line x1="17" y1="9" x2="23" y2="15"></line></svg>;
export const IconCamera = () => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"></path><circle cx="12" cy="13" r="4"></circle></svg>;

export const SCRenderer = ({ node, onLookup }: { node: any; onLookup: (e: React.MouseEvent, word: string, isKanji?: boolean) => void }): any => {
    if (node === null || node === undefined) return null;
    
    if (typeof node === 'string') {
        const parts = node.replace(/\\n/g, '\n').split('\n');
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

        const safeTags = ['span', 'div', 'p', 'ul', 'ol', 'li', 'table', 'tr', 'td', 'th', 'b', 'i', 'u', 'strong', 'em', 'ruby', 'rt', 'rp', 'br', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'dl', 'dt', 'dd'];
        if (safeTags.includes(Tag as string)) {
            if (Tag === 'br') return <br />;
            if (Tag === 'ul' || Tag === 'ol') { style.paddingLeft = style.paddingLeft || '24px'; style.margin = style.margin || '6px 0'; }
            if (Tag === 'li') { style.display = 'list-item'; style.marginBottom = '4px'; }
            if (['div', 'p', 'table', 'dl'].includes(Tag as string)) { style.display = style.display || 'block'; style.marginBottom = style.marginBottom || '4px'; }
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

    const chunks: { text: string; reading: string | null }[] = [];
    const normalizedReading = kataToHira(reading);
    let termIndex = 0;
    let readingIndex = 0;

    while (termIndex < term.length) {
        const current = term[termIndex];

        if (!isKanjiChar(current)) {
            let literal = "";

            while (termIndex < term.length && !isKanjiChar(term[termIndex])) {
                const char = term[termIndex];
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
        while (termIndex < term.length && isKanjiChar(term[termIndex])) {
            kanjiBlock += term[termIndex];
            termIndex += 1;
        }

        let nextLiteral = "";
        let probe = termIndex;
        while (probe < term.length && !isKanjiChar(term[probe])) {
            nextLiteral += term[probe];
            probe += 1;
        }

        const normalizedNextLiteral = kataToHira(nextLiteral);
        let blockReading = "";

        if (normalizedNextLiteral) {
            const nextPos = normalizedReading.indexOf(normalizedNextLiteral, readingIndex);
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

export const groupDictionaryEntries = (entries: any[], settings: any, isKanjiLookup: boolean = false) => {
    const groupedMap = new Map<string, any>();
    
    (entries || []).forEach(ent => {
        const key = `${ent.term || ""}|${ent.reading || ""}`;
        if (!groupedMap.has(key)) {
            groupedMap.set(key, { 
                term: ent.term || "", reading: ent.reading || "", reasons: ent.deinflection_reasons || [], 
                dictionaries: {}, frequencies: [], pitches: [], source_length: ent.source_length || 0 
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

        if (!isDictActive(ent.dict_name, settings)) return;

        const dictSetting = settings?.dictionaries?.find((d: any) => d.name === ent.dict_name);
        if (dictSetting && dictSetting.allowDeinflect === false && ent.deinflection_reasons && ent.deinflection_reasons.length > 0) return;

        const isKanjidic = ent.dict_name.toUpperCase().includes("KANJI");
        if (!isKanjiLookup && isKanjidic) return;
        if (isKanjiLookup && !isKanjidic) return;

        if (ent.definition && typeof ent.definition === 'string' && ent.definition.trim() !== "") {
            if (!existing.dictionaries[ent.dict_name]) existing.dictionaries[ent.dict_name] = [];
            existing.dictionaries[ent.dict_name].push({ definition: ent.definition, tags: ent.tags || [] });
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
    }).filter(g => Object.keys(g.cleanDictionaries).length > 0 || g.frequencies.length > 0 || g.uniquePitches.length > 0);

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

export const LookupEntryItem = ({ group, settings, sentence, onWordLookup, activeGrammarDesc, setActiveGrammarDesc, playAudio, audioFailed, playingAudio, isKanjidic, ankiStatus, onStatusChange }: any) => {
    const [isAdding, setIsAdding] = useState(false);

    const fSize = Math.max(settings?.lookupFontSize || 17, 16);
    const tagSize = Math.max(settings?.lookupTagFontSize || 12, 11);

    const lang = settings?.appLanguage || 'ru';
    const getLoc = (val: any) => {
        if (!val) return "";
        if (typeof val === 'string') return val;
        if (typeof val === 'object') return val[lang] || val['ru'] || val['en'] || "";
        return "";
    };

    const filteredReasons = group.reasons.filter((r: DeinflectReason, _: number, arr: DeinflectReason[]) => {
        const reasonStr = getLoc(r.rule);
        const hasObligation = arr.some((x: DeinflectReason) => getLoc(x.rule).includes('Необходимость'));
        if (hasObligation && reasonStr === 'Отрицание') return false;
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
                
                const safeTags = ['span', 'div', 'p', 'ul', 'ol', 'li', 'table', 'tr', 'td', 'th', 'b', 'i', 'u', 'strong', 'em', 'ruby', 'rt', 'rp', 'br', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'dl', 'dt', 'dd', 'a'];
                if (safeTags.includes(Tag as string)) {
                    if (Tag === 'br') return '<br/>';
                    return `<${Tag}${styleAttr}>${contentHtml}</${Tag}>`;
                }
                return `<span${styleAttr}>${contentHtml}</span>`;
            }
        } catch(e) {}
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

        let activeProcs = "";
        if (Array.isArray(settings?.hookProcesses)) {
            activeProcs = settings.hookProcesses.filter((p: any) => p.active).map((p: any) => p.name).join(',');
        } else if (typeof settings?.hookProcesses === 'string') {
            activeProcs = settings.hookProcesses;
        }

        // НОВАЯ СИСТЕМА ОТЛАОВА ОШИБОК СКРИНШОТА
        if (withScreenshot && activeProcs.length > 0) {
            try {
                const b64 = await invoke<string | null>('take_smart_screenshot', { processes: activeProcs });
                if (b64) {
                    screenshotData = b64;
                } else {
                    alert("Процесс не найден! Пожалуйста, убедитесь, что игра запущена и не свернута.");
                    setIsAdding(false);
                    return;
                }
            } catch (e) {
                console.error("Screenshot failed:", e);
                alert("Ошибка создания скриншота:\n" + String(e));
                setIsAdding(false);
                return; // Прерываем процесс добавления, если скриншот не удался
            }
        }

        const res = await addNote(settings, { 
            word: group.term, reading: plainReading, meaning: formattedMeaning, sentence: sentence, 
            dictionary: dictName, pitch: pitchText, frequency: freqText, audioUrl: audioUrl,
            screenshot: screenshotData
        });
        
        if (!res.error) {
            onStatusChange(group.term, group.reading, 'red');
        } else {
            alert("Ошибка при добавлении в Anki:\n" + res.error);
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
    const isBtnDisabled = isAdding || ankiStatus === 'loading' || (ankiStatus === 'red' && !allowSame) || (ankiStatus === 'blue' && !allowOther);
    const tooltipText = ankiStatus === 'red' ? 'В колоде' : ankiStatus === 'blue' ? 'В другой колоде' : 'Добавить в Anki';

    const renderAnkiButton = () => {
        const hasAnki = Boolean(settings?.ankiDeck && settings?.ankiModel);
        const showNormal = settings?.ankiShowButtonNormal ?? true;
        const showScreen = settings?.ankiShowButtonScreenshot ?? true;

        if (!showNormal && !showScreen) return null;

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
                            if (!hasAnki) { alert("Настройте Anki"); return; }
                            handleAddToAnki(firstDictName, group.cleanDictionaries, false);
                        }} 
                        disabled={isBtnDisabled && hasAnki} title={hasAnki ? tooltipText : "Настройте Anki"}
                        style={{ ...baseBtnStyle, borderRight: showScreen ? '1px solid var(--border-main)' : 'none' }}
                    >
                        {isAdding || ankiStatus === 'loading' ? '...' : '+'}
                    </button>
                )}
                {showScreen && (
                    <button 
                        onClick={() => {
                            if (!hasAnki) { alert("Настройте Anki"); return; }
                            handleAddToAnki(firstDictName, group.cleanDictionaries, true);
                        }} 
                        disabled={isBtnDisabled && hasAnki} title={hasAnki ? "Добавить со скриншотом игры" : "Настройте Anki"}
                        style={{ ...baseBtnStyle }}
                    >
                        {isAdding || ankiStatus === 'loading' ? '...' : <><span style={{fontSize: '16px', marginTop:'-2px'}}>+</span><IconCamera /></>}
                    </button>
                )}
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
                            <div style={{ color: 'var(--text-muted)' }}>Meaning</div>
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
                            <div style={{ color: 'var(--text-muted)' }}>Readings</div>
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
                            <span style={{ fontSize: `${fSize * 2.0}px`, lineHeight: '1.5', fontWeight: 700, color: 'var(--text-main)', fontFamily: '"BIZ UDPGothic", "BIZ UDGothic", "Meiryo", "Noto Sans JP", "Yu Gothic UI", sans-serif', letterSpacing: '0.03em' }}>
                                {splitOkurigana(group.term, group.reading).map((chunk, i) => {
                                    if (!chunk.reading) {
                                        return <span key={i}>{Array.from(chunk.text).map((c: any, j) => {
                                            const isKanji = /[\u4e00-\u9faf]/.test(c);
                                            return isKanji ? <span key={j} onClick={(e) => onWordLookup(e, c, true)} style={{ cursor: 'pointer', borderBottom: '1px dashed var(--text-muted)', paddingBottom: '2px' }}>{c}</span> : <span key={j}>{c}</span>;
                                        })}</span>;
                                    }
                                    return (
                                        <ruby key={i} style={{ rubyPosition: 'over', marginRight: '6px' }}>
                                            {Array.from(chunk.text).map((c: any, j) => {
                                                const isKanji = /[\u4e00-\u9faf]/.test(c);
                                                return isKanji ? <span key={j} onClick={(e) => onWordLookup(e, c, true)} style={{ cursor: 'pointer', borderBottom: '1px dashed var(--text-muted)', paddingBottom: '2px' }}>{c}</span> : <span key={j}>{c}</span>;
                                            })}
                                            <rt style={{ fontSize: `${Math.max(14, fSize * 0.75)}px`, color: 'var(--text-muted)', fontWeight: 700, userSelect: 'none', letterSpacing: '0.05em', fontFamily: '"BIZ UDPGothic", "BIZ UDGothic", "Meiryo", "Noto Sans JP", "Yu Gothic UI", sans-serif' }}>{chunk.reading}</rt>
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
                    </div>
                    
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexShrink: 0 }}>
                        {settings?.lookupShowAudio !== false && (
                            <button 
                                onClick={(e) => playAudio(group.term, group.reading, e)} title={audioFailed[`${group.term}-${group.reading}`] ? "Аудио недоступно" : "Послушать"}
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
                    <div key={dictIdx} className="dict-meaning" style={{ marginTop: dictIdx > 0 ? '12px' : '0', paddingTop: dictIdx > 0 ? '12px' : '0', borderTop: dictIdx > 0 ? '1px solid var(--border-main)' : 'none', fontSize: `${fSize}px`, fontFamily: '"Noto Sans JP", "Yu Gothic", Meiryo, sans-serif' }}>
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

export default function Lookuper({ stack = [], onAppend, onReplace, onReplaceAt, onSlice, settings }: LookuperProps) {
  const [activeGrammarDesc, setActiveGrammarDesc] = useState<string | null>(null);
  const [playingAudio, setPlayingAudio] = useState<string | null>(null);
  const [audioFailed, setAudioFailed] = useState<Record<string, boolean>>({});
  const [ankiStatuses, setAnkiStatuses] = useState<Record<string, 'green' | 'red' | 'blue' | 'loading'>>({});

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
    }, 350);

    return () => {
        cancelled = true;
        clearTimeout(timer);
    };
  }, [stack, settings?.ankiDeck, settings?.ankiFieldWord, settings?.ankiFieldReading]);

  useEffect(() => {
      requestAnimationFrame(() => {
          document.querySelectorAll<HTMLElement>('.dict-popup').forEach((popup) => {
              popup.scrollTop = 0;
          });
      });
  }, [stack.length > 0 ? `${stack[stack.length - 1].word}__${stack[stack.length - 1].entries?.[0]?.reading || ''}` : '']);

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
      let debounceTimer: any = null;
      let lastScannedText = "";

      const handleMouseMove = (e: MouseEvent) => {
          const hotkey = (settings?.lookupHotkey || "Shift").toLowerCase();
          let isHotkeyDown = false;
          if (hotkey === "shift" && e.shiftKey) isHotkeyDown = true;
          if (hotkey === "control" && e.ctrlKey) isHotkeyDown = true;
          if (hotkey === "alt" && e.altKey) isHotkeyDown = true;

          if (!isHotkeyDown) return;

          clearTimeout(debounceTimer);
          debounceTimer = setTimeout(() => scan(e.clientX, e.clientY), 30);
      };

      const scan = async (x: number, y: number) => {
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
          
          if (!range) return;

          textNode = range.startContainer;
          if (textNode.nodeType === Node.TEXT_NODE) {
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
          } else {
              return; 
          }

          let isInsidePopup = false;
          let popupIndex = -1;

          let node = textNode as Node | null;
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

          const container = textNode.parentElement?.closest('.text-line, .dict-meaning, .dict-header');
          if (!container) return;

          if (textNode.parentElement?.tagName === 'RT' || textNode.parentElement?.tagName === 'RP') return;

          const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
              acceptNode: (n) => {
                  const p = n.parentElement;
                  if (p?.tagName === 'RT' || p?.tagName === 'RP') return NodeFilter.FILTER_REJECT;
                  return NodeFilter.FILTER_ACCEPT;
              }
          });

          let sentence = "";
          let cursorIndex = -1;

          let currentNode = walker.nextNode();
          while (currentNode) {
              if (currentNode === textNode) {
                  cursorIndex = sentence.length + exactOffset;
              }
              sentence += currentNode.nodeValue || "";
              currentNode = walker.nextNode();
          }

          if (cursorIndex === -1 || !sentence) return;

          try {
              const subSentence = sentence.substring(cursorIndex);
              const res = await invoke<any>("scan_cursor", { sentence: subSentence, cursor: 0 });
              
              if (res && res.entries && res.entries.length > 0) {
                  if (res.word === lastScannedText) return;
                  lastScannedText = res.word;
                  
                  const originalMatchStart = cursorIndex + res.match_start;

                  const rects = range.getClientRects();
                  let finalRect = rects.length > 0 ? rects[0] : new DOMRect(x, y, 0, 0);
                  if (exactOffset >= 0) {
                      const charRange = document.createRange();
                      charRange.setStart(textNode, exactOffset);
                      charRange.setEnd(textNode, Math.min(exactOffset + 1, textNode.nodeValue?.length || 0));
                      const charRects = charRange.getClientRects();
                      if (charRects.length > 0) finalRect = charRects[0]; 
                  }

                  const data: LookupData = { rect: finalRect, entries: res.entries, word: res.word, sentence };
                  
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
                          if (startNode && currentLen + nodeLen >= originalMatchStart + res.match_len) {
                              endNode = hlNode;
                              endOffset = originalMatchStart + res.match_len - currentLen;
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
              }
          } catch (e) {}
      };

      window.addEventListener('mousemove', handleMouseMove);
      return () => {
          window.removeEventListener('mousemove', handleMouseMove);
          clearTimeout(debounceTimer);
      };
  }, [settings?.lookupHotkey, onReplace, onReplaceAt]);

  const handleWordLookup = async (e: React.MouseEvent, word: string, isKanji: boolean = false) => {
      e.stopPropagation();
      e.preventDefault();
      if (onAppend) {
          try {
              const entries: DictEntry[] = await invoke("lookup_word", { word });
              if (entries && entries.length > 0) {
                  const target = (e.target as HTMLElement);
                  onAppend({ rect: target.getBoundingClientRect(), entries, word, sentence: stack[stack.length - 1]?.sentence || "", isKanjiLookup: isKanji });
              }
          } catch (err) {}
      }
  };

  if (!stack || stack.length === 0) return null;

  return (
    <>
        {(stack || []).map((data, index) => {
            const groupedEntries = groupDictionaryEntries(data.entries, settings, data.isKanjiLookup);
            if (groupedEntries.length === 0) return null;

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
                fontFamily: '"Noto Sans JP", "Yu Gothic", Meiryo, sans-serif',
                fontSize: `${Math.max(settings?.lookupFontSize || 17, 16)}px`,
                lineHeight: 1.55,
            };

            if (spaceBelow >= 450 * scale || spaceBelow > spaceAbove) {
                popupStyle.top = ((data.rect?.bottom || 0) + 5 + (index * 15)) / scale;
                popupStyle.maxHeight = Math.max(160, (spaceBelow / scale) - 10);
            } else {
                popupStyle.bottom = (window.innerHeight - (data.rect?.top || 0) + 5 - (index * 15)) / scale;
                popupStyle.maxHeight = Math.max(160, (spaceAbove / scale) - 10);
            }

            return (
                <div key={index} className="dict-popup" data-popup-index={index} style={popupStyle} onClick={(e) => {
                    e.stopPropagation();
                    if (onSlice && stack.length > index + 1) onSlice(index);
                }}>
                    {groupedEntries.map((group, i) => (
                        <LookupEntryItem 
                            key={i} group={group} settings={settings} sentence={data.sentence} onWordLookup={handleWordLookup}
                            activeGrammarDesc={activeGrammarDesc} setActiveGrammarDesc={setActiveGrammarDesc}
                            playAudio={playAudio} audioFailed={audioFailed} playingAudio={playingAudio}
                            isKanjidic={Object.keys(group.cleanDictionaries)[0]?.toUpperCase().includes("KANJI")}
                            ankiStatus={ankiStatuses[`${group.term}__${group.reading || ""}`] || 'loading'} onStatusChange={updateSingleStatus}
                        />
                    ))}
                </div>
            );
        })}
    </>
  );
}