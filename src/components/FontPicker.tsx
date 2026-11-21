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
    /** Optional script category for preset filtering and preview text. */
    script?: 'ja' | 'latin';
    /** Optional section header override when grouping presets. */
    group?: string;
    /** Optional inline row sample override. */
    sample?: string;
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

type Filter = 'japanese' | 'latin' | 'all';

interface FontPickerProps {
    value: string;
    onChange: (value: string) => void;
    english: boolean;
    title: string;
    presets: FontOption[];
    sampleText?: string;
    latinSampleText?: string;
    defaultFilter?: Filter;
    showLatinFilter?: boolean;
    onPickFile?: () => void;
    onRemoveCustom?: () => void;
    customFont?: FontOption | null;
}

const ROW_HEIGHT = 58;
const HEADER_HEIGHT = 30;
const DEFAULT_JA_SAMPLE = 'あの日見た花の名前を、僕達はまだ知らない。';
const DEFAULT_LATIN_SAMPLE = 'Down the rabbit-hole went Alice, never once considering how to get out.';

export default function FontPicker({
    value,
    onChange,
    english,
    title,
    presets,
    sampleText,
    latinSampleText,
    defaultFilter,
    showLatinFilter,
    onPickFile,
    onRemoveCustom,
    customFont,
}: FontPickerProps) {
    const L = (en: string, ru: string) => (english ? en : ru);
    const hasLatinFilter = showLatinFilter ?? presets.some((option) => option.script === 'latin');
    const resolvedDefaultFilter: Filter = defaultFilter ?? 'japanese';
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
    const [filter, setFilter] = useState<Filter>(resolvedDefaultFilter);
    const [hovered, setHovered] = useState<string | null>(null);
    const listRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (open) setFilter(resolvedDefaultFilter);
    }, [open, resolvedDefaultFilter]);

    useEffect(() => {
        if (!open || fonts) return;
        let cancelled = false;
        void loadSystemFonts().then((list) => {
            if (cancelled) return;
            setFonts(list);
            if (resolvedDefaultFilter === 'japanese' && !list.some((font) => font.japanese)) setFilter('all');
        });
        return () => { cancelled = true; };
    }, [open, fonts, resolvedDefaultFilter]);

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

    type Row = { kind: 'header'; label: string; preset?: boolean } | { kind: 'font'; option: FontOption };

    const { rows, flatOptions } = useMemo(() => {
        const normalized = query.trim().toLowerCase();
        const matches = (text: string) => !normalized || text.toLowerCase().includes(normalized);
        const matchesScript = (option: FontOption) => {
            if (filter === 'all' || !option.script) return true;
            return filter === 'japanese' ? option.script === 'ja' : option.script === 'latin';
        };
        const matchedCustom = customFont && matches(customFont.label) ? [customFont] : [];
        const matchedPresets = presets.filter((option) => matchesScript(option) && (matches(option.label) || (option.hint ? matches(option.hint) : false)));
        const system: FontOption[] = (fonts || [])
            .filter((font) => {
                if (filter === 'all') return true;
                return filter === 'japanese' ? font.japanese : !font.japanese;
            })
            .filter((font) => matches(font.family) || font.localNames.some(matches))
            .map((font) => ({
                value: systemFontValue(font.family),
                label: font.family,
                hint: font.localNames.find((name) => /[^\x00-\x7f]/.test(name)),
                script: font.japanese ? 'ja' : 'latin',
            }));
        const list: Row[] = [];
        const usesExplicitGroups = presets.some((option) => Boolean(option.group));
        if (usesExplicitGroups) {
            if (matchedCustom.length) {
                list.push({ kind: 'header', label: L('Custom font file', 'Свой файл шрифта'), preset: true });
                matchedCustom.forEach((option) => list.push({ kind: 'font', option }));
            }
            const grouped = new Map<string, FontOption[]>();
            for (const option of matchedPresets) {
                const groupLabel = option.group || L('Built-in presets', 'Предустановленные');
                const bucket = grouped.get(groupLabel);
                if (bucket) bucket.push(option);
                else grouped.set(groupLabel, [option]);
            }
            for (const [groupLabel, items] of grouped) {
                list.push({ kind: 'header', label: `${groupLabel} · ${items.length}`, preset: true });
                items.forEach((option) => list.push({ kind: 'font', option }));
            }
        } else {
            const fixed = [...matchedCustom, ...matchedPresets];
            if (fixed.length) {
                list.push({ kind: 'header', label: L('Recommended', 'Рекомендуемые') });
                fixed.forEach((option) => list.push({ kind: 'font', option }));
            }
        }
        if (system.length) {
            const systemHeader = filter === 'japanese'
                ? L(`Installed · Japanese · ${system.length}`, `Установленные · японские · ${system.length}`)
                : filter === 'latin'
                    ? L(`Installed · Latin · ${system.length}`, `Установленные · латиница · ${system.length}`)
                    : L(`Installed · ${system.length}`, `Установленные · ${system.length}`);
            list.push({ kind: 'header', label: systemHeader });
            system.forEach((option) => list.push({ kind: 'font', option }));
        }
        return { rows: list, flatOptions: [...matchedCustom, ...matchedPresets, ...system] };
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
    const activePreviewOption = flatOptions.find((option) => option.value === (hovered ?? value)) ?? current;
    const previewValue = withReadableCyrillic(cssFor(hovered ?? value));
    const previewLabel = activePreviewOption?.label || currentLabel;
    const previewSample = activePreviewOption?.script === 'latin'
        ? (latinSampleText || DEFAULT_LATIN_SAMPLE)
        : activePreviewOption?.script === 'ja'
            ? (sampleText || DEFAULT_JA_SAMPLE)
            : filter === 'latin'
                ? (latinSampleText || DEFAULT_LATIN_SAMPLE)
                : (sampleText || DEFAULT_JA_SAMPLE);

    const backdropPressRef = useRef(false);
    const choose = (next: string) => {
        onChange(next);
        close();
        window.getSelection()?.removeAllRanges();
    };

    return (
        <>
            <button type="button" className="font-picker-trigger" onClick={() => setOpen(true)} title={L('Choose font', 'Выбрать шрифт')}>
                <span className="font-picker-trigger-sample" style={{ fontFamily: cssFor(value) }}>
                    {current?.script === 'latin' ? 'Aa Bb' : 'あア字 Aa'}
                </span>
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
                            <div className="font-picker-preview-text" style={{ fontFamily: previewValue }}>{previewSample}</div>
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
                                {hasLatinFilter && (
                                    <button type="button" className={filter === 'latin' ? 'is-active' : ''} onClick={() => setFilter('latin')}>{L('Latin', 'Латиница')}</button>
                                )}
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
                                            <div key={`h-${item.index}`} className={`font-picker-group${row.preset ? ' is-preset' : ''}`} style={{ transform: `translateY(${item.start}px)`, height: item.size }}>
                                                {row.label}
                                            </div>
                                        );
                                    }
                                    const option = row.option;
                                    const selected = option.value === value;
                                    const isCustom = Boolean(customFont && option.value === customFont.value);
                                    const rowSample = option.sample ?? (option.script === 'latin' ? 'The quick fox Aa' : 'あの日の花 Aa');
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
                                                <span className="font-picker-row-sample" style={{ fontFamily: option.previewFamily ?? option.value }}>{rowSample}</span>
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
