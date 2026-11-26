import type { OnboardingMode } from "./onboardingStore";
import { playerTips, readerTips } from "./readerTips";
import { mobileModeGuide, mobileModeTips } from "./mobileGuides";
import { isMobilePlatform } from "../../utils/platform";

// Texts for the mode introductions and button tips. Written for someone who has
// never used a texthooker: no jargon without an explanation next to it.

export type ModeGuide = {
    title: string;
    lead: string;
    points: string[];
};

export type CoachStep = {
    id: string;
    /** CSS selector of the element the tip points at; steps whose target is missing are skipped. */
    target: string;
    /** "last": point at the last match on screen (the newest line) instead of the first. */
    pick?: "last";
    title: string;
    body: string;
};

type Lang = "ru" | "en";

const MODE_GUIDES: Record<OnboardingMode, Record<Lang, ModeGuide>> = {
    texthooker: {
        ru: {
            title: "Что такое TextHooker",
            lead: "Визуальные новеллы показывают текст картинкой: его нельзя выделить или найти в словаре. Хукер вытаскивает этот текст прямо из игры и складывает сюда строками.",
            points: [
                "Запусти игру и программу-хукер (Agent, Textractor или LunaTranslator) и подключи её как источник текста. Новые строки появятся здесь сами.",
                "Зажми Shift и наведи курсор на слово: откроется словарь. Из него слово добавляется в Anki одной кнопкой.",
                "Flow откроет прозрачное окно поверх игры, чтобы не переключаться между окнами.",
            ],
        },
        en: {
            title: "What is TextHooker",
            lead: "Visual novels draw their text as pictures, so you can't select it or look it up. A texthooker pulls that text out of the running game and lists it here line by line.",
            points: [
                "Start the game and a hooker program (Agent, Textractor or LunaTranslator) and connect it as a text source. New lines appear here on their own.",
                "Hold Shift and point at a word to open the dictionary. One button adds the word to Anki.",
                "Flow opens a see-through window over the game, so you don't have to switch windows.",
            ],
        },
    },
    epub: {
        ru: {
            title: "Читалка",
            lead: "Здесь читаются книги, ранобэ и манга: EPUB, TXT, FB2, PDF, CBZ и другие форматы. Положи файл в библиотеку, и Setsuna запомнит, где ты остановился.",
            points: [
                "Зажми Shift и наведи курсор на слово, чтобы открыть словарь. Shift+клик тоже работает.",
                "В манге текст на картинке становится кликабельным, если у тома есть слой Mokuro.",
                "Esc открывает меню книги: оглавление, настройки шрифта и вида.",
            ],
        },
        en: {
            title: "Reader",
            lead: "Read books, light novels and manga here: EPUB, TXT, FB2, PDF, CBZ and more. Add a file to the library and Setsuna remembers where you stopped.",
            points: [
                "Hold Shift and point at a word to open the dictionary. Shift+click works too.",
                "In manga, the text on the page becomes clickable when the volume has a Mokuro layer.",
                "Esc opens the book menu: contents, font and layout settings.",
            ],
        },
    },
    player: {
        ru: {
            title: "Видео-плеер",
            lead: "Плеер для аниме и сериалов с японскими субтитрами. Каждое слово в субтитрах можно найти в словаре, а сцену сохранить в карточку Anki вместе с кадром и звуком.",
            points: [
                "Открой видео и подключи файл субтитров, если он не встроен.",
                "Наведи курсор на слово в субтитрах: видео встанет на паузу и откроется словарь.",
                "Кнопка добавления в Anki сохраняет слово, предложение, кадр и звук фразы.",
            ],
        },
        en: {
            title: "Video player",
            lead: "A player for anime and shows with Japanese subtitles. Look up any word in the subtitles and save the scene to an Anki card with its frame and audio.",
            points: [
                "Open a video and add a subtitle file if it isn't built in.",
                "Point at a word in the subtitles: the video pauses and the dictionary opens.",
                "The Anki button saves the word, the sentence, the frame and the line's audio.",
            ],
        },
    },
};

const TEXTHOOKER_TIPS: Record<Lang, CoachStep[]> = {
    ru: [
        {
            id: "texthooker.tab",
            target: '[data-coach="tab"]',
            title: "Вкладка и все действия",
            body: "Название текущей вкладки и сколько символов в ней прочитано. Нажми, чтобы открыть меню: вкладки для разных игр, импорт, экспорт и настройки.",
        },
        {
            id: "texthooker.source",
            target: '[data-coach="source"]',
            title: "Источник текста",
            body: "Откуда приходят строки: здесь имя главного источника — подключения к программе-хукеру (Agent, Textractor, LunaTranslator) или «Буфер». Красная точка: не подключён, зелёная: текст идёт. Нажатие подключает или отключает.",
        },
        {
            id: "texthooker.flow",
            target: '[data-coach="flow"]',
            title: "Flow: окно поверх игры",
            body: "Прозрачное окно, которое висит над игрой. В нём видны новые строки и словарь, и не нужно сворачивать игру.",
        },
        {
            id: "texthooker.ai",
            target: '[data-coach="ai"]',
            title: "ИИ-объяснения",
            body: "Открывает панель, где локальная нейросеть разбирает строку: перевод, грамматика, сложные места. Работает без интернета.",
        },
        {
            id: "texthooker.menu",
            target: '[data-coach="menu"]',
            title: "Меню (Esc)",
            body: "То же меню, что по клавише Esc: вкладки, источники текста, колода Anki для вкладки и настройки.",
        },
        {
            id: "texthooker.stats",
            target: '[data-coach="stats"]',
            title: "Статистика и таймер",
            body: "Символы, слова, предложения, время и скорость чтения. Таймер считает время, пока ты читаешь, и сам встаёт на паузу, если долго ничего не происходит. Панель можно перетащить мышью.",
        },
        {
            id: "texthooker.lookup",
            target: "[data-line-index]",
            pick: "last",
            title: "Как открыть словарь",
            body: "Зажми Shift и веди курсором по тексту: слово под курсором сразу откроется в словаре. Внутри словаря Shift тоже работает, так можно уходить вглубь. Клавишу можно поменять в настройках лукапа.",
        },
    ],
    en: [
        {
            id: "texthooker.tab",
            target: '[data-coach="tab"]',
            title: "Tab and all actions",
            body: "The current tab's name and how many characters you've read in it. Click it to open the menu: tabs for different games, import, export and settings.",
        },
        {
            id: "texthooker.source",
            target: '[data-coach="source"]',
            title: "Text source",
            body: "Where lines come from: the name of the main source, a connection to a hooker program (Agent, Textractor, LunaTranslator) or \"Clipboard\". Red dot: not connected, green: text is coming in. Click to connect or disconnect.",
        },
        {
            id: "texthooker.flow",
            target: '[data-coach="flow"]',
            title: "Flow: a window over the game",
            body: "A see-through window that stays on top of the game. New lines and the dictionary show up in it, so you don't have to minimise the game.",
        },
        {
            id: "texthooker.ai",
            target: '[data-coach="ai"]',
            title: "AI explanations",
            body: "Opens a panel where a local model breaks a line down: translation, grammar, tricky parts. Works offline.",
        },
        {
            id: "texthooker.menu",
            target: '[data-coach="menu"]',
            title: "Menu (Esc)",
            body: "The same menu as the Esc key: tabs, text sources, the Anki deck for this tab and settings.",
        },
        {
            id: "texthooker.stats",
            target: '[data-coach="stats"]',
            title: "Stats and timer",
            body: "Characters, words, sentences, time and reading speed. The timer runs while you read and pauses itself when nothing happens for a while. Drag the panel to move it.",
        },
        {
            id: "texthooker.lookup",
            target: "[data-line-index]",
            pick: "last",
            title: "How to open the dictionary",
            body: "Hold Shift and move the pointer over the text: the word under it opens in the dictionary. Shift works inside the dictionary too, to look up words in a definition. You can change the key in the lookup settings.",
        },
    ],
};

/** Lines a clean install starts with, to try the dictionary on (Umineko, Episode 4). */
export const ONBOARDING_SAMPLE_LINES: readonly string[] = [
    "俺達は、永遠にずっと一緒だ",
    "We'll be together for all eternity.",
];

export const modeGuide = (mode: OnboardingMode, language: string): ModeGuide =>
    isMobilePlatform() ? mobileModeGuide(mode, language) : MODE_GUIDES[mode][language === "en" ? "en" : "ru"];

export const modeTips = (mode: OnboardingMode, language: string): CoachStep[] =>
    isMobilePlatform() ? mobileModeTips(mode, language)
        : mode === "texthooker" ? TEXTHOOKER_TIPS[language === "en" ? "en" : "ru"]
        : mode === "epub" ? readerTips(language)
            : playerTips(language);
