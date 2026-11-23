import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import DeckPicker from '../src/components/DeckPicker';
import { themes } from '../src/utils/constants';
import '../src/index.css';
import '../src/App.css';

// Browser check for the per-tab Anki deck picker.
Object.entries(themes.dark).forEach(([key, value]) => document.documentElement.style.setProperty(key, String(value)));
const decks = ['Default', 'Mining', 'Mining::Dies Irae', 'Mining::Yakuza 0', 'Kaishi 1.5k', 'Setsuna'];

function Harness() {
    const [deck, setDeck] = useState<string | null>(null);
    const [open, setOpen] = useState(true);
    return (
        <div style={{ height: '100vh', background: 'var(--bg-main)', color: 'var(--text-main)', padding: 20 }}>
            <button id="open" onClick={() => setOpen(true)}>open</button> <span id="deck">{deck || '(settings)'}</span>
            <DeckPicker open={open} tabName="Dies Irae" current={deck} defaultDeck="Mining" en={false}
                onPick={(d) => { setDeck(d); setOpen(false); }} onClose={() => setOpen(false)}
                loadDecks={() => new Promise((r) => setTimeout(() => r(decks), 200))} />
        </div>
    );
}
createRoot(document.getElementById('root')!).render(<Harness />);
