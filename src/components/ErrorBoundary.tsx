import { Component, type ReactNode } from 'react';

type Props = { children: ReactNode; language?: 'ru' | 'en' };
type State = { hasError: boolean; manual: boolean };

// A transient render error gets one clean remount. Repeated failures stop on a
// visible recovery screen so the WebView never degrades into a blank page.
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
        this.recentErrors = this.recentErrors.filter((time) => now - time < 4000);
        this.recentErrors.push(now);

        if (this.recentErrors.length > 4) {
            this.setState({ manual: true });
            return;
        }
        if (this.resetTimer) clearTimeout(this.resetTimer);
        this.resetTimer = setTimeout(() => this.setState({ hasError: false }), 80);
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
        if (!this.state.hasError) return this.props.children;

        const en = this.props.language === 'en';
        const manual = this.state.manual;
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
                    background: 'var(--bg-main, #151719)',
                    color: 'var(--text-main, #d8dadd)',
                    fontFamily: 'system-ui, sans-serif',
                    textAlign: 'center',
                }}
            >
                <div style={{ fontSize: 18, fontWeight: 700 }}>
                    {manual
                        ? (en ? 'The screen hit a rendering error' : 'Ошибка отображения')
                        : (en ? 'Restoring the interface...' : 'Восстанавливаю интерфейс...')}
                </div>
                {manual && (
                    <>
                        <div style={{ opacity: 0.7, fontSize: 14, maxWidth: 360 }}>
                            {en
                                ? 'Your tabs and settings are saved. Reload to continue.'
                                : 'Вкладки и настройки сохранены. Перезапустите интерфейс, чтобы продолжить.'}
                        </div>
                        <button
                            type="button"
                            onClick={this.hardReload}
                            style={{
                                padding: '12px 22px',
                                borderRadius: 8,
                                border: 0,
                                background: 'var(--accent-blue, #4fa6ff)',
                                color: '#fff',
                                fontSize: 15,
                                fontWeight: 700,
                            }}
                        >
                            {en ? 'Reload' : 'Перезапустить'}
                        </button>
                    </>
                )}
            </div>
        );
    }
}
