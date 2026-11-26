import { useEffect, useState } from 'react';
import { getVersion } from '@tauri-apps/api/app';
import { invoke } from '@tauri-apps/api/core';
import { openUrl } from '@tauri-apps/plugin-opener';
import { writeText } from '@tauri-apps/plugin-clipboard-manager';
import { buildFeedback, EMPTY_FEEDBACK, FEEDBACK_ISSUES_URL, feedbackPlatform, normalizeFeedbackDraft, type FeedbackDraft } from '../../utils/feedback';
import { isMobilePlatform } from '../../utils/platform';
import './SettingsFeedback.css';

const DRAFT_KEY = 'setsuna-feedback-draft-v1';

async function copyText(value: string) {
    try {
        await writeText(value);
    } catch {
        await navigator.clipboard.writeText(value);
    }
}

export default function SettingsFeedback({ english }: { english: boolean }) {
    const [draft, setDraft] = useState<FeedbackDraft>(() => {
        try { return normalizeFeedbackDraft(JSON.parse(localStorage.getItem(DRAFT_KEY) || '{}')); } catch { return { ...EMPTY_FEEDBACK }; }
    });
    const [version, setVersion] = useState('unknown');
    const [busy, setBusy] = useState(false);
    const [message, setMessage] = useState<{ text: string; isError?: boolean } | null>(null);

    useEffect(() => { void getVersion().then(setVersion).catch(() => {}); }, []);
    useEffect(() => {
        try {
            localStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
        } catch {
            setMessage({
                text: english ? 'The draft could not be saved on this device.' : 'Не удалось сохранить черновик на устройстве.',
                isError: true,
            });
        }
    }, [draft, english]);

    const update = <K extends keyof FeedbackDraft>(key: K, value: FeedbackDraft[K]) =>
        setDraft((previous) => ({ ...previous, [key]: value }));

    const platform = feedbackPlatform(navigator.userAgent);
    const result = buildFeedback(draft, version, platform);
    const hasDraftContent = Boolean(draft.title.trim() || draft.description.trim() || draft.steps.trim() || draft.expected.trim());
    const canSubmit = Boolean(draft.title.trim() && draft.description.trim());

    const continueOnGitHub = async () => {
        setBusy(true);
        setMessage(null);
        try {
            if (result.copyRequired) await copyText(result.body);
            await openUrl(result.url);
            setMessage({
                text: result.copyRequired
                    ? (english ? 'Text copied. Paste it into the GitHub description and submit the issue.' : 'Текст скопирован. Вставьте его в описание на GitHub и отправьте обращение.')
                    : (english ? 'Draft opened on GitHub. Review it and submit the issue there.' : 'Черновик открыт на GitHub. Проверьте его и отправьте обращение там.'),
            });
        } catch (error) {
            setMessage({ text: String(error), isError: true });
        } finally {
            setBusy(false);
        }
    };

    const copyReport = async () => {
        setMessage(null);
        try {
            await copyText(`${result.title}\n\n${result.body}`);
            setMessage({
                text: english ? 'Formatted report copied to clipboard.' : 'Текст обращения скопирован в буфер обмена.',
            });
        } catch (error) {
            setMessage({ text: String(error), isError: true });
        }
    };

    const copyDiagnosticsLogPath = async () => {
        setMessage(null);
        try {
            const path = await invoke<string>('get_diagnostics_log_path');
            await copyText(path);
            setMessage({
                text: english ? `Diagnostics log path copied: ${path}` : `Путь к логу диагностики скопирован: ${path}`,
            });
        } catch (error) {
            setMessage({ text: String(error), isError: true });
        }
    };

    const clearDraft = () => {
        setDraft({ ...EMPTY_FEEDBACK });
        setMessage(null);
    };

    return (
        <section className="modern-card feedback-settings" id="feedback-main">
            <header className="feedback-header">
                <div>
                    <h3>{english ? 'Report a bug or suggest a feature' : 'Сообщить об ошибке или предложить идею'}</h3>
                    <p>
                        {english
                            ? 'Feedback opens in GitHub Issues (account required). You can review everything and attach screenshots or logs before submitting.'
                            : 'Обращения отправляются в GitHub Issues проекта (нужен аккаунт GitHub). Перед отправкой можно проверить текст и приложить скриншоты или лог.'}
                    </p>
                </div>
                <button
                    type="button"
                    className="btn-secondary"
                    onClick={() => void openUrl(FEEDBACK_ISSUES_URL).catch((error) => setMessage({ text: String(error), isError: true }))}
                >
                    {english ? 'Open issues ↗' : 'Открытые темы ↗'}
                </button>
            </header>

            <div className="feedback-kind-grid" role="radiogroup" aria-label={english ? 'Report type' : 'Тип обращения'}>
                <button
                    type="button"
                    role="radio"
                    aria-checked={draft.kind === 'bug'}
                    className={`feedback-kind-card${draft.kind === 'bug' ? ' is-active' : ''}`}
                    onClick={() => update('kind', 'bug')}
                >
                    <span className="feedback-kind-icon" aria-hidden="true">
                        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M8 2l1.88 1.88" /><path d="M14.12 3.88L16 2" />
                            <path d="M9 7.13v-1a3.003 3.003 0 1 1 6 0v1" />
                            <path d="M12 20c-3.3 0-6-2.7-6-6v-3a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v3c0 3.3-2.7 6-6 6" />
                            <path d="M12 20v-9" /><path d="M6.53 9C4.6 8.8 3 7.1 3 5" />
                            <path d="M6 13H2" /><path d="M3 21c0-2.1 1.7-3.9 3.8-4" />
                            <path d="M20.97 5c0 2.1-1.6 3.8-3.5 4" /><path d="M22 13h-4" />
                            <path d="M17.2 17c2.1.1 3.8 1.9 3.8 4" />
                        </svg>
                    </span>
                    <span className="feedback-kind-copy">
                        <strong>{english ? 'Bug report' : 'Ошибка'}</strong>
                        <span>{english ? 'Something broke, froze, or behaves wrong' : 'Что-то сломалось, зависло или работает не так'}</span>
                    </span>
                </button>
                <button
                    type="button"
                    role="radio"
                    aria-checked={draft.kind === 'feature'}
                    className={`feedback-kind-card${draft.kind === 'feature' ? ' is-active' : ''}`}
                    onClick={() => update('kind', 'feature')}
                >
                    <span className="feedback-kind-icon" aria-hidden="true">
                        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M12 3l1.9 4.6L18.5 9.5l-4.6 1.9L12 16l-1.9-4.6L5.5 9.5l4.6-1.9L12 3z" />
                            <path d="M5 18l.9 2.1L8 21l-2.1.9L5 24l-.9-2.1L2 21l2.1-.9L5 18z" />
                        </svg>
                    </span>
                    <span className="feedback-kind-copy">
                        <strong>{english ? 'Feature request' : 'Новая функция'}</strong>
                        <span>{english ? 'Suggest an improvement or workflow idea' : 'Предложить улучшение или новую возможность'}</span>
                    </span>
                </button>
            </div>

            <label className="feedback-field">
                <span className="feedback-field-head">
                    <span>
                        {english ? 'Title' : 'Краткое название'}
                        <span className="feedback-required" aria-hidden="true">*</span>
                    </span>
                    <span className="feedback-counter">{draft.title.length} / 120</span>
                </span>
                <input
                    className="feedback-input"
                    value={draft.title}
                    maxLength={120}
                    onChange={(e) => update('title', e.target.value)}
                    placeholder={draft.kind === 'bug'
                        ? (english ? 'e.g. Lookup popup does not open on Shift+hover in EPUB' : 'Например: окно словаря не открывается по Shift в читалке')
                        : (english ? 'e.g. Add option to export highlighted quotes to Markdown' : 'Например: экспорт выделенных цитат в Markdown')}
                />
            </label>

            <label className="feedback-field">
                <span className="feedback-field-head">
                    <span>
                        {english ? 'Description' : 'Подробное описание'}
                        <span className="feedback-required" aria-hidden="true">*</span>
                    </span>
                    <span className="feedback-counter">{draft.description.length} / 8000</span>
                </span>
                <textarea
                    className="feedback-textarea"
                    rows={4}
                    maxLength={8000}
                    value={draft.description}
                    onChange={(e) => update('description', e.target.value)}
                    placeholder={draft.kind === 'bug'
                        ? (english ? 'Describe what happened and how often it occurs.' : 'Опишите, что произошло, на какой книге/игре/видео и как часто повторяется.')
                        : (english ? 'What would you like Setsuna to do, and why would it help?' : 'Что хотелось бы делать в Setsuna и чем это поможет в чтении?')}
                />
            </label>

            {draft.kind === 'bug' && (
                <div className="feedback-bug-grid">
                    <label className="feedback-field">
                        <span className="feedback-field-head">
                            <span>{english ? 'Steps to reproduce (optional)' : 'Как повторить (необязательно)'}</span>
                        </span>
                        <textarea
                            className="feedback-textarea"
                            rows={3}
                            maxLength={4000}
                            value={draft.steps}
                            onChange={(e) => update('steps', e.target.value)}
                            placeholder={english ? '1. Open ...\n2. Click ...' : '1. Открыл ...\n2. Нажал ...'}
                        />
                    </label>
                    <label className="feedback-field">
                        <span className="feedback-field-head">
                            <span>{english ? 'Expected behavior (optional)' : 'Ожидаемое поведение (необязательно)'}</span>
                        </span>
                        <textarea
                            className="feedback-textarea"
                            rows={3}
                            maxLength={2000}
                            value={draft.expected}
                            onChange={(e) => update('expected', e.target.value)}
                            placeholder={english ? 'What should have happened instead?' : 'Что должно было произойти вместо этого?'}
                        />
                    </label>
                </div>
            )}

            <div className={`feedback-env-bar${draft.includeEnvironment ? ' is-checked' : ''}`}>
                <label className="feedback-env-toggle">
                    <input
                        type="checkbox"
                        checked={draft.includeEnvironment}
                        onChange={(e) => update('includeEnvironment', e.target.checked)}
                    />
                    <span>{english ? 'Include app version & OS' : 'Добавить версию и систему в отчёт'}</span>
                </label>
                <div className="feedback-env-meta">
                    <span className="feedback-env-pill">Setsuna {version}</span>
                    <span className="feedback-env-pill">{platform}</span>
                    {!isMobilePlatform() && (
                        <button type="button" className="feedback-log-btn" onClick={() => void copyDiagnosticsLogPath()}>
                            {english ? 'Copy log path' : 'Путь к логу'}
                        </button>
                    )}
                </div>
            </div>

            <details className="feedback-preview">
                <summary>{english ? 'Preview formatted report' : 'Предпросмотр готового обращения'}</summary>
                <pre>{result.title}{'\n\n'}{result.body}</pre>
            </details>

            {message && (
                <p role="status" className={`feedback-status${message.isError ? ' is-error' : ''}`}>
                    {message.text}
                </p>
            )}

            <div className="feedback-actions">
                <button
                    type="button"
                    className="btn-primary"
                    onClick={() => void continueOnGitHub()}
                    disabled={busy || !canSubmit}
                >
                    {result.copyRequired
                        ? (english ? 'Copy text & open GitHub ↗' : 'Скопировать и открыть GitHub ↗')
                        : (english ? 'Continue on GitHub ↗' : 'Продолжить на GitHub ↗')}
                </button>
                <button
                    type="button"
                    className="btn-secondary"
                    onClick={() => void copyReport()}
                    disabled={!canSubmit}
                >
                    {english ? 'Copy text' : 'Скопировать текст'}
                </button>
                {hasDraftContent && (
                    <button type="button" className="feedback-clear-btn" onClick={clearDraft}>
                        {english ? 'Clear draft' : 'Очистить черновик'}
                    </button>
                )}
            </div>
        </section>
    );
}
