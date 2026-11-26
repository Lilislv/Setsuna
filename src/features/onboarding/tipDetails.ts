// Long explanations behind each tip's "More" button. Keys are tip ids from
// guides.ts, surfaceTips.ts and readerTips.ts. "## " starts a subheading,
// "• " a list item.

type Detail = { ru: string[]; en: string[] };

const SOURCES_RU = [
    "Сама Setsuna текст из игры не достаёт. Это делает отдельная программа-хукер: она подключается к запущенной игре, перехватывает строки, которые игра выводит на экран, и передаёт их дальше. Setsuna принимает эти строки и показывает их здесь, где по ним работает словарь.",
    "Главное: все популярные хукеры умеют передавать текст двумя способами — через буфер обмена и через WebSocket. Подойдёт любая программа из списка ниже, а способ ты выбираешь сам.",
    "## Программы для хука",
    "• Agent — хукер на скриптах для конкретных игр, в том числе для эмуляторов (Switch, PS Vita, PSP) и многих ПК-новелл. Буфер и WebSocket включаются в его настройках.",
    "• Textractor — классический бесплатный хукер для ПК-новелл. Буфер — расширение «Copy to Clipboard», которое идёт в комплекте; WebSocket — отдельное расширение (обычно на порту 6677).",
    "• LunaTranslator (LunaHook) — современный хукер с переводчиком. Умеет копировать в буфер, у него встроенный WebSocket-сервер, а если игру не получается хукнуть, он читает текст с экрана через OCR.",
    "Кнопка «Авто-поиск» в настройках источников проверяет обычные порты этих программ как на этом компьютере, так и по всей локальной сети (Wi-Fi / LAN), и показывает список всех найденных подключений — остаётся только нажать «Добавить».",
    "## WebSocket или буфер обмена",
    "WebSocket — это прямой канал между хукером и Setsuna. Хукер отправляет строку, Setsuna её сразу получает. Ничего лишнего туда не попадает, буфер обмена остаётся свободным: можно спокойно копировать ссылки и пароли. Некоторые хукеры передают вместе со строкой и фуригану. Нужно один раз указать адрес вроде ws://localhost:6677 или нажать «Автопоиск». Так можно подключиться даже к хукеру на другом компьютере в той же сети Wi-Fi.",
    "Буфер обмена — универсальный способ. Setsuna забирает всё, что попадает в буфер (Ctrl+C), поэтому работает с любым хукером, который умеет копировать текст, и даже с ручным копированием из браузера. Но в окно попадает вообще всё скопированное: случайная ссылка или пароль тоже станут строкой. И если хукер и ты копируете одновременно, строки могут перемешаться.",
    "Итого: если хукер умеет WebSocket, подключай его. Буфер — для программ без WebSocket и для быстрой проверки.",
    "## Что значат точки",
    "Красная — источник выключен или программа не запущена. Зелёная — подключено, строки идут. Мигает — Setsuna пытается подключиться. Главный источник подписан «основной», он подключается при запуске. Его название — то, как ты назвал подключение, например «ag» для Agent.",
];

const SOURCES_EN = [
    "Setsuna doesn't pull text out of games by itself. A separate hooker program attaches to the running game, intercepts the lines it draws and passes them on; Setsuna receives them and shows them here, where the dictionary works.",
    "The key point: every popular hooker can pass text both ways — through the clipboard and over WebSocket. Any program below works; you pick the way.",
    "## Hooker programs",
    "• Agent — a script-based hooker for specific games, including emulators (Switch, PS Vita, PSP) and many PC novels. Clipboard and WebSocket are switched on in its settings.",
    "• Textractor — the classic free hooker for PC novels. Clipboard comes with the bundled Copy to Clipboard extension; WebSocket is a separate extension (usually port 6677).",
    "• LunaTranslator (LunaHook) — a modern hooker with a translator. It copies to the clipboard, has a built-in WebSocket server, and reads the screen with OCR when a game can't be hooked.",
    "\"Auto find\" in the source settings scans these programs' usual ports on both this PC and your local network (Wi-Fi / LAN), then lists every running hooker it finds so you can add the ones you need.",
    "## WebSocket or clipboard",
    "WebSocket is a direct channel: the hooker sends a line and Setsuna gets it at once. Nothing else gets in and your clipboard stays free. Some hookers send furigana too. Set the address once (like ws://localhost:6677) or use Auto-search; it even works with a hooker on another PC on the same Wi-Fi.",
    "The clipboard is the universal fallback: Setsuna takes whatever lands there (Ctrl+C), so it works with any hooker that copies text, or with copying by hand. But everything you copy becomes a line, links and passwords included, and lines can mix if you and the hooker copy at the same time.",
    "In short: use WebSocket when the hooker supports it; the clipboard is for programs without it and quick tests.",
    "## The dots",
    "Red: off or the program isn't running. Green: connected, lines are coming in. Blinking: connecting. The main source (\"main\") connects on start; its name is whatever you called the connection, like \"ag\" for Agent.",
];

const DETAILS: Record<string, Detail> = {
    // TextHooker
    "texthooker.tab": {
        ru: [
            "Вкладка — это одна игра или один текст. У каждой вкладки свои строки, своя статистика чтения, свой статус (в планах, читаю, прочитано) и может быть своя колода Anki.",
            "Нажми на название, чтобы открыть меню (то же, что по Esc): там список всех вкладок, источники текста и действия. Число справа — сколько символов ты прочитал в этой вкладке.",
            "Совет: заведи по вкладке на каждую игру. Тогда статистика скорости будет честной, а карточки из разных игр можно разложить по разным колодам.",
        ],
        en: [
            "A tab is one game or one text, with its own lines, reading stats, status (planned, reading, finished) and optionally its own Anki deck.",
            "Click the name for the menu (same as Esc): all tabs, text sources and actions. The number is how many characters you've read in this tab.",
            "Tip: one tab per game keeps speed stats honest and lets cards from different games go to different decks.",
        ],
    },
    "texthooker.source": { ru: SOURCES_RU, en: SOURCES_EN },
    "texthooker.flow": {
        ru: [
            "Flow — отдельное маленькое окно, которое висит поверх игры. В нём видна последняя строка, и по ней работает словарь, так что не нужно переключаться между игрой и Setsuna.",
            "Окно можно двигать и менять его размер, прозрачность и шрифт («Настройки» → «Setsuna Flow»). Слово ищется по клику или наведению, как настроишь.",
            "Повторное нажатие закрывает Flow. Строки при этом продолжают приходить в основное окно.",
        ],
        en: [
            "Flow is a small separate window that stays on top of the game, showing the latest line with the dictionary, so you don't switch between the game and Setsuna.",
            "Move and resize it, change transparency and font in Settings → Setsuna Flow. Words are looked up on click or hover, as you choose.",
            "Click again to close Flow; lines keep coming into the main window.",
        ],
    },
    "texthooker.ai": {
        ru: [
            "Панель ИИ-объяснений: локальная нейросеть разбирает выбранную строку — даёт перевод, объясняет грамматику и сложные места.",
            "Модель работает прямо на твоём компьютере, без интернета и без отправки текста куда-либо. Скачать и выбрать модель можно в «Настройки» → «ИИ-объяснения». Ей нужно место на диске и память; на слабых ПК ответ может идти медленно.",
            "Можно выбрать сразу несколько строк (кнопка со списком у строки) и попросить объяснить их вместе.",
        ],
        en: [
            "The AI panel: a local model breaks down the chosen line — translation, grammar, tricky parts.",
            "It runs on your computer, offline, sending text nowhere. Download and pick a model in Settings → AI explanations; it needs disk space and memory, and can be slow on weak PCs.",
            "Select several lines (the list button on a line) to have them explained together.",
        ],
    },
    "texthooker.menu": {
        ru: [
            "Главное меню режима. Открывается этой кнопкой или клавишей Esc и закрывается тем же Esc.",
            "В нём: все вкладки, источники текста, захват окна игры, колода для вкладки, совместное чтение, Flow, поиск по строкам, настройки, импорт и экспорт строк, возврат на главный экран.",
        ],
        en: [
            "The mode's main menu: this button or Esc opens it, Esc closes it.",
            "Inside: all tabs, text sources, game window capture, the tab's deck, reading together, Flow, line search, settings, import/export and the home screen.",
        ],
    },
    "texthooker.stats": {
        ru: [
            "Счётчики сверху вниз: символы, слова, предложения, время чтения и скорость.",
            "Таймер идёт, пока ты читаешь. Если долго ничего не происходит (по умолчанию 5 минут), он сам встаёт на паузу, чтобы не накручивать время. Кнопка внизу ставит паузу вручную.",
            "Панель можно перетащить мышью в любое место, двойной клик возвращает её на место. Где её держать и в чём считать скорость — «Настройки» → «Текст» → «Панель статистики».",
        ],
        en: [
            "Top to bottom: characters, words, sentences, reading time and speed.",
            "The timer runs while you read and pauses itself after a while with nothing new (5 minutes by default), so time isn't inflated. The button pauses it by hand.",
            "Drag the panel anywhere; double-click puts it back. Position and speed units are in Settings → Text → Stats panel.",
        ],
    },
    "texthooker.lookup": {
        ru: [
            "## Внутри Setsuna",
            "Зажми Shift и веди курсором по тексту. Слово под курсором сразу открывается в словаре — кликать не нужно. Shift+клик тоже работает.",
            "Внутри окна словаря Shift работает так же: наведи на слово в определении, и поверх откроется следующее окно. Так можно уходить вглубь.",
            "Из окна словаря слово добавляется в Anki кнопкой «+», а «+ с камерой» добавляет ещё и скриншот игры.",
            "## Во всём Windows",
            "Зажми Shift+Z и веди курсором по тексту в любой программе: в браузере, Discord, даже в самой игре. Словарь откроется отдельным окном. Клик мимо его закрывает, кнопка 📌 закрепляет.",
            "Обе клавиши меняются в «Настройки» → «Лукап».",
        ],
        en: [
            "## Inside Setsuna",
            "Hold Shift and move the pointer over the text: the word under it opens in the dictionary, no click needed. Shift+click works too.",
            "Inside the dictionary Shift works the same: point at a word in a definition and another window opens on top.",
            "Add the word to Anki with \"+\"; \"+ camera\" also attaches a game screenshot.",
            "## Anywhere in Windows",
            "Hold Shift+Z over text in any program — a browser, Discord, the game itself. The dictionary opens as a separate window; click outside to close, 📌 to pin.",
            "Change both keys in Settings → Lookup.",
        ],
    },

    // Esc menu
    "menu.tabs": {
        ru: [
            "Список всех вкладок. Цветная точка — статус: в планах, читаю, на паузе, прочитано. Число — прочитанные символы.",
            "• Клик — открыть вкладку.",
            "• Двойной клик — переименовать.",
            "• Перетаскивание — поменять порядок.",
            "• Правый клик — статус, колода Anki, «Читать вместе», архив и удаление.",
        ],
        en: [
            "All your tabs. The dot is the status (planned, reading, paused, finished); the number is characters read.",
            "• Click to open.",
            "• Double-click to rename.",
            "• Drag to reorder.",
            "• Right-click for status, Anki deck, reading together, archive and delete.",
        ],
    },
    "menu.add": {
        ru: ["Создаёт пустую вкладку и сразу переключается на неё. Новые строки от хукера пойдут уже в неё.", "Старые вкладки никуда не деваются, к ним можно вернуться в любой момент."],
        en: ["Creates an empty tab and switches to it; new lines from the hooker go there.", "Your other tabs stay as they are."],
    },
    "menu.archive": {
        ru: ["Архив — место для прочитанных или брошенных вкладок. Они пропадают из основного списка, но строки и статистика остаются.", "Архивная вкладка открывается только для чтения. Вернуть её в список можно через правый клик."],
        en: ["The archive holds finished or dropped tabs: gone from the main list, lines and stats kept.", "Archived tabs open read-only; right-click to bring one back."],
    },
    "menu.sources": { ru: SOURCES_RU, en: SOURCES_EN },
    "menu.capture": {
        ru: [
            "Привязывает к вкладке окно игры. После этого кнопка «+ с камерой» в словаре снимает скриншот именно этого окна, даже если сейчас на переднем плане Setsuna.",
            "Привязка хранится у каждой вкладки своя, так что у каждой игры будет своё окно.",
        ],
        en: [
            "Binds the game window to this tab, so \"+ camera\" in the dictionary screenshots that window even when Setsuna is in front.",
            "Each tab keeps its own binding.",
        ],
    },
    "menu.deck": {
        ru: [
            "Выбирает колоду Anki только для этой вкладки. Карточки из этой игры будут уходить в неё, а не в общую колоду из настроек.",
            "«Как в настройках» снимает привязку. В какую колоду уйдёт карточка, видно в подсказке на кнопке «+» в словаре.",
        ],
        en: [
            "Picks an Anki deck for this tab only; cards from this game go there instead of the main deck.",
            "\"As in settings\" clears it. The \"+\" button's tooltip in the dictionary shows the target deck.",
        ],
    },
    "menu.shared": {
        ru: [
            "Совместное чтение. Ты можешь начать эфир вкладки и дать другу короткий код, и у него будут появляться те же строки. Или ввести чужой код и смотреть чужую вкладку.",
            "Удобно читать одну новеллу вместе или показать кому-то, что ты сейчас читаешь.",
        ],
        en: [
            "Reading together: start a broadcast and give a friend the short code so the same lines appear for them, or enter someone's code to follow their tab.",
            "Good for reading a novel together or showing what you're reading.",
        ],
    },
    "menu.flow": { ru: ["Открывает окно Flow поверх игры — то же, что кнопка Flow на верхней панели. Подробности есть в подсказке к той кнопке."], en: ["Opens the Flow window over the game, same as the Flow button on the top bar."] },
    "menu.search": {
        ru: ["Поиск по всем строкам текущей вкладки. Открывается и по Ctrl+F.", "Найденные строки подсвечиваются, между ними можно переходить стрелками."],
        en: ["Searches every line of the current tab; Ctrl+F opens it too.", "Matches are highlighted; move between them with the arrows."],
    },
    "menu.settings": {
        ru: ["Открывает все настройки. При первом входе в каждый раздел там тоже появятся подсказки."],
        en: ["Opens all settings; each section shows its own tips the first time."],
    },
    "menu.importexport": {
        ru: [
            "• Импорт — загрузить строки из текстового файла во вкладку, например скрипт новеллы.",
            "• Экспорт — сохранить строки вкладки в файл.",
            "• Главный экран — вернуться к выбору режима (TextHooker, Читалка, Видео-плеер).",
            "• Очистить вкладку — удалить все её строки. Перед этим Setsuna спросит подтверждение.",
        ],
        en: [
            "• Import loads lines from a text file into the tab, e.g. a novel's script.",
            "• Export saves the tab's lines to a file.",
            "• Home screen goes back to choosing a mode.",
            "• Clear tab deletes all its lines, after asking you to confirm.",
        ],
    },

    // Settings shell
    "settings.nav": {
        ru: [
            "Настройки поделены на три группы. «Чтение» — то, как выглядят и работают режимы: текст хукера, читалка, плеер и окно Flow. «Инструменты» — словарь, Anki и ИИ. «Сервисы» — Google Диск, Discord, обновления и обратная связь.",
            "У раздела «Текст» есть подпункты: клик по ним сразу прокручивает к нужной группе.",
        ],
        en: [
            "Three groups: Reading (how the text, reader, player and Flow look and behave), Tools (dictionary, Anki, AI) and Services (Google Drive, Discord, updates, feedback).",
            "Sections with sub-items scroll straight to a group.",
        ],
    },
    "settings.actions": {
        ru: [
            "• «Скрыть для предпросмотра» временно убирает окно настроек: видно, как текст выглядит с новым шрифтом или размером. Кнопка внизу вернёт настройки.",
            "• «Мастер» заново запускает первую настройку: язык, словари, Anki.",
            "• «Сброс» возвращает все настройки по умолчанию. Вкладки, строки и словари при этом не трогаются.",
        ],
        en: [
            "• \"Hide for preview\" moves settings away to see the text with a new font or size; the button at the bottom brings them back.",
            "• \"Wizard\" runs the first-time setup again: language, dictionaries, Anki.",
            "• \"Reset\" restores default settings; tabs, lines and dictionaries are untouched.",
        ],
    },
    "settings.text-app": {
        ru: [
            "• Тема и язык программы.",
            "• Размер шрифта и сам шрифт. «Выравнивать видимый размер» подгоняет разные шрифты, чтобы при смене шрифта текст не прыгал в размере.",
            "• Позиция автоскролла — на какой высоте экрана держать новую строку.",
            "• Режим фуриганы — выключена или автоматически показывать чтение над кандзи.",
            "• Направление — горизонтальный текст или вертикальный, как в японских книгах.",
            "Здесь же кнопка «Показать подсказки заново», если захочешь пройти все подсказки ещё раз.",
        ],
        en: [
            "• Theme and language.",
            "• Font size and font; \"normalize visible size\" keeps text from jumping when you switch fonts.",
            "• Auto-scroll position: where on screen the newest line sits.",
            "• Furigana mode: off, or readings over kanji automatically.",
            "• Direction: horizontal, or vertical like Japanese books.",
            "\"Show tips again\" is here too.",
        ],
    },
    "settings.text-stats": {
        ru: [
            "• Панель плавает справа сверху; её можно перетащить мышью, двойной клик возвращает на место.",
            "• Скорость чтения — считать символы или строки, и за какой период (в час или в минуту).",
            "• Автоостановка таймера — через сколько минут без новых строк таймер встанет на паузу, чтобы время не накручивалось, пока ты отошёл.",
        ],
        en: [
            "• The panel floats top-right; drag it anywhere, double-click puts it back.",
            "• Reading speed: characters or lines, per hour or per minute.",
            "• Auto-pause: minutes without new lines before the timer stops, so time isn't counted while you're away.",
        ],
    },
    "settings.text-src": { ru: SOURCES_RU, en: SOURCES_EN },
    "settings.text-filters": {
        ru: [
            "Фильтры чистят строки, которые приходят от хукера:",
            "• Очистка текста — убирает служебные символы и мусор, который некоторые игры присылают вместе со строкой.",
            "• Игнорировать повторы — одна и та же строка подряд не добавится дважды (хукеры часто дублируют).",
            "• Удалять пробелы — убирает пробелы и переносы внутри японских строк.",
            "## Замены",
            "Свои правила «найти → заменить». Например, убрать имя персонажа в скобках или заменить странный символ. Правило бывает простым текстом или регулярным выражением (для сложных шаблонов). Галочка слева включает и выключает правило.",
        ],
        en: [
            "Filters clean lines coming from the hooker:",
            "• Text cleaner strips control characters and junk some games send.",
            "• Ignore duplicates: the same line in a row is added once (hookers often repeat).",
            "• Remove whitespace inside Japanese lines.",
            "## Replacements",
            "Your own find → replace rules, e.g. drop a bracketed speaker name. Plain text or a regular expression for complex patterns; the checkbox toggles a rule.",
        ],
    },
    "settings.epub-reader": {
        ru: ["• Тема страницы — как в приложении, тёмная, «бумага» или сепия.", "• Режим чтения — по страницам (листание) или прокруткой.", "• Шрифт и размер текста книги."],
        en: ["• Page theme: app, dark, paper or sepia.", "• Reading mode: pages or scrolling.", "• The book's font and size."],
    },
    "settings.epub-layout": {
        ru: ["• Показывать картинки из книги или читать только текст.", "• Блюр иллюстраций — размыть картинки, чтобы не поймать спойлер. Например, всё, кроме обложки.", "• Фуригана в книгах — показывать чтения, которые есть в самой книге.", "• Ширина колонки текста."],
        en: ["• Show the book's images or text only.", "• Blur illustrations against spoilers, e.g. all but the cover.", "• Furigana from the book itself.", "• Text column width."],
    },
    "settings.epub-manga": {
        ru: [
            "Чтобы по манге работал словарь, текст на картинках нужно распознать.",
            "• Mokuro распознаёт весь том сразу и делает кликабельный слой. Ему нужен Python; в окне Mokuro у тома есть кнопка автоматической установки.",
            "• Сервер OCR на ПК позволяет телефону распознавать отдельные баблы через этот компьютер по Wi-Fi.",
            "Статус показывает, работает ли распознавание и на чём: на видеокарте (быстро) или на процессоре.",
        ],
        en: [
            "For the dictionary to work on manga, the text in the pictures must be recognised.",
            "• Mokuro recognises a whole volume into a clickable layer; it needs Python, and the volume's Mokuro window can install it for you.",
            "• The PC OCR server lets the phone recognise single bubbles through this computer over Wi-Fi.",
            "The status shows whether it runs on the graphics card (fast) or the CPU.",
        ],
    },
    "settings.player-main": {
        ru: ["• Стрелки ← / → — перематывать по секундам или прыгать между репликами.", "• Шаг перемотки и шаг сдвига субтитров, если они спешат или опаздывают.", "• Пропуск или ускорение пауз без речи — меньше ждать между репликами."],
        en: ["• Arrow keys: seek by seconds or jump between lines.", "• Seek step and subtitle-shift step for subtitles that run early or late.", "• Skip or speed up silent gaps between lines."],
    },
    "settings.player-mining": {
        ru: ["Карточка из плеера может содержать кусок видео или только звук реплики.", "• Вложение — видео с оригинальным звуком или только звук.", "• Качество клипа — чем выше, тем больше весит карточка.", "• Переигрывать сохранённый отрывок — сразу проверить, что попало в карточку."],
        en: ["A card from the player can carry a video clip or just the line's audio.", "• Attachment: video with audio, or audio only.", "• Clip quality: higher means bigger cards.", "• Replay the saved clip to check what went in."],
    },
    "settings.player-binds": {
        ru: ["Горячие клавиши плеера. Нажми на поле и затем нужную клавишу.", "• Повтор / пред. реплика (R) — переиграть текущую реплику.", "• Дополнить посл. карточку (U) — добавить кадр и звук к карточке, которую ты только что создал из словаря.", "• Копировать реплику (C) и сдвиг субтитров ([ / ])."],
        en: ["Player shortcuts: click a field, then press the key.", "• Replay / prev cue (R) replays the current subtitle.", "• Update last card (U) attaches the frame and audio to the card you just made from the dictionary.", "• Copy subtitle (C) and shift subtitles ([ / ])."],
    },
    "settings.jl-main": {
        ru: ["Flow — окно поверх игры с последней строкой.", "• Шрифт, размер, прозрачность и отступы окна.", "• Как открывать словарь: клик по слову или наведение с задержкой.", "• Прятать словарь, когда приходит новая строка, чтобы он не закрывал текст."],
        en: ["Flow is the window over the game with the latest line.", "• Font, size, transparency and padding.", "• How to open the dictionary: click a word or hover with a delay.", "• Hide the dictionary when a new line arrives."],
    },
    "settings.lookup-win": {
        ru: [
            "## Клавиши",
            "«Лукап внутри Setsuna» — клавиша, которую держишь, наводя курсор на слово (по умолчанию Shift).",
            "«Скан по всему Windows» — сочетание для словаря поверх любой программы (по умолчанию Shift+Z). Галочка включает и выключает его совсем.",
            "«Закрывать при клике мимо» — глобальное окно словаря само закроется, если кликнуть в другое место. Кнопкой 📌 его можно закрепить.",
            "## Вид окна",
            "Масштаб, ширина, шрифт, размер меток и показ кнопок озвучки в окне словаря.",
        ],
        en: [
            "## Keys",
            "\"Lookup inside Setsuna\" is the key you hold while pointing at a word (Shift by default).",
            "\"Live scan across Windows\" is the combo for the dictionary over any program (Shift+Z by default); the checkbox turns it off entirely.",
            "\"Close on click outside\" closes the global popup when you click elsewhere; 📌 pins it.",
            "## Window look",
            "Zoom, width, font, tag size and audio buttons.",
        ],
    },
    "settings.lookup-dicts": {
        ru: [
            "Словари, по которым ищутся слова. Подходят словари в формате Yomitan (zip-архивы): JMdict, частотные списки, питч-акцент, русские Warodai и Kenrowa и другие.",
            "• Порядок — в каком порядке словари показываются в окне. Меняется перетаскиванием.",
            "• Проверить обновления — скачать новые версии словарей, если у них указан источник.",
            "• Обмен — передать словари на телефон через Google Диск, чтобы не скачивать их там заново.",
        ],
        en: [
            "The dictionaries words are looked up in; Yomitan-format zips work: JMdict, frequency lists, pitch accent, Russian Warodai and Kenrowa and more.",
            "• Order: drag to change how they're listed.",
            "• Check for updates: download new versions where a source is set.",
            "• Share: send dictionaries to the phone through Google Drive.",
        ],
    },
    "settings.anki-connect": {
        ru: [
            "Пока Anki не подключён, вкладки выбора колоды, шаблона карточки и процессов для скриншотов скрыты.",
            "## Как подключить на ПК",
            "• Установи в Anki дополнение AnkiConnect (код 2055492159) — кнопку копирования кода и ссылку на страницу дополнения видно прямо в этой карточке.",
            "• Нажми «Подключить автоматически»: Setsuna сама пропишет разрешение в конфиге AnkiConnect, запустит Anki и проверит порт 8765.",
            "• Если Anki уже был открыт во время установки или правки конфига, полностью закрой его и открой заново.",
            "## На телефоне (Android)",
            "Для карточек нужен установленный AnkiDroid. Нажми кнопку выдачи разрешения («Allow AnkiDroid»), после чего колоды подгрузятся автоматически.",
        ],
        en: [
            "While Anki is disconnected, deck selection, note type mapping and screenshot process settings stay hidden.",
            "## Connecting on PC",
            "• Install the AnkiConnect add-on in Anki (code 2055492159) — use the copy button or add-on link right in this card.",
            "• Click \"Connect automatically\": Setsuna configures AnkiConnect permissions, launches Anki if needed and waits for port 8765.",
            "• If Anki was already open when installing or updating the config, fully quit and reopen it once.",
            "## On Android",
            "Cards require AnkiDroid. Grant permission with \"Allow AnkiDroid\" and your decks will load automatically.",
        ],
    },
    "settings.anki-connected": {
        ru: [
            "Статус «Готово к добавлению карточек» означает, что связь с AnkiConnect или AnkiDroid активна.",
            "• При первом подключении Setsuna автоматически создаёт готовую колоду и тип заметки Setsuna Japanese (если их ещё нет).",
            "• Если ты создал новую колоду или добавил поля в модель прямо внутри Anki, нажми «Обновить подключение», чтобы Setsuna перечитала список.",
        ],
        en: [
            "\"Ready to add cards\" means the connection to AnkiConnect or AnkiDroid is live.",
            "• On first connect, Setsuna creates a ready-to-use deck and the Setsuna Japanese note type if needed.",
            "• If you create a new deck or edit note fields inside Anki, click \"Refresh connection\" to reload the metadata.",
        ],
    },
    "settings.anki-cards": {
        ru: [
            "Для карточек нужен Anki с дополнением AnkiConnect (на телефоне — AnkiDroid).",
            "• Колода — куда идут карточки. Тип карточек — их шаблон. Setsuna Japanese создаётся сам и заполняется целиком; Lapis тоже поддерживается полностью.",
            "• «Куда добавлять карточки» — одна колода для всего или отдельная для каждой вкладки и глобального лукапа.",
            "• «Автоподбор полей» заново раскладывает данные по полям выбранного типа.",
            "• «Для опытных» — для каждого поля карточки вручную выбрать, что в него класть: слово, чтение, перевод, предложение, озвучку, картинку.",
            "Кнопка «+» в словаре подсвечивается: зелёным — слова ещё нет, красным — уже есть в этой колоде, синим — есть в другой.",
        ],
        en: [
            "Cards need Anki with the AnkiConnect add-on (AnkiDroid on the phone).",
            "• Deck: where cards go. Note type: their template. Setsuna Japanese is created for you and fully filled; Lapis is fully supported too.",
            "• Deck routing: one deck, or one per tab and for global lookup.",
            "• Auto-map fields lays the data out for the chosen type again.",
            "• Advanced: choose by hand what goes into each field.",
            "The \"+\" button is green for new words, red if already in this deck, blue if in another deck.",
        ],
    },
    "settings.anki-audio": {
        ru: [
            "Произношение слова для карточки.",
            "• Онлайн — записи JapanesePod101, нужен интернет.",
            "• Локальная база — файл озвучки (android.db) на диске, работает без интернета и быстрее.",
            "• Можно задать порядок: сначала одно, потом другое.",
            "Кнопка «Проверить озвучку» сразу проигрывает слово, чтобы убедиться, что всё работает.",
        ],
        en: [
            "Word pronunciation for cards.",
            "• Online: JapanesePod101 recordings, needs internet.",
            "• Local database: an audio file (android.db) on disk, offline and faster.",
            "• Set an order: one first, then the other.",
            "\"Test audio\" plays a word right away.",
        ],
    },
    "settings.anki-hooks": {
        ru: [
            "• Какие кнопки показывать в словаре: «+» (просто карточка) и «+ с камерой» (карточка со скриншотом).",
            "• Процесс игры — с какого окна снимать скриншот. Нажми «Найти окно» и выбери игру из списка запущенных программ. «Тест скрина» сразу покажет, что получится.",
        ],
        en: [
            "• Which dictionary buttons to show: \"+\" (plain card) and \"+ camera\" (card with a screenshot).",
            "• Game process: which window to screenshot. \"Find window\" lists running programs; \"Test screenshot\" shows the result.",
        ],
    },
    "settings.anki-dupes": {
        ru: [
            "Перед показом кнопки добавления в словаре Setsuna проверяет, есть ли слово в твоей базе Anki:",
            "• Новая (по умолчанию зелёная) — карточки с этим словом и чтением ещё нет.",
            "• Уже есть в другой колоде (синяя) — слово изучено в другой колоде; при необходимости можно разрешить добавлять ещё одну карточку.",
            "• Уже есть в этой колоде (красная) — карточка уже лежит в выбранной колоде.",
            "На Android проверка дублей пока не поддерживается API AnkiDroid.",
        ],
        en: [
            "Before showing add buttons in the dictionary, Setsuna checks if the word already exists in your Anki collection:",
            "• New (green by default): no card matches this word and reading yet.",
            "• Already exists (other deck, blue): present in a different deck; you can allow adding another copy.",
            "• Already exists (same deck, red): already present in the target deck.",
            "On Android, duplicate checking is not yet supported by the AnkiDroid bridge.",
        ],
    },
    "settings.ai-main": {
        ru: [
            "ИИ-объяснения — экспериментальная функция. Локальная нейросеть объясняет японские строки: перевод, грамматику, разбор.",
            "Модель скачивается один раз и работает на твоём компьютере без интернета. Чем больше модель, тем лучше ответы, но тем больше нужно памяти и тем медленнее она на слабом ПК.",
        ],
        en: [
            "AI explanations are experimental: a local model explains Japanese lines — translation, grammar, breakdown.",
            "Download a model once; it runs offline on your PC. Bigger models answer better but need more memory and are slower on weak PCs.",
        ],
    },
    "settings.cloud-connect": {
        ru: [
            "Google Диск в Setsuna нужен сразу для трёх задач — и все данные лежат только в твоём собственном аккаунте:",
            "## Что синхронизируется",
            "• Читалка (автоматически) — прогресс чтения, закладки, заметки, обложки и (если включено в настройках читалки) сами файлы EPUB/манги/PDF между ПК и телефоном.",
            "• Бэкапы TextHooker и настроек (вручную) — снимки выбранных вкладок, фильтров и настроек приложения в разделе ниже.",
            "• База словарей (вручную) — перенос уже собранного файла dictionary.db между устройствами без повторной распаковки архивов.",
            "## Безопасность и приватность",
            "Setsuna запрашивает доступ только к скрытой папке приложения (appDataFolder). Программа физически не видит твои личные документы, фото и остальные файлы на Google Диске.",
            "## Как подключить",
            "Нажми «Подключить Google Drive» и войди в один и тот же аккаунт Google на ПК и на телефоне. Если браузер после входа не вернул в Setsuna автоматически, раскрой «Вход не вернулся в приложение» и вставь адрес из адресной строки браузера.",
        ],
        en: [
            "Google Drive powers three features in Setsuna, with everything stored in your own Google account:",
            "## What syncs",
            "• Reader (automatic): reading progress, bookmarks, notes, cover thumbnails and (when enabled in Reader settings) EPUB/manga/PDF book files between PC and phone.",
            "• TextHooker & settings backups (manual): snapshots of chosen tabs and app settings created below.",
            "• Dictionary database (manual): transfer your already compiled dictionary.db between devices without re-importing zips.",
            "## Privacy",
            "Setsuna only asks for access to its hidden app-only folder (appDataFolder). It cannot see or touch any of your personal files on Google Drive.",
            "## Setup on PC & phone",
            "Click \"Connect Google Drive\" and sign in with the same Google account on both devices. If your browser does not return automatically, expand \"Sign-in did not return to the app\" and paste the redirect URL.",
        ],
    },
    "settings.cloud-connected": {
        ru: [
            "Аккаунт Google подключён. После входа открываются управление квотой, создание и восстановление бэкапов и перенос базы словарей.",
            "• «Обновить данные» вручную подтягивает свежую квоту, список бэкапов и размер облачной базы словарей.",
            "• «Отключить» стирает токен входа только на этом устройстве. Уже загруженные книги, прогресс и бэкапы на Google Диске остаются нетронутыми.",
            "Чтобы автосинхронизация читалки работала на двух устройствах, просто войди тем же аккаунтом Google на каждом из них.",
        ],
        en: [
            "Your Google account is connected, unlocking quota info, backup snapshots and dictionary transfer.",
            "• \"Refresh data\" manually fetches the latest storage quota, backup archive and cloud dictionary size.",
            "• \"Disconnect\" removes the sign-in token on this device only. Your books, progress and backups in Drive stay untouched.",
            "To keep reader progress in sync across devices, sign in with the same Google account on each one.",
        ],
    },
    "settings.cloud-quota": {
        ru: [
            "Показывает общий объём Google Диска и сколько свободного места осталось.",
            "Обрати внимание на этот блок перед загрузкой базы словарей или большого числа книг: база словарей легко занимает 1–3 ГБ и расходует обычную квоту твоего Google-аккаунта.",
        ],
        en: [
            "Shows your total Google Drive usage and remaining free space.",
            "Check this before uploading a dictionary database or many manga volumes: dictionary.db can take 1–3 GB and counts toward your Google account's storage quota.",
        ],
    },
    "settings.cloud-backup": {
        ru: [
            "Создаёт новый файл-бэкап со всеми настройками (без паролей и токенов входа) и выбранными вкладками TextHooker.",
            "• Старые бэкапы не удаляются и не перезаписываются — каждый снимок добавляется в архив отдельно.",
            "• Можно искать по вкладкам, отмечать только нужные и выбрать, включать ли общие настройки (тему, шрифты, источники, правила замен и раскладку Anki).",
        ],
        en: [
            "Creates a new backup snapshot containing your app settings (tokens excluded) and whichever TextHooker tabs you check.",
            "• Existing backups are never overwritten — each snapshot is added to the archive below.",
            "• Search and filter tabs to back up only what you want, and toggle whether general settings are included.",
        ],
    },
    "settings.cloud-archive": {
        ru: [
            "Все резервные копии Setsuna, найденные в скрытой папке Диска, включая бэкапы от старых версий.",
            "• Нажми «Открыть», чтобы посмотреть содержимое бэкапа, отметить нужные вкладки или настройки и нажать «Восстановить выбранное».",
            "• При восстановлении вкладки с тем же ID обновляются, а новые добавляются в список; привязки локальных окон захвата сохраняются.",
        ],
        en: [
            "Every Setsuna backup stored in your private app folder, including backups from older app versions.",
            "• Click \"Open\" to inspect a snapshot, pick only specific tabs or settings, and click \"Restore selected\".",
            "• Matching tab IDs are updated and missing ones are added, while local capture window bindings stay intact.",
        ],
    },
    "settings.cloud-dict": {
        ru: [
            "Позволяет перенести готовую базу словарей (`dictionary.db`) целиком через Google Диск — особенно удобно, чтобы не импортировать тяжёлые zip-словари заново на телефоне или втором ПК.",
            "• Показывает размер локальной базы и облачной копии, а также свободное место на диске устройства.",
            "• Чтобы случайно не забить трафик и облако, перед загрузкой нужно подтвердить галочку проверки размера.",
            "• Альтернативный быстрый перенос по локальной Wi-Fi сети без Google Диска есть в «Настройки» → «Лукап» → «Словари» → «Поделиться».",
        ],
        en: [
            "Transfers your compiled `dictionary.db` through Google Drive — handy so you don't have to re-import large dictionary zips on a phone or second PC.",
            "• Compares local vs cloud database sizes and available device disk space.",
            "• Requires checking the acknowledgement box before uploading so you don't unexpectedly burn storage or mobile data.",
            "• For faster local Wi-Fi transfer without Drive, use Settings → Lookup → Dictionaries → Share.",
        ],
    },
    "settings.discord-main": {
        ru: [
            "Статус в профиле Discord: друзья видят «Играет в Setsuna» и что ты читаешь.",
            "Можно выбрать, показывать ли название вкладки, счётчики и таймер, и добавить кнопки-ссылки.",
            "Если выключить, Setsuna перестаёт отправлять статус. Если Discord всё равно пишет «I Am Setsuna», это сам Discord путает Setsuna с игрой Square Enix с таким же именем файла: убери её в настройках Discord, в разделе «Зарегистрированные игры».",
        ],
        en: [
            "Your Discord profile status: friends see \"Playing Setsuna\" and what you're reading.",
            "Choose whether to show the tab name, counters and timer, and add link buttons.",
            "Turned off, Setsuna stops sending it. If Discord still shows \"I Am Setsuna\", Discord itself mistakes Setsuna for the Square Enix game with the same file name: remove it under Registered Games in Discord's settings.",
        ],
    },
    "settings.updates-main": {
        ru: ["Показывает текущую версию. «Проверить сейчас» ищет новую, а галочка включает проверку при каждом запуске.", "Обновление скачивается и ставится поверх; вкладки, книги и словари сохраняются."],
        en: ["Shows your version. \"Check now\" looks for a new one; the checkbox checks on every start.", "Updates install over the current version; tabs, books and dictionaries are kept."],
    },
    "settings.feedback-main": {
        ru: ["Обращение уходит разработчикам в GitHub Issues. Выбери тип (ошибка или идея), коротко назови проблему и опиши, что произошло и что ты ожидал.", "Текст можно сразу открыть на GitHub или скопировать в буфер обмена; на ПК также есть быстрая кнопка копирования пути к файлу диагностики (`setsuna-diagnostics.log`)."],
        en: ["Your report goes to the developers as a GitHub issue. Pick a type (bug or idea), give a short title and describe what happened and what you expected.", "You can open the prefilled form on GitHub or copy the formatted report; on desktop there is also a quick button to copy the path to `setsuna-diagnostics.log`."],
    },

    // Reader library & menus
    "library.sync": {
        ru: [
            "Синхронизирует библиотеку читалки через скрытую папку вашего Google Диска.",
            "• На ПК и телефоне переходят прогресс чтения, закладки, заметки, обложки и (если включено в Настройки → Читалка) сами файлы книг.",
            "• Если аккаунт ещё не подключён, кнопка откроет раздел Google Диска в настройках.",
        ],
        en: [
            "Syncs your reader library through your private Google Drive app folder.",
            "• Progress, bookmarks, notes, covers and (when enabled in Settings → Reader) book files move between PC and phone.",
            "• If not signed in yet, clicking opens Google Drive settings.",
        ],
    },
    "library.open": {
        ru: [
            "«Открыть книгу» добавляет один выбранный файл; «Папка» добавит сразу все книги из папки и её подпапок.",
            "Поддерживаются EPUB, FB2 и FB2.ZIP, PDF, DOCX, MOBI и AZW3, TXT (в том числе Aozora Bunko с фуриганой), Markdown, HTML, а манга — папками картинок, CBZ и ZIP.",
            "Книги остаются там, где лежат; Setsuna запоминает путь и прогресс.",
        ],
        en: [
            "\"Open book\" adds one file; \"Folder\" adds every book in a folder and its subfolders.",
            "EPUB, FB2/FB2.ZIP, PDF, DOCX, MOBI/AZW3, TXT (Aozora Bunko with furigana too), Markdown, HTML; manga as image folders, CBZ and ZIP.",
            "Books stay where they are; Setsuna remembers the path and progress.",
        ],
    },
    "library.folder": {
        ru: [
            "Сканирует выбранную папку и все вложенные папки, автоматически добавляя книги и мангу в библиотеку.",
            "Если в папке лежат тома манги с .mokuro рядом, Setsuna сразу подхватит слой распознавания.",
        ],
        en: [
            "Scans a folder and all subfolders, adding books and manga volumes automatically.",
            "If manga volumes have .mokuro files alongside them, the OCR layer is attached automatically.",
        ],
    },
    "library.select": {
        ru: [
            "Включает режим выделения карточек (Shift+клик выделяет диапазон).",
            "На верхней панели сразу появляются массовые действия: сменить статус, разложить по полкам/серии, конвертировать мангу в CBZ, прогнать Mokuro OCR или убрать из библиотеки.",
        ],
        en: [
            "Enables multi-selection on cards (Shift+click selects a range).",
            "A sticky action bar lets you batch-change status, shelves or series, convert manga to CBZ, run Mokuro OCR or remove selected books.",
        ],
    },
    "library.shelves": {
        ru: [
            "• Переключатель «Все / Книги / Манга» появляется, когда в библиотеке есть манга.",
            "• Вкладки статусов показывают, сколько книг вы сейчас читаете, планируете, отложили или уже дочитали.",
            "• Кнопка «+ Полка» создаёт свои пользовательские полки (например, по жанрам или циклам).",
        ],
        en: [
            "• The \"All / Books / Manga\" filter appears when manga is in the library.",
            "• Status tabs track what you're reading, planning, holding or finished.",
            "• \"+ Shelf\" lets you create custom shelves for genres or series.",
        ],
    },
    "library.filters": {
        ru: [
            "• Язык — показать только японские или только английские книги.",
            "• Группировка — объединяет тома одной серии или книги одного автора в стопки.",
            "• Сортировка — сначала недавние, по названию (с учётом номеров томов и 上中下), по автору или по прогрессу.",
        ],
        en: [
            "• Language: show only Japanese or only English books.",
            "• Grouping: stack volumes by series or group books by author.",
            "• Sorting: recently opened, natural title order, author or progress.",
        ],
    },
    "library.search": {
        ru: ["Поиск по названию и автору идёт прямо во время набора.", "Фильтры рядом оставляют только книги или только мангу и книги на нужном языке."],
        en: ["Searches titles and authors as you type.", "The filters next to it show only books or only manga, in one language."],
    },
    "library.card": {
        ru: [
            "Обложка, название, автор и полоска прогресса.",
            "Через меню книги можно поменять статус (читаю, прочитано, отложено, брошено), исправить название и обложку, найти обложку в интернете или удалить книгу из библиотеки (сам файл остаётся).",
            "Иконка облака — книга лежит на Google Диске, клик скачает её.",
        ],
        en: [
            "Cover, title, author and a progress bar.",
            "The book menu changes status (reading, finished, on hold, dropped), fixes title and cover, finds a cover online, or removes the book from the library (the file stays).",
            "A cloud icon means the book is on Google Drive; click to download it.",
        ],
    },
    "library.display": {
        ru: ["Размер карточек, как обрезать обложки и какие подписи показывать (автор, серия, теги, символы, прогресс).", "Здесь же сортировка, полки и резервная копия библиотеки в JSON-файл и восстановление из него."],
        en: ["Card size, cover fit and which details to show (author, series, tags, characters, progress).", "Also sorting, shelves, and a JSON backup of the library and restoring it."],
    },
    "library.stats": {
        ru: ["Сколько символов ты читал по дням, текущая серия дней подряд и рекорд, дневные цели.", "Учитывается чтение и в книгах, и в манге."],
        en: ["Characters read per day, your current and best streak, and daily goals.", "Books and manga both count."],
    },
    "library.mokuro": {
        ru: ["Запускает Mokuro по нескольким томам манги подряд. После распознавания текст на страницах становится кликабельным, и по нему работает словарь.", "На видеокарте NVIDIA это заметно быстрее. Если Mokuro не установлен, его можно поставить автоматически из окна Mokuro у любого тома."],
        en: ["Runs Mokuro over several manga volumes in a row; afterwards the page text is clickable for the dictionary.", "Much faster on an NVIDIA card. If Mokuro isn't installed, any volume's Mokuro window can install it."],
    },
    "epub.back": { ru: ["Закрывает книгу. Место, где ты остановился, сохраняется, и в следующий раз книга откроется там же."], en: ["Closes the book; it reopens where you stopped."] },
    "epub.bookmarks": {
        ru: ["Закладка запоминает точное место в книге. В списке закладок их можно переименовать, удалить и перейти к любой.", "Закладки синхронизируются через Google Диск, если он подключён."],
        en: ["A bookmark remembers an exact place. In the list you can rename, delete or jump to any.", "Bookmarks sync through Google Drive when it's connected."],
    },
    "epub.stats": {
        ru: ["Скорость чтения в этой книге, сколько времени ты в ней провёл и сколько осталось до конца главы и книги.", "Здесь же можно поставить таймер чтения на паузу (P)."],
        en: ["Your speed in this book, time spent, and how much is left in the chapter and the book.", "Pause the reading timer here too (P)."],
    },
    "epub.zen": { ru: ["Убирает все панели и кнопки: на экране только текст. Клавиша Z включает и выключает режим, панели появляются при наведении к краю."], en: ["Hides every panel and button; only the text remains. Z toggles it; panels show when you reach an edge."] },
    "epub.toc": { ru: ["Оглавление книги. Текущая глава выделена; клик по любой главе переходит к ней."], en: ["The book's contents; the current chapter is highlighted, click any to jump."] },
    "epub.search": { ru: ["Поиск слова или фразы по всей книге. В результатах видно, в какой главе совпадение, и клик сразу переходит туда."], en: ["Find a word or phrase in the whole book; results show the chapter and jump there on click."] },
    "epub.chapters": {
        ru: ["Стрелки переключают главы.", "В режиме прокрутки можно просто докрутить до конца главы и продолжить крутить колесом: появится кольцо, оно заполнится, и откроется следующая глава. В начале главы так же открывается предыдущая."],
        en: ["The arrows switch chapters.", "In scroll mode, keep scrolling past the end: a ring fills up and the next chapter opens. At the start of a chapter the same opens the previous one."],
    },
    "epub.appearance": {
        ru: ["• Шрифт, размер, межстрочный интервал и поля.", "• Тема страницы.", "• Вертикальный текст справа налево, как в японских книгах, или горизонтальный.", "• Чтение страницами или прокруткой."],
        en: ["• Font, size, line spacing and margins.", "• Page theme.", "• Vertical right-to-left text like Japanese books, or horizontal.", "• Pages or scrolling."],
    },
    "epub.lang": {
        ru: ["Setsuna автоматически определяет язык книги по метаданным и тексту.", "Для японских книг доступны вертикальная раскладка и точное разбиение со словарём; английские всегда идут горизонтально."],
        en: ["Setsuna detects the book language from metadata and text.", "Japanese books support vertical layout and Japanese tokenizer lookup; English books stay horizontal."],
    },
    "epub.orientation": {
        ru: ["• Авто — использует направление, заданное в самом EPUB-файле.", "• Горизонтально — привычные строки слева направо.", "• Вертикально — классическая японская вёрстка справа налево."],
        en: ["• Auto follows the book's own layout metadata.", "• Horizontal uses left-to-right lines.", "• Vertical uses traditional Japanese right-to-left columns."],
    },
    "epub.notes": {
        ru: ["Выдели фрагмент текста при чтении, чтобы подсветить цитату цветом или добавить комментарий.", "Все цитаты и заметки книги собраны здесь и синхронизируются с Google Диском."],
        en: ["Select text while reading to highlight it or attach a note.", "All highlights and notes for the book are collected here and sync via Google Drive."],
    },
    "epub.gallery": {
        ru: ["Собирает все изображения и иллюстрации, встроенные в книгу, в отдельную галерею для удобного просмотра."],
        en: ["Collects every illustration inside the book into one gallery view."],
    },
    "epub.point": {
        ru: ["Удобно, если нужно заглянуть на пару глав назад или проверить имя персонажа, не потеряв текущее место.", "Нажми сюда, чтобы поставить якорь на текущем абзаце — позже кнопка ↩ на нижней панели вернёт ровно туда же."],
        en: ["Handy when peeking back at earlier chapters without losing your spot.", "Click to pin the current paragraph; later use ↩ on the bottom bar to jump back."],
    },
    "epub.return-point": {
        ru: ["Возвращает ровно к тому абзацу, на котором ты ранее поставил «Точку чтения»."],
        en: ["Jumps back to the paragraph you pinned earlier with Reading point."],
    },
    "epub.freeze": {
        ru: ["Пока заморозка (❄) включена, перелистывание не перезаписывает твою сохранённую позицию чтения и не накручивает прогресс вперёд."],
        en: ["While freeze (❄) is on, scrolling or flipping pages will not overwrite your saved reading position."],
    },
    "epub.tracking": {
        ru: ["Временно ставит на паузу учёт прочитанных символов и времени в статистике книги (например, когда отлучился от ПК)."],
        en: ["Temporarily pauses character and reading-time tracking for this book."],
    },
    "epub-menu.books": {
        ru: ["Быстрый список всех книг из твоей библиотеки с процентом прочтения. Клик сразу открывает выбранную книгу, не выходя в сетку."],
        en: ["Quick list of every book in your library with reading progress. Click any to switch books directly."],
    },
    "epub-menu.add": {
        ru: ["То же, что «Открыть книгу»: позволяет выбрать файл с диска и сразу открыть его в читалке."],
        en: ["Shortcut to pick a book or manga file from disk and open it right away."],
    },
    "epub-menu.library": {
        ru: ["Закрывает меню и открывает полный экран библиотеки с карточками, полками и поиском."],
        en: ["Switches back to the full library grid with covers, shelves and search."],
    },
    "epub-menu.open": {
        ru: ["Открывает проводник для добавления EPUB, FB2, PDF, DOCX, MOBI, TXT, Markdown или манги (CBZ/ZIP/папка)."],
        en: ["Opens the file picker to add EPUB, FB2, PDF, DOCX, MOBI, TXT, Markdown or manga (CBZ/ZIP)."],
    },
    "epub-menu.settings": {
        ru: ["Открывает вкладку настроек читалки: вид, раскладка, Google Диск и параметры OCR манги."],
        en: ["Opens Reader settings: appearance, layout, Drive sync and manga OCR."],
    },
    "epub-menu.home": {
        ru: ["Выход из читалки на главный экран Setsuna, где можно переключиться в TextHooker или Видео-плеер."],
        en: ["Leaves the reader back to Setsuna's Home screen to switch to TextHooker or Video Player."],
    },
    "epub.autoscroll": { ru: ["Текст сам медленно прокручивается с выбранной скоростью — удобно читать, не трогая мышь. Скорость можно менять прямо во время чтения."], en: ["The text scrolls by itself at a set speed, so you can read hands-free; change the speed while reading."] },
    "epub.sentences": {
        ru: ["Кнопка включает режим выбора предложений на странице (для японских и английских книг).", "Кликай по нужным предложениям (с Shift — весь диапазон) и копируй без фуриганы. На ПК также работает правый клик по любому предложению."],
        en: ["Turns on sentence selection for Japanese and English books.", "Click sentences (hold Shift for a range) to copy clean text without furigana. On PC you can also right-click any sentence."],
    },
    "epub.audio": { ru: ["Озвучка книги: синтезатор речи читает текст вслух.", "Можно подключить и готовую аудиокнигу, чтобы слушать её вместе с текстом."], en: ["Text-to-speech reads the book aloud.", "You can also attach an audiobook to listen along with the text."] },
    "manga.bubbles": {
        ru: ["Режим выбора баблов позволяет отметить 1, 2, 3… баблов в порядке чтения и скопировать их одним текстом.", "Один бабл можно скопировать сразу: по правому клику на ПК, по кнопке в углу бабла или через кнопку копирования в окне словаря на телефоне."],
        en: ["Bubble select lets you pick multiple speech bubbles in order and copy them together.", "Copy a single bubble anytime via right-click on PC, the corner copy button, or the copy button in the mobile lookup card."],
    },
    "manga.mokuro": {
        ru: [
            "Значок показывает, распознан ли текст этого тома.",
            "Если слоя нет, нажми, и откроется окно Mokuro. Там можно распознать том прямо на этом ПК (Mokuro нужен Python, его можно поставить автоматически) или прикрепить готовый файл .mokuro.",
            "После распознавания наводи курсор с Shift на бабл, и откроется словарь.",
        ],
        en: [
            "The badge shows whether this volume's text is recognised.",
            "If not, click to open the Mokuro window: recognise the volume on this PC (Mokuro needs Python, which can be installed for you) or attach a ready .mokuro file.",
            "Then hold Shift over a bubble for the dictionary.",
        ],
    },
    "manga.crop": { ru: ["Если у тома нет Mokuro, можно распознать один бабл: нажми S или эту кнопку и обведи бабл мышью. Текст распознается, и по нему откроется словарь."], en: ["Without Mokuro you can recognise one bubble: press S or this button and draw around it; its text opens with the dictionary."] },
    "manga.pages": { ru: ["Миниатюры всех страниц тома. Клик переходит к странице, текущая выделена."], en: ["Thumbnails of every page; click to jump, the current one is highlighted."] },
    "manga.settings": { ru: ["• Одна страница или разворот из двух.", "• Направление листания: справа налево, как в японской манге, или слева направо.", "• Масштаб: по высоте, по ширине.", "• Как показывать распознанный текст поверх баблов."], en: ["• One page or a two-page spread.", "• Page direction: right to left like Japanese manga, or left to right.", "• Fit: height or width.", "• How recognised text shows over bubbles."] },
    "pdf.back": { ru: ["Закрывает PDF. Страница, на которой ты остановился, сохраняется."], en: ["Closes the PDF; your page is saved."] },
    "pdf.drawer": {
        ru: ["Боковая панель с четырьмя вкладками:", "• Оглавление — главы документа, если они в нём есть.", "• Страницы — миниатюры для быстрого перехода.", "• Закладки — отмеченные страницы (клавиша B ставит закладку).", "• Заметки — твои заметки к выделенному тексту.", "Закладки и заметки синхронизируются через Google Диск."],
        en: ["A side panel with four tabs:", "• Contents, if the document has them.", "• Pages: thumbnails to jump.", "• Bookmarks (B adds one).", "• Notes on selected text.", "Bookmarks and notes sync through Google Drive."],
    },
    "pdf.point": { ru: ["Точка чтения отмечает место, где ты читаешь (клавиша O). Если ушёл посмотреть другую страницу, например оглавление или примечание, клавиша R вернёт к точке."], en: ["The reading point marks where you read (O). If you go to another page, say the contents or a note, R brings you back."] },
    "pdf.appearance": {
        ru: ["• Режим: одна страница, разворот из двух или сплошная лента прокруткой.", "• Масштаб по ширине окна или по странице целиком, и точное приближение (или Ctrl+колесо).", "• Поворот страницы на 90°.", "• Тема: оригинал, сепия, тёмная или e-ink для сканов."],
        en: ["• Layout: one page, a spread, or continuous scroll.", "• Fit to width or page, and exact zoom (or Ctrl+wheel).", "• Rotate pages by 90°.", "• Theme: original, sepia, dark, or e-ink for scans."],
    },
    "pdf.reflow": { ru: ["Достаёт текст из PDF и показывает его обычным текстом, без картинки страницы. Вертикальный японский текст распознаётся по колонкам.", "Так удобнее читать на маленьком экране, и по тексту работает словарь с Shift."], en: ["Extracts the PDF's text and shows it as plain text, without the page image; vertical Japanese is read column by column.", "Easier on small screens, and the Shift dictionary works on it."] },
    "pdf.search": { ru: ["Ищет текст во всём документе. В результатах видна страница и кусок текста вокруг совпадения, клик переходит туда."], en: ["Finds text in the whole document; results show the page and a snippet, click to go there."] },
    "pdf.page": { ru: ["Впиши номер страницы и нажми Enter. Полоса внизу листает документ, если её тянуть.", "Если выделить текст на странице, появится плашка: найти в словаре, скопировать или сохранить в заметку."], en: ["Type a page number and press Enter; drag the bar at the bottom to flip through.", "Selecting text shows a pill: look it up, copy, or save as a note."] },

    // Player
    "player.open": { ru: ["Выбери видеофайл. Если рядом лежат субтитры с тем же именем (.srt, .ass, .vtt), они подключатся сами. Дорожки субтитров внутри видео тоже доступны.", "Кнопка URL открывает видео по ссылке."], en: ["Pick a video file. Subtitles with the same name next to it (.srt, .ass, .vtt) are added automatically; tracks inside the video are available too.", "URL opens a video from a link."] },
    "player.library": { ru: ["Все открытые видео, сгруппированные по сериалам и сериям, с отметкой, где ты остановился. «Добавить папку» добавит сразу весь сезон."], en: ["Every video you opened, grouped by show and episode, with where you stopped. \"Add folder\" adds a whole season."] },
    "player.deck": { ru: ["Отдельная колода Anki для карточек из видео. Тогда они не смешаются с карточками из книг и игр. Если не выбрать, карточки пойдут в общую колоду из настроек."], en: ["A separate Anki deck for cards from videos, so they don't mix with books and games; otherwise the main deck is used."] },
    "player.transcript": { ru: ["Список всех реплик серии (клавиша T). Текущая подсвечена.", "Клик по реплике перематывает к ней. Shift над словом открывает словарь. Рядом с репликой — кнопка, которая сразу делает карточку Anki."], en: ["All lines of the episode (T); the current one is highlighted.", "Click a line to jump to it, Shift over a word for the dictionary; the button next to a line makes an Anki card."] },
    "player.subs": { ru: ["Показывает или прячет субтитры поверх видео. Если навести на слово в субтитрах, видео встанет на паузу и откроется словарь."], en: ["Shows or hides subtitles over the video; pointing at a word pauses the video and opens the dictionary."] },
    "player.lines": { ru: ["↑ — к предыдущей реплике, ↓ — к следующей. Удобно, чтобы переслушать фразу, которую не расслышал."], en: ["↑ for the previous line, ↓ for the next — handy to hear a phrase again."] },
    "player.settings": { ru: ["• Скорость воспроизведения.", "• Сдвиг субтитров, если они спешат или опаздывают относительно звука.", "• Выбор дорожки субтитров и перевода."], en: ["• Playback speed.", "• Subtitle offset when they run early or late.", "• Subtitle and translation tracks."] },
    "player.anki": { ru: ["Делает карточку из реплики: слово, предложение, кадр из видео и звук этого отрезка.", "Что прикладывать (видео или только звук) и в каком качестве — «Настройки» → «Видео-плеер»."], en: ["Makes a card from the line: word, sentence, a video frame and the clip's audio.", "What to attach and at what quality is in Settings → Video player."] },

    // Player: library, dialogs, screen, settings
    "player.url": { ru: ["Вставь прямую ссылку на видеофайл. Обычные страницы вроде YouTube так не откроются — нужна ссылка на сам файл."], en: ["Paste a direct link to a video file. Regular pages like YouTube won't open this way — it needs the file itself."] },
    "player.folders": { ru: ["Открывает отдельное окно со списком папок, из которых собрана видеотека. Внутри можно обновить список серий, подключить новую папку или убрать лишнюю (сами файлы останутся на диске).", "Если рядом стоит «!», какую-то папку не удалось прочитать (например, диск отключён)."], en: ["Opens a window with the folders your library is built from. Inside you can rescan for episodes, add another folder, or remove one (files stay on disk).", "A \"!\" means a folder couldn't be read (a disconnected drive, say)."] },
    "player.folders-refresh": { ru: ["Заново просматривает все подключённые папки видеотеки.", "Удобно, если ты закинул новые серии или файлы субтитров, пока программа была открыта."], en: ["Rescans every connected library folder.", "Handy when you drop in new episodes or subtitle files while the app is open."] },
    "player.folders-list": { ru: ["Показывает каждую подключённую папку и её полный путь. Если папка стала недоступна, под путём появится ошибка.", "Кнопка «Убрать из видеотеки» отвязывает папку только от списка в Setsuna — видеофайлы на диске не удаляются."], en: ["Lists each connected folder and its full path, plus any read error beneath it.", "Removing a folder only disconnects it from Setsuna; video files on disk are not deleted."] },
    "player.addfolder": { ru: ["Выбери папку с сериалом, сезоном или целой коллекцией. Setsuna найдёт видео, разложит их по тайтлам и сериям по именам файлов и попробует найти обложки.", "Субтитры с тем же именем, что и серия, подключатся к ней сами."], en: ["Pick a folder with a show, a season or a whole collection. Setsuna finds the videos, groups them into titles and episodes by file name and looks for posters.", "Subtitles named like an episode are attached to it automatically."] },
    "player.filter": { ru: ["• Все — вся видеотека.", "• Смотрю — начатые, но не досмотренные тайтлы.", "• Просмотрено — тайтлы, где ты посмотрел все серии."], en: ["• All: the whole library.", "• Watching: started but not finished.", "• Watched: every episode seen."] },
    "player.search": { ru: ["Ищет по названию тайтла и по именам файлов серий."], en: ["Searches title names and episode file names."] },
    "player.sort": { ru: ["Переключает порядок карточек в видеотеке: по алфавиту или по тому, какой тайтл ты запускал последним."], en: ["Switches video library sorting between alphabetical and recently watched."] },
    "player.hero": { ru: ["Карточка последнего тайтла: какая серия, на какой минуте ты остановился и сколько серий позади.", "• «Продолжить» откроет серию с того же места.", "• «Серии» откроет список всех серий, обложку и ссылки."], en: ["Your last title: which episode, the minute you stopped at and how many episodes are behind you.", "• \"Continue\" resumes the episode.", "• \"Episodes\" opens the episode list, poster and links."] },
    "player.card": { ru: ["Счётчик на обложке — сколько серий просмотрено из всех. Внизу год и «Продолжить» с временем, если тайтл начат.", "Клик открывает окно тайтла: серии, кнопка продолжения и смена обложки."], en: ["The badge shows episodes watched out of all. Below: year and \"Continue\" with the time if you've started.", "Click for the title window: episodes, continue and poster."] },
    "player-menu.list": { ru: ["Во время просмотра здесь показаны все серии текущего тайтла; в библиотеке — список тайтлов для быстрого запуска."], en: ["During playback, lists all episodes of the current show; in library view, lists your shows."] },
    "player-menu.add": { ru: ["Открывает выбор видеофайла с компьютера (субтитры рядом подключаются автоматически)."], en: ["Picks a video file from your computer; nearby subtitles attach automatically."] },
    "player-menu.library": { ru: ["Возвращает к сетке видеотеки или обратно к открытому плееру."], en: ["Switches between the video library grid and the active player."] },
    "player-menu.open": { ru: ["Позволяет открыть другое видео (.mkv, .mp4, .webm и т.д.) и сразу запустить воспроизведение."], en: ["Opens another video file (.mkv, .mp4, .webm, etc.) for playback."] },
    "player-menu.url": { ru: ["Открывает диалог ввода прямой HTTPS-ссылки на видео или страницу с потоком."], en: ["Opens the dialog to play a direct HTTPS stream or media URL."] },
    "player-menu.deck": { ru: ["Выбирает отдельную колоду Anki для карточек, к которым ты прикрепляешь сцены из видео."], en: ["Selects a dedicated Anki deck for video card mining."] },
    "player-menu.settings": { ru: ["Открывает раздел настроек Видео-плеера (перемотка, качество клипов, горячие клавиши)."], en: ["Opens Video Player settings (seeking, clip quality, shortcuts)."] },
    "player-menu.home": { ru: ["Возвращает на главный экран Setsuna к выбору режима работы."], en: ["Returns to the Home screen to switch modes."] },
    "player.ep-continue": { ru: ["Открывает серию, на которой ты остановился, с той же минуты. Время на кнопке — где именно."], en: ["Opens the episode you stopped at, from the same minute shown on the button."] },
    "player.ep-poster": { ru: ["Откроет поиск обложки: по названию и году в AniList, TVmaze и других базах, или картинка с диска. Вместе с обложкой можно поправить и название тайтла.", "Ссылка AniList ниже открывает страницу тайтла в браузере."], en: ["Opens the poster search: by name and year in AniList, TVmaze and more, or an image from disk; the title's name can be fixed too.", "The AniList link below opens the title's page in the browser."] },
    "player.ep-list": { ru: ["Все серии по порядку. Текущая выделена.", "• Полоска под серией — сколько её просмотрено.", "• Время справа — где ты остановился в этой серии.", "Клик открывает серию с того места, где ты остановился."], en: ["Every episode in order; the current one is highlighted.", "• The bar shows how much of it you watched.", "• The time is where you stopped.", "Click to open it from there."] },
    "player.poster-search": { ru: ["Впиши название (можно на ромадзи, английском или японском) и год — год помогает отличить сезоны и ремейки. «Найти» ищет сразу во всех подключённых базах."], en: ["Type the name (romaji, English or Japanese) and the year — the year tells seasons and remakes apart. \"Find\" searches every connected database."] },
    "player.poster-file": { ru: ["Если подходящей обложки нет, выбери любую картинку на диске — она станет обложкой тайтла."], en: ["If nothing fits, pick any image on disk as the title's poster."] },
    "player.poster-tmdb": { ru: ["TMDB — большая база фильмов и сериалов, в том числе не-аниме. Для неё нужен бесплатный API-ключ: зарегистрируйся на themoviedb.org, создай ключ в настройках аккаунта и вставь его сюда.", "Ключ хранится только на твоём компьютере."], en: ["TMDB is a large film and TV database, beyond anime. It needs a free API key: sign up at themoviedb.org, create a key in your account settings and paste it here.", "The key stays on your computer."] },
    "player.poster-sources": { ru: ["Вкладки показывают результаты из всех баз или только из одной (AniList, TVmaze…). Строка «Сейчас недоступны» — базы, которые не ответили: можно попробовать позже."], en: ["Tabs show results from every database or just one (AniList, TVmaze…). \"Unavailable now\" lists those that didn't answer; try later."] },
    "player.poster-results": { ru: ["Каждый результат — обложка, название и год. Клик ставит обложку и это название тайтлу. Кнопка-ссылка под ним открывает страницу тайтла в базе, чтобы убедиться, что это он."], en: ["Each result shows a poster, name and year. Click to use them for the title; the link below opens its page so you can check it's the right one."] },
    "player.poster-reset": { ru: ["Убирает выбранную обложку и возвращает название, взятое из имени папки."], en: ["Drops the chosen poster and goes back to the name from the folder."] },
    "player.episodes": { ru: ["Стрелки — предыдущая и следующая серия. В середине выпадающий список всех серий тайтла."], en: ["Arrows switch to the previous and next episode; the middle is a list of all episodes."] },
    "player.hud-deck": { ru: ["На кнопке — имя колоды Anki для карточек из видео. Отдельная колода не даёт им смешаться с карточками из книг и игр. Нажми, чтобы выбрать другую."], en: ["The button shows the Anki deck for cards from videos, so they don't mix with books and games. Click to pick another."] },
    "player.more": { ru: ["• Открыть другое видео с диска.", "• Открыть видео по ссылке.", "• Настройки плеера — раздел «Видео-плеер» в настройках."], en: ["• Open another video from disk.", "• Open a video from a link.", "• Player settings: the Video player section of Settings."] },
    "player.timeline": { ru: ["Клик по шкале перематывает, перетаскивание — плавно. При наведении всплывает время.", "Если включён повтор отрезка A–B, он подсвечен на шкале."], en: ["Click to seek, drag to scrub; hovering shows the time.", "An active A–B loop is highlighted on the timeline."] },
    "player.play": { ru: ["Пауза и воспроизведение. Работает и пробел.", "В режимах учёбы плеер может сам вставать на паузу после реплик — тогда эта кнопка продолжает."], en: ["Play and pause; Space works too.", "In study modes the player may pause after lines by itself; this button continues."] },
    "player.audio": { ru: ["Кнопка выключает звук, ползунок меняет громкость."], en: ["The button mutes, the slider sets the volume."] },
    "player.update": { ru: ["Удобный приём: найди слово в словаре и добавь карточку обычной кнопкой «+», а потом нажми эту кнопку (или U) — к той же карточке прикрепятся кадр и звук текущей реплики."], en: ["A handy flow: add a card from the dictionary with \"+\", then press this (or U) to attach the current line's frame and audio to that card."] },
    "player.fullscreen": { ru: ["Разворачивает плеер на весь экран. Выход — этой же кнопкой, F или Esc."], en: ["Full screen; leave with this button, F or Esc."] },
    "player.side": { ru: ["Справа — все реплики серии. Число рядом с заголовком — номер текущей реплики и сколько их всего.", "• Клик по реплике перематывает к ней.", "• Shift над словом открывает словарь."], en: ["All the episode's lines; the number is the current line and the total.", "• Click a line to jump to it.", "• Shift over a word for the dictionary."] },
    "player.follow": { ru: ["Когда «Авто» включено, список сам держит текущую реплику на виду. Если хочешь пролистать назад и почитать, выключи — список перестанет прыгать."], en: ["With Auto on, the list keeps the current line in view. Turn it off to scroll back and read without it jumping."] },
    "player.tracks": { ru: ["• Дорожка субтитров — японские из файла рядом, из самого видео или открыть файл.", "• Дорожка перевода — вторые субтитры для сравнения.", "• Сдвиг — если субтитры появляются раньше или позже речи, сдвинь их на нужные секунды."], en: ["• Subtitle track: Japanese from a file next to the video, inside it, or opened by hand.", "• Translation track: second subtitles to compare.", "• Offset: shift subtitles that appear early or late."] },
    "player.line-search": { ru: ["Ищет фразу во всех репликах серии. Клик по найденной перематывает к ней."], en: ["Finds a phrase in every line of the episode; click a match to jump there."] },
    "player.side-steps": { ru: ["Стрелки ↑ и ↓ перематывают видео ровно к предыдущей или следующей реплике субтитров."], en: ["The ↑ and ↓ arrows jump playback straight to the previous or next subtitle line."] },
    "player.side-close": { ru: ["Скрывает правую боковую панель с репликами, чтобы видео занимало весь экран. Клавиша T открывает её обратно."], en: ["Closes the right transcript sidebar so the video fills the window; press T to bring it back."] },
    "player.study": { ru: [
        "## Режим и скорость",
        "• Режим просмотра — как плеер ведёт себя на репликах (подробнее в следующей подсказке).",
        "• Скорость — замедлить, чтобы расслышать быструю речь, или ускорить.",
        "• Перемотка ← / → — по секундам или сразу к соседней реплике; шаг перемотки в секундах.",
        "• Авто-продолжение — после паузы на реплике продолжать вручную, через фиксированное время или через время, зависящее от длины реплики.",
        "• Мин. пауза — паузы короче этого не ускоряются и не пропускаются.",
        "## Субтитры",
        "• Показ субтитров — всегда, только на паузе или по клавише R: так можно тренировать слух.",
        "• Интерактив — пауза при наведении на субтитры и блюр перевода, чтобы не подглядывать.",
        "• Размер, высота над краем и прозрачность фона субтитров.",
        "## Повтор отрезка",
        "A и B задают начало и конец куска, который плеер крутит по кругу.",
    ], en: [
        "## Mode and speed",
        "• Study mode: how the player handles lines (next tip).",
        "• Speed: slow down fast speech or speed up.",
        "• Arrow keys: seek by seconds or jump to the next line; the seek step.",
        "• Auto-resume after a line pause: by hand, after a fixed time, or a time based on the line's length.",
        "• Min gap: shorter gaps are not sped up or skipped.",
        "## Subtitles",
        "• Show subtitles: always, only when paused, or on R — good for listening practice.",
        "• Immersion: pause on hover over subtitles and blur the translation.",
        "• Size, height above the edge and background opacity.",
        "## A–B loop",
        "A and B set the start and end of a part the player loops.",
    ] },
    "player.study-mode": { ru: [
        "• Обычный просмотр — как в любом плеере.",
        "• Пауза после реплики — плеер останавливается после каждой фразы: успеешь прочитать и разобрать её.",
        "• Пауза в начале реплики — останавливается перед фразой: можно сначала прочитать, потом послушать.",
        "• Ускорять паузы — места без речи проигрываются быстрее.",
        "• Повтор реплики — каждая фраза звучит несколько раз (число повторов настраивается).",
        "• Пропуск пауз — места без речи пропускаются совсем.",
    ], en: [
        "• Normal playback.",
        "• Pause after each line: stops after every phrase so you can read and work it out.",
        "• Pause at line start: stops before a phrase so you can read first, then listen.",
        "• Fast-forward gaps: parts without speech play faster.",
        "• Repeat line: each phrase plays several times (set the count).",
        "• Skip gaps: parts without speech are skipped.",
    ] },
    "player.study-loop": { ru: ["Перемотай к началу нужного места и нажми A, потом к концу и нажми B. Плеер будет повторять этот кусок, пока не сбросишь повтор. Отрезок подсвечивается на шкале времени."], en: ["Seek to the start and press A, then to the end and press B; the player loops that part until you clear it. It's highlighted on the timeline."] },
};

export const tipDetail = (id: string, language: string): string[] | null => {
    const detail = DETAILS[id];
    if (!detail) return null;
    return language === "en" ? detail.en : detail.ru;
};

export const TIP_DETAIL_IDS = Object.keys(DETAILS);
