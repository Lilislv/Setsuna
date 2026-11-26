import type { CoachStep } from "./guides";

// First-time tips for the Esc menu and every settings section. Each settings
// card is targeted by its existing id (the same ids the settings search uses).

type Lang = "ru" | "en";
type Tip = [id: string, target: string, ruTitle: string, ruBody: string, enTitle: string, enBody: string];

const build = (tips: Tip[], language: string): CoachStep[] => {
    const en = language === "en";
    return tips.map(([id, target, ruTitle, ruBody, enTitle, enBody]) => ({
        id,
        target,
        title: en ? enTitle : ruTitle,
        body: en ? enBody : ruBody,
    }));
};

const MENU: Tip[] = [
    ["menu.tabs", ".app-menu-tabs-column",
        "Вкладки", "Каждая вкладка — отдельная игра или книга со своими строками, статистикой и колодой Anki. Клик открывает вкладку, двойной клик переименовывает, перетаскивание меняет порядок, правый клик — статус, колода, архив и удаление.",
        "Tabs", "Each tab is a separate game or book with its own lines, stats and Anki deck. Click to open, double-click to rename, drag to reorder, right-click for status, deck, archive and delete."],
    ["menu.add", '[data-coach="menu-add"]',
        "Новая вкладка", "Создаёт пустую вкладку. Удобно завести по вкладке на каждую игру, чтобы строки и статистика не смешивались.",
        "New tab", "Creates an empty tab. One tab per game keeps lines and stats apart."],
    ["menu.archive", ".app-menu-archive-toggle",
        "Архив", "Прочитанные вкладки можно убрать в архив: они не мешают в списке, но строки и статистика сохраняются. Отсюда их можно вернуть.",
        "Archive", "Move finished tabs here: they leave the list but keep their lines and stats. You can bring them back from here."],
    ["menu.sources", ".app-menu-source-list",
        "Источники текста", "Откуда приходят строки. Любой хукер (Agent, Textractor, LunaTranslator) умеет отдавать текст и по WebSocket — прямому каналу, и через буфер обмена. WebSocket-подключения названы так, как ты их назвал; «Буфер» берёт всё, что копируется (Ctrl+C). Красная точка: выключен, зелёная: подключён.",
        "Text sources", "Where lines come from. Any hooker (Agent, Textractor, LunaTranslator) can send text over WebSocket, a direct channel, or through the clipboard. WebSocket connections carry the names you gave them; \"Clipboard\" takes whatever is copied (Ctrl+C). Red dot: off, green: connected."],
    ["menu.capture", '[data-coach="menu-capture"]',
        "Захват", "Выбери окно игры. Тогда скриншоты для карточек Anki будут сниматься именно с него, а агент будет знать, откуда брать текст.",
        "Capture", "Pick the game window. Screenshots for Anki cards are then taken from it, and the agent knows where to read text."],
    ["menu.deck", '[data-coach="menu-deck"]',
        "Колода для вкладки", "Своя колода Anki для этой вкладки: карточки из этой игры пойдут в неё. «Как в настройках» — общая колода.",
        "Deck for this tab", "A separate Anki deck for this tab: cards from this game go there. \"As in settings\" uses the main deck."],
    ["menu.shared", '[data-coach="menu-shared"]',
        "Читать вместе", "Транслируй вкладку другу по короткому коду или подключись к чужой: строки будут приходить вам обоим.",
        "Read together", "Share this tab with a friend by a short code, or join theirs: you both get the same lines."],
    ["menu.flow", '[data-coach="menu-flow"]',
        "Flow", "Прозрачное окно поверх игры с последней строкой и словарём. Можно читать и искать слова, не сворачивая игру.",
        "Flow", "A see-through window over the game with the latest line and the dictionary, so you never leave the game."],
    ["menu.search", '[data-coach="menu-search"]',
        "Поиск", "Поиск по всем строкам вкладки (Ctrl+F): найти фразу, которую видел раньше.",
        "Search", "Search all lines of the tab (Ctrl+F) to find a phrase you saw earlier."],
    ["menu.settings", '[data-coach="menu-settings"]',
        "Настройки", "Все настройки Setsuna: вид текста, источники, словари, Anki, плеер и читалка.",
        "Settings", "All of Setsuna's settings: text look, sources, dictionaries, Anki, player and reader."],
    ["menu.importexport", ".app-menu-footer-actions",
        "Импорт, экспорт и главный экран", "Импорт загружает строки из файла во вкладку, экспорт сохраняет их в файл. «Главный экран» возвращает к выбору режима. «Очистить вкладку» удаляет все строки этой вкладки.",
        "Import, export and home", "Import loads lines from a file into the tab, export saves them to a file. \"Home screen\" goes back to choosing a mode. \"Clear tab\" deletes every line in this tab."],
];

const SETTINGS_SHELL: Tip[] = [
    ["settings.nav", ".settings-navigation",
        "Разделы настроек", "Слева все разделы: чтение (текст, читалка, плеер, Flow), инструменты (лукап, Anki, ИИ) и сервисы. У разделов с подпунктами можно сразу прыгнуть к нужной группе.",
        "Settings sections", "All sections are on the left: reading (text, reader, player, Flow), tools (lookup, Anki, AI) and services. Sections with sub-items jump straight to a group."],
    ["settings.actions", ".settings-topbar-actions",
        "Предпросмотр, мастер и сброс", "«Скрыть для предпросмотра» убирает окно настроек, чтобы увидеть, как выглядит текст. «Мастер» заново проводит через первую настройку. «Сброс» возвращает настройки по умолчанию.",
        "Preview, wizard and reset", "\"Hide for preview\" moves settings away so you can see the text. \"Wizard\" runs the first-time setup again. \"Reset\" restores the defaults."],
];

const SETTINGS: Record<string, Tip[]> = {
    text: [
        ["settings.text-app", "#text-app",
            "Внешний вид", "Тема и язык программы, размер и шрифт текста, где держать новую строку при автопрокрутке, фуригана над кандзи и направление текста (горизонтально или вертикально, как в книгах).",
            "Appearance", "Theme and language, text size and font, where the newest line sits while auto-scrolling, furigana over kanji, and text direction (horizontal or vertical, like Japanese books)."],
        ["settings.text-stats", "#text-stats",
            "Панель статистики", "Где показывать счётчики (строки, символы, время, скорость), в чём мерить скорость и за какой период. Таймер может сам вставать на паузу, если ты не читаешь несколько минут.",
            "Stats panel", "Where the counters go (lines, characters, time, speed), how speed is measured and over what period. The timer can pause itself after a few idle minutes."],
        ["settings.text-src", "#text-src",
            "Источники", "Адреса WebSocket — каналов, по которым хукеры вроде Luna и Textractor присылают текст. «Авто-поиск» сканирует этот ПК и локальную сеть (LAN) и показывает список всех найденных хукеров.",
            "Sources", "WebSocket addresses: the channels hookers like Luna and Textractor send text through. \"Auto find\" scans this PC and your local network (LAN) and lists every hooker it finds."],
        ["settings.text-filters", "#text-filters",
            "Фильтры", "Чистка входящих строк: убрать мусор и служебные символы, пропускать повторы одной и той же строки, убирать пробелы. Ниже — свои замены: «найти → заменить», простым текстом или регулярным выражением.",
            "Filters", "Clean incoming lines: strip junk and control characters, skip repeats of the same line, remove spaces. Below: your own find → replace rules, as plain text or a regular expression."],
    ],
    epub: [
        ["settings.epub-reader", "#epub-reader",
            "Вид читалки", "Тема страницы (как в приложении, тёмная, бумага, сепия), режим чтения — страницами или прокруткой, шрифт и размер текста книги.",
            "Reader look", "Page theme (app, dark, paper, sepia), reading mode (pages or scrolling), and the book's font and size."],
        ["settings.epub-layout", "#epub-layout",
            "Раскладка и картинки", "Показывать ли иллюстрации, размывать их от спойлеров, фуригана в книгах и ширина колонки текста.",
            "Layout and images", "Whether to show illustrations, blur them against spoilers, furigana in books, and the text column width."],
        ["settings.epub-manga", "#epub-manga",
            "Манга и OCR", "Распознавание текста на страницах манги. Mokuro делает кликабельный слой для всего тома, сервер OCR на ПК помогает телефону распознавать отдельные баблы.",
            "Manga and OCR", "Text recognition on manga pages. Mokuro builds a clickable layer for a whole volume; the PC OCR server lets the phone recognise single bubbles."],
    ],
    player: [
        ["settings.player-main", "#player-main",
            "Плеер и погружение", "Как работают стрелки (по секундам или между репликами), шаг перемотки и сдвига субтитров, пропуск пауз без речи.",
            "Player and immersion", "What the arrow keys do (seconds or between subtitle lines), seek and subtitle-shift steps, skipping silent gaps."],
        ["settings.player-mining", "#player-mining",
            "Карточки из плеера", "Что прикладывать к карточке Anki: видео с оригинальным звуком или только звук реплики, и в каком качестве. Можно сразу переиграть сохранённый отрывок.",
            "Cards from the player", "What to attach to the Anki card: video with the original audio or just the line's audio, and at what quality. Replay the saved clip right away."],
        ["settings.player-binds", "#player-binds",
            "Клавиши", "Горячие клавиши плеера: пауза, перемотка, повтор реплики, дополнить последнюю карточку, скопировать реплику и сдвиг субтитров.",
            "Keys", "Player shortcuts: pause, seek, replay line, attach clip to the last card, copy line and subtitle offset."],
    ],
    jl: [
        ["settings.jl-main", "#jl-main",
            "Setsuna Flow", "Окно поверх игры с последней строкой: шрифт и его размер, прозрачность, отступы, как открывать словарь (клик или наведение) и прятать ли его при новой строке.",
            "Setsuna Flow", "The window over the game with the latest line: font and size, transparency, padding, how to open the dictionary (click or hover) and whether to hide it on a new line."],
    ],
    lookup: [
        ["settings.lookup-win", "#lookup-win",
            "Окно словаря и клавиши", "«Лукап внутри Setsuna» — клавиша, которую держишь, наводя курсор на слово (по умолчанию Shift). «Скан по всему Windows» — сочетание (по умолчанию Shift+Z), с которым словарь открывается над текстом в любой программе. Ниже размер, ширина и шрифт окна.",
            "Dictionary window and keys", "\"Lookup inside Setsuna\" is the key you hold while pointing at a word (Shift by default). \"Live scan across Windows\" is the combo (Shift+Z by default) that opens the dictionary over text in any program. Below: size, width and font of the window."],
        ["settings.lookup-dicts", "#lookup-dicts",
            "Словари", "Какие словари установлены, в каком порядке показываются, импорт новых (формат Yomitan) и проверка обновлений. Перетаскивание меняет порядок.",
            "Dictionaries", "Which dictionaries are installed and in what order they show, importing new ones (Yomitan format) and checking for updates. Drag to reorder."],
    ],
    anki: [
        ["settings.anki-connect", '#anki-connection[data-anki-state="disconnected"]',
            "Подключение Anki", "Anki пока не найден. Для создания карточек нужен Anki с дополнением AnkiConnect (код 2055492159), а на телефоне — разрешение AnkiDroid. Нажми «Подключить автоматически» — настройки колод, полей и скриншотов появятся сразу после подключения.",
            "Connecting Anki", "Anki is not connected yet. Cards need desktop Anki with the AnkiConnect add-on (code 2055492159), or AnkiDroid permission on Android. Click \"Connect automatically\" — deck, field and screenshot settings appear right after connecting."],
        ["settings.anki-connected", '#anki-connection[data-anki-state="connected"]',
            "Anki подключён", "Связь с Anki работает — можно создавать карточки прямо из словаря и плеера. Если создашь новую колоду или тип заметки в Anki, нажми «Обновить подключение», чтобы список подгрузился.",
            "Anki connected", "Anki is ready for new cards from the dictionary and player. If you create a new deck or note type in Anki, click \"Refresh connection\" to reload the list."],
        ["settings.anki-cards", "#anki-cards",
            "Карточки Anki", "Колода и тип карточек. Рекомендуются Setsuna Japanese и Lapis: с ними все поля заполняются сами. «Куда добавлять» — одна колода или своя для каждой вкладки. «Для опытных» — ручная раскладка полей.",
            "Anki cards", "Deck and note type. Setsuna Japanese and Lapis are recommended: every field fills itself. \"Deck routing\": one deck or one per tab. \"Advanced\": map the fields by hand."],
        ["settings.anki-audio", "#anki-audio",
            "Озвучка слов", "Откуда брать произношение для карточек и словаря: из интернета (JapanesePod101), из локальной базы озвучки без интернета или по очереди. Работает в словаре даже без Anki.",
            "Word audio", "Where pronunciation comes from for dictionary playback and cards: online (JapanesePod101), a local offline audio database, or both in order. Works in the dictionary even before connecting Anki."],
        ["settings.anki-hooks", "#anki-hooks",
            "Скриншоты", "Какие кнопки показывать в словаре (просто добавить или добавить с картинкой) и с какого окна снимать скриншот — выбери процесс игры.",
            "Screenshots", "Which buttons the dictionary shows (add, or add with a picture) and which window the screenshot is taken from: pick the game's process."],
        ["settings.anki-dupes", "#anki-dupes",
            "Проверка дубликатов", "Настройка цветов кнопки «+» для новых слов, слов из других колод и дублей в текущей колоде, а также разрешение добавлять повторные карточки.",
            "Duplicate check", "Customise the \"+\" button colors for new words, cards in other decks and cards in the same deck, and control whether duplicates can still be added."],
    ],
    ai: [
        ["settings.ai-main", "#ai-main",
            "ИИ-объяснения", "Локальная нейросеть, которая разбирает строку: перевод, грамматика, сложные места. Здесь её скачивание, выбор модели и запуск. Работает без интернета, но требует место на диске и память.",
            "AI explanations", "A local model that breaks a line down: translation, grammar, tricky parts. Download, pick and start it here. Works offline but needs disk space and memory."],
    ],
    cloud: [
        ["settings.cloud-connect", '#cloud-connection[data-drive-state="disconnected"]',
            "Подключить Google Диск", "Здесь включается облачная синхронизация: книги и прогресс читалки сами переходят между ПК и телефоном, а настройки, вкладки и словари можно сохранять в бэкап. Все данные лежат в скрытой папке приложения — Setsuna не видит остальные файлы на твоём Диске.",
            "Connect Google Drive", "Turn on cloud sync here: reader books and progress move automatically between PC and phone, and settings, tabs and dictionaries can be backed up. Everything stays in a hidden app-only folder — Setsuna cannot see your other Drive files."],
        ["settings.cloud-connected", '#cloud-connection[data-drive-state="connected"]',
            "Google Диск подключён", "Аккаунт привязан. «Обновить данные» заново проверяет квоту, список бэкапов и базу словарей в облаке. «Отключить» выходит из аккаунта только на этом устройстве и не удаляет файлы с Диска.",
            "Google Drive connected", "Your account is linked. \"Refresh data\" reloads quota, backup archive and the cloud dictionary database. \"Disconnect\" signs out on this device only without deleting cloud files."],
        ["settings.cloud-quota", "#cloud-quota",
            "Место на Диске", "Показывает, сколько места уже занято в твоём Google Диске и сколько свободно. Удобно проверить перед загрузкой архивов и базы словарей.",
            "Drive storage", "Shows how much space is used and free in your Google Drive — handy to check before uploading backups or a multi-gigabyte dictionary database."],
        ["settings.cloud-backup", "#cloud-backup",
            "Новый бэкап", "Создаёт снимок настроек и выбранных вкладок TextHooker в архиве Диска. Старые бэкапы при этом не затираются.",
            "New backup", "Saves a snapshot of your settings and selected TextHooker tabs into the Drive archive without overwriting older backups."],
        ["settings.cloud-archive", "#cloud-archive",
            "Архив бэкапов", "Список всех сохранённых копий (включая созданные старыми версиями). Нажми «Открыть», чтобы выборочно восстановить настройки или нужные вкладки.",
            "Backup archive", "Lists every saved snapshot (including older formats). Click \"Open\" to inspect and restore only the settings or tabs you want."],
        ["settings.cloud-dict", "#cloud-dict",
            "База словарей в облаке", "Переносит готовую базу словарей (dictionary.db) между устройствами без повторного импорта. Проверь размер базы и свободное место на Диске перед загрузкой.",
            "Dictionary database in cloud", "Transfers your compiled dictionary database (dictionary.db) between devices so you don't have to re-import zips. Check sizes and free space before uploading."],
    ],
    discord: [
        ["settings.discord-main", "#discord-main",
            "Discord", "Статус «Играет в Setsuna» в профиле Discord: что показывать (название, счётчики, таймер) и кнопки-ссылки. Выключи, если не хочешь, чтобы друзья видели, что ты читаешь.",
            "Discord", "The \"Playing Setsuna\" status on your Discord profile: what to show (title, counters, timer) and link buttons. Turn it off if you don't want friends to see what you read."],
    ],
    updates: [
        ["settings.updates-main", "#updates-main",
            "Обновления", "Текущая версия и проверка новых. Setsuna может сама проверять обновления при запуске.",
            "Updates", "Your version and checking for new ones. Setsuna can check for updates on every start."],
    ],
    feedback: [
        ["settings.feedback-main", "#feedback-main",
            "Обратная связь", "Сообщи об ошибке или предложи идею: обращение уйдёт разработчикам.",
            "Feedback", "Report a bug or suggest an idea: it goes to the developers."],
    ],
};

const EPUB_MENU: Tip[] = [
    ["epub-menu.books", '[data-coach="epub-menu-books"]',
        "Книги в библиотеке", "Быстрое переключение между книгами и томами манги прямо из чтения. Процент справа показывает, сколько уже прочитано.",
        "Library books", "Jump straight between your books and manga volumes while reading. The percent on the right is your progress."],
    ["epub-menu.add", '[data-coach="epub-menu-add"]',
        "Добавить файл", "Быстро открыть новый файл EPUB, FB2, PDF, TXT или мангу.",
        "Open a file", "Quickly open a new EPUB, FB2, PDF, TXT or manga archive."],
    ["epub-menu.library", '[data-coach="epub-menu-library"]',
        "Библиотека", "Перейти к полному экрану библиотеки со всеми обложками, фильтрами, полками и поиском.",
        "Library", "Go back to the full library grid with covers, filters, shelves and search."],
    ["epub-menu.open", '[data-coach="epub-menu-open"]',
        "Открыть книгу", "Выбрать файл книги или манги с диска — она откроется и сохранится в библиотеке.",
        "Open book", "Pick a book or manga file from disk to open and save to the library."],
    ["epub-menu.settings", '[data-coach="epub-menu-settings"]',
        "Настройки читалки", "Открывает настройки шрифта, раскладки, облачной синхронизации и OCR манги.",
        "Reader settings", "Opens settings for reader font, layout, Drive sync and manga OCR."],
    ["epub-menu.home", '[data-coach="epub-menu-home"]',
        "Главный экран", "Возвращает к выбору режима работы: TextHooker, Читалка или Видео-плеер.",
        "Home screen", "Returns to the mode picker: TextHooker, Reader or Video Player."],
];

const PLAYER_MENU: Tip[] = [
    ["player-menu.list", '[data-coach="player-menu-list"]',
        "Серии и видеотека", "В плеере здесь список серий текущего тайтла; на экране видеотеки — все ваши тайтлы для быстрого запуска.",
        "Episodes & library", "Inside playback this lists the current title's episodes; from the library it lists your shows."],
    ["player-menu.add", '[data-coach="player-menu-add"]',
        "Открыть видео", "Быстро выбрать видеофайл с диска.",
        "Open media", "Quickly pick a video file from disk."],
    ["player-menu.library", '[data-coach="player-menu-library"]',
        "Видеотека / К видео", "Переключает между общим списком тайтлов и открытым видео.",
        "Library / Back to video", "Switches between your video library and the active video."],
    ["player-menu.open", '[data-coach="player-menu-open"]',
        "Открыть видео…", "Выбрать видеофайл с компьютера; подходящие субтитры рядом подключатся сами.",
        "Open media…", "Pick a video file from your PC; matching subtitles next to it load automatically."],
    ["player-menu.url", '[data-coach="player-menu-url"]',
        "Открыть по URL", "Запустить видеопоток или страницу по прямой HTTPS-ссылке.",
        "Open URL", "Play a direct HTTPS stream or media link."],
    ["player-menu.deck", '[data-coach="player-menu-deck"]',
        "Колода Anki для плеера", "Задаёт отдельную колоду Anki для карточек, дополненных из видео.",
        "Player Anki deck", "Sets a separate Anki deck for cards mined with video clips."],
    ["player-menu.settings", '[data-coach="player-menu-settings"]',
        "Настройки плеера", "Открывает раздел настроек Видео-плеера: шаг перемотки, качество клипов и горячие клавиши.",
        "Player settings", "Opens Video Player settings: seek step, clip quality and shortcuts."],
    ["player-menu.home", '[data-coach="player-menu-home"]',
        "Главный экран", "Возвращает к выбору режима: TextHooker, Читалка или Видео-плеер.",
        "Home screen", "Returns to the mode picker: TextHooker, Reader or Video Player."],
];

export const menuTips = (language: string): CoachStep[] => build(MENU, language);
export const epubMenuTips = (language: string): CoachStep[] => build(EPUB_MENU, language);
export const playerMenuTips = (language: string): CoachStep[] => build(PLAYER_MENU, language);

export const settingsTips = (section: string, language: string): CoachStep[] =>
    build([...SETTINGS_SHELL, ...(SETTINGS[section] || [])], language);

export const SETTINGS_TIP_SECTIONS = Object.keys(SETTINGS);
export type { Lang };
