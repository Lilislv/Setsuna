import { useEffect, useRef, useState, type ReactNode } from 'react';
import { IconBookTab, IconClear, IconExport, IconHome, IconImport, IconPin, IconSearch, IconSettings } from './Icons';
import './AppMenu.css';

export interface AppMenuSource {
    id: string;
    label: string;
    active: boolean;
    pending?: boolean;
    primary?: boolean;
    onToggle: () => void;
    onContextMenu?: () => void;
    title?: string;
}

interface AppMenuTile {
    id: string;
    label: string;
    hint?: string;
    icon: ReactNode;
    onSelect: () => void;
}

interface AppMenuProps {
    open: boolean;
    onClose: () => void;
    english: boolean;
    title: string;
    subtitle?: string;
    tabs: ReactNode;
    tabCount: number;
    onAddTab: () => void;
    /** The tab list shows archived tabs instead of the regular ones. */
    archiveView?: boolean;
    archiveCount?: number;
    onToggleArchive?: () => void;
    sources: AppMenuSource[];
    tiles: AppMenuTile[];
    onImport: () => void;
    onExport: () => void;
    onHome: () => void;
    onClear: () => void;
}

const CLOSE_MS = 180;

const IconLayers = () => <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m12 3 9 5-9 5-9-5z" /><path d="m3 13 9 5 9-5" /></svg>;
const IconArchiveBox = () => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="4" rx="1" /><path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8M10 12h4" /></svg>;

const IconDeck = () => <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="3" y="7" width="13" height="14" rx="2" /><path d="M7 7V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3" /></svg>;
const IconShare = () => <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="2.2" /><path d="M7.8 7.8a6 6 0 0 0 0 8.4M16.2 7.8a6 6 0 0 1 0 8.4M4.9 4.9a10 10 0 0 0 0 14.2M19.1 4.9a10 10 0 0 1 0 14.2" /></svg>;
export const MenuIcons = { IconLayers, IconPin, IconSearch, IconSettings, IconBookTab, IconDeck, IconShare };

/** Full-window reader menu opened with Esc, styled after the EPUB reader menu. */
export default function AppMenu({
    open, onClose, english, title, subtitle, tabs, tabCount, onAddTab, archiveView = false, archiveCount = 0, onToggleArchive,
    sources, tiles, onImport, onExport, onHome, onClear,
}: AppMenuProps) {
    const [mounted, setMounted] = useState(open);
    const [visible, setVisible] = useState(false);
    const [entering, setEntering] = useState(false);
    const panelRef = useRef<HTMLDivElement>(null);
    const pendingActionRef = useRef<(() => void) | null>(null);

    useEffect(() => {
        if (open) {
            setMounted(true);
            setEntering(true);
            const frame = requestAnimationFrame(() => setVisible(true));
            const settle = window.setTimeout(() => setEntering(false), 900);
            return () => { cancelAnimationFrame(frame); window.clearTimeout(settle); };
        }
        setVisible(false);
        const timer = window.setTimeout(() => {
            setMounted(false);
            const action = pendingActionRef.current;
            pendingActionRef.current = null;
            action?.();
        }, CLOSE_MS);
        return () => window.clearTimeout(timer);
    }, [open]);

    useEffect(() => {
        if (!visible) return;
        const panel = panelRef.current;
        (panel?.querySelector<HTMLElement>('.app-menu-tab.is-active') || panel)?.focus({ preventScroll: false });
        panel?.querySelector('.app-menu-tab.is-active')?.scrollIntoView({ block: 'nearest' });
    }, [visible]);

    if (!mounted) return null;

    const run = (action: () => void) => {
        pendingActionRef.current = action;
        onClose();
    };
    const L = (en: string, ru: string) => (english ? en : ru);

    return (
        <div
            className={`app-menu-backdrop${visible ? ' is-open' : ''}${visible && entering ? ' is-entering' : ''}`}
            onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}
            role="presentation"
        >
            <div ref={panelRef} tabIndex={-1} className="app-menu" role="dialog" aria-modal="true" aria-labelledby="app-menu-title">
                <header className="app-menu-heading">
                    <div className="app-menu-heading-text">
                        <p className="app-menu-brand">SETSUNA</p>
                        <h1 id="app-menu-title">{title}</h1>
                        {subtitle && <p className="app-menu-subtitle">{subtitle}</p>}
                    </div>
                    <button type="button" className="app-menu-close" onClick={onClose} aria-label={L('Close menu', 'Закрыть меню')}>
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" /></svg>
                    </button>
                </header>

                <div className="app-menu-body">
                    <section className={`app-menu-column app-menu-tabs-column${archiveView ? ' is-archive-view' : ''}`} aria-label={archiveView ? L('Archive', 'Архив') : L('Tabs', 'Вкладки')}>
                        <div className="app-menu-section-head">
                            {archiveView ? (
                                <span className="app-menu-section-label app-menu-archive-label"><IconArchiveBox /> {L('Archive', 'Архив')} <span className="app-menu-count">{archiveCount}</span></span>
                            ) : (
                                <span className="app-menu-section-label">{L('Tabs', 'Вкладки')} <span className="app-menu-count">{tabCount}</span></span>
                            )}
                            <div className="app-menu-section-actions">
                                {archiveView ? (
                                    <button type="button" className="app-menu-back-button" onClick={onToggleArchive} title={L('Back to tabs', 'Назад к вкладкам')}>
                                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M15 18l-6-6 6-6" /></svg>
                                        {L('Tabs', 'Вкладки')}
                                    </button>
                                ) : (
                                    <>
                                        {onToggleArchive && (
                                            <button type="button" className="app-menu-icon-button app-menu-archive-toggle" onClick={onToggleArchive} title={L('Archive', 'Архив')} aria-label={L('Show archived tabs', 'Показать архив')}>
                                                <IconArchiveBox />
                                                {archiveCount > 0 && <span>{archiveCount}</span>}
                                            </button>
                                        )}
                                        <button type="button" className="app-menu-icon-button" onClick={onAddTab} title={L('New tab', 'Новая вкладка')} aria-label={L('New tab', 'Новая вкладка')}>+</button>
                                    </>
                                )}
                            </div>
                        </div>
                        {tabs}
                        <p className="app-menu-tabs-hint">
                            {archiveView
                                ? L('Archived tabs open read-only · right-click to restore or delete', 'Архивные вкладки открываются только для чтения · ПКМ — вернуть или удалить')
                                : L('Drag to reorder · double-click to rename · right-click for more', 'Перетаскивание — порядок · двойной клик — имя · ПКМ — ещё')}
                        </p>
                    </section>

                    <section className="app-menu-column">
                        <div className="app-menu-section-head">
                            <span className="app-menu-section-label">{L('Text sources', 'Источники текста')}</span>
                        </div>
                        <div className="app-menu-source-list">
                            {sources.map((source, index) => (
                                <button
                                    key={source.id}
                                    type="button"
                                    style={{ ['--i' as any]: index }}
                                    className={`app-menu-source${source.active ? ' is-active' : ''}${source.pending ? ' is-pending' : ''}`}
                                    onClick={source.onToggle}
                                    onContextMenu={source.onContextMenu ? (event) => { event.preventDefault(); run(source.onContextMenu!); } : undefined}
                                    title={source.title}
                                    aria-pressed={source.active}
                                >
                                    <span className="app-menu-source-dot" aria-hidden="true" />
                                    <span>{source.label}</span>
                                    {source.primary && <span className="app-menu-source-badge">{L('main', 'основной')}</span>}
                                </button>
                            ))}
                        </div>

                        <div className="app-menu-section-head" style={{ marginTop: 22 }}>
                            <span className="app-menu-section-label">{L('Actions', 'Действия')}</span>
                        </div>
                        <div className="app-menu-grid">
                            {tiles.map((tile, index) => (
                                <button key={tile.id} type="button" className="app-menu-tile" style={{ ['--i' as any]: index }} onClick={() => run(tile.onSelect)}>
                                    <span className="app-menu-tile-icon">{tile.icon}</span>
                                    <span className="app-menu-tile-text">
                                        <strong>{tile.label}</strong>
                                        {tile.hint && <small>{tile.hint}</small>}
                                    </span>
                                </button>
                            ))}
                        </div>
                    </section>
                </div>

                <footer className="app-menu-footer">
                    <div className="app-menu-footer-actions">
                        <button type="button" onClick={() => run(onImport)}><IconExport /> {L('Import', 'Импорт')}</button>
                        <button type="button" onClick={() => run(onExport)}><IconImport /> {L('Export', 'Экспорт')}</button>
                        <button type="button" className="is-home" onClick={() => run(onHome)}><IconHome /> {L('Home screen', 'Главный экран')}</button>
                        <button type="button" className="is-danger" onClick={() => run(onClear)}><IconClear /> {L('Clear tab', 'Очистить вкладку')}</button>
                    </div>
                    <p className="app-menu-hint"><kbd>Esc</kbd> {L('back to reading', 'вернуться к чтению')}</p>
                </footer>
            </div>
        </div>
    );
}
