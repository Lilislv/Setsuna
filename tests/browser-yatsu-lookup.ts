import { DEFAULT_SETTINGS } from '../src/utils/constants';

// Isolated-origin fixture: exercises the actual local companion and slow IPC.
localStorage.setItem('txthk-settings', JSON.stringify({ ...DEFAULT_SETTINGS, ankiEnabled: false,
    dictionaries: [{ name: 'Fixture', active: true }, { name: 'Disabled', active: false }] }));
const callbacks = new Map<number, (event: any) => void>();
let next = 1, scanListener = 0;
const highlights: any[] = [];
const shown: any[] = [];
(window as any).__yatsuFixture = {
    highlights, shown,
    send: (revision: number, sentence: string, cursor = 0) => callbacks.get(scanListener)?.({ payload: { revision, sentence, cursor } }),
};
(window as any).__TAURI_INTERNALS__ = {
    transformCallback: (callback: (event: any) => void) => { const id = next++; callbacks.set(id, callback); return id; },
    unregisterCallback: (id: number) => callbacks.delete(id),
    invoke: async (command: string, args: any) => {
        if (command === 'plugin:event|listen') { if (args.event === 'yatsu-scan') scanListener = args.handler; return 1; }
        if (command === 'get_yatsu_request') return { revision: 0, sentence: '', cursor: 0 };
        if (command === 'highlight_yatsu_match') { highlights.push(args); return; }
        if (command === 'show_yatsu_lookup') { shown.push(args); return true; }
        if (command === 'scan_cursor') {
            await new Promise(resolve => setTimeout(resolve, args.sentence === '猫' ? 180 : 20));
            return { word: args.sentence, match_start: 0, match_len: 1, entries: [
                { term: args.sentence, reading: '', definition: JSON.stringify(['Definition: ' + args.sentence]), dict_name: args.sentence === '無' ? 'Disabled' : 'Fixture',
                    tags: '', source_length: 1, frequencies: [], pitches: [], pronunciations: [], deinflection_reasons: [] },
            ] };
        }
        if (command === 'lookup_word') return [];
        return null;
    },
};
void import('../src/yatsu-lookup');
