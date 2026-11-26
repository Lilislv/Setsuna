export type EscMenuId = 'texthooker' | 'epub' | 'player';

export interface EscMenuSectionLayout {
    order: string[];
    hidden: string[];
}

export type EscMenuLayoutStore = Partial<Record<EscMenuId, EscMenuSectionLayout>>;

export const ESC_MENU_LAYOUT_STORAGE_KEY = 'setsuna_esc_menu_layout_v1';
export const ESC_MENU_LAYOUT_EVENT = 'setsuna:esc-menu-layout-changed';

const normalizeIds = (list: unknown): string[] => {
    if (!Array.isArray(list)) return [];
    const seen = new Set<string>();
    const result: string[] = [];
    for (const item of list) {
        if (typeof item === 'string' && item && !seen.has(item)) {
            seen.add(item);
            result.push(item);
        }
    }
    return result;
};

const normalizeSection = (raw: unknown): EscMenuSectionLayout => {
    if (!raw || typeof raw !== 'object') return { order: [], hidden: [] };
    const candidate = raw as { order?: unknown; hidden?: unknown };
    return {
        order: normalizeIds(candidate.order),
        hidden: normalizeIds(candidate.hidden),
    };
};

export const resetEscMenuLayout = (): EscMenuSectionLayout => ({ order: [], hidden: [] });

export function readEscMenuLayoutStore(): EscMenuLayoutStore {
    if (typeof localStorage === 'undefined') return {};
    try {
        const raw = localStorage.getItem(ESC_MENU_LAYOUT_STORAGE_KEY);
        if (!raw) return {};
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
        const store: EscMenuLayoutStore = {};
        for (const menuId of ['texthooker', 'epub', 'player'] as const) {
            if (menuId in parsed) {
                const section = normalizeSection((parsed as Record<string, unknown>)[menuId]);
                if (section.order.length || section.hidden.length) {
                    store[menuId] = section;
                }
            }
        }
        return store;
    } catch {
        return {};
    }
}

export function readEscMenuLayout(menuId: EscMenuId): EscMenuSectionLayout {
    const store = readEscMenuLayoutStore();
    return store[menuId] ? normalizeSection(store[menuId]) : resetEscMenuLayout();
}

export function writeEscMenuLayout(menuId: EscMenuId, layout: EscMenuSectionLayout): void {
    if (typeof localStorage === 'undefined') return;
    const normalized = normalizeSection(layout);
    const store = readEscMenuLayoutStore();
    if (!normalized.order.length && !normalized.hidden.length) {
        delete store[menuId];
    } else {
        store[menuId] = normalized;
    }
    try {
        if (Object.keys(store).length === 0) {
            localStorage.removeItem(ESC_MENU_LAYOUT_STORAGE_KEY);
        } else {
            localStorage.setItem(ESC_MENU_LAYOUT_STORAGE_KEY, JSON.stringify(store));
        }
    } catch {
        // Ignore storage quota or private-mode failures.
    }
    if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
        try {
            const evt =
                typeof CustomEvent === 'function'
                    ? new CustomEvent(ESC_MENU_LAYOUT_EVENT, { detail: { menuId } })
                    : { type: ESC_MENU_LAYOUT_EVENT, detail: { menuId } };
            window.dispatchEvent(evt as Event);
        } catch {
            // Ignore minimal mock window implementations in tests.
        }
    }
}

/**
 * Applies saved order and hidden flags to the current menu items while keeping
 * unseen/new items appended in their default order.
 */
export function applyEscMenuLayout<T extends { id: string }>(
    items: readonly T[],
    layout?: EscMenuSectionLayout,
): { visible: T[]; hidden: T[]; isCustomized: boolean } {
    const normalized = layout ? normalizeSection(layout) : resetEscMenuLayout();
    const byId = new Map<string, T>();
    for (const item of items) {
        byId.set(item.id, item);
    }

    const hiddenIds = normalized.hidden.filter((id) => byId.has(id));
    const hiddenSet = new Set(hiddenIds);

    const visible: T[] = [];
    const seenVisible = new Set<string>();
    for (const id of normalized.order) {
        if (hiddenSet.has(id) || seenVisible.has(id)) continue;
        const item = byId.get(id);
        if (item) {
            visible.push(item);
            seenVisible.add(id);
        }
    }
    for (const item of items) {
        if (!hiddenSet.has(item.id) && !seenVisible.has(item.id)) {
            visible.push(item);
            seenVisible.add(item.id);
        }
    }

    const hidden: T[] = [];
    for (const id of hiddenIds) {
        const item = byId.get(id);
        if (item) hidden.push(item);
    }

    const orderDiffers =
        hidden.length > 0 || visible.some((item, idx) => item.id !== items[idx]?.id);

    return {
        visible,
        hidden,
        isCustomized: orderDiffers,
    };
}

/**
 * Reorders `activeId` relative to `overId` across `visibleIds`, preserving any
 * temporarily absent IDs (for example context-dependent tiles) already stored in `current.order`.
 */
export function reorderEscMenuLayout(
    current: EscMenuSectionLayout,
    visibleIds: readonly string[],
    activeId: string,
    overId: string,
): EscMenuSectionLayout {
    if (activeId === overId) return normalizeSection(current);
    const oldVisibleIdx = visibleIds.indexOf(activeId);
    const newVisibleIdx = visibleIds.indexOf(overId);
    if (oldVisibleIdx < 0 || newVisibleIdx < 0) return normalizeSection(current);

    const normalized = normalizeSection(current);
    const fullOrder = normalizeIds([...normalized.order, ...visibleIds]).filter(
        (id) => id !== activeId,
    );
    const overIdx = fullOrder.indexOf(overId);
    if (overIdx < 0) return normalized;

    const insertIdx = oldVisibleIdx < newVisibleIdx ? overIdx + 1 : overIdx;
    fullOrder.splice(insertIdx, 0, activeId);

    return {
        order: fullOrder,
        hidden: normalized.hidden,
    };
}

/**
 * Hides `idToHide` while recording the current item order so restoring the
 * tile later puts it back in its original slot.
 */
export function hideEscMenuItem(
    current: EscMenuSectionLayout,
    allCurrentIds: readonly string[],
    idToHide: string,
): EscMenuSectionLayout {
    const normalized = normalizeSection(current);
    return {
        order: normalizeIds([...normalized.order, ...allCurrentIds]),
        hidden: normalizeIds([...normalized.hidden, idToHide]),
    };
}

export function restoreEscMenuItem(
    current: EscMenuSectionLayout,
    idToRestore: string,
): EscMenuSectionLayout {
    const normalized = normalizeSection(current);
    return {
        order: normalized.order,
        hidden: normalized.hidden.filter((id) => id !== idToRestore),
    };
}
