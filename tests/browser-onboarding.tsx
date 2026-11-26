import { createRoot } from 'react-dom/client';
import { useState } from 'react';
import HomeScreen from '../src/components/HomeScreen';
import AppMenu, { MenuIcons } from '../src/components/AppMenu';
import { ONBOARDING_SAMPLE_LINES, modeTips } from '../src/features/onboarding/guides';
import { menuTips, settingsTips, SETTINGS_TIP_SECTIONS } from '../src/features/onboarding/surfaceTips';
import OnboardingLayer from '../src/features/onboarding/OnboardingLayer';
import CoachTour from '../src/features/onboarding/CoachTour';
import TourHelpButton from '../src/features/onboarding/TourHelpButton';
import { resetOnboarding } from '../src/features/onboarding/onboardingStore';
import { themes } from '../src/utils/constants';
import '../src/index.css';
import '../src/App.css';

// Onboarding check: /tests/browser-onboarding.html shows the home screen ("?" on
// each mode); ?mode=texthooker shows a TextHooker-like screen with the first-visit
// introduction and the button tips. window.resetTips() starts over.
Object.entries(themes.dark).forEach(([key, value]) => document.documentElement.style.setProperty(key, String(value)));
Object.assign(window, {
    resetTips: () => { resetOnboarding(); location.reload(); },
    // Every tip selector must be valid CSS (a bad one would throw while touring).
    checkSelectors: () => {
        const all = ['ru', 'en'].flatMap((l) => [
            ...(['texthooker', 'epub', 'player'] as const).flatMap((m) => modeTips(m, l)),
            ...menuTips(l),
            ...SETTINGS_TIP_SECTIONS.flatMap((s) => settingsTips(s, l)),
        ]);
        const bad = all.filter((step) => { try { document.querySelector(step.target); return false; } catch { return true; } });
        return { total: all.length, bad: bad.map((step) => step.target) };
    },
});

const lang = new URLSearchParams(location.search).get('lang') === 'en' ? 'en' : 'ru';

function TextHookerMock() {
    const pill = { padding: '6px 12px', borderRadius: 999, border: '1px solid var(--border-main)', background: 'var(--bg-panel)', color: 'var(--text-main)', fontSize: 12 } as const;
    return (
        <div style={{ height: '100vh', background: 'var(--bg-main)', color: 'var(--text-main)', position: 'relative', fontFamily: 'sans-serif' }}>
            <div style={{ position: 'absolute', top: 12, left: '50%', translate: '-50% 0', display: 'flex', gap: 6, padding: 6, borderRadius: 999, background: 'var(--bg-side)', border: '1px solid var(--border-main)' }}>
                <button data-coach="tab" style={pill}>● 死月妖花～四月八日～ 22 680 симв.</button>
                <button data-coach="source" style={pill}>● ag</button>
                <button data-coach="flow" style={pill}>Flow</button>
                <button data-coach="ai" style={pill}>ИИ</button>
                <button data-coach="menu" style={pill}>☰ Esc</button>
                <TourHelpButton surface="mode:texthooker" language={lang} />
            </div>
            <div data-coach="stats" style={{ position: 'absolute', top: 40, right: 12, width: 120, height: 150, borderRadius: 12, border: '1px solid var(--border-main)', background: 'var(--bg-panel)' }} />
            <div style={{ padding: '90px 32px', fontSize: 24, lineHeight: 2.6 }}>
                {[...ONBOARDING_SAMPLE_LINES].map((line, index) => (
                    <div key={index} data-line-index={index} style={{ width: 'fit-content' }}>{line}</div>
                ))}
            </div>
        </div>
    );
}

function Root() {
    const [mode] = useState(new URLSearchParams(location.search).get('mode'));
    if (mode === 'settings') {
        // Settings-like window: content scrolls inside it, below a header.
        const card = (id: string, title: string, height: number) => (
            <div id={id} style={{ height, margin: '0 0 20px', padding: 20, borderRadius: 16, border: '1px solid var(--border-main)', background: 'var(--bg-panel)', color: 'var(--text-main)' }}>{title}</div>
        );
        return (
            <div style={{ height: '100vh', background: 'var(--bg-main)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <div className="settings-window" style={{ width: 1100, height: 700, display: 'flex', flexDirection: 'column', borderRadius: 20, border: '1px solid var(--border-main)', background: 'var(--bg-side)', overflow: 'hidden' }}>
                    <header className="settings-topbar" style={{ height: 90, padding: 20, color: 'var(--text-main)', borderBottom: '1px solid var(--border-main)' }}>Lookup<span className="settings-topbar-actions" style={{ float: 'right' }}>Предпросмотр · Мастер · Сброс</span></header>
                    <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
                        <nav className="settings-navigation" style={{ width: 220, borderRight: '1px solid var(--border-main)' }} />
                        <main className="settings-content" style={{ flex: 1, overflowY: 'auto', padding: 24 }}>
                            {card('lookup-win', 'Окно словаря и клавиши (высокий блок с превью)', 820)}
                            {card('lookup-dicts', 'Словари', 400)}
                        </main>
                    </div>
                </div>
                <CoachTour steps={settingsTips('lookup', lang)} language={lang} active delayMs={300} />
            </div>
        );
    }
    if (mode === 'menu') {
        const tile = (id: string, label: string, hint: string) => ({ id, label, hint, icon: <MenuIcons.IconLayers />, onSelect: () => {} });
        return (
            <AppMenu open onClose={() => {}} english={lang === 'en'} title="死月妖花～四月八日～" subtitle="Читаю · 22 680 симв." tabCount={3}
                tabs={<div style={{ padding: 12 }}>I/O · 13 se · LB</div>} onAddTab={() => {}} archiveCount={2} onToggleArchive={() => {}}
                sources={[{ id: 'ag', label: 'ag', active: false, primary: true, onToggle: () => {} }, { id: 'clipboard', label: 'Буфер', active: false, onToggle: () => {} }] as any}
                tiles={[tile('capture', 'Захват', 'game.exe'), tile('deck', 'Колода', 'all::shigatsu'), tile('shared', 'Читать вместе', 'код'), tile('flow', 'Flow', 'Окно поверх игры'), tile('search', 'Поиск', 'Ctrl + F'), tile('settings', 'Настройки', 'Источники, лукап, Anki')]}
                onImport={() => {}} onExport={() => {}} onHome={() => {}} onClear={() => {}} />
        );
    }
    if (mode === 'texthooker') {
        return <><TextHookerMock /><OnboardingLayer mode="texthooker" language={lang} tips /></>;
    }
    return <HomeScreen language={lang} onTextHooker={() => {}} onEpub={() => {}} onPlayer={() => {}} onAnki={() => {}} onSettings={() => {}} wsConnected={false} />;
}

createRoot(document.getElementById('root')!).render(<Root />);
