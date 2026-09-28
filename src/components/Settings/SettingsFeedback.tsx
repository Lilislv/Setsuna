import { useEffect, useState } from 'react';
import { getVersion } from '@tauri-apps/api/app';
import { openUrl } from '@tauri-apps/plugin-opener';
import { writeText } from '@tauri-apps/plugin-clipboard-manager';
import { buildFeedback, EMPTY_FEEDBACK, FEEDBACK_ISSUES_URL, feedbackPlatform, normalizeFeedbackDraft, type FeedbackDraft } from '../../utils/feedback';

const DRAFT_KEY = 'setsuna-feedback-draft-v1';
export default function SettingsFeedback({ english }: { english: boolean }) {
    const [draft, setDraft] = useState<FeedbackDraft>(() => {
        try { return normalizeFeedbackDraft(JSON.parse(localStorage.getItem(DRAFT_KEY) || '{}')); } catch { return { ...EMPTY_FEEDBACK }; }
    });
    const [version, setVersion] = useState('unknown');
    const [busy, setBusy] = useState(false);
    const [message, setMessage] = useState('');
    useEffect(() => { void getVersion().then(setVersion).catch(() => {}); }, []);
    useEffect(() => {
        try { localStorage.setItem(DRAFT_KEY, JSON.stringify(draft)); } catch { setMessage(english ? 'The draft could not be saved on this device.' : 'Не удалось сохранить черновик на устройстве.'); }
    }, [draft]);
    const update = <K extends keyof FeedbackDraft>(key: K, value: FeedbackDraft[K]) => setDraft(previous => ({ ...previous, [key]: value }));
    const result = buildFeedback(draft, version, feedbackPlatform(navigator.userAgent));
    const continueOnGitHub = async () => {
        setBusy(true); setMessage('');
        try {
            if (result.copyRequired) await writeText(result.body);
            await openUrl(result.url);
            setMessage(result.copyRequired
                ? (english ? 'Text copied. Paste it into the GitHub description and submit the issue.' : 'Текст скопирован. Вставьте его в описание на GitHub и отправьте обращение.')
                : (english ? 'Draft opened on GitHub. Review it and submit the issue there.' : 'Черновик открыт на GitHub. Проверьте его и отправьте обращение там.'));
        } catch (error) { setMessage(String(error)); }
        finally { setBusy(false); }
    };
    const inputStyle = { display: 'block', width: '100%', boxSizing: 'border-box' as const, marginTop: 6 };
    return <section className="modern-card" id="feedback-main" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <h3 style={{ margin: 0 }}>{english ? 'Report a bug or suggest a feature' : 'Сообщить об ошибке или предложить функцию'}</h3>
        <p style={{ margin: 0, color: 'var(--text-muted)' }}>{english ? 'Feedback goes to the project’s GitHub Issues. A GitHub account is needed. You can review the text and attach screenshots before submitting.' : 'Обращения поступают в GitHub Issues проекта. Нужен аккаунт GitHub. Перед отправкой можно проверить текст и приложить скриншоты.'}</p>
        <label>{english ? 'Type' : 'Тип обращения'}<select className="modern-select" style={inputStyle} value={draft.kind} onChange={e => update('kind', e.target.value as FeedbackDraft['kind'])}>
            <option value="bug">{english ? 'Bug' : 'Ошибка'}</option><option value="feature">{english ? 'Feature request' : 'Новая функция'}</option>
        </select></label>
        <label>{english ? 'Title' : 'Краткое название'}<input style={inputStyle} value={draft.title} maxLength={120} onChange={e => update('title', e.target.value)} placeholder={english ? 'What should be fixed or added?' : 'Что нужно исправить или добавить?'} /></label>
        <label>{english ? 'Description' : 'Описание'}<textarea style={inputStyle} rows={5} maxLength={8000} value={draft.description} onChange={e => update('description', e.target.value)} placeholder={draft.kind === 'bug' ? (english ? 'What happened?' : 'Что произошло?') : (english ? 'What would you like to do, and why?' : 'Что хотелось бы делать и зачем это нужно?')} /></label>
        {draft.kind === 'bug' && <>
            <label>{english ? 'Steps to reproduce (optional)' : 'Как повторить ошибку (необязательно)'}<textarea style={inputStyle} rows={3} maxLength={4000} value={draft.steps} onChange={e => update('steps', e.target.value)} /></label>
            <label>{english ? 'Expected behavior (optional)' : 'Как должно работать (необязательно)'}<textarea style={inputStyle} rows={2} maxLength={2000} value={draft.expected} onChange={e => update('expected', e.target.value)} /></label>
        </>}
        <label className="checkbox-label"><input type="checkbox" checked={draft.includeEnvironment} onChange={e => update('includeEnvironment', e.target.checked)} />{english ? 'Include app version and operating system' : 'Добавить версию приложения и операционную систему'}</label>
        <details><summary>{english ? 'Preview report' : 'Предпросмотр обращения'}</summary><pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxHeight: 300, overflow: 'auto' }}>{result.title}{'\n\n'}{result.body}</pre></details>
        {message && <p role="status" style={{ margin: 0 }}>{message}</p>}
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            <button type="button" className="btn-primary" onClick={continueOnGitHub} disabled={busy || !draft.title.trim() || !draft.description.trim()}>
                {result.copyRequired ? (english ? 'Copy text and open GitHub' : 'Скопировать текст и открыть GitHub') : (english ? 'Continue on GitHub' : 'Продолжить на GitHub')}
            </button>
            <button type="button" className="btn-primary" onClick={() => void openUrl(FEEDBACK_ISSUES_URL).catch(error => setMessage(String(error)))}>{english ? 'Existing reports' : 'Существующие обращения'}</button>
        </div>
    </section>;
}
