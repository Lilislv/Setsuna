import { memo, useMemo, useState } from 'react';
import { getTranslator, type AppLanguage } from '../utils/i18n';
import type { ReadingSpeedSample } from '../utils/constants';

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
}

const chartWidth = 760;
const chartHeight = 250;

const colors = {
    bg: '#1a1a1a',
    panel: '#202020',
    panel2: '#252525',
    border: '#3a3a3a',
    text: '#f1f1f1',
    muted: '#a8a8a8',
    blue: '#4fa6ff',
    green: '#35d07f',
};

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
}: StatsPanelProps) {
    const [analyticsOpen, setAnalyticsOpen] = useState(false);
    const [rangeValue, setRangeValue] = useState(30);
    const [rangeUnit, setRangeUnit] = useState<'minutes' | 'hours'>('minutes');
    const t = getTranslator(language);
    const { chars, words, sentences, time } = stats;

    const multiplier = speedTimeframe === 'minute' ? 60 : 3600;
    const speedValue = time > 0 ? Math.round((getMetric(stats, speedMetric) / time) * multiplier) : 0;
    const metricText = speedMetric === 'chars' ? t('stats.secondsShort') : speedMetric === 'words' ? t('stats.wordsShort') : t('stats.sentencesShort');
    const timeframeText = speedTimeframe === 'minute' ? t('stats.minutesShort') : t('stats.hoursShort');
    const metricLabel = `${metricText}/${timeframeText}`;

    const analytics = useMemo(() => {
        const now = Date.now();
        const rangeMs = Math.max(1, rangeValue || 1) * (rangeUnit === 'minutes' ? 60_000 : 3_600_000);
        const filtered = speedSamples.filter((sample) => sample.at >= now - rangeMs);
        const source = filtered.length >= 2 ? filtered : speedSamples.slice(-48);

        const intervals = source
            .map((sample, index, arr) => {
                if (index === 0) return null;
                const prev = arr[index - 1];
                const deltaTime = Math.max(1, sample.time - prev.time);
                const deltaMetric = Math.max(0, getMetric(sample, speedMetric) - getMetric(prev, speedMetric));
                return Math.round((deltaMetric / deltaTime) * multiplier);
            })
            .filter((value): value is number => value !== null);

        const values = intervals.length ? intervals : [speedValue];
        const max = Math.max(1, ...values);
        const min = Math.min(...values);
        const avg = Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
        const peak = Math.max(...values);
        const points = values.map((value, index) => {
            const x = values.length === 1 ? chartWidth / 2 : (index / (values.length - 1)) * chartWidth;
            const y = chartHeight - (value / max) * (chartHeight - 20) - 10;
            return `${x.toFixed(1)},${y.toFixed(1)}`;
        }).join(' ');

        return { values, points, peak, min, avg, max, count: source.length };
    }, [multiplier, rangeUnit, rangeValue, speedMetric, speedSamples, speedValue]);

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
                color: colors.blue,
                fontWeight: 'bold',
                cursor: 'pointer',
            }}
            title={language === 'en' ? 'Open reading speed analytics' : 'Открыть аналитику скорости чтения'}
        >
            <span style={{ fontSize: position === 'top-right' ? 13 : 16 }}>{speedValue}</span>
            <span style={{ color: colors.muted, fontSize: position === 'top-right' ? 10 : 11, fontWeight: 'normal' }}>{metricLabel}</span>
        </button>
    );

    const analyticsModal = analyticsOpen ? (
        <div
            onMouseDown={(event) => {
                if (event.target === event.currentTarget) setAnalyticsOpen(false);
            }}
            style={{
                position: 'fixed',
                inset: 0,
                zIndex: 5000,
                display: 'grid',
                placeItems: 'center',
                padding: 24,
                background: 'rgba(0,0,0,0.58)',
            }}
        >
            <div
                style={{
                    width: 'min(920px, calc(100vw - 48px))',
                    maxHeight: 'min(720px, calc(100vh - 48px))',
                    overflow: 'auto',
                    border: `1px solid ${colors.border}`,
                    borderRadius: 10,
                    background: colors.panel,
                    color: colors.text,
                    boxShadow: '0 22px 70px rgba(0,0,0,0.55)',
                }}
            >
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 14, padding: '18px 20px', borderBottom: `1px solid ${colors.border}` }}>
                    <div>
                        <h2 style={{ margin: 0, fontSize: 22 }}>{language === 'en' ? 'Reading Speed Analytics' : 'Аналитика скорости чтения'}</h2>
                        <div style={{ color: colors.muted, fontSize: 13, marginTop: 4 }}>
                            {language === 'en' ? 'Based on recent reading samples' : 'По последним замерам чтения'} · {metricLabel}
                        </div>
                    </div>
                    <button
                        onClick={() => setAnalyticsOpen(false)}
                        style={{ width: 34, height: 34, border: `1px solid ${colors.border}`, borderRadius: 7, background: colors.panel2, color: colors.text, cursor: 'pointer', fontSize: 18 }}
                    >
                        x
                    </button>
                </div>

                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'center', padding: '16px 20px 0' }}>
                    <span style={{ color: colors.muted, fontSize: 13 }}>{language === 'en' ? 'Show last' : 'Показать последние'}</span>
                    <input
                        type="number"
                        min={1}
                        max={rangeUnit === 'minutes' ? 1440 : 168}
                        value={rangeValue}
                        onChange={(event) => setRangeValue(Math.max(1, Number(event.target.value) || 1))}
                        style={{ width: 92, height: 34, padding: '0 10px', borderRadius: 7, border: `1px solid ${colors.border}`, background: '#151515', color: colors.text }}
                    />
                    <select
                        value={rangeUnit}
                        onChange={(event) => setRangeUnit(event.target.value as 'minutes' | 'hours')}
                        style={{ height: 34, padding: '0 10px', borderRadius: 7, border: `1px solid ${colors.border}`, background: '#151515', color: colors.text }}
                    >
                        <option value="minutes">{language === 'en' ? 'minutes' : 'минут'}</option>
                        <option value="hours">{language === 'en' ? 'hours' : 'часов'}</option>
                    </select>
                    <span style={{ color: colors.muted, fontSize: 13 }}>
                        {language === 'en' ? 'samples' : 'замеров'}: {analytics.count}
                    </span>
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 10, padding: 20 }}>
                    <MetricCard label={language === 'en' ? 'Current' : 'Сейчас'} value={speedValue} suffix={metricLabel} accent={colors.blue} />
                    <MetricCard label={language === 'en' ? 'Peak' : 'Пик'} value={analytics.peak} suffix={metricLabel} accent={colors.green} />
                    <MetricCard label={language === 'en' ? 'Lowest' : 'Минимум'} value={analytics.min} suffix={metricLabel} accent="#ff7a7a" />
                    <MetricCard label={language === 'en' ? 'Average' : 'Средняя'} value={analytics.avg} suffix={metricLabel} accent="#d7b8ff" />
                </div>

                <div style={{ padding: '0 20px 22px' }}>
                    <div style={{ border: `1px solid ${colors.border}`, borderRadius: 8, background: '#161616', padding: 16 }}>
                        <svg width="100%" height={chartHeight} viewBox={`0 0 ${chartWidth} ${chartHeight}`} preserveAspectRatio="none" style={{ display: 'block' }}>
                            {[0, 0.25, 0.5, 0.75, 1].map((level) => {
                                const y = 10 + level * (chartHeight - 20);
                                return <line key={level} x1="0" x2={chartWidth} y1={y} y2={y} stroke="#2d2d2d" strokeWidth="1" />;
                            })}
                            <polyline points={analytics.points} fill="none" stroke={colors.blue} strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
                            {analytics.values.map((value, index) => {
                                const x = analytics.values.length === 1 ? chartWidth / 2 : (index / (analytics.values.length - 1)) * chartWidth;
                                const y = chartHeight - (value / Math.max(1, analytics.max)) * (chartHeight - 20) - 10;
                                return <circle key={`${index}-${value}`} cx={x} cy={y} r="3" fill={colors.blue} opacity={index === analytics.values.length - 1 ? 1 : 0.45} />;
                            })}
                        </svg>
                    </div>
                </div>
            </div>
        </div>
    ) : null;

    const pauseButton = (
        <>
            {isPaused ? <IconPlay /> : <IconPause />}
            {isPaused ? t('stats.start') : t('stats.pause')}
        </>
    );

    if (position === 'top-right') {
        const isVertical = textOrientation === 'vertical';
        return (
            <>
                <div style={{
                    position: 'absolute', top: '50px', right: isVertical ? 'auto' : '20px', left: isVertical ? '20px' : 'auto',
                    backgroundColor: 'var(--bg-panel)', border: '1px solid var(--border-main)',
                    borderRadius: '8px', padding: '12px', display: 'flex', flexDirection: 'column',
                    gap: '10px', boxShadow: '0 8px 30px rgba(0,0,0,0.2)', zIndex: 90, opacity: 0.95, transition: '0.3s'
                }}>
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
                            borderRadius: '4px', padding: '6px', fontSize: '11px', cursor: 'pointer',
                            fontWeight: 'bold', transition: 'all 0.2s', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px',
                            letterSpacing: '1px'
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
            <div style={{
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
                        borderRadius: '6px', padding: '6px 16px', fontSize: '12px', cursor: 'pointer',
                        fontWeight: 'bold', display: 'flex', alignItems: 'center', gap: '6px', transition: 'all 0.2s',
                        letterSpacing: '1px'
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

const MetricCard = ({ label, value, suffix, accent }: { label: string; value: number; suffix: string; accent: string }) => (
    <div style={{ border: `1px solid ${colors.border}`, borderRadius: 8, background: colors.panel2, padding: 14 }}>
        <div style={{ color: colors.muted, fontSize: 12, marginBottom: 8 }}>{label}</div>
        <div style={{ color: accent, fontSize: 28, fontWeight: 800, lineHeight: 1 }}>{value}</div>
        <div style={{ color: colors.muted, fontSize: 11, marginTop: 6 }}>{suffix}</div>
    </div>
);

export default StatsPanel;
