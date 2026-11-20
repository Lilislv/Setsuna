import { useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ReadingSpeedSample } from '../utils/constants';
import { speedCurve, type SpeedMetric } from '../utils/speedSamples';
import { dayKey, getDay, getRecentDays, useDailyStatsVersion, type DayCounts } from '../utils/dailyStats';
import './SpeedAnalytics.css';

interface SpeedAnalyticsProps {
    open: boolean;
    closing: boolean;
    onClose: () => void;
    english: boolean;
    tabId: number | string | null;
    tabName: string;
    stats: { chars: number; words: number; sentences: number; time: number };
    samples: ReadingSpeedSample[];
    defaultMetric: SpeedMetric;
    timeframe: 'minute' | 'hour';
}

const RANGES: { id: string; seconds: number | null; ru: string; en: string }[] = [
    { id: '10m', seconds: 600, ru: '10 мин', en: '10 min' },
    { id: '30m', seconds: 1800, ru: '30 мин', en: '30 min' },
    { id: '1h', seconds: 3600, ru: '1 ч', en: '1 h' },
    { id: '3h', seconds: 10800, ru: '3 ч', en: '3 h' },
    { id: 'all', seconds: null, ru: 'Всё', en: 'All' },
];

const CHART_W = 760;
const CHART_H = 220;
const PAD = { top: 16, right: 12, bottom: 28, left: 48 };

const formatClock = (seconds: number) => {
    const total = Math.max(0, Math.round(seconds));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    return h > 0 ? `${h}:${String(m).padStart(2, '0')}` : `${m}:${String(total % 60).padStart(2, '0')}`;
};

const formatDuration = (seconds: number, english: boolean) => {
    const total = Math.max(0, Math.round(seconds));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    if (h > 0) return english ? `${h} h ${m} min` : `${h} ч ${m} мин`;
    return english ? `${m} min` : `${m} мин`;
};

const formatNumber = (value: number) => Math.round(value).toLocaleString('ru-RU');

/** Smooth path through points (Catmull-Rom converted to cubic Béziers). */
const smoothPath = (points: { x: number; y: number }[]) => {
    if (points.length === 0) return '';
    if (points.length === 1) return `M ${points[0].x} ${points[0].y}`;
    let d = `M ${points[0].x.toFixed(1)} ${points[0].y.toFixed(1)}`;
    for (let i = 0; i < points.length - 1; i += 1) {
        const p0 = points[i - 1] || points[i];
        const p1 = points[i];
        const p2 = points[i + 1];
        const p3 = points[i + 2] || p2;
        const c1x = p1.x + (p2.x - p0.x) / 6;
        const c1y = p1.y + (p2.y - p0.y) / 6;
        const c2x = p2.x - (p3.x - p1.x) / 6;
        const c2y = p2.y - (p3.y - p1.y) / 6;
        d += ` C ${c1x.toFixed(1)} ${c1y.toFixed(1)}, ${c2x.toFixed(1)} ${c2y.toFixed(1)}, ${p2.x.toFixed(1)} ${p2.y.toFixed(1)}`;
    }
    return d;
};

export default function SpeedAnalytics({ open, closing, onClose, english, tabId, tabName, stats, samples, defaultMetric, timeframe }: SpeedAnalyticsProps) {
    const L = (en: string, ru: string) => (english ? en : ru);
    const [rangeId, setRangeId] = useState('30m');
    const [metric, setMetric] = useState<SpeedMetric>(defaultMetric);
    const [hoverIndex, setHoverIndex] = useState<number | null>(null);
    const chartRef = useRef<SVGSVGElement>(null);
    useDailyStatsVersion();

    const unitFactor = timeframe === 'hour' ? 60 : 1;
    const metricShort = metric === 'chars' ? L('ch', 'с') : metric === 'words' ? L('w', 'сл') : L('s', 'пр');
    const unitLabel = `${metricShort}/${timeframe === 'hour' ? L('h', 'ч') : L('min', 'мин')}`;
    const range = RANGES.find((item) => item.id === rangeId) || RANGES[1];

    const curve = useMemo(
        () => speedCurve(samples, stats, metric, range.seconds),
        [samples, stats, metric, range.seconds],
    );

    const chart = useMemo(() => {
        const points = curve.points;
        const innerW = CHART_W - PAD.left - PAD.right;
        const innerH = CHART_H - PAD.top - PAD.bottom;
        const maxValue = Math.max(1, ...points.map((point) => point.perMinute * unitFactor)) * 1.12;
        const minTime = points.length ? points[0].time : 0;
        const maxTime = points.length ? points[points.length - 1].time : 1;
        const span = Math.max(1, maxTime - minTime);
        const xy = points.map((point) => ({
            x: PAD.left + ((point.time - minTime) / span) * innerW,
            y: PAD.top + innerH - ((point.perMinute * unitFactor) / maxValue) * innerH,
        }));
        const line = smoothPath(xy);
        const area = xy.length > 1 ? `${line} L ${xy[xy.length - 1].x.toFixed(1)} ${PAD.top + innerH} L ${xy[0].x.toFixed(1)} ${PAD.top + innerH} Z` : '';
        const avgY = PAD.top + innerH - ((curve.averagePerMinute * unitFactor) / maxValue) * innerH;
        const yTicks = [0, 0.25, 0.5, 0.75, 1].map((level) => ({ y: PAD.top + innerH - level * innerH, value: maxValue * level }));
        const xTicks = Array.from({ length: 5 }, (_, i) => ({ x: PAD.left + (i / 4) * innerW, time: minTime + (i / 4) * span }));
        return { xy, line, area, avgY, yTicks, xTicks, innerH };
    }, [curve, unitFactor]);

    const today = getDay(dayKey());
    const tabToday: DayCounts = (tabId != null && today.tabs[String(tabId)]) || { chars: 0, words: 0, sentences: 0, lines: 0, seconds: 0 };
    const recent = getRecentDays(14);
    const recentMax = Math.max(1, ...recent.map((day) => day.record.total[metric]));

    if (!open) return null;

    const hoverPoint = hoverIndex != null ? curve.points[hoverIndex] : null;
    const hoverXY = hoverIndex != null ? chart.xy[hoverIndex] : null;

    const onChartMove = (event: React.PointerEvent<SVGSVGElement>) => {
        const svg = chartRef.current;
        if (!svg || chart.xy.length === 0) return;
        const rect = svg.getBoundingClientRect();
        const x = ((event.clientX - rect.left) / rect.width) * CHART_W;
        let best = 0;
        for (let i = 1; i < chart.xy.length; i += 1) {
            if (Math.abs(chart.xy[i].x - x) < Math.abs(chart.xy[best].x - x)) best = i;
        }
        setHoverIndex(best);
    };

    const metricNames: Record<SpeedMetric, string> = { chars: L('Characters', 'Символы'), words: L('Words', 'Слова'), sentences: L('Sentences', 'Предложения') };
    const dayCards = (counts: DayCounts) => (
        <div className="speed-day-grid">
            <div><span>{L('Characters', 'Символы')}</span><strong>{formatNumber(counts.chars)}</strong></div>
            <div><span>{L('Words', 'Слова')}</span><strong>{formatNumber(counts.words)}</strong></div>
            <div><span>{L('Sentences', 'Предложения')}</span><strong>{formatNumber(counts.sentences)}</strong></div>
            <div><span>{L('Reading time', 'Время чтения')}</span><strong>{formatDuration(counts.seconds, english)}</strong></div>
        </div>
    );

    return createPortal(
        <div className={`speed-overlay${closing ? ' is-closing' : ''}`} onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
            <div className="speed-sheet" role="dialog" aria-modal="true" aria-label={L('Reading analytics', 'Аналитика чтения')}>
                <header className="speed-header">
                    <div>
                        <p className="speed-eyebrow">{L('ANALYTICS', 'АНАЛИТИКА')}</p>
                        <h2>{L('Reading speed', 'Скорость чтения')}</h2>
                        <p className="speed-subtitle">{tabName} · {L('by reading timer', 'по таймеру чтения')}</p>
                    </div>
                    <button type="button" className="speed-close" onClick={onClose} aria-label={L('Close', 'Закрыть')}>
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" /></svg>
                    </button>
                </header>

                <div className="speed-body">
                    <div className="speed-controls">
                        <div className="speed-segment" role="group" aria-label={L('Period', 'Период')}>
                            {RANGES.map((item) => (
                                <button key={item.id} type="button" className={item.id === rangeId ? 'is-active' : ''} onClick={() => { setRangeId(item.id); setHoverIndex(null); }}>
                                    {english ? item.en : item.ru}
                                </button>
                            ))}
                        </div>
                        <div className="speed-segment" role="group" aria-label={L('Metric', 'Метрика')}>
                            {(['chars', 'words', 'sentences'] as SpeedMetric[]).map((item) => (
                                <button key={item} type="button" className={item === metric ? 'is-active' : ''} onClick={() => { setMetric(item); setHoverIndex(null); }}>
                                    {metricNames[item]}
                                </button>
                            ))}
                        </div>
                    </div>

                    <div className="speed-kpis">
                        <div className="speed-kpi is-primary">
                            <span>{L('Speed for the period', 'Скорость за период')}</span>
                            <strong>{formatNumber(curve.averagePerMinute * unitFactor)}</strong>
                            <small>{unitLabel}</small>
                        </div>
                        <div className="speed-kpi">
                            <span>{L('Peak', 'Пик')}</span>
                            <strong>{formatNumber(curve.peakPerMinute * unitFactor)}</strong>
                            <small>{unitLabel}</small>
                        </div>
                        <div className="speed-kpi">
                            <span>{L('Lowest', 'Минимум')}</span>
                            <strong>{formatNumber(curve.lowPerMinute * unitFactor)}</strong>
                            <small>{unitLabel}</small>
                        </div>
                        <div className="speed-kpi">
                            <span>{L('Read in the period', 'Прочитано за период')}</span>
                            <strong>{formatNumber(curve.read)}</strong>
                            <small>{metricNames[metric].toLowerCase()} · {formatDuration(curve.spanSeconds, english)}</small>
                        </div>
                    </div>

                    <div className="speed-chart-card">
                        {curve.points.length < 2 ? (
                            <div className="speed-chart-empty">
                                {L('Not enough reading time yet. Samples are taken every 15 seconds of the running timer.', 'Пока мало данных: замеры берутся каждые 15 секунд работающего таймера.')}
                            </div>
                        ) : (
                            <svg
                                ref={chartRef}
                                className="speed-chart"
                                viewBox={`0 0 ${CHART_W} ${CHART_H}`}
                                onPointerMove={onChartMove}
                                onPointerLeave={() => setHoverIndex(null)}
                            >
                                <defs>
                                    <linearGradient id="speed-area" x1="0" x2="0" y1="0" y2="1">
                                        <stop offset="0%" stopColor="var(--accent-blue)" stopOpacity="0.32" />
                                        <stop offset="100%" stopColor="var(--accent-blue)" stopOpacity="0" />
                                    </linearGradient>
                                </defs>
                                {chart.yTicks.map((tick, index) => (
                                    <g key={index}>
                                        <line x1={PAD.left} x2={CHART_W - PAD.right} y1={tick.y} y2={tick.y} className="speed-grid" />
                                        <text x={PAD.left - 8} y={tick.y + 4} className="speed-axis" textAnchor="end">{formatNumber(tick.value)}</text>
                                    </g>
                                ))}
                                {chart.xTicks.map((tick, index) => (
                                    <text key={index} x={tick.x} y={CHART_H - 8} className="speed-axis" textAnchor={index === 0 ? 'start' : index === 4 ? 'end' : 'middle'}>{formatClock(tick.time)}</text>
                                ))}
                                <path d={chart.area} fill="url(#speed-area)" className="speed-area" />
                                <line x1={PAD.left} x2={CHART_W - PAD.right} y1={chart.avgY} y2={chart.avgY} className="speed-avg" />
                                <path d={chart.line} className="speed-line" pathLength={1} />
                                {hoverXY && hoverPoint && (
                                    <g>
                                        <line x1={hoverXY.x} x2={hoverXY.x} y1={PAD.top} y2={PAD.top + chart.innerH} className="speed-crosshair" />
                                        <circle cx={hoverXY.x} cy={hoverXY.y} r="5" className="speed-dot" />
                                    </g>
                                )}
                            </svg>
                        )}
                        {hoverXY && hoverPoint && (
                            <div
                                className="speed-tooltip"
                                style={{ left: `${(hoverXY.x / CHART_W) * 100}%`, top: `${(hoverXY.y / CHART_H) * 100}%` }}
                            >
                                <strong>{formatNumber(hoverPoint.perMinute * unitFactor)} {unitLabel}</strong>
                                <span>{L('timer', 'таймер')} {formatClock(hoverPoint.time)}</span>
                            </div>
                        )}
                        <div className="speed-legend">
                            <span><i className="speed-legend-line" />{L('speed', 'скорость')}</span>
                            <span><i className="speed-legend-avg" />{L('period average', 'среднее за период')}</span>
                        </div>
                    </div>

                    <section className="speed-today">
                        <div className="speed-section-head">
                            <h3>{L('Today', 'Сегодня')}</h3>
                            <span>{new Date().toLocaleDateString(english ? 'en-GB' : 'ru-RU', { day: 'numeric', month: 'long' })}</span>
                        </div>
                        <div className="speed-today-columns">
                            <div>
                                <p className="speed-today-label">{L('This tab', 'Эта вкладка')}</p>
                                {dayCards(tabToday)}
                            </div>
                            <div>
                                <p className="speed-today-label">{L('All tabs', 'Все вкладки')}</p>
                                {dayCards(today.total)}
                            </div>
                        </div>
                        <div className="speed-days">
                            <p className="speed-today-label">{L(`Last 14 days · ${metricNames[metric].toLowerCase()}`, `Последние 14 дней · ${metricNames[metric].toLowerCase()}`)}</p>
                            <div className="speed-days-bars">
                                {recent.map((day, index) => {
                                    const value = day.record.total[metric];
                                    return (
                                        <div key={day.key} className={`speed-day-bar${index === recent.length - 1 ? ' is-today' : ''}`} title={`${day.date.toLocaleDateString(english ? 'en-GB' : 'ru-RU')}: ${formatNumber(value)}`}>
                                            <span style={{ height: `${Math.max(3, (value / recentMax) * 100)}%`, ['--i' as any]: index }} />
                                            <small>{day.date.getDate()}</small>
                                        </div>
                                    );
                                })}
                            </div>
                        </div>
                    </section>
                </div>
            </div>
        </div>,
        document.body,
    );
}
