import { createRoot } from 'react-dom/client';
import PlayerWorkspace from '../src/features/player/PlayerWorkspace';
import { recordSceneClip } from '../src/features/player/mobileClip';
import { DEFAULT_SETTINGS, themes } from '../src/utils/constants';
import '../src/index.css';
import '../src/App.css';

// Phone player check: open with the "mobile" viewport preset (Android UA).
// window.pickSample() feeds the hidden picker a video + its subtitle file, like the
// Android file chooser does; window.recordSample() records a scene clip.
// Fixtures (not committed), from the repo root:
//   ffmpeg -f lavfi -i testsrc=size=640x360:rate=24 -f lavfi -i sine=frequency=440 -t 20 -c:v libvpx -c:a libopus \
//     "tests/fixtures/tmp-player/[Group] Sample Show - 03 [1080p].webm"
//   plus "[Group] Sample Show - 03 [1080p].ja.srt" with a few cues.
Object.entries(themes.dark).forEach(([key, value]) => document.documentElement.style.setProperty(key, String(value)));

const base = '/tests/fixtures/tmp-player/';
const names = ['[Group] Sample Show - 03 [1080p].webm', '[Group] Sample Show - 03 [1080p].ja.srt'];

async function sampleFiles() {
    return Promise.all(names.map(async (name) => {
        const blob = await (await fetch(base + encodeURIComponent(name))).blob();
        return new File([blob], name, { type: name.endsWith('.webm') ? 'video/webm' : 'application/x-subrip', lastModified: 1 });
    }));
}

Object.assign(window, {
    pickSample: async () => {
        const input = document.querySelector<HTMLInputElement>('.sp-workspace input[type=file][multiple]');
        if (!input) return 'no input';
        const dt = new DataTransfer();
        (await sampleFiles()).forEach((f) => dt.items.add(f));
        input.files = dt.files;
        input.dispatchEvent(new Event('change', { bubbles: true }));
        return 'picked';
    },
    recordSample: async () => {
        const [video] = await sampleFiles();
        const url = URL.createObjectURL(video);
        const started = performance.now();
        const clip = await recordSceneClip(url, 1.5, 5, { withVideo: true, quality: 'compact' });
        return { mime: clip.mime, ext: clip.extension, type: clip.mediaType, kb: Math.round(clip.base64.length * 0.75 / 1024), ms: Math.round(performance.now() - started) };
    },
});

createRoot(document.getElementById('root')!).render(
    <div style={{ height: '100vh', display: 'flex', background: 'var(--bg-main)', color: 'var(--text-main)' }}>
        <PlayerWorkspace
            settings={{ ...DEFAULT_SETTINGS, ankiDeck: 'Mining', ankiModel: 'Lapis' } as never}
            language="ru"
            shortcutsBlocked={false}
            onHome={() => {}}
            onSettings={() => {}}
            onDeckChange={() => {}}
        />
    </div>,
);
