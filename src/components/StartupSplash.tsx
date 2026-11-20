import "./StartupSplash.css";

interface StartupSplashProps {
    leaving?: boolean;
}

const WORDMARK = "SETSUNA".split("");

/**
 * 刹那 means "an instant". The splash plays one: the tile springs in, a light
 * slash cuts across it, the two halves of 刹 snap together along the cut and a
 * shockwave rings out. On exit the screen irises closed onto the logo,
 * revealing the app underneath.
 */
export default function StartupSplash({ leaving = false }: StartupSplashProps) {
    return (
        <div className={`startup-splash${leaving ? " is-leaving" : ""}`} aria-label="Setsuna" role="status">
            <div className="startup-glow" aria-hidden="true" />
            <div className="startup-splash-content">
                <div className="startup-logo-wrap" aria-hidden="true">
                    <span className="startup-shockwave" />
                    <div className="startup-logo">
                        <img className="startup-logo-half startup-logo-half-a" src="/setsuna-logo.png" alt="" draggable={false} />
                        <img className="startup-logo-half startup-logo-half-b" src="/setsuna-logo.png" alt="" draggable={false} />
                        <span className="startup-slash" />
                    </div>
                </div>
                <div className="startup-wordmark" aria-hidden="true">
                    {WORDMARK.map((letter, index) => (
                        <span key={index} style={{ ["--i" as any]: index }}>{letter}</span>
                    ))}
                </div>
                <div className="startup-caption" aria-hidden="true">刹那</div>
                <div className="startup-progress" aria-hidden="true"><span /></div>
            </div>
        </div>
    );
}
