import type { ReactNode } from "react";
import Lookuper, { type LookuperProps } from "../../components/Lookuper";

export type LookupSurfaceMode = "internal" | "external";

export interface LookupSurfaceProps extends LookuperProps {
    mode: LookupSurfaceMode;
    controls?: ReactNode;
}

export default function LookupSurface({ mode, controls, ...lookuperProps }: LookupSurfaceProps) {
    return (
        <section
            className={`lookup-surface lookup-surface-${mode}`}
            data-lookup-mode={mode}
            style={mode === "external" ? {
                position: "fixed",
                inset: 0,
                overflow: "hidden",
                background: "transparent",
            } : undefined}
        >
            {controls}
            <Lookuper {...lookuperProps} />
        </section>
    );
}
