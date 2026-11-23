import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ImportProgressModal } from '../src/components/AppModals';
import { themes } from '../src/utils/constants';
import '../src/index.css';
import '../src/App.css';

// Visual check for the import progress pill with a 19-dictionary batch.
Object.entries(themes.dark).forEach(([key, value]) => document.documentElement.style.setProperty(key, String(value)));

function Harness() {
    const [step, setStep] = useState(0);
    useEffect(() => {
        const timer = window.setInterval(() => setStep((n) => (n + 1) % 200), 120);
        return () => window.clearInterval(timer);
    }, []);
    const index = 6 + Math.floor(step / 100);
    const progress = {
        dict_name: index === 6 ? 'wty-en-en' : 'Leipzig English Web',
        total_dicts: 19, dict_index: index, dict_count: 19,
        current_file: 12, total_files: 67, words_added: 412345 + step * 900,
        percent: step % 100, status: 'Reading dictionary archive...',
    };
    return <div style={{ height: '100vh', background: 'var(--bg-main)', color: 'var(--text-main)', padding: 30, fontSize: 24 }}>
        「おまえ、ちょっと今日おかしいぞ。何かあったか？」
        <ImportProgressModal dictProgress={progress} language="ru" />
    </div>;
}
createRoot(document.getElementById('root')!).render(<Harness />);
