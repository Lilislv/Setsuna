// Setsuna's adapter only. The Yatsu application is loaded from its official site.
(() => {
    if (location.origin !== 'https://app.yatsu.moe' || window.top !== window || window.__setsunaYatsuInstalled) return;
    window.__setsunaYatsuInstalled = true;
    const excluded = 'rt, rp, script, style, button, input, textarea, select, a, [contenteditable], [aria-hidden="true"], .book-content-page-measure, [data-yatsu-current-position-marker], [data-yatsu-bookmark-marker]';
    const send = (action, data) => { location.href = 'setsuna-yatsu://' + action + (data ? '?data=' + encodeURIComponent(JSON.stringify(data)) : ''); };
    let popupOpen = false, menu = null;
    let pointer = null, last = null, pending = null, timer = 0, sequence = 0, current = null;
    const hit = (node, offset, x, y, root) => {
        if (node?.nodeType !== Node.TEXT_NODE || !root.contains(node) || node.parentElement?.closest(excluded)) return null;
        if (offset > 0 && /[\uDC00-\uDFFF]/.test(node.data[offset] || '')) offset--;
        const cp = node.data.codePointAt(offset);
        if (cp === undefined || /\s/.test(String.fromCodePoint(cp))) return null;
        const range = document.createRange();
        range.setStart(node, offset); range.setEnd(node, offset + (cp > 65535 ? 2 : 1));
        if (![...range.getClientRects()].some(r => r.width && r.height && x >= r.left && x < r.right && y >= r.top && y < r.bottom)) return null;
        const rect = range.getBoundingClientRect();
        const mode = getComputedStyle(node.parentElement).writingMode;
        return { node, offset, root, text: node.data, anchor: { x: Math.max(0, rect.x), y: Math.max(0, rect.y), width: rect.width, height: rect.height }, vertical: mode.startsWith('vertical') || mode.startsWith('sideways'), prefer_right: mode.endsWith('-rl') };
    };
    function point(x, y) {
        const element = document.elementFromPoint(x, y);
        const root = element?.closest('.book-content:not(.book-content-page-measure)');
        if (!root || element.closest(excluded)) return null;
        const caret = document.caretPositionFromPoint?.(x, y);
        const range = caret ? null : document.caretRangeFromPoint?.(x, y);
        const node = caret?.offsetNode || range?.startContainer;
        const offset = caret?.offset ?? range?.startOffset ?? 0;
        return hit(node, offset, x, y, root) || (offset > 0 ? hit(node, offset - 1, x, y, root) : null);
    }
    function context(target) {
        const block = target.node.parentElement.closest('p, li, h1, h2, h3, h4, h5, h6, blockquote, .book-content-container > *');
        const host = block && target.root.contains(block) ? block : target.root;
        const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT, {
            acceptNode: node => node.parentElement?.closest(excluded) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
        });
        // Bound both traversal and the IPC payload, including unusually long EPUB paragraphs.
        const nodes = []; let before = '', after = '', found = false, budget = 20000;
        for (let node = walker.nextNode(); node && budget-- > 0; node = walker.nextNode()) {
            nodes.push(node);
            if (node === target.node) {
                before += node.data.slice(0, target.offset); after = node.data.slice(target.offset, target.offset + 4096); found = true;
            } else if (found) after += node.data.slice(0, 4096 - after.length);
            else before = (before + node.data).slice(-4096);
            if (found && after.length >= 2048) break;
        }
        if (!found) return null;
        const prefix = Array.from(before).slice(-512).join('');
        const sentence = prefix + Array.from(after).slice(0, 1536).join('');
        return { sentence, cursor: Array.from(prefix).length, nodes, target, prefixLength: prefix.length };
    }
    function scan() {
        timer = 0;
        const target = pending; pending = null;
        if (!target || !target.node.isConnected) return;
        const value = context(target);
        if (!value) return;
        current = { ...value, id: ++sequence };
        send('lookup', { id: current.id, sentence: value.sentence, cursor: value.cursor, anchor: target.anchor, vertical: target.vertical, prefer_right: target.prefer_right });
    }
    function update(x, y) {
        const next = point(x, y);
        if (!next) { last = null; pending = null; return; }
        if (last && last.node === next.node && last.offset === next.offset && last.text === next.text) return;
        last = next; pending = next;
        if (!timer) timer = setTimeout(scan, 60);
    }
    const clear = () => {
        popupOpen = false;
        last = pending = current = null; clearTimeout(timer); timer = 0;
        window.CSS?.highlights?.delete('setsuna-yatsu');
    };
    const dismiss = () => { const active = current || popupOpen; clear(); if (active) send('close'); };
    window.__setsunaYatsuDismiss = clear;
    window.__setsunaYatsuPopup = value => { popupOpen = Boolean(value); };
    document.addEventListener('pointermove', event => {
        pointer = { x: event.clientX, y: event.clientY };
        if (!menu?.open && event.shiftKey && !event.buttons) update(pointer.x, pointer.y);
        else { last = pending = null; clearTimeout(timer); timer = 0; }
    }, { passive: true });
    document.addEventListener('keydown', event => {
        if (event.key === 'Escape' && !event.repeat) {
            if (event.target instanceof Element && event.target.closest('input,textarea,select,[contenteditable]') && !menu?.open) return;
            event.preventDefault(); event.stopImmediatePropagation();
            if (menu?.open) closeMenu();
            else if (current || popupOpen) dismiss();
            else openMenu();
        }
        if (!menu?.open && event.key === 'Shift' && !event.repeat && pointer) update(pointer.x, pointer.y);
    }, true);
    document.addEventListener('pointerdown', event => {
        if (!event.composedPath().some(node => node === menu?.getRootNode().host)) dismiss();
    }, true);
    document.addEventListener('keyup', event => {
        if (event.key === 'Shift') { pending = null; clearTimeout(timer); timer = 0; last = null; }
    });
    // Moving from the book into the popup changes focus; keep its article alive.
    window.addEventListener('blur', () => { pending = null; clearTimeout(timer); timer = 0; last = null; });
    document.addEventListener('scroll', event => { if (!menu?.open && !event.composedPath().includes(menu)) dismiss(); }, { passive: true, capture: true });
    window.addEventListener('resize', dismiss);
    window.addEventListener('pagehide', clear);
    window.__setsunaYatsuHighlight = (id, start, length) => {
        if (!current || current.id !== id || !current.target.node.isConnected || !window.CSS?.highlights || !window.Highlight) return;
        const { sentence, target, prefixLength, nodes } = current;
        const head = nodes.slice(0, nodes.indexOf(target.node)).reduce((sum, node) => sum + node.length, 0) + target.offset - prefixLength;
        const from = head + Array.from(sentence).slice(0, start).join('').length;
        const to = from + Array.from(sentence).slice(start, start + length).join('').length;
        CSS.highlights.delete('setsuna-yatsu');
        if (!length) return;
        const range = document.createRange(); let consumed = 0, began = false;
        for (const node of nodes) {
            if (!node.isConnected) return;
            if (!began && from < consumed + node.length) { range.setStart(node, from - consumed); began = true; }
            if (began && to <= consumed + node.length) {
                range.setEnd(node, to - consumed); CSS.highlights.set('setsuna-yatsu', new Highlight(range)); return;
            }
            consumed += node.length;
        }
    };
    let closeTimer = 0;
    const motionTime = () => matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 220;
    function openMenu() {
        if (!menu || menu.open) return;
        dismiss(); clearTimeout(closeTimer);
        menu.showModal();
        requestAnimationFrame(() => { if (menu.open) menu.classList.add('is-open'); });
    }
    function closeMenu(action) {
        if (!menu?.open) return;
        menu.classList.remove('is-open'); clearTimeout(closeTimer);
        closeTimer = setTimeout(() => { menu.close(); action?.(); }, motionTime());
    }
    const installStyle = () => {
        const style = document.createElement('style');
        style.textContent = '::highlight(setsuna-yatsu) { background: #2867b2; color: white; }';
        document.head.append(style);
        const host = document.createElement('setsuna-reader-controls');
        const shadow = host.attachShadow({ mode: 'open' });
        const en = window.__setsunaYatsuLanguage === 'en';
        const paths = {
            resume: '<path d="m9 5 11 7-11 7z"/>',
            library: '<path d="M4 4h5v16H4zM11 4h4v16h-4zM17 5l4-1 3 15-4 1z"/>',
            home: '<path d="m3 11 9-8 9 8M5 10v11h5v-7h4v7h5V10"/>',
            reload: '<path d="M20 7a9 9 0 1 0 1 9M20 2v6h-6"/>',
        };
        const items = [
            ['resume', en ? 'Continue reading' : 'Продолжить', en ? 'Back to your book' : 'Вернуться к книге'],
            ['library', en ? 'Library' : 'Библиотека', en ? 'Choose another book' : 'Выбрать другую книгу'],
            ['home', en ? 'Home screen' : 'Главный экран', en ? 'Setsuna reading modes' : 'Режимы чтения Setsuna'],
            ['reload', en ? 'Reload reader' : 'Обновить', en ? 'Reload this page' : 'Перезагрузить страницу'],
        ];
        shadow.innerHTML = `<style>
            :host { all: initial; font-family: 'Segoe UI', sans-serif; color-scheme: dark; }
            * { box-sizing: border-box; }
            button { font: inherit; cursor: pointer; }
            .hint { position: fixed; left: 18px; bottom: 18px; z-index: 2147483646; display: flex; align-items: center; gap: 8px; height: 32px; padding: 0 11px; color: #d1d5df; background: #20232ccc; backdrop-filter: blur(8px); border: 1px solid #ffffff26; border-radius: 10px; opacity: .55; transition: opacity .2s, background .2s; font: 12px 'Segoe UI', sans-serif; }
            .hint:hover, .hint:focus-visible { opacity: 1; background: #323a4bef; }
            kbd { font: 11px 'Segoe UI', sans-serif; padding: 2px 5px; border: 1px solid #ffffff30; border-radius: 4px; }
            dialog { width: min(820px, calc(100vw - 64px)); max-height: calc(100vh - 48px); margin: auto; padding: 0; border: 0; background: transparent; color: #f1f4fb; outline: 0; overflow: auto; opacity: 0; transform: translateY(18px) scale(.97); transition: opacity .22s ease, transform .22s cubic-bezier(.2,.8,.2,1); }
            dialog.is-open { opacity: 1; transform: translateY(0) scale(1); }
            dialog::backdrop { background: #10131c00; backdrop-filter: blur(0); transition: background .22s, backdrop-filter .22s; }
            dialog.is-open::backdrop { background: #10131caa; backdrop-filter: blur(14px) saturate(.65); }
            .heading { display: flex; align-items: center; justify-content: space-between; padding: 12px 4px 28px; }
            .brand { letter-spacing: .25em; font-size: 11px; color: #a9b9d7; margin: 0 0 8px; }
            h1 { font-size: 28px; font-weight: 500; margin: 0; }
            .close { width: 38px; height: 38px; border: 1px solid #ffffff26; border-radius: 50%; color: #d5dced; background: #ffffff09; font-size: 24px; }
            .grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; }
            .item { min-height: 178px; padding: 25px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 12px; border: 1px solid #ffffff24; border-radius: 22px; background: linear-gradient(145deg, #ffffff13, #ffffff05); color: #e4eaf6; box-shadow: 0 12px 35px #00000014; transition: background .18s, border-color .18s, transform .18s; }
            .item:hover { background: #7ea5eb22; border-color: #a1bfff80; transform: translateY(-3px); }
            button:focus-visible { outline: 2px solid #a1bfff; outline-offset: 4px; }
            svg { width: 44px; height: 44px; stroke: #a9c9ff; stroke-width: 1.5; fill: none; stroke-linecap: round; stroke-linejoin: round; }
            .item strong { font-size: 19px; font-weight: 500; }
            .item small { font-size: 12px; color: #aebbd1; }
            .footer { margin: 24px 0 4px; text-align: center; color: #b5c0d3; font-size: 12px; }
            @media(max-width:600px), (max-height:600px) { dialog { width: calc(100vw - 32px); } .heading { padding-bottom: 16px; } .item { min-height: 120px; padding: 16px; gap: 8px; border-radius: 16px; } .item small { display: none; } svg { width: 32px; height: 32px; } .item strong { font-size: 16px; } }
            @media(prefers-reduced-motion:reduce) { *, *::backdrop { transition: none !important; transform: none !important; } }
        </style>
        <button class="hint" title="${en ? 'Reader menu' : 'Меню читалки'}"><span>⋯</span> ${en ? 'Menu' : 'Меню'} <kbd>Esc</kbd></button>
        <dialog aria-labelledby="setsuna-menu-title">
            <div class="heading"><div><p class="brand">SETSUNA</p><h1 id="setsuna-menu-title">${en ? 'Reading' : 'Чтение'}</h1></div><button class="close" aria-label="${en ? 'Close menu' : 'Закрыть меню'}">×</button></div>
            <div class="grid">${items.map(([action, label, hint]) => `<button class="item" data-action="${action}"><svg viewBox="0 0 26 24" aria-hidden="true">${paths[action]}</svg><strong>${label}</strong><small>${hint}</small></button>`).join('')}</div>
            <p class="footer"><kbd>Esc</kbd> ${en ? 'return to reading · Shift + hover to look up a word' : 'вернуться к чтению · Shift + наведение для лукапа'}</p>
        </dialog>`;
        menu = shadow.querySelector('dialog');
        shadow.querySelector('.hint').addEventListener('click', openMenu);
        shadow.querySelector('.close').addEventListener('click', () => closeMenu());
        menu.addEventListener('cancel', event => { event.preventDefault(); closeMenu(); });
        menu.addEventListener('click', event => { if (event.target === menu) closeMenu(); });
        for (const button of shadow.querySelectorAll('[data-action]')) button.addEventListener('click', () => {
            const action = button.dataset.action;
            closeMenu(() => {
                if (action === 'home') send('home');
                if (action === 'library') location.href = 'https://app.yatsu.moe/';
                if (action === 'reload') location.reload();
            });
        });
        document.documentElement.append(host);
    };
    if (document.head && document.body) installStyle(); else document.addEventListener('DOMContentLoaded', installStyle, { once: true });
})();
