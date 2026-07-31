import { Tab } from '../utils/constants';
import { getTranslator, type AppLanguage } from '../utils/i18n';

export const ConfirmDialogModal = ({ dialog, setDialog, language = 'ru' }: any) => {
    const t = getTranslator(language as AppLanguage);
    if (!dialog) return null;

    return (
        <div className="modal-overlay" style={{ zIndex: 100000, position: 'fixed', top: 0, left: 0, width: '100vw', height: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }} onClick={() => setDialog(null)}>
            <div className="modern-modal" onClick={e => e.stopPropagation()} style={{ width: '400px', height: 'auto', minHeight: 'auto', padding: '25px', textAlign: 'center', display: 'block', background: 'var(--bg-panel)', border: '1px solid var(--border-main)', borderRadius: '8px' }}>
                <h3 style={{ marginTop: 0, color: 'var(--text-main)', fontSize: '18px', fontWeight: 'bold' }}>{dialog.title}</h3>
                <p style={{ color: 'var(--text-muted)', marginBottom: '25px', lineHeight: '1.5', fontSize: '14px' }}>{dialog.message}</p>
                <div style={{ display: 'flex', gap: '10px', justifyContent: 'center' }}>
                    <button className="btn-primary" style={{ background: 'transparent', color: 'var(--text-main)', border: '1px solid var(--border-main)', padding: '8px 20px' }} onClick={() => setDialog(null)}>{t('common.cancel')}</button>
                    <button className="btn-primary" style={{ background: '#ff4444', border: 'none', padding: '8px 20px' }} onClick={() => { dialog.onConfirm(); setDialog(null); }}>{t('common.confirm')}</button>
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
export const ImportProgressModal = ({ jsonProgress, dictProgress, language = 'ru' }: any) => {
    const t = getTranslator(language as AppLanguage);

    if (jsonProgress) {
        return (
            <div className="modal-overlay" style={{ position: 'fixed', top: 0, left: 0, width: '100vw', height: '100vh', zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <div className="modern-modal" style={{ background: 'var(--bg-panel)', padding: '30px', borderRadius: '8px', width: '350px', height: 'auto', minHeight: 'auto', display: 'block', textAlign: 'center', border: '1px solid var(--border-main)' }}>
                    <h3 style={{ marginTop: 0, color: 'var(--text-main)', fontSize: '18px', fontWeight: 'normal' }}>{t('modal.importText')}</h3>
                    <div style={{ width: '100%', height: '8px', backgroundColor: 'var(--bg-main)', borderRadius: '4px', overflow: 'hidden', margin: '20px 0' }}>
                        <div style={{ width: `${(jsonProgress.current / jsonProgress.total) * 100}%`, height: '100%', backgroundColor: '#4fa6ff', transition: 'width 0.1s' }} />
                    </div>
                    <div style={{ color: 'var(--text-muted)', fontSize: '13px' }}>{t('modal.processedRows', { current: jsonProgress.current, total: jsonProgress.total })}</div>
                </div>
            </div>
        );
    }

    if (dictProgress) {
        return (
            <div className="modal-overlay" style={{ position: 'fixed', top: 0, left: 0, width: '100vw', height: '100vh', zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <div className="modern-modal" style={{ background: 'var(--bg-panel)', padding: '30px', borderRadius: '8px', width: '400px', height: 'auto', minHeight: 'auto', display: 'block', textAlign: 'center', border: '1px solid var(--border-main)' }}>
                    <div style={{ color: '#4CAF50', fontSize: '14px', marginBottom: '8px', fontWeight: 'bold' }}>
                        {dictProgress.total_dicts > 1 ? t('modal.importCollection', { count: dictProgress.total_dicts }) : t('modal.importDictionary')}
                    </div>
                    <h3 style={{ marginTop: 0, color: 'var(--text-main)', fontSize: '18px', fontWeight: 'normal', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {dictProgress.dict_name}
                    </h3>
                    <div style={{ width: '100%', height: '10px', backgroundColor: 'var(--bg-main)', borderRadius: '5px', overflow: 'hidden', margin: '20px 0' }}>
                        <div style={{ width: `${(dictProgress.current_file / dictProgress.total_files) * 100}%`, height: '100%', backgroundColor: '#4CAF50', transition: 'width 0.2s' }} />
                    </div>
                    <div style={{ color: 'var(--text-muted)', fontSize: '13px', display: 'flex', justifyContent: 'space-between', borderBottom: '1px solid var(--border-main)', paddingBottom: '10px', marginBottom: '10px' }}>
                        <span>{t('modal.files')}: {dictProgress.current_file} / {dictProgress.total_files}</span>
                        <span>{t('modal.words')}: {dictProgress.words_added}</span>
                    </div>
                    {dictProgress.status && <div style={{ color: '#4fa6ff', fontSize: '13px' }}>{dictProgress.status}</div>}
                </div>
            </div>
        );
    }

    return null;
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
