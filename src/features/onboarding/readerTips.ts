import { getTranslator } from "../../utils/i18n";
import type { CoachStep } from "./guides";

// Tips for the reader (library, EPUB, manga, PDF) and the video player. Buttons
// are targeted by explicit `data-coach` hooks or unique translated titles/aria-labels
// so two buttons never collide.

type Tip = [id: string, target: string | ((t: Translate, en: boolean) => string), ruTitle: string, ruBody: string, enTitle: string, enBody: string];
type Translate = ReturnType<typeof getTranslator>;

const quote = (value: string) => value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
/** Elements whose title starts with this text (titles often add a shortcut or a value after it). */
const titled = (text: string) => `[title^="${quote(text)}"]`;
const labelled = (text: string) => `[aria-label="${quote(text)}"]`;

/** `scope` keeps a tip inside its screen: the library and the open book share some titles. */
const build = (tips: Tip[], language: string, scope: string): CoachStep[] => {
    const en = language === "en";
    const t = getTranslator(en ? "en" : "ru");
    return tips.map(([id, target, ruTitle, ruBody, enTitle, enBody]) => ({
        id,
        target: `${scope} ${typeof target === "function" ? target(t, en) : target}`,
        title: en ? enTitle : ruTitle,
        body: en ? enBody : ruBody,
    }));
};

const LIBRARY: Tip[] = [
    ["library.sync", '[data-coach="lib-sync"]',
        "Облако Google Диска", "Синхронизирует книги, обложки, закладки и прогресс чтения между ПК и телефоном. Зелёная галочка значит, что всё актуально; клик запускает синхронизацию или открывает вход в Диск.",
        "Google Drive sync", "Syncs books, covers, bookmarks and reading progress between PC and phone. A green check means everything is up to date; click to sync or sign in to Drive."],
    ["library.stats", '[data-coach="lib-stats"]',
        "Статистика и цели", "Сколько ты прочитал по дням, текущая серия дней, скорость чтения и дневная цель.",
        "Stats and goals", "Characters read per day, current streak, reading speed and daily goal."],
    ["library.mokuro", '[data-coach="lib-mokuro"]',
        "Mokuro OCR по томам", "Пакетно запускает распознавание текста Mokuro на выбранных томах манги, чтобы баблы стали кликабельными для словаря.",
        "Batch Mokuro OCR", "Runs Mokuro text recognition across selected manga volumes so bubbles become clickable for the dictionary."],
    ["library.select", '[data-coach="lib-select"]',
        "Выбрать несколько", "Включает массовый выбор книг: удобно сразу сменить статус, полку, серию, прогнать Mokuro или удалить выбранные.",
        "Select books", "Turns on multi-select to change status, shelves, series, run Mokuro or remove several books at once."],
    ["library.display", '[data-coach="lib-display"]',
        "Вид библиотеки", "Размер карточек, как обрезать обложки и какие подписи показывать на карточке. Здесь же экспорт и импорт резервной копии библиотеки.",
        "Library view", "Card size, cover fit and which fields appear on cards, plus JSON backup export and import."],
    ["library.folder", '[data-coach="lib-folder"]',
        "Добавить папку", "Сканирует выбранную папку (вместе с подпапками) и добавляет все найденные книги и мангу в библиотеку.",
        "Add folder", "Scans a folder and its subfolders and imports every supported book or manga volume found inside."],
    ["library.open", '[data-coach="lib-open"]',
        "Открыть книгу", "Добавляет один файл книги или манги: EPUB, FB2, PDF, DOCX, MOBI, AZW3, TXT, HTML, Markdown или архив манги (CBZ/ZIP) с файлом .mokuro.",
        "Open book", "Adds a single book or manga file: EPUB, FB2, PDF, DOCX, MOBI, AZW3, TXT, HTML, Markdown or a manga archive (CBZ/ZIP) with .mokuro."],
    ["library.shelves", '[data-coach="lib-shelves"]',
        "Полки и статусы", "Быстро отфильтровать книги по типу (книги / манга), статусу (читаю, не начато, прочитано…) или разложить по своим полкам кнопкой «+ Полка».",
        "Shelves and status", "Filter by type (books / manga), reading status, or group books onto custom shelves with \"+ Shelf\"."],
    ["library.search", '[data-coach="lib-search"]',
        "Поиск по библиотеке", "Ищет по названию, автору, серии, тегам и полкам прямо во время набора.",
        "Search the library", "Searches titles, authors, series, tags and shelves as you type."],
    ["library.filters", '[data-coach="lib-filters"]',
        "Фильтры и сортировка", "Фильтр по языку (JA / EN), группировка по сериям или авторам и порядок сортировки (недавние, по названию, прогрессу).",
        "Filters and sorting", "Language filter (JA / EN), grouping by series or author, and sort order (recent, title, progress)."],
    ["library.card", ".epub-book-card",
        "Карточка книги", "Клик открывает книгу там, где ты остановился (или скачивает её из облака). При наведении доступны поиск обложки/тайтла, редактирование метаданных и меню по правому клику.",
        "Book card", "Click to resume where you stopped (or download from the cloud). Hover actions let you search covers/metadata, edit details, or right-click for more."],
];

const EPUB_COMMON: Tip[] = [
    ["epub.back", (t) => titled(t("epub.backToLibrary")),
        "К библиотеке", "Закрывает книгу и возвращает к списку книг. Место, где ты остановился, сохранится.",
        "Back to library", "Closes the book and returns to your library. Your reading position is saved."],
    ["epub.bookmarks", (t) => titled(t("epub.bookmarks")),
        "Закладки", "Открывает панель закладок (клавиша B): можно отметить важное место и потом быстро вернуться к нему.",
        "Bookmarks", "Opens the bookmarks drawer (key B) to save places and jump back later."],
    ["epub.stats", (t) => titled(t("epub.statsTitle")),
        "Статистика и цель", "Кружок показывает прогресс дневной цели чтения. Нажми, чтобы открыть скорость, время и дневную статистику.",
        "Stats and goal", "The dot shows today's reading goal progress. Click to view speed, time and daily stats."],
    ["epub.zen", (t) => titled(t("epub.zenMode")),
        "Zen-режим", "Прячет все панели, остаётся только текст. Клавиша Z включает и выключает режим.",
        "Zen mode", "Hides all panels so only the text remains. Press Z to toggle it."],
];

/** EPUB / text reader specific controls. */
const EPUB: Tip[] = [
    ["epub.toc", '[data-coach="epub-toc"]',
        "Оглавление", "Список глав книги: текущая выделена, клик сразу переходит к выбранной главе.",
        "Contents", "The chapter list: the active chapter is highlighted; click any to jump."],
    ["epub.lang", '[data-coach="epub-lang"]',
        "Язык книги", "Определённый язык книги (JA или EN) — от него зависят словарь, фуригана и режим вертикального чтения.",
        "Book language", "Detected book language (JA or EN), used for dictionary lookups, furigana and vertical reading."],
    ["epub.orientation", ".epub-orientation-glass-select",
        "Направление текста", "Переключает чтение японской книги: как задумано в файле (Авто), горизонтально или вертикально справа налево.",
        "Text direction", "Switches Japanese book layout between book default (Auto), horizontal and vertical right-to-left."],
    ["epub.sentences", '[data-coach="epub-sentences"]',
        "Предложения и копирование", "Включает выбор предложений (одного или нескольких подряд, без фуриганы) для копирования. На ПК можно также нажать правой кнопкой мыши по любому предложению.",
        "Sentences & copy", "Select one or multiple sentences in order to copy clean text (without furigana). On PC you can also right-click any sentence."],
    ["epub.search", '[data-coach="epub-search"]',
        "Поиск по книге", "Найти слово или фразу во всей книге (Ctrl+F) и сразу перейти к нужному абзацу.",
        "Search the book", "Find any word or phrase across the whole book (Ctrl+F) and jump straight there."],
    ["epub.notes", '[data-coach="epub-notes"]',
        "Цитаты и заметки", "Открывает сохранённые выделения текста и личные заметки к книге.",
        "Highlights & notes", "Opens your saved highlights and reading notes for this book."],
    ["epub.gallery", '[data-coach="epub-gallery"]',
        "Галерея иллюстраций", "Показывает все картинки из книги в одном месте без лишнего спойлер-поиска по главам.",
        "Illustration gallery", "Browse all illustrations inside the book in one place."],
    ["epub.point", '[data-coach="epub-point"]',
        "Точка чтения", "Помечает текущий абзац якорем: если отойдёшь полистать назад или в оглавление, кнопка ↩ внизу вернёт ровно сюда.",
        "Reading point", "Pins the current paragraph so if you browse earlier pages or the contents, ↩ below brings you right back."],
    ["epub.audio", '[data-coach="epub-audio"]',
        "Озвучка и аудиокнига", "Открывает панель озвучки: чтение текста голосом (TTS) или синхронное прослушивание аудиокниги.",
        "Audio & audiobook", "Opens the audio bar for text-to-speech or synced audiobook playback."],
    ["epub.appearance", '[data-coach="epub-appearance"]',
        "Вид текста (Aa)", "Шрифт, размер, отступы, тема страницы, фуригана, блюр картинок, режим страницами или прокруткой.",
        "Appearance (Aa)", "Font, size, spacing, page theme, furigana, image blur, and paged vs scroll reading mode."],
    ["epub.chapters", (t) => titled(t("epub.nextChapter")),
        "Главы и страницы", "Стрелки листают страницы и главы. В режиме прокрутки достаточно докрутить за конец главы — кольцо заполнится и откроет следующую.",
        "Chapters and pages", "Arrows flip pages and chapters. In scroll mode, keep scrolling past the end to fill the ring and open the next chapter."],
    ["epub.autoscroll", '[data-coach="epub-autoscroll"]',
        "Автопрокрутка", "Плавно прокручивает текст сама (клавиша S — старт/пауза, A / D — скорость).",
        "Auto-scroll", "Smoothly scrolls text hands-free (S toggles, A / D adjusts speed)."],
    ["epub.return-point", '[data-coach="epub-return-point"]',
        "Вернуться к точке чтения", "Мгновенно возвращает к абзацу, который ты отметил кнопкой «Точка чтения».",
        "Return to reading point", "Jumps straight back to the paragraph pinned with Reading point."],
    ["epub.freeze", '[data-coach="epub-freeze"]',
        "Заморозить позицию", "Блокирует перезапись сохранённого прогресса, пока ты просматриваешь старые главы или ищешь сцену.",
        "Freeze position", "Locks your saved reading progress while browsing earlier chapters so you don't lose your spot."],
    ["epub.tracking", '[data-coach="epub-tracking"]',
        "Пауза таймера чтения", "Ставит счётчик времени и скорости чтения в этой книге на паузу и снимает с неё.",
        "Pause reading timer", "Pauses or resumes the reading time and speed tracker for this book."],
];

const MANGA: Tip[] = [
    ["manga.bubbles", '[data-coach="manga-bubbles"]',
        "Баблы и копирование", "Выбор нескольких баблов подряд для копирования текста. Отдельный бабл можно скопировать кнопкой на нём или правым кликом (на телефоне — также кнопкой копирования в карточке словаря).",
        "Bubbles & copy", "Select multiple bubbles in reading order to copy them together. Copy a single bubble with its corner button, right-click (PC), or from the mobile lookup card."],
    ["manga.mokuro", ".manga-badge-btn",
        "Слой Mokuro", "Показывает, распознан ли текст в этом томе. Если нет — нажми, чтобы запустить распознавание Mokuro или прикрепить готовый файл .mokuro. После этого на баблы можно наводить курсор с Shift.",
        "Mokuro layer", "Shows whether this volume's text is recognised. If not, click to run Mokuro or attach a ready .mokuro file. Then hold Shift over a bubble to look it up."],
    ["manga.crop", (_t, en) => titled(en ? "Select bubble area to OCR" : "Обвести бабл для OCR"),
        "Обвести бабл", "Распознать один бабл без Mokuro: обведи его мышью (клавиша S), и текст появится со словарём.",
        "Select a bubble", "Recognise a single bubble without Mokuro: draw around it (key S) and its text opens with the dictionary."],
    ["manga.pages", (_t, en) => titled(en ? "Pages" : "Страницы"),
        "Страницы", "Миниатюры всех страниц тома: быстро перейти к нужной.",
        "Pages", "Thumbnails of every page in the volume to jump to one quickly."],
    ["manga.settings", (_t, en) => titled(en ? "Reader appearance & layout" : "Настройки читалки"),
        "Настройки читалки", "Одна или две страницы, направление листания (справа налево, как в японской манге), масштаб и как показывать текст баблов.",
        "Reader settings", "One or two pages, page direction (right to left, as in Japanese manga), zoom and how bubble text is shown."],
];

const PDF: Tip[] = [
    ["pdf.back", (t) => titled(t("epub.library")),
        "К библиотеке", "Закрывает PDF и возвращает к списку книг. Страница, на которой ты остановился, сохранится.",
        "Back to library", "Closes the PDF and returns to your library. Your page is saved."],
    ["pdf.drawer", (t) => titled(t("epub.toc")),
        "Боковая панель", "Четыре вкладки: оглавление, миниатюры всех страниц, закладки (клавиша B) и заметки. Закладки и заметки синхронизируются через Google Диск.",
        "Side panel", "Four tabs: contents, thumbnails of every page, bookmarks (key B) and notes. Bookmarks and notes sync through Google Drive."],
    ["pdf.point", (t) => titled(t("epub.readingPoint")),
        "Точка чтения", "Отмечает, где ты читаешь (клавиша O). Если отошёл посмотреть другую страницу, клавиша R вернёт обратно.",
        "Reading point", "Marks where you are reading (key O). If you go look at another page, R brings you back."],
    ["pdf.appearance", (t) => titled(t("epub.appearance")),
        "Вид страницы (Aa)", "Режим: одна страница, разворот из двух или сплошная лента. Масштаб по ширине или по странице, приближение (или Ctrl+колесо), поворот на 90° и тема: оригинал, сепия, тёмная, e-ink.",
        "Page look (Aa)", "Layout: one page, a two-page spread or continuous scroll. Fit to width or page, zoom (or Ctrl+wheel), 90° rotation and a theme: original, sepia, dark, e-ink."],
    ["pdf.reflow", (_t, en) => titled(en ? "Toggle Page / Reflow" : "Переключить Страница"),
        "Только текст", "Показывает PDF как обычный текст без вёрстки, в том числе вертикальный японский. Его удобнее читать, и по нему работает словарь.",
        "Text only", "Shows the PDF as plain text without the layout, vertical Japanese included. Easier to read, and the dictionary works on it."],
    ["pdf.search", (_t, en) => titled(en ? "Search PDF" : "Поиск по PDF"),
        "Поиск по PDF", "Найти текст во всём документе и перейти к странице.",
        "Search the PDF", "Find text anywhere in the document and jump to its page."],
    ["pdf.page", (_t, en) => labelled(en ? "Page number" : "Номер страницы"),
        "Номер страницы", "Впиши номер и нажми Enter, чтобы перейти. Полоса внизу листается мышью. Выделенный текст можно найти в словаре, скопировать или сохранить в заметку.",
        "Page number", "Type a number and press Enter to jump. Drag the bar at the bottom to flip through. Selected text can be looked up, copied or saved as a note."],
];

const L = (ru: string, en: string) => (_t: Translate, isEn: boolean) => labelled(isEn ? en : ru);
const T = (ru: string, en: string) => (_t: Translate, isEn: boolean) => titled(isEn ? en : ru);

/** The video library (first screen of the player). */
const PLAYER_LIBRARY: Tip[] = [
    ["player.open", ".sp-source-actions > button:first-child",
        "Открыть видео", "Открывает видеофайл с диска. Субтитры с тем же именем рядом подхватятся сами.",
        "Open a video", "Opens a video file; subtitles with the same name next to it are picked up automatically."],
    ["player.url", ".sp-source-actions > button:nth-child(2)",
        "Видео по ссылке", "Открыть видео по прямой ссылке из интернета вместо файла.",
        "Video from a link", "Open a video from a direct web link instead of a file."],
    ["player.deck", '[data-coach="player-deck"]',
        "Колода Anki для плеера", "Показывает, в какую колоду пойдут карточки из видео (иначе используется основная колода из настроек). Нажми, чтобы выбрать другую.",
        "Player Anki deck", "Shows which Anki deck video cards go into (or your default deck). Click to pick another."],
    ["player.folders", '[data-coach="player-folders"]',
        "Папки видеотеки", "Список папок, из которых собрана видеотека: можно пересканировать их вручную или убрать лишнюю папку.",
        "Library folders", "The folders your video library is built from: rescan them or remove a folder."],
    ["player.addfolder", '[data-coach="player-addfolder"]',
        "Добавить папку", "Выбери папку с сериалом или сезоном — Setsuna сама разложит серии по тайтлам и найдёт обложки.",
        "Add folder", "Pick a folder with anime, films or shows; Setsuna groups episodes into titles and finds posters."],
    ["player.filter", '[data-coach="player-filter"]',
        "Фильтр по статусу", "Все тайтлы, только те, что смотришь сейчас, или уже просмотренные.",
        "Status filter", "All titles, only those you're watching, or finished ones."],
    ["player.search", '[data-coach="player-search"]',
        "Поиск по видеотеке", "Найти тайтл или серию по названию.",
        "Library search", "Find a title or an episode by name."],
    ["player.sort", '[data-coach="player-sort"]',
        "Сортировка", "Показывает тайтлы по алфавиту или ставит выше то, что ты смотрел недавно.",
        "Sort", "Order titles alphabetically or bring recently watched titles to the top."],
    ["player.hero", ".sp-continue-hero",
        "Продолжить просмотр", "Последний тайтл, который ты смотрел: серия, время и прогресс. «Продолжить» откроет с того же места, «Серии» — список серий.",
        "Continue watching", "The last title you watched: episode, time and progress. \"Continue\" resumes there, \"Episodes\" lists them."],
    ["player.card", ".sp-library-grid > :first-child",
        "Тайтл", "Обложка, год и сколько серий просмотрено. Клик открывает список серий; при наведении кнопка ▶ сразу запускает текущую серию.",
        "A title", "Poster, year and how many episodes you've watched. Click for the episode list, or hover and press ▶ to play right away."],
];

/** The episode list of one title. */
const PLAYER_EPISODES: Tip[] = [
    ["player.ep-continue", ".sp-library-details-actions .sp-library-primary",
        "Продолжить серию", "Открывает серию, на которой ты остановился, с того же момента.",
        "Continue the episode", "Opens the episode you stopped at, from the same moment."],
    ["player.ep-poster", ".sp-library-details-actions > button:not(.sp-library-primary)",
        "Сменить обложку", "Найти другую обложку и название тайтла в интернете или взять картинку с диска.",
        "Change the poster", "Find another poster and title online, or use an image from disk."],
    ["player.ep-list", ".sp-library-episodes",
        "Серии", "Все серии тайтла. Полоска под серией — сколько просмотрено, время справа — где ты остановился. Клик открывает серию.",
        "Episodes", "Every episode. The bar shows how much you watched, the time where you stopped. Click to open one."],
];

/** "Choose a poster" window. */
const PLAYER_POSTER: Tip[] = [
    ["player.poster-search", ".sp-poster-search",
        "Поиск обложки", "Название и год тайтла. «Найти» ищет обложки сразу в нескольких базах аниме и сериалов.",
        "Poster search", "The title's name and year; \"Find\" searches several anime and TV databases."],
    ["player.poster-file", "div.sp-dialog-actions",
        "Обложка из файла", "Взять обложку с диска, если в интернете подходящей не нашлось.",
        "Poster from a file", "Use an image from disk if nothing fits online."],
    ["player.poster-tmdb", ".sp-poster-tmdb",
        "Подключить TMDB", "Ещё один источник обложек — TMDB, большая база фильмов и сериалов. Нужен бесплатный ключ с их сайта.",
        "Add TMDB", "One more poster source: TMDB, a big film and TV database. Needs a free key from their site."],
    ["player.poster-sources", ".sp-library-dialog.is-wide .sp-library-tabs",
        "Источники", "Показать результаты из всех баз сразу или только из одной. Ниже видно, какие базы сейчас не отвечают.",
        "Sources", "Results from every database or just one. Below: which ones aren't answering right now."],
    ["player.poster-results", ".sp-poster-options",
        "Найденные обложки", "Клик по обложке ставит её и название тайтла. Ссылка под ней открывает страницу тайтла в базе.",
        "Found posters", "Click a poster to use it and its title; the link below opens the title's page."],
    ["player.poster-reset", "footer.sp-dialog-actions",
        "Сбросить", "Вернуть название по имени папки и убрать выбранную обложку.",
        "Reset", "Go back to the folder's name and drop the chosen poster."],
];

/** The player itself. */
const PLAYER_SCREEN: Tip[] = [
    ["player.library", L("Видеотека", "Library"),
        "К видеотеке", "Возврат к списку тайтлов. Место в серии сохраняется.",
        "Back to library", "Back to the title list; your place in the episode is saved."],
    ["player.episodes", ".sp-episode-nav",
        "Серии", "Предыдущая и следующая серия, а в середине — список всех серий тайтла.",
        "Episodes", "Previous and next episode; the middle opens the full list."],
    ["player.hud-deck", '[data-coach="player-hud-deck"]',
        "Колода Anki для плеера", "Колода Anki для карточек из видео. Нажми, чтобы выбрать другую.",
        "Player Anki deck", "The Anki deck used when mining from video; click to change it."],
    ["player.more", L("Другие действия", "More options"),
        "Ещё", "Открыть другое видео с диска, ссылку HTTPS, настройки плеера или меню Esc.",
        "More", "Open another video from disk, an HTTPS URL, player settings or the Esc menu."],
    ["player.side", ".sp-side-title",
        "Реплики серии", "Все реплики списком; текущая подсвечена, число — её номер. Клик перематывает к реплике, Shift над словом открывает словарь.",
        "Episode lines", "All lines as a list; the current one is highlighted with its number. Click to jump, Shift over a word for the dictionary."],
    ["player.follow", ".sp-follow-pill",
        "Автопрокрутка реплик", "Список сам прокручивается за текущей репликой. Выключи, чтобы спокойно листать назад.",
        "Auto-follow", "The list follows the current line; turn it off to scroll back freely."],
    ["player.tracks", L("Дорожки субтитров и сдвиг", "Subtitle tracks & offset"),
        "Дорожки и сдвиг", "Выбрать дорожку субтитров и перевода и сдвинуть их, если они спешат или опаздывают.",
        "Tracks and offset", "Pick subtitle and translation tracks and shift them if they run early or late."],
    ["player.line-search", L("Поиск по репликам", "Search lines"),
        "Поиск по репликам", "Найти фразу среди всех реплик серии и перейти к ней.",
        "Search lines", "Find a phrase among the episode's lines and jump to it."],
    ["player.side-steps", '[data-coach="player-side-steps"]',
        "Перейти к реплике ↑ / ↓", "Быстро прыгнуть на предыдущую или следующую реплику (стрелки ↑ и ↓).",
        "Step lines ↑ / ↓", "Jump straight to the previous or next subtitle line (↑ and ↓)."],
    ["player.side-close", '[data-coach="player-side-close"]',
        "Скрыть панель реплик", "Закрывает боковой список реплик (клавиша T открывает и закрывает его).",
        "Hide transcript", "Closes the side transcript panel (press T to toggle it)."],
    ["player.timeline", ".sp-timeline-wrap",
        "Шкала времени", "Клик или перетаскивание перематывает. При наведении видно время. Отрезок повтора A–B подсвечивается на шкале.",
        "Timeline", "Click or drag to seek; hover shows the time. An A–B loop is highlighted on it."],
    ["player.play", ".sp-play-button",
        "Пауза и воспроизведение", "Пробел тоже ставит на паузу.",
        "Play and pause", "Space works too."],
    ["player.lines", ".sp-transport-step",
        "Переход по репликам", "К предыдущей или следующей реплике (↑ и ↓), чтобы переслушать фразу.",
        "Jump between lines", "Previous or next line (↑ and ↓) to hear a phrase again."],
    ["player.audio", ".sp-transport-audio",
        "Звук", "Выключить звук и отрегулировать громкость.",
        "Sound", "Mute and adjust volume."],
    ["player.anki", ".sp-mine-quick",
        "Реплика в Anki", "Сразу делает карточку из текущей реплики вместе с кадром и звуком.",
        "Line to Anki", "Makes a card from the current line with its frame and audio right away."],
    ["player.update", L("Обновить последнюю карточку Anki", "Update last Anki card"),
        "Дополнить последнюю карточку", "Прикрепляет кадр и звук этой реплики к карточке, которую ты только что сделал из словаря (клавиша U).",
        "Update the last card", "Attaches this line's frame and audio to the card you just made from the dictionary (U)."],
    ["player.subs", L("Субтитры на видео", "Subtitles on video"),
        "Субтитры на видео", "Показывать или прятать субтитры поверх картинки.",
        "Subtitles on video", "Show or hide subtitles over the picture."],
    ["player.settings", T("Настройки просмотра", "Playback settings"),
        "Настройки просмотра", "Режим учёбы, скорость, перемотка, показ субтитров и повтор отрезка.",
        "Playback settings", "Study mode, speed, seeking, subtitle display and A–B loop."],
    ["player.transcript", L("Реплики", "Transcript"),
        "Панель реплик", "Показать или спрятать список всех реплик справа (клавиша T).",
        "Line panel", "Show or hide the list of all lines on the right (T)."],
    ["player.fullscreen", ".sp-transport-view > button:last-child",
        "Во весь экран", "Развернуть видео на весь экран и обратно (F).",
        "Full screen", "Toggle full screen (F)."],
];

/** Playback settings window. */
const PLAYER_STUDY: Tip[] = [
    ["player.study", ".sp-study",
        "Настройки просмотра", "Здесь всё, что помогает учиться по видео: режимы паузы и повтора, скорость, перемотка, показ субтитров и их вид.",
        "Playback settings", "Everything that helps you study with video: pause and repeat modes, speed, seeking, subtitle display and look."],
    ["player.study-mode", ".sp-study > label:first-child",
        "Режим просмотра", "Как плеер ведёт себя на репликах: обычно, пауза после или в начале каждой, повтор, ускорение или пропуск пауз без речи.",
        "Study mode", "How the player handles lines: normal, pause after or at the start of each, repeat, or speed up / skip silent gaps."],
    ["player.study-loop", ".sp-study fieldset",
        "Повтор отрезка A–B", "Нажми A в начале нужного места и B в конце — плеер будет крутить этот кусок по кругу.",
        "A–B loop", "Press A at the start and B at the end; the player loops that part."],
];

/** Library folders dialog. */
const PLAYER_FOLDERS: Tip[] = [
    ["player.folders-refresh", "[data-coach='player-folders-refresh']",
        "Обновить папки", "Заново сканирует подключённые папки и подхватывает новые серии и постеры.",
        "Refresh folders", "Rescans connected folders to pick up new episodes and posters."],
    ["player.folders-list", "[data-coach='player-folders-list']",
        "Подключённые папки", "Список папок видеотеки и их пути. Папку можно убрать из списка — сами файлы на диске останутся.",
        "Connected folders", "The folders included in your library and their paths. Removing a folder leaves files on disk untouched."],
];

/** Reader mode: library first, then whichever reader is open. */
export const readerTips = (language: string): CoachStep[] => [
    ...build(LIBRARY, language, ".epub-library"),
    // Back, bookmarks, stats and Zen look the same in every reader.
    ...build(EPUB_COMMON, language, ":is(.epub-reader-shell, .pdf-reader-shell)"),
    ...build(EPUB, language, ".epub-reader-shell"),
    ...build(MANGA, language, ".epub-reader-shell"),
    ...build(PDF, language, ".pdf-reader-shell"),
];

export const playerTips = (language: string): CoachStep[] => [
    ...build(PLAYER_LIBRARY, language, ".sp-library"),
    ...build(PLAYER_FOLDERS, language, ".sp-library-dialog"),
    ...build(PLAYER_EPISODES, language, ".sp-library-dialog:not(.is-wide)"),
    ...build(PLAYER_POSTER, language, ".sp-library-dialog.is-wide"),
    ...build(PLAYER_SCREEN, language, ".sp-body"),
    ...build(PLAYER_STUDY, language, ".sp-library-dialog"),
];
