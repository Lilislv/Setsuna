import { useEffect, useRef, useState, useCallback, memo, useLayoutEffect, type ReactNode } from "react";
import { invoke } from '@tauri-apps/api/core';
import { writeText } from '@tauri-apps/plugin-clipboard-manager';
import { useVirtualizer } from '@tanstack/react-virtual';
import { getTranslator } from '../utils/i18n';
import { tokenizeLookupText } from '../utils/appRuntime';

const IconCopy = () => <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>;
const IconCheck = () => <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#4CAF50" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>;
const IconDelete = () => <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>;
const IconEdit = () => <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg>;
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

const FuriganaLine = memo(({ text, mode, searchQuery, contextBefore = "", contextAfter = "" }: { text: string, mode: string, searchQuery: string, contextBefore?: string, contextAfter?: string }) => {
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

const TokenizedLine = ({ text, searchQuery, onLookupToken, furiganaMode = 'none', contextBefore = '', contextAfter = '', activeCursor = null }: { text: string; searchQuery: string; onLookupToken?: (token: string, sentence: string, cursor: number) => void; furiganaMode?: string; contextBefore?: string; contextAfter?: string; activeCursor?: number | null }) => {
    const tokens = useFuriganaTokens(text, contextBefore, contextAfter);

    if (!onLookupToken) return <>{highlightText(text, searchQuery)}</>;

    // Word-level: render each analyzer token as a highlighted, tappable chip.
    if (tokens && tokens.length) {
        const showRuby = furiganaMode === 'auto';
        let searchFrom = 0;
        const nodes: ReactNode[] = tokens.map((tk, index) => {
            const surface = typeof tk?.text === 'string' ? tk.text : String(tk?.text ?? '');
            if (!surface) return null;
            // Native segmentation returns Unicode character offsets. Falling back to
            // indexOf is only needed for older backends and cached legacy results.
            const nativeStart = Number(tk?.start);
            const found = text.indexOf(surface, searchFrom);
            const cursor = Number.isInteger(nativeStart) && nativeStart >= 0
                ? nativeStart
                : (found >= 0 ? found : searchFrom);
            searchFrom = (found >= 0 ? found : searchFrom) + surface.length;

            const tappable = JAPANESE_TOKEN_RE.test(surface) || LATIN_TOKEN_RE.test(surface);
            if (!tappable) {
                return <span key={`plain-${index}-${cursor}`}>{highlightText(surface, searchQuery)}</span>;
            }

            const inner = showRuby && tk.reading ? (
                <ruby style={{ WebkitRubyPosition: 'over', rubyPosition: 'over' }}>
                    {highlightText(surface, searchQuery)}
                    <rt style={{ fontSize: '0.55em', color: 'var(--text-main)', opacity: 0.85, fontWeight: 500, userSelect: 'none', lineHeight: 1 }}>{tk.reading}</rt>
                </ruby>
            ) : highlightText(surface, searchQuery);

            const isActive = activeCursor != null && cursor === activeCursor;
            return (
                <button
                    key={`word-${index}-${cursor}-${surface}`}
                    type="button"
                    className={isActive ? "lookup-word active" : "lookup-word"}
                    onClick={(e) => {
                        e.stopPropagation();
                        onLookupToken(surface, text, cursor);
                    }}
                >
                    {inner}
                </button>
            );
        });
        return <>{nodes}</>;
    }

    // Keep lookup available while Rust segmentation loads or when it returns no
    // tokens. The fallback groups scripts into stable word-like chunks rather
    // than creating a button for every character.
    return <>{tokenizeLookupText(text).map((part, index) => {
        if (!part.lookup) {
            return <span key={`fallback-plain-${part.cursor}-${index}`}>{highlightText(part.text, searchQuery)}</span>;
        }
        const isActive = activeCursor != null && part.cursor === activeCursor;
        return (
            <button
                key={`fallback-word-${part.cursor}-${index}-${part.text}`}
                type="button"
                className={isActive ? "lookup-word active" : "lookup-word"}
                onClick={(event) => {
                    event.stopPropagation();
                    onLookupToken(part.text, text, part.cursor);
                }}
            >
                {highlightText(part.text, searchQuery)}
            </button>
        );
    })}</>;
};

const TextLineItem = memo(function TextLineItem({ line, index, suppliedFurigana, onDelete, onEdit, furiganaMode, searchQuery, isActiveSearchMatch, contextBefore = "", contextAfter = "", language = 'ru', onLookupToken, onTokenTap, activeToken }: any) {
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

    const btnStyle = { background: 'var(--hover-bg)', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', padding: '6px', display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: '4px', transition: '0.2s' };

    const bgColor = isActiveSearchMatch 
        ? 'rgba(79, 166, 255, 0.15)' 
        : (isHovered || isEditing ? 'var(--hover-bg)' : 'transparent');

    return (
        <div className="text-line-wrapper" data-raw-text={line} onMouseEnter={() => setIsHovered(true)} onMouseLeave={() => setIsHovered(false)} style={{ display: 'flex', flexDirection: 'column', alignItems: 'stretch', width: 'fit-content', maxWidth: '100%', boxSizing: 'border-box', marginBottom: '14px', padding: '6px 10px', borderRadius: '8px', backgroundColor: bgColor, transition: 'background-color 0.2s', position: 'relative' }}>
            
            <div 
                ref={textRef}
                contentEditable={isEditing}
                suppressContentEditableWarning={true}
                onBlur={(e) => {
                    setIsEditing(false);
                    const newText = e.currentTarget.innerText.trim();
                    if (newText !== line && newText !== "") onEdit(index, newText);
                    else e.currentTarget.innerText = line; 
                }}
                onKeyDown={(e) => {
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
                {isEditing ? line : suppliedFurigana ? (
                    <SuppliedFuriganaLine text={line} supplied={suppliedFurigana} searchQuery={searchQuery} />
                ) : (
                    onLookupToken ? (
                        <TokenizedLine
                            text={line}
                            searchQuery={searchQuery}
                            onLookupToken={onTokenTap ? (token: string, sentence: string, cursor: number) => onTokenTap(index, token, sentence, cursor) : onLookupToken}
                            furiganaMode={furiganaMode}
                            contextBefore={contextBefore}
                            contextAfter={contextAfter}
                            activeCursor={activeToken && activeToken.line === index ? activeToken.cursor : null}
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

            <span className="text-line-actions" contentEditable={false} style={{ opacity: isHovered || isEditing || isActiveSearchMatch ? 1 : 0, pointerEvents: isHovered || isEditing || isActiveSearchMatch ? 'auto' : 'none', display: 'inline-flex', alignSelf: 'flex-end', flexShrink: 0, gap: '6px', marginTop: '4px', transition: 'opacity 0.2s' }}>
                {!isEditing && <button onClick={handleCopy} style={btnStyle} title={t('common.copy')}>{isCopied ? <IconCheck /> : <IconCopy />}</button>}
                <button 
                    onClick={() => {
                        if (isEditing) textRef.current?.blur();
                        else { setIsEditing(true); setTimeout(() => textRef.current?.focus(), 50); }
                    }} 
                    style={{...btnStyle, background: isEditing ? 'var(--accent-blue)' : btnStyle.background, color: isEditing ? '#fff' : btnStyle.color}} 
                    title={t('common.edit')}
                >
                    <IconEdit />
                </button>
                {!isEditing && <button onClick={() => onDelete(index)} style={{ ...btnStyle, color: '#ff6b6b', background: 'rgba(255, 107, 107, 0.1)' }} title={t('common.delete')}><IconDelete /></button>}
            </span>
        </div>
    );
});

const TextContainer = memo(function TextContainer({ contentKey, lines = [], lineFurigana = [], isFlashing = false, onDelete, onEdit, furiganaMode, autoScrollOffset = 80, searchQuery = "", activeSearchLineIdx = -1, searchTrigger = 0, panelPosition = 'bottom', language = 'ru', textOrientation = 'horizontal', readerProgress = 0, onReaderProgress, onLookupToken, lookupActive = false }: any) {
  const parentRef = useRef<HTMLDivElement>(null);
  // Which word is currently looked up — held highlighted while the popup is open, cleared on close.
  const [activeToken, setActiveToken] = useState<{ line: number; cursor: number } | null>(null);
  const lookupActiveRef = useRef(lookupActive);
  useEffect(() => { lookupActiveRef.current = lookupActive; }, [lookupActive]);
  useEffect(() => { if (!lookupActive) setActiveToken(null); }, [lookupActive]);
  // If a tapped word finds no dictionary entry, don't leave it highlighted forever —
  // clear the highlight shortly after if no popup opened.
  useEffect(() => {
      if (!activeToken) return;
      const timer = setTimeout(() => { if (!lookupActiveRef.current) setActiveToken(null); }, 750);
      return () => clearTimeout(timer);
  }, [activeToken]);
  const handleTokenTap = useCallback((lineIndex: number, token: string, sentence: string, cursor: number) => {
      setActiveToken({ line: lineIndex, cursor });
      onLookupToken?.(token, sentence, cursor);
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
    count: lines.length > 0 ? lines.length + 1 : 0,
    getScrollElement: () => parentRef.current,
    estimateSize: (index) => {
        if (index === lines.length) {
            const bottomSpace = 100 - clampAutoScrollOffset(autoScrollOffset);
            const viewportHeight = parentRef.current?.clientHeight || window.innerHeight;
            return viewportHeight * (bottomSpace / 100);
        }
        const text = String(lines[index] || "");
        const containerWidth = parentRef.current?.clientWidth || window.innerWidth || 900;
        const fontSize = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--txt-font-size')) || 26;
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
    enabled: !isVertical
  });

  useEffect(() => {
      if (isVertical) return;
      const timer = window.setTimeout(() => rowVirtualizer.measure(), 120);
      const fonts = (document as any).fonts;
      if (fonts?.ready) {
          fonts.ready.then(() => rowVirtualizer.measure()).catch(() => {});
      }
      return () => window.clearTimeout(timer);
  }, [isVertical, lines.length, rowVirtualizer]);

  useEffect(() => {
      if (isVertical) return;
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

      const frame = window.requestAnimationFrame(() => {
          const el = parentRef.current;
          if (!el) return;
          if (isVertical) el.scrollLeft = -(el.scrollWidth - el.clientWidth);
          else el.scrollTop = el.scrollHeight;
      });
      return () => window.cancelAnimationFrame(frame);
  }, [contentKey, isVertical, lines.length]);

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
      shouldFollowTailRef.current = isNearBottom;
      const max = Math.max(1, target.scrollHeight - target.clientHeight);
      emitProgress(Math.min(1, Math.max(0, target.scrollTop / max)));
      updateShowScrollBottom(!isNearBottom && lines.length > 0);
  };

  const scrollToBottom = () => {
      shouldFollowTailRef.current = true;
      if (isVertical) {
          const el = parentRef.current;
          if (!el) return;
          el.scrollLeft = -(el.scrollWidth - el.clientWidth);
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
          if (isVertical) {
              const timer = window.setTimeout(() => {
                  const target = parentRef.current?.querySelector(`[data-index="${activeSearchLineIdx}"]`) as HTMLElement | null;
                  target?.scrollIntoView({ block: 'nearest', inline: 'center' });
              }, 0);
              return () => window.clearTimeout(timer);
          }
          rowVirtualizer.scrollToIndex(activeSearchLineIdx, { align: 'center' });
          const timer = window.setTimeout(() => {
              rowVirtualizer.scrollToIndex(activeSearchLineIdx, { align: 'center' });
              const retryTarget = parentRef.current?.querySelector(`[data-index="${activeSearchLineIdx}"]`) as HTMLElement | null;
              retryTarget?.scrollIntoView({ block: 'center' });
          }, 80);
          return () => window.clearTimeout(timer);
      }
  }, [activeSearchLineIdx, searchTrigger, lines.length, isVertical, rowVirtualizer]);

  // Вычисляем отступ кнопки от нижнего края в зависимости от положения панели
  const buttonBottomOffset = panelPosition === 'bottom' ? '70px' : '30px';

  useEffect(() => {
      const el = parentRef.current;
      if (!el || lines.length === 0 || readerProgress <= 0) return;
      setTimeout(() => {
          if (isVertical) {
              const max = Math.max(0, el.scrollWidth - el.clientWidth);
              el.scrollLeft = -max * readerProgress;
          } else {
              const max = Math.max(0, el.scrollHeight - el.clientHeight);
              el.scrollTop = max * readerProgress;
          }
      }, 80);
  }, [isVertical, lines.length]);

  useEffect(() => {
      if (!isVertical || lines.length === 0 || activeSearchLineIdx >= 0 || !shouldFollowTailRef.current) return;
      const el = parentRef.current;
      if (!el) return;
      const frame = requestAnimationFrame(() => {
          el.scrollLeft = -(el.scrollWidth - el.clientWidth);
          updateShowScrollBottom(false);
      });
      return () => cancelAnimationFrame(frame);
  }, [isVertical, lines.length, activeSearchLineIdx]);

  if (isVertical) {
      const verticalFuriganaMode = 'none';

      return (
        <div ref={parentRef} onScroll={handleScroll} className={`text-container ${isFlashing ? 'flash' : ''}`} style={{ padding: panelPosition === 'top-right' ? '28px 28px 28px 190px' : '28px', overflowX: 'auto', overflowY: 'hidden', flex: 1, position: 'relative', direction: 'rtl' }}>
            <div style={{ writingMode: 'vertical-rl', textOrientation: 'mixed', height: '100%', display: 'flex', flexDirection: 'column', flexWrap: 'wrap', alignContent: 'flex-start', gap: '18px', direction: 'ltr' }}>
                {lines.map((line: string, index: number) => {
                    return (
                    <div className="text-line" data-index={index} data-raw-text={line} key={`${index}-${line.slice(0, 12)}`} style={{ minHeight: '40px', maxHeight: '100%', padding: '8px 2px', borderRadius: '6px', color: 'var(--text-main)', fontSize: 'var(--txt-font-size, 26px)', fontFamily: `var(--txt-font-family, 'Noto Serif JP'), ${jpSerifFallback}`, lineHeight: 1.9, letterSpacing: '0', fontSynthesis: 'none', fontVariantNumeric: 'tabular-nums', textRendering: 'optimizeLegibility', background: index === activeSearchLineIdx ? 'rgba(79, 166, 255, 0.15)' : 'transparent' }}>
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
            </div>
            {showScrollBottom && (
                <button onClick={scrollToBottom} style={{ position: 'fixed', bottom: buttonBottomOffset, right: '30px', width: '44px', height: '44px', borderRadius: '50%', background: 'var(--accent-blue)', color: '#fff', border: 'none', boxShadow: '0 4px 12px rgba(0,0,0,0.3)', cursor: 'pointer', zIndex: 100, display: 'flex', alignItems: 'center', justifyContent: 'center' }} title={language === 'en' ? 'Scroll to end' : 'К концу текста'}>
                    <IconArrowDown />
                </button>
            )}
        </div>
      );
  }

  return (
    <div ref={parentRef} onScroll={handleScroll} className={`text-container ${isFlashing ? 'flash' : ''}`} style={{ padding: '20px', overflowY: 'auto', flex: 1, position: 'relative' }}>
      <div style={{ width: '100%', minHeight: '100%', height: `${Math.max(rowVirtualizer.getTotalSize(), parentRef.current?.clientHeight || 0)}px`, position: 'relative' }}>
        {rowVirtualizer.getVirtualItems().map((virtualRow) => {
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
                        position: 'absolute',
                        top: 0,
                        left: 0,
                        width: '100%',
                        transform: `translateY(${virtualRow.start}px)`,
                        height: isSpacer ? `${spacerHeight}px` : undefined,
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
                        />
                    )}
                </div>
            );
        })}
      </div>

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
