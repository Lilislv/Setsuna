import { useEffect, useMemo, useRef, useState } from "react";
import { getDecks } from "../utils/anki";
import "./DeckPicker.css";

// Binds an Anki deck to one reading tab (like the screenshot process binding).
// Cards added from that tab go to its deck; "As in settings" clears the binding.

interface DeckPickerProps {
    open: boolean;
    tabName: string;
    current: string | null | undefined;
    defaultDeck: string;
    en: boolean;
    onPick: (deck: string | null) => void;
    onClose: () => void;
    /** Where the deck list comes from (AnkiConnect / AnkiDroid by default). */
    loadDecks?: () => Promise<string[]>;
}

export default function DeckPicker({ open, tabName, current, defaultDeck, en, onPick, onClose, loadDecks = () => getDecks(true) }: DeckPickerProps) {
    const [decks, setDecks] = useState<string[] | null>(null);
    const [error, setError] = useState(false);
    const [query, setQuery] = useState("");
    const searchRef = useRef<HTMLInputElement>(null);
    // Callers pass inline callbacks, and the reader re-renders every second while its
    // timer runs. Depending on them reset the list to "Loading…" and cleared the search
    // each tick, so the row under the cursor changed between press and release and a
    // neighbouring deck was bound to the tab.
    const onCloseRef = useRef(onClose);
    const loadDecksRef = useRef(loadDecks);
    onCloseRef.current = onClose;
    loadDecksRef.current = loadDecks;

    useEffect(() => {
        if (!open) return;
        setQuery("");
        setError(false);
        setDecks(null);
        let alive = true;
        loadDecksRef.current()
            .then((list) => { if (alive) setDecks(Array.isArray(list) ? list : []); })
            .catch(() => { if (alive) { setError(true); setDecks([]); } });
        requestAnimationFrame(() => searchRef.current?.focus());
        const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onCloseRef.current(); };
        window.addEventListener("keydown", onKey);
        return () => {
            alive = false;
            window.removeEventListener("keydown", onKey);
        };
    }, [open]);

    const filtered = useMemo(() => {
        const q = query.trim().toLowerCase();
        return (decks || []).filter((deck) => !q || deck.toLowerCase().includes(q));
    }, [decks, query]);

    if (!open) return null;

    const Check = ({ on }: { on: boolean }) => (
        <span className={`deck-picker-check${on ? " is-on" : ""}`} aria-hidden="true">
            {on && <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12.5 10 17 19 7" /></svg>}
        </span>
    );

    return (
        <div className="deck-picker-backdrop" onClick={onClose}>
            <div className="deck-picker" role="dialog" aria-label={en ? "Anki deck for this tab" : "Колода Anki для вкладки"} onClick={(e) => e.stopPropagation()}>
                <header className="deck-picker-head">
                    <div>
                        <div className="deck-picker-title">{en ? "Anki deck" : "Колода Anki"}</div>
                        <div className="deck-picker-sub">
                            {en ? `Cards from “${tabName}” go here` : `Сюда пойдут карточки из «${tabName}»`}
                        </div>
                    </div>
                    <button type="button" className="deck-picker-close" onClick={onClose} aria-label={en ? "Close" : "Закрыть"}>
                        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M18 6 6 18" /><path d="m6 6 12 12" /></svg>
                    </button>
                </header>

                <input
                    ref={searchRef}
                    className="deck-picker-search"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    onKeyDown={(e) => {
                        e.stopPropagation();
                        if (e.key === "Enter" && filtered.length === 1) onPick(filtered[0]);
                        if (e.key === "Escape") onClose();
                    }}
                    placeholder={en ? "Find a deck…" : "Найти колоду…"}
                />

                <div className="deck-picker-list">
                    {!query && (
                        <button type="button" className={`deck-picker-item is-default${!current ? " is-current" : ""}`} onClick={() => onPick(null)}>
                            <Check on={!current} />
                            <span className="deck-picker-name">{en ? "As in settings" : "Как в настройках"}</span>
                            <span className="deck-picker-meta">{defaultDeck || (en ? "not set" : "не выбрана")}</span>
                        </button>
                    )}
                    {decks === null ? (
                        <div className="deck-picker-empty">{en ? "Loading decks…" : "Загружаю колоды…"}</div>
                    ) : error ? (
                        <div className="deck-picker-empty">{en ? "Anki isn't answering. Start Anki with AnkiConnect and try again." : "Anki не отвечает. Запусти Anki с AnkiConnect и попробуй ещё раз."}</div>
                    ) : filtered.length === 0 ? (
                        <div className="deck-picker-empty">{en ? "No such deck" : "Такой колоды нет"}</div>
                    ) : (
                        filtered.map((deck) => {
                            const parts = deck.split("::");
                            const leaf = parts.pop() || deck;
                            return (
                                <button type="button" key={deck} className={`deck-picker-item${current === deck ? " is-current" : ""}`} onClick={() => onPick(deck)} title={deck}>
                                    <Check on={current === deck} />
                                    <span className="deck-picker-name">{leaf}</span>
                                    {parts.length > 0 && <span className="deck-picker-meta">{parts.join(" › ")}</span>}
                                </button>
                            );
                        })
                    )}
                </div>
            </div>
        </div>
    );
}
