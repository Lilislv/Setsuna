import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { createLatestTaskQueue } from '../utils/runtimeMemory';
import './YatsuWorkspace.css';

type Bounds = { x: number; y: number; width: number; height: number };
type Layout = { reader: Bounds; language: string } | null;
// Shared across mounts: a late resize/open must never cover the home screen.
const layouts = createLatestTaskQueue<{ layout: Layout; onError?: (error: unknown) => void }>(async request => {
    try { await invoke('set_yatsu_workspace', { layout: request.layout }); }
    catch (error) { request.onError?.(error); }
});

export function hideYatsuWorkspace() { return layouts.push({ layout: null }); }

export default function YatsuWorkspace({ language, onHome }: { language: string; onHome: () => void }) {
    const readerRef = useRef<HTMLDivElement>(null);
    const onHomeRef = useRef(onHome); onHomeRef.current = onHome;
    const [error, setError] = useState('');
    useEffect(() => {
        let disposed = false, frame = 0;
        let unlisten: (() => void) | undefined;
        const update = () => {
            cancelAnimationFrame(frame);
            frame = requestAnimationFrame(() => {
                if (disposed || !readerRef.current) return;
                const rect = readerRef.current.getBoundingClientRect();
                if (rect.width < 1 || rect.height < 1) return;
                void layouts.push({
                    layout: { reader: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }, language },
                    onError: value => { if (!disposed) { setError(String(value)); void hideYatsuWorkspace(); } },
                });
            });
        };
        const observer = new ResizeObserver(update);
        if (readerRef.current) observer.observe(readerRef.current);
        window.addEventListener('resize', update);
        void listen('yatsu-home', () => { if (!disposed) onHomeRef.current(); }).then(stop => {
            if (disposed) stop(); else { unlisten = stop; update(); }
        }).catch(value => { if (!disposed) setError(String(value)); });
        return () => {
            disposed = true; unlisten?.(); observer.disconnect(); cancelAnimationFrame(frame);
            window.removeEventListener('resize', update); void hideYatsuWorkspace();
        };
    }, [language]);
    return <section className="yatsu-workspace">
        {error ? <div className="yatsu-workspace-error" role="alert"><p>{error}</p><button onClick={() => onHomeRef.current()}>{language === 'en' ? 'Home' : 'На главный экран'}</button></div>
            : <div ref={readerRef} className="yatsu-workspace-reader" />}
    </section>;
}
