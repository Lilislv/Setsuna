import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Tab } from '../utils/constants';
import { getTranslator, type AppLanguage } from '../utils/i18n';

export const ConfirmDialogModal = ({ dialog, setDialog, language = 'ru' }: any) => {
    const t = getTranslator(language as AppLanguage);
    if (!dialog) return null;

    return (
        <div className="modal-overlay" style={{ zIndex: 100000, position: 'fixed', top: 0, left: 0, width: '100vw', height: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }} onClick={() => setDialog(null)}>
            <div className="modern-modal" onClick={e => e.stopPropagation()} style={{ width: '400px', height: 'auto', minHeight: 'auto', padding: '25px', textAlign: 'center', display: 'block', background: 'var(--bg-panel)', border: '1px solid var(--border-main)', borderRadius: '8px' }}>
                <h3 style={{ marginTop: 0, color: 'var(--text-main)', fontSize: '18px', fontWeight: 600 }}>{dialog.title}</h3>
                <p style={{ color: 'var(--text-muted)', marginBottom: '25px', lineHeight: '1.5', fontSize: '14px' }}>{dialog.message}</p>
                <div style={{ display: 'flex', gap: '10px', justifyContent: 'center' }}>
                    <button className="btn-primary btn-secondary" style={{ padding: '8px 20px' }} onClick={() => setDialog(null)}>{t('common.cancel')}</button>
                    <button className="btn-primary btn-danger" style={{ padding: '8px 20px' }} onClick={() => { dialog.onConfirm(); setDialog(null); }}>{t('common.confirm')}</button>
                </div>
            </div>
        </div>
    );
};

export const NoticeModal = ({ notice, setNotice, language = 'ru' }: any) => {
    const t = getTranslator(language as AppLanguage);
    if (!notice) return null;

    return (
        <div className="modal-overlay" style={{ zIndex: 100001, position: 'fixed', top: 0, left: 0, width: '100vw', height: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }} onClick={() => setNotice(null)}>
            <div className="modern-modal" onClick={e => e.stopPropagation()} style={{ width: '520px', maxWidth: 'calc(100vw - 36px)', height: 'auto', minHeight: 'auto', padding: '24px', display: 'block', background: 'var(--bg-panel)', border: '1px solid var(--border-main)', borderRadius: '8px', boxShadow: '0 20px 60px rgba(0,0,0,0.45)' }}>
                <h3 style={{ margin: '0 0 12px 0', color: 'var(--text-main)', fontSize: '18px', fontWeight: 700 }}>{notice.title || 'Setsuna'}</h3>
                <div style={{ color: 'var(--text-main)', fontSize: '14px', lineHeight: 1.55, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{notice.message}</div>
                <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '22px' }}>
                    <button className="btn-primary" onClick={() => setNotice(null)}>{t('common.close')}</button>
                </div>
            </div>
        </div>
    );
};
// Backend import statuses are English; show them in the app language.
const IMPORT_STATUS_RU: Record<string, string> = {
    'Building lookup indexes...': 'Строю индексы поиска…',
    'Importing Cambridge JSON...': 'Импортирую Cambridge JSON…',
    'Importing Cambridge JSONL...': 'Импортирую Cambridge JSONL…',
    'Importing DICTD entries...': 'Импортирую статьи DICTD…',
    'Importing DSL entries...': 'Импортирую статьи DSL…',
    'Importing JSON entries...': 'Импортирую статьи JSON…',
    'Importing Kaikki JSONL...': 'Импортирую Kaikki JSONL…',
    'Importing StarDict entries...': 'Импортирую статьи StarDict…',
    'Importing text entries...': 'Импортирую текстовые статьи…',
    'Opening JSONL dictionary...': 'Открываю словарь JSONL…',
    'Opening StarDict files...': 'Открываю файлы StarDict…',
    'Opening database...': 'Открываю базу словарей…',
    'Optimizing dictionary database (one time)...': 'Оптимизирую базу словарей (один раз)…',
    'Preparing dictionary...': 'Готовлю словарь…',
    'Rebuilding dictionary indexes...': 'Восстанавливаю индексы словарей…',
    'Reading JSON dictionary...': 'Читаю словарь JSON…',
    'Reading dictionary archive...': 'Читаю архив словаря…',
    'Reading text dictionary...': 'Читаю текстовый словарь…',
    'Removing previous version...': 'Удаляю прошлую версию…',
    'Saving dictionary...': 'Сохраняю словарь…',
    'Streaming Yomitan JSON...': 'Читаю Yomitan JSON…',
    'Streaming large JSON dictionary...': 'Читаю большой словарь JSON…',
    'Waiting for dictionary database...': 'Жду базу словарей…',
    'Import complete': 'Готово',
    'Collecting dictionaries...': 'Собираю словари…',
    'Compressing...': 'Сжимаю…',
    'Uploading to Google Drive...': 'Загружаю на Google Drive…',
    'Downloading...': 'Скачиваю…',
    'Unpacking...': 'Распаковываю…',
    'Done': 'Готово',
};

// Import progress is a small pill (like the stats pill) that never blocks
// reading; a click opens the details. Batches show "6/19" next to it.
export const ImportProgressModal = ({ jsonProgress, dictProgress, language = 'ru' }: any) => {
    const t = getTranslator(language as AppLanguage);
    const en = language === 'en';
    const [expanded, setExpanded] = useState(false);
    const [startedAt, setStartedAt] = useState<number | null>(null);
    const active = Boolean(jsonProgress || dictProgress);
    useEffect(() => {
        if (active && startedAt === null) setStartedAt(Date.now());
        if (!active) { setStartedAt(null); setExpanded(false); }
    }, [active, startedAt]);
    const [, tick] = useState(0);
    useEffect(() => {
        if (!active || !expanded) return;
        const timer = window.setInterval(() => tick((n) => n + 1), 1000);
        return () => window.clearInterval(timer);
    }, [active, expanded]);
    if (!active) return null;

    let label: string;
    let percent: number;
    let badge = '';
    let details: Array<[string, string]> = [];
    let title: string;
    let status = '';
    if (jsonProgress) {
        title = t('modal.importText');
        label = title;
        percent = jsonProgress.total > 0 ? (jsonProgress.current / jsonProgress.total) * 100 : 0;
        details = [[en ? 'Rows' : 'Строк', `${jsonProgress.current} / ${jsonProgress.total}`]];
    } else {
        const p = dictProgress;
        const count = Math.max(1, Number(p.dict_count ?? p.total_dicts) || 1);
        const index = Math.min(count, Math.max(1, Number(p.dict_index) || 1));
        const local = Number.isFinite(p.percent)
            ? Number(p.percent)
            : p.total_files > 0 ? (p.current_file / p.total_files) * 100 : 0;
        percent = count > 1 ? ((index - 1) + Math.min(100, local) / 100) / count * 100 : local;
        if (count > 1) badge = `${index}/${count}`;
        title = count > 1 ? t('modal.importCollection', { count }) : t('modal.importDictionary');
        label = p.operation === 'repair'
            ? (en ? 'Repairing' : 'Восстановление')
            : p.operation === 'share'
            ? (en ? 'Sharing' : 'Раздача')
            : p.operation === 'download'
                ? (en ? 'Downloading' : 'Скачивание')
                : (en ? 'Importing' : 'Импорт');
        if (p.operation === 'share') title = en ? 'Sharing dictionaries' : 'Раздача словарей';
        if (p.operation === 'download') title = en ? 'Downloading shared dictionaries' : 'Скачивание словарей по коду';
        if (p.operation === 'repair') title = en ? 'Repairing dictionary indexes' : 'Восстановление индексов словаря';
        status = String(p.status || '').replace(/^\[\d+\/\d+\]\s*/, '');
        if (!en) status = IMPORT_STATUS_RU[status] || status;
        details = p.operation === 'share' || p.operation === 'download' || p.operation === 'repair'
            ? [
                [p.operation === 'share' ? (en ? 'Pack' : 'Пакет') : p.operation === 'repair' ? (en ? 'Database' : 'База') : (en ? 'Source' : 'Источник'), String(p.dict_name || '')],
                [en ? 'Progress' : 'Готово', `${Math.floor(Math.max(0, Math.min(100, local)))}%`],
            ]
            : [
                [en ? 'Dictionary' : 'Словарь', String(p.dict_name || '')],
                ...(count > 1 ? [[en ? 'In the batch' : 'В очереди', `${index} ${en ? 'of' : 'из'} ${count}`] as [string, string]] : []),
                [t('modal.words'), Number(p.words_added || 0).toLocaleString(en ? 'en-US' : 'ru-RU')],
                [en ? 'This dictionary' : 'Этот словарь', `${Math.floor(Math.min(100, local))}%`],
            ];
    }
    const shown = Math.max(0, Math.min(100, percent));
    const elapsed = startedAt ? Math.max(0, Math.round((Date.now() - startedAt) / 1000)) : 0;
    const clock = `${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, '0')}`;
    const radius = 11;
    const circumference = 2 * Math.PI * radius;

    // Portal to <body>: inside the app tree the pill shared compositing with the
    // blurred settings overlay and vanished/reappeared while pages scrolled.
    return createPortal(
        <div className={`import-pill-wrap${expanded ? ' is-expanded' : ''}`} role="status" aria-live="polite">
            {expanded && (
                <div className="import-pill-card">
                    <div className="import-pill-card-head">
                        <strong>{title}</strong>
                        <span>{clock}</span>
                    </div>
                    <div className="import-pill-bar"><div style={{ width: `${shown}%` }} /></div>
                    {status && <div className="import-pill-status">{status}</div>}
                    <dl>
                        {details.map(([key, value]) => (
                            <div key={key}><dt>{key}</dt><dd title={value}>{value}</dd></div>
                        ))}
                    </dl>
                    <p>{dictProgress?.operation === 'repair'
                        ? (en ? 'The last import was interrupted. Keep Setsuna open until the indexes are rebuilt; lookups may be slow meanwhile.' : 'Прошлый импорт был прерван. Не закрывай Setsuna, пока индексы не соберутся; до этого поиск может работать медленно.')
                        : (en ? 'You can keep reading: lookups keep working during the import. Keep Setsuna open until it finishes.' : 'Можно читать дальше: поиск по словам работает и во время импорта. Не закрывай Setsuna до его окончания.')}</p>
                </div>
            )}
            <button type="button" className="import-pill" onClick={() => setExpanded((v) => !v)} aria-expanded={expanded}
                title={en ? 'Dictionary import: click for details' : 'Импорт словарей: нажми, чтобы увидеть подробности'}>
                <svg className="import-pill-ring" width="28" height="28" viewBox="0 0 28 28" aria-hidden="true">
                    <circle cx="14" cy="14" r={radius} className="import-pill-ring-track" />
                    <circle cx="14" cy="14" r={radius} className="import-pill-ring-value"
                        strokeDasharray={circumference} strokeDashoffset={circumference * (1 - shown / 100)} />
                </svg>
                <span className="import-pill-label">{label}</span>
                <span className="import-pill-percent">{Math.floor(shown)}%</span>
                {badge && <span className="import-pill-badge">{badge}</span>}
            </button>
        </div>,
        document.body,
    );
};

export const ExportModal = ({ isOpen, onClose, fileName, setFileName, tabs, selection, setSelection, onExport, language = 'ru' }: any) => {
    const t = getTranslator(language as AppLanguage);
    if (!isOpen) return null;

    return (
        <div className="modal-overlay" onClick={onClose}>
            <div className="modern-modal" style={{ width: '400px', height: 'auto', minHeight: 'auto', padding: '25px', display: 'block' }} onClick={e => e.stopPropagation()}>
                <h3 style={{ margin: '0 0 20px 0', fontWeight: 'normal' }}>{t('modal.exportTabs')}</h3>
                <div style={{ marginBottom: '20px' }}>
                    <label style={{ display: 'block', fontSize: '13px', color: 'var(--text-muted)', marginBottom: '8px' }}>{t('modal.fileName')}</label>
                    <input type="text" className="modern-input" value={fileName} onChange={e => setFileName(e.target.value)} />
                </div>
                <div style={{ marginBottom: '20px', maxHeight: '200px', overflowY: 'auto', background: 'var(--bg-main)', border: '1px solid var(--border-main)', borderRadius: '6px', padding: '10px' }}>
                    <label style={{ display: 'block', fontSize: '13px', color: 'var(--text-muted)', marginBottom: '10px', borderBottom: '1px solid var(--border-main)', paddingBottom: '8px' }}>{t('modal.selectTabs')}</label>
                    {tabs.map((tab: Tab) => (
                        <label key={tab.id} className="checkbox-label" style={{ marginBottom: '10px', display: 'flex', alignItems: 'center' }}>
                            <input
                                type="checkbox"
                                checked={selection.includes(tab.id)}
                                onChange={e => {
                                    if (e.target.checked) setSelection((prev: number[]) => [...prev, tab.id]);
                                    else setSelection((prev: number[]) => prev.filter((id: number) => id !== tab.id));
                                }}
                            />
                            {tab.name}
                        </label>
                    ))}
                </div>
                <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end' }}>
                    <button className="btn-primary" style={{ background: 'transparent', color: 'var(--text-main)', border: '1px solid var(--border-main)' }} onClick={onClose}>{t('common.cancel')}</button>
                    <button className="btn-primary" disabled={selection.length === 0} onClick={onExport}>{t('modal.exportSelected', { count: selection.length })}</button>
                </div>
            </div>
        </div>
    );
};
