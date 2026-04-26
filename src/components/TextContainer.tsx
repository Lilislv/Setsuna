import { useEffect, useRef, useState, memo, useLayoutEffect } from "react";
import { invoke } from '@tauri-apps/api/core';
import { writeText } from '@tauri-apps/plugin-clipboard-manager';
import { useVirtualizer } from '@tanstack/react-virtual';

const IconCopy = () => <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>;
const IconCheck = () => <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#4CAF50" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>;
const IconDelete = () => <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>;
const IconEdit = () => <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg>;
const IconArrowDown = () => <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="12" y1="5" x2="12" y2="19"></line><polyline points="19 12 12 19 5 12"></polyline></svg>;

const highlightText = (text: string, query: string) => {
    if (!query) return text;
    const parts = text.split(new RegExp(`(${query})`, 'gi'));
    return parts.map((part, i) => 
        part.toLowerCase() === query.toLowerCase() 
            ? <mark key={i} style={{ backgroundColor: '#4fa6ff', color: '#fff', borderRadius: '3px', padding: '0 2px' }}>{part}</mark> 
            : part
    );
};

const FuriganaLine = memo(({ text, mode, searchQuery }: { text: string, mode: string, searchQuery: string }) => {
    const [tokens, setTokens] = useState<any[] | null>(null);

    useEffect(() => {
        if (mode === 'auto' && !tokens) {
            invoke('get_furigana', { text }).then(res => setTokens(res as any[])).catch(() => {});
        } else if (mode !== 'auto') {
            setTokens(null);
        }
    }, [text, mode]);

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

const TextLineItem = memo(function TextLineItem({ line, index, onDelete, onEdit, furiganaMode, searchQuery, isActiveSearchMatch }: any) {
    const [isHovered, setIsHovered] = useState(false);
    const [isCopied, setIsCopied] = useState(false);
    const [isEditing, setIsEditing] = useState(false);
    const textRef = useRef<HTMLDivElement>(null);

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
        <div className="text-line-wrapper" data-raw-text={line} onMouseEnter={() => setIsHovered(true)} onMouseLeave={() => setIsHovered(false)} style={{ display: 'flex', flexDirection: 'row', alignItems: 'flex-end', flexWrap: 'wrap', marginBottom: '10px', padding: '5px 10px', borderRadius: '8px', backgroundColor: bgColor, transition: 'background-color 0.2s', position: 'relative' }}>
            
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
                    display: 'inline', fontSize: 'var(--txt-font-size, 26px)', fontFamily: "var(--txt-font-family, 'Noto Serif JP', sans-serif)", 
                    lineHeight: '2.2', wordBreak: 'break-word', color: 'var(--text-main)', minWidth: '50px',
                    outline: isEditing ? '2px dashed var(--accent-blue)' : 'none',
                    padding: isEditing ? '2px 6px' : '0', borderRadius: '4px'
                }}
            >
                {isEditing ? line : <FuriganaLine text={line} mode={furiganaMode} searchQuery={searchQuery} />}
            </div>

            <div className="text-line-actions" style={{ opacity: isHovered || isEditing || isActiveSearchMatch ? 1 : 0, display: 'inline-flex', gap: '6px', marginLeft: '12px', transition: 'opacity 0.2s', flexShrink: 0, marginBottom: '6px' }}>
                {!isEditing && <button onClick={handleCopy} style={btnStyle} title="Копировать">{isCopied ? <IconCheck /> : <IconCopy />}</button>}
                <button 
                    onClick={() => {
                        if (isEditing) textRef.current?.blur();
                        else { setIsEditing(true); setTimeout(() => textRef.current?.focus(), 50); }
                    }} 
                    style={{...btnStyle, background: isEditing ? 'var(--accent-blue)' : btnStyle.background, color: isEditing ? '#fff' : btnStyle.color}} 
                    title="Редактировать"
                >
                    <IconEdit />
                </button>
                {!isEditing && <button onClick={() => onDelete(index)} style={{ ...btnStyle, color: '#ff6b6b', background: 'rgba(255, 107, 107, 0.1)' }} title="Удалить"><IconDelete /></button>}
            </div>
        </div>
    );
});

const TextContainer = memo(function TextContainer({ lines = [], isFlashing = false, onDelete, onEdit, furiganaMode, autoScrollOffset = 80, searchQuery = "", activeSearchLineIdx = -1, searchTrigger = 0, panelPosition = 'bottom' }: any) {
  const parentRef = useRef<HTMLDivElement>(null);
  const prevLinesLengthRef = useRef(lines.length);
  const [showScrollBottom, setShowScrollBottom] = useState(false);

  const rowVirtualizer = useVirtualizer({
    count: lines.length > 0 ? lines.length + 1 : 0,
    getScrollElement: () => parentRef.current,
    estimateSize: (index) => {
        if (index === lines.length) {
            const bottomSpace = 100 - autoScrollOffset;
            return window.innerHeight * (bottomSpace / 100); 
        }
        return 65; 
    },
    overscan: 10,
    getItemKey: (index) => {
        if (index === lines.length) return 'spacer';
        return index;
    }
  });

  // Запоминаем первую строчку текста, чтобы понимать, когда мы переключаем вкладки
    const prevFirstLineRef = useRef<string | undefined>(undefined);

    useEffect(() => {
        if (lines.length === 0) {
            prevFirstLineRef.current = undefined;
            return;
        }

        // Если первая строка изменилась (или мы только открыли прогу) — значит это смена вкладки
        if (lines[0] !== prevFirstLineRef.current) {
            // Даем виртуализатору 50мс на отрисовку интерфейса и командуем прыжок в самый низ
            setTimeout(() => {
                try {
                    rowVirtualizer.scrollToIndex(lines.length - 1, { align: 'end' });
                } catch (e) {}
            }, 50);
        }

        prevFirstLineRef.current = lines[0];
    }, [lines, rowVirtualizer]);

  const handleScroll = (e: React.UIEvent<HTMLDivElement>) => {
      const target = e.currentTarget;
      const isNearBottom = target.scrollHeight - target.scrollTop - target.clientHeight < 150;
      setShowScrollBottom(!isNearBottom && lines.length > 0);
  };

  const scrollToBottom = () => {
      rowVirtualizer.scrollToIndex(lines.length, { align: 'end' });
      setTimeout(() => {
          rowVirtualizer.scrollToIndex(lines.length, { align: 'end' });
      }, 50);
  };

  useEffect(() => {
      const isNewText = lines.length > prevLinesLengthRef.current;
      prevLinesLengthRef.current = lines.length;

      if (isNewText && activeSearchLineIdx === -1) {
          const timer = setTimeout(() => {
              rowVirtualizer.scrollToIndex(lines.length, { align: 'end' });
          }, 50);
          return () => clearTimeout(timer);
      }
  }, [lines.length, activeSearchLineIdx]); 

  useLayoutEffect(() => {
      if (activeSearchLineIdx >= 0 && activeSearchLineIdx < lines.length) {
          rowVirtualizer.scrollToIndex(activeSearchLineIdx, { align: 'center' });
          const timer = setTimeout(() => {
              rowVirtualizer.scrollToIndex(activeSearchLineIdx, { align: 'center' });
          }, 50);
          return () => clearTimeout(timer);
      }
  }, [activeSearchLineIdx, searchTrigger, lines.length]);

  // Вычисляем отступ кнопки от нижнего края в зависимости от положения панели
  const buttonBottomOffset = panelPosition === 'bottom' ? '70px' : '30px';

  return (
    <div ref={parentRef} onScroll={handleScroll} className={`text-container ${isFlashing ? 'flash' : ''}`} style={{ padding: '20px', overflowY: 'auto', flex: 1, position: 'relative' }}>
      
      <div style={{ height: `${rowVirtualizer.getTotalSize()}px`, width: '100%', position: 'relative' }}>
        {rowVirtualizer.getVirtualItems().map((virtualRow) => {
            if (virtualRow.index === lines.length) {
                return <div key={virtualRow.key} style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: `${virtualRow.size}px`, transform: `translateY(${virtualRow.start}px)`, pointerEvents: 'none' }} />;
            }
            
            const line = lines[virtualRow.index];
            return (
                <div
                    key={virtualRow.key}
                    data-index={virtualRow.index}
                    ref={rowVirtualizer.measureElement}
                    style={{ position: 'absolute', top: 0, left: 0, width: '100%', transform: `translateY(${virtualRow.start}px)` }}
                >
                    <TextLineItem 
                        line={line} 
                        index={virtualRow.index} 
                        onDelete={onDelete} 
                        onEdit={onEdit} 
                        furiganaMode={furiganaMode} 
                        searchQuery={searchQuery}
                        isActiveSearchMatch={virtualRow.index === activeSearchLineIdx}
                    />
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
              title="Вниз"
          >
              <IconArrowDown />
          </button>
      )}
    </div>
  );
});

export default TextContainer;