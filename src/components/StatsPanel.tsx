import { memo } from 'react';

interface TabStats {
    chars: number;
    words: number;
    sentences: number;
    time: number;
}

interface StatsPanelProps {
    stats: TabStats;
    isPaused: boolean;
    onTogglePause: () => void;
    position: 'bottom' | 'top-right';
    speedMetric: 'chars' | 'words' | 'sentences';
    speedTimeframe: 'minute' | 'hour';
}

const formatTime = (seconds: number) => {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    // ТЕПЕРЬ СЕКУНДЫ НИКУДА НЕ ПРОПАДАЮТ
    if (h > 0) return `${h}ч ${m}м ${s}с`;
    return `${m}м ${s}с`;
};

// Строгие минималистичные SVG иконки
const IconChars = () => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg>;
const IconWords = () => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="4 7 4 4 20 4 20 7"></polyline><line x1="9" y1="20" x2="15" y2="20"></line><line x1="12" y1="4" x2="12" y2="20"></line></svg>;
const IconSentences = () => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"></path><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"></path></svg>;
const IconTime = () => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg>;
const IconSpeed = () => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"></polygon></svg>;
const IconPlay = () => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>;
const IconPause = () => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="6" y="4" width="4" height="16"></rect><rect x="14" y="4" width="4" height="16"></rect></svg>;

const StatsPanel = memo(function StatsPanel({ stats, isPaused, onTogglePause, position, speedMetric, speedTimeframe }: StatsPanelProps) {
    const { chars, words, sentences, time } = stats;

    let speedValue = 0;
    if (time > 0) {
        let baseMetric = chars;
        if (speedMetric === 'words') baseMetric = words;
        if (speedMetric === 'sentences') baseMetric = sentences;

        const timeInMinutes = time / 60;
        const timeInHours = time / 3600;

        if (speedTimeframe === 'minute') {
            speedValue = Math.round(baseMetric / timeInMinutes);
        } else {
            speedValue = Math.round(baseMetric / timeInHours);
        }
    }

    const getMetricLabel = () => {
        let m = speedMetric === 'chars' ? 'с' : speedMetric === 'words' ? 'сл' : 'пр';
        let t = speedTimeframe === 'minute' ? 'м' : 'ч';
        return `${m}/${t}`;
    };

    if (position === 'top-right') {
        return (
            <div style={{
                position: 'absolute', top: '50px', right: '20px',
                backgroundColor: 'var(--bg-panel)', border: '1px solid var(--border-main)',
                borderRadius: '8px', padding: '12px', display: 'flex', flexDirection: 'column',
                gap: '10px', boxShadow: '0 8px 30px rgba(0,0,0,0.2)', zIndex: 90, opacity: 0.95, transition: '0.3s'
            }}>
                <div style={{ display: 'grid', gridTemplateColumns: '20px 1fr', gap: '8px 12px', alignItems: 'center', fontSize: '13px' }}>
                    <div style={{ color: 'var(--text-muted)', display: 'flex', justifyContent: 'center' }} title="Символы"><IconChars /></div>
                    <div style={{ color: 'var(--text-main)', fontWeight: 'bold' }}>{chars}</div>
                    
                    <div style={{ color: 'var(--text-muted)', display: 'flex', justifyContent: 'center' }} title="Слова"><IconWords /></div>
                    <div style={{ color: 'var(--text-main)', fontWeight: 'bold' }}>{words}</div>
                    
                    <div style={{ color: 'var(--text-muted)', display: 'flex', justifyContent: 'center' }} title="Предложения"><IconSentences /></div>
                    <div style={{ color: 'var(--text-main)', fontWeight: 'bold' }}>{sentences}</div>
                    
                    <div style={{ color: 'var(--text-muted)', display: 'flex', justifyContent: 'center' }} title="Время"><IconTime /></div>
                    <div style={{ color: 'var(--text-main)', fontWeight: 'bold' }}>{formatTime(time)}</div>
                    
                    <div style={{ color: 'var(--text-muted)', display: 'flex', justifyContent: 'center' }} title="Скорость"><IconSpeed /></div>
                    <div style={{ color: 'var(--accent-blue)', fontWeight: 'bold' }}>{speedValue} <span style={{fontSize:'10px', color:'var(--text-muted)', fontWeight: 'normal'}}>{getMetricLabel()}</span></div>
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
                    {isPaused ? <><IconPlay /> ПУСК</> : <><IconPause /> ПАУЗА</>}
                </button>
            </div>
        );
    }

    return (
        <div style={{
            display: 'flex', justifyContent: 'center', alignItems: 'center', gap: '30px',
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
                {isPaused ? <><IconPlay /> ПУСК</> : <><IconPause /> ПАУЗА</>}
            </button>
            <div style={{ display: 'flex', gap: '20px' }}>
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                    <span style={{ color: 'var(--text-muted)', fontSize: '11px', textTransform: 'uppercase' }}>Символов</span>
                    <span style={{ color: 'var(--text-main)', fontWeight: 'bold', fontSize: '16px' }}>{chars}</span>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                    <span style={{ color: 'var(--text-muted)', fontSize: '11px', textTransform: 'uppercase' }}>Слов</span>
                    <span style={{ color: 'var(--text-main)', fontWeight: 'bold', fontSize: '16px' }}>{words}</span>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                    <span style={{ color: 'var(--text-muted)', fontSize: '11px', textTransform: 'uppercase' }}>Предложений</span>
                    <span style={{ color: 'var(--text-main)', fontWeight: 'bold', fontSize: '16px' }}>{sentences}</span>
                </div>
                <div style={{ width: '1px', background: 'var(--border-main)', margin: '0 5px' }} />
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                    <span style={{ color: 'var(--text-muted)', fontSize: '11px', textTransform: 'uppercase' }}>Время</span>
                    <span style={{ color: 'var(--text-main)', fontWeight: 'bold', fontSize: '16px' }}>{formatTime(time)}</span>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                    <span style={{ color: 'var(--text-muted)', fontSize: '11px', textTransform: 'uppercase' }}>Скорость</span>
                    <div style={{ display: 'flex', alignItems: 'baseline', gap: '4px' }}>
                        <span style={{ color: 'var(--accent-blue)', fontWeight: 'bold', fontSize: '16px' }}>{speedValue}</span>
                        <span style={{ color: 'var(--text-muted)', fontSize: '11px' }}>{getMetricLabel()}</span>
                    </div>
                </div>
            </div>
        </div>
    );
});

export default StatsPanel;