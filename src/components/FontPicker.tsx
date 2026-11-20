import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { invoke } from '@tauri-apps/api/core';
import { useVirtualizer } from '@tanstack/react-virtual';
import { withReadableCyrillic } from '../utils/cyrillicFace';
import './FontPicker.css';

export interface SystemFont {
    family: string;
    localNames: string[];
    japanese: boolean;
    monospaced: boolean;
    styles: number;
}

export interface FontOption {
    value: string;
    label: string;
    hint?: string;
    /** CSS family used for previews when `value` is a sentinel rather than a font stack. */
    previewFamily?: string;
}

let systemFontsPromise: Promise<SystemFont[]> | null = null;

/** Installed font families from the native side (empty on platforms without the command). */
export const loadSystemFonts = () => {
    if (!systemFontsPromise) {
        systemFontsPromise = invoke<SystemFont[]>('list_system_fonts').catch(() => {
            systemFontsPromise = null;
            return [];
        });
    }
    return systemFontsPromise;
};

/** CSS value stored in settings for an installed family. */
export const systemFontValue = (family: string) => `'${family.replace(/'/g, "\\'")}'`;

const firstFamily = (value: string) => value.split(',')[0]?.trim().replace(/^['"]|['"]$/g, '') || value;

type Filter = 'japanese' | 'all';

interface FontPickerProps {
    value: string;
    onChange: (value: string) => void;
    english: boolean;
    title: string;
    presets: FontOption[];
    sampleText?: string;
    onPickFile?: () => void;
    onRemoveCustom?: () => void;
    customFont?: FontOption | null;
}

const ROW_HEIGHT = 58;
const HEADER_HEIGHT = 30;

export default function FontPicker({ value, onChange, english, title, presets, sampleText, onPickFile, onRemoveCustom, customFont }: FontPickerProps) {
    const L = (en: string, ru: string) => (english ? en : ru);
    const sample = sampleText || 'あの日見た花の名前を、僕達はまだ知らない。';
    const [open, setOpen] = useState(false);
    const [closing, setClosing] = useState(false);
    const closeTimerRef = useRef(0);
    /** Animate the sheet out, then unmount it. */
    const close = () => {
        if (closing) return;
        setClosing(true);
        window.clearTimeout(closeTimerRef.current);
        closeTimerRef.current = window.setTimeout(() => { setOpen(false); setClosing(false); }, 170);
    };
    useEffect(() => () => window.clearTimeout(closeTimerRef.current), []);
    const [fonts, setFonts] = useState<SystemFont[] | null>(null);
    const [query, setQuery] = useState('');
    const [filter, setFilter] = useState<Filter>('japanese');
    const [hovered, setHovered] = useState<string | null>(null);
    const listRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (!open || fonts) return;
        let cancelled = false;
        void loadSystemFonts().then((list) => {
            if (cancelled) return;
            setFonts(list);
            if (!list.some((font) => font.japanese)) setFilter('all');
        });
        return () => { cancelled = true; };
    }, [open, fonts]);

    useEffect(() => {
        if (!open) return;
        const onKey = (event: KeyboardEvent) => {
            if (event.key !== 'Escape') return;
            event.preventDefault();
            event.stopPropagation();
            close();
        };
        window.addEventListener('keydown', onKey, true);
        return () => window.removeEventListener('keydown', onKey, true);
    }, [open]);

    type Row = { kind: 'header'; label: string } | { kind: 'font'; option: FontOption };

    const { rows, flatOptions } = useMemo(() => {
        const normalized = query.trim().toLowerCase();
        const matches = (text: string) => !normalized || text.toLowerCase().includes(normalized);
        const fixed = [...(customFont ? [customFont] : []), ...presets].filter((option) => matches(option.label));
        const system: FontOption[] = (fonts || [])
            .filter((font) => filter === 'all' || font.japanese)
            .filter((font) => matches(font.family) || font.localNames.some(matches))
            .map((font) => ({
                value: systemFontValue(font.family),
                label: font.family,
                hint: font.localNames.find((name) => /[^\x00-\x7f]/.test(name)),
            }));
        const list: Row[] = [];
        if (fixed.length) {
            list.push({ kind: 'header', label: L('Recommended', 'Рекомендуемые') });
            fixed.forEach((option) => list.push({ kind: 'font', option }));
        }
        if (system.length) {
            list.push({ kind: 'header', label: filter === 'japanese' ? L(`Installed · Japanese · ${system.length}`, `Установленные · японские · ${system.length}`) : L(`Installed · ${system.length}`, `Установленные · ${system.length}`) });
            system.forEach((option) => list.push({ kind: 'font', option }));
        }
        return { rows: list, flatOptions: [...fixed, ...system] };
    }, [customFont, presets, fonts, filter, query, english]);

    const virtualizer = useVirtualizer({
        count: rows.length,
        getScrollElement: () => listRef.current,
        estimateSize: (index) => (rows[index]?.kind === 'header' ? HEADER_HEIGHT : ROW_HEIGHT),
        overscan: 8,
    });

    useEffect(() => { virtualizer.measure(); }, [rows]);

    const current = [...(customFont ? [customFont] : []), ...presets].find((option) => option.value === value);
    const currentLabel = current?.label || firstFamily(value);
    const allFixed = [...(customFont ? [customFont] : []), ...presets];
    const cssFor = (optionValue: string) => allFixed.find((option) => option.value === optionValue)?.previewFamily ?? optionValue;
    const previewValue = withReadableCyrillic(cssFor(hovered ?? value));
    const previewLabel = flatOptions.find((option) => option.value === (hovered ?? value))?.label || currentLabel;

    const backdropPressRef = useRef(false);
    const choose = (next: string) => {
        onChange(next);
        close();
        window.getSelection()?.removeAllRanges();
    };

    return (
        <>
            <button type="button" className="font-picker-trigger" onClick={() => setOpen(true)} title={L('Choose font', 'Выбрать шрифт')}>
                <span className="font-picker-trigger-sample" style={{ fontFamily: cssFor(value) }}>あア字 Aa</span>
                <span className="font-picker-trigger-name">{currentLabel}</span>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>
            </button>

            {open && createPortal(
                <div
                    className={`font-picker-overlay${closing ? ' is-closing' : ''}`}
                    // Close on a full click on the backdrop. Closing on mousedown let
                    // the still-pressed mouse drag a text selection into the reader.
                    onMouseDown={(event) => { backdropPressRef.current = event.target === event.currentTarget; }}
                    onClick={(event) => {
                        if (backdropPressRef.current && event.target === event.currentTarget) close();
                        backdropPressRef.current = false;
                    }}
                >
                    <div className="font-picker-sheet" role="dialog" aria-modal="true" aria-label={title}>
                        <header className="font-picker-header">
                            <div>
                                <p className="font-picker-eyebrow">{L('FONT', 'ШРИФТ')}</p>
                                <h2>{title}</h2>
                            </div>
                            <button type="button" className="font-picker-close" onClick={() => close()} aria-label={L('Close', 'Закрыть')}>
                                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" /></svg>
                            </button>
                        </header>

                        <div className="font-picker-preview">
                            <div className="font-picker-preview-text" style={{ fontFamily: previewValue }}>{sample}</div>
                            <div className="font-picker-preview-meta">
                                <span style={{ fontFamily: previewValue }}>Aa Бб 0123 — {previewLabel}</span>
                                {hovered && hovered !== value && <span className="font-picker-preview-badge">{L('Preview', 'Предпросмотр')}</span>}
                            </div>
                        </div>

                        <div className="font-picker-toolbar">
                            <input
                                autoFocus
                                className="font-picker-search"
                                value={query}
                                onChange={(event) => setQuery(event.target.value)}
                                placeholder={L('Search fonts', 'Поиск шрифта')}
                            />
                            <div className="font-picker-filters" role="group">
                                <button type="button" className={filter === 'japanese' ? 'is-active' : ''} onClick={() => setFilter('japanese')}>{L('Japanese', 'Японские')}</button>
                                <button type="button" className={filter === 'all' ? 'is-active' : ''} onClick={() => setFilter('all')}>{L('All', 'Все')}</button>
                            </div>
                            {onPickFile && (
                                <button type="button" className="font-picker-file" onClick={() => { close(); onPickFile(); }}>
                                    {L('Font file…', 'Файл шрифта…')}
                                </button>
                            )}
                        </div>

                        <div ref={listRef} className="font-picker-list" onMouseLeave={() => setHovered(null)}>
                            {fonts === null && <div className="font-picker-empty">{L('Loading installed fonts…', 'Загружаю шрифты системы…')}</div>}
                            {fonts !== null && rows.length === 0 && <div className="font-picker-empty">{L('Nothing found', 'Ничего не найдено')}</div>}
                            <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
                                {virtualizer.getVirtualItems().map((item) => {
                                    const row = rows[item.index];
                                    if (row.kind === 'header') {
                                        return (
                                            <div key={`h-${item.index}`} className="font-picker-group" style={{ transform: `translateY(${item.start}px)`, height: item.size }}>
                                                {row.label}
                                            </div>
                                        );
                                    }
                                    const option = row.option;
                                    const selected = option.value === value;
                                    const isCustom = Boolean(customFont && option.value === customFont.value);
                                    return (
                                        <div
                                            key={`${option.value}-${item.index}`}
                                            className="font-picker-row-slot"
                                            style={{ transform: `translateY(${item.start}px)`, height: item.size }}
                                        >
                                            <button
                                                type="button"
                                                className={`font-picker-row${selected ? ' is-selected' : ''}`}
                                                onMouseEnter={() => setHovered(option.value)}
                                                onFocus={() => setHovered(option.value)}
                                                onClick={() => choose(option.value)}
                                            >
                                                <span className="font-picker-row-text">
                                                    <strong>{option.label}</strong>
                                                    {option.hint && <small>{option.hint}</small>}
                                                </span>
                                                <span className="font-picker-row-sample" style={{ fontFamily: option.previewFamily ?? option.value }}>あの日の花 Aa</span>
                                                {isCustom && onRemoveCustom ? (
                                                    <span
                                                        role="button"
                                                        tabIndex={0}
                                                        className="font-picker-remove"
                                                        onClick={(event) => { event.stopPropagation(); onRemoveCustom(); }}
                                                        title={L('Remove font file', 'Удалить файл шрифта')}
                                                    >×</span>
                                                ) : (
                                                    <span className="font-picker-check" aria-hidden="true">{selected ? '✓' : ''}</span>
                                                )}
                                            </button>
                                        </div>
                                    );
                                })}
                            </div>
                        </div>
                    </div>
                </div>,
                document.body,
            )}
        </>
    );
}
