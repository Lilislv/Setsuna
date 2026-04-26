import { useState, useEffect, useRef } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import SetupWizard from "./SetupWizard"; 

import SettingsLookup from "./Settings/SettingsLookup";
import SettingsAnki from "./Settings/SettingsAnki";
import SettingsCloud from "./Settings/SettingsCloud";
import { DEFAULT_SETTINGS } from "../utils/constants";

export interface TextReplacement { id: string; active: boolean; pattern: string; replacement: string; isRegex: boolean; }
export interface WsConfig { id: string; name: string; url: string; active: boolean; }

export interface AppSettings {
  useClipboard: boolean; websockets: WsConfig[];
  panelPosition: 'bottom' | 'top-right'; speedMetric: 'chars' | 'words' | 'sentences'; speedTimeframe: 'minute' | 'hour';
  allowManualPaste: boolean; allowManualPasteDuringPause: boolean;
  
  lookupHotkey: 'Shift' | 'Control' | 'Alt';
  lookupScale: number; lookupFontSize: number; lookupTagFontSize: number; lookupWidth: number; lookupShowTags: boolean; lookupShowAudio: boolean;
  hookProcesses: { name: string; active: boolean; icon?: string }[];

  ankiDeck: string; ankiModel: string; 
  ankiFieldWord: string; ankiFieldReading: string; ankiFieldMeaning: string; ankiFieldSentence: string; ankiFieldDict: string;
  ankiFieldAudio: string; ankiFieldPitch: string; ankiFieldFreq: string; ankiFieldScreenshot: string;
  ankiShowButtonNormal: boolean; ankiShowButtonScreenshot: boolean;

  dictionaries: { name: string; active: boolean; color?: string; allowDeinflect?: boolean }[];
  autoPlayAudio: boolean; helperUrl: string; syncPin: string; gdriveRefreshToken?: string;
  ankiColorNew: string; ankiColorOther: string; ankiColorSame: string; 
  ankiAllowDuplicatesOther: boolean; ankiAllowDuplicatesSame: boolean; 
  fontSize: number; fontFamily: string; furiganaMode: 'none' | 'auto'; appLanguage: 'ru' | 'en'; autoScrollOffset: number; theme: 'dark' | 'light' | 'amoled';
  replacements: TextReplacement[]; removeWhitespace: boolean; requireJapanese: boolean; ignoreDuplicates: boolean; enableTextCleaner: boolean; searchEngine: string;
}

interface SettingsModalProps { 
    isOpen: boolean; onClose: () => void; settings: AppSettings; onSettingsChange: (newSettings: AppSettings) => void; tabs: any[]; setTabs: (t: any[]) => void; 
    syncDictionaries: () => Promise<void>; runDictImport: (path: string) => Promise<void>;
    onResetSettings: () => void; onClearLookup: () => void; 
}

export default function SettingsModal({ isOpen, onClose, settings, onSettingsChange, tabs, setTabs, syncDictionaries, runDictImport, onClearLookup }: SettingsModalProps) {
  const [activeTab, setActiveTab] = useState<'text' | 'lookup' | 'anki' | 'cloud'>('text');
  const [activeSubTab, setActiveSubTab] = useState<string>('text-app');
  const [highlightedSection, setHighlightedSection] = useState<string | null>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  const [wizardOpen, setWizardOpen] = useState(false);
  const [confirmDialog, setConfirmDialog] = useState<{title: string, message: string, onConfirm: () => void | Promise<void>} | null>(null);
  
  const initialSettingsRef = useRef<AppSettings | null>(null); 
  const historyRef = useRef<AppSettings[]>([]); 
  const [isPreviewMode, setIsPreviewMode] = useState(false); 
  const [resetDialog, setResetDialog] = useState(false); 
  const [localFontSize, setLocalFontSize] = useState(settings.fontSize || 26);
  const [localScrollOffset, setLocalScrollOffset] = useState(settings.autoScrollOffset ?? 80);


  const handleImportYomitanFiles = async () => {
    try {
      const selected = await open({
        multiple: true,
        directory: false,
        filters: [
          {
            name: 'Yomitan export',
            extensions: ['json', 'zip']
          }
        ]
      });

      if (!selected) return;

      const files = Array.isArray(selected) ? selected : [selected];

      const settingsFiles = files.filter((file) => {
        const name = file.toLowerCase().split(/[\\/]/).pop() || file.toLowerCase();
        return name.includes('settings') && name.endsWith('.json');
      });

      const dictionaryFiles = files.filter((file) => {
        const lower = file.toLowerCase();
        const name = lower.split(/[\\/]/).pop() || lower;

        if (settingsFiles.includes(file)) return false;

        // Yomitan Dictionary Collection чаще всего экспортируется как json.
        // Обычные словари могут быть zip.
        return lower.endsWith('.zip') || lower.endsWith('.json') || name.includes('dictionaries');
      });

      if (dictionaryFiles.length === 0) {
        alert(
          settingsFiles.length > 0
            ? 'Ты выбрал только yomitan-settings.json. Для словарей нужен ещё файл Export Dictionary Collection: обычно yomitan-dictionaries.json.'
            : 'Не найден файл словарей. Выбери yomitan-dictionaries.json или .zip словаря.'
        );
        return;
      }

      for (const file of dictionaryFiles) {
        await runDictImport(file);
      }

      await syncDictionaries();

      if (settingsFiles.length > 0) {
        alert('Словари импортированы. yomitan-settings.json выбран тоже, но сейчас он не обязателен: настройки Yomitan пока не переносятся автоматически.');
      } else {
        alert('Словари Yomitan импортированы.');
      }
    } catch (e) {
      alert('Ошибка выбора/импорта файлов Yomitan: ' + e);
    }
  };

  useEffect(() => {
      if (isOpen) {
          initialSettingsRef.current = JSON.parse(JSON.stringify(settings));
          historyRef.current = [];
          syncDictionaries();
          document.body.style.overflow = 'hidden';
      } else { 
          document.body.style.overflow = 'unset'; 
          setIsPreviewMode(false);
      }
      return () => { document.body.style.overflow = 'unset'; };
  }, [isOpen]);

  useEffect(() => {
      if (isOpen && highlightedSection) {
          setTimeout(() => {
              const el = document.getElementById(highlightedSection);
              if (el) { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); setTimeout(() => setHighlightedSection(null), 2000); }
          }, 100);
      }
  }, [isOpen, highlightedSection]);

  useEffect(() => { setLocalFontSize(settings.fontSize || 26); }, [settings.fontSize]);
  useEffect(() => { setLocalScrollOffset(settings.autoScrollOffset ?? 80); }, [settings.autoScrollOffset]);

  const updateSetting = <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => { 
      historyRef.current.push(JSON.parse(JSON.stringify(settings))); 
      onSettingsChange({ ...settings, [key]: value }); 
  };

  useEffect(() => {
      const handleKeyDown = (e: KeyboardEvent) => {
          if (isOpen && (e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === 'z' || e.key.toLowerCase() === 'я')) {
              if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
              e.preventDefault();
              if (historyRef.current.length > 0) {
                  const prev = historyRef.current.pop();
                  if (prev) onSettingsChange(prev);
              }
          }
      };
      window.addEventListener('keydown', handleKeyDown);
      return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, settings]);

  const handleCancel = () => {
      onClose();
  };

  const handleResetVisuals = () => {
      historyRef.current.push(JSON.parse(JSON.stringify(settings)));
      onSettingsChange({
          ...settings,
          theme: 'dark', fontSize: 26, fontFamily: "'Noto Serif JP', sans-serif",
          panelPosition: 'bottom', autoScrollOffset: 80,
          lookupScale: 1.0, lookupFontSize: 14, lookupTagFontSize: 11, lookupWidth: 380,
      });
      setResetDialog(false);
  };
  
  const handleResetAll = () => {
      historyRef.current.push(JSON.parse(JSON.stringify(settings)));
      onSettingsChange({
          ...DEFAULT_SETTINGS,
          dictionaries: settings.dictionaries, websockets: settings.websockets, hookProcesses: settings.hookProcesses
      });
      setResetDialog(false);
  };

  const handleNav = (mainTab: 'text' | 'lookup' | 'anki' | 'cloud', subTab: string) => {
      if (activeTab !== mainTab) setActiveTab(mainTab);
      setActiveSubTab(subTab); setHighlightedSection(subTab);
      setTimeout(() => {
          const el = document.getElementById(subTab);
          if (el && scrollContainerRef.current) scrollContainerRef.current.scrollTo({ top: el.offsetTop - 25, behavior: 'smooth' });
      }, 50);
      setTimeout(() => setHighlightedSection(null), 1000); 
  };

  if (!isOpen) return null;

  return (
    <>
      <style>{`
          @keyframes tabFadeIn { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
          .tab-content-anim { animation: tabFadeIn 0.25s cubic-bezier(0.2, 0.8, 0.2, 1) forwards; display: flex; flex-direction: column; gap: 25px; }
          @keyframes smoothFlash { 0% { border-color: var(--border-main); background-color: var(--bg-panel); box-shadow: none; } 15% { border-color: var(--accent-blue); background-color: rgba(79, 166, 255, 0.08); box-shadow: 0 0 10px rgba(79, 166, 255, 0.2); } 100% { border-color: var(--border-main); background-color: var(--bg-panel); box-shadow: none; } }
          .card-highlighted { animation: smoothFlash 1s ease-in-out forwards; }
          .tiny-scroll::-webkit-scrollbar { width: 6px; } .tiny-scroll::-webkit-scrollbar-track { background: var(--bg-main); border-radius: 4px; } .tiny-scroll::-webkit-scrollbar-thumb { background: var(--border-main); border-radius: 4px; } .tiny-scroll::-webkit-scrollbar-thumb:hover { background: var(--text-muted); }
      `}</style>

      {wizardOpen && (
        <SetupWizard
          isOpen={wizardOpen}
          onClose={() => setWizardOpen(false)}
          installedDictionariesCount={settings.dictionaries?.length || 0}
          ankiDeck={settings.ankiDeck}
          ankiModel={settings.ankiModel}
        onAnkiDeckChange={(deck) => onSettingsChange({ ...settings, ankiDeck: deck })}
          onImportYomitan={handleImportYomitanFiles}
        />
      )}
      
      {/* КНОПКА ВОЗВРАТА */}
      {isPreviewMode && (
          <div style={{ position: 'fixed', top: '20px', left: '50%', transform: 'translateX(-50%)', zIndex: 100001 }}>
              <button onClick={() => setIsPreviewMode(false)} className="btn-primary" style={{ padding: '12px 24px', borderRadius: '30px', fontSize: '15px', fontWeight: 'bold', boxShadow: '0 10px 25px rgba(0,0,0,0.5)', border: '1px solid rgba(255,255,255,0.2)', cursor: 'pointer' }}>
                  🔙 Вернуться к настройкам
              </button>
          </div>
      )}

      {/* ОВЕРЛЕЙ. Удаляем класс модалки при предпросмотре, чтобы отключить блюр */}
      <div className={isPreviewMode ? "" : "modal-overlay"} onClick={() => { if (!isPreviewMode) { handleCancel(); onClearLookup(); } }} 
           style={{
               position: 'fixed', top: 0, left: 0, width: '100vw', height: '100vh',
               display: 'flex', alignItems: 'center', justifyContent: 'center',
               pointerEvents: isPreviewMode ? 'none' : 'auto', 
               backgroundColor: isPreviewMode ? 'transparent' : 'var(--overlay-bg)',
               zIndex: 10000,
               transition: 'background-color 0.2s'
           }}>
        
        {/* ИСПРАВЛЕНИЕ: animation: none убивает CSS анимацию, мешающую opacity: 0 */}
        <div className="modern-modal" onClick={(e) => { e.stopPropagation(); onClearLookup(); }} 
             style={{ 
                 opacity: isPreviewMode ? 0 : 1, 
                 animation: isPreviewMode ? 'none' : undefined, 
                 pointerEvents: isPreviewMode ? 'none' : 'auto',
                 background: 'var(--bg-panel)', color: 'var(--text-main)', border: '1px solid var(--border-main)', 
                 width: '95vw', maxWidth: '1400px', height: '90vh', minHeight: '600px', display: 'flex', flexDirection: 'column',
                 transition: 'opacity 0.2s'
             }}>
          
          <div className="modern-header" style={{ borderBottom: '1px solid var(--border-main)', padding: '15px 25px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '15px' }}>
                  <h1 style={{ fontWeight: 'normal', margin: 0, fontSize: '22px' }}>Настройки</h1>
                  <button onClick={() => setIsPreviewMode(true)} style={{ background: 'var(--bg-side)', color: 'var(--accent-blue)', border: '1px solid var(--accent-blue)', borderRadius: '6px', padding: '6px 12px', cursor: 'pointer', transition: '0.1s', fontSize: '13px', display: 'flex', alignItems: 'center', gap: '6px' }}>
                      👁 Скрыть для предпросмотра
                  </button>
              </div>
              
              <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
                  <button
                      onClick={handleCancel}
                      style={{
                          background: 'transparent',
                          color: 'var(--text-muted)',
                          border: '1px solid var(--border-main)',
                          width: '32px',
                          height: '32px',
                          borderRadius: '6px',
                          cursor: 'pointer',
                          fontSize: '18px',
                          lineHeight: '1',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                      }}
                      title="Закрыть"
                  >
                      ×
                  </button>

                  <button onClick={() => setResetDialog(true)} style={{ background: 'transparent', color: '#ff4444', border: 'none', cursor: 'pointer', transition: '0.2s', fontSize: '13px' }}>Сброс</button>
                  <button onClick={() => setWizardOpen(true)} style={{ background: 'transparent', color: 'var(--text-main)', border: 'none', cursor: 'pointer', transition: '0.2s', fontSize: '13px' }}>Мастер</button>
              </div>

          </div>
          
          <div className="modern-body" style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
            
            {/* ЛЕВОЕ МЕНЮ */}
            <div className="modern-sidebar" style={{ borderRight: '1px solid var(--border-main)', flexShrink: 0, width: '240px', overflowY: 'auto', padding: '15px 0' }}>
              <div onClick={() => handleNav('text', 'text-app')} style={{ padding: '8px 20px', cursor: 'pointer', fontSize: '14px', fontWeight: 'bold', color: activeTab === 'text' ? 'var(--text-main)' : 'var(--text-muted)', backgroundColor: activeTab === 'text' ? 'var(--hover-bg)' : 'transparent', transition: '0.1s' }}>Текст</div>
              {activeTab === 'text' && (
                  <div style={{ display: 'flex', flexDirection: 'column', marginBottom: '10px' }}>
                      <div onClick={() => handleNav('text', 'text-app')} style={{ padding: '6px 20px 6px 35px', cursor: 'pointer', fontSize: '13px', color: activeSubTab === 'text-app' ? 'var(--accent-blue)' : 'var(--text-muted)', borderLeft: activeSubTab === 'text-app' ? '3px solid var(--accent-blue)' : '3px solid transparent' }}>Внешний вид</div>
                      <div onClick={() => handleNav('text', 'text-stats')} style={{ padding: '6px 20px 6px 35px', cursor: 'pointer', fontSize: '13px', color: activeSubTab === 'text-stats' ? 'var(--accent-blue)' : 'var(--text-muted)', borderLeft: activeSubTab === 'text-stats' ? '3px solid var(--accent-blue)' : '3px solid transparent' }}>Панель статистики</div>
                      <div onClick={() => handleNav('text', 'text-src')} style={{ padding: '6px 20px 6px 35px', cursor: 'pointer', fontSize: '13px', color: activeSubTab === 'text-src' ? 'var(--accent-blue)' : 'var(--text-muted)', borderLeft: activeSubTab === 'text-src' ? '3px solid var(--accent-blue)' : '3px solid transparent' }}>Источники</div>
                      <div onClick={() => handleNav('text', 'text-filters')} style={{ padding: '6px 20px 6px 35px', cursor: 'pointer', fontSize: '13px', color: activeSubTab === 'text-filters' ? 'var(--accent-blue)' : 'var(--text-muted)', borderLeft: activeSubTab === 'text-filters' ? '3px solid var(--accent-blue)' : '3px solid transparent' }}>Фильтры</div>
                  </div>
              )}
              <div onClick={() => handleNav('lookup', 'lookup-win')} style={{ padding: '8px 20px', cursor: 'pointer', fontSize: '14px', fontWeight: 'bold', color: activeTab === 'lookup' ? 'var(--text-main)' : 'var(--text-muted)', backgroundColor: activeTab === 'lookup' ? 'var(--hover-bg)' : 'transparent', transition: '0.1s' }}>Лукап</div>
              {activeTab === 'lookup' && (
                  <div style={{ display: 'flex', flexDirection: 'column', marginBottom: '10px' }}>
                      <div onClick={() => handleNav('lookup', 'lookup-win')} style={{ padding: '6px 20px 6px 35px', cursor: 'pointer', fontSize: '13px', color: activeSubTab === 'lookup-win' ? 'var(--accent-blue)' : 'var(--text-muted)', borderLeft: activeSubTab === 'lookup-win' ? '3px solid var(--accent-blue)' : '3px solid transparent' }}>Настройки окна</div>
                      <div onClick={() => handleNav('lookup', 'lookup-dicts')} style={{ padding: '6px 20px 6px 35px', cursor: 'pointer', fontSize: '13px', color: activeSubTab === 'lookup-dicts' ? 'var(--accent-blue)' : 'var(--text-muted)', borderLeft: activeSubTab === 'lookup-dicts' ? '3px solid var(--accent-blue)' : '3px solid transparent' }}>Словари</div>
                  </div>
              )}
              <div onClick={() => handleNav('anki', 'anki-cards')} style={{ padding: '8px 20px', cursor: 'pointer', fontSize: '14px', fontWeight: 'bold', color: activeTab === 'anki' ? 'var(--text-main)' : 'var(--text-muted)', backgroundColor: activeTab === 'anki' ? 'var(--hover-bg)' : 'transparent', transition: '0.1s' }}>Anki</div>
              {activeTab === 'anki' && (
                  <div style={{ display: 'flex', flexDirection: 'column', marginBottom: '10px' }}>
                      <div onClick={() => handleNav('anki', 'anki-cards')} style={{ padding: '6px 20px 6px 35px', cursor: 'pointer', fontSize: '13px', color: activeSubTab === 'anki-cards' ? 'var(--accent-blue)' : 'var(--text-muted)', borderLeft: activeSubTab === 'anki-cards' ? '3px solid var(--accent-blue)' : '3px solid transparent' }}>Карточки</div>
                      <div onClick={() => handleNav('anki', 'anki-hooks')} style={{ padding: '6px 20px 6px 35px', cursor: 'pointer', fontSize: '13px', color: activeSubTab === 'anki-hooks' ? 'var(--accent-blue)' : 'var(--text-muted)', borderLeft: activeSubTab === 'anki-hooks' ? '3px solid var(--accent-blue)' : '3px solid transparent' }}>Скриншоты и Кнопки</div>
                  </div>
              )}
              <div onClick={() => handleNav('cloud', 'cloud-main')} style={{ padding: '8px 20px', cursor: 'pointer', fontSize: '14px', fontWeight: 'bold', color: activeTab === 'cloud' ? 'var(--text-main)' : 'var(--text-muted)', backgroundColor: activeTab === 'cloud' ? 'var(--hover-bg)' : 'transparent', transition: '0.1s' }}>Синхронизация</div>
            </div>
            
            {/* ПРАВАЯ ПАНЕЛЬ С КОНТЕНТОМ */}
            <div ref={scrollContainerRef} className="modern-content" style={{ background: 'var(--bg-main)', flex: 1, overflowY: 'auto', padding: '25px', position: 'relative' }}>
              
              {/* === ВКЛАДКА ТЕКСТ === */}
              {activeTab === 'text' && (
                <div className="tab-content-anim">
                  <div id="text-app" className={`modern-card ${highlightedSection === 'text-app' ? 'card-highlighted' : ''}`} style={{ background: 'var(--bg-panel)', border: '1px solid var(--border-main)' }}>
                      <div className="card-label" style={{ color: 'var(--text-main)' }}>Внешний вид</div>
                      <div style={{ display: 'flex', gap: '15px', marginBottom: '15px' }}>
                          <div style={{ flex: 1 }}>
                              <div style={{ color: 'var(--text-muted)', fontSize: '12px', marginBottom: '6px' }}>Цветовая тема:</div>
                              <select className="modern-select" value={settings.theme || 'dark'} onChange={(e) => updateSetting('theme', e.target.value as any)}><option value="dark">Тёмная</option><option value="light">Светлая</option><option value="amoled">AMOLED</option></select>
                          </div>
                          <div style={{ flex: 1 }}>
                              <div style={{ color: 'var(--text-muted)', fontSize: '12px', marginBottom: '6px' }}>Язык программы:</div>
                              <select className="modern-select" value={settings.appLanguage || 'ru'} onChange={(e) => updateSetting('appLanguage', e.target.value as any)}><option value="ru">Русский</option><option value="en">English</option></select>
                          </div>
                      </div>
                      <div style={{ display: 'flex', gap: '15px', alignItems: 'center', marginBottom: '15px' }}>
                          <span style={{ color: 'var(--text-muted)', fontSize: '13px', width: '130px' }}>Размер шрифта:</span>
                          <input type="range" min="12" max="64" value={localFontSize} onChange={(e) => { const val = Number(e.target.value); setLocalFontSize(val); document.documentElement.style.setProperty('--txt-font-size', `${val}px`); }} onMouseUp={() => updateSetting('fontSize', localFontSize)} style={{ flex: 1 }} />
                          <span style={{ color: 'var(--text-main)', fontWeight: 'bold', width: '40px', textAlign: 'center' }}>{localFontSize}px</span>
                      </div>
                      <div style={{ display: 'flex', gap: '15px', alignItems: 'center', marginBottom: '15px' }}>
                          <span style={{ color: 'var(--text-muted)', fontSize: '13px', width: '130px' }}>Позиция автоскролла:</span>
                          <input type="range" min="30" max="85" value={localScrollOffset} onChange={(e) => setLocalScrollOffset(Number(e.target.value))} onMouseUp={() => updateSetting('autoScrollOffset', localScrollOffset)} style={{ flex: 1 }} />
                          <span style={{ color: 'var(--text-main)', fontWeight: 'bold', width: '40px', textAlign: 'center' }}>{localScrollOffset}%</span>
                      </div>
                      <div style={{ display: 'flex', gap: '15px', alignItems: 'center', marginBottom: '15px' }}>
                          <span style={{ color: 'var(--text-muted)', fontSize: '13px', width: '130px' }}>Шрифт текста:</span>
                          <select className="modern-select" value={settings.fontFamily || "'Noto Serif JP', sans-serif"} onChange={(e) => { updateSetting('fontFamily', e.target.value); document.documentElement.style.setProperty('--txt-font-family', e.target.value); }} style={{ flex: 1, marginTop: 0 }}><option value="'Noto Serif JP', serif">Noto Serif JP (С засечками)</option><option value="'Noto Sans JP', sans-serif">Noto Sans JP (Без засечек)</option><option value="'Yu Gothic', sans-serif">Yu Gothic</option><option value="'Meiryo', sans-serif">Meiryo</option></select>
                      </div>
                      <div style={{ display: 'flex', gap: '15px', alignItems: 'center', marginBottom: '15px' }}>
                          <span style={{ color: 'var(--text-muted)', fontSize: '13px', width: '130px' }}>Режим Фуриганы:</span>
                          <select className="modern-select" value={settings.furiganaMode === 'auto' ? 'auto' : 'none'} onChange={(e) => updateSetting('furiganaMode', e.target.value as any)} style={{ flex: 1, marginTop: 0 }}><option value="none">Отключено</option><option value="auto">Автоматически (умный поиск)</option></select>
                      </div>
                  </div>

                  <div id="text-stats" className={`modern-card ${highlightedSection === 'text-stats' ? 'card-highlighted' : ''}`} style={{ background: 'var(--bg-panel)', border: '1px solid var(--border-main)' }}>
                      <div className="card-label" style={{ color: 'var(--text-main)' }}>Панель статистики</div>
                      <div style={{ display: 'flex', gap: '15px' }}>
                          <div style={{ flex: 1 }}>
                              <div style={{ color: 'var(--text-muted)', fontSize: '12px', marginBottom: '6px' }}>Расположение:</div>
                              <select className="modern-select" value={settings.panelPosition || 'bottom'} onChange={(e) => updateSetting('panelPosition', e.target.value as any)}>
                                  <option value="bottom">Внизу (Закреплена)</option>
                                  <option value="top-right">Справа сверху (Плавающая)</option>
                              </select>
                          </div>
                          <div style={{ flex: 1 }}>
                              <div style={{ color: 'var(--text-muted)', fontSize: '12px', marginBottom: '6px' }}>Скорость чтения:</div>
                              <select className="modern-select" value={settings.speedMetric || 'chars'} onChange={(e) => updateSetting('speedMetric', e.target.value as any)}>
                                  <option value="chars">Символы</option>
                                  <option value="words">Слова</option>
                                  <option value="sentences">Предложения</option>
                              </select>
                          </div>
                          <div style={{ flex: 1 }}>
                              <div style={{ color: 'var(--text-muted)', fontSize: '12px', marginBottom: '6px' }}>За период:</div>
                              <select className="modern-select" value={settings.speedTimeframe || 'minute'} onChange={(e) => updateSetting('speedTimeframe', e.target.value as any)}>
                                  <option value="minute">В минуту</option>
                                  <option value="hour">В час</option>
                              </select>
                          </div>
                      </div>
                  </div>

                  <div id="text-src" className={`modern-card ${highlightedSection === 'text-src' ? 'card-highlighted' : ''}`} style={{ background: 'var(--bg-panel)', border: '1px solid var(--border-main)' }}>
                      <div className="card-label" style={{ color: 'var(--text-main)' }}>Источники текста</div>
                      <label className="checkbox-label" style={{ marginBottom: '10px' }}><input type="checkbox" checked={settings.useClipboard} onChange={(e) => updateSetting('useClipboard', e.target.checked)} /> Перехват буфера обмена</label>
                      <label className="checkbox-label" style={{ marginBottom: '10px' }}><input type="checkbox" checked={settings.allowManualPaste} onChange={(e) => updateSetting('allowManualPaste', e.target.checked)} /> Ручная вставка (Ctrl+V)</label>
                      
                      <div style={{ marginTop: '15px', borderTop: '1px solid var(--border-main)', paddingTop: '15px' }}>
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px' }}>
                              <div style={{ color: 'var(--text-main)', fontSize: '13px', fontWeight: 'bold' }}>Шорткаты WebSockets (на главной панели)</div>
                              <button onClick={() => { updateSetting('websockets', [...(settings.websockets || []), { id: Date.now().toString(), name: 'Новый WS', url: 'ws://localhost:9002', active: true }]); }} className="btn-primary" style={{ padding: '4px 10px', fontSize: '11px' }}>+ Добавить</button>
                          </div>
                          {(!settings.websockets || settings.websockets.length === 0) ? ( <div style={{ color: 'var(--text-muted)', fontSize: '12px' }}>Нет добавленных подключений</div> ) : (
                              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                                  {settings.websockets.map((ws, idx) => (
                                      <div key={ws.id} style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                                          <input type="checkbox" checked={ws.active} onChange={(e) => { const arr = [...settings.websockets]; arr[idx].active = e.target.checked; updateSetting('websockets', arr); }} style={{ accentColor: 'var(--accent-blue)', cursor: 'pointer' }} title="Показывать кнопку на панели" />
                                          <input type="text" className="modern-input" placeholder="Имя" value={ws.name} onChange={(e) => { const arr = [...settings.websockets]; arr[idx].name = e.target.value; updateSetting('websockets', arr); }} style={{ padding: '4px 8px', width: '100px' }} />
                                          <input type="text" className="modern-input" placeholder="ws://" value={ws.url} onChange={(e) => { const arr = [...settings.websockets]; arr[idx].url = e.target.value; updateSetting('websockets', arr); }} style={{ padding: '4px 8px', flex: 1 }} />
                                          <button onClick={() => { updateSetting('websockets', settings.websockets.filter((_, i) => i !== idx)); }} style={{ background: 'transparent', color: '#ff4444', border: 'none', cursor: 'pointer' }}>✕</button>
                                      </div>
                                  ))}
                              </div>
                          )}
                      </div>
                  </div>

                  <div id="text-filters" className={`modern-card ${highlightedSection === 'text-filters' ? 'card-highlighted' : ''}`} style={{ background: 'var(--bg-panel)', border: '1px solid var(--border-main)' }}>
                        <div className="card-label" style={{ color: 'var(--text-main)' }}>Базовые фильтры</div>
                        <label className="checkbox-label" style={{ marginBottom: '12px' }}><input type="checkbox" checked={settings.enableTextCleaner ?? true} onChange={(e) => updateSetting('enableTextCleaner', e.target.checked)} /> Автоматически удалять HTML и Unity теги</label>
                        <label className="checkbox-label" style={{ marginBottom: '12px' }}><input type="checkbox" checked={settings.ignoreDuplicates ?? true} onChange={(e) => updateSetting('ignoreDuplicates', e.target.checked)} /> Игнорировать дублирующиеся подряд строки</label>
                        <label className="checkbox-label" style={{ marginBottom: '12px' }}><input type="checkbox" checked={settings.removeWhitespace ?? false} onChange={(e) => updateSetting('removeWhitespace', e.target.checked)} /> Удалять все пробелы и табуляции из текста</label>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '15px', marginTop: '20px', borderTop: '1px solid var(--border-main)', paddingTop: '20px' }}>
                            <div className="card-label" style={{ margin: 0, color: 'var(--text-main)' }}>Пользовательские замены</div>
                            <button onClick={() => { updateSetting('replacements', [...(settings.replacements || []), { id: Date.now().toString(), active: true, pattern: '', replacement: '', isRegex: false }]); }} className="btn-primary" style={{ padding: '6px 12px' }}>Добавить правило</button>
                        </div>
                        {(!settings.replacements || settings.replacements.length === 0) ? (
                            <div style={{ color: 'var(--text-muted)', fontSize: '13px', textAlign: 'center', padding: '20px', border: '1px dashed var(--border-main)', borderRadius: '6px' }}>Нет правил замены. Нажмите "Добавить правило".</div>
                        ) : (
                            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                                {settings.replacements.map((rep, idx) => (
                                    <div key={rep.id} style={{ display: 'flex', gap: '10px', alignItems: 'center', background: 'var(--bg-side)', padding: '10px', borderRadius: '6px', border: '1px solid var(--border-main)' }}>
                                        <input type="checkbox" checked={rep.active} onChange={(e) => { const arr = [...settings.replacements]; arr[idx].active = e.target.checked; updateSetting('replacements', arr); }} style={{ cursor: 'pointer', width: '16px', height: '16px', accentColor: 'var(--accent-blue)' }} />
                                        <div style={{ display: 'flex', flex: 1, gap: '8px', alignItems: 'center' }}>
                                            <select className="modern-select" style={{ width: '90px', padding: '6px 8px' }} value={rep.isRegex ? 'regex' : 'text'} onChange={(e) => { const arr = [...settings.replacements]; arr[idx].isRegex = e.target.value === 'regex'; updateSetting('replacements', arr); }}><option value="text">Текст</option><option value="regex">Regex</option></select>
                                            <input type="text" className="modern-input" placeholder="Найти..." value={rep.pattern} onChange={(e) => { const arr = [...settings.replacements]; arr[idx].pattern = e.target.value; updateSetting('replacements', arr); }} style={{ padding: '6px 8px' }} />
                                            <span style={{ color: 'var(--text-muted)' }}>→</span>
                                            <input type="text" className="modern-input" placeholder="Заменить на..." value={rep.replacement} onChange={(e) => { const arr = [...settings.replacements]; arr[idx].replacement = e.target.value; updateSetting('replacements', arr); }} style={{ padding: '6px 8px' }} />
                                        </div>
                                        <button onClick={() => { updateSetting('replacements', settings.replacements.filter((_, i) => i !== idx)); }} style={{ background: 'rgba(255, 68, 68, 0.1)', color: '#ff4444', border: '1px solid rgba(255, 68, 68, 0.3)', borderRadius: '4px', cursor: 'pointer', width: '26px', height: '26px' }}>✕</button>
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>
                </div>
              )}

              {/* === ВКЛАДКА ЛУКАП (СЛОВАРИ) === */}
              {activeTab === 'lookup' && (
                  <SettingsLookup
                      settings={settings}
                      updateSetting={updateSetting}
                      highlightedSection={highlightedSection}
                      isOpen={activeTab === 'lookup' && isOpen}
                      syncDictionaries={syncDictionaries}
                      runDictImport={runDictImport}
                      setConfirmDialog={setConfirmDialog}
                  />
              )}

              {/* === ВКЛАДКА ANKI === */}
              {activeTab === 'anki' && (
                  <SettingsAnki 
                      settings={settings} 
                      updateSetting={updateSetting} 
                      highlightedSection={highlightedSection} 
                      isOpen={activeTab === 'anki' && isOpen} 
                  />
              )}

              {/* === ВКЛАДКА CLOUD === */}
              {activeTab === 'cloud' && (
                  <SettingsCloud 
                      settings={settings} 
                      updateSetting={updateSetting} 
                      onSettingsChange={onSettingsChange}
                      tabs={tabs} 
                      setTabs={setTabs} 
                      syncDictionaries={syncDictionaries} 
                      highlightedSection={highlightedSection} 
                      isOpen={activeTab === 'cloud' && isOpen} 
                  />
              )}

            </div>
          </div>
        </div>
      </div>

      {/* МОДАЛКА УДАЛЕНИЯ */}
      {confirmDialog && (
          <div className="modal-overlay" style={{ zIndex: 100000, position: 'fixed', top: 0, left: 0, width: '100vw', height: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }} onClick={() => setConfirmDialog(null)}>
              <div className="modern-modal" onClick={e => e.stopPropagation()} style={{ width: '400px', height: 'auto', minHeight: 'auto', padding: '25px', textAlign: 'center', display: 'block', background: 'var(--bg-panel)', border: '1px solid var(--border-main)', borderRadius: '8px' }}>
                  <h3 style={{ marginTop: 0, color: 'var(--text-main)', fontSize: '18px', fontWeight: 'bold' }}>{confirmDialog.title}</h3>
                  <p style={{ color: 'var(--text-muted)', marginBottom: '25px', lineHeight: '1.5', fontSize: '14px' }}>{confirmDialog.message}</p>
                  <div style={{ display: 'flex', gap: '10px', justifyContent: 'center' }}>
                      <button className="btn-primary" style={{ background: 'transparent', color: 'var(--text-main)', border: '1px solid var(--border-main)', padding: '8px 20px' }} onClick={() => setConfirmDialog(null)}>Отмена</button>
                      <button className="btn-primary" style={{ background: '#ff4444', border: 'none', padding: '8px 20px' }} onClick={() => { confirmDialog.onConfirm(); setConfirmDialog(null); }}>Подтвердить</button>
                  </div>
              </div>
          </div>
      )}

      {/* КАСТОМНАЯ МОДАЛКА ДЛЯ ВЫБОРА СБРОСА */}
      {resetDialog && (
          <div className="modal-overlay" style={{ zIndex: 100000, display: 'flex', alignItems: 'center', justifyContent: 'center' }} onClick={() => setResetDialog(false)}>
              <div className="modern-modal" onClick={e => e.stopPropagation()} style={{ width: '400px', padding: '25px', textAlign: 'center', background: 'var(--bg-panel)', border: '1px solid var(--border-main)', borderRadius: '8px' }}>
                  <h3 style={{ marginTop: 0, color: 'var(--text-main)' }}>Сброс настроек</h3>
                  <p style={{ color: 'var(--text-muted)', marginBottom: '20px', fontSize: '14px' }}>Что именно вы хотите сбросить?</p>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                      <button className="btn-primary" style={{ background: 'var(--bg-side)', color: 'var(--text-main)', border: '1px solid var(--border-main)' }} onClick={handleResetVisuals}>Только внешний вид (шрифты, цвета)</button>
                      <button className="btn-primary" style={{ background: '#ff4444', border: 'none' }} onClick={handleResetAll}>Сбросить ВСЕ настройки</button>
                      <button className="btn-primary" style={{ background: 'transparent', color: 'var(--text-muted)', border: 'none', marginTop: '10px' }} onClick={() => setResetDialog(false)}>Отмена</button>
                  </div>
              </div>
          </div>
      )}

    </>
  );
}