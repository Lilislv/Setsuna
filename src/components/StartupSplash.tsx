import "./StartupSplash.css";

interface StartupSplashProps {
    leaving?: boolean;
}

export default function StartupSplash({ leaving = false }: StartupSplashProps) {
    return (
        <div className={`startup-splash${leaving ? " is-leaving" : ""}`} aria-label="Setsuna" role="status">
            <div className="startup-splash-content">
                <div className="startup-logo" aria-hidden="true">
                    <img className="startup-logo-shadow" src="/setsuna-logo.png" alt="" />
                    <img className="startup-logo-part startup-logo-part-top" src="/setsuna-logo.png" alt="" />
                    <img className="startup-logo-part startup-logo-part-bottom" src="/setsuna-logo.png" alt="" />
                    <span className="startup-logo-scan" />
                </div>
                <div className="startup-wordmark">Setsuna</div>
                <div className="startup-loading-line" aria-hidden="true"><span /></div>
            </div>
        </div>
    );
}
