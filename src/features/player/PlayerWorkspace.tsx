import { useCompatibleVideo } from "./useCompatibleVideo";
import { readWebText, webVideoPage, type WebTrack } from "./webMedia";
import { createPortal } from "react-dom";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { usePlayerSource } from "./usePlayerSource";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { AppSettings } from "../../components/SettingsModal";
import DeckPicker from "../../components/DeckPicker";
import { FuriganaLine } from "../../components/TextContainer";
import { PlayerCardEditor, type SceneDraft } from "./PlayerCardEditor";
import {
    autoPauseResumeDelayMs,
    escapeCardText,
    clipInterval,
    filterCuesByRegex,
    scenePaddingSeconds,
    previousCue,
    nextCue,
    replayOrPreviousCue,
    syncOffsetToCue,
    cueAt,
    formatClock,
    sceneForCue,
    type Cue,
    type PlayerScene,
} from "./model";
import { addPlayerNote, subtitleScenes, updateLastPlayerNote } from "./mining";
import { SubtitleTracks } from "./SubtitleTracks";
import { episodeLabel, fileName, mediaExtensions, isMediaPath, isSubtitlePath, matchSubtitlePaths } from "./localMedia";
import { PlayerTransport, readPlaybackAudio, writePlaybackAudio, type PlaybackAudio } from "./PlayerTransport";
import { IconChevronDown, IconChevronUp, IconClose, IconHome, IconImport, IconPlayerTab, IconSearch, IconSettings } from "../../components/Icons";
import { isMobilePlatform } from "../../utils/platform";
import { MOBILE_BACK_PRIORITY, useMobileBackHandler } from "../../utils/mobileBack";
import "../../components/AppMenu.css";
import { LibraryDialog } from "./PosterPicker";
import { catalogEntries, cleanReleaseTitle, inferMediaTitle } from "./posterModel";
import { PlayerLibrary } from "./PlayerLibrary";
import { usePlayerLibrary } from "./usePlayerLibrary";
import { episodeProgress, naturalOrder, positionKey, readProgress, suggestedEpisode, type LibraryDirectory } from "./libraryModel";
import "./player.css";

const ESC_MENU_CLOSE_MS = 180;

type Props = {
    settings: AppSettings;
    language?: "ru" | "en";
    shortcutsBlocked: boolean;
};
type AudioTrackList = ArrayLike<{ label: string; language: string; enabled: boolean }> & EventTarget;
function availableAudio(element: HTMLVideoElement) {
    return (element as HTMLVideoElement & { audioTracks?: AudioTrackList }).audioTracks;
}
type Mode = "normal" | "pause" | "pauseStart" | "fast" | "repeat" | "skip";
function CueText({ cue, scene, furigana }: { cue: Cue; scene?: PlayerScene; furigana: string }) {
    return (
        <span
            className="sp-cue text-line"
            ref={(node) => {
                if (node && scene) subtitleScenes.set(node, scene);
                return () => {
                    if (node) subtitleScenes.delete(node);
                };
            }}
        >
            <FuriganaLine text={cue.text} mode={furigana} searchQuery="" />
        </span>
    );
}

export default function PlayerWorkspace(
    props: Props & {
        lookupOpen?: boolean;
        onCloseLookup?: () => void;
        escMenuBlocked?: boolean;
        onHome?: () => void;
        onSettings?: () => void;
        onUpdateSettings?: (patch: Partial<AppSettings>) => void;
        onDeckChange?: (deck: string | null) => void;
    },
) {
    const en = props.language === "en";
    const library = usePlayerLibrary();
    const [libraryOpen, setLibraryOpen] = useState(true);
    const [libraryQueue, setLibraryQueue] = useState<{ root: string; directory: LibraryDirectory } | null>(null);
    const [deckPickerOpen, setDeckPickerOpen] = useState(false);
    const closeDeckPicker = useCallback(() => setDeckPickerOpen(false), []);
    const [droppedTracks, setDroppedTracks] = useState<string[]>([]);
    const [matchOnly, setMatchOnly] = useState(false);
    const [overMedia, setOverMedia] = useState(false);
    const [sources, setSources] = useState<string[]>([]);
    const [autoNext, setAutoNext] = useState(false);
    const [index, setIndex] = useState(0);
    const [webTracks, setWebTracks] = useState<WebTrack[]>([]);
    const [pageMode, setPageMode] = useState(false);
    const [loading, setLoading] = useState(false);
    const request = useRef(0);
    const [urlVisible, setUrlVisible] = useState(false);
    const [url, setUrl] = useState("");
    const [error, setError] = useState("");
    const [escMenuOpen, setEscMenuOpen] = useState(false);
    const [escMenuMounted, setEscMenuMounted] = useState(false);
    const [escMenuVisible, setEscMenuVisible] = useState(false);
    const [escMenuEntering, setEscMenuEntering] = useState(false);
    const escMenuPanelRef = useRef<HTMLDivElement>(null);
    const pendingMenuActionRef = useRef<(() => void) | null>(null);
    const openLocalMedia = (paths: string[]) => {
        request.current++;
        setLoading(false);
        setWebTracks([]);
        setSources([...new Set(paths)].sort(naturalOrder));
        setLibraryQueue(null);
        setLibraryOpen(false);
        setAutoNext(false);
        setIndex(0);
        setError("");
        setUrlVisible(false);
    };
    const choose = async () => {
        try {
            const paths = await open({
                multiple: true,
                filters: [{ name: en ? "Media" : "Видео и аудио", extensions: mediaExtensions }],
            });
            if (paths?.length) {
                setDroppedTracks([]);
                openLocalMedia(paths);
            }
        } catch (e) {
            setError(String(e));
        }
    };
    useEffect(() => {
        if (!isTauri()) return;
        let disposed = false;
        let stop: (() => void) | undefined;
        void getCurrentWebview()
            .onDragDropEvent(({ payload }) => {
                if (payload.type === "leave") setOverMedia(false);
                if (payload.type === "enter")
                    setOverMedia(payload.paths.some((path) => isMediaPath(path) || isSubtitlePath(path)));
                if (payload.type !== "drop") return;
                setOverMedia(false);
                const media = payload.paths.filter(isMediaPath);
                const subtitles = payload.paths.filter(isSubtitlePath);
                if (media.length) {
                    setMatchOnly(media.length > 1);
                    setDroppedTracks(subtitles);
                    openLocalMedia(media);
                } else if (subtitles.length) {
                    setMatchOnly(false);
                    setDroppedTracks(subtitles);
                }
            })
            .then((unlisten) => {
                if (disposed) unlisten();
                else stop = unlisten;
            })
            .catch(console.warn);
        return () => {
            disposed = true;
            stop?.();
        };
    }, []);

    const openLibraryEpisode = async (
        root: string,
        directory: LibraryDirectory,
        episodeIndex: number,
        autoplay = false,
    ) => {
        const selected = directory.episodes[episodeIndex];
        if (!selected) return;
        const id = ++request.current;
        setLoading(true);
        setError("");
        try {
            await invoke("player_allow_library_media", { root, path: selected.path });
            if (request.current !== id) return;
            setLibraryQueue({ root, directory });
            setSources(directory.episodes.map((episode) => episode.path));
            setDroppedTracks([]);
            setMatchOnly(true);
            setWebTracks([]);
            setIndex(episodeIndex);
            setAutoNext(autoplay);
            setLibraryOpen(false);
            setUrlVisible(false);
        } catch (failure) {
            if (request.current === id) setError(String(failure));
        } finally {
            if (request.current === id) setLoading(false);
        }
    };
    const switchEpisode = (nextIndex: number, autoplay: boolean) => {
        if (libraryQueue) {
            void openLibraryEpisode(libraryQueue.root, libraryQueue.directory, nextIndex, autoplay);
            return;
        }
        setAutoNext(autoplay);
        if (!matchOnly) setDroppedTracks([]);
        setIndex(nextIndex);
    };
    const currentSource = sources[index] || "";
    const sidecars = droppedTracks.length ? droppedTracks : libraryQueue?.directory.subtitles || [];
    const [primaryFile, translationFile] = matchSubtitlePaths(currentSource, sidecars, !matchOnly);
    const sourceFile = fileName(currentSource).split("?")[0];
    const title = libraryQueue
        ? inferMediaTitle(libraryQueue.directory, libraryQueue.root).title
        : cleanReleaseTitle(sourceFile, true).title || sourceFile;

    // Esc menu enter/exit animation lifecycle (matching EpubWorkspace & AppMenu)
    useEffect(() => {
        if (escMenuOpen) {
            setEscMenuMounted(true);
            setEscMenuEntering(true);
            const frame = requestAnimationFrame(() => setEscMenuVisible(true));
            const settle = window.setTimeout(() => setEscMenuEntering(false), 900);
            return () => {
                cancelAnimationFrame(frame);
                window.clearTimeout(settle);
            };
        }
        setEscMenuVisible(false);
        const timer = window.setTimeout(() => {
            setEscMenuMounted(false);
            const action = pendingMenuActionRef.current;
            pendingMenuActionRef.current = null;
            action?.();
        }, ESC_MENU_CLOSE_MS);
        return () => window.clearTimeout(timer);
    }, [escMenuOpen]);

    useEffect(() => {
        if (!escMenuVisible) return;
        const panel = escMenuPanelRef.current;
        (panel?.querySelector<HTMLElement>(".app-menu-tab.is-active") || panel)?.focus({ preventScroll: false });
        panel?.querySelector(".app-menu-tab.is-active")?.scrollIntoView({ block: "nearest" });
    }, [escMenuVisible]);

    useEffect(() => {
        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key !== "Escape" || event.repeat || event.defaultPrevented) return;
            const target = event.target;
            const inField = target instanceof Element && target.closest('input, textarea, select, [contenteditable="true"]');
            if (escMenuOpen) {
                if (inField) return;
                event.preventDefault();
                setEscMenuOpen(false);
                return;
            }
            if (inField) return;
            if (urlVisible && libraryOpen) {
                event.preventDefault();
                setUrlVisible(false);
                return;
            }
            if (deckPickerOpen || document.fullscreenElement) return;
            if (props.lookupOpen) {
                event.preventDefault();
                props.onCloseLookup?.();
                return;
            }
            if (
                props.escMenuBlocked ||
                document.querySelector("dialog[open], .modal-overlay, .settings-window, .deck-picker-backdrop")
            )
                return;
            event.preventDefault();
            setEscMenuOpen(true);
        };
        window.addEventListener("keydown", handleKeyDown);
        return () => window.removeEventListener("keydown", handleKeyDown);
    }, [
        escMenuOpen,
        urlVisible,
        libraryOpen,
        deckPickerOpen,
        props.lookupOpen,
        props.onCloseLookup,
        props.escMenuBlocked,
    ]);

    const runEscMenuAction = useCallback((action: () => void) => {
        pendingMenuActionRef.current = action;
        setEscMenuOpen(false);
    }, []);

    const isMobilePlayer = isMobilePlatform();
    useMobileBackHandler(isMobilePlayer && escMenuOpen, MOBILE_BACK_PRIORITY.MODAL, () => {
        setEscMenuOpen(false);
    });
    useMobileBackHandler(isMobilePlayer && Boolean(props.onHome), MOBILE_BACK_PRIORITY.WORKSPACE, () => {
        if (!props.onHome) return false;
        props.onHome();
    });

    const escLibraryShows = useMemo(() => {
        if (!escMenuMounted) return [];
        const saved = readProgress();
        const shows: { id: string; root: string; directory: LibraryDirectory; title: string; epIndex: number; count: number; watched: number }[] = [];
        const seen = new Set<string>();
        for (const root of library.roots) {
            const scan = library.results[root];
            if (!scan || !("folder" in scan)) continue;
            for (const group of scan.folder.directories) {
                for (const { id, directory } of catalogEntries(group)) {
                    if (!directory.episodes.length || seen.has(id)) continue;
                    seen.add(id);
                    const watched = directory.episodes.filter((ep) => episodeProgress(saved[ep.path]).completed).length;
                    shows.push({
                        id,
                        root,
                        directory,
                        title: inferMediaTitle(directory, root).title || fileName(directory.path),
                        epIndex: suggestedEpisode(directory.episodes, saved),
                        count: directory.episodes.length,
                        watched,
                    });
                }
            }
        }
        return shows.sort((a, b) => naturalOrder(a.title, b.title));
    }, [escMenuMounted, library.roots, library.results]);

    const activeDeckName = props.settings.playerAnkiDeck || props.settings.ankiDeck || "Anki";
    const escMenuTitle = !libraryOpen && currentSource ? title : en ? "Anime Player" : "Аниме-плеер";
    const escMenuSubtitle = !libraryOpen && currentSource
        ? episodeCountLabel(episodeLabel(currentSource, index, en), sources.length, index, en)
        : en
          ? `${escLibraryShows.length} titles in library`
          : `Тайтлов в видеотеке: ${escLibraryShows.length}`;

    const escMenuElement = escMenuMounted
        ? createPortal(
              <div
                  className={`app-menu-backdrop${escMenuVisible ? " is-open" : ""}${escMenuVisible && escMenuEntering ? " is-entering" : ""}`}
                  onMouseDown={(event) => {
                      if (event.target === event.currentTarget) setEscMenuOpen(false);
                  }}
                  role="presentation"
              >
                  <div
                      ref={escMenuPanelRef}
                      tabIndex={-1}
                      className="app-menu"
                      role="dialog"
                      aria-modal="true"
                      aria-labelledby="player-esc-menu-title"
                      onClick={(event) => event.stopPropagation()}
                  >
                      <header className="app-menu-heading">
                          <div className="app-menu-heading-text">
                              <p className="app-menu-brand">SETSUNA</p>
                              <h1 id="player-esc-menu-title">{escMenuTitle}</h1>
                              <p className="app-menu-subtitle">{escMenuSubtitle}</p>
                          </div>
                          <button
                              type="button"
                              className="app-menu-close"
                              onClick={() => setEscMenuOpen(false)}
                              aria-label={en ? "Close menu" : "Закрыть меню"}
                          >
                              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
                                  <path d="M6 6l12 12M18 6 6 18" />
                              </svg>
                          </button>
                      </header>

                      <div className="app-menu-body">
                          <section
                              className="app-menu-column app-menu-tabs-column"
                              aria-label={!libraryOpen && sources.length > 0 ? (en ? "Episodes" : "Серии") : en ? "Library" : "Видеотека"}
                          >
                              <div className="app-menu-section-head">
                                  <span className="app-menu-section-label">
                                      {!libraryOpen && sources.length > 0
                                          ? en ? "Episodes" : "Серии"
                                          : en ? "Library" : "Видеотека"}{" "}
                                      <span className="app-menu-count">
                                          {!libraryOpen && sources.length > 0 ? sources.length : escLibraryShows.length}
                                      </span>
                                  </span>
                                  <div className="app-menu-section-actions">
                                      <button
                                          type="button"
                                          className="app-menu-icon-button"
                                          onClick={() => runEscMenuAction(() => void choose())}
                                          title={en ? "Open media…" : "Открыть видео…"}
                                          aria-label={en ? "Open media…" : "Открыть видео…"}
                                      >
                                          +
                                      </button>
                                  </div>
                              </div>

                              <div
                                  className="app-menu-tabs"
                                  role="listbox"
                                  aria-label={!libraryOpen && sources.length > 0 ? (en ? "Episodes" : "Серии") : en ? "Library" : "Видеотека"}
                              >
                                  {!libraryOpen && sources.length > 0 ? (
                                      sources.map((src, i) => {
                                          const isActive = i === index;
                                          return (
                                              <div
                                                  key={src}
                                                  role="option"
                                                  aria-selected={isActive}
                                                  tabIndex={0}
                                                  style={{ ["--i" as string]: i }}
                                                  className={`app-menu-tab${isActive ? " is-active" : ""}`}
                                                  onClick={() => runEscMenuAction(() => switchEpisode(i, false))}
                                                  onKeyDown={(event) => {
                                                      if (event.key === "Enter" || event.key === " ") {
                                                          event.preventDefault();
                                                          runEscMenuAction(() => switchEpisode(i, false));
                                                      }
                                                  }}
                                              >
                                                  <span className="app-menu-tab-name">{episodeLabel(src, i, en)}</span>
                                                  <span className="app-menu-tab-meta">{i + 1}/{sources.length}</span>
                                              </div>
                                          );
                                      })
                                  ) : escLibraryShows.length > 0 ? (
                                      escLibraryShows.map((show, i) => (
                                          <div
                                              key={show.id}
                                              role="option"
                                              aria-selected={false}
                                              tabIndex={0}
                                              style={{ ["--i" as string]: i }}
                                              className="app-menu-tab"
                                              onClick={() =>
                                                  runEscMenuAction(() =>
                                                      void openLibraryEpisode(show.root, show.directory, show.epIndex),
                                                  )
                                              }
                                              onKeyDown={(event) => {
                                                  if (event.key === "Enter" || event.key === " ") {
                                                      event.preventDefault();
                                                      runEscMenuAction(() =>
                                                          void openLibraryEpisode(show.root, show.directory, show.epIndex),
                                                      );
                                                  }
                                              }}
                                          >
                                              <span className="app-menu-tab-name">{show.title}</span>
                                              <span className="app-menu-tab-meta">
                                                  {show.watched}/{show.count}
                                              </span>
                                          </div>
                                      ))
                                  ) : (
                                      <p className="app-menu-tabs-hint">
                                          {en ? "Add a video folder or open a file." : "Добавь папку с видео или открой файл."}
                                      </p>
                                  )}
                              </div>
                          </section>

                          <section className="app-menu-column">
                              <div className="app-menu-section-head">
                                  <span className="app-menu-section-label">{en ? "Actions" : "Действия"}</span>
                              </div>
                              <div className="app-menu-grid">
                                  {!libraryOpen ? (
                                      <button
                                          type="button"
                                          className="app-menu-tile"
                                          style={{ ["--i" as string]: 0 }}
                                          onClick={() =>
                                              runEscMenuAction(() => {
                                                  setAutoNext(false);
                                                  setLibraryOpen(true);
                                              })
                                          }
                                      >
                                          <span className="app-menu-tile-icon"><IconPlayerTab /></span>
                                          <span className="app-menu-tile-text">
                                              <strong>{en ? "Library" : "Видеотека"}</strong>
                                              <small>{en ? "Browse shows & folders" : "Тайтлы и папки"}</small>
                                          </span>
                                      </button>
                                  ) : currentSource ? (
                                      <button
                                          type="button"
                                          className="app-menu-tile"
                                          style={{ ["--i" as string]: 0 }}
                                          onClick={() => runEscMenuAction(() => setLibraryOpen(false))}
                                      >
                                          <span className="app-menu-tile-icon"><IconPlayerTab /></span>
                                          <span className="app-menu-tile-text">
                                              <strong>{en ? "Back to video" : "Вернуться к видео"}</strong>
                                              <small>{title}</small>
                                          </span>
                                      </button>
                                  ) : null}

                                  <button
                                      type="button"
                                      className="app-menu-tile"
                                      style={{ ["--i" as string]: 1 }}
                                      onClick={() => runEscMenuAction(() => void choose())}
                                  >
                                      <span className="app-menu-tile-icon"><IconImport /></span>
                                      <span className="app-menu-tile-text">
                                          <strong>{en ? "Open media…" : "Открыть видео…"}</strong>
                                          <small>.mkv · .mp4 · .webm</small>
                                      </span>
                                  </button>

                                  <button
                                      type="button"
                                      className="app-menu-tile"
                                      style={{ ["--i" as string]: 2 }}
                                      onClick={() =>
                                          runEscMenuAction(() => {
                                              setError("");
                                              setUrlVisible(true);
                                          })
                                      }
                                  >
                                      <span className="app-menu-tile-icon">
                                          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                                              <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
                                              <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
                                          </svg>
                                      </span>
                                      <span className="app-menu-tile-text">
                                          <strong>{en ? "Open URL…" : "Открыть по URL…"}</strong>
                                          <small>HTTPS stream / page</small>
                                      </span>
                                  </button>

                                  {props.onDeckChange && (
                                      <button
                                          type="button"
                                          className="app-menu-tile"
                                          style={{ ["--i" as string]: 3 }}
                                          onClick={() => runEscMenuAction(() => setDeckPickerOpen(true))}
                                      >
                                          <span className="app-menu-tile-icon">
                                              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                                                  <rect x="3" y="7" width="13" height="14" rx="2" />
                                                  <path d="M7 7V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3" />
                                              </svg>
                                          </span>
                                          <span className="app-menu-tile-text">
                                              <strong>{en ? "Anki deck" : "Колода Anki"}</strong>
                                              <small>{activeDeckName}</small>
                                          </span>
                                      </button>
                                  )}

                                  {props.onSettings && (
                                      <button
                                          type="button"
                                          className="app-menu-tile"
                                          style={{ ["--i" as string]: 4 }}
                                          onClick={() => runEscMenuAction(() => props.onSettings?.())}
                                      >
                                          <span className="app-menu-tile-icon"><IconSettings /></span>
                                          <span className="app-menu-tile-text">
                                              <strong>{en ? "Settings" : "Настройки"}</strong>
                                              <small>{en ? "Anime Player" : "Аниме-плеер"}</small>
                                          </span>
                                      </button>
                                  )}
                              </div>
                          </section>
                      </div>

                      <footer className="app-menu-footer">
                          <div className="app-menu-footer-actions">
                              {props.onHome && (
                                  <button type="button" className="is-home" onClick={() => runEscMenuAction(() => props.onHome?.())}>
                                      <IconHome /> {en ? "Home screen" : "Главный экран"}
                                  </button>
                              )}
                          </div>
                          <p className="app-menu-hint">
                              <kbd>Esc</kbd>{" "}
                              {libraryOpen
                                  ? en ? "close menu" : "закрыть меню"
                                  : en ? "back to watching" : "вернуться к просмотру"}
                          </p>
                      </footer>
                  </div>
              </div>,
              document.body,
          )
        : null;
    const openUrlStream = async (rawUrl: string, isPage: boolean) => {
        const id = ++request.current;
        setLoading(true);
        try {
            const address = new URL(rawUrl.trim());
            if (address.protocol !== "https:")
                throw new Error(
                    en ? "Use a direct HTTPS media URL" : "Нужна прямая HTTPS-ссылка на видео",
                );
            let nextSource = address.href;
            let tracks: WebTrack[] = [];
            if (isPage) {
                const page = await readWebText(nextSource);
                if (request.current !== id) return;
                const media = webVideoPage(page.text, page.url);
                if (!media)
                    throw new Error(
                        en
                            ? "This page does not publish an HTML video source. Use a direct media link."
                            : "Страница не содержит открытой ссылки на HTML-видео. Вставь прямую ссылку на видео.",
                    );
                nextSource = media.source;
                tracks = media.tracks;
            }
            setDroppedTracks([]);
            setWebTracks(tracks);
            setSources([nextSource]);
            setLibraryQueue(null);
            setLibraryOpen(false);
            setAutoNext(false);
            setIndex(0);
            setUrlVisible(false);
            setError("");
        } catch (err) {
            if (id === request.current) setError(String(err));
        } finally {
            if (id === request.current) setLoading(false);
        }
    };
    const sourceActions = (
        <div className="sp-source is-library">
            {currentSource && (
                <button onClick={() => setLibraryOpen(false)}>{en ? "Back to video" : "К видео"}</button>
            )}
            <div className="sp-source-actions">
                <button onClick={() => void choose()}>{en ? "Open media…" : "Открыть видео…"}</button>
                <button aria-expanded={urlVisible} onClick={() => setUrlVisible(!urlVisible)}>URL</button>
                {props.onDeckChange && (
                    <button
                        className="sp-deck"
                        onClick={() => setDeckPickerOpen(true)}
                        title={en ? "Choose the Anki deck for this mode" : "Выбрать колоду Anki для плеера"}
                    >
                        {props.settings.playerAnkiDeck || "Anki"}
                    </button>
                )}
            </div>
            {urlVisible && libraryOpen && (
                <form
                    onSubmit={(e) => {
                        e.preventDefault();
                        void openUrlStream(url, pageMode);
                    }}
                >
                    <input
                        type="url"
                        required
                        autoFocus
                        aria-label="HTTPS URL"
                        placeholder="https://…/episode.mp4"
                        value={url}
                        onChange={(e) => setUrl(e.target.value)}
                    />
                    <label>
                        <input
                            type="checkbox"
                            checked={pageMode}
                            onChange={(e) => setPageMode(e.target.checked)}
                        />
                        {en ? "Video page" : "Страница с видео"}
                    </label>
                    <button disabled={loading}>{loading ? "…" : en ? "Open" : "Открыть"}</button>
                </form>
            )}
            {error && <span role="alert">{error}</span>}
        </div>
    );
    return (
        <div className="sp-workspace">
            {deckPickerOpen &&
                createPortal(
                    <DeckPicker
                        open={deckPickerOpen}
                        en={en}
                        current={props.settings.playerAnkiDeck}
                        defaultDeck={props.settings.ankiDeck}
                        tabName={en ? "Anime Player" : "Аниме-плеер"}
                        onClose={closeDeckPicker}
                        onPick={(deck) => {
                            props.onDeckChange?.(deck);
                            closeDeckPicker();
                        }}
                    />,
                    document.body,
                )}
            {!libraryOpen && urlVisible && (
                <LibraryDialog
                    title={en ? "Open video URL" : "Открыть видео по URL"}
                    en={en}
                    onClose={() => setUrlVisible(false)}
                >
                    <form
                        className="sp-url-modal-form"
                        onSubmit={(e) => {
                            e.preventDefault();
                            void openUrlStream(url, pageMode);
                        }}
                    >
                        <input
                            type="url"
                            required
                            autoFocus
                            aria-label="HTTPS URL"
                            placeholder="https://…/episode.mp4"
                            value={url}
                            onChange={(e) => setUrl(e.target.value)}
                        />
                        <label>
                            <input
                                type="checkbox"
                                checked={pageMode}
                                onChange={(e) => setPageMode(e.target.checked)}
                            />
                            {en ? "Video page" : "Страница с видео"}
                        </label>
                        {error && <span role="alert">{error}</span>}
                        <div className="sp-dialog-actions">
                            <button type="button" onClick={() => setUrlVisible(false)}>
                                {en ? "Cancel" : "Отмена"}
                            </button>
                            <button className="sp-library-primary" disabled={loading}>
                                {loading ? "…" : en ? "Open" : "Открыть"}
                            </button>
                        </div>
                    </form>
                </LibraryDialog>
            )}
            {overMedia && (
                <div className="sp-drop" aria-hidden="true">
                    {en ? "Drop video or subtitles" : "Отпусти видео или субтитры"}
                </div>
            )}
            {libraryOpen ? (
                <PlayerLibrary
                    library={library}
                    en={en}
                    opening={loading}
                    openEpisode={openLibraryEpisode}
                    actions={sourceActions}
                />
            ) : (
                <Session
                    key={currentSource}
                    language={props.language}
                    settings={
                        props.settings.playerAnkiDeck
                            ? { ...props.settings, ankiDeck: props.settings.playerAnkiDeck }
                            : props.settings
                    }
                    shortcutsBlocked={props.shortcutsBlocked || deckPickerOpen || urlVisible || escMenuOpen}
                    source={currentSource}
                    primaryFile={primaryFile}
                    translationFile={translationFile}
                    openFile={choose}
                    webTracks={webTracks}
                    autoNext={autoNext}
                    title={title}
                    sourceFile={sourceFile}
                    episodeIndex={index}
                    episodeCount={sources.length}
                    episodeSources={sources}
                    episodeLoading={loading}
                    onBackToLibrary={() => {
                        setAutoNext(false);
                        setLibraryOpen(true);
                    }}
                    onSwitchEpisode={(nextIdx) => switchEpisode(nextIdx, false)}
                    onOpenUrlDialog={() => {
                        setError("");
                        setUrlVisible(true);
                    }}
                    onOpenDeckPicker={props.onDeckChange ? () => setDeckPickerOpen(true) : undefined}
                    onOpenSettings={props.onSettings}
                    onOpenMenu={() => setEscMenuOpen(true)}
                    onUpdateSettings={props.onUpdateSettings}
                    deckName={props.settings.playerAnkiDeck}
                    nextEpisode={index + 1 < sources.length ? () => switchEpisode(index + 1, true) : undefined}
                />
            )}
            {escMenuElement}
        </div>
    );
}

function episodeCountLabel(label: string, total: number, currentIndex: number, en: boolean) {
    if (total <= 1) return label;
    return `${label} · ${currentIndex + 1}/${total}${en ? " ep." : ""}`;
}

function Session({
    source,
    openFile,
    nextEpisode,
    autoNext,
    webTracks,
    primaryFile,
    translationFile,
    language,
    settings,
    shortcutsBlocked,
    title,
    sourceFile,
    episodeIndex,
    episodeCount,
    episodeSources,
    episodeLoading,
    onBackToLibrary,
    onSwitchEpisode,
    onOpenUrlDialog,
    onOpenDeckPicker,
    onOpenSettings,
    onOpenMenu,
    onUpdateSettings,
    deckName,
}: Props & {
    source: string;
    openFile: () => void;
    nextEpisode?: () => void;
    autoNext: boolean;
    webTracks: WebTrack[];
    primaryFile?: string;
    translationFile?: string;
    title: string;
    sourceFile: string;
    episodeIndex: number;
    episodeCount: number;
    episodeSources: string[];
    episodeLoading: boolean;
    onBackToLibrary: () => void;
    onSwitchEpisode: (nextIndex: number) => void;
    onOpenUrlDialog: () => void;
    onOpenDeckPicker?: () => void;
    onOpenSettings?: () => void;
    onOpenMenu?: () => void;
    onUpdateSettings?: (patch: Partial<AppSettings>) => void;
    deckName?: string;
}) {
    const tr = (en: string, ru: string) => (language === "en" ? en : ru);
    const video = useRef<HTMLVideoElement>(null);

    const list = useRef<HTMLDivElement>(null);
    const [rawCues, setRawCues] = useState<Cue[]>([]);
    const [rawTranslations, setRawTranslations] = useState<Cue[]>([]);
    const cues = useMemo(
        () => filterCuesByRegex(rawCues, settings.playerSubtitleRegexFilter),
        [rawCues, settings.playerSubtitleRegexFilter],
    );
    const translations = useMemo(
        () => filterCuesByRegex(rawTranslations, settings.playerSubtitleRegexFilter),
        [rawTranslations, settings.playerSubtitleRegexFilter],
    );
    const [resume] = useState(() => episodeProgress(readProgress()[source]));
    const [offset, setOffset] = useState(resume.offset);
    const [translationOffset, setTranslationOffset] = useState(resume.translationOffset);
    const [current, setCurrent] = useState(0);
    const [draft, setDraft] = useState<SceneDraft | null>(null);
    const [studyOpen, setStudyOpen] = useState(false);
    const [tracks, setTracks] = useState<string[]>([]);
    const [audioTrack, setAudioTrack] = useState<number>();
    const [audioOnly, setAudioOnly] = useState(false);
    const [duration, setDuration] = useState(0);
    const [ready, setReady] = useState(false);
    const [isPlaying, setPlaying] = useState(false);
    const [audio, setAudio] = useState(readPlaybackAudio);
    const [transcriptOpen, setTranscriptOpen] = useState(true);
    const [fullscreen, setFullscreen] = useState(Boolean(document.fullscreenElement));
    const [query, setQuery] = useState("");
    const [pausedLine, setPausedLine] = useState<Cue>();
    const [mode, setMode] = useState<Mode>("normal");
    const [rate, setRate] = useState(1);
    const [repeatLimit, setRepeatLimit] = useState(0);
    const repeats = useRef({ id: -1, count: 0 });
    const [range, setRange] = useState<{ a?: number; b?: number }>({});
    const [showSubs, setShowSubs] = useState(true);
    const [follow, setFollow] = useState(true);
    const [tracksOpen, setTracksOpen] = useState(false);
    const [searchOpen, setSearchOpen] = useState(false);
    const [moreMenuOpen, setMoreMenuOpen] = useState(false);
    const [message, report] = useState("");
    const [hudFlash, setHudFlash] = useState<{ label?: string; icon?: "play" | "pause"; key: number } | null>(null);
    const [controlsIdle, setControlsIdle] = useState(false);
    const [revealedCueId, setRevealedCueId] = useState<number | null>(null);
    const hudTimerRef = useRef<number | null>(null);
    const idleTimerRef = useRef<number | null>(null);
    const autoResumeTimerRef = useRef<number | null>(null);
    const navCueRef = useRef<{ index: number; at: number } | null>(null);
    const hoverPausedRef = useRef(false);
    const shortcutsBlockedRef = useRef(shortcutsBlocked);
    shortcutsBlockedRef.current = shortcutsBlocked;
    const compatible = useCompatibleVideo(source, report);
    usePlayerSource(video, compatible.copy || source, report);
    const mining = useRef(false);
    const [busy, setBusy] = useState(false);
    const lastTime = useRef(0);
    const lastSaved = useRef(-1);
    const playing = useRef(false);
    const ended = useRef(false);
    const saveOnLeave = useRef<(element: HTMLVideoElement | null) => void>(() => {});
    const replayEnd = useRef<number | null>(null);
    const clock = current + offset;
    const cue = pausedLine && cues.includes(pausedLine) ? pausedLine : cueAt(cues, clock);
    const translation = cueAt(translations, clock + translationOffset);
    const filtered = useMemo(() => {
        const needle = query.trim().toLocaleLowerCase();
        return needle ? cues.filter((c) => c.text.toLocaleLowerCase().includes(needle)) : cues;
    }, [query, cues]);
    const rows = useVirtualizer({
        count: filtered.length,
        getScrollElement: () => list.current,
        estimateSize: () => 64,
        overscan: 6,
    });
    useEffect(() => {
        if (!follow || !cue || query) return;
        const index = filtered.indexOf(cue);
        if (index >= 0) rows.scrollToIndex(index, { align: "auto" });
    }, [cue, follow, query, filtered, rows]);

    const clearAutoResume = useCallback(() => {
        if (autoResumeTimerRef.current !== null) {
            window.clearTimeout(autoResumeTimerRef.current);
            autoResumeTimerRef.current = null;
        }
    }, []);
    const seek = (time: number) => {
        const el = video.current;
        if (!el || !Number.isFinite(el.duration)) return;
        clearAutoResume();
        hoverPausedRef.current = false;
        setPausedLine(undefined);
        lastTime.current = Math.max(0, Math.min(el.duration, time));
        setCurrent(lastTime.current);
        el.currentTime = lastTime.current;
    };
    const flashHud = useCallback((content: string | { icon: "play" | "pause" }) => {
        if (hudTimerRef.current !== null) window.clearTimeout(hudTimerRef.current);
        setHudFlash(
            typeof content === "string"
                ? { label: content, key: Date.now() }
                : { icon: content.icon, key: Date.now() },
        );
        hudTimerRef.current = window.setTimeout(() => {
            setHudFlash(null);
            hudTimerRef.current = null;
        }, 650);
    }, []);
    const wakeControls = useCallback(() => {
        if (idleTimerRef.current !== null) {
            window.clearTimeout(idleTimerRef.current);
            idleTimerRef.current = null;
        }
        setControlsIdle(false);
        if (isPlaying && !studyOpen && !draft && !moreMenuOpen && !shortcutsBlocked) {
            idleTimerRef.current = window.setTimeout(() => {
                setControlsIdle(true);
                idleTimerRef.current = null;
            }, 2200);
        }
    }, [isPlaying, studyOpen, draft, moreMenuOpen, shortcutsBlocked]);
    useEffect(() => {
        wakeControls();
    }, [wakeControls]);
    useEffect(() => {
        return () => {
            clearAutoResume();
            if (hudTimerRef.current !== null) window.clearTimeout(hudTimerRef.current);
            if (idleTimerRef.current !== null) window.clearTimeout(idleTimerRef.current);
        };
    }, [clearAutoResume]);
    useEffect(() => {
        navCueRef.current = null;
    }, [cues]);
    useEffect(() => {
        clearAutoResume();
    }, [mode, clearAutoResume]);
    useEffect(() => {
        if (isPlaying && revealedCueId !== null && cue && cue.id !== revealedCueId) {
            setRevealedCueId(null);
        }
    }, [isPlaying, cue, revealedCueId]);
    const play = () => {
        clearAutoResume();
        void video.current?.play().catch((e) => report(String(e)));
    };
    const togglePlayback = () => {
        if (!video.current) return;
        clearAutoResume();
        hoverPausedRef.current = false;
        const willPlay = video.current.paused;
        if (willPlay) play();
        else video.current.pause();
        flashHud({ icon: willPlay ? "play" : "pause" });
    };
    const markLoopEnd = () => {
        if (range.a !== undefined && current > range.a) setRange({ a: range.a, b: current });
    };
    const toggleFullscreen = () => {
        const action = document.fullscreenElement
            ? document.exitFullscreen()
            : document.documentElement.requestFullscreen();
        void action.catch((error) => report(String(error)));
    };
    const seekByUser = (position: number) => {
        navCueRef.current = null;
        replayEnd.current = null;
        repeats.current = { id: -1, count: 0 };
        seek(position);
    };
    const applyAudio = (next: PlaybackAudio) => {
        const element = video.current;
        if (element) {
            element.volume = next.volume;
            element.muted = next.muted;
        }
        setAudio(next);
        writePlaybackAudio(next);
    };
    useLayoutEffect(() => {
        const element = video.current;
        if (element) {
            element.volume = audio.volume;
            element.muted = audio.muted;
        }
    }, []);
    useEffect(() => {
        const sync = () => setFullscreen(Boolean(document.fullscreenElement));
        document.addEventListener("fullscreenchange", sync);
        return () => document.removeEventListener("fullscreenchange", sync);
    }, []);

    const moveCue = (forward: boolean) => {
        const liveClock = lastTime.current + offset;
        const anchor = navCueRef.current && Date.now() - navCueRef.current.at < 2000 ? navCueRef.current.index : undefined;
        const target = nextCue(cues, liveClock, forward ? 1 : -1, offset, duration, anchor);
        if (!target) return;
        navCueRef.current = { index: cues.indexOf(target), at: Date.now() };
        replayEnd.current = null;
        repeats.current = { id: -1, count: 0 };
        setRevealedCueId(target.id);
        const epsilon = Math.min(0.01, Math.max(0, (target.end - target.start) / 4));
        seek(target.start - offset + epsilon);
    };
    const replayCue = () => {
        const liveClock = lastTime.current + offset;
        const res = replayOrPreviousCue(cues, liveClock, offset, duration);
        if (!res.cue) return;
        navCueRef.current = { index: cues.indexOf(res.cue), at: Date.now() };
        replayEnd.current = null;
        repeats.current = { id: -1, count: 0 };
        setRevealedCueId(res.cue.id);
        const epsilon = Math.min(0.01, Math.max(0, (res.cue.end - res.cue.start) / 4));
        seek(res.cue.start - offset + epsilon);
        flashHud(res.replayed ? "↺" : "‹");
    };
    const syncToCue = (direction: -1 | 1) => {
        const synced = syncOffsetToCue(cues, current, offset, direction, duration);
        if (!synced) return;
        setOffset(synced.offset);
        flashHud(`${tr("Synced", "Синхр.")} ${synced.offset >= 0 ? "+" : ""}${synced.offset.toFixed(1)}s`);
    };
    const persist = (time: number, played = false, complete = false) => {
        if (!source || source.startsWith("https:") || !Number.isFinite(time)) return;
        const saved = readProgress();
        const item = episodeProgress(saved[source]);
        delete saved[source];
        try {
            localStorage.setItem(
                positionKey,
                JSON.stringify(
                    Object.fromEntries([
                        ...Object.entries(saved).slice(-4999),
                        [
                            source,
                            {
                                ...item,
                                time,
                                offset,
                                translationOffset,
                                duration: duration || item.duration,
                                lastPlayedAt: played ? Date.now() : item.lastPlayedAt,
                                completed: complete || item.completed,
                            },
                        ],
                    ]),
                ),
            );
        } catch {
            /* Storage may be unavailable. */
        }
    };
    saveOnLeave.current = (element) => {
        if (playing.current && !ended.current) persist(element?.currentTime ?? lastTime.current, true);
    };
    useLayoutEffect(() => {
        const element = video.current;
        return () => saveOnLeave.current(element);
    }, []);
    useEffect(() => {
        persist(video.current?.readyState ? video.current.currentTime : resume.time);
    }, [offset, translationOffset]);
    const tick = (el: HTMLVideoElement) => {
        const now = el.currentTime;
        const previous = lastTime.current;
        lastTime.current = now;
        setCurrent(now);
        const bucket = Math.floor(now / 3);
        if (bucket !== lastSaved.current && !el.seeking) {
            if (!el.ended) persist(now, now > 0);
            lastSaved.current = bucket;
        }
        if (el.paused || el.seeking) return;
        if (replayEnd.current !== null && now >= replayEnd.current) {
            replayEnd.current = null;
            el.pause();
            return;
        }
        if (range.a !== undefined && range.b !== undefined && now >= range.b) {
            seek(range.a);
            return;
        }
        const scheduleAutoResume = (target: Cue) => {
            const delay = autoPauseResumeDelayMs(
                target,
                settings.playerAutoPauseResumeMode ?? "manual",
                settings.playerAutoPauseFixedSec,
                settings.playerAutoPauseCharMs,
            );
            if (delay === null) return;
            clearAutoResume();
            autoResumeTimerRef.current = window.setTimeout(() => {
                autoResumeTimerRef.current = null;
                if (!shortcutsBlockedRef.current && video.current?.paused) play();
            }, delay);
        };
        if (mode === "pauseStart") {
            const starting = cues.find((c) => c.start > previous + offset && c.start <= now + offset);
            if (starting) {
                el.pause();
                seek(starting.start - offset);
                setPausedLine(starting);
                scheduleAutoResume(starting);
                return;
            }
        }
        const ending =
            (mode === "repeat" || mode === "pause") &&
            cues.find((c) => c.end > previous + offset && c.end <= now + offset);
        if (ending) {
            if (mode === "repeat") {
                if (repeats.current.id !== ending.id) repeats.current = { id: ending.id, count: 0 };
                if (!repeatLimit || repeats.current.count < repeatLimit) {
                    repeats.current.count++;
                    seek(ending.start - offset);
                }
            } else {
                el.pause();
                seek(ending.end - offset);
                setPausedLine(ending);
                scheduleAutoResume(ending);
            }
        } else if (mode === "skip" && !cueAt(cues, now + offset)) {
            const minGap = Math.max(0.3, settings.playerSkipMinGap ?? 1.5);
            const next = cues.find((c) => c.start > now + offset);
            if (next && next.start - (now + offset) > minGap) {
                seek(Math.max(now, next.start - offset - 0.2));
            }
        }
    };

    const sceneFor = (line: Cue) => {
        const scene = sceneForCue(source, line, offset, duration);
        return scene && { ...scene, audioOnly, audioTrack };
    };
    const saveCard = async (
        { word, sentence, meaning, scene }: SceneDraft,
        exact = false,
    ): Promise<string | undefined> => {
        if (mining.current) return tr("Adding a card…", "Добавление карточки…");
        if (!settings.ankiDeck || !settings.ankiModel) {
            const message = tr(
                "Choose a deck and note type in Anki settings.",
                "Выбери колоду и тип записи в настройках Anki.",
            );
            report(message);
            return message;
        }
        mining.current = true;
        setBusy(true);
        video.current?.pause();
        report(tr("Adding scene to Anki…", "Добавление сцены в Anki…"));
        try {
            const result = await addPlayerNote(
                settings,
                { word: escapeCardText(word), sentence, meaning: escapeCardText(meaning) },
                scene,
                false,
                exact,
            );
            report(result.error || result.warning || tr("Card added to Anki", "Карточка добавлена в Anki"));
            if (!result.error && settings.playerMiningReplayOnMine) {
                const replay = exact
                    ? scene
                    : clipInterval(scene, settings.playerClipPadStart, settings.playerClipPadEnd);
                seek(replay.start);
                replayEnd.current = replay.end;
                play();
            }
            return result.error || undefined;
        } finally {
            setBusy(false);
            mining.current = false;
        }
    };
    const updateLastCard = async (explicitCue?: Cue) => {
        if (mining.current) return;
        const selected = explicitCue || cue || previousCue(cues, clock);
        const selectedScene = selected && sceneFor(selected);
        if (!source || !duration) return;
        const padBefore = settings.playerClipPadStart ?? scenePaddingSeconds;
        const padAfter = settings.playerClipPadEnd ?? scenePaddingSeconds;
        const scene = selectedScene || {
            source,
            start: Math.max(0, current - padBefore),
            end: Math.min(duration, current + padAfter),
            duration,
            audioOnly,
            audioTrack,
        };
        mining.current = true;
        setBusy(true);
        video.current?.pause();
        report(tr("Updating last Anki card…", "Обновление последней карточки Anki…"));
        try {
            const result = await updateLastPlayerNote(
                settings,
                { sentence: selected?.text || "" },
                scene,
                true,
                !selectedScene,
            );
            report(result.error || tr("Last Anki card updated", "Последняя карточка Anki обновлена"));
            if (!result.error) {
                flashHud("↻ Anki");
                if (settings.playerMiningReplayOnMine) {
                    const replay = selectedScene
                        ? clipInterval(scene, settings.playerClipPadStart, settings.playerClipPadEnd)
                        : scene;
                    seek(replay.start);
                    replayEnd.current = replay.end;
                    play();
                }
            }
        } finally {
            setBusy(false);
            mining.current = false;
        }
    };
    const mine = async (edit = false, explicitCue?: Cue) => {
        const selected = explicitCue || cue || previousCue(cues, clock);
        const selectedScene = selected && sceneFor(selected);
        if (!source || !duration) return;
        const padBefore = settings.playerClipPadStart ?? scenePaddingSeconds;
        const padAfter = settings.playerClipPadEnd ?? scenePaddingSeconds;
        const scene = selectedScene || {
            source,
            start: Math.max(0, current - padBefore),
            end: Math.min(duration, current + padAfter),
            duration,
            audioOnly,
            audioTrack,
        };
        const data = {
            word: selected?.text || "",
            sentence: selected?.text || "",
            meaning: selected
                ? cueAt(translations, (selected.start + selected.end) / 2 + translationOffset)?.text || ""
                : "",
            scene,
        };
        if (!selectedScene || edit) {
            video.current?.pause();
            const interval =
                range.a !== undefined && range.b !== undefined
                    ? { start: range.a, end: range.b }
                    : selectedScene
                      ? clipInterval(scene, settings.playerClipPadStart, settings.playerClipPadEnd)
                      : scene;
            setDraft({ ...data, scene: { ...scene, ...interval } });
        } else await saveCard(data);
    };
    useEffect(() => {
        if (!moreMenuOpen) return;
        const onEscape = (event: KeyboardEvent) => {
            if (event.key !== "Escape") return;
            event.preventDefault();
            event.stopPropagation();
            setMoreMenuOpen(false);
        };
        window.addEventListener("keydown", onEscape, true);
        return () => window.removeEventListener("keydown", onEscape, true);
    }, [moreMenuOpen]);

    useEffect(() => {
        if (shortcutsBlocked) {
            clearAutoResume();
            video.current?.pause();
        }
    }, [shortcutsBlocked, clearAutoResume]);
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (
                draft ||
                studyOpen ||
                shortcutsBlocked ||
                e.defaultPrevented ||
                e.ctrlKey ||
                e.metaKey ||
                e.altKey ||
                (e.target as HTMLElement)?.closest("input,select,textarea,[contenteditable=true],dialog")
            )
                return;
            if (e.shiftKey) {
                if (e.code === "BracketLeft") {
                    syncToCue(-1);
                    e.preventDefault();
                } else if (e.code === "BracketRight") {
                    syncToCue(1);
                    e.preventDefault();
                }
                return;
            }
            const match = (key: string) => [e.code, e.key].some((s) => s.toLowerCase() === key.toLowerCase());
            if (match(settings.playerKeyPlayPause || "Space")) {
                if ((e.target as HTMLElement)?.closest("button")) return;
                togglePlayback();
            } else if (match(settings.playerKeyBack || "ArrowLeft")) {
                if (settings.playerArrowSeekMode === "subtitle" && cues.length > 0) {
                    moveCue(false);
                    flashHud("‹");
                } else {
                    const step = settings.playerRewindSeconds || 2;
                    seekByUser(current - step);
                    flashHud(`-${step}s`);
                }
            } else if (match(settings.playerKeyForward || "ArrowRight")) {
                if (settings.playerArrowSeekMode === "subtitle" && cues.length > 0) {
                    moveCue(true);
                    flashHud("›");
                } else {
                    const step = settings.playerRewindSeconds || 2;
                    seekByUser(current + step);
                    flashHud(`+${step}s`);
                }
            } else if (match(settings.playerKeyReplayCue || "r")) {
                replayCue();
            } else if (match(settings.playerKeyMine || "m")) {
                if (!e.repeat) void mine(true);
            } else if (match(settings.playerKeyUpdateLast || "u")) {
                if (!e.repeat) void updateLastCard();
            } else if (match(settings.playerKeyCopySub || "c")) {
                const line = (cue || previousCue(cues, clock))?.text;
                if (line && !e.repeat) {
                    void navigator.clipboard?.writeText(line).catch(() => {});
                    flashHud(tr("Copied", "Скопировано"));
                }
            } else if (match(settings.playerKeyOffsetMinus || "[")) {
                const next = Number((offset - settings.playerSubtitleStep).toFixed(2));
                setOffset(next);
                flashHud(`${tr("Sub offset", "Сдвиг")} ${next >= 0 ? "+" : ""}${next.toFixed(1)}s`);
            } else if (match(settings.playerKeyOffsetPlus || "]")) {
                const next = Number((offset + settings.playerSubtitleStep).toFixed(2));
                setOffset(next);
                flashHud(`${tr("Sub offset", "Сдвиг")} ${next >= 0 ? "+" : ""}${next.toFixed(1)}s`);
            } else if (match("ArrowUp")) moveCue(false);
            else if (match("ArrowDown")) moveCue(true);
            else if (match("KeyF") && !e.repeat) toggleFullscreen();
            else if (match("KeyT") && !e.repeat) setTranscriptOpen((open) => !open);
            else if (match("KeyI") && ready && !e.repeat) setRange({ a: current });
            else if (match("KeyO") && !e.repeat) markLoopEnd();
            else return;
            e.preventDefault();
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    });

    useEffect(() => {
        if (!video.current) return;
        const minGap = Math.max(0.3, settings.playerSkipMinGap ?? 1.5);
        const upcoming = !cue && cues.length ? cues.find((c) => c.start > clock) : undefined;
        const inFastGap = Boolean(upcoming && upcoming.start - clock > minGap);
        video.current.playbackRate = mode === "fast" && inFastGap ? Math.max(4, rate) : rate;
    }, [mode, cue, cues, rate, clock, settings.playerSkipMinGap]);

    useEffect(() => {
        const el = video.current;
        if (!el) return;
        const list = availableAudio(el);
        if (!list) return;
        const refresh = () => {
            const tracks = Array.from(list);
            setTracks(tracks.map((track, i) => track.label || track.language || "#" + (i + 1)));
            const enabled = tracks.findIndex((track) => track.enabled);
            setAudioTrack(enabled >= 0 ? enabled : undefined);
        };
        refresh();
        list.addEventListener("change", refresh);
        list.addEventListener("addtrack", refresh);
        list.addEventListener("removetrack", refresh);
        return () => {
            list.removeEventListener("change", refresh);
            list.removeEventListener("addtrack", refresh);
            list.removeEventListener("removetrack", refresh);
        };
    }, [source]);

    const activeScene = cue && sceneFor(cue);
    const activeCueIndex = cue ? cues.indexOf(cue) : -1;
    const subsVis = settings.playerSubsVisibility ?? "always";
    const subsVisibleNow =
        showSubs &&
        (subsVis === "always" ||
            (subsVis === "paused" && !isPlaying) ||
            (subsVis === "repeat" && (!isPlaying || (cue !== undefined && revealedCueId === cue.id))));
    const screenStyle = {
        ["--sp-sub-size" as string]: `${settings.playerSubFontSize ?? 26}px`,
        ["--sp-sub-bottom" as string]: `${settings.playerSubBottomOffset ?? 22}px`,
        ["--sp-sub-bg-alpha" as string]: ((settings.playerSubBgOpacity ?? 76) / 100).toFixed(2),
    };
    return (
        <div className="sp-body" data-transcript-open={transcriptOpen} data-fullscreen={fullscreen}>
            <main
                className="sp-main"
                onPointerMove={wakeControls}
                onClick={() => {
                    if (moreMenuOpen) setMoreMenuOpen(false);
                }}
            >
                <div className="sp-screen" style={screenStyle} data-idle={controlsIdle ? "true" : undefined}>
                    <header
                        className="sp-top-hud"
                        data-idle={controlsIdle ? "true" : undefined}
                        onPointerMove={wakeControls}
                        onClick={(e) => e.stopPropagation()}
                    >
                        <div className="sp-top-hud-left">
                            <button
                                type="button"
                                className="sp-hud-icon"
                                onClick={onBackToLibrary}
                                title={tr("Library", "Видеотека")}
                                aria-label={tr("Library", "Видеотека")}
                            >
                                ←
                            </button>
                            <div className="sp-top-hud-title" title={sourceFile}>
                                <strong>{title}</strong>
                                {episodeCount > 1 && (
                                    <span className="sp-watch-count">
                                        {episodeIndex + 1}/{episodeCount}
                                    </span>
                                )}
                            </div>
                        </div>

                        <div className="sp-top-hud-right">
                            {episodeCount > 1 && (
                                <div className="sp-episode-nav">
                                    <button
                                        type="button"
                                        disabled={episodeLoading || episodeIndex <= 0}
                                        aria-label={tr("Previous episode", "Предыдущая серия")}
                                        title={tr("Previous episode", "Предыдущая серия")}
                                        onClick={() => onSwitchEpisode(episodeIndex - 1)}
                                    >
                                        ‹
                                    </button>
                                    <select
                                        className="sp-episode-select"
                                        aria-label={tr("Episode", "Серия")}
                                        value={episodeIndex}
                                        disabled={episodeLoading}
                                        onChange={(e) => onSwitchEpisode(Number(e.target.value))}
                                    >
                                        {episodeSources.map((src, i) => (
                                            <option key={src} value={i}>
                                                {episodeLabel(src, i, language === "en")}
                                            </option>
                                        ))}
                                    </select>
                                    <button
                                        type="button"
                                        disabled={episodeLoading || episodeIndex >= episodeCount - 1}
                                        aria-label={tr("Next episode", "Следующая серия")}
                                        title={tr("Next episode", "Следующая серия")}
                                        onClick={() => onSwitchEpisode(episodeIndex + 1)}
                                    >
                                        ›
                                    </button>
                                </div>
                            )}

                            {onOpenDeckPicker && (
                                <button
                                    type="button"
                                    className="sp-deck-pill"
                                    onClick={onOpenDeckPicker}
                                    title={tr("Choose Anki deck", "Выбрать колоду Anki для плеера")}
                                >
                                    {deckName || "Anki"}
                                </button>
                            )}

                            <div className="sp-more-wrap">
                                <button
                                    type="button"
                                    className="sp-hud-icon"
                                    aria-expanded={moreMenuOpen}
                                    aria-label={tr("More options", "Другие действия")}
                                    title={tr("More options", "Открыть файл / URL")}
                                    onClick={() => setMoreMenuOpen((v) => !v)}
                                >
                                    ⋯
                                </button>
                                {moreMenuOpen && (
                                    <div className="sp-more-menu" role="menu">
                                        <button
                                            type="button"
                                            role="menuitem"
                                            onClick={() => {
                                                setMoreMenuOpen(false);
                                                openFile();
                                            }}
                                        >
                                            {tr("Open file…", "Открыть видео…")}
                                        </button>
                                        <button
                                            type="button"
                                            role="menuitem"
                                            onClick={() => {
                                                setMoreMenuOpen(false);
                                                onOpenUrlDialog();
                                            }}
                                        >
                                            {tr("Open URL…", "Открыть по URL…")}
                                        </button>
                                        {onOpenSettings && (
                                            <button
                                                type="button"
                                                role="menuitem"
                                                onClick={() => {
                                                    setMoreMenuOpen(false);
                                                    onOpenSettings();
                                                }}
                                            >
                                                {tr("Player settings…", "Настройки плеера…")}
                                            </button>
                                        )}
                                        {onOpenMenu && (
                                            <button
                                                type="button"
                                                role="menuitem"
                                                onClick={() => {
                                                    setMoreMenuOpen(false);
                                                    onOpenMenu();
                                                }}
                                            >
                                                {tr("Menu (Esc)", "Меню (Esc)")}
                                            </button>
                                        )}
                                    </div>
                                )}
                            </div>
                        </div>
                    </header>
                    {source ? (
                        <video
                            ref={video}
                            playsInline
                            onClick={togglePlayback}
                            onDoubleClick={toggleFullscreen}
                            onCanPlay={() => setReady(true)}
                            onEmptied={() => {
                                setReady(false);
                                setPlaying(false);
                                setDuration(0);
                            }}
                            onDurationChange={(event) => {
                                const length = event.currentTarget.duration;
                                setDuration(Number.isFinite(length) ? length : 0);
                            }}
                            autoPlay={autoNext}
                            onTimeUpdate={(e) => tick(e.currentTarget)}
                            onLoadedMetadata={(e) => {
                                const el = e.currentTarget;
                                setReady(true);
                                setAudioOnly(el.videoWidth === 0);
                                setDuration(Number.isFinite(el.duration) ? el.duration : 0);
                                el.playbackRate = rate;
                                const saved = resume.time;
                                if (saved > 0 && saved < el.duration - 2) seek(saved);
                            }}
                            onPlay={() => {
                                clearAutoResume();
                                hoverPausedRef.current = false;
                                setPlaying(true);
                                playing.current = true;
                                ended.current = false;
                                setPausedLine(undefined);
                            }}
                            onSeeking={(e) => {
                                if (Math.abs(lastTime.current - e.currentTarget.currentTime) > 0.005) {
                                    setPausedLine(undefined);
                                    replayEnd.current = null;
                                    lastTime.current = e.currentTarget.currentTime;
                                }
                            }}
                            onPause={(e) => {
                                setPlaying(false);
                                if (!e.currentTarget.ended) persist(e.currentTarget.currentTime, playing.current);
                            }}
                            onEnded={() => {
                                setPlaying(false);
                                ended.current = true;
                                persist(0, true, true);
                                nextEpisode?.();
                            }}
                            onError={() => {
                                setReady(false);
                                setPlaying(false);
                                compatible.setFailed(true);
                                report(
                                    tr(
                                        "The system player cannot decode this video.",
                                        "Системный плеер не смог декодировать видео.",
                                    ),
                                );
                            }}
                        />
                    ) : (
                        <button className="sp-open" onClick={openFile}>
                            ▶　{tr("Open or drop a video", "Открыть или перетащить видео")}
                        </button>
                    )}
                    {subsVisibleNow && (cue || translation) && (
                        <div
                            className="sp-overlay"
                            onMouseEnter={() => {
                                if (settings.playerPauseOnHover && video.current && !video.current.paused) {
                                    video.current.pause();
                                    hoverPausedRef.current = true;
                                }
                            }}
                            onMouseLeave={() => {
                                if (hoverPausedRef.current) {
                                    hoverPausedRef.current = false;
                                    if (!shortcutsBlocked && video.current?.paused) play();
                                }
                            }}
                        >
                            {cue && <CueText furigana={settings.furiganaMode} cue={cue} scene={activeScene} />}
                            {translation && (
                                <span className={`sp-translation${settings.playerBlurTranslation ? " is-blurred" : ""}`}>
                                    {translation.text}
                                </span>
                            )}
                        </div>
                    )}
                    {hudFlash && (
                        <div
                            key={hudFlash.key}
                            className={hudFlash.icon ? "sp-hud-flash is-icon" : "sp-hud-flash"}
                            aria-hidden="true"
                        >
                            {hudFlash.icon === "play" ? (
                                <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
                                    <polygon points="8,5 20,12 8,19" />
                                </svg>
                            ) : hudFlash.icon === "pause" ? (
                                <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
                                    <rect x="6" y="5" width="4" height="14" rx="1.2" />
                                    <rect x="14" y="5" width="4" height="14" rx="1.2" />
                                </svg>
                            ) : (
                                hudFlash.label
                            )}
                        </div>
                    )}
                </div>
                <PlayerTransport
                    en={language === "en"}
                    ready={ready}
                    playing={isPlaying}
                    current={current}
                    duration={duration}
                    audio={audio}
                    transcriptOpen={transcriptOpen}
                    fullscreen={fullscreen}
                    onPlayPause={togglePlayback}
                    onSeek={seekByUser}
                    onAudio={applyAudio}
                    onToggleTranscript={() => setTranscriptOpen((open) => !open)}
                    onFullscreen={toggleFullscreen}
                    onSettings={() => setStudyOpen(true)}
                    settingsLabel={rate !== 1 ? rate + "×" : undefined}
                    studyActive={mode !== "normal" || range.b !== undefined}
                    loopRange={range}
                    showSubs={showSubs}
                    onToggleSubs={() => setShowSubs((v) => !v)}
                    hasCues={cues.length > 0}
                    onPrevCue={() => moveCue(false)}
                    onNextCue={() => moveCue(true)}
                    idleHidden={controlsIdle}
                    onInteract={wakeControls}
                >
                    <div className="sp-card-actions">
                        <button
                            className="sp-mine-edit"
                            disabled={busy || !duration}
                            onClick={() => void updateLastCard()}
                            title={tr("Update last Anki card with clip & frame (U)", "Прикрепить кадр и звук к последней карточке Anki (U)")}
                            aria-label={tr("Update last Anki card", "Обновить последнюю карточку Anki")}
                        >
                            {busy ? "…" : "↻"}
                        </button>
                        <button
                            className="sp-mine-edit"
                            disabled={busy || !duration}
                            onClick={() => void mine(true)}
                            title={tr("Create Anki card manually… (M)", "Создать карточку Anki вручную… (M)")}
                            aria-label={tr("Create Anki card manually", "Создать карточку Anki вручную")}
                        >
                            ✎
                        </button>
                    </div>
                </PlayerTransport>
                {studyOpen && (
                    <LibraryDialog
                        title={tr("Playback settings", "Настройки просмотра")}
                        en={language === "en"}
                        onClose={() => setStudyOpen(false)}
                    >
                        <div className="sp-study">
                            <label>
                                {tr("Study mode", "Режим просмотра")}
                                <select value={mode} onChange={(e) => setMode(e.target.value as Mode)}>
                                    <option value="normal">{tr("Normal playback", "Обычный просмотр")}</option>
                                    <option value="pause">{tr("Pause after each line", "Пауза после реплики")}</option>
                                    <option value="pauseStart">{tr("Pause at line start", "Пауза в начале реплики")}</option>
                                    <option value="fast">{tr("Fast-forward gaps", "Ускорять паузы")}</option>
                                    <option value="repeat">{tr("Repeat line", "Повтор реплики")}</option>
                                    <option value="skip">{tr("Skip gaps", "Пропуск пауз")}</option>
                                </select>
                            </label>
                            {mode === "repeat" && (
                                <label>
                                    {tr("Repeat count", "Число повторов")}
                                    <select
                                        value={repeatLimit}
                                        onChange={(e) => {
                                            setRepeatLimit(Number(e.target.value));
                                            repeats.current = { id: -1, count: 0 };
                                        }}
                                    >
                                        {[0, 1, 2, 3, 5].map((n) => (
                                            <option key={n} value={n}>{n ? n + "×" : "∞"}</option>
                                        ))}
                                    </select>
                                </label>
                            )}
                            <label>
                                {tr("Playback speed", "Скорость")}
                                <div className="sp-speed-pills" role="group" aria-label={tr("Playback speed", "Скорость")}>
                                    {[0.5, 0.75, 1, 1.25, 1.5, 2].map((n) => (
                                        <button
                                            key={n}
                                            type="button"
                                            aria-pressed={rate === n}
                                            onClick={() => setRate(n)}
                                        >
                                            {n}×
                                        </button>
                                    ))}
                                </div>
                            </label>
                            {onUpdateSettings && (
                                <>
                                    <label>
                                        {tr("Arrow keys ← / →", "Перемотка ← / →")}
                                        <div className="sp-speed-pills" role="group" aria-label={tr("Arrow keys ← / →", "Перемотка ← / →")}>
                                            <button
                                                type="button"
                                                aria-pressed={(settings.playerArrowSeekMode ?? "seconds") === "seconds"}
                                                onClick={() => onUpdateSettings({ playerArrowSeekMode: "seconds" })}
                                            >
                                                {tr("Seconds", "Секунды")}
                                            </button>
                                            <button
                                                type="button"
                                                aria-pressed={settings.playerArrowSeekMode === "subtitle"}
                                                onClick={() => onUpdateSettings({ playerArrowSeekMode: "subtitle" })}
                                            >
                                                {tr("Subtitles", "Субтитры")}
                                            </button>
                                        </div>
                                    </label>
                                    {(settings.playerArrowSeekMode ?? "seconds") === "seconds" && (
                                        <label>
                                            {tr("Seek step (s)", "Шаг перемотки (с)")}
                                            <input
                                                className="sp-study-input"
                                                type="number"
                                                min={0.25}
                                                max={30}
                                                step={0.25}
                                                value={settings.playerRewindSeconds ?? 2}
                                                onChange={(e) => {
                                                    const val = Number(e.target.value);
                                                    if (Number.isFinite(val) && val > 0) {
                                                        onUpdateSettings({ playerRewindSeconds: val });
                                                    }
                                                }}
                                            />
                                        </label>
                                    )}
                                    {(mode === "pause" || mode === "pauseStart") && (
                                        <label>
                                            {tr("Auto-resume", "Авто-продолжение")}
                                            <div className="sp-speed-pills" role="group">
                                                {(
                                                    [
                                                        ["manual", tr("Manual", "Вручную")],
                                                        ["fixed", tr("Fixed", "Таймер")],
                                                        ["dynamic", tr("By length", "По длине")],
                                                    ] as const
                                                ).map(([val, label]) => (
                                                    <button
                                                        key={val}
                                                        type="button"
                                                        aria-pressed={(settings.playerAutoPauseResumeMode ?? "manual") === val}
                                                        onClick={() => onUpdateSettings({ playerAutoPauseResumeMode: val })}
                                                    >
                                                        {label}
                                                    </button>
                                                ))}
                                            </div>
                                        </label>
                                    )}
                                    {(mode === "skip" || mode === "fast") && (
                                        <label>
                                            {tr("Min gap (s)", "Мин. пауза (с)")}
                                            <input
                                                className="sp-study-input"
                                                type="number"
                                                min={0.3}
                                                max={15}
                                                step={0.1}
                                                value={settings.playerSkipMinGap ?? 1.5}
                                                onChange={(e) => {
                                                    const val = Number(e.target.value);
                                                    if (Number.isFinite(val) && val >= 0.3) {
                                                        onUpdateSettings({ playerSkipMinGap: val });
                                                    }
                                                }}
                                            />
                                        </label>
                                    )}
                                    <label>
                                        {tr("Show subtitles", "Показ субтитров")}
                                        <div className="sp-speed-pills" role="group">
                                            {(
                                                [
                                                    [
                                                        "always",
                                                        tr("Always", "Всегда"),
                                                        tr("Always show subtitles", "Всегда показывать субтитры"),
                                                    ],
                                                    [
                                                        "paused",
                                                        tr("On pause", "На паузе"),
                                                        tr(
                                                            "Listening mode: hide subtitles while playing, show when paused",
                                                            "Тренировка на слух: скрывать во время речи и показывать только на паузе",
                                                        ),
                                                    ],
                                                    [
                                                        "repeat",
                                                        tr("Pause / R", "Пауза / R"),
                                                        tr(
                                                            "Listening mode: hide subtitles until you pause or press R to replay a line",
                                                            "Тренировка на слух: скрывать субтитры, пока не поставишь паузу или не нажмёшь R (повтор реплики)",
                                                        ),
                                                    ],
                                                ] as const
                                            ).map(([val, label, tip]) => (
                                                <button
                                                    key={val}
                                                    type="button"
                                                    title={tip}
                                                    aria-pressed={(settings.playerSubsVisibility ?? "always") === val}
                                                    onClick={() => onUpdateSettings({ playerSubsVisibility: val })}
                                                >
                                                    {label}
                                                </button>
                                            ))}
                                        </div>
                                    </label>
                                    <label>
                                        {tr("Immersion", "Интерактив")}
                                        <div className="sp-speed-pills" role="group">
                                            <button
                                                type="button"
                                                aria-pressed={Boolean(settings.playerPauseOnHover)}
                                                onClick={() => onUpdateSettings({ playerPauseOnHover: !settings.playerPauseOnHover })}
                                            >
                                                {tr("Hover pause", "Пауза при наведении")}
                                            </button>
                                            <button
                                                type="button"
                                                aria-pressed={Boolean(settings.playerBlurTranslation)}
                                                onClick={() => onUpdateSettings({ playerBlurTranslation: !settings.playerBlurTranslation })}
                                            >
                                                {tr("Blur TL", "Блюр перевода")}
                                            </button>
                                        </div>
                                    </label>
                                    <label>
                                        {tr(`Sub size (${settings.playerSubFontSize ?? 26}px)`, `Размер (${settings.playerSubFontSize ?? 26}px)`)}
                                        <input
                                            className="sp-study-range"
                                            type="range"
                                            min={16}
                                            max={44}
                                            step={1}
                                            value={settings.playerSubFontSize ?? 26}
                                            onChange={(e) => onUpdateSettings({ playerSubFontSize: Number(e.target.value) })}
                                        />
                                    </label>
                                    <label>
                                        {tr(`Sub offset (${settings.playerSubBottomOffset ?? 22}px)`, `Высота (${settings.playerSubBottomOffset ?? 22}px)`)}
                                        <input
                                            className="sp-study-range"
                                            type="range"
                                            min={0}
                                            max={160}
                                            step={2}
                                            value={settings.playerSubBottomOffset ?? 22}
                                            onChange={(e) => onUpdateSettings({ playerSubBottomOffset: Number(e.target.value) })}
                                        />
                                    </label>
                                    <label>
                                        {tr(`Sub opacity (${settings.playerSubBgOpacity ?? 76}%)`, `Фон сабов (${settings.playerSubBgOpacity ?? 76}%)`)}
                                        <input
                                            className="sp-study-range"
                                            type="range"
                                            min={0}
                                            max={100}
                                            step={2}
                                            value={settings.playerSubBgOpacity ?? 76}
                                            onChange={(e) => onUpdateSettings({ playerSubBgOpacity: Number(e.target.value) })}
                                        />
                                    </label>
                                </>
                            )}
                            {tracks.length > 1 && (
                                <label>
                                    {tr("Audio track", "Озвучка")}
                                    <select
                                        value={audioTrack ?? 0}
                                        onChange={(e) => {
                                            const list = video.current && availableAudio(video.current);
                                            if (list)
                                                Array.from(list).forEach((track, i) => {
                                                    track.enabled = i === Number(e.target.value);
                                                });
                                        }}
                                    >
                                        {tracks.map((name, i) => (
                                            <option key={i} value={i}>{name}</option>
                                        ))}
                                    </select>
                                </label>
                            )}
                            <fieldset>
                                <legend>{tr("A–B loop", "Повтор отрезка A–B")}</legend>
                                <button
                                    disabled={!ready}
                                    data-set={range.a !== undefined}
                                    title={tr("Mark loop start (I)", "Начало повтора (I)")}
                                    onClick={() => setRange({ a: current })}
                                >
                                    A {range.a !== undefined && formatClock(range.a)}
                                </button>
                                <button
                                    data-set={range.b !== undefined}
                                    disabled={range.a === undefined || current <= range.a}
                                    title={tr("Mark loop end (O)", "Конец повтора (O)")}
                                    onClick={markLoopEnd}
                                >
                                    B {range.b !== undefined && formatClock(range.b)}
                                </button>
                                {range.a !== undefined && (
                                    <button onClick={() => setRange({})}>{tr("Clear A–B", "Сбросить A–B")}</button>
                                )}
                            </fieldset>
                        </div>
                    </LibraryDialog>
                )}
                {draft && (
                    <PlayerCardEditor
                        draft={draft}
                        en={language === "en"}
                        onClose={() => setDraft(null)}
                        onSave={(data) => saveCard(data, true)}
                    />
                )}
                {compatible.failed && source && !source.startsWith("https:") && (
                    <div className="sp-controls">
                        {compatible.busy ? (
                            <>
                                <span>
                                    {tr("Preparing a compatible MP4…", "Подготовка совместимой копии MP4…")}
                                </span>
                                <button onClick={compatible.cancel}>{tr("Cancel", "Отмена")}</button>
                            </>
                        ) : (
                            <button onClick={() => void compatible.prepare()}>
                                {tr(
                                    "Prepare compatible MP4 with FFmpeg",
                                    "Подготовить совместимую MP4-копию через FFmpeg",
                                )}
                            </button>
                        )}
                    </div>
                )}
                {message && (
                    <output className="sp-status">
                        <span>{message}</span>
                        <button
                            type="button"
                            className="sp-status-close"
                            aria-label={tr("Dismiss", "Закрыть")}
                            onClick={() => report("")}
                        >
                            <IconClose />
                        </button>
                    </output>
                )}
            </main>
            <aside className="sp-side" aria-label={tr("Transcript", "Реплики")}>
                <header className="sp-side-head">
                    <div className="sp-side-title">
                        <h2>{tr("Transcript", "Реплики")}</h2>
                        {cues.length > 0 && (
                            <span className="sp-side-count">
                                {activeCueIndex >= 0 ? `${activeCueIndex + 1}/${cues.length}` : cues.length}
                            </span>
                        )}
                    </div>
                    <div className="sp-line-navigation">
                        <button
                            type="button"
                            className="sp-follow-pill"
                            aria-pressed={follow}
                            onClick={() => setFollow((v) => !v)}
                            title={tr("Auto-scroll to active line", "Автопрокрутка к текущей реплике")}
                        >
                            {tr("Auto", "Авто")}
                        </button>
                        <button
                            type="button"
                            aria-pressed={tracksOpen}
                            onClick={() => setTracksOpen((v) => !v)}
                            aria-label={tr("Subtitle tracks & offset", "Дорожки субтитров и сдвиг")}
                            title={tr("Subtitle tracks & offset", "Дорожки субтитров и сдвиг")}
                        >
                            <IconSettings />
                        </button>
                        <button
                            type="button"
                            aria-pressed={searchOpen || query.length > 0}
                            onClick={() => setSearchOpen((v) => !v)}
                            aria-label={tr("Search lines", "Поиск по репликам")}
                            title={tr("Search lines", "Поиск по репликам")}
                        >
                            <IconSearch />
                        </button>
                        <button
                            disabled={!cues.length}
                            onClick={() => moveCue(false)}
                            aria-label={tr("Previous line", "Предыдущая реплика")}
                            title={tr("Previous line (↑)", "Предыдущая реплика (↑)")}
                        >
                            <IconChevronUp />
                        </button>
                        <button
                            disabled={!cues.length}
                            onClick={() => moveCue(true)}
                            aria-label={tr("Next line", "Следующая реплика")}
                            title={tr("Next line (↓)", "Следующая реплика (↓)")}
                        >
                            <IconChevronDown />
                        </button>
                        <button
                            type="button"
                            onClick={() => setTranscriptOpen(false)}
                            aria-label={tr("Close transcript", "Скрыть панель реплик")}
                            title={tr("Close transcript (T)", "Скрыть панель (T)")}
                        >
                            <IconClose />
                        </button>
                    </div>
                </header>
                <div className="sp-track-drawer" hidden={!tracksOpen}>
                    <SubtitleTracks
                        webTracks={webTracks}
                        primaryFile={primaryFile}
                        translationFile={translationFile}
                        en={language === "en"}
                        source={source}
                        onPrimary={setRawCues}
                        onTranslation={setRawTranslations}
                        report={report}
                    />
                    <div className="sp-tools">
                        <label>
                            {tr("Offset (s)", "Сдвиг (с)")}{" "}
                            <input
                                aria-label={tr("Subtitle offset", "Сдвиг субтитров")}
                                type="number"
                                step={settings.playerSubtitleStep || 0.1}
                                key={Math.round(offset * 100)}
                                defaultValue={Number(offset.toFixed(2))}
                                onBlur={(e) => setOffset(Number(e.target.value))}
                                onKeyDown={(e) => {
                                    if (e.key === "Enter") e.currentTarget.blur();
                                }}
                            />
                        </label>
                        {translations.length > 0 && (
                            <label>
                                {tr("Translation (s)", "Перевод (с)")}{" "}
                                <input
                                    aria-label={tr("Translation offset", "Сдвиг перевода")}
                                    type="number"
                                    step={settings.playerSubtitleStep || 0.1}
                                    key={Math.round(translationOffset * 100)}
                                    defaultValue={Number(translationOffset.toFixed(2))}
                                    onBlur={(e) => setTranslationOffset(Number(e.target.value))}
                                    onKeyDown={(e) => {
                                        if (e.key === "Enter") e.currentTarget.blur();
                                    }}
                                />
                            </label>
                        )}
                        <label>
                            <input
                                type="checkbox"
                                checked={showSubs}
                                onChange={(e) => setShowSubs(e.target.checked)}
                            />
                            {tr("On video", "На видео")}
                        </label>
                    </div>
                    {cues.length > 0 && (
                        <div className="sp-sync-row">
                            <button
                                type="button"
                                onClick={() => syncToCue(-1)}
                                title={tr("Snap previous subtitle to current playback time (Shift+[)", "Привязать предыдущую реплику к текущему времени (Shift+[)")}
                            >
                                ← {tr("Snap prev", "Под реплику")}
                            </button>
                            <button
                                type="button"
                                onClick={() => syncToCue(1)}
                                title={tr("Snap next subtitle to current playback time (Shift+])", "Привязать следующую реплику к текущему времени (Shift+])")}
                            >
                                {tr("Snap next", "Под след.")} →
                            </button>
                            <button
                                type="button"
                                disabled={offset === 0}
                                onClick={() => {
                                    setOffset(0);
                                    flashHud(tr("Offset 0s", "Сдвиг 0s"));
                                }}
                                title={tr("Reset offset", "Сбросить сдвиг")}
                            >
                                0
                            </button>
                        </div>
                    )}
                </div>
                {(searchOpen || query.length > 0) && (
                    <label className="sp-search-wrap">
                        <IconSearch />
                        <input
                            aria-label={tr("Find a subtitle", "Поиск реплики")}
                            className="sp-search"
                            type="search"
                            autoFocus
                            value={query}
                            placeholder={tr("Find a subtitle…", "Найти реплику…")}
                            onChange={(e) => setQuery(e.target.value)}
                        />
                    </label>
                )}
                <div className="sp-list" ref={list}>
                    {!filtered.length && (
                        <p>
                            {query
                                ? tr("No matching lines", "Совпадений нет")
                                : tr(
                                      "Select subtitles to see the transcript.",
                                      "Выбери субтитры, чтобы увидеть реплики.",
                                  )}
                        </p>
                    )}
                    <div style={{ height: rows.getTotalSize(), position: "relative" }}>
                        {rows.getVirtualItems().map((row) => {
                            const item = filtered[row.index];
                            return (
                                <div
                                    key={row.key}
                                    ref={rows.measureElement}
                                    data-index={row.index}
                                    className="sp-row"
                                    data-active={cue?.id === item.id}
                                    style={{ transform: "translateY(" + row.start + "px)" }}
                                >
                                    <button
                                        onClick={() => {
                                            setRevealedCueId(item.id);
                                            seekByUser(item.start - offset);
                                        }}
                                        title={tr("Seek to line", "Перейти к реплике")}
                                    >
                                        {formatClock(item.start - offset)}
                                    </button>
                                    <CueText furigana={settings.furiganaMode} cue={item} scene={sceneFor(item)} />
                                </div>
                            );
                        })}
                    </div>
                </div>
            </aside>
        </div>
    );
}
