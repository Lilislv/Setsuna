import { useEffect, useState } from 'react';

/**
 * Keeps a layer mounted for `exitMs` after `open` turns false so it can play
 * its closing animation. Returns whether to render it and whether it is
 * currently closing.
 */
export function usePresence(open: boolean, exitMs = 220) {
    const [mounted, setMounted] = useState(open);
    const [closing, setClosing] = useState(false);
    useEffect(() => {
        if (open) {
            setMounted(true);
            setClosing(false);
            return;
        }
        if (!mounted) return;
        setClosing(true);
        const timer = window.setTimeout(() => {
            setMounted(false);
            setClosing(false);
        }, exitMs);
        return () => window.clearTimeout(timer);
    }, [open]);
    return { mounted: open || mounted, closing: !open && closing };
}
