import {
    IconSearch,
    IconWifi,
    IconImport,
    IconExport,
    IconBrowser,
    IconClear,
    IconSettings,
    IconPin,
} from './Icons';
import { Tab, BrowserTab } from '../utils/constants';

export const SearchBar = ({
    isOpen,
    isHelperSpaceReserved,
    reservedWidth,
    searchQuery,
    setSearchQuery,
    onClose,
    onNext,
    onPrev,
    resultsLength,
    currentIdx,
    inputRef,
}: any) => {
    if (!isOpen) return null;

    return (
        <div
            className="search-bar-anim"
            onClick={(e) => e.stopPropagation()}
            style={{
                position: 'absolute',
                top: '65px',
                right: isHelperSpaceReserved ? `${reservedWidth + 20}px` : '20px',
                background: 'var(--bg-panel)',
                border: '1px solid var(--border-main)',
                padding: '10px 16px',
                borderRadius: '12px',
                zIndex: 1000,
                display: 'flex',
                alignItems: 'center',
                gap: '12px',
                boxShadow: '0 8px 24px rgba(0,0,0,0.4)',
                transition: 'right 0.3s cubic-bezier(0.4, 0, 0.2, 1)',
            }}
        >
            <IconSearch />

            <input
                ref={inputRef}
                type="text"
                placeholder="Поиск по тексту..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                        if (e.shiftKey) onPrev();
                        else onNext();
                    } else if (e.code === 'Escape') {
                        onClose();
                    }
                }}
                style={{
                    background: 'transparent',
                    border: 'none',
                    color: 'var(--text-main)',
                    outline: 'none',
                    width: '180px',
                    fontSize: '15px',
                }}
            />

            <span
                style={{
                    color: 'var(--text-muted)',
                    fontSize: '13px',
                    minWidth: '45px',
                    textAlign: 'center',
                    background: 'var(--bg-side)',
                    padding: '2px 6px',
                    borderRadius: '4px',
                }}
            >
                {resultsLength > 0 ? `${currentIdx + 1} / ${resultsLength}` : '0 / 0'}
            </span>

            <div
                style={{
                    display: 'flex',
                    gap: '4px',
                    borderLeft: '1px solid var(--border-main)',
                    paddingLeft: '8px',
                }}
            >
                <button
                    onClick={onPrev}
                    disabled={resultsLength === 0}
                    style={{
                        background: 'transparent',
                        border: 'none',
                        color: 'var(--text-main)',
                        cursor: 'pointer',
                        padding: '4px',
                    }}
                >
                    ↑
                </button>

                <button
                    onClick={onNext}
                    disabled={resultsLength === 0}
                    style={{
                        background: 'transparent',
                        border: 'none',
                        color: 'var(--text-main)',
                        cursor: 'pointer',
                        padding: '4px',
                    }}
                >
                    ↓
                </button>
            </div>

            <button
                onClick={onClose}
                style={{
                    background: 'transparent',
                    border: 'none',
                    color: 'var(--text-muted)',
                    cursor: 'pointer',
                    padding: '4px',
                }}
            >
                ✕
            </button>
        </div>
    );
};

export const TopBar = ({
    tabs,
    activeTabId,
    switchTab,
    editingTabId,
    setEditingTabId,
    setTabs,
    closeTab,
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
    toggleBrowser,
    isBrowserOpen,
    clearAll,
    openSettings,
}: any) => {
    return (
        <div
            className="top-bar"
            style={{
                backgroundColor: 'var(--bg-topbar)',
                borderBottom: '1px solid var(--border-subtle)',
            }}
        >
            <style>{`
                @keyframes fast-blink {
                    0%, 100% { opacity: 1; }
                    50% { opacity: 0.3; }
                }
            `}</style>

            <div className="tabs">
                {tabs.map((tab: Tab) => (
                    <div
                        key={tab.id}
                        className={`tab ${activeTabId === tab.id ? 'active' : ''}`}
                        onClick={() => switchTab(tab.id)}
                    >
                        {editingTabId === tab.id ? (
                            <input
                                autoFocus
                                defaultValue={tab.name}
                                onBlur={(e) => {
                                    const newName = e.target.value.trim() || tab.name;
                                    setTabs((prev: Tab[]) =>
                                        prev.map((t) =>
                                            t.id === tab.id ? { ...t, name: newName } : t
                                        )
                                    );
                                    setEditingTabId(null);
                                }}
                                onKeyDown={(e) => {
                                    if (e.key === 'Enter') e.currentTarget.blur();
                                    else if (e.code === 'Escape') setEditingTabId(null);
                                }}
                                onClick={(e) => e.stopPropagation()}
                                style={{
                                    width: '80px',
                                    background: 'transparent',
                                    color: 'var(--text-main)',
                                    border: 'none',
                                    borderBottom: '1px solid var(--accent-blue)',
                                    outline: 'none',
                                    fontSize: '14px',
                                }}
                            />
                        ) : (
                            <span onDoubleClick={() => setEditingTabId(tab.id)}>
                                {tab.name}
                            </span>
                        )}

                        {tabs.length > 1 && (
                            <span
                                className="tab-close"
                                onClick={(e) => closeTab(e, tab.id)}
                            >
                                ×
                            </span>
                        )}
                    </div>
                ))}

                <div className="tab tab-add" onClick={addNewTab}>
                    +
                </div>
            </div>

            <div className="header-actions" style={{ display: 'flex', alignItems: 'center' }}>
                <button
                    onClick={toggleClipboard}
                    className="header-btn"
                    style={{
                        color: useClipboard ? '#4CAF50' : '#ff4444',
                        display: 'flex',
                        alignItems: 'center',
                        gap: '6px',
                    }}
                >
                    <svg
                        width="14"
                        height="14"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2.5"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                    >
                        <rect x="9" y="2" width="6" height="4" rx="1" ry="1"></rect>
                        <path d="M19 6h-2M5 6h2M5 6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-2"></path>
                    </svg>
                    <span>Буфер</span>
                </button>

                {settings.websockets &&
                    settings.websockets.map((ws: any) => {
                        const isConnected = wsStatuses[ws.id];
                        const isBlinking = wsIntents && wsIntents[ws.id] && !isConnected;
                        const color = isConnected ? '#4CAF50' : '#ff4444';

                        return (
                            <button
                                key={ws.id}
                                onClick={() => toggleWs(ws.id)}
                                className="header-btn"
                                style={{
                                    color,
                                    display: 'flex',
                                    alignItems: 'center',
                                    gap: '6px',
                                }}
                            >
                                <div
                                    style={{
                                        animation: isBlinking ? 'fast-blink 0.8s infinite' : 'none',
                                        display: 'flex',
                                        alignItems: 'center',
                                    }}
                                >
                                    <IconWifi connected={isConnected} />
                                </div>
                                <span>{ws.name}</span>
                            </button>
                        );
                    })}

                <button
                    onClick={openSearch}
                    className="header-btn"
                    style={{ display: 'flex', alignItems: 'center', gap: '6px' }}
                >
                    <IconSearch /> <span>Поиск</span>
                </button>

                <button
                    onClick={openImport}
                    className="header-btn"
                    style={{ display: 'flex', alignItems: 'center', gap: '6px' }}
                >
                    <IconImport /> <span>Импорт</span>
                </button>

                <button
                    onClick={openExport}
                    className="header-btn"
                    style={{ display: 'flex', alignItems: 'center', gap: '6px' }}
                >
                    <IconExport /> <span>Экспорт</span>
                </button>

                <button
                    onClick={toggleBrowser}
                    className="header-btn"
                    style={{ display: 'flex', alignItems: 'center', gap: '6px' }}
                >
                    <IconBrowser /> <span>{isBrowserOpen ? 'Закрыть' : 'Браузер'}</span>
                </button>

                <button
                    onClick={clearAll}
                    className="header-btn"
                    style={{
                        color: '#ff4444',
                        display: 'flex',
                        alignItems: 'center',
                        gap: '6px',
                    }}
                >
                    <IconClear /> <span>Очистить</span>
                </button>

                <button
                    onClick={openSettings}
                    className="header-btn"
                    style={{ display: 'flex', alignItems: 'center', gap: '6px' }}
                >
                    <IconSettings /> <span>Настройки</span>
                </button>
            </div>
        </div>
    );
};

export const BrowserSidebar = ({
    isOpen,
    reservedWidth,
    isResizing,
    onMouseDownResize,
    showBrowserUI,
    setShowBrowserUI,
    syncBrowserBounds,
    browserTabs,
    activeBrowserIdx,
    selectBrowserTab,
    closeBrowserTab,
    addBrowserTab,
    urlInput,
    setUrlInput,
    submitUrl,
    setIsUrlFocused,
}: any) => {
    return (
        <>
            <div
                onMouseDown={onMouseDownResize}
                style={{
                    width: isOpen ? '5px' : '0px',
                    backgroundColor: 'var(--bg-topbar)',
                    cursor: 'col-resize',
                    zIndex: 101,
                    borderLeft: isOpen ? '1px solid var(--border-subtle)' : 'none',
                    overflow: 'hidden',
                }}
            />

            <div
                style={{
                    width: isOpen ? `${reservedWidth}px` : '0px',
                    flexShrink: 0,
                    backgroundColor: 'var(--bg-side)',
                    transition: isResizing ? 'none' : 'width 0.3s cubic-bezier(0.4, 0, 0.2, 1)',
                    display: 'flex',
                    flexDirection: 'column',
                    overflow: 'hidden',
                }}
            >
                <div
                    style={{
                        backgroundColor: 'var(--bg-panel)',
                        display: 'flex',
                        flexDirection: 'column',
                        borderBottom: '1px solid var(--border-main)',
                        minWidth: `${reservedWidth}px`,
                    }}
                >
                    <div
                        style={{
                            display: 'flex',
                            justifyContent: 'space-between',
                            alignItems: 'center',
                            padding: '6px 12px',
                        }}
                    >
                        <span
                            style={{
                                fontWeight: 'bold',
                                color: 'var(--accent-blue)',
                                fontSize: '11px',
                                letterSpacing: '1px',
                            }}
                        >
                            БРАУЗЕР
                        </span>

                        <button
                            onClick={() => {
                                setShowBrowserUI(!showBrowserUI);
                                setTimeout(syncBrowserBounds, 50);
                            }}
                            style={{
                                background: 'transparent',
                                border: 'none',
                                color: 'var(--text-muted)',
                                fontSize: '11px',
                                cursor: 'pointer',
                            }}
                        >
                            {showBrowserUI ? 'Скрыть интерфейс' : 'Показать интерфейс'}
                        </button>
                    </div>

                    {showBrowserUI && (
                        <div
                            style={{
                                padding: '0 12px 10px 12px',
                                display: 'flex',
                                flexDirection: 'column',
                                gap: '8px',
                            }}
                        >
                            <div
                                style={{
                                    display: 'flex',
                                    overflowX: 'auto',
                                    gap: '4px',
                                    paddingBottom: '2px',
                                }}
                            >
                                {browserTabs.map((bt: BrowserTab, i: number) => (
                                    <div
                                        key={bt.id || i}
                                        onClick={() => selectBrowserTab(i)}
                                        style={{
                                            padding: '4px 10px',
                                            background:
                                                activeBrowserIdx === i
                                                    ? 'var(--bg-main)'
                                                    : 'var(--bg-side)',
                                            border: `1px solid ${
                                                activeBrowserIdx === i
                                                    ? 'var(--accent-blue)'
                                                    : 'var(--border-main)'
                                            }`,
                                            color:
                                                activeBrowserIdx === i
                                                    ? 'var(--text-main)'
                                                    : 'var(--text-muted)',
                                            borderRadius: '4px',
                                            cursor: 'pointer',
                                            fontSize: '11px',
                                            display: 'flex',
                                            alignItems: 'center',
                                            gap: '6px',
                                            whiteSpace: 'nowrap',
                                            minWidth: '0',
                                            maxWidth: '180px',
                                            flexShrink: 0,
                                        }}
                                    >
                                        <div
                                            style={{
                                                display: 'flex',
                                                alignItems: 'center',
                                                gap: '6px',
                                                minWidth: 0,
                                                flex: 1,
                                            }}
                                        >
                                            {bt.favicon ? (
                                                <img
                                                    src={bt.favicon}
                                                    alt=""
                                                    style={{
                                                        width: '14px',
                                                        height: '14px',
                                                        flexShrink: 0,
                                                        borderRadius: '2px',
                                                    }}
                                                    onError={(e) => {
                                                        (e.currentTarget as HTMLImageElement).style.display = 'none';
                                                    }}
                                                />
                                            ) : (
                                                <div
                                                    style={{
                                                        width: '14px',
                                                        height: '14px',
                                                        flexShrink: 0,
                                                        borderRadius: '2px',
                                                        background: 'var(--border-main)',
                                                        opacity: 0.5,
                                                    }}
                                                />
                                            )}

                                            <span
                                                title={bt.title}
                                                style={{
                                                    maxWidth: '120px',
                                                    overflow: 'hidden',
                                                    textOverflow: 'ellipsis',
                                                    whiteSpace: 'nowrap',
                                                    display: 'inline-block',
                                                    verticalAlign: 'bottom',
                                                }}
                                            >
                                                {bt.title}
                                            </span>
                                        </div>

                                        <span
                                            onClick={(e) => closeBrowserTab(e, i)}
                                            style={{
                                                fontSize: '12px',
                                                opacity: 0.6,
                                                flexShrink: 0,
                                            }}
                                        >
                                            ×
                                        </span>
                                    </div>
                                ))}

                                <button
                                    onClick={addBrowserTab}
                                    style={{
                                        background: 'var(--bg-main)',
                                        border: '1px solid var(--border-main)',
                                        color: 'var(--text-main)',
                                        borderRadius: '4px',
                                        padding: '2px 8px',
                                        cursor: 'pointer',
                                        flexShrink: 0,
                                    }}
                                >
                                    +
                                </button>
                            </div>

                            <div style={{ display: 'flex', gap: '6px' }}>
                                <input
                                    type="text"
                                    placeholder="Поиск..."
                                    value={urlInput}
                                    onChange={(e) => setUrlInput(e.target.value)}
                                    onKeyDown={(e) => e.key === 'Enter' && submitUrl()}
                                    onFocus={() => setIsUrlFocused(true)}
                                    onBlur={() => setIsUrlFocused(false)}
                                    style={{
                                        flex: 1,
                                        padding: '6px 10px',
                                        background: 'var(--bg-main)',
                                        color: 'var(--text-main)',
                                        border: '1px solid var(--border-main)',
                                        borderRadius: '4px',
                                        fontSize: '12px',
                                    }}
                                />

                                <button
                                    onClick={() => syncBrowserBounds()}
                                    title="Обновить"
                                    style={{
                                        background: 'var(--bg-main)',
                                        border: '1px solid var(--border-main)',
                                        color: 'var(--text-muted)',
                                        borderRadius: '4px',
                                        padding: '0 10px',
                                        cursor: 'pointer',
                                    }}
                                >
                                    <IconPin />
                                </button>
                            </div>
                        </div>
                    )}
                </div>

                <div
                    id="native-browser-container"
                    style={{
                        flex: 1,
                        position: 'relative',
                        minWidth: `${reservedWidth}px`,
                    }}
                >
                    <div
                        style={{
                            position: 'absolute',
                            top: '50%',
                            left: '50%',
                            transform: 'translate(-50%, -50%)',
                            color: 'var(--border-main)',
                            textAlign: 'center',
                        }}
                    >
                        <IconBrowser />
                    </div>
                </div>
            </div>
        </>
    );
};