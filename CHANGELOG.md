# Changelog

## 0.6.0 beta - 2026-11-25

Внутренняя версия обновления: `8` (`0.6.0` для Tauri updater).

### Русский

> **Статус функций:** **Читалка** и **Видео-плеер** (на ПК и в мобильной версии) находятся в статусе **Бета**. **ИИ-объяснения (LLM)** — экспериментальная тестовая функция, которая может не войти в финальный релиз. Поддержка **английского как целевого языка изучения** — **ранняя альфа** (основной фокус — японский).

#### Читалка (Бета)
- **Мультиформатность:** помимо `.epub`, добавлена поддержка `.fb2` / `.fb2.zip`, `.html`, `.md`, `.txt` (включая Aozora Bunko с фуриганой и автоопределением кодировки), `.docx` (включая `<w:ruby>`), DRM-free `.mobi` / `.azw3` и интерактивной **PDF-читалки** (Canvas + выделение/лукап текста + режим сплошного текста, поиск, оглавление, ночной инверт).
- **Читалка манги и Mokuro OCR:** нативный просмотр папок, `.cbz`/`.zip`, `.cbr`/`.rar`/`.7z` (распаковка на ПК) со слоем `.mokuro` / `.mokuro.gz` и правками OCR прямо в баблах, двухстраничный разворот и вебтун-режим, улучшенная вёрстка крупных/многострочных баблов и автоматическая очистка имён от мусорных префиксов релиз-групп.
- **Пакетный Mokuro OCR из библиотеки:** запуск `mokuro CLI` по нескольким томам очереди прямо из главного экрана библиотеки или контекстного меню с прогрессом по томам/страницам (CUDA/CPU, ETA) и безопасной остановкой.
- **Поиск названий и обложек по каталогам:** AniList, Shikimori, Kitsu, MangaUpdates, Jikan (MAL), Apple Books JP и MangaDex (включая покадровые/потомные обложки для всей серии за один шаг и загрузку обложки из файла).
- **Конвертация в CBZ и полная синхронизация (ПК ↔ Android):** преобразование тома в `.cbz` (со вшитым `.mokuro`, правками и обложкой) и автоматическая синхронизация прогресса, закладок, заметок, полок, форматов и самих файлов через Google Drive (до 250 МБ), плюс локальный JSON-бэкап библиотеки.
- **Аудиокниги, типографика и трекер:** синхронизация книг со звуковой дорожкой/субтитрами (SRT/VTT, автопауза и майнинг аудио-сцен в Anki), LiquidGlass-интерфейс, E-Ink режим, группировка по сериям/авторам, полки, скрытие спойлерных картинок, статистика, цели и серии дней чтения.

#### Видео-плеер (Бета)
- **Видеотека:** сканирование папок, автоматический разбор сериалов/сезонов/эпизодов, подбор постеров и хранение прогресса.
- **Кинотеатр и двойные субтитры:** безрамочный плеер с автоскрывающимся HUD, поддержкой `.srt`/`.vtt`/`.ass` и встроенных дорожек, HLS-потоками, переключением аудиодорожек, поиском по репликам и точным сдвигом тайминга (`Shift + [` / `Shift + ]`).
- **Режимы погружения:** пауза при наведении на субтитр, скрытие сабов для тренировки на слух (`Повтор` по `R`), блюр перевода до наведения, regex-фильтр ремарок/SFX, умное авто-продолжение паузы и настройка внешнего вида субтитров.
- **Майнинг в Anki:** вырезка видео- и аудиосцен с настраиваемым запасом до/после реплики (`Tiny`/`Compact`/`Balanced`/`High`), кнопка `U` / `↻` («Дополнить последнюю карточку Anki») и ручной редактор сцен.

#### Совместное чтение (P2P)
- Комнаты совместного чтения поверх WebRTC (Trystero / Nostr-реле) с кодом `XXX-XXX`, синхронизацией строк в реальном времени и режимом зрителя.

#### Лукап, словари и Anki
- **Скан по всему Windows (`Shift + Z`):** всплывающий словарь поверх любых приложений (браузер, игры, Discord) с автозакрытием и закреплением.
- **Шаблон `Setsuna Japanese` v3 и QoL:** встроенный шаблон карточек Anki (питч-акцент, фуригана, подсветка слова, ночная тема), выбор колоды на вкладку, привязка окна захвата к вкладке и обмен словарями через Google Drive.
- Улучшена разметка фуриганы для Anki и надёжность поиска/дубликатов.

#### ИИ-объяснения (Тест)
- Локальная LLM-панель (Gemma 4 / llama.cpp) с чатами по вкладкам, общим чатом, памятью имён и терминов — **тестовая функция**, которая может не попасть в финальный релиз.

#### Android / Мобильная версия
- Единый стек системного жеста «Назад» (`OnBackPressedCallback`) с пошаговым закрытием меню, модалок, ридера и вкладок без случайного выхода из приложения.
- Мобильный режим читалки (книги и манга) с OCR-цепочкой (ПК по Wi-Fi → локальный ONNX → ML Kit), быстрым меню на карточках и синхронизацией прогресса/файлов с ПК через Google Drive.

---

### English

> **Feature status:** **Reader** and **Video Player** (Desktop & Mobile) are in **Beta**. **AI explanations (LLM)** is an experimental **Test** feature that may not make it into the final release. **English as a target learning language** is in **early alpha** (Setsuna currently focuses on Japanese).

#### Reader (Beta)
- **Multi-format support:** added `.fb2` / `.fb2.zip`, `.html`, `.md`, `.txt` (including Aozora Bunko ruby & auto encoding detection), `.docx` (with `<w:ruby>` furigana), DRM-free `.mobi` / `.azw3`, and an interactive **PDF Reader** (HiDPI canvas + selectable/hoverable word lookup + text reflow view, outline, full-text search, night invert).
- **Manga Reader & Mokuro OCR:** native reading for image folders, `.cbz`/`.zip`, and `.cbr`/`.rar`/`.7z` (desktop extract) with `.mokuro` / `.mokuro.gz` layers, inline typo overrides, single/spread/webtoon modes, improved layout for large multi-line text blocks, and automatic cleanup of release-group tags in titles.
- **Batch Mokuro OCR from Library:** run `mokuro CLI` sequentially across multiple volumes right from the Library or card context menu with live per-volume & per-page progress (CUDA/CPU, ETA) and safe stop-after-current cancellation.
- **Catalog Title & Cover Picker:** integrated AniList, Shikimori, Kitsu, MangaUpdates, Jikan (MAL), direct Apple Books JP, and MangaDex (including per-volume cover matching across an entire series in one click and local image cover upload).
- **In-place CBZ conversion & full Google Drive sync (PC ↔ Android):** convert manga into `.cbz` with embedded `.mokuro`, edits, and custom covers, plus automatic sync of progress, annotations, shelves, formats, and files up to 250 MB via Google Drive alongside portable JSON backups.
- **Audiobooks, Typography & Tracker:** audiobook/subtitle sync (SRT/VTT, auto-pause, Anki scene clip mining), LiquidGlass reader UI, E-Ink high-contrast mode, series/author grouping, shelves, spoiler image blur, reading stats, daily goals, and streaks.

#### Video Player (Beta)
- **Video Library:** folder scanning, automatic series/season/episode parsing, poster lookup, and resume progress.
- **Borderless Cinema & Dual Subtitles:** auto-hiding HUD with `.srt`/`.vtt`/`.ass`/embedded tracks, HLS support, audio track switching, transcript search, and 1-key timing snap (`Shift + [` / `Shift + ]`).
- **Immersion Controls:** pause on subtitle hover, listening subtitle visibility (`Always` / `Paused` / `Repeat R`), blur translation until hover, SFX/stage-cue regex filter, smart auto-pause resume, and live subtitle styling sliders.
- **Anki Scene Mining:** configurable pre/post clip padding, video/audio quality presets (`Tiny`/`Compact`/`Balanced`/`High`), `U` / `↻` (`Update Last Anki Card`), and manual card editor.

#### Shared Reading (P2P)
- Peer-to-peer reading rooms over WebRTC (Trystero / Nostr relays) using a `XXX-XXX` room code with live line diffs and read-only viewer tabs.

#### Live Lookup, Dictionaries & Anki
- **System-wide Windows Scan (`Shift + Z`):** live popup lookup across any app with auto-close and pin mode.
- **`Setsuna Japanese` v3 Template & QoL:** built-in Anki note type (pitch accent, furigana, sentence highlight, night mode), per-tab Anki deck & capture-window binding, Google Drive dictionary sharing, and improved furigana/duplicate handling.

#### AI Explanations (Experimental Test)
- Local Gemma 4 / llama.cpp assistant panel with per-tab chats, general chat, and character/term memory — marked as an **experimental test** that may not make it into the final release.

#### Android / Mobile
- Priority-ordered native Back gesture stack (`OnBackPressedCallback`) peeling one UI layer at a time across menus, modals, readers, and workspaces.
- Mobile Reader (books + manga) with chained bubble OCR (PC Wi-Fi → offline ONNX → ML Kit), card quick menus, and seamless Google Drive sync with Desktop.

---

## 0.1.1 - 2026-09-01

Внутренняя версия обновления: `2` (`0.0.2` для Tauri updater).

### Мобильная версия

- Полностью переработан интерфейс Android под телефон: отдельные разделы текста, ручного ввода, словарей и настроек.
- Добавлен приём текста через WebSocket, Android Share, `PROCESS_TEXT`, буфер обмена и ручной ввод.
- Добавлен нативный foreground-сервис для устойчивого приёма текста в фоне.
- Реализован Setsuna Flow overlay с последней строкой, интерактивным lookup, перемещением, изменением размера, шрифта, цвета и прозрачности.
- Добавлены импорт локальных Yomitan-словарей, встроенный тестовый набор и единая совместимая схема `dictionary.db` для ПК и Android.
- Добавлена интеграция с AnkiDroid: выбор колоды и модели, создание заметок и передача скриншота.
- Добавлены мобильные бэкапы Google Drive, просмотр архива, восстановление, удаление и перенос словарной базы.

### Lookup и разбор текста

- Японская сегментация переведена на Lindera/IPADIC с группировкой морфем в стиле Jidoujisho.
- Исправлено разбиение японских предложений по одному иероглифу; frontend теперь использует стабильные диапазоны backend.
- Английский lookup теперь распознаёт многословные статьи, идиомы и фразовые глаголы: `get out`, `space out`, `kick the bucket` и другие.
- Добавлена нормализация регулярных и неправильных форм: `spaced out` -> `space out`, `went out` -> `go out`.
- Поддержаны разрывные фразовые глаголы: `take it out`, `space the cards out`, `turn the light off`.
- Добавлены идиомы с притяжательными шаблонами: `pull my leg` -> `pull one's leg`.
- Одиночный lookup остаётся запасным вариантом, если подходящей фразы в словаре нет.

### Google Drive

- Google Drive выведен из тестового режима и доступен без специального кода.
- Добавлены сведения о квоте и проверка свободного места перед загрузкой.
- Добавлен архив всех облачных бэкапов с выборочным восстановлением и удалением.
- Добавлены предупреждения о размере словарей и отдельная синхронизация большой `dictionary.db`.
- Для крупных словарных баз реализована потоковая загрузка с прогрессом и повтором отдельных частей.
- Улучшена совместимость старых и новых форматов бэкапа между ПК и Android.

### Интерфейс и настольная версия

- Переработан экран настроек и навигация по разделам.
- Обновлены настройки Discord Rich Presence и добавлено наглядное превью активности.
- Добавлена стартовая анимация с логотипом Setsuna.
- Улучшено автоматическое подключение AnkiConnect и редактирование разрешённых origin с резервной копией конфига.
- Исправлены длинные строки, перекрытие текста, hitbox действий и работа виртуализированной истории.
- Улучшено поведение интерфейса при узком окне и изменении размера.

### Linux

- Добавлены сборки Linux и пакет для Arch Linux.
- Исправлены тема элементов управления и рендеринг WebKitGTK.
- Добавлены иконки процессов, статистика памяти и локализованные строки.
- Добавлен глобальный lookup через accessibility API в сессиях X11.

### Надёжность и разработка

- Схема словарной базы унифицирована, добавлена миграция старой мобильной таблицы и общие индексы.
- Добавлены тесты импорта, миграции, японской сегментации, английских фраз и разрывных фразовых глаголов.
- Обновлены технические документы, Android smoke-тест и уведомления о сторонних MIT-компонентах.
