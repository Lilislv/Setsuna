import { memo, useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { getTranslator, type AppLanguage } from '../utils/i18n';
import type { ReadingSpeedSample } from '../utils/constants';
import { useJelly } from '../utils/jelly';
import SpeedAnalytics from './SpeedAnalytics';

interface TabStats {
    chars: number;
    words: number;
    sentences: number;
    time: number;
}

interface StatsPanelProps {
    stats: TabStats;
    speedSamples?: ReadingSpeedSample[];
    isPaused: boolean;
    onTogglePause: () => void;
    position: 'bottom' | 'top-right';
    speedMetric: 'chars' | 'words' | 'sentences';
    speedTimeframe: 'minute' | 'hour';
    language?: AppLanguage;
    textOrientation?: 'horizontal' | 'vertical';
    tabId?: number | string | null;
    tabName?: string;
}



const formatTime = (seconds: number, t: ReturnType<typeof getTranslator>) => {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    if (h > 0) return `${h}${t('stats.hoursShort')} ${m}${t('stats.minutesShort')} ${s}${t('stats.secondsShort')}`;
    return `${m}${t('stats.minutesShort')} ${s}${t('stats.secondsShort')}`;
};

const IconChars = () => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" /></svg>;
const IconWords = () => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="4 7 4 4 20 4 20 7" /><line x1="9" y1="20" x2="15" y2="20" /><line x1="12" y1="4" x2="12" y2="20" /></svg>;
const IconSentences = () => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z" /><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z" /></svg>;
const IconTime = () => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" /></svg>;
const IconSpeed = () => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" /></svg>;
const IconPlay = () => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="5 3 19 12 5 21 5 3" /></svg>;
const IconPause = () => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="6" y="4" width="4" height="16" /><rect x="14" y="4" width="4" height="16" /></svg>;

const POSITION_KEY = 'setsuna-stats-panel-position';
const EDGE = 8;

type PanelOffset = { right: number; top: number };

const readSavedOffset = (): PanelOffset | null => {
    try {
        const parsed = JSON.parse(localStorage.getItem(POSITION_KEY) || 'null');
        if (parsed && Number.isFinite(parsed.right) && Number.isFinite(parsed.top)) return parsed;
    } catch {}
    return null;
};

/**
 * Lets the floating stats card be dragged anywhere inside its container. The
 * offset is kept from the right edge so the card stays put when the window is
 * resized, and it is clamped back into view if the window shrinks.
 */
const useDraggablePanel = (enabled: boolean) => {
    const panelRef = useRef<HTMLDivElement>(null);
    const [offset, setOffset] = useState<PanelOffset | null>(() => readSavedOffset());
    const [dragging, setDragging] = useState(false);
    const dragRef = useRef<{ pointerX: number; pointerY: number; right: number; top: number } | null>(null);

    const clamp = useCallback((value: PanelOffset): PanelOffset => {
        const panel = panelRef.current;
        const parent = panel?.offsetParent as HTMLElement | null;
        if (!panel || !parent) return value;
        const maxRight = Math.max(EDGE, parent.clientWidth - panel.offsetWidth - EDGE);
        const maxTop = Math.max(EDGE, parent.clientHeight - panel.offsetHeight - EDGE);
        return {
            right: Math.min(maxRight, Math.max(EDGE, value.right)),
            top: Math.min(maxTop, Math.max(EDGE, value.top)),
        };
    }, []);

    useEffect(() => {
        if (!enabled) return;
        const parent = panelRef.current?.offsetParent as HTMLElement | null;
        if (!parent) return;
        const observer = new ResizeObserver(() => setOffset((current) => (current ? clamp(current) : current)));
        observer.observe(parent);
        return () => observer.disconnect();
    }, [clamp, enabled]);

    const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
        if (!enabled || event.button !== 0 || (event.target as HTMLElement).closest('button')) return;
        const panel = panelRef.current;
        const parent = panel?.offsetParent as HTMLElement | null;
        if (!panel || !parent) return;
        const panelRect = panel.getBoundingClientRect();
        const parentRect = parent.getBoundingClientRect();
        dragRef.current = {
            pointerX: event.clientX,
            pointerY: event.clientY,
            right: parentRect.right - panelRect.right,
            top: panelRect.top - parentRect.top,
        };
        panel.setPointerCapture(event.pointerId);
        setDragging(true);
        event.preventDefault();
    };
    const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
        const drag = dragRef.current;
        if (!drag) return;
        setOffset(clamp({
            right: drag.right - (event.clientX - drag.pointerX),
            top: drag.top + (event.clientY - drag.pointerY),
        }));
    };
    const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
        if (!dragRef.current) return;
        dragRef.current = null;
        setDragging(false);
        try { panelRef.current?.releasePointerCapture(event.pointerId); } catch {}
        setOffset((current) => {
            if (current) {
                try { localStorage.setItem(POSITION_KEY, JSON.stringify(current)); } catch {}
            }
            return current;
        });
    };
    const reset = () => {
        setOffset(null);
        try { localStorage.removeItem(POSITION_KEY); } catch {}
    };

    return { panelRef, offset, dragging, reset, handlers: { onPointerDown, onPointerMove, onPointerUp, onPointerCancel: onPointerUp } };
};

const getMetric = (sample: ReadingSpeedSample | TabStats, metric: StatsPanelProps['speedMetric']) => {
    if (metric === 'words') return sample.words;
    if (metric === 'sentences') return sample.sentences;
    return sample.chars;
};

const StatsPanel = memo(function StatsPanel({
    stats,
    speedSamples = [],
    isPaused,
    onTogglePause,
    position,
    speedMetric,
    speedTimeframe,
    language = 'ru',
    textOrientation = 'horizontal',
    tabId = null,
    tabName = '',
}: StatsPanelProps) {
    const [analyticsOpen, setAnalyticsOpen] = useState(false);
    const [analyticsClosing, setAnalyticsClosing] = useState(false);
    const closeAnalytics = useCallback(() => {
        setAnalyticsClosing(true);
        window.setTimeout(() => { setAnalyticsOpen(false); setAnalyticsClosing(false); }, 180);
    }, []);
    useEffect(() => {
        if (!analyticsOpen) return;
        const onKey = (event: KeyboardEvent) => {
            if (event.key !== 'Escape') return;
            event.preventDefault();
            event.stopPropagation();
            closeAnalytics();
        };
        window.addEventListener('keydown', onKey, true);
        return () => window.removeEventListener('keydown', onKey, true);
    }, [analyticsOpen, closeAnalytics]);
    const t = getTranslator(language);
    const { chars, words, sentences, time } = stats;
    const drag = useDraggablePanel(position === 'top-right');
    useJelly(() => drag.panelRef.current, drag.dragging);
    // In a small window the full floating card covers a good part of the text;
    // it shrinks to a pill with the timer, time and speed.
    const isSmallWindow = () => typeof window !== 'undefined' && (window.innerWidth < 900 || window.innerHeight < 560);
    const [compact, setCompact] = useState(isSmallWindow);
    useEffect(() => {
        const onResize = () => setCompact(isSmallWindow());
        window.addEventListener('resize', onResize);
        return () => window.removeEventListener('resize', onResize);
    }, []);

    const multiplier = speedTimeframe === 'minute' ? 60 : 3600;
    const speedValue = time > 0 ? Math.round((getMetric(stats, speedMetric) / time) * multiplier) : 0;
    const metricText = speedMetric === 'chars' ? t('stats.secondsShort') : speedMetric === 'words' ? t('stats.wordsShort') : t('stats.sentencesShort');
    const timeframeText = speedTimeframe === 'minute' ? t('stats.minutesShort') : t('stats.hoursShort');
    const metricLabel = `${metricText}/${timeframeText}`;


    const speedButton = (
        <button
            onClick={() => setAnalyticsOpen(true)}
            style={{
                display: 'inline-flex',
                alignItems: 'baseline',
                gap: 4,
                border: 0,
                padding: 0,
                background: 'transparent',
                color: 'var(--accent-blue)',
                fontWeight: 'bold',
                cursor: 'pointer',
            }}
            title={language === 'en' ? 'Open reading speed analytics' : 'Открыть аналитику скорости чтения'}
        >
            <span style={{ fontSize: position === 'top-right' ? 13 : 16 }}>{speedValue}</span>
            <span style={{ color: 'var(--text-muted)', fontSize: position === 'top-right' ? 10 : 11, fontWeight: 'normal' }}>{metricLabel}</span>
        </button>
    );

    const analyticsModal = (
        <SpeedAnalytics
            open={analyticsOpen}
            closing={analyticsClosing}
            onClose={closeAnalytics}
            english={language === 'en'}
            tabId={tabId}
            tabName={tabName}
            stats={stats}
            samples={speedSamples}
            defaultMetric={speedMetric}
            timeframe={speedTimeframe}
        />
    );

    const pauseButton = (
        <>
            {isPaused ? <IconPlay /> : <IconPause />}
            {isPaused ? t('stats.start') : t('stats.pause')}
        </>
    );

    if (position === 'top-right') {
        const isVertical = textOrientation === 'vertical';
        if (compact) {
            return (
                <>
                    <div
                        data-coach="stats"
                        ref={drag.panelRef}
                        {...drag.handlers}
                        onDoubleClick={(event) => { if (!(event.target as HTMLElement).closest('button')) drag.reset(); }}
                        title={language === 'en' ? 'Drag to move · double-click to reset position' : 'Перетащи, чтобы сдвинуть · двойной клик — вернуть на место'}
                        style={{
                            position: 'absolute',
                            top: drag.offset ? `${drag.offset.top}px` : '10px',
                            right: drag.offset ? `${drag.offset.right}px` : (isVertical ? 'auto' : '12px'),
                            left: drag.offset ? 'auto' : (isVertical ? '12px' : 'auto'),
                            display: 'flex', alignItems: 'center', gap: '8px',
                            padding: '4px 12px 4px 4px', borderRadius: '999px',
                            backgroundColor: 'var(--surface-glass)', border: '1px solid var(--line)', backdropFilter: 'blur(14px)',
                            boxShadow: drag.dragging ? '0 14px 40px rgba(0,0,0,0.38)' : '0 8px 24px rgba(0,0,0,0.2)',
                            zIndex: 90, transform: 'var(--jelly-transform, none)',
                            cursor: drag.dragging ? 'grabbing' : 'grab', userSelect: 'none', touchAction: 'none',
                        }}
                    >
                        <button
                            type="button"
                            onClick={onTogglePause}
                            title={isPaused ? t('stats.start') : t('stats.pause')}
                            style={{
                                width: 28, height: 28, display: 'grid', placeItems: 'center', border: 0, borderRadius: '50%',
                                background: isPaused ? 'var(--surface-2)' : 'var(--accent-blue)',
                                color: isPaused ? 'var(--text-muted)' : '#fff', cursor: 'pointer',
                            }}
                        >
                            {isPaused ? <IconPlay /> : <IconPause />}
                        </button>
                        <span style={{ color: 'var(--text-main)', fontSize: 12.5, fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>{formatTime(time, t)}</span>
                        {speedButton}
                    </div>
                    {analyticsModal}
                </>
            );
        }
        return (
            <>
                <div
                    data-coach="stats"
                    ref={drag.panelRef}
                    {...drag.handlers}
                    onDoubleClick={(event) => { if (!(event.target as HTMLElement).closest('button')) drag.reset(); }}
                    title={language === 'en' ? 'Drag to move · double-click to reset position' : 'Перетащи, чтобы сдвинуть · двойной клик — вернуть на место'}
                    style={{
                        position: 'absolute',
                        top: drag.offset ? `${drag.offset.top}px` : '12px',
                        right: drag.offset ? `${drag.offset.right}px` : (isVertical ? 'auto' : '20px'),
                        left: drag.offset ? 'auto' : (isVertical ? '20px' : 'auto'),
                        backgroundColor: 'var(--surface-glass)', border: '1px solid var(--line)',
                        backdropFilter: 'blur(14px)',
                        borderRadius: '16px', padding: '12px 14px', display: 'flex', flexDirection: 'column',
                        gap: '10px', boxShadow: drag.dragging ? '0 14px 40px rgba(0,0,0,0.38)' : '0 8px 30px rgba(0,0,0,0.2)',
                        zIndex: 90, opacity: 0.95, transform: 'var(--jelly-transform, none)', willChange: drag.dragging ? 'transform' : undefined,
                        cursor: drag.dragging ? 'grabbing' : 'grab', userSelect: 'none', touchAction: 'none',
                        transition: drag.dragging ? 'box-shadow 0.15s' : 'box-shadow 0.15s, background-color 0.3s, border-color 0.3s',
                    }}
                >
                    <div style={{ display: 'grid', gridTemplateColumns: '20px 1fr', gap: '8px 12px', alignItems: 'center', fontSize: '13px' }}>
                        <div style={{ color: 'var(--text-muted)', display: 'flex', justifyContent: 'center' }} title={t('stats.chars')}><IconChars /></div>
                        <div style={{ color: 'var(--text-main)', fontWeight: 'bold' }}>{chars}</div>
                        <div style={{ color: 'var(--text-muted)', display: 'flex', justifyContent: 'center' }} title={t('stats.words')}><IconWords /></div>
                        <div style={{ color: 'var(--text-main)', fontWeight: 'bold' }}>{words}</div>
                        <div style={{ color: 'var(--text-muted)', display: 'flex', justifyContent: 'center' }} title={t('stats.sentences')}><IconSentences /></div>
                        <div style={{ color: 'var(--text-main)', fontWeight: 'bold' }}>{sentences}</div>
                        <div style={{ color: 'var(--text-muted)', display: 'flex', justifyContent: 'center' }} title={t('stats.time')}><IconTime /></div>
                        <div style={{ color: 'var(--text-main)', fontWeight: 'bold' }}>{formatTime(time, t)}</div>
                        <div style={{ color: 'var(--text-muted)', display: 'flex', justifyContent: 'center' }} title={t('stats.speed')}><IconSpeed /></div>
                        <div>{speedButton}</div>
                    </div>
                    <button
                        onClick={onTogglePause}
                        style={{
                            width: '100%', marginTop: '5px',
                            background: isPaused ? 'var(--bg-side)' : 'var(--accent-blue)',
                            border: `1px solid ${isPaused ? 'var(--border-main)' : 'var(--accent-blue)'}`,
                            color: isPaused ? 'var(--text-muted)' : '#fff',
                            borderRadius: '999px', padding: '6px', fontSize: '11px', cursor: 'pointer',
                            fontWeight: 600, transition: 'background-color 0.2s, color 0.2s', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px',
                            letterSpacing: '0.4px'
                        }}
                    >
                        {pauseButton}
                    </button>
                </div>
                {analyticsModal}
            </>
        );
    }

    return (
        <>
            <div data-coach="stats" style={{
                position: 'relative', display: 'flex', justifyContent: 'center', alignItems: 'center', gap: '30px',
                padding: '10px 20px', backgroundColor: 'var(--bg-main)', borderTop: '1px solid var(--border-main)',
                fontSize: '13px', userSelect: 'none', transition: '0.3s'
            }}>
                <button
                    onClick={onTogglePause}
                    style={{
                        background: isPaused ? 'var(--bg-side)' : 'var(--accent-blue)',
                        border: `1px solid ${isPaused ? 'var(--border-main)' : 'var(--accent-blue)'}`,
                        color: isPaused ? 'var(--text-muted)' : '#fff',
                        borderRadius: '999px', padding: '6px 16px', fontSize: '12px', cursor: 'pointer',
                        fontWeight: 600, display: 'flex', alignItems: 'center', gap: '6px', transition: 'background-color 0.2s, color 0.2s',
                        letterSpacing: '0.4px'
                    }}
                >
                    {pauseButton}
                </button>
                <div style={{ display: 'flex', gap: '20px', alignItems: 'center' }}>
                    <StatBlock label={t('stats.chars')} value={chars} />
                    <StatBlock label={t('stats.words')} value={words} />
                    <StatBlock label={t('stats.sentences')} value={sentences} />
                    <div style={{ width: '1px', height: 28, background: 'var(--border-main)', margin: '0 5px' }} />
                    <StatBlock label={t('stats.time')} value={formatTime(time, t)} />
                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                        <span style={{ color: 'var(--text-muted)', fontSize: '11px', textTransform: 'uppercase' }}>{t('stats.speed')}</span>
                        {speedButton}
                    </div>
                </div>
            </div>
            {analyticsModal}
        </>
    );
});

const StatBlock = ({ label, value }: { label: string; value: React.ReactNode }) => (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
        <span style={{ color: 'var(--text-muted)', fontSize: '11px', textTransform: 'uppercase' }}>{label}</span>
        <span style={{ color: 'var(--text-main)', fontWeight: 'bold', fontSize: '16px' }}>{value}</span>
    </div>
);


export default StatsPanel;
