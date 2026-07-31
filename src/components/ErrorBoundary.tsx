import { Component, type ReactNode } from 'react';

type Props = { children: ReactNode; language?: 'ru' | 'en' };
type State = { hasError: boolean; manual: boolean };

// Catches render/commit errors (e.g. transient virtualizer/reconciliation glitches while
// furigana resolves) so a single throw never leaves the whole app on a dead grey screen.
// Transient errors self-heal; rapid repeats fall back to a manual recovery screen.
export default class ErrorBoundary extends Component<Props, State> {
    state: State = { hasError: false, manual: false };
    private recentErrors: number[] = [];
    private resetTimer: ReturnType<typeof setTimeout> | null = null;

    static getDerivedStateFromError(): Partial<State> {
        return { hasError: true };
    }

    componentDidCatch(error: unknown) {
        console.error('Setsuna error boundary caught:', error);
        const now = Date.now();
        this.recentErrors = this.recentErrors.filter((t) => now - t < 4000);
        this.recentErrors.push(now);

        // Too many crashes in a short window -> stop auto-healing, ask the user.
        if (this.recentErrors.length > 4) {
            this.setState({ manual: true });
            return;
        }
        if (this.resetTimer) clearTimeout(this.resetTimer);
        this.resetTimer = setTimeout(() => this.setState({ hasError: false }), 60);
    }

    componentWillUnmount() {
        if (this.resetTimer) clearTimeout(this.resetTimer);
    }

    private hardReload = () => {
        try {
            window.location.reload();
        } catch {
            this.recentErrors = [];
            this.setState({ hasError: false, manual: false });
        }
    };

    render() {
        if (this.state.hasError && this.state.manual) {
            const en = this.props.language === 'en';
            return (
                <div
                    style={{
                        position: 'fixed',
                        inset: 0,
                        display: 'flex',
                        flexDirection: 'column',
                        alignItems: 'center',
                        justifyContent: 'center',
                        gap: 16,
                        padding: 24,
                        background: 'var(--bg-main, #101014)',
                        color: 'var(--text-main, #fff)',
                        fontFamily: 'system-ui, sans-serif',
                        textAlign: 'center',
                    }}
                >
                    <div style={{ fontSize: 18, fontWeight: 700 }}>
                        {en ? 'The screen hit a rendering error' : 'Экран поймал ошибку отрисовки'}
                    </div>
                    <div style={{ opacity: 0.7, fontSize: 14, maxWidth: 320 }}>
                        {en
                            ? 'Your tabs and settings are saved. Reload to continue.'
                            : 'Вкладки и настройки сохранены. Перезагрузи, чтобы продолжить.'}
                    </div>
                    <button
                        type="button"
                        onClick={this.hardReload}
                        style={{
                            padding: '12px 22px',
                            borderRadius: 10,
                            border: 0,
                            background: 'var(--accent-blue, #4fa6ff)',
                            color: '#fff',
                            fontSize: 15,
                            fontWeight: 700,
                        }}
                    >
                        {en ? 'Reload' : 'Перезагрузить'}
                    </button>
                </div>
            );
        }

        // While self-healing, render nothing for one tick, then children remount cleanly.
        if (this.state.hasError) return null;
        return this.props.children;
    }
}
