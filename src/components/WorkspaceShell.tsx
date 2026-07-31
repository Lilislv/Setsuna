import type { ReactNode } from "react";
import { IconHome, IconSettings } from "./Icons";
import "./WorkspaceShell.css";

type WorkspaceShellProps = {
    title: string;
    icon: ReactNode;
    accent: "reader" | "player";
    onHome: () => void;
    onSettings: () => void;
    children: ReactNode;
};

export default function WorkspaceShell({ title, icon, accent, onHome, onSettings, children }: WorkspaceShellProps) {
    return (
        <section className={`workspace-shell workspace-shell-${accent}`}>
            <header className="workspace-shell-header">
                <button type="button" className="workspace-shell-button" onClick={onHome} title="Setsuna Hub" aria-label="Setsuna Hub">
                    <IconHome />
                </button>
                <div className="workspace-shell-title">
                    <span className="workspace-shell-mode-icon" aria-hidden="true">{icon}</span>
                    <strong>{title}</strong>
                </div>
                <button type="button" className="workspace-shell-button" onClick={onSettings} title="Настройки" aria-label="Открыть настройки">
                    <IconSettings />
                </button>
            </header>
            <div className="workspace-shell-content">{children}</div>
        </section>
    );
}
