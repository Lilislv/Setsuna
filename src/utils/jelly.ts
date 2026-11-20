import { useEffect, useRef } from 'react';

/**
 * "Jelly" deformation for dragged UI. While an element is held it lifts a
 * little; pointer velocity stretches it along the direction of travel and
 * shears it so the trailing edge lags; on release underdamped springs let it
 * wobble back to rest. The result is written to `--jelly-transform`, which the
 * element applies via `transform` (see `.jelly-target` in styles/motion.css).
 */

const STIFFNESS = 520;
const DAMPING = 17;
const TARGET_DECAY_MS = 90;
const MAX_STRETCH = 0.16;
const MAX_SKEW = 8;
const LIFT = 0.04;
const STRETCH_PER_SPEED = 0.11;
const REST = 0.0004;

type Spring = { value: number; velocity: number; target: number };

const spring = (): Spring => ({ value: 0, velocity: 0, target: 0 });

const step = (s: Spring, dt: number) => {
    const force = STIFFNESS * (s.target - s.value) - DAMPING * s.velocity;
    s.velocity += force * dt;
    s.value += s.velocity * dt;
};

const atRest = (s: Spring) => Math.abs(s.value - s.target) < REST && Math.abs(s.velocity) < REST * 20;

export const prefersReducedMotion = () =>
    typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

export interface Jelly {
    grab: () => void;
    push: (vx: number, vy: number) => void;
    release: () => void;
}

export function createJelly(element: HTMLElement): Jelly {
    const stretchX = spring();
    const stretchY = spring();
    const skew = spring();
    const lift = spring();
    const springs = [stretchX, stretchY, skew, lift];
    let held = false;
    let frame = 0;
    let lastTime = 0;

    const render = () => {
        const sx = stretchX.value;
        const sy = stretchY.value;
        const amount = Math.min(MAX_STRETCH, Math.hypot(sx, sy));
        const angle = Math.atan2(sy, sx);
        const scale = 1 + lift.value;
        element.style.setProperty(
            '--jelly-transform',
            `scale(${scale.toFixed(4)}) rotate(${angle.toFixed(4)}rad) scale(${(1 + amount).toFixed(4)}, ${(1 - amount * 0.55).toFixed(4)}) rotate(${(-angle).toFixed(4)}rad) skewX(${skew.value.toFixed(3)}deg)`,
        );
    };

    const tick = (now: number) => {
        const dt = Math.min(0.032, Math.max(0.001, (now - (lastTime || now - 16)) / 1000));
        lastTime = now;
        const decay = Math.exp(-(dt * 1000) / TARGET_DECAY_MS);
        stretchX.target *= decay;
        stretchY.target *= decay;
        skew.target *= decay;
        lift.target = held ? LIFT : 0;
        for (const s of springs) step(s, dt);
        render();
        if (!held && springs.every(atRest)) {
            frame = 0;
            lastTime = 0;
            element.style.removeProperty('--jelly-transform');
            return;
        }
        frame = requestAnimationFrame(tick);
    };

    const wake = () => {
        if (!frame) frame = requestAnimationFrame(tick);
    };

    return {
        grab() {
            held = true;
            // A small kick so picking something up visibly "pops".
            lift.velocity += 1.6;
            wake();
        },
        push(vx, vy) {
            // vx/vy are px per ms; ~1.5 px/ms is a brisk drag.
            const clamp = (value: number, max: number) => Math.max(-max, Math.min(max, value));
            stretchX.target = clamp(vx * STRETCH_PER_SPEED, MAX_STRETCH);
            stretchY.target = clamp(vy * STRETCH_PER_SPEED, MAX_STRETCH);
            skew.target = clamp(-vx * 4.5, MAX_SKEW);
            wake();
        },
        release() {
            held = false;
            stretchX.target = 0;
            stretchY.target = 0;
            skew.target = 0;
            wake();
        },
    };
}

/**
 * Applies jelly physics to the element returned by `getElement` while
 * `active` is true, reading pointer velocity from window pointer events.
 */
export function useJelly(getElement: () => HTMLElement | null, active: boolean, options: { axis?: 'x' | 'y' | 'both' } = {}) {
    const axis = options.axis || 'both';
    const getterRef = useRef(getElement);
    getterRef.current = getElement;

    useEffect(() => {
        if (!active || prefersReducedMotion()) return;
        const element = getterRef.current();
        if (!element) return;
        const jelly = createJelly(element);
        jelly.grab();
        let last: { x: number; y: number; t: number } | null = null;
        const onMove = (event: PointerEvent) => {
            const now = performance.now();
            if (last) {
                const dt = Math.max(8, now - last.t);
                const vx = axis === 'y' ? 0 : (event.clientX - last.x) / dt;
                const vy = axis === 'x' ? 0 : (event.clientY - last.y) / dt;
                jelly.push(vx, vy);
            }
            last = { x: event.clientX, y: event.clientY, t: now };
        };
        window.addEventListener('pointermove', onMove, { passive: true });
        return () => {
            window.removeEventListener('pointermove', onMove);
            jelly.release();
        };
    }, [active, axis]);
}
