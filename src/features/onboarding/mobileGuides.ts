import type { CoachStep, ModeGuide } from "./guides";
import type { OnboardingMode } from "./onboardingStore";

// Phone versions of the mode introductions and button tips: taps instead of
// Shift and the mouse, Android's own pieces (AnkiDroid, the Flow bubble, the
// folder picker), and targets in the phone layout (island, dock, sheets).

type Lang = "ru" | "en";
type Tip = [id: string, target: string, ruTitle: string, ruBody: string, enTitle: string, enBody: string, pick?: "last"];

const steps = (tips: Tip[], language: string): CoachStep[] => {
    const en = language === "en";
    return tips.map(([id, target, ruTitle, ruBody, enTitle, enBody, pick]) => ({
        id,
        target,
        pick,
        title: en ? enTitle : ruTitle,
        body: en ? enBody : ruBody,
    }));
};

const coach = (name: string) => `[data-coach="${name}"]`;

export const MOBILE_MODE_GUIDES: Record<OnboardingMode, Record<Lang, ModeGuide>> = {
    texthooker: {
        ru: {
            title: "TextHooker на телефоне",
            lead: "Сюда приходят строки из игры: с ПК или Steam Deck по Wi-Fi, из общего доступа Android или из Setsuna Flow. Каждое слово можно найти в словаре и отправить в AnkiDroid.",
            points: [
                "Подключи источник: Настройки → Источник текста. Там же автопоиск находит хукеры в твоей сети Wi-Fi.",
                "Нажми на слово, и снизу откроется словарь. Из него слово уходит в AnkiDroid одной кнопкой.",
                "Setsuna Flow — плавающее окно поверх других приложений: читать и искать слова, не выходя из игры.",
            ],
        },
        en: {
            title: "TextHooker on the phone",
            lead: "Lines from the game arrive here: from a PC or Steam Deck over Wi-Fi, from Android's Share menu or from Setsuna Flow. Look up any word and send it to AnkiDroid.",
            points: [
                "Connect a source: Settings → Text source. Auto-find there spots hookers on your Wi-Fi.",
                "Tap a word and the dictionary slides up. One button sends the word to AnkiDroid.",
                "Setsuna Flow is a floating window over other apps: read and look up words without leaving the game.",
            ],
        },
    },
    epub: {
        ru: {
            title: "Читалка",
            lead: "Книги, ранобэ и манга: EPUB, TXT, FB2, PDF, CBZ и другие форматы. Setsuna запоминает, где ты остановился, и может синхронизировать место с ПК через Google Drive.",
            points: [
                "Нажми на слово, чтобы открыть словарь. В вертикальном тексте словарь выезжает сбоку, а предложение остаётся рядом.",
                "В манге текст на странице становится нажимаемым, если у тома есть слой Mokuro или включено распознавание.",
                "Страницы можно листать кнопками громкости: Настройки → Читалка и манга OCR.",
            ],
        },
        en: {
            title: "Reader",
            lead: "Books, light novels and manga: EPUB, TXT, FB2, PDF, CBZ and more. Setsuna remembers where you stopped and can sync your place with the PC through Google Drive.",
            points: [
                "Tap a word to open the dictionary. In vertical text it slides in from the side and the sentence stays next to it.",
                "In manga, text on the page becomes tappable when the volume has a Mokuro layer or recognition is on.",
                "Turn pages with the volume keys: Settings → Reader & manga OCR.",
            ],
        },
    },
    player: {
        ru: {
            title: "Видео-плеер",
            lead: "Аниме и сериалы с японскими субтитрами. Любое слово в субтитрах — в словарь, а сцену — в AnkiDroid вместе с кадром и звуком.",
            points: [
                "Добавь папку с сериалами: Setsuna разложит серии по тайтлам, подберёт субтитры и запомнит, где ты остановился.",
                "Или открой отдельные файлы: выбери серии вместе с файлами субтитров.",
                "Нажми на слово в субтитрах: видео встанет на паузу и откроется словарь.",
            ],
        },
        en: {
            title: "Video player",
            lead: "Anime and shows with Japanese subtitles. Any word in the subtitles goes to the dictionary, and the scene goes to AnkiDroid with its frame and audio.",
            points: [
                "Add a folder with your shows: Setsuna sorts episodes into titles, matches subtitles and remembers where you stopped.",
                "Or open single files: pick episodes together with their subtitle files.",
                "Tap a word in the subtitles: the video pauses and the dictionary opens.",
            ],
        },
    },
};

const TEXTHOOKER: Tip[] = [
    ["m.texthooker.island", coach("m-island"),
        "Вкладка", "Название текущей вкладки и сколько символов в ней прочитано. Нажми, чтобы открыть все вкладки, импорт, экспорт и «Читать вместе».",
        "Tab", "The current tab and how many characters you've read in it. Tap for all tabs, import, export and Read together."],
    ["m.texthooker.source", coach("m-source"),
        "Источник текста", "Зелёная точка — строки идут, жёлтая — подключаюсь, красная — источник не подключён. Нажми, чтобы открыть список источников.",
        "Text source", "Green: lines are coming in, yellow: connecting, red: no source. Tap to open the list of sources."],
    ["m.texthooker.lookup", "[data-line-index]",
        "Как открыть словарь", "Нажми на слово в строке: снизу откроется словарь. Внутри словаря тоже можно нажимать на слова. Свайп вниз закрывает.",
        "Open the dictionary", "Tap a word in a line and the dictionary slides up. Words inside it are tappable too. Swipe down to close.", "last"],
    ["m.texthooker.timer", coach("m-dock-timer"),
        "Таймер чтения", "Считает время и скорость чтения. Нажми, чтобы поставить на паузу или продолжить. Если долго ничего не происходит, встаёт на паузу сам.",
        "Reading timer", "Counts reading time and speed. Tap to pause or resume; it pauses itself when nothing happens for a while."],
    ["m.texthooker.tabs", coach("m-dock-tabs"),
        "Вкладки", "Отдельная вкладка для каждой игры: переключение, переименование, архив, импорт и экспорт.",
        "Tabs", "One tab per game: switch, rename, archive, import and export."],
    ["m.texthooker.input", coach("m-dock-input"),
        "Ввод и поиск", "Вставь или напечатай свой текст, чтобы разобрать его, или найди строку во вкладке.",
        "Type & search", "Paste or type your own text to read it, or search the tab's lines."],
    ["m.texthooker.flow", coach("m-dock-flow"),
        "Setsuna Flow", "Плавающее окно поверх игры. Показывает новые строки и словарь, не выходя из игры. Нужно разрешение «поверх других приложений».",
        "Setsuna Flow", "A floating window over the game with new lines and the dictionary. Needs the “display over other apps” permission."],
    ["m.texthooker.settings", coach("m-dock-settings"),
        "Настройки", "Источники текста, словари, AnkiDroid, Google Drive, вид текста и всё остальное.",
        "Settings", "Text sources, dictionaries, AnkiDroid, Google Drive, text look and everything else."],
];

const TABS_SHEET: Tip[] = [
    ["m.tabs.list", ".m-tab-row",
        "Вкладки", "Нажми на вкладку, чтобы перейти к ней. Карандаш — переименовать, стрелка — в архив, крестик — закрыть. Цветная точка — статус: читаю, отложено, прочитано.",
        "Tabs", "Tap a tab to switch to it. Pencil: rename, arrow: archive, cross: close. The coloured dot is its status: reading, on hold, finished."],
    ["m.tabs.new", coach("m-tabs-new"),
        "Новая вкладка", "Пустая вкладка для новой игры или книги.",
        "New tab", "An empty tab for a new game or book."],
    ["m.tabs.together", coach("m-tabs-together"),
        "Читать вместе", "Транслируй вкладку друзьям по коду или подключись к чужой: строки приходят у всех сразу.",
        "Read together", "Broadcast this tab to friends by a code, or join theirs: lines arrive for everyone at once."],
    ["m.tabs.stats", coach("m-tabs-stats"),
        "Статистика", "Сколько прочитано за день и за всё время, скорость чтения.",
        "Stats", "How much you read today and overall, and your reading speed."],
    ["m.tabs.import", coach("m-tabs-import"),
        "Импорт и экспорт", "Загрузить строки из TXT/JSON или сохранить вкладку, чтобы перенести её на другое устройство.",
        "Import & export", "Load lines from TXT/JSON, or save the tab to move it to another device."],
];

const SETTINGS_HOME: Tip[] = [
    ["m.settings.source", coach("m-settings-source"),
        "Источник текста", "Откуда приходят строки: хукеры на ПК или Steam Deck по Wi-Fi. Можно добавить несколько и выбрать основной.",
        "Text source", "Where lines come from: hookers on a PC or Steam Deck over Wi-Fi. Add several and pick the main one."],
    ["m.settings.dictionaries", coach("m-settings-data"),
        "Словари", "Импорт словарей Yomitan, их порядок, обновления и обмен словарями по коду.",
        "Dictionaries", "Import Yomitan dictionaries, their order, updates and sharing by code."],
    ["m.settings.drive", coach("m-settings-drive"),
        "Google Drive", "Резервные копии вкладок и настроек и перенос всех словарей с ПК на телефон одним файлом.",
        "Google Drive", "Backups of tabs and settings, and moving all dictionaries from the PC to the phone as one file."],
    ["m.settings.flow", coach("m-settings-flow"),
        "Setsuna Flow", "Плавающее окно поверх игры: его размер, прозрачность и поведение.",
        "Setsuna Flow", "The floating window over the game: size, transparency and behaviour."],
    ["m.settings.anki", coach("m-settings-anki"),
        "AnkiDroid", "Колода и тип карточек, какие поля заполнять и что делать с дубликатами.",
        "AnkiDroid", "Deck and note type, which fields to fill and what to do with duplicates."],
    ["m.settings.display", coach("m-settings-reading"),
        "Текстхукер и вид", "Тема, язык, размер текста, фуригана, таймер и фильтры строк.",
        "TextHooker & look", "Theme, language, text size, furigana, timer and line filters."],
    ["m.settings.reader", coach("m-settings-reader"),
        "Читалка и манга OCR", "Вид книг, листание кнопками громкости, синхронизация и распознавание текста в манге.",
        "Reader & manga OCR", "Book look, volume-key paging, sync and text recognition in manga."],
    ["m.settings.player", coach("m-settings-player"),
        "Видео-плеер", "Колода, формат клипа для карточек и показ субтитров.",
        "Video player", "Deck, clip format for cards and subtitle display."],
    ["m.settings.updates", coach("m-settings-updates"),
        "Обновления", "Текущая версия и проверка новой. Setsuna может проверять обновления сама при запуске.",
        "Updates", "Your version and a check for a new one. Setsuna can check on launch by itself."],
    ["m.settings.feedback", coach("m-settings-feedback"),
        "Обратная связь", "Сообщить об ошибке или предложить идею. К письму можно приложить журнал диагностики.",
        "Feedback", "Report a bug or suggest an idea. You can attach the diagnostics log."],
];

const SETTINGS_SOURCE: Tip[] = [
    ["m.source.list", ".m-source-item",
        "Источник", "Переключатель включает и выключает этот источник. ★ — основной: он подключается сам при запуске и работает в фоне.",
        "A source", "The switch turns this source on or off. ★ is the main one: it connects on launch and keeps working in the background."],
    ["m.source.add", coach("m-source-add"),
        "Добавить по адресу", "Адрес вида ws://192.168.0.40:9003 показывает сам хукер (Agent, Textractor, LunaTranslator) в своих настройках WebSocket.",
        "Add by address", "The hooker itself (Agent, Textractor, LunaTranslator) shows an address like ws://192.168.0.40:9003 in its WebSocket settings."],
    ["m.source.find", coach("m-source-find"),
        "Автопоиск", "Ищет запущенные хукеры во всей сети Wi-Fi и показывает все найденные: добавь нужные одной кнопкой.",
        "Auto-find", "Looks for running hookers on your whole Wi-Fi and lists everything it finds; add the ones you need with one tap."],
];

const SETTINGS_DRIVE: Tip[] = [
    ["m.drive.backup", coach("m-drive-backup"),
        "Копия Setsuna", "Вкладки, текст, таймеры и настройки в твоём Google Drive. Совместимо с копиями с ПК.",
        "Setsuna backup", "Tabs, text, timers and settings in your Google Drive. Works with backups from the PC."],
    ["m.drive.dictionaries", ".m-dict-sync",
        "Словари", "Сохрани все словари на ПК в Google Drive и скачай их здесь одним файлом — без импорта по одному.",
        "Dictionaries", "Save all dictionaries to Google Drive on the PC and download them here as one file, no importing one by one."],
];

const PLAYER_HOME: Tip[] = [
    ["m.player.open", ".spm-open-main",
        "Открыть видео", "Выбери серии вместе с файлами субтитров: субтитры подберутся по именам.",
        "Open a video", "Pick episodes together with their subtitle files; subtitles are matched by name."],
    ["m.player.folder", ".spm-folder-add, .spm-home .sp-library-primary",
        "Папка с сериалами", "Добавь папку один раз: Setsuna разложит серии по тайтлам, найдёт обложки и будет помнить прогресс.",
        "A folder with shows", "Add a folder once: Setsuna sorts episodes into titles, finds posters and remembers your progress."],
    ["m.player.url", coach("m-player-url"),
        "По ссылке", "Открыть видео по прямой ссылке из интернета.",
        "From a link", "Open a video from a direct web link."],
    ["m.player.deck", coach("m-player-deck"),
        "Колода", "Колода AnkiDroid для карточек из видео.",
        "Deck", "The AnkiDroid deck for cards from videos."],
    ["m.player.recent", ".spm-recent-row",
        "Недавно открытые", "Файлы, открытые по одному. Выбери файл снова — продолжится с того же места. Крестик убирает его из списка.",
        "Recently opened", "Files opened one by one. Pick the file again to resume. The cross removes it from the list."],
];

export const mobileModeGuide = (mode: OnboardingMode, language: string): ModeGuide =>
    MOBILE_MODE_GUIDES[mode][language === "en" ? "en" : "ru"];

export const mobileModeTips = (mode: OnboardingMode, language: string): CoachStep[] =>
    mode === "texthooker" ? steps(TEXTHOOKER, language)
        : mode === "player" ? steps(PLAYER_HOME, language)
            : [];

export const mobileTabsTips = (language: string) => steps(TABS_SHEET, language);

export const mobileSettingsTips = (section: string | null, language: string): CoachStep[] =>
    section === null ? steps(SETTINGS_HOME, language)
        : section === "source" ? steps(SETTINGS_SOURCE, language)
            : section === "drive" ? steps(SETTINGS_DRIVE, language)
                : [];
