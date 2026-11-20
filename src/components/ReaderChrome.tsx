import { useEffect, useRef, useState, type HTMLAttributes, type ReactNode } from 'react';
import { DndContext, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent, type Modifier } from '@dnd-kit/core';
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { Tab } from '../utils/constants';
import { getTranslator } from '../utils/i18n';
import { getDecks } from '../utils/anki';
import { YATSU_READER_AVAILABLE } from '../utils/featureFlags';
import AppMenu, { MenuIcons, type AppMenuSource } from './AppMenu';
import { IconBookTab, IconPlayerTab } from './Icons';
import { useJelly } from '../utils/jelly';

type TabStatus = NonNullable<Tab['status']>;

const lockToVerticalAxis: Modifier = ({ transform }) => ({ ...transform, x: 0 });

/** One draggable tab row: dnd-kit moves it, the jelly hook squishes it. */
function SortableTabRow({ id, index, className, rowProps, children }: {
    id: number;
    index: number;
    className: string;
    rowProps: HTMLAttributes<HTMLDivElement>;
    children: ReactNode;
}) {
    const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id });
    const nodeRef = useRef<HTMLDivElement | null>(null);
    useJelly(() => nodeRef.current, isDragging, { axis: 'y' });
    return (
        <div
            ref={(node) => { nodeRef.current = node; setNodeRef(node); }}
            {...attributes}
            {...listeners}
            {...rowProps}
            data-tab-id={id}
            className={`${className}${isDragging ? ' is-dragging' : ''}`}
            style={{
                ['--i' as any]: Math.min(index, 12),
                transform: `${CSS.Transform.toString(transform) || ''} var(--jelly-transform, scale(1))`,
                transition: transition || undefined,
                zIndex: isDragging ? 3 : undefined,
            }}
        >
            {children}
        </div>
    );
}

/**
 * Desktop reader chrome: the Esc menu that holds tabs, text sources and every
 * toolbar action. Nothing is drawn over the text until Esc is pressed.
 */
export const TopBar = ({
    openEpubWorkspace,
    tabs,
    activeTabId,
    switchTab,
    editingTabId,
    setEditingTabId,
    setTabs,
    closeTab,
    openArchiveSettings,
    cycleTabStatus,
    addNewTab,
    settings,
    wsStatuses,
    wsIntents,
    toggleWs,
    useClipboard,
    toggleClipboard,
    openSearch,
    openImport,
    openExport,
    activeTab,
    openCaptureSourcePicker,
    openJlModeWindow,
    flowOpen,
    toggleFlow,
    clearAll,
    openHome,
    openSettings,
    lookupOpen,
    closeLookup,
    escMenuBlocked,
}: any) => {
    const isEn = settings?.appLanguage === 'en';
    const t = getTranslator(settings?.appLanguage || 'ru');
    const [isMenuOpen, setIsMenuOpen] = useState(false);
    const [tabMenu, setTabMenu] = useState<{ x: number; y: number; tabId: number } | null>(null);
    const [tabDecks, setTabDecks] = useState<string[]>([]);
    const suppressClickRef = useRef(false);
    const visibleTabs: Tab[] = tabs.filter((tab: Tab) => !tab.archived);
    const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));
    const primaryWebSocketId = settings?.primaryWebSocketId || settings?.websockets?.[0]?.id;

    const statusMeta = (status?: Tab['status']) => {
        if (status === 'reading') return { label: isEn ? 'Reading' : 'Читаю', color: '#4CAF50' };
        if (status === 'paused') return { label: isEn ? 'Paused' : 'На паузе', color: '#d6a84f' };
        if (status === 'completed') return { label: isEn ? 'Completed' : 'Прочитано', color: '#8bdeff' };
        return { label: isEn ? 'Planned' : 'В планах', color: '#8b8f98' };
    };
    const tabTypeIcon = (tab: Tab) => {
        if (tab.mode === 'epub') return { icon: <IconBookTab />, title: 'EPUB', color: '#d6a84f' };
        if (tab.mode === 'player') return { icon: <IconPlayerTab />, title: isEn ? 'Player' : 'Плеер', color: '#ff6b6b' };
        return null;
    };
    const getTabById = (id: number) => tabs.find((tab: Tab) => tab.id === id);

    const moveTab = (fromId: number, toId: number) => {
        if (fromId === toId) return;
        setTabs((prev: Tab[]) => {
            const fromIndex = prev.findIndex((tab) => tab.id === fromId);
            const toIndex = prev.findIndex((tab) => tab.id === toId);
            if (fromIndex < 0 || toIndex < 0) return prev;
            const next = [...prev];
            const [moved] = next.splice(fromIndex, 1);
            next.splice(toIndex, 0, moved);
            return next;
        });
    };
    const handleDragEnd = ({ active, over }: DragEndEvent) => {
        if (over && active.id !== over.id) moveTab(Number(active.id), Number(over.id));
        window.setTimeout(() => { suppressClickRef.current = false; }, 0);
    };

    const setTabStatus = (id: number, status: TabStatus) => {
        setTabs((prev: Tab[]) => prev.map((tab) => tab.id === id ? { ...tab, status } : tab));
        setTabMenu(null);
    };
    const setTabDeck = (id: number, deck: string) => {
        setTabs((prev: Tab[]) => prev.map((tab) => tab.id === id ? { ...tab, ankiDeck: deck || null } : tab));
    };
    const renameTab = (id: number) => {
        setEditingTabId(id);
        setTabMenu(null);
    };
    const duplicateTab = (id: number) => {
        const source = getTabById(id);
        if (!source) return;
        const copy: Tab = {
            ...source,
            id: Date.now(),
            name: `${source.name} copy`,
            stats: { ...source.stats },
            lines: [...source.lines],
            speedSamples: source.speedSamples ? [...source.speedSamples] : undefined,
            archived: false,
        };
        setTabs((prev: Tab[]) => {
            const index = prev.findIndex((tab) => tab.id === id);
            const next = [...prev];
            next.splice(index + 1, 0, copy);
            return next;
        });
        setTabMenu(null);
    };
    const archiveTab = (id: number) => {
        if (visibleTabs.length <= 1) return;
        setTabs((prev: Tab[]) => prev.map((tab) => tab.id === id ? { ...tab, archived: true } : tab));
        if (activeTabId === id) {
            const next = visibleTabs.find((tab) => tab.id !== id);
            if (next) switchTab(next.id);
        }
        setTabMenu(null);
    };
    const deleteTab = (id: number) => {
        if (visibleTabs.length <= 1) return;
        const next = tabs.filter((tab: Tab) => tab.id !== id);
        setTabs(next);
        if (activeTabId === id) {
            const nextVisible = next.find((tab: Tab) => !tab.archived);
            if (nextVisible) switchTab(nextVisible.id);
        }
        setTabMenu(null);
    };

    useEffect(() => {
        if (!tabMenu) return;
        if (settings?.ankiDeckMode === 'contextual') {
            getDecks().then(setTabDecks).catch(() => setTabDecks(settings?.ankiDeck ? [settings.ankiDeck] : []));
        }
        const close = () => setTabMenu(null);
        window.addEventListener('click', close);
        window.addEventListener('resize', close);
        return () => {
            window.removeEventListener('click', close);
            window.removeEventListener('resize', close);
        };
    }, [tabMenu]);

    useEffect(() => {
        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key !== 'Escape' || event.repeat || event.defaultPrevented) return;
            if (tabMenu) {
                event.preventDefault();
                setTabMenu(null);
                return;
            }
            const target = event.target;
            const inField = target instanceof Element && target.closest('input, textarea, select, [contenteditable="true"]');
            if (isMenuOpen) {
                if (inField) return;
                event.preventDefault();
                setIsMenuOpen(false);
                return;
            }
            if (inField) return;
            if (lookupOpen) {
                event.preventDefault();
                closeLookup?.();
                return;
            }
            if (escMenuBlocked || document.querySelector('.modal-overlay, .settings-window')) return;
            event.preventDefault();
            setIsMenuOpen(true);
        };
        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [isMenuOpen, tabMenu, lookupOpen, closeLookup, escMenuBlocked]);

    const activeWebSockets: any[] = settings?.websockets || [];
    const menuSources: AppMenuSource[] = [
        ...[...activeWebSockets]
            .sort((a: any, b: any) => (a.id === primaryWebSocketId ? -1 : b.id === primaryWebSocketId ? 1 : 0))
            .map((ws: any) => ({
                id: `ws:${ws.id}`,
                label: ws.name,
                active: Boolean(wsStatuses?.[ws.id]),
                pending: Boolean(wsIntents?.[ws.id] && !wsStatuses?.[ws.id]),
                primary: ws.id === primaryWebSocketId,
                onToggle: () => toggleWs(ws.id),
            })),
        { id: 'clipboard', label: t('topbar.clipboard'), active: Boolean(useClipboard), onToggle: toggleClipboard },
    ];
    const menuTiles = [
        { id: 'capture', label: isEn ? 'Capture' : 'Захват', hint: activeTab?.captureSource?.name || t('topbar.captureSource'), icon: <MenuIcons.IconPin />, onSelect: openCaptureSourcePicker },
        { id: 'flow', label: 'Flow', hint: isEn ? 'Floating reader' : 'Окно поверх игры', icon: <MenuIcons.IconLayers />, onSelect: openJlModeWindow },
        { id: 'search', label: t('common.search'), hint: 'Ctrl + F', icon: <MenuIcons.IconSearch />, onSelect: openSearch },
        ...(YATSU_READER_AVAILABLE ? [{ id: 'yatsu', label: 'Yatsu', hint: 'EPUB', icon: <MenuIcons.IconBookTab />, onSelect: openEpubWorkspace }] : []),
        { id: 'settings', label: t('topbar.settings'), hint: isEn ? 'Sources, lookup, Anki' : 'Источники, лукап, Anki', icon: <MenuIcons.IconSettings />, onSelect: openSettings },
    ];
    const activeStatus = statusMeta(activeTab?.status);
    const formatChars = (value: number) => Math.round(value || 0).toLocaleString('ru-RU');
    const charsLabel = isEn ? 'chars' : 'симв.';
    const activeChars = activeTab?.stats?.chars || 0;
    // Single click switches the tab after a short wait so a double click can rename it instead.
    const tabClickTimer = useRef(0);
    useEffect(() => () => window.clearTimeout(tabClickTimer.current), []);
    useEffect(() => {
        if (!isMenuOpen) setEditingTabId(null);
    }, [isMenuOpen]);

    // Top island: hidden while reading, revealed when the pointer reaches the
    // top edge of the window and briefly after switching tabs.
    const [islandVisible, setIslandVisible] = useState(false);
    const islandVisibleRef = useRef(false);
    const islandHoverRef = useRef(false);
    const islandHideTimer = useRef(0);
    const islandHidePending = useRef(false);
    const hideIslandLater = (delayMs: number) => {
        window.clearTimeout(islandHideTimer.current);
        islandHidePending.current = true;
        islandHideTimer.current = window.setTimeout(() => {
            islandHidePending.current = false;
            if (islandHoverRef.current) return;
            islandVisibleRef.current = false;
            setIslandVisible(false);
        }, delayMs);
    };
    /** Shows the island; with `holdMs` it hides again after that delay. */
    const showIsland = (holdMs: number | null) => {
        window.clearTimeout(islandHideTimer.current);
        islandHidePending.current = false;
        islandVisibleRef.current = true;
        setIslandVisible(true);
        if (holdMs != null) hideIslandLater(holdMs);
    };
    useEffect(() => {
        const onMove = (event: PointerEvent) => {
            if (event.clientY <= 64) {
                if (!islandVisibleRef.current || islandHidePending.current) showIsland(null);
            } else if (event.clientY > 120 && islandVisibleRef.current && !islandHoverRef.current && !islandHidePending.current) {
                hideIslandLater(450);
            }
        };
        const onLeave = () => {
            if (islandVisibleRef.current && !islandHoverRef.current) hideIslandLater(300);
        };
        window.addEventListener('pointermove', onMove, { passive: true });
        document.addEventListener('pointerleave', onLeave);
        return () => {
            window.removeEventListener('pointermove', onMove);
            document.removeEventListener('pointerleave', onLeave);
            window.clearTimeout(islandHideTimer.current);
        };
    }, []);
    const firstTabRef = useRef(true);
    useEffect(() => {
        if (firstTabRef.current) { firstTabRef.current = false; return; }
        showIsland(2200);
    }, [activeTabId]);
    const primaryWs = activeWebSockets.find((ws: any) => ws.id === primaryWebSocketId) || activeWebSockets[0];
    const sourceConnected = primaryWs ? Boolean(wsStatuses?.[primaryWs.id]) : Boolean(useClipboard);
    const sourcePending = primaryWs ? Boolean(wsIntents?.[primaryWs.id] && !wsStatuses?.[primaryWs.id]) : false;
    // The lookup popup often opens at the top of the window (first lines), right
    // where the island appears; keep the island out of its way while it is open.
    const islandHidden = !islandVisible || isMenuOpen || Boolean(lookupOpen);

    const tabList = (
        <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            modifiers={[lockToVerticalAxis]}
            onDragStart={() => { suppressClickRef.current = true; }}
            onDragEnd={handleDragEnd}
            onDragCancel={() => { suppressClickRef.current = false; }}
        >
        <SortableContext items={visibleTabs.map((tab) => tab.id)} strategy={verticalListSortingStrategy}>
        <div className="app-menu-tabs" role="listbox" aria-label={isEn ? 'Tabs' : 'Вкладки'}>
            {visibleTabs.map((tab, index) => {
                const status = statusMeta(tab.status);
                const type = tabTypeIcon(tab);
                const isActive = tab.id === activeTabId;
                return (
                    <SortableTabRow
                        key={tab.id}
                        id={tab.id}
                        index={index}
                        className={`app-menu-tab${isActive ? ' is-active' : ''}`}
                        rowProps={{
                        role: 'option',
                        'aria-selected': isActive,
                        tabIndex: 0,
                        onClick: (event) => {
                            if (suppressClickRef.current) { suppressClickRef.current = false; return; }
                            if (editingTabId === tab.id || event.detail > 1) return;
                            window.clearTimeout(tabClickTimer.current);
                            tabClickTimer.current = window.setTimeout(() => {
                                switchTab(tab.id);
                                setIsMenuOpen(false);
                            }, 230);
                        },
                        onKeyDown: (e) => {
                            if (e.key === 'Enter' && editingTabId !== tab.id) { switchTab(tab.id); setIsMenuOpen(false); }
                            if (e.key === 'F2') { e.preventDefault(); setEditingTabId(tab.id); }
                        },
                        onDoubleClick: () => { window.clearTimeout(tabClickTimer.current); setEditingTabId(tab.id); },
                        onAuxClick: (e) => { if (e.button === 1 && visibleTabs.length > 1) closeTab(e, tab.id); },
                        onContextMenu: (e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            setTabMenu({ x: e.clientX, y: e.clientY, tabId: tab.id });
                        },
                        }}
                    >
                        <button
                            type="button"
                            className={`tab-status tab-status-${tab.status || 'planned'}`}
                            onClick={(e) => { e.stopPropagation(); cycleTabStatus?.(e, tab.id); }}
                            title={`${status.label} · ${isEn ? 'click to change' : 'клик — сменить статус'}`}
                            aria-label={status.label}
                            style={{ ['--status-color' as any]: status.color }}
                        />
                        {editingTabId === tab.id ? (
                            <input
                                autoFocus
                                className="tab-rename"
                                defaultValue={tab.name}
                                onClick={(e) => e.stopPropagation()}
                                onBlur={(e) => {
                                    const name = e.target.value.trim() || tab.name;
                                    setTabs((prev: Tab[]) => prev.map((item) => item.id === tab.id ? { ...item, name } : item));
                                    setEditingTabId(null);
                                }}
                                onKeyDown={(e) => {
                                    e.stopPropagation();
                                    if (e.key === 'Enter') e.currentTarget.blur();
                                    else if (e.key === 'Escape') { e.preventDefault(); setEditingTabId(null); }
                                }}
                            />
                        ) : (
                            <span className="app-menu-tab-name">{tab.name || (isEn ? 'Unnamed tab' : 'Без названия')}</span>
                        )}
                        {type && <span className="app-menu-tab-type" title={type.title} style={{ color: type.color }}>{type.icon}</span>}
                        <span className="app-menu-tab-meta" title={isEn ? 'Characters read' : 'Прочитано символов'}>{formatChars(tab.stats?.chars || 0)}</span>
                        {visibleTabs.length > 1 && (
                            <button
                                type="button"
                                className="tab-close"
                                title={isEn ? 'Close tab' : 'Закрыть вкладку'}
                                aria-label={isEn ? 'Close tab' : 'Закрыть вкладку'}
                                onClick={(e) => { e.stopPropagation(); closeTab(e, tab.id); }}
                            >
                                ×
                            </button>
                        )}
                    </SortableTabRow>
                );
            })}
        </div>
        </SortableContext>
        </DndContext>
    );

    const menuButtonStyle = {
        width: '100%',
        textAlign: 'left' as const,
        background: 'transparent',
        border: 'none',
        color: 'var(--text-main)',
        padding: '8px 10px',
        borderRadius: 5,
        cursor: 'pointer',
        fontSize: 13,
    };
    const contextTab = tabMenu ? getTabById(tabMenu.tabId) : null;

    return (
        <>
            <div
                className={`reader-island${islandHidden ? ' is-hidden' : ''}`}
                aria-hidden={islandHidden}
                onPointerEnter={() => { islandHoverRef.current = true; showIsland(null); }}
                onPointerLeave={() => { islandHoverRef.current = false; hideIslandLater(600); }}
            >
                <button
                    type="button"
                    className="reader-island-tab"
                    tabIndex={islandHidden ? -1 : 0}
                    onClick={() => setIsMenuOpen(true)}
                    title={isEn ? 'Tabs and actions' : 'Вкладки и действия'}
                >
                    <span className={`tab-status tab-status-${activeTab?.status || 'planned'}`} style={{ ['--status-color' as any]: activeStatus.color }} aria-hidden="true" />
                    <span key={activeTab?.id} className="reader-island-name">{activeTab?.name || (isEn ? 'Reading' : 'Чтение')}</span>
                    <span className="reader-island-meta">{formatChars(activeChars)} {charsLabel}</span>
                </button>
                <span className="reader-island-divider" aria-hidden="true" />
                <button
                    type="button"
                    className={`reader-island-source${sourceConnected ? ' is-active' : ''}${sourcePending ? ' is-pending' : ''}`}
                    tabIndex={islandHidden ? -1 : 0}
                    onClick={() => (primaryWs ? toggleWs(primaryWs.id) : toggleClipboard())}
                    title={primaryWs
                        ? `${primaryWs.name}: ${sourceConnected ? (isEn ? 'connected' : 'подключён') : (isEn ? 'disconnected' : 'отключён')}`
                        : t('topbar.clipboard')}
                >
                    <span className="reader-island-dot" aria-hidden="true" />
                    {primaryWs ? primaryWs.name : t('topbar.clipboard')}
                </button>
                <button
                    type="button"
                    className={`reader-island-flow${flowOpen ? ' is-active' : ''}`}
                    tabIndex={islandHidden ? -1 : 0}
                    onClick={() => toggleFlow?.()}
                    aria-pressed={Boolean(flowOpen)}
                    title={flowOpen
                        ? (isEn ? 'Close the Flow window over the game' : 'Закрыть окно Flow поверх игры')
                        : (isEn ? 'Open the Flow window over the game' : 'Открыть окно Flow поверх игры')}
                >
                    <MenuIcons.IconLayers />
                    <span>Flow</span>
                </button>
                <button
                    type="button"
                    className="reader-island-menu"
                    tabIndex={islandHidden ? -1 : 0}
                    onClick={() => setIsMenuOpen(true)}
                    aria-label={isEn ? 'Open menu' : 'Открыть меню'}
                >
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h10" /></svg>
                    <kbd>Esc</kbd>
                </button>
            </div>

            <AppMenu
                open={isMenuOpen}
                onClose={() => { setIsMenuOpen(false); setEditingTabId(null); }}
                english={isEn}
                title={activeTab?.name || (isEn ? 'Reading' : 'Чтение')}
                subtitle={`${activeStatus.label} · ${formatChars(activeChars)} ${charsLabel}`}
                tabs={tabList}
                tabCount={visibleTabs.length}
                onAddTab={() => addNewTab()}
                onOpenArchive={openArchiveSettings}
                sources={menuSources}
                tiles={menuTiles}
                onImport={openImport}
                onExport={openExport}
                onHome={openHome}
                onClear={clearAll}
            />

            {tabMenu && contextTab && (() => {
                const menuX = Math.min(tabMenu.x, window.innerWidth - 230);
                const menuY = Math.min(tabMenu.y, window.innerHeight - 320);
                return (
                    <div className="tab-context-menu" onClick={(e) => e.stopPropagation()} style={{ left: menuX, top: menuY }}>
                        <div className="tab-context-title">{contextTab.name}</div>
                        <button style={menuButtonStyle} onClick={() => renameTab(contextTab.id)}>{isEn ? 'Rename' : 'Переименовать'}</button>
                        <button style={menuButtonStyle} onClick={() => duplicateTab(contextTab.id)}>{isEn ? 'Duplicate' : 'Дублировать'}</button>
                        {settings?.ankiDeckMode === 'contextual' && (
                            <label style={{ display: 'block', padding: '5px 8px 8px' }}>
                                <span style={{ display: 'block', color: 'var(--text-muted)', fontSize: 11, marginBottom: 6 }}>{isEn ? 'Anki deck' : 'Колода Anki'}</span>
                                <select
                                    value={contextTab.ankiDeck || ''}
                                    onChange={(event) => setTabDeck(contextTab.id, event.target.value)}
                                    onClick={(event) => event.stopPropagation()}
                                    style={{ width: '100%', height: 30, border: '1px solid var(--border-main)', borderRadius: 5, background: 'var(--bg-main)', color: 'var(--text-main)', padding: '0 7px' }}
                                >
                                    <option value="">{isEn ? `Main: ${settings.ankiDeck || '-'}` : `Основная: ${settings.ankiDeck || '-'}`}</option>
                                    {tabDecks.map((deck) => <option key={deck} value={deck}>{deck}</option>)}
                                </select>
                            </label>
                        )}
                        <div className="tab-context-divider" />
                        <div className="tab-context-title">{isEn ? 'Status' : 'Статус'}</div>
                        {(['planned', 'reading', 'paused', 'completed'] as const).map((value) => {
                            const meta = statusMeta(value);
                            return (
                                <button key={value} style={{ ...menuButtonStyle, display: 'flex', alignItems: 'center', gap: 10 }} onClick={() => setTabStatus(contextTab.id, value)}>
                                    <span className={`tab-status tab-status-${value}`} style={{ ['--status-color' as any]: meta.color }} />
                                    <span style={{ flex: 1 }}>{meta.label}</span>
                                    {(contextTab.status || 'planned') === value && <span style={{ color: 'var(--accent-blue)' }}>✓</span>}
                                </button>
                            );
                        })}
                        <div className="tab-context-divider" />
                        <button style={{ ...menuButtonStyle, opacity: visibleTabs.length <= 1 ? 0.45 : 1 }} disabled={visibleTabs.length <= 1} onClick={() => archiveTab(contextTab.id)}>{isEn ? 'Archive tab' : 'В архив'}</button>
                        <button style={{ ...menuButtonStyle, color: '#ff5555', opacity: visibleTabs.length <= 1 ? 0.45 : 1 }} disabled={visibleTabs.length <= 1} onClick={() => deleteTab(contextTab.id)}>{isEn ? 'Delete tab' : 'Удалить вкладку'}</button>
                    </div>
                );
            })()}
        </>
    );
};
