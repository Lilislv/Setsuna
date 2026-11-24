import { useEffect, useRef, useState, useCallback, memo, useLayoutEffect, type ReactNode } from "react";
import type { ClipboardEvent as ReactClipboardEvent } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { writeText } from '@tauri-apps/plugin-clipboard-manager';
import { useVirtualizer } from '@tanstack/react-virtual';
import { getTranslator } from '../utils/i18n';
import { tokenizeLookupText } from '../utils/appRuntime';
import { IconSparkle } from './Icons';

const IconCopy = () => <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>;
const IconCheck = () => <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#4CAF50" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>;
const IconDelete = () => <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>;
const IconEdit = () => <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg>;
const IconChecklist = () => <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M10 6h10"></path><path d="M10 12h10"></path><path d="M10 18h10"></path><path d="m3 6 1.5 1.5L7 5"></path><path d="m3 12 1.5 1.5L7 11"></path><path d="m3 18 1.5 1.5L7 17"></path></svg>;
const MAX_AI_SELECTION = 40;
const IconArrowDown = () => <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="12" y1="5" x2="12" y2="19"></line><polyline points="19 12 12 19 5 12"></polyline></svg>;
const jpSerifFallback = "'Yu Mincho', 'YuMincho', 'Hiragino Mincho ProN', 'BIZ UDPMincho', 'Meiryo', serif";
const MAX_FURIGANA_CACHE = 500;
const MAX_FURIGANA_TEXT_LENGTH = 220;
const furiganaCache = new Map<string, any[]>();
const furiganaPending = new Map<string, Promise<any[]>>();
const clampAutoScrollOffset = (value: number) => Math.min(95, Math.max(30, Number.isFinite(value) ? value : 80));

const rememberFurigana = (key: string, tokens: any[]) => {
    furiganaCache.set(key, tokens);
    while (furiganaCache.size > MAX_FURIGANA_CACHE) {
        const firstKey = furiganaCache.keys().next().value;
        if (!firstKey) break;
        furiganaCache.delete(firstKey);
    }
};

const highlightText = (text: string, query: string) => {
    if (!query) return text;
    const escapedQuery = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const parts = text.split(new RegExp(`(${escapedQuery})`, 'gi'));
    return parts.map((part, i) => 
        part.toLowerCase() === query.toLowerCase() 
            ? <mark key={i} style={{ backgroundColor: '#4fa6ff', color: '#fff', borderRadius: '3px', padding: '0 2px' }}>{part}</mark> 
            : part
    );
};

const suppliedFuriganaTokens = (value: unknown): Array<{ text: string; reading: string }> => {
    let source = value;
    if (typeof source === 'string') {
        try { source = JSON.parse(source); } catch {}
    }
    if (!Array.isArray(source)) return [];
    return source.map((item: any) => ({
        text: String(item?.text ?? item?.surface ?? item?.term ?? ''),
        reading: String(item?.reading ?? item?.ruby ?? item?.furigana ?? ''),
    })).filter((item) => item.text);
};

const renderRubyMarkup = (value: string, searchQuery: string): ReactNode[] => {
    if (!/<ruby\b/i.test(value)) return [];
    const doc = new DOMParser().parseFromString(value, 'text/html');
    const visit = (node: Node, key: string): ReactNode[] => {
        if (node.nodeType === Node.TEXT_NODE) return [highlightText(node.textContent || '', searchQuery)];
        if (!(node instanceof HTMLElement)) return [];
        if (node.tagName.toLowerCase() === 'ruby') {
            const reading = node.querySelector('rt')?.textContent?.trim() || '';
            const base = Array.from(node.childNodes)
                .filter((child) => !(child instanceof HTMLElement && ['rt', 'rp'].includes(child.tagName.toLowerCase())))
                .map((child) => child.textContent || '').join('');
            return [<ruby key={key} style={{ WebkitRubyPosition: 'over', rubyPosition: 'over' }}>
                {highlightText(base, searchQuery)}
                {reading && <rt style={{ fontSize: '0.55em', color: 'var(--text-main)', opacity: 0.85, fontWeight: 500, userSelect: 'none', lineHeight: 1 }}>{reading}</rt>}
            </ruby>];
        }
        return Array.from(node.childNodes).flatMap((child, index) => visit(child, `${key}-${index}`));
    };
    return Array.from(doc.body.childNodes).flatMap((node, index) => visit(node, String(index)));
};

const SuppliedFuriganaLine = memo(({ text, supplied, searchQuery }: { text: string; supplied?: unknown; searchQuery: string }) => {
    const tokens = suppliedFuriganaTokens(supplied);
    if (tokens.length) {
        const parts: ReactNode[] = [];
        let cursor = 0;

        tokens.forEach((token, index) => {
            const tokenStart = text.indexOf(token.text, cursor);
            if (tokenStart < 0) return;
            if (tokenStart > cursor) {
                parts.push(<span key={`plain-${index}`}>{highlightText(text.slice(cursor, tokenStart), searchQuery)}</span>);
            }
            parts.push(token.reading ? (
                <ruby key={`ruby-${index}-${tokenStart}`} style={{ WebkitRubyPosition: 'over', rubyPosition: 'over' }}>
                    {highlightText(token.text, searchQuery)}
                    <rt style={{ fontSize: '0.55em', color: 'var(--text-main)', opacity: 0.85, fontWeight: 500, userSelect: 'none', lineHeight: 1 }}>{token.reading}</rt>
                </ruby>
            ) : <span key={`token-${index}-${tokenStart}`}>{highlightText(token.text, searchQuery)}</span>);
            cursor = tokenStart + token.text.length;
        });

        if (cursor < text.length) {
            parts.push(<span key="plain-tail">{highlightText(text.slice(cursor), searchQuery)}</span>);
        }
        if (parts.length) return <>{parts}</>;
    }
    if (typeof supplied === 'string') {
        const markup = renderRubyMarkup(supplied, searchQuery);
        if (markup.length) return <>{markup}</>;
    }
    return <>{highlightText(text, searchQuery)}</>;
});

export const FuriganaLine = memo(({ text, mode, searchQuery, contextBefore = "", contextAfter = "" }: { text: string, mode: string, searchQuery: string, contextBefore?: string, contextAfter?: string }) => {
    const [tokens, setTokens] = useState<any[] | null>(null);

    useEffect(() => {
        let cancelled = false;

        if (mode === 'auto') {
            setTokens(null);
            const cacheKey = `${text}\u0001${contextBefore}\u0001${contextAfter}`;
            const cached = furiganaCache.get(cacheKey);
            if (cached) {
                setTokens(cached);
                return () => {
                    cancelled = true;
                };
            }

            if ((text.length + contextBefore.length + contextAfter.length) > MAX_FURIGANA_TEXT_LENGTH) {
                return () => {
                    cancelled = true;
                };
            }

            let pending = furiganaPending.get(cacheKey);
            if (!pending) {
                pending = invoke('get_furigana', { text, contextBefore, contextAfter })
                    .then((res) => {
                        const parsed = Array.isArray(res) ? res : [];
                        rememberFurigana(cacheKey, parsed);
                        return parsed;
                    })
                    .finally(() => {
                        furiganaPending.delete(cacheKey);
                    });
                furiganaPending.set(cacheKey, pending);
            }

            pending
                .then(res => {
                    if (!cancelled) setTokens(res);
                })
                .catch(() => {});
        } else if (mode !== 'auto') {
            setTokens(null);
        }

        return () => {
            cancelled = true;
        };
    }, [text, mode, contextBefore, contextAfter]);

    if (mode === 'auto') {
        return (
            <>
                {tokens ? tokens.map((t, idx) => t.reading ? (
                    <ruby key={idx} style={{ WebkitRubyPosition: 'over', rubyPosition: 'over' }}>
                        {highlightText(t.text, searchQuery)}
                        <rt style={{ fontSize: '0.55em', color: 'var(--text-main)', opacity: 0.85, fontWeight: 500, userSelect: 'none', lineHeight: 1 }}>
                            {t.reading}
                        </rt>
                    </ruby>
                ) : <span key={idx}>{highlightText(t.text, searchQuery)}</span>) : highlightText(text, searchQuery)}
            </>
        );
    }
    return <>{highlightText(text, searchQuery)}</>;
});

// Fetch morphological word tokens (surface + reading) for a line, sharing the
// same cache/in-flight map as FuriganaLine so segmentation and furigana reuse one call.
const useFuriganaTokens = (text: string, contextBefore: string, contextAfter: string): any[] | null => {
    const [tokens, setTokens] = useState<any[] | null>(() => {
        const cacheKey = `${text}${contextBefore}${contextAfter}`;
        return furiganaCache.get(cacheKey) ?? null;
    });

    useEffect(() => {
        let cancelled = false;
        const cacheKey = `${text}${contextBefore}${contextAfter}`;
        const cached = furiganaCache.get(cacheKey);
        if (cached) {
            setTokens(cached);
            return () => { cancelled = true; };
        }
        setTokens(null);
        if ((text.length + contextBefore.length + contextAfter.length) > MAX_FURIGANA_TEXT_LENGTH) {
            return () => { cancelled = true; };
        }
        let pending = furiganaPending.get(cacheKey);
        if (!pending) {
            pending = invoke('get_furigana', { text, contextBefore, contextAfter })
                .then((res) => {
                    const parsed = Array.isArray(res) ? res : [];
                    rememberFurigana(cacheKey, parsed);
                    return parsed;
                })
                .finally(() => { furiganaPending.delete(cacheKey); });
            furiganaPending.set(cacheKey, pending);
        }
        pending.then((res) => { if (!cancelled) setTokens(res); }).catch(() => {});
        return () => { cancelled = true; };
    }, [text, contextBefore, contextAfter]);

    return tokens;
};

const JAPANESE_TOKEN_RE = /[぀-ヿ㐀-鿿豈-﫿ｦ-ﾟー々〆ヶ]/;
const LATIN_TOKEN_RE = /[A-Za-zÀ-ɏ]/;
const KINSOKU_CLOSING_RE = /^[。、」』）］】〕〉》！？…・,.!?;:]+$/;
type RubySpan = { start: number; end: number; reading: string };
const epubRubySpanCache = new Map<string, RubySpan[]>();
const MAX_EPUB_RUBY_CACHE = 800;

const extractEpubRubySpans = (html?: string): RubySpan[] => {
    if (!html || !/<ruby\b/i.test(html)) return [];
    const cached = epubRubySpanCache.get(html);
    if (cached) return cached;
    const spans: RubySpan[] = [];
    try {
        const doc = new DOMParser().parseFromString(html, 'text/html');
        let offset = 0;
        const walk = (node: Node) => {
            if (node.nodeType === Node.TEXT_NODE) {
                offset += Array.from(node.textContent || '').length;
                return;
            }
            if (!(node instanceof HTMLElement)) return;
            const tag = node.tagName.toLowerCase();
            if (tag === 'rt' || tag === 'rp') return;
            if (tag === 'ruby') {
                const start = offset;
                const rtParts: string[] = [];
                node.childNodes.forEach((child) => {
                    if (child instanceof HTMLElement) {
                        const ctag = child.tagName.toLowerCase();
                        if (ctag === 'rt') {
                            const r = (child.textContent || '').trim();
                            if (r) rtParts.push(r);
                            return;
                        }
                        if (ctag === 'rp') return;
                    }
                    walk(child);
                });
                const reading = rtParts.join('');
                if (reading && offset > start) {
                    spans.push({ start, end: offset, reading });
                }
                return;
            }
            node.childNodes.forEach(walk);
        };
        walk(doc.body);
    } catch {
        // ignore parse errors
    }
    epubRubySpanCache.set(html, spans);
    while (epubRubySpanCache.size > MAX_EPUB_RUBY_CACHE) {
        const firstKey = epubRubySpanCache.keys().next().value;
        if (firstKey === undefined) break;
        epubRubySpanCache.delete(firstKey);
    }
    return spans;
};

const renderSurfaceWithEpubRuby = (
    surface: string,
    cursor: number,
    spans: RubySpan[],
    searchQuery: string,
): ReactNode => {
    if (spans.length === 0) return highlightText(surface, searchQuery);
    const chars = Array.from(surface);
    const tokenEnd = cursor + chars.length;
    const overlapping = spans.filter((s) => s.start < tokenEnd && s.end > cursor);
    if (overlapping.length === 0) return highlightText(surface, searchQuery);

    const out: ReactNode[] = [];
    let pos = cursor;
    for (let i = 0; i < overlapping.length; i += 1) {
        const span = overlapping[i];
        const segStart = Math.max(pos, span.start);
        const segEnd = Math.min(tokenEnd, span.end);
        if (segStart > pos) {
            out.push(highlightText(chars.slice(pos - cursor, segStart - cursor).join(''), searchQuery));
        }
        if (segEnd > segStart) {
            const base = chars.slice(segStart - cursor, segEnd - cursor).join('');
            out.push(
                <ruby key={`er-${i}-${segStart}`} style={{ WebkitRubyPosition: 'over', rubyPosition: 'over' }}>
                    {highlightText(base, searchQuery)}
                    <rt style={{ fontSize: '0.55em', color: 'var(--epub-fg, var(--text-main))', opacity: 0.85, fontWeight: 500, userSelect: 'none', lineHeight: 1 }}>
                        {span.reading}
                    </rt>
                </ruby>,
            );
            pos = segEnd;
        }
    }
    if (pos < tokenEnd) {
        out.push(highlightText(chars.slice(pos - cursor).join(''), searchQuery));
    }
    return <>{out}</>;
};

type LookupMatch = { start: number; length: number };
type LookupTokenHandler = (
    token: string,
    sentence: string,
    cursor: number,
    boundaries?: number[],
    lemma?: string,
) => LookupMatch | null | void | Promise<LookupMatch | null | void>;

export const TokenizedLine = ({ text, searchQuery, onLookupToken, furiganaMode = 'none', epubHtml, contextBefore = '', contextAfter = '', activeRange = null }: { text: string; searchQuery: string; onLookupToken?: LookupTokenHandler; furiganaMode?: string; epubHtml?: string; contextBefore?: string; contextAfter?: string; activeRange?: LookupMatch | null }) => {
    const tokens = useFuriganaTokens(text, contextBefore, contextAfter);
    const epubRubySpans = furiganaMode === 'epub' ? extractEpubRubySpans(epubHtml) : [];

    if (!onLookupToken) return <>{highlightText(text, searchQuery)}</>;

    // Word-level: render each analyzer token as a highlighted, tappable chip.
    if (tokens && tokens.length) {
        const showAutoRuby = furiganaMode === 'auto';
        const showEpubRuby = furiganaMode === 'epub' && epubRubySpans.length > 0;
        // Character offsets where analyzer words end; the lookup uses them to
        // avoid matches that stop in the middle of the next word.
        const boundaries = tokens
            .map((tk) => Number(tk?.end))
            .filter((value) => Number.isInteger(value) && value > 0);
        let searchFromCodeUnits = 0;
        const renderedItems: Array<{ key: string; node: ReactNode; isClosingPunct: boolean; isWord: boolean }> = [];
        tokens.forEach((tk, index) => {
            const surface = typeof tk?.text === 'string' ? tk.text : String(tk?.text ?? '');
            if (!surface) return;
            // Native segmentation returns Unicode character offsets. Falling back to
            // indexOf is only needed for older backends and cached legacy results.
            const nativeStart = Number(tk?.start);
            const found = text.indexOf(surface, searchFromCodeUnits);
            const fallbackStartCodeUnits = found >= 0 ? found : searchFromCodeUnits;
            const cursor = Number.isInteger(nativeStart) && nativeStart >= 0
                ? nativeStart
                : Array.from(text.slice(0, fallbackStartCodeUnits)).length;
            searchFromCodeUnits = fallbackStartCodeUnits + surface.length;

            const tappable = JAPANESE_TOKEN_RE.test(surface) || LATIN_TOKEN_RE.test(surface);
            if (!tappable) {
                renderedItems.push({
                    key: `plain-${index}-${cursor}`,
                    node: <span key={`plain-${index}-${cursor}`}>{highlightText(surface, searchQuery)}</span>,
                    isClosingPunct: KINSOKU_CLOSING_RE.test(surface),
                    isWord: false,
                });
                return;
            }

            const inner = showEpubRuby
                ? renderSurfaceWithEpubRuby(surface, cursor, epubRubySpans, searchQuery)
                : showAutoRuby && tk.reading ? (
                    <ruby style={{ WebkitRubyPosition: 'over', rubyPosition: 'over' }}>
                        {highlightText(surface, searchQuery)}
                        <rt style={{ fontSize: '0.55em', color: 'var(--text-main)', opacity: 0.85, fontWeight: 500, userSelect: 'none', lineHeight: 1 }}>{tk.reading}</rt>
                    </ruby>
                ) : highlightText(surface, searchQuery);

            const surfaceLength = Array.from(surface).length;
            const isActive = Boolean(activeRange
                && cursor < activeRange.start + activeRange.length
                && cursor + surfaceLength > activeRange.start);
            renderedItems.push({
                key: `word-${index}-${cursor}-${surface}`,
                node: (
                    <button
                        key={`word-${index}-${cursor}-${surface}`}
                        type="button"
                        className={isActive ? "lookup-word active" : "lookup-word"}
                        aria-label={surface}
                        onClick={(e) => {
                            e.stopPropagation();
                            onLookupToken(surface, text, cursor, boundaries, typeof tk?.lemma === 'string' ? tk.lemma : undefined);
                        }}
                    >
                        {inner}
                    </button>
                ),
                isClosingPunct: false,
                isWord: true,
            });
        });

        // Glue closing Japanese punctuation (。、」』！？ etc.) to the preceding word button
        // so browser line-breaking never orphans punctuation onto the next line or vertical column.
        const nodes: ReactNode[] = [];
        for (let i = 0; i < renderedItems.length; i += 1) {
            const item = renderedItems[i];
            if (item.isWord && i + 1 < renderedItems.length && renderedItems[i + 1].isClosingPunct) {
                const grouped: ReactNode[] = [item.node];
                let j = i + 1;
                while (j < renderedItems.length && renderedItems[j].isClosingPunct) {
                    grouped.push(renderedItems[j].node);
                    j += 1;
                }
                nodes.push(
                    <span key={`kp-${item.key}`} className="lookup-kinsoku-pair" style={{ whiteSpace: 'nowrap' }}>
                        {grouped}
                    </span>,
                );
                i = j - 1;
            } else {
                nodes.push(item.node);
            }
        }
        return <>{nodes}</>;
    }

    // Keep lookup available while Rust segmentation loads or when it returns no
    // tokens. The fallback groups scripts into stable word-like chunks rather
    // than creating a button for every character.
    return <>{tokenizeLookupText(text).map((part, index) => {
        const renderedPart = furiganaMode === 'epub' && epubRubySpans.length > 0
            ? renderSurfaceWithEpubRuby(part.text, part.cursor, epubRubySpans, searchQuery)
            : highlightText(part.text, searchQuery);
        if (!part.lookup) {
            return <span key={`fallback-plain-${part.cursor}-${index}`}>{renderedPart}</span>;
        }
        const partLength = Array.from(part.text).length;
        const isActive = Boolean(activeRange
            && part.cursor < activeRange.start + activeRange.length
            && part.cursor + partLength > activeRange.start);
        return (
            <button
                key={`fallback-word-${part.cursor}-${index}-${part.text}`}
                type="button"
                className={isActive ? "lookup-word active" : "lookup-word"}
                aria-label={part.text}
                onClick={(event) => {
                    event.stopPropagation();
                    onLookupToken(part.text, text, part.cursor);
                }}
            >
                {renderedPart}
            </button>
        );
    })}</>;
};

const TextLineItem = memo(function TextLineItem({ line, index, suppliedFurigana, onDelete, onEdit, furiganaMode, searchQuery, isActiveSearchMatch, contextBefore = "", contextAfter = "", language = 'ru', onLookupToken, onTokenTap, activeToken, onExplain, onStartSelect, selectMode = false, selected = false, onToggleSelect, readOnly = false }: any) {
    const [isHovered, setIsHovered] = useState(false);
    const [isCopied, setIsCopied] = useState(false);
    const [isEditing, setIsEditing] = useState(false);
    const textRef = useRef<HTMLDivElement>(null);
    const t = getTranslator(language);

    const handleCopy = async () => {
        try { await writeText(line); setIsCopied(true); setTimeout(() => setIsCopied(false), 2000); } 
        catch (error) {
            try { await navigator.clipboard.writeText(line); setIsCopied(true); setTimeout(() => setIsCopied(false), 2000); } catch (e) {}
        }
    };

    const btnStyle = { background: 'var(--surface-2, var(--hover-bg))', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', width: '30px', height: '30px', padding: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: '9px', transition: 'background-color 0.15s, color 0.15s' };

    const bgColor = selected
        ? 'rgba(79, 166, 255, 0.16)'
        : isActiveSearchMatch
        ? 'rgba(79, 166, 255, 0.15)' 
        : (isHovered || isEditing ? 'var(--hover-bg)' : 'transparent');
    const showActions = !selectMode && (isHovered || isEditing || isActiveSearchMatch);

    return (
        <div className={`text-line-wrapper${selectMode ? ' is-selectable' : ''}${selected ? ' is-selected' : ''}`} data-line-index={index} data-raw-text={line} onMouseEnter={() => setIsHovered(true)} onMouseLeave={() => setIsHovered(false)} onClickCapture={selectMode ? (e) => { e.preventDefault(); e.stopPropagation(); onToggleSelect?.(index); } : undefined} style={{ display: 'flex', flexDirection: 'column', alignItems: 'stretch', width: 'fit-content', maxWidth: '100%', boxSizing: 'border-box', margin: 0, padding: '6px 10px', borderRadius: '8px', backgroundColor: bgColor, boxShadow: selected ? 'inset 0 0 0 1px rgba(79, 166, 255, 0.55)' : selectMode && isHovered ? 'inset 0 0 0 1px var(--border-main)' : 'none', cursor: selectMode ? 'pointer' : undefined, userSelect: selectMode ? 'none' : undefined, transition: 'background-color 0.2s, box-shadow 0.2s', position: 'relative' }}>
            
            <div 
                ref={textRef}
                contentEditable={isEditing}
                suppressContentEditableWarning={true}
                onBlur={(e) => {
                    // Focus also leaves descendant lookup buttons. Never replace
                    // their React DOM with plain text when the line isn't being edited.
                    if (!isEditing || e.target !== e.currentTarget) return;
                    setIsEditing(false);
                    const newText = e.currentTarget.innerText.trim();
                    if (newText !== line && newText !== "") onEdit(index, newText);
                    else e.currentTarget.innerText = line; 
                }}
                onKeyDown={(e) => {
                    if (!isEditing || e.target !== e.currentTarget) return;
                    if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault();
                        e.currentTarget.blur();
                    } else if (e.key === 'Escape') {
                        setIsEditing(false);
                        if (textRef.current) textRef.current.innerText = line;
                    }
                }}
                className="text-line" 
                style={{ 
                    display: 'block', width: 'fit-content', maxWidth: '100%', boxSizing: 'border-box', fontSize: 'var(--txt-font-size, 26px)', fontFamily: `var(--txt-font-family, 'Noto Serif JP'), ${jpSerifFallback}`,
                    lineHeight: '1.9', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', wordBreak: 'break-word', color: 'var(--text-main)',
                    fontSynthesis: 'none', fontVariantNumeric: 'tabular-nums', textRendering: 'optimizeLegibility',
                    outline: isEditing ? '2px dashed var(--accent-blue)' : 'none',
                    padding: isEditing ? '2px 6px' : '0', borderRadius: '4px'
                }}
            >
                {isEditing ? line : suppliedFurigana && !onLookupToken ? (
                    <SuppliedFuriganaLine text={line} supplied={suppliedFurigana} searchQuery={searchQuery} />
                ) : (
                    onLookupToken ? (
                        <TokenizedLine
                            text={line}
                            searchQuery={searchQuery}
                            onLookupToken={onTokenTap ? (token: string, sentence: string, cursor: number, boundaries?: number[], lemma?: string) => onTokenTap(index, token, sentence, cursor, boundaries, lemma) : onLookupToken}
                            furiganaMode={furiganaMode}
                            contextBefore={contextBefore}
                            contextAfter={contextAfter}
                            activeRange={activeToken && activeToken.line === index
                                ? { start: activeToken.start, length: activeToken.length }
                                : null}
                        />
                    ) : (
                        <FuriganaLine
                            text={line}
                            mode={furiganaMode}
                            searchQuery={searchQuery}
                            contextBefore={contextBefore}
                            contextAfter={contextAfter}
                        />
                    )
                )}
            </div>

            <span className="text-line-actions" contentEditable={false} style={{ opacity: showActions ? 1 : 0, pointerEvents: showActions ? 'auto' : 'none', display: 'inline-flex', alignSelf: 'flex-end', flexShrink: 0, gap: '6px', marginTop: '4px', transition: 'opacity 0.2s' }}>
                {!isEditing && onExplain && <button onClick={() => onExplain(index)} style={{ ...btnStyle, color: 'var(--accent-blue)' }} title={language === 'en' ? 'Explain with AI' : 'Объяснить (ИИ)'}><IconSparkle size={16} /></button>}
                {!isEditing && onStartSelect && <button onClick={() => onStartSelect(index)} style={btnStyle} title={language === 'en' ? 'Pick several lines to explain together' : 'Выбрать несколько строк для объяснения'}><IconChecklist /></button>}
                {!isEditing && <button onClick={handleCopy} style={btnStyle} title={t('common.copy')}>{isCopied ? <IconCheck /> : <IconCopy />}</button>}
                {!readOnly && <button 
                    onClick={() => {
                        if (isEditing) textRef.current?.blur();
                        else { setIsEditing(true); setTimeout(() => textRef.current?.focus(), 50); }
                    }} 
                    style={{...btnStyle, background: isEditing ? 'var(--accent-blue)' : btnStyle.background, color: isEditing ? '#fff' : btnStyle.color}} 
                    title={t('common.edit')}
                >
                    <IconEdit />
                </button>}
                {!isEditing && !readOnly && <button onClick={() => onDelete(index)} style={{ ...btnStyle, color: 'var(--danger, #ff6b6b)', background: 'color-mix(in srgb, var(--danger, #ff6b6b) 12%, transparent)' }} title={t('common.delete')}><IconDelete /></button>}
            </span>
        </div>
    );
});

const TextContainer = memo(function TextContainer({ contentKey, lines = [], lineFurigana = [], isFlashing = false, onDelete, onEdit, furiganaMode, autoScrollOffset = 80, searchQuery = "", activeSearchLineIdx = -1, searchTrigger = 0, panelPosition = 'bottom', language = 'ru', textOrientation = 'horizontal', readerProgress = 0, onReaderProgress, onLookupToken, lookupActive = false, onExplainLines, readOnly = false }: any) {
  const parentRef = useRef<HTMLDivElement>(null);
  // AI explanations: one line from its button, or several picked in selection mode.
  const [selectMode, setSelectMode] = useState(false);
  const [selectedLines, setSelectedLines] = useState<number[]>([]);
  const explainLine = useCallback((index: number) => onExplainLines?.([index]), [onExplainLines]);
  const startSelect = useCallback((index: number) => { setSelectMode(true); setSelectedLines([index]); }, []);
  const toggleSelectLine = useCallback((index: number) => {
      setSelectedLines((prev) => prev.includes(index)
          ? prev.filter((value) => value !== index)
          : prev.length >= MAX_AI_SELECTION ? prev : [...prev, index]);
  }, []);
  const cancelSelect = useCallback(() => { setSelectMode(false); setSelectedLines([]); }, []);
  const explainSelected = useCallback(() => {
      if (!selectedLines.length) return;
      onExplainLines?.([...selectedLines].sort((a, b) => a - b));
      setSelectMode(false);
      setSelectedLines([]);
  }, [onExplainLines, selectedLines]);
  useEffect(() => {
      if (!selectMode) return;
      const onKey = (event: KeyboardEvent) => {
          if (event.key === 'Escape') { event.stopPropagation(); cancelSelect(); }
          else if (event.key === 'Enter') { event.preventDefault(); explainSelected(); }
      };
      window.addEventListener('keydown', onKey, true);
      return () => window.removeEventListener('keydown', onKey, true);
  }, [selectMode, cancelSelect, explainSelected]);
  useEffect(() => { if (!onExplainLines) cancelSelect(); }, [onExplainLines, cancelSelect]);
  useEffect(() => { cancelSelect(); }, [contentKey, cancelSelect]);
  // Which word is currently looked up — held highlighted while the popup is open, cleared on close.
  const [activeToken, setActiveToken] = useState<{ line: number; start: number; length: number } | null>(null);
  const lookupRequestRef = useRef(0);
  const lookupActiveRef = useRef(lookupActive);
  useEffect(() => { lookupActiveRef.current = lookupActive; }, [lookupActive]);
  // Switching tabs cross-fades the text instead of swapping it abruptly.
  const firstContentKeyRef = useRef(true);
  useEffect(() => {
    if (firstContentKeyRef.current) { firstContentKeyRef.current = false; return; }
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    parentRef.current?.animate(
      [{ opacity: 0, transform: 'translateY(10px)' }, { opacity: 1, transform: 'none' }],
      { duration: 360, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' },
    );
  }, [contentKey]);
  // Freshly hooked lines rise in softly instead of popping into place.
  const lineCountRef = useRef({ key: contentKey, count: lines.length });
  useEffect(() => {
    const previous = lineCountRef.current;
    lineCountRef.current = { key: contentKey, count: lines.length };
    if (previous.key !== contentKey) return;
    const added = lines.length - previous.count;
    if (added <= 0 || added > 5) return;
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    const frame = requestAnimationFrame(() => {
      for (let index = previous.count; index < lines.length; index += 1) {
        const line = parentRef.current?.querySelector<HTMLElement>(`[data-index="${index}"] .text-line, .text-line[data-index="${index}"]`);
        line?.animate(
          [
            { opacity: 0, translate: '0 14px', filter: 'blur(3px)' },
            { opacity: 1, translate: '0 0', filter: 'blur(0)' },
          ],
          { duration: 460, easing: 'cubic-bezier(0.3, 1.18, 0.5, 1)' },
        );
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [lines.length, contentKey]);
  useEffect(() => { if (!lookupActive) setActiveToken(null); }, [lookupActive]);
  // If a tapped word finds no dictionary entry, don't leave it highlighted forever —
  // clear the highlight shortly after if no popup opened.
  useEffect(() => {
      if (!activeToken) return;
      const timer = setTimeout(() => { if (!lookupActiveRef.current) setActiveToken(null); }, 750);
      return () => clearTimeout(timer);
  }, [activeToken]);
  const handleTokenTap = useCallback(async (lineIndex: number, token: string, sentence: string, cursor: number, boundaries?: number[], lemma?: string) => {
      const requestId = ++lookupRequestRef.current;
      setActiveToken({ line: lineIndex, start: cursor, length: Array.from(token).length });
      try {
          const match = await onLookupToken?.(token, sentence, cursor, boundaries, lemma);
          if (requestId !== lookupRequestRef.current) return;
          if (!match || match.length <= 0) {
              if (!lookupActiveRef.current) setActiveToken(null);
              return;
          }
          setActiveToken({ line: lineIndex, start: match.start, length: match.length });
      } catch {
          if (requestId === lookupRequestRef.current && !lookupActiveRef.current) {
              setActiveToken(null);
          }
      }
  }, [onLookupToken]);
  // On mobile the lookup opens as a bottom sheet; lift the tapped word near the top so it
  // stays visible above the sheet instead of being covered by it.
  useEffect(() => {
      if (!activeToken || !lookupActive) return;
      const raf = requestAnimationFrame(() => {
          const container = parentRef.current;
          const el = container?.querySelector('.lookup-word.active') as HTMLElement | null;
          if (!container || !el) return;
          const elRect = el.getBoundingClientRect();
          const contRect = container.getBoundingClientRect();
          const target = contRect.top + container.clientHeight * 0.14;
          const delta = elRect.top - target;
          if (Math.abs(delta) > 8) container.scrollBy({ top: delta, behavior: 'smooth' });
      });
      return () => cancelAnimationFrame(raf);
  }, [activeToken, lookupActive]);
  const prevLinesLengthRef = useRef(lines.length);
  const previousContentKeyRef = useRef<any>(null);
  const shouldFollowTailRef = useRef(true);
  const lastProgressUpdateRef = useRef(0);
  const lastShowScrollBottomRef = useRef(false);
  const [showScrollBottom, setShowScrollBottom] = useState(false);
  const t = getTranslator(language);
  const isVertical = textOrientation === 'vertical';

  const rowVirtualizer = useVirtualizer({
    count: lines.length > 0 ? lines.length + (isVertical ? 0 : 1) : 0,
    getScrollElement: () => parentRef.current,
    horizontal: isVertical,
    isRtl: isVertical,
    // ResizeObserver's inlineSize is height for vertical-rl text; the
    // horizontal virtualizer needs the physical column width instead.
    measureElement: (element) => isVertical ? (element as HTMLElement).offsetWidth : (element as HTMLElement).offsetHeight,
    gap: isVertical ? 18 : 0,
    scrollToFn: (offset, { adjustments = 0, behavior }, instance) => {
        instance.scrollElement?.scrollTo({
            [isVertical ? 'left' : 'top']: (offset + adjustments) * (isVertical ? -1 : 1),
            behavior,
        });
    },
    estimateSize: (index) => {
        if (index === lines.length) {
            const bottomSpace = 100 - clampAutoScrollOffset(autoScrollOffset);
            const viewportHeight = parentRef.current?.clientHeight || window.innerHeight;
            return viewportHeight * (bottomSpace / 100);
        }
        const text = String(lines[index] || "");
        const containerWidth = parentRef.current?.clientWidth || window.innerWidth || 900;
        const fontSize = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--txt-font-size')) || 26;
        if (isVertical) {
            const height = parentRef.current?.clientHeight || window.innerHeight;
            const charsPerColumn = Math.max(1, Math.floor((height - 80) / fontSize));
            return Math.max(1, Math.ceil(Array.from(text).length / charsPerColumn)) * fontSize * 1.9 + 4;
        }
        const charsPerLine = Math.max(12, Math.floor((containerWidth - 90) / Math.max(12, fontSize * 0.82)));
        const visualLines = Math.max(1, Math.ceil(text.length / charsPerLine));
        return Math.max(76, visualLines * fontSize * 1.95 + 30);
    },
    overscan: 10,
    getItemKey: (index) => {
        if (index === lines.length) return 'spacer';
        const line = String(lines[index] || '');
        return `${index}:${line.length}:${line.slice(0, 48)}`;
    },
  });

  useEffect(() => {
      const timer = window.setTimeout(() => {
          rowVirtualizer.measure();
          if (shouldFollowTailRef.current && activeSearchLineIdx < 0 && lines.length > 0) {
              rowVirtualizer.scrollToIndex(isVertical ? lines.length - 1 : lines.length, { align: 'end' });
          }
      }, 120);
      const fonts = (document as any).fonts;
      if (fonts?.ready) {
          fonts.ready.then(() => rowVirtualizer.measure()).catch(() => {});
      }
      return () => window.clearTimeout(timer);
  }, [isVertical, lines.length, rowVirtualizer]);

  useEffect(() => {
      const el = parentRef.current;
      if (!el) return;
      let frame = 0;
      const observer = new ResizeObserver(() => {
          window.cancelAnimationFrame(frame);
          frame = window.requestAnimationFrame(() => rowVirtualizer.measure());
      });
      observer.observe(el);
      return () => {
          window.cancelAnimationFrame(frame);
          observer.disconnect();
      };
  }, [isVertical, rowVirtualizer]);

  useLayoutEffect(() => {
      if (previousContentKeyRef.current === contentKey) return;
      previousContentKeyRef.current = contentKey;
      shouldFollowTailRef.current = true;
      prevLinesLengthRef.current = lines.length;
      rowVirtualizer.measure();

      const frame = window.requestAnimationFrame(() => {
          const el = parentRef.current;
          if (!el) return;
          if (lines.length > 0) rowVirtualizer.scrollToIndex(isVertical ? lines.length - 1 : lines.length, { align: 'end' });
      });
      return () => window.cancelAnimationFrame(frame);
  }, [contentKey, isVertical, lines.length]);

  // Reading position anchor: the first visible line and how far into it the
  // view is. Changing the text font or size re-measures every row; without the
  // anchor the pixel offset stayed put and the view jumped to other lines.
  const readingAnchorRef = useRef<{ index: number; ratio: number } | null>(null);
  const restoringAnchorRef = useRef(false);
  const captureReadingAnchor = (scrollTop: number) => {
      if (restoringAnchorRef.current || isVertical) return;
      const first = rowVirtualizer.getVirtualItems().find((item) => item.end > scrollTop);
      readingAnchorRef.current = first
          ? { index: first.index, ratio: Math.min(1, Math.max(0, (scrollTop - first.start) / Math.max(1, first.size))) }
          : null;
  };
  // Puts the anchor line back at the top. Uses the measured row positions only:
  // calling measure() here reset every row to its estimated height, which made
  // the view jump (or go blank) on every step of the font-size slider.
  const applyReadingAnchor = () => {
      const anchor = readingAnchorRef.current;
      const el = parentRef.current;
      if (!anchor || !el || shouldFollowTailRef.current) return;
      const item = rowVirtualizer.measurementsCache[anchor.index];
      if (!item) return;
      const target = item.start + anchor.ratio * item.size;
      if (Math.abs(el.scrollTop - target) > 0.5) el.scrollTop = target;
  };
  // Rows re-measure themselves (ResizeObserver) when the text size changes and
  // each re-measure re-renders; correcting before paint keeps the line still.
  useLayoutEffect(() => {
      if (restoringAnchorRef.current) applyReadingAnchor();
  });
  // While anchoring, the virtualizer must not shift the scroll on its own.
  rowVirtualizer.shouldAdjustScrollPositionOnItemSizeChange = (item, _delta, instance) =>
      !restoringAnchorRef.current && item.start < (instance.scrollOffset ?? 0);
  useEffect(() => {
      if (isVertical) return;
      const root = document.documentElement;
      const readMetrics = () => `${root.style.getPropertyValue('--txt-font-family')}|${root.style.getPropertyValue('--txt-font-size')}`;
      let metrics = readMetrics();
      const timers: number[] = [];
      const holdAnchor = (ms: number) => {
          restoringAnchorRef.current = true;
          timers.forEach((timer) => window.clearTimeout(timer));
          timers.length = 0;
          window.requestAnimationFrame(applyReadingAnchor);
          timers.push(window.setTimeout(() => { restoringAnchorRef.current = false; }, ms));
      };
      const observer = new MutationObserver(() => {
          const next = readMetrics();
          if (next === metrics) return;
          metrics = next;
          if (shouldFollowTailRef.current || !readingAnchorRef.current) return;
          holdAnchor(600);
          // A newly chosen family may still be loading; hold again once it lands.
          const fonts = (document as any).fonts;
          fonts?.ready?.then(() => { if (readMetrics() === metrics) holdAnchor(400); }).catch(() => {});
      });
      observer.observe(root, { attributes: true, attributeFilter: ['style'] });
      return () => {
          observer.disconnect();
          timers.forEach((timer) => window.clearTimeout(timer));
      };
  }, [isVertical, rowVirtualizer]);

  const updateShowScrollBottom = (value: boolean) => {
      if (lastShowScrollBottomRef.current === value) return;
      lastShowScrollBottomRef.current = value;
      setShowScrollBottom(value);
  };

  const handleScroll = (e: React.UIEvent<HTMLDivElement>) => {
      const target = e.currentTarget;
      const now = Date.now();
      const emitProgress = (value: number) => {
          if (!onReaderProgress || now - lastProgressUpdateRef.current < 350) return;
          lastProgressUpdateRef.current = now;
          onReaderProgress(value);
      };
      if (isVertical) {
          const max = Math.max(1, target.scrollWidth - target.clientWidth);
          const progress = Math.min(1, Math.max(0, Math.abs(target.scrollLeft) / max));
          shouldFollowTailRef.current = progress >= 0.98;
          emitProgress(progress);
          updateShowScrollBottom(progress < 0.98 && lines.length > 0);
          return;
      }
      const isNearBottom = target.scrollHeight - target.scrollTop - target.clientHeight < 150;
      captureReadingAnchor(target.scrollTop);
      if (restoringAnchorRef.current) return;
      shouldFollowTailRef.current = isNearBottom;
      const max = Math.max(1, target.scrollHeight - target.clientHeight);
      emitProgress(Math.min(1, Math.max(0, target.scrollTop / max)));
      updateShowScrollBottom(!isNearBottom && lines.length > 0);
  };

  const scrollToBottom = () => {
      shouldFollowTailRef.current = true;
      if (isVertical) {
          rowVirtualizer.scrollToIndex(Math.max(0, lines.length - 1), { align: 'end' });
          updateShowScrollBottom(false);
          return;
      }
      const el = parentRef.current;
      if (el) {
          el.scrollTop = el.scrollHeight;
      }
      setTimeout(() => {
          const nextEl = parentRef.current;
          if (nextEl) nextEl.scrollTop = nextEl.scrollHeight;
      }, 50);
  };

  const handleCopySelection = useCallback((event: ReactClipboardEvent<HTMLDivElement>) => {
      const selection = window.getSelection();
      const container = parentRef.current;
      if (!container || !selection || selection.isCollapsed || selection.rangeCount === 0) return;

      const range = selection.getRangeAt(0);
      const selectedRows = Array.from(container.querySelectorAll<HTMLElement>('.text-line-wrapper[data-raw-text]'))
          .filter((row) => {
              try { return range.intersectsNode(row); } catch { return false; }
          })
          .sort((left, right) => Number(left.dataset.lineIndex || 0) - Number(right.dataset.lineIndex || 0));

      if (selectedRows.length < 2) return;
      const cleanText = selectedRows
          .map((row) => row.dataset.rawText || '')
          .filter(Boolean)
          .join('\n\n');
      if (!cleanText) return;

      event.preventDefault();
      event.clipboardData.setData('text/plain', cleanText);
  }, []);

  useEffect(() => {
      const isNewText = lines.length > prevLinesLengthRef.current;
      prevLinesLengthRef.current = lines.length;

      if (isVertical) return;

      if (isNewText && activeSearchLineIdx === -1 && shouldFollowTailRef.current) {
          const timer = setTimeout(() => {
              const el = parentRef.current;
              if (el) el.scrollTop = el.scrollHeight;
          }, 50);
          return () => clearTimeout(timer);
      }
  }, [lines.length, activeSearchLineIdx, isVertical, rowVirtualizer, autoScrollOffset]);

  useLayoutEffect(() => {
      if (activeSearchLineIdx >= 0 && activeSearchLineIdx < lines.length) {
          shouldFollowTailRef.current = false;
          rowVirtualizer.scrollToIndex(activeSearchLineIdx, { align: 'center' });
          const timer = window.setTimeout(() => {
              rowVirtualizer.scrollToIndex(activeSearchLineIdx, { align: 'center' });
              const retryTarget = parentRef.current?.querySelector(`[data-index="${activeSearchLineIdx}"]`) as HTMLElement | null;
              retryTarget?.scrollIntoView({ block: 'center', inline: 'center' });
          }, 80);
          return () => window.clearTimeout(timer);
      }
  }, [activeSearchLineIdx, searchTrigger, lines.length, isVertical, rowVirtualizer]);

  // Вычисляем отступ кнопки от нижнего края в зависимости от положения панели
  const buttonBottomOffset = panelPosition === 'bottom' ? '70px' : '30px';

  useEffect(() => {
      const el = parentRef.current;
      if (!el || lines.length === 0 || readerProgress <= 0) return;
      const timer = setTimeout(() => {
          if (isVertical) {
              const max = Math.max(0, el.scrollWidth - el.clientWidth);
              el.scrollLeft = -max * readerProgress;
          } else {
              const max = Math.max(0, el.scrollHeight - el.clientHeight);
              el.scrollTop = max * readerProgress;
          }
      }, 80);
      return () => clearTimeout(timer);
  }, [isVertical, lines.length]);

  useEffect(() => {
      if (!isVertical || lines.length === 0 || activeSearchLineIdx >= 0 || !shouldFollowTailRef.current) return;
      const el = parentRef.current;
      if (!el) return;
      const frame = requestAnimationFrame(() => {
          rowVirtualizer.scrollToIndex(lines.length - 1, { align: 'end' });
          updateShowScrollBottom(false);
      });
      return () => cancelAnimationFrame(frame);
  }, [isVertical, lines.length, activeSearchLineIdx]);

  if (isVertical) {
      const verticalFuriganaMode = 'none';
      const columns = rowVirtualizer.getVirtualItems();
      const first = columns[0];
      const last = columns[columns.length - 1];
      const before = first?.start || 0;
      const after = last ? Math.max(0, rowVirtualizer.getTotalSize() - last.end) : 0;

      return (
        <div ref={parentRef} onScroll={handleScroll} className={`text-container ${isFlashing ? 'flash' : ''}`} style={{ padding: panelPosition === 'top-right' ? '28px 28px 28px 190px' : '28px', overflowX: 'auto', overflowY: 'hidden', flex: 1, position: 'relative', direction: 'rtl' }}>
            <div style={{ height: '100%', display: 'flex', direction: 'rtl', width: `${rowVirtualizer.getTotalSize()}px` }}>
                {before > 0 && <div aria-hidden="true" style={{ flex: `0 0 ${before}px` }} />}
                {columns.map((column) => {
                    const index = column.index;
                    const line = lines[index];
                    return (
                    <div ref={rowVirtualizer.measureElement} className="text-line" data-index={index} data-raw-text={line} key={column.key} style={{ writingMode: 'vertical-rl', textOrientation: 'mixed', direction: 'ltr', flex: '0 0 auto', height: '100%', boxSizing: 'border-box', marginLeft: index < lines.length - 1 ? '18px' : 0, padding: '8px 2px', borderRadius: '6px', color: 'var(--text-main)', fontSize: 'var(--txt-font-size, 26px)', fontFamily: `var(--txt-font-family, 'Noto Serif JP'), ${jpSerifFallback}`, lineHeight: 1.9, letterSpacing: '0', fontSynthesis: 'none', fontVariantNumeric: 'tabular-nums', textRendering: 'optimizeLegibility', background: index === activeSearchLineIdx ? 'rgba(79, 166, 255, 0.15)' : 'transparent' }}>
                        <FuriganaLine
                            text={line}
                            mode={verticalFuriganaMode}
                            searchQuery={searchQuery}
                            contextBefore={lines.slice(Math.max(0, index - 3), index).join('')}
                            contextAfter={lines.slice(index + 1, index + 4).join('')}
                        />
                    </div>
                    );
                })}
                {after > 0 && <div aria-hidden="true" style={{ flex: `0 0 ${Math.max(0, after - 18)}px` }} />}
            </div>
            {showScrollBottom && (
                <button onClick={scrollToBottom} style={{ position: 'fixed', bottom: buttonBottomOffset, right: '30px', width: '44px', height: '44px', borderRadius: '50%', background: 'var(--accent-blue)', color: '#fff', border: 'none', boxShadow: '0 4px 12px rgba(0,0,0,0.3)', cursor: 'pointer', zIndex: 100, display: 'flex', alignItems: 'center', justifyContent: 'center' }} title={language === 'en' ? 'Scroll to end' : 'К концу текста'}>
                    <IconArrowDown />
                </button>
            )}
        </div>
      );
  }

  const virtualRows = rowVirtualizer.getVirtualItems();
  const firstVirtualRow = virtualRows[0];
  const lastVirtualRow = virtualRows[virtualRows.length - 1];
  const virtualPaddingTop = firstVirtualRow?.start || 0;
  const virtualPaddingBottom = lastVirtualRow
      ? Math.max(0, rowVirtualizer.getTotalSize() - lastVirtualRow.end)
      : 0;

  return (
    <div ref={parentRef} onScroll={handleScroll} onCopy={handleCopySelection} className={`text-container ${isFlashing ? 'flash' : ''}`} style={{ padding: '20px', overflowY: 'auto', flex: 1, position: 'relative' }}>
      <div style={{ width: '100%', minHeight: '100%' }}>
        {virtualPaddingTop > 0 && <div aria-hidden="true" style={{ height: `${virtualPaddingTop}px` }} />}
        {virtualRows.map((virtualRow) => {
            const index = virtualRow.index;
            const isSpacer = index === lines.length;
            const viewportHeight = parentRef.current?.clientHeight || window.innerHeight;
            const spacerHeight = viewportHeight * ((100 - clampAutoScrollOffset(autoScrollOffset)) / 100);
            return (
                <div
                    key={virtualRow.key}
                    ref={rowVirtualizer.measureElement}
                    data-index={index}
                    style={{
                        width: '100%',
                        height: isSpacer ? `${spacerHeight}px` : undefined,
                        paddingBottom: isSpacer ? 0 : '14px',
                        boxSizing: 'border-box',
                        display: 'flow-root',
                    }}
                >
                    {!isSpacer && (
                        <TextLineItem
                            line={lines[index]}
                            index={index}
                            suppliedFurigana={lineFurigana[index]}
                            onDelete={onDelete}
                            onEdit={onEdit}
                            furiganaMode={furiganaMode}
                            searchQuery={searchQuery}
                            isActiveSearchMatch={index === activeSearchLineIdx}
                            contextBefore={lines.slice(Math.max(0, index - 3), index).join('')}
                            contextAfter={lines.slice(index + 1, index + 4).join('')}
                            language={language}
                            onLookupToken={onLookupToken}
                            onTokenTap={handleTokenTap}
                            activeToken={activeToken}
                            onExplain={onExplainLines ? explainLine : undefined}
                            onStartSelect={onExplainLines ? startSelect : undefined}
                            selectMode={selectMode}
                            selected={selectMode && selectedLines.includes(index)}
                            onToggleSelect={toggleSelectLine}
                            readOnly={readOnly}
                        />
                    )}
                </div>
            );
        })}
        {virtualPaddingBottom > 0 && <div aria-hidden="true" style={{ height: `${virtualPaddingBottom}px` }} />}
      </div>

      {selectMode && (
          <div className="ai-select-bar" role="toolbar" aria-label={language === 'en' ? 'Pick lines' : 'Выбор строк'}>
              <span className="ai-select-count">
                  {language === 'en'
                      ? `${selectedLines.length} ${selectedLines.length === 1 ? 'line' : 'lines'} picked`
                      : `Выбрано строк: ${selectedLines.length}`}
                  {selectedLines.length >= MAX_AI_SELECTION && <em>{language === 'en' ? ` (max ${MAX_AI_SELECTION})` : ` (максимум ${MAX_AI_SELECTION})`}</em>}
              </span>
              <button type="button" className="ai-select-primary" disabled={!selectedLines.length} onClick={explainSelected}>
                  <IconSparkle size={15} /> {language === 'en' ? 'Explain together' : 'Объяснить вместе'}
              </button>
              <button type="button" className="ai-select-cancel" onClick={cancelSelect}>{language === 'en' ? 'Cancel' : 'Отмена'}</button>
          </div>
      )}

      {showScrollBottom && (
          <button
              onClick={scrollToBottom}
              style={{
                  position: 'fixed', bottom: buttonBottomOffset, right: '30px',
                  background: 'var(--bg-panel)', color: 'var(--text-main)', border: '1px solid var(--border-main)',
                  borderRadius: '50%', width: '45px', height: '45px', cursor: 'pointer',
                  boxShadow: '0 4px 12px rgba(0,0,0,0.4)', zIndex: 1000,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  opacity: 0.9, transition: '0.2s bottom' // Плавная анимация при смене позиции
              }}
              title={t('common.down')}
          >
              <IconArrowDown />
          </button>
      )}
    </div>
  );
});

export default TextContainer;
