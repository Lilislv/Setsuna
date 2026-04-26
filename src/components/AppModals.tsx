import { Tab } from '../utils/constants';

// Окно диалога "Вы уверены?"
export const ConfirmDialogModal = ({ dialog, setDialog }: any) => {
    if (!dialog) return null;
    return (
        <div className="modal-overlay" style={{ zIndex: 100000, position: 'fixed', top: 0, left: 0, width: '100vw', height: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }} onClick={() => setDialog(null)}>
            <div className="modern-modal" onClick={e => e.stopPropagation()} style={{ width: '400px', height: 'auto', minHeight: 'auto', padding: '25px', textAlign: 'center', display: 'block', background: 'var(--bg-panel)', border: '1px solid var(--border-main)', borderRadius: '8px' }}>
                <h3 style={{ marginTop: 0, color: 'var(--text-main)', fontSize: '18px', fontWeight: 'bold' }}>{dialog.title}</h3>
                <p style={{ color: 'var(--text-muted)', marginBottom: '25px', lineHeight: '1.5', fontSize: '14px' }}>{dialog.message}</p>
                <div style={{ display: 'flex', gap: '10px', justifyContent: 'center' }}>
                    <button className="btn-primary" style={{ background: 'transparent', color: 'var(--text-main)', border: '1px solid var(--border-main)', padding: '8px 20px' }} onClick={() => setDialog(null)}>Отмена</button>
                    <button className="btn-primary" style={{ background: '#ff4444', border: 'none', padding: '8px 20px' }} onClick={() => { dialog.onConfirm(); setDialog(null); }}>Подтвердить</button>
                </div>
            </div>
        </div>
    );
};

// Окно загрузки (когда импортируется JSON или Словарь)
export const ImportProgressModal = ({ jsonProgress, dictProgress }: any) => {
    if (jsonProgress) {
        return (
            <div className="modal-overlay" style={{ position: 'fixed', top: 0, left: 0, width: '100vw', height: '100vh', zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <div className="modern-modal" style={{ background: 'var(--bg-panel)', padding: '30px', borderRadius: '8px', width: '350px', height: 'auto', minHeight: 'auto', display: 'block', textAlign: 'center', border: '1px solid var(--border-main)' }}>
                    <h3 style={{ marginTop: 0, color: 'var(--text-main)', fontSize: '18px', fontWeight: 'normal' }}>Импорт текста</h3>
                    <div style={{ width: '100%', height: '8px', backgroundColor: 'var(--bg-main)', borderRadius: '4px', overflow: 'hidden', margin: '20px 0' }}>
                        <div style={{ width: `${(jsonProgress.current / jsonProgress.total) * 100}%`, height: '100%', backgroundColor: '#4fa6ff', transition: 'width 0.1s' }} />
                    </div>
                    <div style={{ color: 'var(--text-muted)', fontSize: '13px' }}>Обработано {jsonProgress.current} из {jsonProgress.total} строк</div>
                </div>
            </div>
        );
    }
    if (dictProgress) {
        return (
            <div className="modal-overlay" style={{ position: 'fixed', top: 0, left: 0, width: '100vw', height: '100vh', zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <div className="modern-modal" style={{ background: 'var(--bg-panel)', padding: '30px', borderRadius: '8px', width: '400px', height: 'auto', minHeight: 'auto', display: 'block', textAlign: 'center', border: '1px solid var(--border-main)' }}>
                    <div style={{ color: '#4CAF50', fontSize: '14px', marginBottom: '8px', fontWeight: 'bold' }}>
                        {dictProgress.total_dicts > 1 ? `Импорт коллекции (${dictProgress.total_dicts} словарей)` : 'Импорт словаря'}
                    </div>
                    <h3 style={{ marginTop: 0, color: 'var(--text-main)', fontSize: '18px', fontWeight: 'normal', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {dictProgress.dict_name}
                    </h3>
                    <div style={{ width: '100%', height: '10px', backgroundColor: 'var(--bg-main)', borderRadius: '5px', overflow: 'hidden', margin: '20px 0' }}>
                        <div style={{ width: `${(dictProgress.current_file / dictProgress.total_files) * 100}%`, height: '100%', backgroundColor: '#4CAF50', transition: 'width 0.2s' }} />
                    </div>
                    <div style={{ color: 'var(--text-muted)', fontSize: '13px', display: 'flex', justifyContent: 'space-between', borderBottom: '1px solid var(--border-main)', paddingBottom: '10px', marginBottom: '10px' }}>
                        <span>Файлов: {dictProgress.current_file} / {dictProgress.total_files}</span>
                        <span>Слов: {dictProgress.words_added}</span>
                    </div>
                    {dictProgress.status && <div style={{ color: '#4fa6ff', fontSize: '13px' }}>{dictProgress.status}</div>}
                </div>
            </div>
        );
    }
    return null;
};

// Окно экспорта вкладок
export const ExportModal = ({ isOpen, onClose, fileName, setFileName, tabs, selection, setSelection, onExport }: any) => {
    if (!isOpen) return null;
    return (
        <div className="modal-overlay" onClick={onClose}>
            <div className="modern-modal" style={{ width: '400px', height: 'auto', minHeight: 'auto', padding: '25px', display: 'block' }} onClick={e => e.stopPropagation()}>
                <h3 style={{ margin: '0 0 20px 0', fontWeight: 'normal' }}>Экспорт вкладок</h3>
                <div style={{ marginBottom: '20px' }}>
                    <label style={{ display: 'block', fontSize: '13px', color: 'var(--text-muted)', marginBottom: '8px' }}>Имя файла:</label>
                    <input type="text" className="modern-input" value={fileName} onChange={e => setFileName(e.target.value)} />
                </div>
                <div style={{ marginBottom: '20px', maxHeight: '200px', overflowY: 'auto', background: 'var(--bg-main)', border: '1px solid var(--border-main)', borderRadius: '6px', padding: '10px' }}>
                    <label style={{ display: 'block', fontSize: '13px', color: 'var(--text-muted)', marginBottom: '10px', borderBottom: '1px solid var(--border-main)', paddingBottom: '8px' }}>Выберите окна:</label>
                    {tabs.map((t: Tab) => (
                        <label key={t.id} className="checkbox-label" style={{ marginBottom: '10px', display: 'flex', alignItems: 'center' }}>
                            <input 
                                type="checkbox" 
                                checked={selection.includes(t.id)} 
                                onChange={e => {
                                    if (e.target.checked) setSelection((prev: number[]) => [...prev, t.id]);
                                    else setSelection((prev: number[]) => prev.filter((id: number) => id !== t.id));
                                }} 
                            />
                            {t.name}
                        </label>
                    ))}
                </div>
                <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end' }}>
                    <button className="btn-primary" style={{ background: 'transparent', color: 'var(--text-main)', border: '1px solid var(--border-main)' }} onClick={onClose}>Отмена</button>
                    <button className="btn-primary" disabled={selection.length === 0} onClick={onExport}>Экспорт ({selection.length})</button>
                </div>
            </div>
        </div>
    );
};