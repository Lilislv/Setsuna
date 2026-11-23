import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type PointerEvent as ReactPointerEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
    AI_DEFAULT_MODEL,
    AI_MEMORY_SYSTEM,
    aiExplainPrompt,
    aiMemoryExtractPrompt,
    aiMemoryPrompt,
    aiSystemPrompt,
    parseAiMemoryItems,
    readAiPromptSettings,
    type AiExplainRequest,
    type AiMemoryItem,
} from "../utils/aiAssistant";
import { IconSparkle } from "./Icons";
import "./AiPanel.css";

// The AI panel docked to the right of the reader.
//
// Every reading tab has its own chat; there is also one general chat for any
// language question. A tab chat is a list of "blocks": an explained line (or
// several) with its answer and the follow-up questions about it. The chat is
// shown as one continuous scrollable conversation, and the "Lines" menu jumps
// to any explained line. History lives in ai/history.json (app data).

const THINK_KEY = "setsuna-ai-think";
const WIDTH_KEY = "setsuna-ai-panel-width";
const MIN_WIDTH = 340;
const MAX_WIDTH = 760;
const GENERAL_KEY = "general";
/** The general chat sends this many recent messages as context. */
const GENERAL_CONTEXT = 12;
const AUTO_MEMORY_KEY = "setsuna-ai-auto-memory";
/** How many explained lines one "find names" request looks at. */
const MEMORY_SCAN_BLOCKS = 12;

type ChatMessage = {
    role: "user" | "assistant";
    content: string;
    lines?: string[];
    think?: boolean;
    error?: string;
    reasoningChars?: number;
    tokensPerSecond?: number;
    cancelled?: boolean;
};

type Block = {
    id: string;
    createdAt: number;
    lines?: string[];
    messages: ChatMessage[];
    /** Names and terms were already looked for in this block. */
    scanned?: boolean;
    /** Terms the memory picked up from this block (shown under the answer). */
    remembered?: string[];
};

type Chat = {
    key: string;
    title: string;
    tabId: number | string | null;
    updatedAt: number;
    blocks: Block[];
    /** Names, places and terms of this work; sent with every request in this tab. */
    memory?: AiMemoryItem[];
};

type History = { version: 2; chats: Chat[] };

type Phase = "loading" | "thinking" | "writing";

type Running = { requestId: string; chatKey: string; blockId: string; index: number; phase: Phase };

export type AiPanelRequest = { id: number; request: AiExplainRequest };

const newId = () => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`);
const tabKey = (tabId: number | string | null) => `tab:${tabId ?? "none"}`;

const readWidth = () => {
    try {
        const value = Number(localStorage.getItem(WIDTH_KEY));
        if (Number.isFinite(value) && value >= MIN_WIDTH) return Math.min(MAX_WIDTH, value);
    } catch { /* ignore */ }
    return 440;
};

/** History from the first test build stored loose threads; group them into tab chats. */
const migrateHistory = (data: any): History => {
    if (data?.version === 2 && Array.isArray(data.chats)) return { version: 2, chats: data.chats };
    const chats = new Map<string, Chat>();
    const threads = Array.isArray(data?.threads) ? [...data.threads].reverse() : [];
    for (const thread of threads) {
        const key = tabKey(thread.tabId ?? null);
        const chat: Chat = chats.get(key) ?? { key, title: thread.tabName || "", tabId: thread.tabId ?? null, updatedAt: 0, blocks: [] };
        chat.blocks.push({ id: thread.id || newId(), createdAt: thread.createdAt || Date.now(), lines: thread.messages?.[0]?.lines, messages: thread.messages || [] });
        chat.updatedAt = Math.max(chat.updatedAt, thread.createdAt || 0);
        chats.set(key, chat);
    }
    return { version: 2, chats: [...chats.values()] };
};

// ---------------------------------------------------------------------------
// Minimal, safe Markdown (bold, italic, code, headings, lists). No HTML.
// ---------------------------------------------------------------------------

const renderInline = (text: string, keyBase: string): ReactNode[] => {
    const out: ReactNode[] = [];
    const pattern = /(\*\*[^*]+\*\*|`[^`]+`|\*[^*\s][^*]*\*)/g;
    let last = 0;
    let match: RegExpExecArray | null;
    let n = 0;
    while ((match = pattern.exec(text))) {
        if (match.index > last) out.push(text.slice(last, match.index));
        const token = match[0];
        const key = `${keyBase}-${n++}`;
        if (token.startsWith("**")) out.push(<strong key={key}>{token.slice(2, -2)}</strong>);
        else if (token.startsWith("`")) out.push(<code key={key}>{token.slice(1, -1)}</code>);
        else out.push(<em key={key}>{token.slice(1, -1)}</em>);
        last = match.index + token.length;
    }
    if (last < text.length) out.push(text.slice(last));
    return out;
};

const Markdown = ({ text }: { text: string }) => {
    const blocks: ReactNode[] = [];
    const lines = text.replace(/\r/g, "").split("\n");
    let list: { ordered: boolean; items: string[] } | null = null;
    let paragraph: string[] = [];
    const flushParagraph = () => {
        if (!paragraph.length) return;
        const key = `p${blocks.length}`;
        blocks.push(<p key={key}>{paragraph.flatMap((line, i) => (i ? [<br key={`${key}-br${i}`} />, ...renderInline(line, `${key}-${i}`)] : renderInline(line, `${key}-${i}`)))}</p>);
        paragraph = [];
    };
    const flushList = () => {
        if (!list) return;
        const key = `l${blocks.length}`;
        const items = list.items.map((item, i) => <li key={`${key}-${i}`}>{renderInline(item, `${key}-${i}`)}</li>);
        blocks.push(list.ordered ? <ol key={key}>{items}</ol> : <ul key={key}>{items}</ul>);
        list = null;
    };
    for (const raw of lines) {
        const line = raw.trimEnd();
        const bullet = /^\s*[-*•]\s+(.*)$/.exec(line);
        const ordered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
        const heading = /^\s*#{1,6}\s+(.*)$/.exec(line);
        if (!line.trim()) {
            flushParagraph();
            flushList();
        } else if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) {
            flushParagraph();
            flushList();
            blocks.push(<hr key={`hr${blocks.length}`} />);
        } else if (heading) {
            flushParagraph();
            flushList();
            blocks.push(<h4 key={`h${blocks.length}`}>{renderInline(heading[1], `h${blocks.length}`)}</h4>);
        } else if (bullet || ordered) {
            flushParagraph();
            const isOrdered = !bullet;
            if (!list || list.ordered !== isOrdered) {
                flushList();
                list = { ordered: isOrdered, items: [] };
            }
            list.items.push((bullet || ordered)![1]);
        } else {
            flushList();
            paragraph.push(line);
        }
    }
    flushParagraph();
    flushList();
    return <div className="aip-md">{blocks}</div>;
};

const formatWhen = (ms: number, en: boolean) => {
    const date = new Date(ms);
    const sameDay = date.toDateString() === new Date().toDateString();
    const time = date.toLocaleTimeString(en ? "en-GB" : "ru-RU", { hour: "2-digit", minute: "2-digit" });
    if (sameDay) return time;
    return `${date.toLocaleDateString(en ? "en-GB" : "ru-RU", { day: "numeric", month: "short" })}, ${time}`;
};

const snippet = (text: string, max = 46) => (text.length > max ? `${text.slice(0, max)}…` : text);

interface AiPanelProps {
    open: boolean;
    settings: Record<string, any>;
    request: AiPanelRequest | null;
    activeTabId: number | string | null;
    activeTabName: string;
    onClose: () => void;
}

export default function AiPanel({ open, settings, request, activeTabId, activeTabName, onClose }: AiPanelProps) {
    const en = settings.appLanguage === "en";
    const [history, setHistory] = useState<History>({ version: 2, chats: [] });
    const [loaded, setLoaded] = useState(false);
    const [view, setView] = useState<"tab" | "general">("tab");
    const [pickedChatKey, setPickedChatKey] = useState<string | null>(null);
    const [running, setRunning] = useState<Running | null>(null);
    const [draft, setDraft] = useState("");
    const [replyTo, setReplyTo] = useState<string | null>(null);
    const [think, setThink] = useState(() => {
        try { return localStorage.getItem(THINK_KEY) === "1"; } catch { return false; }
    });
    const [menuOpen, setMenuOpen] = useState(false);
    const [memoryOpen, setMemoryOpen] = useState(false);
    const [scanning, setScanning] = useState<string | null>(null);
    const [autoMemory, setAutoMemory] = useState(() => {
        try { return localStorage.getItem(AUTO_MEMORY_KEY) !== "0"; } catch { return true; }
    });
    const autoMemoryRef = useRef(autoMemory);
    autoMemoryRef.current = autoMemory;
    const scanRef = useRef<{ requestId: string; chatKey: string } | null>(null);
    const [flashBlock, setFlashBlock] = useState<string | null>(null);
    const [width, setWidth] = useState(readWidth);
    const historyRef = useRef(history);
    historyRef.current = history;
    const runningRef = useRef(running);
    runningRef.current = running;
    const settingsRef = useRef(settings);
    settingsRef.current = settings;
    const scrollRef = useRef<HTMLDivElement>(null);
    const stickToBottomRef = useRef(true);
    const handledRequestRef = useRef<number | null>(null);
    const fileLoadedRef = useRef(false);
    const saveAfterLoadRef = useRef(false);

    // Never write the file before it has been read, or the old history is lost.
    const persist = useCallback((next: History) => {
        if (!fileLoadedRef.current) { saveAfterLoadRef.current = true; return; }
        invoke("ai_history_save", { data: next }).catch((error) => console.error("[ai] history save failed", error));
    }, []);

    const commit = useCallback((next: History, save = false) => {
        historyRef.current = next;
        setHistory(next);
        if (save) persist(next);
    }, [persist]);

    const updateChat = useCallback((key: string, change: (chat: Chat) => Chat, save = false) => {
        const prev = historyRef.current;
        commit({ ...prev, chats: prev.chats.map((chat) => (chat.key === key ? change(chat) : chat)) }, save);
    }, [commit]);

    const patchMessage = useCallback((key: string, blockId: string, index: number, patch: (m: ChatMessage) => ChatMessage, save = false) => {
        updateChat(key, (chat) => ({
            ...chat,
            blocks: chat.blocks.map((block) => block.id !== blockId ? block : {
                ...block,
                messages: block.messages.map((m, i) => (i === index ? patch(m) : m)),
            }),
        }), save);
    }, [updateChat]);

    const ensureChat = useCallback((key: string, title: string, tabId: number | string | null) => {
        const prev = historyRef.current;
        const existing = prev.chats.find((chat) => chat.key === key);
        if (existing) {
            if (title && existing.title !== title) updateChat(key, (chat) => ({ ...chat, title }));
            return;
        }
        commit({ ...prev, chats: [...prev.chats, { key, title, tabId, updatedAt: Date.now(), blocks: [] }] });
    }, [commit, updateChat]);

    // Sends one block and streams the answer into a new assistant message, or
    // into `replaceIndex` when retrying.
    const runBlock = useCallback(async (key: string, blockId: string, options: { think: boolean; replaceIndex?: number }) => {
        if (runningRef.current) return;
        // The model serves one request at a time: the user's question wins over a memory scan.
        if (scanRef.current) invoke("ai_cancel", { requestId: scanRef.current.requestId }).catch(() => {});
        const chat = historyRef.current.chats.find((c) => c.key === key);
        const block = chat?.blocks.find((b) => b.id === blockId);
        if (!chat || !block) return;
        const base = options.replaceIndex !== undefined ? block.messages.slice(0, options.replaceIndex) : block.messages;
        const prompt = readAiPromptSettings(settingsRef.current);
        const usable = base.filter((m) => !m.error && m.content.trim());
        const context = key === GENERAL_KEY ? usable.slice(-GENERAL_CONTEXT) : usable;
        const apiMessages = [
            { role: "system", content: aiSystemPrompt(prompt, key === GENERAL_KEY ? "" : aiMemoryPrompt(chat.memory || [], prompt.explainLanguage)) },
            ...context.map((m) => ({ role: m.role, content: m.content })),
        ];
        const index = base.length;
        updateChat(key, (c) => ({
            ...c,
            updatedAt: Date.now(),
            blocks: c.blocks.map((b) => b.id !== blockId ? b : { ...b, messages: [...base, { role: "assistant", content: "", think: options.think, reasoningChars: 0 }] }),
        }));
        const requestId = newId();
        const run: Running = { requestId, chatKey: key, blockId, index, phase: "loading" };
        runningRef.current = run;
        setRunning(run);
        stickToBottomRef.current = true;
        try {
            const result = await invoke<{ content: string; reasoningChars?: number; tokensPerSecond?: number; cancelled?: boolean }>("ai_chat", {
                requestId,
                modelId: settingsRef.current.aiModel || AI_DEFAULT_MODEL,
                messages: apiMessages,
                think: options.think,
                maxTokens: null,
            });
            patchMessage(key, blockId, index, (m) => ({
                ...m,
                content: result.content || m.content,
                reasoningChars: result.reasoningChars ?? m.reasoningChars,
                tokensPerSecond: result.tokensPerSecond ?? undefined,
                cancelled: result.cancelled || undefined,
            }), true);
            if (key !== GENERAL_KEY && index === 1 && block.lines?.length && !result.cancelled && autoMemoryRef.current) {
                window.setTimeout(() => { void scanMemoryRef.current(key, [blockId]); }, 0);
            }
        } catch (error) {
            patchMessage(key, blockId, index, (m) => ({ ...m, error: String(error) }), true);
        } finally {
            runningRef.current = null;
            setRunning(null);
        }
    }, [patchMessage, updateChat]);

    // Looks for names and terms in explained lines and adds the new ones to the
    // tab's memory. Runs quietly after each explanation, or on demand.
    const scanMemory = useCallback(async (key: string, blockIds?: string[]) => {
        if (runningRef.current || scanRef.current) return;
        const chat = historyRef.current.chats.find((c) => c.key === key);
        if (!chat) return;
        const explained = chat.blocks.filter((b) => b.lines?.length && b.messages[1]?.content);
        const targets = blockIds
            ? explained.filter((b) => blockIds.includes(b.id))
            : (explained.some((b) => !b.scanned) ? explained.filter((b) => !b.scanned) : explained).slice(-MEMORY_SCAN_BLOCKS);
        if (!targets.length) return;
        const prompt = readAiPromptSettings(settingsRef.current);
        const memory = chat.memory || [];
        const passages = targets.map((b) => `${b.lines!.join("\n")}\n---\n${b.messages[1].content.slice(0, 700)}`);
        const requestId = newId();
        scanRef.current = { requestId, chatKey: key };
        setScanning(key);
        try {
            const result = await invoke<{ content: string; cancelled?: boolean }>("ai_chat", {
                requestId,
                modelId: settingsRef.current.aiModel || AI_DEFAULT_MODEL,
                messages: [
                    { role: "system", content: AI_MEMORY_SYSTEM },
                    { role: "user", content: aiMemoryExtractPrompt(chat.title, passages, memory.map((m) => m.term), prompt.explainLanguage) },
                ],
                think: false,
                maxTokens: 700,
            });
            if (result.cancelled) return;
            const found = parseAiMemoryItems(result.content || "");
            const allText = targets.map((b) => b.lines!.join("\n")).join("\n");
            const norm = (t: string) => t.replace(/\s+/g, "").toLowerCase();
            updateChat(key, (c) => {
                const known = new Set((c.memory || []).map((m) => norm(m.term)));
                const added: AiMemoryItem[] = [];
                for (const item of found) {
                    const k = norm(item.term);
                    // Only names that are really in the text: the model sometimes invents.
                    if (!k || known.has(k) || !norm(allText).includes(k)) continue;
                    known.add(k);
                    added.push({ id: newId(), term: item.term, reading: item.reading, note: item.note, auto: true });
                }
                const ids = new Set(targets.map((b) => b.id));
                return {
                    ...c,
                    memory: [...added, ...(c.memory || [])],
                    blocks: c.blocks.map((b) => {
                        if (!ids.has(b.id)) return b;
                        const mine = added.filter((m) => b.lines!.some((line) => norm(line).includes(norm(m.term)))).map((m) => m.term);
                        return { ...b, scanned: true, remembered: mine.length ? [...(b.remembered || []), ...mine] : b.remembered };
                    }),
                };
            }, true);
        } catch (error) {
            console.warn("[ai] memory scan failed", error);
        } finally {
            scanRef.current = null;
            setScanning(null);
        }
    }, [updateChat]);
    const scanMemoryRef = useRef(scanMemory);
    scanMemoryRef.current = scanMemory;

    const startExplanation = useCallback((explain: AiExplainRequest) => {
        const key = tabKey(explain.tabId);
        ensureChat(key, explain.tabName, explain.tabId);
        const prompt = readAiPromptSettings(settingsRef.current);
        const block: Block = {
            id: newId(),
            createdAt: Date.now(),
            lines: explain.lines,
            messages: [{ role: "user", content: aiExplainPrompt(explain, prompt), lines: explain.lines }],
        };
        updateChat(key, (chat) => ({ ...chat, updatedAt: Date.now(), blocks: [...chat.blocks, block] }), true);
        setView("tab");
        setPickedChatKey(null);
        setReplyTo(null);
        setMenuOpen(false);
        let deep = false;
        try { deep = localStorage.getItem(THINK_KEY) === "1"; } catch { /* ignore */ }
        void runBlock(key, block.id, { think: deep });
    }, [ensureChat, runBlock, updateChat]);

    // History is loaded once, when the panel first mounts.
    useEffect(() => {
        invoke<unknown>("ai_history_load")
            .then((data) => {
                const saved = migrateHistory(data);
                // Explanations started before the file loaded are merged in.
                const pending = historyRef.current.chats;
                const merged = [...saved.chats];
                for (const chat of pending) {
                    const existing = merged.find((c) => c.key === chat.key);
                    if (existing) existing.blocks = [...existing.blocks, ...chat.blocks.filter((b) => !existing.blocks.some((x) => x.id === b.id))];
                    else merged.push(chat);
                }
                fileLoadedRef.current = true;
                const migrated = (data as any)?.version !== 2;
                commit({ version: 2, chats: merged }, saveAfterLoadRef.current || migrated);
                saveAfterLoadRef.current = false;
            })
            .catch((error) => console.error("[ai] history load failed", error))
            .finally(() => setLoaded(true));
    }, [commit]);

    useEffect(() => {
        if (!request || handledRequestRef.current === request.id) return;
        handledRequestRef.current = request.id;
        startExplanation(request.request);
    }, [request, startExplanation]);

    // Streamed tokens.
    useEffect(() => {
        const unlisteners: Array<() => void> = [];
        let disposed = false;
        const add = (promise: Promise<() => void>) => promise.then((fn) => (disposed ? fn() : unlisteners.push(fn)));
        add(listen<{ requestId: string; content: string; reasoning: string }>("ai://chunk", (event) => {
            const run = runningRef.current;
            if (!run || event.payload.requestId !== run.requestId) return;
            const { content, reasoning } = event.payload;
            const phase: Phase = content ? "writing" : reasoning ? "thinking" : run.phase;
            if (phase !== run.phase) {
                const next = { ...run, phase };
                runningRef.current = next;
                setRunning(next);
            }
            patchMessage(run.chatKey, run.blockId, run.index, (m) => ({
                ...m,
                content: m.content + (content || ""),
                reasoningChars: (m.reasoningChars || 0) + (reasoning ? reasoning.length : 0),
            }));
        }));
        return () => { disposed = true; unlisteners.forEach((fn) => fn()); };
    }, [patchMessage]);

    const currentKey = view === "general" ? GENERAL_KEY : (pickedChatKey ?? tabKey(activeTabId));
    const currentChat = useMemo(() => history.chats.find((chat) => chat.key === currentKey) || null, [history, currentKey]);
    const tabChats = useMemo(() => history.chats.filter((chat) => chat.key !== GENERAL_KEY && chat.blocks.length > 0)
        .sort((a, b) => b.updatedAt - a.updatedAt), [history]);
    const explainedBlocks = useMemo(() => (currentChat?.blocks || []).filter((block) => block.lines?.length), [currentChat]);
    const chatTitle = view === "general"
        ? (en ? "General chat" : "Общий чат")
        : (currentChat?.title || (pickedChatKey ? "" : activeTabName) || (en ? "This tab" : "Эта вкладка"));

    // Switching reading tabs shows that tab's chat.
    useEffect(() => { setPickedChatKey(null); setReplyTo(null); stickToBottomRef.current = true; }, [activeTabId]);
    useEffect(() => { if (view === "general") setMemoryOpen(false); }, [view]);

    // Keep the newest text in view while it streams, unless the user scrolled up.
    useEffect(() => {
        const el = scrollRef.current;
        if (el && stickToBottomRef.current) el.scrollTop = el.scrollHeight;
    }, [currentChat, open, view]);

    const onScroll = () => {
        const el = scrollRef.current;
        if (!el) return;
        stickToBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
    };

    const jumpToBlock = (blockId: string) => {
        setMenuOpen(false);
        stickToBottomRef.current = false;
        requestAnimationFrame(() => {
            document.getElementById(`aip-block-${blockId}`)?.scrollIntoView({ block: "start", behavior: "smooth" });
            setFlashBlock(blockId);
            window.setTimeout(() => setFlashBlock(null), 1400);
        });
    };

    const send = () => {
        const text = draft.trim();
        if (!text || running) return;
        if (view === "general") {
            ensureChat(GENERAL_KEY, en ? "General chat" : "Общий чат", null);
            const chat = historyRef.current.chats.find((c) => c.key === GENERAL_KEY)!;
            const block = chat.blocks[0] ?? { id: newId(), createdAt: Date.now(), messages: [] };
            updateChat(GENERAL_KEY, (c) => ({
                ...c,
                updatedAt: Date.now(),
                blocks: [{ ...block, messages: [...block.messages, { role: "user", content: text }] }],
            }), true);
            setDraft("");
            void runBlock(GENERAL_KEY, block.id, { think });
            return;
        }
        // In a tab chat a question belongs to an explained line: the chosen one,
        // or the latest. A question with nothing explained yet starts a block of its own.
        const key = currentKey;
        ensureChat(key, activeTabName, activeTabId);
        const chat = historyRef.current.chats.find((c) => c.key === key)!;
        let target = chat.blocks.find((b) => b.id === replyTo) ?? chat.blocks[chat.blocks.length - 1];
        if (!target) {
            target = { id: newId(), createdAt: Date.now(), messages: [] };
            updateChat(key, (c) => ({ ...c, blocks: [...c.blocks, target!] }));
        }
        const blockId = target.id;
        updateChat(key, (c) => ({
            ...c,
            updatedAt: Date.now(),
            blocks: c.blocks.map((b) => b.id !== blockId ? b : { ...b, messages: [...b.messages, { role: "user", content: text }] }),
        }), true);
        setDraft("");
        void runBlock(key, blockId, { think });
    };

    const memory = currentChat?.memory || [];
    const editMemory = (id: string, patch: Partial<AiMemoryItem>) => {
        updateChat(currentKey, (chat) => ({ ...chat, memory: (chat.memory || []).map((m) => (m.id === id ? { ...m, ...patch, auto: false } : m)) }));
    };
    const saveMemory = () => persist(historyRef.current);
    const addMemory = () => {
        ensureChat(currentKey, activeTabName, activeTabId);
        updateChat(currentKey, (chat) => ({ ...chat, memory: [{ id: newId(), term: "", reading: "", note: "" }, ...(chat.memory || [])] }));
        requestAnimationFrame(() => (document.querySelector(".aip-mem-row input") as HTMLInputElement | null)?.focus());
    };
    const removeMemory = (id: string) => {
        updateChat(currentKey, (chat) => ({ ...chat, memory: (chat.memory || []).filter((m) => m.id !== id) }), true);
    };
    const toggleAutoMemory = () => {
        setAutoMemory((value) => {
            const next = !value;
            try { localStorage.setItem(AUTO_MEMORY_KEY, next ? "1" : "0"); } catch { /* ignore */ }
            return next;
        });
    };
    const openMemory = () => { setMemoryOpen(true); setMenuOpen(false); };

    const stop = () => {
        if (running) invoke("ai_cancel", { requestId: running.requestId }).catch(() => {});
    };

    const deleteBlock = (blockId: string) => {
        if (running?.blockId === blockId) return;
        updateChat(currentKey, (chat) => ({ ...chat, blocks: chat.blocks.filter((b) => b.id !== blockId) }), true);
        if (replyTo === blockId) setReplyTo(null);
    };

    const clearChat = () => {
        if (!currentChat || running?.chatKey === currentKey) return;
        const ok = window.confirm(en ? `Clear "${chatTitle}"?` : `Очистить «${chatTitle}»?`);
        if (!ok) return;
        updateChat(currentKey, (chat) => ({ ...chat, blocks: [] }), true);
        setMenuOpen(false);
    };

    const toggleThink = () => {
        setThink((value) => {
            const next = !value;
            try { localStorage.setItem(THINK_KEY, next ? "1" : "0"); } catch { /* ignore */ }
            return next;
        });
    };

    const startResize = (event: ReactPointerEvent<HTMLDivElement>) => {
        event.preventDefault();
        const startX = event.clientX;
        const startWidth = width;
        const target = event.currentTarget;
        target.setPointerCapture(event.pointerId);
        let latest = startWidth;
        const move = (e: PointerEvent) => {
            latest = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, startWidth + (startX - e.clientX)));
            setWidth(latest);
        };
        const up = () => {
            target.removeEventListener("pointermove", move);
            target.removeEventListener("pointerup", up);
            target.removeEventListener("pointercancel", up);
            try { localStorage.setItem(WIDTH_KEY, String(Math.round(latest))); } catch { /* ignore */ }
        };
        target.addEventListener("pointermove", move);
        target.addEventListener("pointerup", up);
        target.addEventListener("pointercancel", up);
    };

    const phaseLabel = (phase: Phase, reasoningChars: number) => {
        if (phase === "loading") return en ? "Loading the model… (the first time takes ~20 s)" : "Загружаю модель… (в первый раз ~20 с)";
        if (phase === "thinking") return en ? `Thinking… ${reasoningChars ? `(${reasoningChars} chars)` : ""}` : `Думает… ${reasoningChars ? `(${reasoningChars} симв.)` : ""}`;
        return en ? "Writing…" : "Пишет…";
    };

    const replyBlock = currentChat?.blocks.find((b) => b.id === replyTo) ?? null;
    const lastBlockId = currentChat?.blocks[currentChat.blocks.length - 1]?.id;

    const renderMessage = (block: Block, message: ChatMessage, index: number) => {
        const isRunning = running?.chatKey === currentKey && running.blockId === block.id && running.index === index;
        const isLast = index === block.messages.length - 1;
        if (message.role === "user") {
            if (message.lines) {
                return (
                    <div key={index} className="aip-quote">
                        {message.lines.map((line, i) => <p key={i}>{line}</p>)}
                    </div>
                );
            }
            return <div key={index} className="aip-user">{message.content}</div>;
        }
        return (
            <div key={index} className={`aip-answer${isRunning ? " is-running" : ""}`}>
                {message.think && <span className="aip-tag">{en ? "Deep" : "Глубже"}</span>}
                {message.content ? <Markdown text={message.content} /> : null}
                {isRunning && <div className="aip-phase"><span className="aip-spinner" />{phaseLabel(running.phase, message.reasoningChars || 0)}</div>}
                {message.error && <div className="aip-error">{message.error}</div>}
                {!isRunning && (
                    <div className="aip-actions">
                        {message.cancelled && <span className="aip-muted">{en ? "Stopped" : "Остановлено"}</span>}
                        {message.content && (
                            <button type="button" onClick={() => navigator.clipboard?.writeText(message.content).catch(() => {})}>{en ? "Copy" : "Копировать"}</button>
                        )}
                        {isLast && !running && (
                            <>
                                <button type="button" onClick={() => runBlock(currentKey, block.id, { think: Boolean(message.think), replaceIndex: index })}>{en ? "Retry" : "Повторить"}</button>
                                {!message.think && (
                                    <button type="button" className="is-accent" onClick={() => runBlock(currentKey, block.id, { think: true, replaceIndex: index })}>
                                        <IconSparkle size={12} /> {en ? "Think deeper" : "Подумать глубже"}
                                    </button>
                                )}
                            </>
                        )}
                        {message.tokensPerSecond ? <span className="aip-muted">{Math.round(message.tokensPerSecond)} tok/s</span> : null}
                    </div>
                )}
            </div>
        );
    };

    return (
        <aside
            className={`aip${open ? " is-open" : ""}`}
            style={{ width: open ? width : 0 }}
            aria-hidden={!open}
            aria-label={en ? "AI explanations" : "ИИ-объяснения"}
        >
            <div className="aip-inner" style={{ width }}>
                <div className="aip-resize" onPointerDown={startResize} title={en ? "Drag to resize" : "Потяни, чтобы изменить ширину"} />

                <header className="aip-header">
                    <div className="aip-switch" role="tablist">
                        <button type="button" role="tab" aria-selected={view === "tab"} className={view === "tab" ? "is-active" : ""} onClick={() => { setView("tab"); setMenuOpen(false); }} title={chatTitle}>
                            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M4 5h16M4 12h16M4 19h10" /></svg>
                            <span>{view === "tab" ? snippet(chatTitle, 22) : (en ? "Tab" : "Вкладка")}</span>
                        </button>
                        <button type="button" role="tab" aria-selected={view === "general"} className={view === "general" ? "is-active" : ""} onClick={() => { setView("general"); setMenuOpen(false); setReplyTo(null); }}>
                            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4Z" /></svg>
                            <span>{en ? "General" : "Общий"}</span>
                        </button>
                    </div>
                    {view === "tab" && (
                        <button type="button" className={`aip-icon-btn${scanning === currentKey ? " is-busy" : ""}`} onClick={() => { setMemoryOpen((v) => !v); setMenuOpen(false); }} aria-pressed={memoryOpen} title={en ? "Tab memory: names and terms" : "Память вкладки: имена и термины"}>
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z" /><path d="M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z" /><path d="M12 5v13" /></svg>
                            {memory.length > 0 && <span className="aip-badge">{memory.length}</span>}
                        </button>
                    )}
                    <button type="button" className="aip-icon-btn" onClick={() => { setMenuOpen((v) => !v); setMemoryOpen(false); }} aria-pressed={menuOpen} title={en ? "Explained lines and other chats" : "Объяснённые строки и другие чаты"}>
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 12a9 9 0 1 0 3-6.7" /><path d="M3 4v4h4" /><path d="M12 8v4l3 2" /></svg>
                    </button>
                    <button type="button" className="aip-icon-btn" onClick={onClose} title={en ? "Close" : "Закрыть"}>
                        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M18 6 6 18" /><path d="m6 6 12 12" /></svg>
                    </button>

                    {menuOpen && (
                        <div className="aip-menu" role="menu">
                            {view === "tab" && (
                                <>
                                    <div className="aip-menu-label">{en ? "Lines in this chat" : "Строки в этом чате"}</div>
                                    {explainedBlocks.length === 0 && <div className="aip-menu-empty">{en ? "Nothing explained yet" : "Пока ничего не объяснено"}</div>}
                                    <div className="aip-menu-list">
                                        {[...explainedBlocks].reverse().map((block) => (
                                            <button type="button" key={block.id} className="aip-menu-item" onClick={() => jumpToBlock(block.id)}>
                                                <span className="aip-menu-line">{block.lines!.join(" ")}</span>
                                                <span className="aip-menu-meta">{formatWhen(block.createdAt, en)}{block.messages.length > 2 ? ` · ${en ? "questions" : "вопросы"}: ${Math.floor((block.messages.length - 2) / 2)}` : ""}</span>
                                            </button>
                                        ))}
                                    </div>
                                </>
                            )}
                            {tabChats.filter((chat) => chat.key !== currentKey).length > 0 && (
                                <>
                                    <div className="aip-menu-label">{en ? "Other tabs" : "Другие вкладки"}</div>
                                    <div className="aip-menu-list is-short">
                                        {tabChats.filter((chat) => chat.key !== currentKey).map((chat) => (
                                            <button type="button" key={chat.key} className="aip-menu-item" onClick={() => { setView("tab"); setPickedChatKey(chat.key); setMenuOpen(false); stickToBottomRef.current = true; }}>
                                                <span className="aip-menu-line">{chat.title || (en ? "Tab" : "Вкладка")}</span>
                                                <span className="aip-menu-meta">{chat.blocks.length} · {formatWhen(chat.updatedAt, en)}</span>
                                            </button>
                                        ))}
                                    </div>
                                </>
                            )}
                            {currentChat && currentChat.blocks.length > 0 && (
                                <button type="button" className="aip-menu-item is-danger" onClick={clearChat}>{en ? "Clear this chat" : "Очистить этот чат"}</button>
                            )}
                        </div>
                    )}
                </header>

                {pickedChatKey && view === "tab" && (
                    <button type="button" className="aip-back" onClick={() => setPickedChatKey(null)}>
                        ← {en ? `Back to the current tab: ${activeTabName}` : `К текущей вкладке: ${activeTabName}`}
                    </button>
                )}

                {memoryOpen && view === "tab" && (
                    <div className="aip-memory">
                        <div className="aip-mem-head">
                            <div>
                                <div className="aip-mem-title">{en ? "Tab memory" : "Память вкладки"}</div>
                                <div className="aip-mem-hint">
                                    {en
                                        ? "Names, places and terms of this work. The AI uses them in every explanation in this tab."
                                        : "Имена, места и термины этого произведения. ИИ учитывает их в каждом объяснении в этой вкладке."}
                                </div>
                            </div>
                            <button type="button" className="aip-icon-btn" onClick={() => setMemoryOpen(false)} title={en ? "Back to the chat" : "Назад к чату"}>
                                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M18 6 6 18" /><path d="m6 6 12 12" /></svg>
                            </button>
                        </div>
                        <div className="aip-mem-actions">
                            <button type="button" onClick={addMemory}>+ {en ? "Add" : "Добавить"}</button>
                            <button type="button" disabled={Boolean(running) || Boolean(scanning) || !explainedBlocks.length} onClick={() => void scanMemory(currentKey)}>
                                {scanning === currentKey ? <><span className="aip-spinner" /> {en ? "Looking…" : "Ищу…"}</> : (en ? "Find names in explained lines" : "Найти имена в объяснённом")}
                            </button>
                        </div>
                        <label className="aip-mem-auto">
                            <input type="checkbox" checked={autoMemory} onChange={toggleAutoMemory} />
                            {en ? "Remember new names after each explanation" : "Запоминать новые имена после каждого объяснения"}
                        </label>
                        {memory.length === 0 ? (
                            <div className="aip-mem-empty">
                                {en
                                    ? "Nothing yet. Names show up here as you explain lines, or add them yourself: for example 蓮（れん） — Ren, the hero."
                                    : "Пока пусто. Имена появятся здесь по мере объяснений, или добавь сам: например 蓮（れん） — Рэн, главный герой."}
                            </div>
                        ) : (
                            <div className="aip-mem-list">
                                {memory.map((item) => (
                                    <div key={item.id} className={`aip-mem-row${item.auto ? " is-auto" : ""}`}>
                                        <div className="aip-mem-fields">
                                            <div className="aip-mem-line">
                                                <input className="aip-mem-term" value={item.term} placeholder={en ? "Name" : "Имя"} onChange={(e) => editMemory(item.id, { term: e.target.value })} onBlur={saveMemory} />
                                                <input className="aip-mem-reading" value={item.reading || ""} placeholder={en ? "reading" : "чтение"} onChange={(e) => editMemory(item.id, { reading: e.target.value })} onBlur={saveMemory} />
                                            </div>
                                            <input className="aip-mem-note" value={item.note} placeholder={en ? "Who or what it is" : "Кто это или что это"} onChange={(e) => editMemory(item.id, { note: e.target.value })} onBlur={saveMemory} />
                                        </div>
                                        <button type="button" className="aip-mem-del" onClick={() => removeMemory(item.id)} title={en ? "Forget" : "Забыть"} aria-label={en ? "Forget" : "Забыть"}>
                                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><path d="M18 6 6 18" /><path d="m6 6 12 12" /></svg>
                                        </button>
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>
                )}

                <div className="aip-messages" ref={scrollRef} onScroll={onScroll} onClick={() => menuOpen && setMenuOpen(false)} hidden={memoryOpen && view === "tab"}>
                    {!currentChat || currentChat.blocks.length === 0 ? (
                        <div className="aip-empty">
                            <IconSparkle size={26} />
                            {view === "general" ? (
                                <>
                                    <p>{en ? "Ask anything about Japanese or English." : "Спроси что угодно про японский или английский."}</p>
                                    <span>{en ? "Grammar, words, nuance, how to say something — this chat isn't tied to a tab." : "Грамматика, слова, нюансы, как что-то сказать — этот чат не привязан к вкладке."}</span>
                                </>
                            ) : (
                                <>
                                    <p>{en ? "No explanations in this tab yet." : "В этой вкладке пока нет объяснений."}</p>
                                    <span>{en ? "Hover a line and press the sparkle button, or the checklist button to pick several lines." : "Наведи на строку и нажми кнопку со звёздочкой, а чтобы выбрать несколько строк — кнопку со списком."}</span>
                                </>
                            )}
                        </div>
                    ) : (
                        currentChat.blocks.map((block) => (
                            <section key={block.id} id={`aip-block-${block.id}`} className={`aip-block${flashBlock === block.id ? " is-flash" : ""}${replyTo === block.id ? " is-reply-target" : ""}`}>
                                {view === "tab" && (
                                    <div className="aip-block-head">
                                        <span>{formatWhen(block.createdAt, en)}</span>
                                        <div className="aip-block-tools">
                                            {block.lines?.length ? (
                                                <button type="button" onClick={() => setReplyTo(replyTo === block.id ? null : block.id)} title={en ? "Ask about this line" : "Спросить про эту строку"}>
                                                    {en ? "Ask" : "Спросить"}
                                                </button>
                                            ) : null}
                                            <button type="button" disabled={running?.blockId === block.id} onClick={() => deleteBlock(block.id)} title={en ? "Delete" : "Удалить"} aria-label={en ? "Delete" : "Удалить"}>
                                                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><path d="M18 6 6 18" /><path d="m6 6 12 12" /></svg>
                                            </button>
                                        </div>
                                    </div>
                                )}
                                {block.messages.map((message, index) => renderMessage(block, message, index))}
                                {view === "tab" && block.remembered?.length ? (
                                    <button type="button" className="aip-remembered" onClick={openMemory}>
                                        {en ? "Remembered:" : "Запомнил:"} {block.remembered.join(", ")}
                                    </button>
                                ) : null}
                            </section>
                        ))
                    )}
                </div>

                <footer className="aip-composer">
                    {view === "tab" && replyBlock?.lines && (
                        <div className="aip-reply">
                            <span>{en ? "About:" : "Про:"} «{snippet(replyBlock.lines.join(" "), 40)}»</span>
                            <button type="button" onClick={() => setReplyTo(null)} aria-label={en ? "Cancel" : "Отмена"}>×</button>
                        </div>
                    )}
                    {view === "tab" && !replyBlock && lastBlockId && currentChat?.blocks.length ? (
                        <div className="aip-reply is-hint">{en ? "Questions go to the latest explanation · “Ask” picks another one" : "Вопрос — к последнему объяснению · «Спросить» у строки выбирает другое"}</div>
                    ) : null}
                    <textarea
                        value={draft}
                        placeholder={view === "general"
                            ? (en ? "Ask about Japanese or English…" : "Вопрос про японский или английский…")
                            : (en ? "Ask a follow-up question…" : "Задай уточняющий вопрос…")}
                        onChange={(e) => setDraft(e.target.value)}
                        onKeyDown={(e) => {
                            e.stopPropagation();
                            if (e.key === "Enter" && !e.shiftKey) {
                                e.preventDefault();
                                send();
                            }
                        }}
                        rows={1}
                    />
                    <div className="aip-composer-row">
                        <button type="button" className={`aip-think${think ? " is-on" : ""}`} onClick={toggleThink} title={en ? "Let the model think first: slower but more accurate" : "Модель сначала думает: дольше, но точнее"}>
                            <IconSparkle size={12} /> {en ? "Think deeper" : "Думать глубже"}
                        </button>
                        {running ? (
                            <button type="button" className="aip-send is-stop" onClick={stop}>{en ? "Stop" : "Стоп"}</button>
                        ) : (
                            <button type="button" className="aip-send" disabled={!draft.trim() || !loaded} onClick={send}>{en ? "Send" : "Отправить"}</button>
                        )}
                    </div>
                </footer>
            </div>
        </aside>
    );
}
