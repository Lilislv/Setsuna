import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import {
    DndContext,
    PointerSensor,
    closestCenter,
    useSensor,
    useSensors,
    type DragEndEvent,
} from '@dnd-kit/core';
import { SortableContext, rectSortingStrategy, useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
    ESC_MENU_LAYOUT_EVENT,
    applyEscMenuLayout,
    hideEscMenuItem,
    readEscMenuLayout,
    reorderEscMenuLayout,
    resetEscMenuLayout,
    restoreEscMenuItem,
    writeEscMenuLayout,
    type EscMenuId,
    type EscMenuSectionLayout,
} from '../utils/escMenuLayout';
import { useJelly } from '../utils/jelly';

export interface EscActionTile {
    id: string;
    label: string;
    hint?: string;
    icon: ReactNode;
    coachId?: string;
    onSelect: () => void;
}

interface EscActionGridProps {
    menuId: EscMenuId;
    tiles: EscActionTile[];
    english: boolean;
    onRun: (action: () => void) => void;
    menuOpen: boolean;
    headerMarginTop?: number;
}

const IconPencil = () => (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M12 20h9" />
        <path d="M16.5 3.5a2.12 2.12 0 1 1 3 3L7 19l-4 1 1-4Z" />
    </svg>
);

const IconTileRemove = () => (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true">
        <path d="M6 6l12 12M18 6 6 18" />
    </svg>
);

function SortableActionTile({
    tile,
    index,
    editing,
    english,
    onActivate,
    onRemove,
    onContextMenu,
}: {
    tile: EscActionTile;
    index: number;
    editing: boolean;
    english: boolean;
    onActivate: () => void;
    onRemove: () => void;
    onContextMenu: (x: number, y: number) => void;
}) {
    const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
        id: tile.id,
    });
    const nodeRef = useRef<HTMLDivElement | null>(null);
    useJelly(() => nodeRef.current, isDragging, { axis: 'both' });

    const translate = CSS.Translate.toString(transform);

    return (
        <div
            ref={(node) => {
                nodeRef.current = node;
                setNodeRef(node);
            }}
            data-coach={tile.coachId}
            className={`app-menu-tile-slot${editing ? ' is-editing' : ''}${isDragging ? ' is-dragging' : ''}`}
            style={{
                transform: `${translate || ''} var(--jelly-transform, scale(1))`.trim(),
                transition: transition || undefined,
                zIndex: isDragging ? 4 : undefined,
            }}
            aria-roledescription={attributes['aria-roledescription']}
            {...listeners}
        >
            <button
                type="button"
                className="app-menu-tile"
                style={{ ['--i' as string]: index }}
                onClick={onActivate}
                onContextMenu={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    onContextMenu(event.clientX, event.clientY);
                }}
            >
                <span className="app-menu-tile-icon">{tile.icon}</span>
                <span className="app-menu-tile-text">
                    <strong>{tile.label}</strong>
                    {tile.hint && <small>{tile.hint}</small>}
                </span>
            </button>
            {editing && (
                <button
                    type="button"
                    className="app-menu-tile-remove"
                    aria-label={english ? `Remove ${tile.label}` : `Убрать «${tile.label}»`}
                    title={english ? 'Remove from menu' : 'Убрать из меню'}
                    onPointerDown={(event) => event.stopPropagation()}
                    onClick={(event) => {
                        event.stopPropagation();
                        onRemove();
                    }}
                >
                    <IconTileRemove />
                </button>
            )}
        </div>
    );
}

export default function EscActionGrid({
    menuId,
    tiles,
    english,
    onRun,
    menuOpen,
    headerMarginTop,
}: EscActionGridProps) {
    const L = (enText: string, ruText: string) => (english ? enText : ruText);
    const [layout, setLayout] = useState<EscMenuSectionLayout>(() => readEscMenuLayout(menuId));
    const [editing, setEditing] = useState(false);
    const [contextMenu, setContextMenu] = useState<{ x: number; y: number; tileId: string } | null>(null);
    const lastDragEndRef = useRef(0);

    useEffect(() => {
        setLayout(readEscMenuLayout(menuId));
    }, [menuId]);

    useEffect(() => {
        const onLayoutEvent = (event: Event) => {
            const detail = (event as CustomEvent<{ menuId?: EscMenuId }>).detail;
            if (!detail?.menuId || detail.menuId === menuId) {
                setLayout(readEscMenuLayout(menuId));
            }
        };
        window.addEventListener(ESC_MENU_LAYOUT_EVENT, onLayoutEvent);
        return () => window.removeEventListener(ESC_MENU_LAYOUT_EVENT, onLayoutEvent);
    }, [menuId]);

    useEffect(() => {
        if (!menuOpen) {
            setEditing(false);
            setContextMenu(null);
        }
    }, [menuOpen]);

    useEffect(() => {
        if (!contextMenu) return;
        const onPointerDown = (event: PointerEvent) => {
            const target = event.target as HTMLElement | null;
            if (target?.closest('.app-menu-tile-context')) return;
            setContextMenu(null);
        };
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape') {
                event.preventDefault();
                event.stopPropagation();
                setContextMenu(null);
            }
        };
        window.addEventListener('pointerdown', onPointerDown, true);
        window.addEventListener('keydown', onKeyDown, true);
        return () => {
            window.removeEventListener('pointerdown', onPointerDown, true);
            window.removeEventListener('keydown', onKeyDown, true);
        };
    }, [contextMenu]);

    const sensors = useSensors(
        useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    );

    const { visible, hidden, isCustomized } = useMemo(
        () => applyEscMenuLayout(tiles, layout),
        [tiles, layout],
    );

    const visibleIds = useMemo(() => visible.map((tile) => tile.id), [visible]);
    const currentOrderIds = useMemo(
        () => [...visible.map((t) => t.id), ...hidden.map((t) => t.id)],
        [visible, hidden],
    );

    const commitLayout = (next: EscMenuSectionLayout) => {
        setLayout(next);
        writeEscMenuLayout(menuId, next);
    };

    const handleDragEnd = (event: DragEndEvent) => {
        lastDragEndRef.current = Date.now();
        const { active, over } = event;
        if (!over || active.id === over.id) return;
        const next = reorderEscMenuLayout(
            layout,
            visibleIds,
            String(active.id),
            String(over.id),
        );
        commitLayout(next);
    };

    const handleHide = (tileId: string) => {
        setContextMenu(null);
        commitLayout(hideEscMenuItem(layout, currentOrderIds, tileId));
    };

    const handleRestore = (tileId: string) => {
        commitLayout(restoreEscMenuItem(layout, tileId));
    };

    const handleReset = () => {
        setContextMenu(null);
        commitLayout(resetEscMenuLayout());
    };

    const contextTile = contextMenu
        ? tiles.find((tile) => tile.id === contextMenu.tileId) || null
        : null;

    return (
        <>
            <div
                className="app-menu-section-head"
                style={headerMarginTop != null ? { marginTop: headerMarginTop } : undefined}
            >
                <span className="app-menu-section-label">{L('Actions', 'Действия')}</span>
                <div className="app-menu-actions-head-controls">
                    {editing && isCustomized && (
                        <button
                            type="button"
                            className="app-menu-action-text-btn"
                            onClick={handleReset}
                        >
                            {L('Reset', 'Сбросить')}
                        </button>
                    )}
                    <button
                        type="button"
                        className={`app-menu-edit-toggle${editing ? ' is-active' : ''}`}
                        aria-pressed={editing}
                        title={
                            editing
                                ? L('Finish editing', 'Закончить настройку')
                                : L('Customize buttons', 'Настроить кнопки')
                        }
                        onClick={() => {
                            setContextMenu(null);
                            setEditing((value) => !value);
                        }}
                    >
                        {editing ? (
                            <span>{L('Done', 'Готово')}</span>
                        ) : (
                            <IconPencil />
                        )}
                    </button>
                </div>
            </div>

            {visible.length > 0 ? (
                <DndContext
                    sensors={sensors}
                    collisionDetection={closestCenter}
                    onDragEnd={handleDragEnd}
                    onDragCancel={() => {
                        lastDragEndRef.current = Date.now();
                    }}
                >
                    <SortableContext items={visibleIds} strategy={rectSortingStrategy}>
                        <div className="app-menu-grid">
                            {visible.map((tile, index) => (
                                <SortableActionTile
                                    key={tile.id}
                                    tile={tile}
                                    index={index}
                                    editing={editing}
                                    english={english}
                                    onActivate={() => {
                                        if (editing) return;
                                        if (Date.now() - lastDragEndRef.current < 200) return;
                                        onRun(tile.onSelect);
                                    }}
                                    onRemove={() => handleHide(tile.id)}
                                    onContextMenu={(x, y) =>
                                        setContextMenu({ x, y, tileId: tile.id })
                                    }
                                />
                            ))}
                        </div>
                    </SortableContext>
                </DndContext>
            ) : (
                <div className="app-menu-actions-empty">
                    <p>{L('All action buttons are hidden', 'Все кнопки действий скрыты')}</p>
                    <div className="app-menu-actions-empty-buttons">
                        <button type="button" className="is-primary" onClick={handleReset}>
                            {L('Restore all', 'Вернуть все')}
                        </button>
                        {!editing && (
                            <button type="button" onClick={() => setEditing(true)}>
                                {L('Customize', 'Настроить')}
                            </button>
                        )}
                    </div>
                </div>
            )}

            {editing && hidden.length > 0 && (
                <div className="app-menu-hidden-tray">
                    <span className="app-menu-hidden-label">
                        {L('Hidden buttons', 'Скрытые кнопки')}
                    </span>
                    <div className="app-menu-hidden-chips">
                        {hidden.map((tile) => (
                            <button
                                key={tile.id}
                                type="button"
                                className="app-menu-hidden-chip"
                                title={L(`Restore ${tile.label}`, `Вернуть «${tile.label}»`)}
                                onClick={() => handleRestore(tile.id)}
                            >
                                <span className="app-menu-hidden-plus">+</span>
                                <span className="app-menu-hidden-chip-icon">{tile.icon}</span>
                                <span>{tile.label}</span>
                            </button>
                        ))}
                    </div>
                </div>
            )}

            <p className="app-menu-actions-hint">
                {editing
                    ? L(
                          'Drag to reorder · × to hide · click hidden below to restore',
                          'Перетащи — порядок · × — убрать · нажми на скрытую ниже, чтобы вернуть',
                      )
                    : L(
                          'Drag to reorder · right-click or ✎ to edit',
                          'Перетаскивание — порядок · ПКМ или ✎ — настройка и удаление',
                      )}
            </p>

            {contextMenu &&
                contextTile &&
                typeof document !== 'undefined' &&
                createPortal(
                    <div
                        className="tab-context-menu app-menu-tile-context"
                        style={{
                            left: Math.min(contextMenu.x, window.innerWidth - 240),
                            top: Math.min(contextMenu.y, window.innerHeight - 170),
                        }}
                        onClick={(event) => event.stopPropagation()}
                    >
                        <div className="tab-context-title">{contextTile.label}</div>
                        <button
                            type="button"
                            className="tab-context-item is-danger"
                            onClick={() => handleHide(contextTile.id)}
                        >
                            {L('Remove from menu', 'Убрать из меню')}
                        </button>
                        <button
                            type="button"
                            className="tab-context-item"
                            onClick={() => {
                                setContextMenu(null);
                                setEditing((value) => !value);
                            }}
                        >
                            {editing
                                ? L('Finish editing', 'Закончить настройку')
                                : L('Customize buttons', 'Настроить кнопки')}
                        </button>
                        {isCustomized && (
                            <>
                                <div className="tab-context-divider" />
                                <button
                                    type="button"
                                    className="tab-context-item"
                                    onClick={handleReset}
                                >
                                    {L('Reset to default', 'Сбросить по умолчанию')}
                                </button>
                            </>
                        )}
                    </div>,
                    document.body,
                )}
        </>
    );
}
