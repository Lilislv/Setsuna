import { useState, useEffect, useRef } from "react";
import FontPicker from './FontPicker';
import { open } from "@tauri-apps/plugin-dialog";
import type { ReactNode } from "react";
import { appVersionLabel } from "../utils/appVersion";
import { invoke } from "@tauri-apps/api/core";
import SetupWizard from "./SetupWizard"; 

import SettingsLookup from "./Settings/SettingsLookup";
import SettingsAnki from "./Settings/SettingsAnki";
import SettingsFeedback from './Settings/SettingsFeedback';
import SettingsCloud from "./Settings/SettingsCloud";
import SettingsDiscord from "./Settings/SettingsDiscord";
import SettingsAI from "./Settings/SettingsAI";
import { isMobilePlatform } from "../utils/platform";
import { IconPlayerTab, IconBookTab, IconClose, IconCloud, IconEye, IconImport, IconMessage, IconRefresh, IconSearch, IconSparkle, IconTextTab } from "./Icons";
import { DEFAULT_SETTINGS } from "../utils/constants";
import { ANIME_PLAYER_AVAILABLE, EPUB_READER_AVAILABLE } from "../utils/featureFlags";
import { buildEpubFontPresets } from "../features/epub/epubFonts";
import { getTranslator } from "../utils/i18n";
import "./SettingsModal.css";

export interface TextReplacement { id: string; active: boolean; pattern: string; replacement: string; isRegex: boolean; }
export interface WsConfig { id: string; name: string; url: string; active: boolean; }

export interface AppSettings {
  useClipboard: boolean; websockets: WsConfig[]; websocketAutoConnect?: boolean; primaryWebSocketId?: string;
  panelPosition: 'bottom' | 'top-right'; speedMetric: 'chars' | 'words' | 'sentences'; speedTimeframe: 'minute' | 'hour'; autoPauseOnIdle?: boolean; autoPauseIdleMinutes?: number;
  allowManualPaste: boolean; allowManualPasteDuringPause: boolean;
  
  lookupHotkey: string;
  lookupScale: number; lookupFontSize: number; lookupFontFamily?: string; lookupTagFontSize: number; lookupWidth: number; lookupShowTags: boolean; lookupShowAudio: boolean;
  globalLookupEnabled?: boolean; globalLookupRestoreClipboard?: boolean; globalLookupShortcut?: string;
  hookProcesses: { name: string; active: boolean; icon?: string; path?: string; pid?: number }[];

  ankiDeck: string; ankiModel: string;
  ankiDeckMode?: 'shared' | 'contextual';
  ankiGlobalDeck?: string;
  ankiFieldWord: string; ankiFieldReading: string; ankiFieldMeaning: string; ankiFieldSentence: string; ankiFieldSentenceFurigana?: string; ankiFieldDict: string;
  ankiFieldAudio: string; ankiFieldPitch: string; ankiFieldFreq: string; ankiFieldScreenshot: string;
  ankiShowButtonNormal: boolean; ankiShowButtonScreenshot: boolean;

  dictionaries: { name: string; active: boolean; color?: string; allowDeinflect?: boolean }[];
  autoPlayAudio: boolean; syncPin: string; gdriveRefreshToken?: string;
  dictionaryAudioSource?: 'online' | 'local' | 'local-first' | 'online-first'; localAudioDatabasePath?: string; localAudioPreferredSource?: string;
  remoteCaptureAgentUrl?: string; remoteCaptureAgentToken?: string; localCaptureAgentToken?: string;
  textSyncServerEnabled?: boolean; textSyncServerPort?: number; textSyncServerToken?: string; textSyncRemoteEnabled?: boolean; textSyncRemoteUrl?: string; textSyncRemoteToken?: string;
  textSyncDeviceId?: string; textSyncCloudEnabled?: boolean; textSyncCloudUrl?: string;
  accountApiBaseUrl?: string; accountEmail?: string; accountAccessToken?: string; accountUserId?: string; accountDeviceName?: string;
  ankiColorNew: string; ankiColorOther: string; ankiColorSame: string; 
  ankiAllowDuplicatesOther: boolean; ankiAllowDuplicatesSame: boolean; 
  fontSize: number; fontFamily: string; normalizeFontSize?: boolean; customFontFamily?: string; customFontData?: string; customFontPath?: string; customFontName?: string; furiganaMode: 'none' | 'auto'; appLanguage: 'ru' | 'en'; autoScrollOffset: number; theme: 'dark' | 'light' | 'amoled'; textOrientation: 'horizontal' | 'vertical';
  jlModeFontSize?: number; jlModeFontFamily?: string; jlModeOpacity?: number; jlModeTextColor?: string; jlModeBackgroundColor?: string; jlModeBorderColor?: string; jlModeAlwaysOnTop?: boolean; jlModeShowControls?: boolean; jlModePadding?: number; jlModeLookupOnClick?: boolean;
  jlModeLookupTrigger?: 'hover' | 'click' | 'both'; jlModeHoverDelay?: number; jlModeBacklogCapacity?: number; jlModeHideLookupOnNewText?: boolean; jlModeAutoLookupFirstWord?: boolean;
  jlModeLookupMode?: 'scan' | 'click'; jlModeScanDelay?: number;
  aiEnabled?: boolean; aiLineButtons?: boolean; aiLanguage?: 'ru' | 'uk'; aiModel?: string;
  aiExplainLanguage?: 'ru' | 'uk' | 'ja' | 'en'; aiSourceLanguage?: 'auto' | 'ja' | 'en'; aiDetail?: 'detailed' | 'brief'; aiCustomPrompt?: string;
  mobileOverlayEnabled?: boolean; mobileOverlayFontSize?: number; mobileOverlayFontFamily?: 'serif' | 'sans' | 'monospace'; mobileOverlayLineHeight?: number;
  mobileOverlayOpacity?: number; mobileOverlayTextColor?: string; mobileOverlayBackgroundColor?: string; mobileOverlayBorderColor?: string;
  mobileOverlayWidth?: number; mobileOverlayHeight?: number; mobileOverlayPadding?: number; mobileOverlayLookupHeight?: number;
  mobileOverlayLocked?: boolean; mobileOverlayToolbarExpanded?: boolean;
  epubFontSize?: number; epubFontFamily?: string; epubTheme?: 'app' | 'dark' | 'paper' | 'sepia' | 'ttu-light' | 'ttu-ecru' | 'ttu-water' | 'ttu-gray' | 'ttu-dark' | 'ttu-black'; epubReadingMode?: 'paged' | 'scroll'; epubTextOrientation?: 'auto' | 'horizontal' | 'vertical'; epubMaxWidth?: number; epubLineHeight?: number; epubParagraphSpacing?: number; epubParagraphSpacingJa?: number; epubPagePadding?: number; epubShowImages?: boolean; epubBlurImages?: boolean; epubBlurImagesMode?: 'off' | 'after-toc' | 'all'; epubFuriganaMode?: 'show' | 'hover' | 'hide'; epubJustify?: boolean; epubPrettyWrap?: boolean; epubVerticalGrid?: boolean; epubTextIndent?: 'auto' | 'none' | 'indent'; epubAutoscrollSpeed?: number; epubAutoSync?: boolean; epubSyncUploadFiles?: boolean; epubVolumeKeyPaging?: boolean; epubEinkMode?: boolean; epubImageMaxWidth?: number;
  playerRewindSeconds: number; playerSubtitleStep: number; playerMiningLeadIn: number; playerMiningLeadOut: number; playerMiningReplayOnMine: boolean; playerCardFormat?: "audio" | "video"; playerSceneLeadIn?: number; playerMiningUseClipForAnki: boolean;
  playerKeyPlayPause: string; playerKeyBack: string; playerKeyForward: string; playerKeyMine: string; playerKeyOffsetMinus: string; playerKeyOffsetPlus: string;
  discordEnabled: boolean; discordClientId: string; discordShowTab: boolean; discordShowStats: boolean; discordShowChars: boolean; discordShowWords: boolean; discordShowSentences: boolean; discordShowProgress: boolean; discordShowPaused: boolean; discordShowTimer: boolean; discordShowButtons: boolean; discordShowSpeed?: boolean; discordTitleInMemberList?: boolean;
  discordTextActivityType: 'playing' | 'watching' | 'listening' | 'competing'; discordTextStatus: 'playing' | 'reading' | 'watching' | 'mining' | 'custom'; discordCustomTextStatus: string;
  discordLargeImage: string; discordSmallImage: string; discordButtonLabel: string; discordButtonUrl: string; discordSecondButtonLabel: string; discordSecondButtonUrl: string;
  updateAutoCheck: boolean;
  topbarShowClipboard?: boolean; topbarShowWebSockets?: boolean; topbarShowSync?: boolean; topbarShowCapture?: boolean; topbarShowJl?: boolean; topbarShowSearch?: boolean; topbarShowImport?: boolean; topbarShowExport?: boolean;
  replacements: TextReplacement[]; removeWhitespace: boolean; requireJapanese: boolean; ignoreDuplicates: boolean; enableTextCleaner: boolean;
}

interface SettingsModalProps { 
    isOpen: boolean; onClose: () => void; settings: AppSettings; onSettingsChange: (newSettings: AppSettings) => void; tabs: any[]; setTabs: (t: any[]) => void; 
    syncDictionaries: () => Promise<void>; runDictImport: (path: string | string[]) => Promise<boolean>;
    onResetSettings: () => void; onClearLookup: () => void; onCheckForUpdates?: (manual?: boolean) => Promise<void>; updateChecking?: boolean;
    initialSection?: string | null;
}

type SettingsTab = 'text' | 'sync' | 'jl' | 'epub' | 'lookup' | 'anki' | 'ai' | 'cloud' | 'player' | 'discord' | 'updates' | 'feedback';

interface SettingsNavButtonProps {
  active: boolean;
  icon: ReactNode;
  label: string;
  badge?: string;
  onClick: () => void;
}

const SettingsNavButton = ({ active, icon, label, badge, onClick }: SettingsNavButtonProps) => (
  <button type="button" className={`settings-nav-item${active ? " is-active" : ""}`} onClick={onClick}>
    <span className="settings-nav-icon" aria-hidden="true">{icon}</span>
    <span className="settings-nav-label">{label}</span>
    {badge && <span className="settings-nav-badge">{badge}</span>}
  </button>
);

const SettingsSubNavButton = ({ active, label, onClick }: Omit<SettingsNavButtonProps, "icon" | "badge">) => (
  <button type="button" className={`settings-subnav-item${active ? " is-active" : ""}`} onClick={onClick}>
    {label}
  </button>
);

interface AccountDevice {
  id?: string;
  deviceId?: string;
  deviceName?: string;
  captureAgentUrl?: string;
  captureAgentToken?: string;
  name?: string;
  createdAt?: string;
  updatedAt?: string;
  lastSeenAt?: string;
}

export default function SettingsModal({ isOpen, onClose, settings, onSettingsChange, tabs, setTabs, syncDictionaries, runDictImport, onClearLookup, onCheckForUpdates, updateChecking = false, initialSection = null }: SettingsModalProps) {
  const t = getTranslator(settings.appLanguage || 'ru');
  const [activeTab, setActiveTab] = useState<SettingsTab>('text');
  const [activeSubTab, setActiveSubTab] = useState<string>('text-app');
  const [highlightedSection, setHighlightedSection] = useState<string | null>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  const [wizardOpen, setWizardOpen] = useState(false);
  const [confirmDialog, setConfirmDialog] = useState<{title: string, message: string, onConfirm: () => void | Promise<void>} | null>(null);
  
  const initialSettingsRef = useRef<AppSettings | null>(null); 
  const historyRef = useRef<AppSettings[]>([]); 
  const [isPreviewMode, setIsPreviewMode] = useState(false); 
  const [resetDialog, setResetDialog] = useState(false); 
  const [localFontSize, setLocalFontSize] = useState(settings.fontSize || 26);
  const [localScrollOffset, setLocalScrollOffset] = useState(settings.autoScrollOffset ?? 80);
  const [wsAutoScanning, setWsAutoScanning] = useState(false);
  const [wsAutoStatus, setWsAutoStatus] = useState("");
  const [textSyncStatus, setTextSyncStatus] = useState("");
  const [accountPassword, setAccountPassword] = useState("");
  const [accountStatus, setAccountStatus] = useState("");
  const [accountDevices, setAccountDevices] = useState<AccountDevice[]>([]);
  const [accountBusy, setAccountBusy] = useState(false);
  const [captureAgent, setCaptureAgent] = useState<{ url: string; port: number; token: string } | null>(null);
  const [isCaptureAgentStarting, setIsCaptureAgentStarting] = useState(false);
  const [isRemoteCaptureChecking, setIsRemoteCaptureChecking] = useState(false);
  const [remoteCaptureStatus, setRemoteCaptureStatus] = useState("");

  const normalizeWebSocketUrl = (value: string) => {
      const trimmed = value.trim();
      if (!trimmed) return "";
      if (/^wss?:\/\//i.test(trimmed)) return trimmed;
      return `ws://${trimmed}`;
  };

  const testWebSocketUrl = (url: string, timeoutMs = 650) =>
      new Promise<boolean>((resolve) => {
          let settled = false;
          let ws: WebSocket | null = null;
          const finish = (ok: boolean) => {
              if (settled) return;
              settled = true;
              try { ws?.close(); } catch {}
              resolve(ok);
          };
          const timer = window.setTimeout(() => finish(false), timeoutMs);
          try {
              ws = new WebSocket(url);
              ws.onopen = () => { window.clearTimeout(timer); finish(true); };
              ws.onerror = () => { window.clearTimeout(timer); finish(false); };
              ws.onclose = () => { window.clearTimeout(timer); finish(false); };
          } catch {
              window.clearTimeout(timer);
              finish(false);
          }
      });

  const autoFindWebSocket = async () => {
      setWsAutoScanning(true);
      setWsAutoStatus(settings.appLanguage === 'en' ? 'Scanning...' : 'Ищу подключения...');
      try {
          const hosts = new Set(['127.0.0.1', 'localhost']);
          if (settings.remoteCaptureAgentUrl) {
              try { hosts.add(new URL(settings.remoteCaptureAgentUrl).hostname); } catch {}
          }
          (settings.websockets || []).forEach((ws) => {
              try { hosts.add(new URL(normalizeWebSocketUrl(ws.url)).hostname); } catch {}
          });

          const ports = [9002, 9001, 9000, 9003, 9004, 9005, 6677, 6678, 8080, 27080];
          const candidates = Array.from(hosts).flatMap((host) =>
              ports.flatMap((port) => [
                  { name: 'Agent / Textractor', url: `ws://${host}:${port}` },
                  { name: 'LunaTranslator', url: `ws://${host}:${port}/api/text/origin` },
              ])
          );

          const existing = new Set((settings.websockets || []).map((ws) => normalizeWebSocketUrl(ws.url)));
          for (let i = 0; i < candidates.length; i += 8) {
              const batch = candidates.slice(i, i + 8).filter((candidate) => !existing.has(candidate.url));
              const results = await Promise.all(batch.map(async (candidate) => ({
                  ...candidate,
                  ok: await testWebSocketUrl(candidate.url),
              })));
              const found = results.find((result) => result.ok);
              if (found) {
                  updateSetting('websockets', [
                      ...(settings.websockets || []),
                      { id: Date.now().toString(), name: found.name, url: found.url, active: true },
                  ]);
                  setWsAutoStatus(settings.appLanguage === 'en' ? `Found: ${found.url}` : `Найдено: ${found.url}`);
                  return;
              }
          }

          setWsAutoStatus(settings.appLanguage === 'en' ? 'Nothing found. Add IP:port manually.' : 'Ничего не найдено. Можно добавить IP:port вручную.');
      } finally {
          setWsAutoScanning(false);
      }
  };

  const generateToken = () => {
      const bytes = new Uint8Array(16);
      crypto.getRandomValues(bytes);
      return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  };

  const startTextSyncServer = async () => {
      const token = settings.textSyncServerToken?.trim();
      if (!token) {
          setTextSyncStatus(settings.appLanguage === "en" ? "Token is missing. Generate it once first." : "Нет токена. Сначала создай постоянный токен.");
          return;
      }
      const port = Math.max(1, Math.min(65535, Number(settings.textSyncServerPort) || 48732));
      setTextSyncStatus(settings.appLanguage === "en" ? "Starting Setsuna Sync..." : "Запускаю Setsuna Sync...");
      try {
          const result = await invoke<{ url: string; port: number; token: string }>("start_text_sync_server", { port, token });
          onSettingsChange({
              ...settings,
              textSyncServerEnabled: true,
              textSyncServerPort: result.port,
              textSyncServerToken: result.token,
          });
          setTextSyncStatus(settings.appLanguage === "en"
              ? `Running at ${result.url}`
              : `Запущено: ${result.url}`);
      } catch (error) {
          setTextSyncStatus(settings.appLanguage === "en"
              ? `Start failed: ${String(error)}`
              : `Не удалось запустить: ${String(error)}`);
      }
  };

  const stopTextSyncServer = async () => {
      try {
          await invoke("stop_text_sync_server");
      } catch {}
      onSettingsChange({ ...settings, textSyncServerEnabled: false });
      setTextSyncStatus(settings.appLanguage === "en" ? "Stopped." : "Остановлено.");
  };

  const testRemoteTextSync = async () => {
      const url = settings.textSyncRemoteUrl?.trim();
      const token = settings.textSyncRemoteToken?.trim();
      if (!url || !token) {
          setTextSyncStatus(settings.appLanguage === "en" ? "Enter remote URL and token first." : "Сначала введи URL и токен второй Setsuna.");
          return;
      }
      setTextSyncStatus(settings.appLanguage === "en" ? "Checking remote Setsuna..." : "Проверяю вторую Setsuna...");
      try {
          const result = await invoke<{ seq: number; lines: unknown[] }>("poll_remote_text_sync", { url, token, since: 0 });
          setTextSyncStatus(settings.appLanguage === "en"
              ? `Connected. Remote seq: ${result.seq}, buffered lines: ${result.lines?.length || 0}.`
              : `Подключено. Seq: ${result.seq}, строк в буфере: ${result.lines?.length || 0}.`);
      } catch (error) {
          setTextSyncStatus(settings.appLanguage === "en"
              ? `Connection failed: ${String(error)}`
              : `Не удалось подключиться: ${String(error)}`);
      }
  };

  const createCloudSyncRoom = async () => {
      setTextSyncStatus(settings.appLanguage === "en" ? "Creating cloud room..." : "Создаю облачную комнату...");
      try {
          const url = await invoke<string>("create_text_sync_cloud_room");
          onSettingsChange({
              ...settings,
              textSyncCloudUrl: url,
              textSyncCloudEnabled: true,
          });
          setTextSyncStatus(settings.appLanguage === "en"
              ? "Cloud room created. Use the same URL on the second PC."
              : "Облачная комната создана. Вставь этот же URL на втором ПК.");
      } catch (error) {
          setTextSyncStatus(settings.appLanguage === "en"
              ? `Cloud room failed: ${String(error)}`
              : `Не удалось создать облачную комнату: ${String(error)}`);
      }
  };

  const testCloudSyncRoom = async () => {
      const url = settings.textSyncCloudUrl?.trim();
      if (!url) {
          setTextSyncStatus(settings.appLanguage === "en" ? "Enter cloud room URL first." : "Сначала введи URL облачной комнаты.");
          return;
      }
      setTextSyncStatus(settings.appLanguage === "en" ? "Checking cloud room..." : "Проверяю облачную комнату...");
      try {
          await invoke("pull_text_sync_cloud_state", { url });
          setTextSyncStatus(settings.appLanguage === "en" ? "Cloud room is reachable." : "Облачная комната доступна.");
      } catch (error) {
          setTextSyncStatus(settings.appLanguage === "en"
              ? `Cloud check failed: ${String(error)}`
              : `Облако недоступно: ${String(error)}`);
      }
  };

  const readAuthPayload = (payload: any) => {
      const token = String(payload?.token || payload?.accessToken || "");
      const user = payload?.user || {};
      const userId = String(user?.id || payload?.userId || "");
      const email = String(user?.email || payload?.email || settings.accountEmail || "");
      const devices = Array.isArray(payload?.devices) ? payload.devices : (payload?.device ? [payload.device] : []);
      return { token, userId, email, devices };
  };

  const currentCaptureAgentUrl = captureAgent?.url || "";
  const currentCaptureAgentToken = captureAgent?.token || "";

  const registerCurrentDevice = async (options: { silent?: boolean } = {}) => {
      const apiBaseUrl = settings.accountApiBaseUrl?.trim();
      const token = settings.accountAccessToken?.trim();
      if (!apiBaseUrl || !token) return false;
      const deviceId = settings.textSyncDeviceId?.trim() || settings.textSyncServerToken?.trim() || "setsuna";
      const deviceName = settings.accountDeviceName?.trim() || (settings.appLanguage === "en" ? "This device" : "Это устройство");
      try {
          await invoke("account_register_device", {
              apiBaseUrl,
              token,
              deviceId,
              deviceName,
              captureAgentUrl: currentCaptureAgentUrl,
              captureAgentToken: currentCaptureAgentToken,
          });
          return true;
      } catch (error) {
          if (!options.silent) {
              setAccountStatus(settings.appLanguage === "en"
                  ? `Device heartbeat failed: ${formatAccountError(error)}`
                  : `Не удалось обновить устройство: ${formatAccountError(error)}`);
          }
          return false;
      }
  };

  const saveAccountAuth = (payload: any) => {
      const auth = readAuthPayload(payload);
      if (!auth.token) throw new Error(settings.appLanguage === "en" ? "Server did not return a token." : "Сервер не вернул токен.");
      onSettingsChange({
          ...settings,
          accountEmail: auth.email,
          accountUserId: auth.userId,
          accountAccessToken: auth.token,
      });
      setAccountDevices(auth.devices);
      setAccountPassword("");
  };

  const formatAccountError = (error: unknown) => {
      const text = String(error || "");
      const isMissingApi =
          text.includes("405 Method Not Allowed")
          || text.includes("404 Not Found")
          || text.includes("<html")
          || text.includes("<!DOCTYPE");

      if (isMissingApi) {
          return settings.appLanguage === "en"
              ? "Setsuna account API is not deployed at this address. Route the worker to /api/* or change the account server URL in technical settings."
              : "API аккаунтов Setsuna не развернут по этому адресу. Нужно привязать worker к /api/* или поменять URL сервера аккаунта в технических настройках.";
      }

      return text;
  };

  const accountAction = async (mode: "login" | "register") => {
      const apiBaseUrl = settings.accountApiBaseUrl?.trim();
      const email = settings.accountEmail?.trim();
      const password = accountPassword.trim();
      const deviceId = settings.textSyncDeviceId?.trim() || settings.textSyncServerToken?.trim() || "setsuna";
      const deviceName = settings.accountDeviceName?.trim() || (settings.appLanguage === "en" ? "This device" : "Это устройство");
      if (!apiBaseUrl || !email || !password) {
          setAccountStatus(settings.appLanguage === "en" ? "Enter API URL, email and password." : "Введи API URL, email и пароль.");
          return;
      }
      setAccountBusy(true);
      setAccountStatus(mode === "register"
          ? (settings.appLanguage === "en" ? "Creating account..." : "Создаю аккаунт...")
          : (settings.appLanguage === "en" ? "Signing in..." : "Вхожу в аккаунт..."));
      try {
          const command = mode === "register" ? "account_register" : "account_login";
          const payload = await invoke<any>(command, { apiBaseUrl, email, password, deviceId, deviceName });
          saveAccountAuth(payload);
          setAccountStatus(settings.appLanguage === "en" ? "Account connected." : "Аккаунт подключен.");
      } catch (error) {
          const message = formatAccountError(error);
          setAccountStatus(settings.appLanguage === "en"
              ? `Account error: ${message}`
              : `Ошибка аккаунта: ${message}`);
      } finally {
          setAccountBusy(false);
      }
  };

  const refreshAccountDevices = async () => {
      const apiBaseUrl = settings.accountApiBaseUrl?.trim();
      const token = settings.accountAccessToken?.trim();
      if (!apiBaseUrl || !token) {
          setAccountStatus(settings.appLanguage === "en" ? "Sign in first." : "Сначала войди в аккаунт.");
          return;
      }
      setAccountBusy(true);
      setAccountStatus(settings.appLanguage === "en" ? "Loading devices..." : "Загружаю устройства...");
      try {
          await registerCurrentDevice({ silent: true });
          const payload = await invoke<any>("account_list_devices", { apiBaseUrl, token });
          const devices = Array.isArray(payload?.devices) ? payload.devices : [];
          setAccountDevices(devices);
          setAccountStatus(settings.appLanguage === "en"
              ? `Devices loaded: ${devices.length}.`
              : `Устройств загружено: ${devices.length}.`);
      } catch (error) {
          const message = formatAccountError(error);
          setAccountStatus(settings.appLanguage === "en"
              ? `Device list failed: ${message}`
              : `Не удалось получить устройства: ${message}`);
      } finally {
          setAccountBusy(false);
      }
  };

  const disconnectAccount = () => {
      onSettingsChange({
          ...settings,
          accountAccessToken: "",
          accountUserId: "",
      });
      setAccountDevices([]);
      setAccountPassword("");
      setAccountStatus(settings.appLanguage === "en" ? "Account disconnected." : "Аккаунт отключен.");
  };

  const startCaptureAgent = async () => {
      setIsCaptureAgentStarting(true);
      try {
          const existingToken = settings.localCaptureAgentToken?.trim();
          const token = existingToken || crypto.randomUUID().replace(/-/g, "");
          const result = await invoke<{ url: string; port: number; token: string }>("start_capture_agent_server", { port: 48731, token });
          onSettingsChange({ ...settings, localCaptureAgentToken: token });
          setCaptureAgent(result);
          const apiBaseUrl = settings.accountApiBaseUrl?.trim();
          const accountToken = settings.accountAccessToken?.trim();
          if (apiBaseUrl && accountToken) {
              const deviceId = settings.textSyncDeviceId?.trim() || settings.textSyncServerToken?.trim() || "setsuna";
              const deviceName = settings.accountDeviceName?.trim() || (settings.appLanguage === "en" ? "This device" : "Это устройство");
              await invoke("account_register_device", {
                  apiBaseUrl,
                  token: accountToken,
                  deviceId,
                  deviceName,
                  captureAgentUrl: result.url,
                  captureAgentToken: result.token,
              }).catch(() => {});
              refreshAccountDevices();
          }
      } catch (error) {
          setRemoteCaptureStatus(settings.appLanguage === "en" ? `Agent start failed: ${String(error)}` : `Не удалось запустить агент: ${String(error)}`);
      } finally {
          setIsCaptureAgentStarting(false);
      }
  };

  const stopCaptureAgent = async () => {
      try { await invoke("stop_capture_agent_server"); } catch {}
      setCaptureAgent(null);
      const apiBaseUrl = settings.accountApiBaseUrl?.trim();
      const accountToken = settings.accountAccessToken?.trim();
      if (apiBaseUrl && accountToken) {
          const deviceId = settings.textSyncDeviceId?.trim() || settings.textSyncServerToken?.trim() || "setsuna";
          const deviceName = settings.accountDeviceName?.trim() || (settings.appLanguage === "en" ? "This device" : "Это устройство");
          await invoke("account_register_device", {
              apiBaseUrl,
              token: accountToken,
              deviceId,
              deviceName,
              captureAgentUrl: "",
              captureAgentToken: "",
          }).catch(() => {});
          refreshAccountDevices();
      }
  };

  const checkRemoteCaptureAgent = async () => {
      const url = settings.remoteCaptureAgentUrl?.trim();
      const token = settings.remoteCaptureAgentToken?.trim();
      if (!url || !token) {
          setRemoteCaptureStatus(settings.appLanguage === "en" ? "Enter URL and token first." : "Сначала введи URL и token.");
          return;
      }
      setIsRemoteCaptureChecking(true);
      try {
          const sources = await invoke<any[]>("list_remote_capture_sources", { url, token });
          setRemoteCaptureStatus(settings.appLanguage === "en" ? `Connected. Windows: ${sources.length}.` : `Подключено. Окон: ${sources.length}.`);
      } catch (error) {
          setRemoteCaptureStatus(settings.appLanguage === "en" ? `Connection failed: ${String(error)}` : `Не удалось подключиться: ${String(error)}`);
      } finally {
          setIsRemoteCaptureChecking(false);
      }
  };

  const useDeviceForScreenshots = async (device: AccountDevice) => {
      const url = device.captureAgentUrl?.trim() || "";
      const token = device.captureAgentToken?.trim() || "";
      if (!url || !token) {
          setRemoteCaptureStatus(settings.appLanguage === "en"
              ? "This device is not publishing screenshots right now."
              : "Это устройство сейчас не отдаёт скриншоты.");
          return;
      }

      onSettingsChange({
          ...settings,
          remoteCaptureAgentUrl: url,
          remoteCaptureAgentToken: token,
      });
      setRemoteCaptureStatus(settings.appLanguage === "en"
          ? `Screenshot source selected: ${device.deviceName || device.name || url}`
          : `Источник скриншотов выбран: ${device.deviceName || device.name || url}`);

      try {
          const sources = await invoke<any[]>("list_remote_capture_sources", { url, token });
          setRemoteCaptureStatus(settings.appLanguage === "en"
              ? `Connected. Windows available: ${sources.length}.`
              : `Подключено. Окон доступно: ${sources.length}.`);
      } catch (error) {
          setRemoteCaptureStatus(settings.appLanguage === "en"
              ? `Selected, but check failed: ${String(error)}`
              : `Выбрано, но проверка не прошла: ${String(error)}`);
      }
  };

  const isDeviceOnline = (lastSeen?: string) => {
      if (!lastSeen) return false;
      const at = Date.parse(lastSeen);
      return Number.isFinite(at) && Date.now() - at < 2 * 60 * 1000;
  };


  const handleImportYomitanFiles = async () => {
    try {
      const selected = await open({
        multiple: true,
        directory: false,
        filters: [
          {
            name: 'Dictionaries',
            extensions: ['zip', 'json', 'jsonl', 'gz', 'xz', 'txz', 'ifo', 'idx', 'dict', 'dz', 'csv', 'tsv', 'txt', 'dsl']
          }
        ]
      });

      if (!selected) return;

      const files = Array.isArray(selected) ? selected : [selected];

      const settingsFiles = files.filter((file) => {
        const name = file.toLowerCase().split(/[\\/]/).pop() || file.toLowerCase();
        return name.includes('settings') && name.endsWith('.json');
      });

      const dictionaryFiles = files.filter((file) => {
        const lower = file.toLowerCase();
        const name = lower.split(/[\\/]/).pop() || lower;

        if (settingsFiles.includes(file)) return false;

        return (
          lower.endsWith('.zip') ||
          lower.endsWith('.json') ||
          lower.endsWith('.jsonl') ||
          lower.endsWith('.jsonl.gz') ||
          lower.endsWith('.tar.xz') ||
          lower.endsWith('.txz') ||
          lower.endsWith('.ifo') ||
          lower.endsWith('.idx') ||
          lower.endsWith('.idx.gz') ||
          lower.endsWith('.dict') ||
          lower.endsWith('.dict.dz') ||
          lower.endsWith('.csv') ||
          lower.endsWith('.tsv') ||
          lower.endsWith('.txt') ||
          lower.endsWith('.dsl') ||
          name.includes('dictionaries')
        );
      });

      if (dictionaryFiles.length === 0) {
        alert(
          settingsFiles.length > 0
            ? t('app.yomitanOnlySettings')
            : t('app.yomitanNoDictionary')
        );
        return;
      }

      const imported = await runDictImport(dictionaryFiles);
      if (!imported) return;

      if (settingsFiles.length > 0) {
        alert(t('app.yomitanImportedWithSettings'));
      } else {
        alert(t('app.yomitanImported'));
      }
    } catch (e) {
      alert(t('app.yomitanImportError', { error: String(e) }));
    }
  };

  // Stay mounted briefly after closing so the window can animate out.
  const [presenceOpen, setPresenceOpen] = useState(isOpen);
  const [isClosing, setIsClosing] = useState(false);
  useEffect(() => {
      if (isOpen) {
          setPresenceOpen(true);
          setIsClosing(false);
          return;
      }
      if (!presenceOpen) return;
      setIsClosing(true);
      const timer = window.setTimeout(() => { setPresenceOpen(false); setIsClosing(false); }, 200);
      return () => window.clearTimeout(timer);
  }, [isOpen]);

  useEffect(() => {
      if (isOpen) {
          initialSettingsRef.current = JSON.parse(JSON.stringify(settings));
          historyRef.current = [];
          syncDictionaries();
          document.body.style.overflow = 'hidden';
      } else { 
          document.body.style.overflow = 'unset'; 
          setIsPreviewMode(false);
      }
      return () => { document.body.style.overflow = 'unset'; };
  }, [isOpen]);

  useEffect(() => {
      if (isOpen && highlightedSection) {
          setTimeout(() => {
              const el = document.getElementById(highlightedSection);
              if (el) { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); setTimeout(() => setHighlightedSection(null), 2000); }
          }, 100);
      }
  }, [isOpen, highlightedSection]);

  useEffect(() => { setLocalFontSize(settings.fontSize || 26); }, [settings.fontSize]);
  useEffect(() => { setLocalScrollOffset(settings.autoScrollOffset ?? 80); }, [settings.autoScrollOffset]);

  useEffect(() => {
      if (!isOpen || activeTab !== 'sync' || !settings.accountAccessToken || accountBusy) return;
      if (accountDevices.length > 0) return;
      refreshAccountDevices();
  }, [isOpen, activeTab, settings.accountAccessToken]);

  useEffect(() => {
      if (!isOpen || activeTab !== 'sync' || !settings.accountAccessToken) return;
      const interval = window.setInterval(() => {
          if (!accountBusy) refreshAccountDevices();
      }, 30000);
      return () => window.clearInterval(interval);
  }, [isOpen, activeTab, settings.accountAccessToken, accountBusy, captureAgent?.url, captureAgent?.token]);

  const updateSetting = <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => { 
      historyRef.current.push(JSON.parse(JSON.stringify(settings))); 
      onSettingsChange({ ...settings, [key]: value }); 
  };
  // Dragging the text size / autoscroll sliders turns Settings see-through
  // (only the slider row stays) so the change is visible on the reader behind.
  // One undo entry per drag; the live values skip the history.
  const [peekSlider, setPeekSlider] = useState<null | 'fontSize' | 'autoScroll'>(null);
  const peekValuesRef = useRef({ fontSize: localFontSize, autoScroll: localScrollOffset });
  peekValuesRef.current = { fontSize: localFontSize, autoScroll: localScrollOffset };
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  // The applied text size is the setting times the font's visual-size factor
  // (font normalization). Previewing with the same factor avoids a second jump
  // when the slider is released and the app re-applies the size.
  const fontScaleRef = useRef(1);
  const readFontScale = () => {
      const applied = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--txt-font-size'));
      const base = settings.fontSize || 26;
      return applied > 0 && base > 0 ? applied / base : 1;
  };
  const previewFontSize = (value: number) => {
      document.documentElement.style.setProperty('--txt-font-size', `${(value * fontScaleRef.current).toFixed(2)}px`);
  };
  const beginPeek = (slider: 'fontSize' | 'autoScroll') => {
      historyRef.current.push(JSON.parse(JSON.stringify(settings)));
      if (slider === 'fontSize') fontScaleRef.current = readFontScale();
      setPeekSlider(slider);
  };
  useEffect(() => {
      if (!peekSlider) return;
      const finish = () => {
          const values = peekValuesRef.current;
          onSettingsChange(peekSlider === 'fontSize'
              ? { ...settingsRef.current, fontSize: values.fontSize }
              : { ...settingsRef.current, autoScrollOffset: values.autoScroll });
          setPeekSlider(null);
      };
      window.addEventListener('pointerup', finish);
      window.addEventListener('pointercancel', finish);
      return () => {
          window.removeEventListener('pointerup', finish);
          window.removeEventListener('pointercancel', finish);
      };
  }, [peekSlider]);
  const peekRowClass = (slider: 'fontSize' | 'autoScroll') => `settings-peek-row${peekSlider === slider ? ' is-peek-target' : ''}`;

  const updateMultipleSettings = (newValues: Partial<AppSettings>) => {
      historyRef.current.push(JSON.parse(JSON.stringify(settings)));
      onSettingsChange({ ...settings, ...newValues });
  };

  const handleCustomFontPick = async () => {
      const selected = await open({
          multiple: false,
          directory: false,
          filters: [{
              name: settings.appLanguage === 'en' ? 'Font files' : 'Файлы шрифтов',
              extensions: ['ttf', 'otf', 'woff', 'woff2'],
          }],
      });
      const path = typeof selected === 'string' ? selected : null;
      if (!path) return;

      try {
          const rawBytes = await invoke<number[]>('read_file_bytes', { path });
          let binary = '';
          for (const byte of rawBytes) binary += String.fromCharCode(byte);
          const extension = (path.split('.').pop() || 'ttf').toLowerCase();
          const mime = extension === 'woff2' ? 'font/woff2' : extension === 'woff' ? 'font/woff' : extension === 'otf' ? 'font/otf' : 'font/ttf';
          const fileName = path.split(/[\\/]/).pop() || path;
          updateMultipleSettings({
              customFontFamily: 'SetsunaCustomFont',
              customFontData: `data:${mime};base64,${btoa(binary)}`,
              customFontPath: path,
              customFontName: fileName,
              fontFamily: "'SetsunaCustomFont', sans-serif",
              jlModeFontFamily: "'SetsunaCustomFont', sans-serif",
          });
      } catch (error) {
          setRemoteCaptureStatus(settings.appLanguage === 'en'
              ? `Could not load font: ${String(error)}`
              : `Не удалось загрузить шрифт: ${String(error)}`);
      }
  };

  const clearCustomFont = () => updateMultipleSettings({
      customFontFamily: '',
      customFontData: '',
      customFontPath: '',
      customFontName: '',
      fontFamily: DEFAULT_SETTINGS.fontFamily,
      jlModeFontFamily: DEFAULT_SETTINGS.jlModeFontFamily,
  });

  useEffect(() => {
      const handleKeyDown = (e: KeyboardEvent) => {
          if (isOpen && (e.ctrlKey || e.metaKey) && (e.code === 'KeyZ' || e.key.toLowerCase() === 'z' || e.key.toLowerCase() === 'я')) {
              if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
              e.preventDefault();
              if (historyRef.current.length > 0) {
                  const prev = historyRef.current.pop();
                  if (prev) onSettingsChange(prev);
              }
          }
      };
      window.addEventListener('keydown', handleKeyDown);
      return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, settings]);

  const handleCancel = () => {
      onClose();
  };

  const handleResetVisuals = () => {
      historyRef.current.push(JSON.parse(JSON.stringify(settings)));
      onSettingsChange({
          ...settings,
          theme: 'dark', fontSize: 26, fontFamily: "'Noto Serif JP', 'Yu Mincho', 'YuMincho', 'Hiragino Mincho ProN', 'BIZ UDPMincho', 'Meiryo', serif",
          customFontFamily: '', customFontData: '', customFontPath: '', customFontName: '',
          panelPosition: 'bottom', autoScrollOffset: 80, textOrientation: 'horizontal',
          lookupScale: 1.0, lookupFontSize: 14, lookupTagFontSize: 11, lookupWidth: 380,
      });
      setResetDialog(false);
  };
  
  const handleResetAll = () => {
      historyRef.current.push(JSON.parse(JSON.stringify(settings)));
      onSettingsChange({
          ...DEFAULT_SETTINGS,
          dictionaries: settings.dictionaries,
          websockets: settings.websockets,
          hookProcesses: settings.hookProcesses,
          textSyncServerToken: settings.textSyncServerToken,
          textSyncServerPort: settings.textSyncServerPort,
      });
      setResetDialog(false);
  };

  useEffect(() => {
      if (!isOpen || !initialSection) return;
      if (initialSection.startsWith('text-') || initialSection === 'sync-main') {
          setActiveTab('text');
          const target = initialSection.startsWith('text-') ? initialSection : 'text-src';
          setActiveSubTab(target);
          setHighlightedSection(target);
      } else if (initialSection.startsWith('anki-')) {
          setActiveTab('anki');
          setActiveSubTab(initialSection);
          setHighlightedSection(initialSection);
      } else if (initialSection.startsWith('player-') && ANIME_PLAYER_AVAILABLE) {
          setActiveTab('player');
          setActiveSubTab(initialSection);
          setHighlightedSection(initialSection);
      } else if (initialSection.startsWith('epub-')) {
          setActiveTab('epub');
          setActiveSubTab(initialSection);
          setHighlightedSection(initialSection);
      }
  }, [isOpen, initialSection]);

  const handleNav = (mainTab: SettingsTab, subTab: string) => {
      if (activeTab !== mainTab) setActiveTab(mainTab);
      setActiveSubTab(subTab); setHighlightedSection(subTab);
      setTimeout(() => {
          const el = document.getElementById(subTab);
          if (el && scrollContainerRef.current) scrollContainerRef.current.scrollTo({ top: el.offsetTop - 25, behavior: 'smooth' });
      }, 50);
      setTimeout(() => setHighlightedSection(null), 1000); 
  };

  const isEnglish = settings.appLanguage === 'en';
  const sectionMeta: Record<SettingsTab, { title: string; description: string }> = {
      text: { title: t('settings.nav.text'), description: isEnglish ? 'Appearance, text sources and reading behavior' : 'Внешний вид, источники текста и поведение читалки' },
      sync: { title: 'Setsuna Sync', description: isEnglish ? 'Connected devices and capture' : 'Подключённые устройства и захват' },
      jl: { title: 'Setsuna Flow', description: isEnglish ? 'Floating reading mode' : 'Компактный режим чтения поверх окон' },
      epub: { title: isEnglish ? 'EPUB reader' : 'EPUB-ридер', description: isEnglish ? 'Book reader settings' : 'Настройки чтения книг' },
      lookup: { title: t('settings.nav.lookup'), description: isEnglish ? 'Lookup window, dictionaries and shortcuts' : 'Окно поиска, словари и горячие клавиши' },
      anki: { title: 'Anki', description: isEnglish ? 'Cards, decks and screenshots' : 'Карточки, колоды и скриншоты' },
      ai: { title: isEnglish ? 'AI explanations' : 'ИИ-объяснения', description: isEnglish ? 'A local model that explains lines in Russian or Ukrainian' : 'Локальная модель объясняет строки на русском или украинском' },
      cloud: { title: 'Google Drive', description: isEnglish ? 'Private backups and restore' : 'Приватные резервные копии и восстановление' },
      player: { title: isEnglish ? 'Player' : 'Плеер', description: isEnglish ? 'Video and subtitle settings' : 'Видео и настройки субтитров' },
      discord: { title: 'Discord', description: isEnglish ? 'Rich Presence and activity preview' : 'Rich Presence и предпросмотр активности' },
      updates: { title: isEnglish ? 'Updates' : 'Обновления', description: isEnglish ? 'Version and automatic update settings' : 'Версия и параметры автоматического обновления' },
      feedback: { title: isEnglish ? 'Feedback' : 'Обратная связь', description: isEnglish ? 'Bug reports and feature requests' : 'Ошибки и пожелания по новым функциям' },
  };
  const currentSection = sectionMeta[activeTab];

  if (!isOpen && !presenceOpen) return null;

  return (
    <>
      <style>{`
          @keyframes tabFadeIn { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
          .tab-content-anim { animation: tabFadeIn 0.25s cubic-bezier(0.2, 0.8, 0.2, 1) forwards; display: flex; flex-direction: column; gap: 25px; }
          @keyframes smoothFlash { 0% { border-color: var(--border-main); background-color: var(--bg-panel); box-shadow: none; } 15% { border-color: var(--accent-blue); background-color: rgba(79, 166, 255, 0.08); box-shadow: 0 0 10px rgba(79, 166, 255, 0.2); } 100% { border-color: var(--border-main); background-color: var(--bg-panel); box-shadow: none; } }
          .card-highlighted { animation: smoothFlash 1s ease-in-out forwards; }
          .tiny-scroll::-webkit-scrollbar { width: 6px; } 
      `}</style>

      {wizardOpen && (
        <SetupWizard
          isOpen={wizardOpen}
          onClose={() => setWizardOpen(false)}
          installedDictionariesCount={settings.dictionaries?.length || 0}
          ankiDeck={settings.ankiDeck}
          ankiModel={settings.ankiModel}
          settings={settings}
          onSettingsPatch={(patch) => onSettingsChange({ ...settings, ...patch })}
          onAnkiDeckChange={(deck) => onSettingsChange({ ...settings, ankiDeck: deck })}
          onImportYomitan={handleImportYomitanFiles}
        />
      )}
      
      {/* КНОПКА ВОЗВРАТА */}
      {isPreviewMode && (
          <div style={{ position: 'fixed', top: '20px', left: '50%', transform: 'translateX(-50%)', zIndex: 100001 }}>
              <button onClick={() => setIsPreviewMode(false)} className="btn-primary" style={{ padding: '12px 24px', borderRadius: '30px', fontSize: '15px', fontWeight: 'bold', boxShadow: '0 10px 25px rgba(0,0,0,0.5)', border: '1px solid rgba(255,255,255,0.2)', cursor: 'pointer' }}>
                  {t('settings.backToSettings')}
              </button>
          </div>
      )}

      <div className={`settings-overlay${isPreviewMode ? ' is-preview' : ''}${peekSlider ? ' is-peeking' : ''}${isClosing ? ' is-closing' : ''}`} onClick={() => { if (!isPreviewMode) { handleCancel(); onClearLookup(); } }}>
        <div className={`settings-window${isPreviewMode ? ' is-preview' : ''}${peekSlider ? ' is-peeking' : ''}${isClosing ? ' is-closing' : ''}`} onClick={(e) => { e.stopPropagation(); onClearLookup(); }}>
          <header className="settings-topbar">
              <div className="settings-title-block">
                  <span className="settings-eyebrow">Setsuna</span>
                  <div>
                      <h1>{currentSection.title}</h1>
                      <p>{currentSection.description}</p>
                  </div>
              </div>
              <div className="settings-topbar-actions">
                  <button type="button" className="settings-action" onClick={() => setIsPreviewMode(true)}>
                      <IconEye /> <span>{t('settings.preview')}</span>
                  </button>
                  <button type="button" className="settings-action" onClick={() => setWizardOpen(true)}>
                      <IconImport /> <span>{t('settings.wizard')}</span>
                  </button>
                  <button type="button" className="settings-action is-danger" onClick={() => setResetDialog(true)}>{t('settings.reset')}</button>
                  <button type="button" className="settings-action is-icon" onClick={handleCancel} title={t('common.close')} aria-label={t('common.close')}>
                      <IconClose />
                  </button>
              </div>
          </header>

          <div className="settings-layout">
            <nav className="settings-navigation" aria-label={isEnglish ? 'Settings sections' : 'Разделы настроек'}>
              <div className="settings-nav-group">
                  <span className="settings-nav-heading">{isEnglish ? 'Reading' : 'Чтение'}</span>
                  <SettingsNavButton active={activeTab === 'text'} icon={<IconTextTab />} label={t('settings.nav.text')} onClick={() => handleNav('text', 'text-app')} />
                  {activeTab === 'text' && <div className="settings-subnav">
                      <SettingsSubNavButton active={activeSubTab === 'text-app'} label={t('settings.nav.appearance')} onClick={() => handleNav('text', 'text-app')} />
                      <SettingsSubNavButton active={activeSubTab === 'text-stats'} label={t('settings.nav.stats')} onClick={() => handleNav('text', 'text-stats')} />
                      <SettingsSubNavButton active={activeSubTab === 'text-src'} label={t('settings.nav.sources')} onClick={() => handleNav('text', 'text-src')} />
                      <SettingsSubNavButton active={activeSubTab === 'text-filters'} label={t('settings.nav.filters')} onClick={() => handleNav('text', 'text-filters')} />
                  </div>}
                  {EPUB_READER_AVAILABLE && (
                      <>
                          <SettingsNavButton active={activeTab === 'epub'} icon={<IconBookTab />} label={isEnglish ? 'EPUB reader' : 'EPUB-ридер'} onClick={() => handleNav('epub', 'epub-reader')} />
                          {activeTab === 'epub' && <div className="settings-subnav">
                              <SettingsSubNavButton active={activeSubTab === 'epub-reader'} label={isEnglish ? 'Reading view' : 'Вид читалки'} onClick={() => handleNav('epub', 'epub-reader')} />
                              <SettingsSubNavButton active={activeSubTab === 'epub-layout'} label={isEnglish ? 'Layout & images' : 'Раскладка и картинки'} onClick={() => handleNav('epub', 'epub-layout')} />
                          </div>}
                      </>
                  )}
                  {ANIME_PLAYER_AVAILABLE && <SettingsNavButton active={activeTab === 'player'} icon={<IconPlayerTab />} label={isEnglish ? 'Media player' : 'Видеоплеер'} onClick={() => handleNav('player', 'player-main')} />}
                  <SettingsNavButton active={activeTab === 'jl'} icon={<IconTextTab />} label="Setsuna Flow" onClick={() => handleNav('jl', 'jl-main')} />
              </div>

              <div className="settings-nav-group">
                  <span className="settings-nav-heading">{isEnglish ? 'Tools' : 'Инструменты'}</span>
                  <SettingsNavButton active={activeTab === 'lookup'} icon={<IconSearch />} label={t('settings.nav.lookup')} onClick={() => handleNav('lookup', 'lookup-win')} />
                  {activeTab === 'lookup' && <div className="settings-subnav">
                      <SettingsSubNavButton active={activeSubTab === 'lookup-win'} label={t('settings.nav.lookupWindow')} onClick={() => handleNav('lookup', 'lookup-win')} />
                      <SettingsSubNavButton active={activeSubTab === 'lookup-dicts'} label={t('settings.nav.dictionaries')} onClick={() => handleNav('lookup', 'lookup-dicts')} />
                  </div>}
                  <SettingsNavButton active={activeTab === 'anki'} icon={<IconBookTab />} label="Anki" onClick={() => handleNav('anki', 'anki-cards')} />
                  {activeTab === 'anki' && <div className="settings-subnav">
                      <SettingsSubNavButton active={activeSubTab === 'anki-cards'} label={t('settings.nav.cards')} onClick={() => handleNav('anki', 'anki-cards')} />
                      <SettingsSubNavButton active={activeSubTab === 'anki-audio'} label={isEnglish ? 'Audio' : 'Озвучка'} onClick={() => handleNav('anki', 'anki-audio')} />
                      <SettingsSubNavButton active={activeSubTab === 'anki-hooks'} label={t('settings.nav.screenshots')} onClick={() => handleNav('anki', 'anki-hooks')} />
                  </div>}
                  {!isMobilePlatform() && <SettingsNavButton active={activeTab === 'ai'} icon={<IconSparkle />} label={isEnglish ? 'AI explanations' : 'ИИ-объяснения'} onClick={() => handleNav('ai', 'ai-main')} />}
              </div>

              <div className="settings-nav-group">
                  <span className="settings-nav-heading">{isEnglish ? 'Services' : 'Сервисы'}</span>
                  <SettingsNavButton active={activeTab === 'cloud'} icon={<IconCloud />} label="Google Drive" onClick={() => handleNav('cloud', 'cloud-main')} />
                  <SettingsNavButton active={activeTab === 'discord'} icon={<IconMessage />} label="Discord" onClick={() => handleNav('discord', 'discord-main')} />
                  <SettingsNavButton active={activeTab === 'updates'} icon={<IconRefresh />} label={isEnglish ? 'Updates' : 'Обновления'} onClick={() => handleNav('updates', 'updates-main')} />
                  <SettingsNavButton active={activeTab === 'feedback'} icon={<IconMessage />} label={isEnglish ? 'Feedback' : 'Обратная связь'} onClick={() => handleNav('feedback', 'feedback-main')} />
              </div>
            </nav>

            <main ref={scrollContainerRef} className="settings-content">
              <div className="settings-content-inner" key={activeTab}>
              
              {/* === TEXT TAB === */}
              {activeTab === 'text' && (
                <div className="tab-content-anim">
                  <div id="text-app" className={`modern-card ${highlightedSection === 'text-app' ? 'card-highlighted' : ''}`} style={{ background: 'var(--bg-panel)', border: '1px solid var(--border-main)' }}>
                      <div className="card-label" style={{ color: 'var(--text-main)' }}>{t('settings.nav.appearance')}</div>
                      <div style={{ display: 'flex', gap: '15px', marginBottom: '15px' }}>
                          <div style={{ flex: 1 }}>
                              <div style={{ color: 'var(--text-muted)', fontSize: '12px', marginBottom: '6px' }}>{t('settings.theme')}</div>
                              <select className="modern-select" value={settings.theme || 'dark'} onChange={(e) => updateSetting('theme', e.target.value as any)}><option value="dark">{t('wizard.theme.dark')}</option><option value="light">{t('wizard.theme.light')}</option><option value="amoled">{t('wizard.theme.amoled')}</option></select>
                          </div>
                          <div style={{ flex: 1 }}>
                              <div style={{ color: 'var(--text-muted)', fontSize: '12px', marginBottom: '6px' }}>{t('settings.language')}</div>
                              <select className="modern-select" value={settings.appLanguage || 'ru'} onChange={(e) => updateSetting('appLanguage', e.target.value as any)}><option value="ru">{t('wizard.language.ru')}</option><option value="en">{t('wizard.language.en')}</option></select>
                          </div>
                      </div>
                      <div className={peekRowClass('fontSize')} style={{ display: 'flex', gap: '15px', alignItems: 'center', marginBottom: '15px' }}>
                          <span style={{ color: 'var(--text-muted)', fontSize: '13px', width: '130px' }}>{t('settings.fontSize')}</span>
                          <input type="range" min="12" max="64" value={localFontSize} onPointerDown={() => beginPeek('fontSize')} onChange={(e) => { const val = Number(e.target.value); setLocalFontSize(val); if (peekSlider) previewFontSize(val); else updateSetting('fontSize', val); }} style={{ flex: 1 }} />
                          <span style={{ color: 'var(--text-main)', fontWeight: 'bold', width: '40px', textAlign: 'center' }}>{localFontSize}px</span>
                      </div>
                      <div className={peekRowClass('autoScroll')} style={{ display: 'flex', gap: '15px', alignItems: 'center', marginBottom: '15px' }}>
                          <span style={{ color: 'var(--text-muted)', fontSize: '13px', width: '130px' }}>{t('settings.autoscroll')}</span>
                          <input type="range" min="30" max="85" value={localScrollOffset} onPointerDown={() => beginPeek('autoScroll')} onChange={(e) => { const val = Number(e.target.value); setLocalScrollOffset(val); if (peekSlider) onSettingsChange({ ...settings, autoScrollOffset: val }); else updateSetting('autoScrollOffset', val); }} style={{ flex: 1 }} />
                          <span style={{ color: 'var(--text-main)', fontWeight: 'bold', width: '40px', textAlign: 'center' }}>{localScrollOffset}%</span>
                      </div>
                      <div style={{ display: 'flex', gap: '15px', alignItems: 'center', marginBottom: '15px' }}>
                          <span style={{ color: 'var(--text-muted)', fontSize: '13px', width: '130px' }}>{t('settings.textFont')}</span>
                          <FontPicker
                              english={settings.appLanguage === 'en'}
                              title={t('settings.textFont').replace(/:$/, '')}
                              value={settings.fontFamily || "'Noto Serif JP', 'Yu Mincho', serif"}
                              onChange={(value) => { updateSetting('fontFamily', value); document.documentElement.style.setProperty('--txt-font-family', value); }}
                              presets={[
                                  { value: "'Noto Serif JP', 'Yu Mincho', 'YuMincho', 'Hiragino Mincho ProN', 'BIZ UDPMincho', 'Meiryo', serif", label: t('wizard.font.serif') },
                                  { value: "'Noto Sans JP', 'Yu Gothic UI', 'Yu Gothic', 'Meiryo', 'BIZ UDPGothic', sans-serif", label: t('wizard.font.sans') },
                                  { value: "'Yu Gothic UI', 'Yu Gothic', 'Meiryo', sans-serif", label: t('wizard.font.yu') },
                                  { value: "'Meiryo', 'Yu Gothic UI', sans-serif", label: t('wizard.font.meiryo') },
                              ]}
                              customFont={(settings.customFontData || settings.customFontPath) && settings.customFontFamily
                                  ? { value: `'${settings.customFontFamily}', sans-serif`, label: settings.customFontName || (settings.appLanguage === 'en' ? 'Custom font' : 'Свой шрифт'), hint: settings.appLanguage === 'en' ? 'Font file' : 'Файл шрифта' }
                                  : null}
                              onPickFile={() => void handleCustomFontPick()}
                              onRemoveCustom={clearCustomFont}
                          />
                      </div>
                      <div style={{ display: 'flex', gap: '15px', alignItems: 'center', marginBottom: '15px' }}>
                          <span style={{ width: '130px', flex: '0 0 130px' }} />
                          <label className="checkbox-label" title={settings.appLanguage === 'en' ? 'Different fonts draw Japanese at different sizes; this scales the text so every font looks the same size.' : 'Шрифты рисуют японские знаки разного размера; эта опция подгоняет текст, чтобы любой шрифт выглядел одинаково крупным.'}>
                              <input type="checkbox" checked={settings.normalizeFontSize !== false} onChange={(e) => updateSetting('normalizeFontSize', e.target.checked)} />
                              {settings.appLanguage === 'en' ? 'Even out the visual size of different fonts' : 'Выравнивать видимый размер разных шрифтов'}
                          </label>
                      </div>
                      <div style={{ display: 'flex', gap: '15px', alignItems: 'center', marginBottom: '15px' }}>
                          <span style={{ color: 'var(--text-muted)', fontSize: '13px', width: '130px' }}>{t('settings.furiganaMode')}</span>
                          <select className="modern-select" value={settings.furiganaMode === 'auto' ? 'auto' : 'none'} onChange={(e) => updateSetting('furiganaMode', e.target.value as any)} style={{ flex: 1, marginTop: 0 }}><option value="none">{t('wizard.furigana.none')}</option><option value="auto">{t('wizard.furigana.auto')}</option></select>
                      </div>
                      <div style={{ display: 'flex', gap: '15px', alignItems: 'center', marginBottom: '15px' }}>
                          <span style={{ color: 'var(--text-muted)', fontSize: '13px', width: '130px' }}>{settings.appLanguage === 'en' ? 'Text direction' : 'Направление'}</span>
                          <select className="modern-select" value={settings.textOrientation || 'horizontal'} onChange={(e) => updateSetting('textOrientation', e.target.value as any)} style={{ flex: 1, marginTop: 0 }}>
                              <option value="horizontal">{settings.appLanguage === 'en' ? 'Horizontal' : 'Горизонтально'}</option>
                              <option value="vertical">{settings.appLanguage === 'en' ? 'Vertical right-to-left' : 'Вертикально справа налево'}</option>
                          </select>
                      </div>
                  </div>

                  <div id="text-stats" className={`modern-card ${highlightedSection === 'text-stats' ? 'card-highlighted' : ''}`} style={{ background: 'var(--bg-panel)', border: '1px solid var(--border-main)' }}>
                      <div className="card-label" style={{ color: 'var(--text-main)' }}>{t('settings.statsPanel')}</div>
                      <div style={{ display: 'flex', gap: '15px' }}>
                          <div style={{ flex: 1 }}>
                              <div style={{ color: 'var(--text-muted)', fontSize: '12px', marginBottom: '6px' }}>{t('settings.position')}</div>
                              <select className="modern-select" value={settings.panelPosition || 'bottom'} onChange={(e) => updateSetting('panelPosition', e.target.value as any)}>
                                  <option value="bottom">{t('settings.bottomDocked')}</option>
                                  <option value="top-right">{t('settings.topRightFloating')}</option>
                              </select>
                          </div>
                          <div style={{ flex: 1 }}>
                              <div style={{ color: 'var(--text-muted)', fontSize: '12px', marginBottom: '6px' }}>{t('settings.readingSpeed')}</div>
                              <select className="modern-select" value={settings.speedMetric || 'chars'} onChange={(e) => updateSetting('speedMetric', e.target.value as any)}>
                                  <option value="chars">{t('settings.metricChars')}</option>
                                  <option value="words">{t('settings.metricWords')}</option>
                                  <option value="sentences">{t('settings.metricSentences')}</option>
                              </select>
                          </div>
                          <div style={{ flex: 1 }}>
                              <div style={{ color: 'var(--text-muted)', fontSize: '12px', marginBottom: '6px' }}>{t('settings.timeframe')}</div>
                              <select className="modern-select" value={settings.speedTimeframe || 'minute'} onChange={(e) => updateSetting('speedTimeframe', e.target.value as any)}>
                                  <option value="minute">{t('settings.perMinute')}</option>
                                  <option value="hour">{t('settings.perHour')}</option>
                              </select>
                          </div>
                      </div>
                      <div style={{ marginTop: 16, paddingTop: 14, borderTop: '1px solid var(--border-main)', display: 'grid', gridTemplateColumns: '1fr 190px', gap: 14, alignItems: 'end' }}>
                          <label className="checkbox-label" style={{ marginBottom: 0 }}>
                              <input type="checkbox" checked={settings.autoPauseOnIdle ?? false} onChange={(e) => updateSetting('autoPauseOnIdle', e.target.checked)} />
                              {settings.appLanguage === 'en' ? 'Automatically pause timer after inactivity' : 'Автоматически останавливать таймер после бездействия'}
                          </label>
                          <label style={{ color: 'var(--text-muted)', fontSize: '12px' }}>
                              {settings.appLanguage === 'en' ? 'Idle minutes' : 'Минут бездействия'}
                              <input
                                  type="number"
                                  min="1"
                                  max="120"
                                  className="modern-input"
                                  value={settings.autoPauseIdleMinutes ?? 5}
                                  onChange={(e) => updateSetting('autoPauseIdleMinutes', Math.max(1, Number(e.target.value) || 1))}
                                  style={{ marginTop: 6 }}
                              />
                          </label>
                      </div>
                  </div>

                  <div id="text-src" className={`modern-card ${highlightedSection === 'text-src' ? 'card-highlighted' : ''}`} style={{ background: 'var(--bg-panel)', border: '1px solid var(--border-main)' }}>
                      <div className="card-label" style={{ color: 'var(--text-main)' }}>{t('settings.sourcesTitle')}</div>
                      <label className="checkbox-label" style={{ marginBottom: '10px' }}><input type="checkbox" checked={settings.useClipboard} onChange={(e) => updateSetting('useClipboard', e.target.checked)} /> {t('settings.clipboardCapture')}</label>
                      <label className="checkbox-label" style={{ marginBottom: '10px' }}><input type="checkbox" checked={settings.allowManualPaste} onChange={(e) => updateSetting('allowManualPaste', e.target.checked)} /> {t('settings.manualPaste')}</label>
                      
                      <div style={{ marginTop: '15px', borderTop: '1px solid var(--border-main)', paddingTop: '15px' }}>
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px' }}>
                              <div style={{ color: 'var(--text-main)', fontSize: '13px', fontWeight: 'bold' }}>{t('settings.websockets')}</div>
                              <div style={{ display: 'flex', gap: '8px' }}>
                                  <button onClick={autoFindWebSocket} disabled={wsAutoScanning} className="btn-primary" style={{ padding: '4px 10px', fontSize: '11px', opacity: wsAutoScanning ? 0.7 : 1 }}>{wsAutoScanning ? '...' : (settings.appLanguage === 'en' ? 'Auto find' : 'Авто-поиск')}</button>
                                  <button onClick={() => { updateSetting('websockets', [...(settings.websockets || []), { id: Date.now().toString(), name: t('settings.newWebSocket'), url: 'ws://localhost:9002', active: true }]); }} className="btn-primary" style={{ padding: '4px 10px', fontSize: '11px' }}>+ {t('settings.add')}</button>
                              </div>
                          </div>
                          <label className="checkbox-label" style={{ marginBottom: '10px' }}>
                              <input
                                  type="checkbox"
                                  checked={settings.websocketAutoConnect ?? false}
                                  onChange={(e) => updateSetting('websocketAutoConnect', e.target.checked)}
                              />
                              {settings.appLanguage === 'en' ? 'Connect primary WebSocket on startup' : 'Подключать основной WebSocket при запуске'}
                          </label>
                          {wsAutoStatus && <div style={{ color: 'var(--text-muted)', fontSize: '12px', marginBottom: '8px' }}>{wsAutoStatus}</div>}
                          {(!settings.websockets || settings.websockets.length === 0) ? ( <div style={{ color: 'var(--text-muted)', fontSize: '12px' }}>{t('settings.noConnections')}</div> ) : (
                              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                                  {settings.websockets.map((ws, idx) => (
                                      <div key={ws.id} style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                                          <input type="checkbox" checked={ws.active} onChange={(e) => { const arr = [...settings.websockets]; arr[idx].active = e.target.checked; updateSetting('websockets', arr); }} style={{ accentColor: 'var(--accent-blue)', cursor: 'pointer' }} title={settings.appLanguage === 'en' ? 'Enable connection and toolbar button' : 'Включить подключение и кнопку на панели'} />
                                          <input
                                              type="radio"
                                              name="primary-websocket"
                                              checked={(settings.primaryWebSocketId || settings.websockets.find((item) => item.active)?.id) === ws.id}
                                              onChange={() => updateSetting('primaryWebSocketId', ws.id)}
                                              title={settings.appLanguage === 'en' ? 'Primary WebSocket' : 'Основной WebSocket'}
                                              style={{ accentColor: 'var(--accent-blue)', cursor: 'pointer' }}
                                          />
                                          <input type="text" className="modern-input" placeholder={t('settings.namePlaceholder')} value={ws.name} onChange={(e) => { const arr = [...settings.websockets]; arr[idx].name = e.target.value; updateSetting('websockets', arr); }} style={{ padding: '4px 8px', width: '100px' }} />
                                          <input type="text" className="modern-input" placeholder="ws:// or ip:port" value={ws.url} onBlur={(e) => { const arr = [...settings.websockets]; arr[idx].url = normalizeWebSocketUrl(e.target.value); updateSetting('websockets', arr); }} onChange={(e) => { const arr = [...settings.websockets]; arr[idx].url = e.target.value; updateSetting('websockets', arr); }} style={{ padding: '4px 8px', flex: 1 }} />
                                          <button onClick={() => { const remaining = settings.websockets.filter((_, i) => i !== idx); onSettingsChange({ ...settings, websockets: remaining, primaryWebSocketId: settings.primaryWebSocketId === ws.id ? remaining.find((item) => item.active)?.id : settings.primaryWebSocketId }); }} style={{ background: 'transparent', color: '#ff4444', border: 'none', cursor: 'pointer' }}>✕</button>
                                      </div>
                                  ))}
                              </div>
                          )}
                      </div>
                  </div>

                  <div id="text-filters" className={`modern-card ${highlightedSection === 'text-filters' ? 'card-highlighted' : ''}`} style={{ background: 'var(--bg-panel)', border: '1px solid var(--border-main)' }}>
                        <div className="card-label" style={{ color: 'var(--text-main)' }}>{t('settings.filtersTitle')}</div>
                        <label className="checkbox-label" style={{ marginBottom: '12px' }}><input type="checkbox" checked={settings.enableTextCleaner ?? true} onChange={(e) => updateSetting('enableTextCleaner', e.target.checked)} /> {t('settings.cleanHtmlUnity')}</label>
                        <label className="checkbox-label" style={{ marginBottom: '12px' }}><input type="checkbox" checked={settings.ignoreDuplicates ?? true} onChange={(e) => updateSetting('ignoreDuplicates', e.target.checked)} /> {t('settings.ignoreDuplicates')}</label>
                        <label className="checkbox-label" style={{ marginBottom: '12px' }}><input type="checkbox" checked={settings.removeWhitespace ?? false} onChange={(e) => updateSetting('removeWhitespace', e.target.checked)} /> {t('settings.removeWhitespace')}</label>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '15px', marginTop: '20px', borderTop: '1px solid var(--border-main)', paddingTop: '20px' }}>
                            <div className="card-label" style={{ margin: 0, color: 'var(--text-main)' }}>{t('settings.replacements')}</div>
                            <button onClick={() => { updateSetting('replacements', [...(settings.replacements || []), { id: Date.now().toString(), active: true, pattern: '', replacement: '', isRegex: false }]); }} className="btn-primary" style={{ padding: '6px 12px' }}>{t('settings.addRule')}</button>
                        </div>
                        {(!settings.replacements || settings.replacements.length === 0) ? (
                            <div style={{ color: 'var(--text-muted)', fontSize: '13px', textAlign: 'center', padding: '20px', border: '1px dashed var(--border-main)', borderRadius: '6px' }}>{t('settings.noRules')}</div>
                        ) : (
                            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                                {settings.replacements.map((rep, idx) => (
                                    <div key={rep.id} style={{ display: 'flex', gap: '10px', alignItems: 'center', background: 'var(--bg-side)', padding: '10px', borderRadius: '6px', border: '1px solid var(--border-main)' }}>
                                        <input type="checkbox" checked={rep.active} onChange={(e) => { const arr = [...settings.replacements]; arr[idx].active = e.target.checked; updateSetting('replacements', arr); }} style={{ cursor: 'pointer', width: '16px', height: '16px', accentColor: 'var(--accent-blue)' }} />
                                        <div style={{ display: 'flex', flex: 1, gap: '8px', alignItems: 'center' }}>
                                            <select className="modern-select" style={{ width: '90px', padding: '6px 8px' }} value={rep.isRegex ? 'regex' : 'text'} onChange={(e) => { const arr = [...settings.replacements]; arr[idx].isRegex = e.target.value === 'regex'; updateSetting('replacements', arr); }}><option value="text">{t('settings.textMode')}</option><option value="regex">Regex</option></select>
                                            <input type="text" className="modern-input" placeholder={t('settings.findPlaceholder')} value={rep.pattern} onChange={(e) => { const arr = [...settings.replacements]; arr[idx].pattern = e.target.value; updateSetting('replacements', arr); }} style={{ padding: '6px 8px' }} />
                                            <span style={{ color: 'var(--text-muted)' }}>→</span>
                                            <input type="text" className="modern-input" placeholder={t('settings.replacePlaceholder')} value={rep.replacement} onChange={(e) => { const arr = [...settings.replacements]; arr[idx].replacement = e.target.value; updateSetting('replacements', arr); }} style={{ padding: '6px 8px' }} />
                                        </div>
                                        <button onClick={() => { updateSetting('replacements', settings.replacements.filter((_, i) => i !== idx)); }} style={{ background: 'rgba(255, 68, 68, 0.1)', color: '#ff4444', border: '1px solid rgba(255, 68, 68, 0.3)', borderRadius: '4px', cursor: 'pointer', width: '26px', height: '26px' }}>✕</button>
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>
                </div>
              )}

              {activeTab === 'sync' && (
                <div className="tab-content-anim">
                  <div id="sync-main" className={`modern-card ${highlightedSection === 'sync-main' ? 'card-highlighted' : ''}`} style={{ background: 'var(--bg-panel)', border: '1px solid var(--border-main)' }}>
                      <div className="card-label" style={{ color: 'var(--text-main)' }}>
                          {settings.appLanguage === 'en' ? 'Setsuna Account Sync' : 'Аккаунт Setsuna'}
                      </div>
                      <div style={{ color: 'var(--text-muted)', fontSize: '12px', lineHeight: 1.5, marginBottom: 14 }}>
                          {settings.appLanguage === 'en'
                              ? 'Sign in on your devices to see which Setsuna instances are online and which can provide screenshots.'
                              : 'Войди на устройствах, чтобы видеть какие Setsuna онлайн и с каких можно сделать скриншот.'}
                      </div>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 18, paddingBottom: 18, borderBottom: '1px solid var(--border-main)' }}>
                          <div style={{ color: 'var(--text-main)', fontSize: 13, fontWeight: 'bold' }}>
                              {settings.appLanguage === 'en' ? 'Account and devices' : 'Аккаунт и устройства'}
                          </div>
                          <div style={{ color: 'var(--text-muted)', fontSize: '12px', lineHeight: 1.45 }}>
                              {settings.appLanguage === 'en' ? 'This device: ' : 'Это устройство: '}
                              <span style={{ color: 'var(--text-main)', fontWeight: 700 }}>
                                  {settings.accountDeviceName?.trim() || (settings.appLanguage === 'en' ? 'detecting Windows name...' : 'определяю имя Windows...')}
                              </span>
                          </div>
                          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                              <label style={{ color: 'var(--text-muted)', fontSize: '12px' }}>
                                  Email
                                  <input
                                      type="email"
                                      className="modern-input"
                                      value={settings.accountEmail || ""}
                                      onChange={(e) => updateSetting('accountEmail', e.target.value)}
                                      placeholder="you@example.com"
                                      style={{ marginTop: 6 }}
                                  />
                              </label>
                              <label style={{ color: 'var(--text-muted)', fontSize: '12px' }}>
                                  {settings.appLanguage === 'en' ? 'Password' : 'Пароль'}
                                  <input
                                      type="password"
                                      className="modern-input"
                                      value={accountPassword}
                                      onChange={(e) => setAccountPassword(e.target.value)}
                                      placeholder={settings.accountAccessToken ? "••••••••" : ""}
                                      style={{ marginTop: 6 }}
                                  />
                              </label>
                          </div>
                          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
                              <button onClick={() => accountAction("login")} disabled={accountBusy} className="btn-primary" style={{ padding: '7px 12px' }}>
                                  {settings.appLanguage === 'en' ? 'Sign in' : 'Войти'}
                              </button>
                              <button onClick={() => accountAction("register")} disabled={accountBusy} className="btn-primary" style={{ padding: '7px 12px' }}>
                                  {settings.appLanguage === 'en' ? 'Create account' : 'Создать аккаунт'}
                              </button>
                              <button onClick={refreshAccountDevices} disabled={accountBusy || !settings.accountAccessToken} className="btn-primary" style={{ padding: '7px 12px' }}>
                                  {settings.appLanguage === 'en' ? 'Refresh devices' : 'Обновить устройства'}
                              </button>
                              {settings.accountAccessToken && (
                                  <button onClick={disconnectAccount} disabled={accountBusy} style={{ background: 'transparent', color: '#ff5555', border: '1px solid rgba(255, 85, 85, 0.35)', borderRadius: 6, padding: '7px 12px', cursor: 'pointer' }}>
                                      {settings.appLanguage === 'en' ? 'Disconnect' : 'Отключить'}
                                  </button>
                              )}
                              <span style={{ color: settings.accountAccessToken ? '#4ade80' : 'var(--text-muted)', fontSize: 12 }}>
                                  {settings.accountAccessToken
                                      ? (settings.appLanguage === 'en' ? 'Connected' : 'Подключено')
                                      : (settings.appLanguage === 'en' ? 'Not signed in' : 'Нет входа')}
                              </span>
                          </div>
                          {accountStatus && (
                              <div style={{ color: 'var(--text-muted)', fontSize: '12px', lineHeight: 1.45 }}>{accountStatus}</div>
                          )}
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                              <div style={{ color: 'var(--text-muted)', fontSize: '12px' }}>
                                  {settings.appLanguage === 'en' ? 'Connected devices' : 'Подключенные устройства'}
                              </div>
                              {accountDevices.length === 0 ? (
                                  <div style={{ color: 'var(--text-muted)', fontSize: '12px', padding: 10, border: '1px dashed var(--border-main)', borderRadius: 6 }}>
                                      {settings.appLanguage === 'en' ? 'No devices loaded yet.' : 'Устройства пока не загружены.'}
                                  </div>
                              ) : (
                                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))', gap: 8 }}>
                                      {accountDevices.map((device, index) => {
                                          const deviceId = device.deviceId || device.id || "";
                                          const isThisDevice = deviceId && deviceId === settings.textSyncDeviceId;
                                          const lastSeen = device.lastSeenAt || device.updatedAt || device.createdAt || "";
                                          const online = isDeviceOnline(lastSeen);
                                          const canCapture = Boolean(device.captureAgentUrl && device.captureAgentToken);
                                          return (
                                              <div key={`${deviceId}-${index}`} style={{ border: '1px solid var(--border-main)', borderRadius: 6, padding: 10, background: 'var(--bg-side)', display: 'flex', flexDirection: 'column', gap: 6 }}>
                                                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'center' }}>
                                                      <div style={{ color: 'var(--text-main)', fontWeight: 700, fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                                          {device.deviceName || device.name || (settings.appLanguage === 'en' ? 'Unnamed device' : 'Без имени')}
                                                      </div>
                                                      <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexShrink: 0 }}>
                                                          <span style={{ color: online ? '#4ade80' : 'var(--text-muted)', fontSize: 11 }}>
                                                              {online ? (settings.appLanguage === 'en' ? 'online' : 'онлайн') : (settings.appLanguage === 'en' ? 'offline' : 'офлайн')}
                                                          </span>
                                                          {isThisDevice && <span style={{ color: '#4ade80', fontSize: 11 }}>{settings.appLanguage === 'en' ? 'this' : 'это'}</span>}
                                                      </div>
                                                  </div>
                                                  <div style={{ color: canCapture ? '#4ade80' : 'var(--text-muted)', fontSize: 11 }}>
                                                      {canCapture
                                                          ? (settings.appLanguage === 'en' ? 'screenshots available' : 'скриншоты доступны')
                                                          : (settings.appLanguage === 'en' ? 'screenshots unavailable' : 'скриншоты недоступны')}
                                                  </div>
                                                  <div style={{ color: 'var(--text-muted)', fontSize: 11, marginTop: 6, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                                      {deviceId || 'unknown-id'}
                                                  </div>
                                                  {lastSeen && (
                                                      <div style={{ color: 'var(--text-muted)', fontSize: 11, marginTop: 4 }}>
                                                          {settings.appLanguage === 'en' ? 'Last seen: ' : 'Был в сети: '}{lastSeen}
                                                      </div>
                                                  )}
                                                  {!isThisDevice && (
                                                      <button
                                                          className="btn-primary"
                                                          disabled={!canCapture}
                                                          onClick={() => useDeviceForScreenshots(device)}
                                                          style={{ padding: '6px 10px', marginTop: 4, opacity: canCapture ? 1 : 0.5 }}
                                                      >
                                                          {settings.appLanguage === 'en' ? 'Use for screenshots' : 'Брать скриншоты'}
                                                      </button>
                                                  )}
                                              </div>
                                          );
                                      })}
                                  </div>
                              )}
                          </div>
                      </div>
                      <details style={{ marginTop: 6 }}>
                          <summary style={{ color: 'var(--text-muted)', fontSize: 12, cursor: 'pointer', marginBottom: 12 }}>
                              {settings.appLanguage === 'en' ? 'Technical sync settings' : 'Технические настройки синхронизации'}
                          </summary>
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 14, borderTop: '1px solid var(--border-main)', paddingTop: 14 }}>
                          <label style={{ color: 'var(--text-muted)', fontSize: '12px', display: 'block' }}>
                              {settings.appLanguage === 'en' ? 'Account server' : 'Сервер аккаунта'}
                              <input
                                  type="text"
                                  className="modern-input"
                                  value={settings.accountApiBaseUrl || ""}
                                  onChange={(e) => updateSetting('accountApiBaseUrl', e.target.value)}
                                  placeholder="https://setsunalookup.ru/api"
                                  style={{ marginTop: 6 }}
                              />
                          </label>
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, borderTop: '1px solid var(--border-main)', paddingTop: 14 }}>
                              <div style={{ color: 'var(--text-main)', fontSize: 13, fontWeight: 'bold' }}>
                                  {settings.appLanguage === 'en' ? 'Screenshot sync' : 'Синхронизация скриншотов'}
                              </div>
                              <div style={{ color: 'var(--text-muted)', fontSize: 12, lineHeight: 1.45 }}>
                                  {settings.appLanguage === 'en'
                                      ? 'Start the agent on the VN device. Signed-in devices will see it in the list above.'
                                      : 'Запусти агент на устройстве с VN. Устройства в аккаунте увидят его в списке выше.'}
                              </div>
                              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                                  <button className="btn-primary" disabled={isCaptureAgentStarting} onClick={captureAgent ? stopCaptureAgent : startCaptureAgent} style={{ padding: '7px 12px' }}>
                                      {captureAgent
                                          ? (settings.appLanguage === 'en' ? 'Stop agent' : 'Остановить агент')
                                          : isCaptureAgentStarting
                                              ? '...'
                                              : (settings.appLanguage === 'en' ? 'Start agent' : 'Запустить агент')}
                                  </button>
                                  {captureAgent && (
                                      <span style={{ color: '#4CAF50', fontSize: 12, userSelect: 'text' }}>{captureAgent.url} · {captureAgent.token}</span>
                                  )}
                              </div>
                              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr auto', gap: 8, alignItems: 'center' }}>
                                  <input className="modern-input" value={settings.remoteCaptureAgentUrl || ""} onChange={(e) => updateSetting("remoteCaptureAgentUrl", e.target.value)} placeholder="http://192.168.1.10:48731" />
                                  <input className="modern-input" value={settings.remoteCaptureAgentToken || ""} onChange={(e) => updateSetting("remoteCaptureAgentToken", e.target.value)} placeholder="Token" />
                                  <button className="btn-primary" disabled={isRemoteCaptureChecking} onClick={checkRemoteCaptureAgent} style={{ padding: '7px 12px', whiteSpace: 'nowrap' }}>
                                      {isRemoteCaptureChecking ? '...' : (settings.appLanguage === 'en' ? 'Check' : 'Проверить')}
                                  </button>
                              </div>
                              {remoteCaptureStatus && <div style={{ color: remoteCaptureStatus.startsWith("Connected") || remoteCaptureStatus.startsWith("Подключено") ? '#4CAF50' : 'var(--text-muted)', fontSize: 12 }}>{remoteCaptureStatus}</div>}
                          </div>
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                          <div style={{ color: 'var(--text-main)', fontSize: 13, fontWeight: 'bold' }}>
                              {settings.appLanguage === 'en' ? 'Legacy text cloud room' : 'Старая облачная комната для текста'}
                          </div>
                          <label className="checkbox-label">
                              <input
                                  type="checkbox"
                                  checked={settings.textSyncCloudEnabled ?? false}
                                  onChange={(e) => updateSetting('textSyncCloudEnabled', e.target.checked)}
                              />
                              {settings.appLanguage === 'en' ? 'Use cloud relay room' : 'Использовать облачную комнату'}
                          </label>
                          <div style={{ display: 'flex', gap: 8 }}>
                              <input
                                  type="text"
                                  className="modern-input"
                                  value={settings.textSyncCloudUrl || ""}
                                  onChange={(e) => updateSetting('textSyncCloudUrl', e.target.value)}
                                  placeholder="https://jsonblob.com/api/jsonBlob/..."
                                  style={{ flex: 1 }}
                              />
                              <button onClick={createCloudSyncRoom} className="btn-primary" style={{ padding: '7px 12px', whiteSpace: 'nowrap' }}>
                                  {settings.appLanguage === 'en' ? 'Create room' : 'Создать комнату'}
                              </button>
                              <button onClick={testCloudSyncRoom} className="btn-primary" style={{ padding: '7px 12px', whiteSpace: 'nowrap' }}>
                                  {settings.appLanguage === 'en' ? 'Test' : 'Проверить'}
                              </button>
                          </div>
                          <div style={{ color: 'var(--text-muted)', fontSize: '12px', lineHeight: 1.45 }}>
                              {settings.appLanguage === 'en'
                                  ? 'Put the same room URL on both PCs. Whoever changes tabs, timer, archive, or text last wins.'
                                  : 'Вставь один и тот же URL комнаты на оба ПК. Кто последним меняет вкладки, таймер, архив или текст, тот и обновляет общее состояние.'}
                          </div>
                          </div>
                      <div style={{ color: 'var(--text-main)', fontSize: 13, fontWeight: 'bold', marginBottom: 12, marginTop: 6 }}>
                          {settings.appLanguage === 'en' ? 'LAN fallback' : 'LAN-режим как запасной вариант'}
                      </div>
                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, borderRight: '1px solid var(--border-main)', paddingRight: 16 }}>
                              <div style={{ color: 'var(--text-main)', fontSize: 13, fontWeight: 'bold' }}>
                                  {settings.appLanguage === 'en' ? 'This device publishes text' : 'Это устройство отдаёт текст'}
                              </div>
                              <label style={{ color: 'var(--text-muted)', fontSize: '12px' }}>
                                  Port
                                  <input
                                      type="number"
                                      min="1"
                                      max="65535"
                                      className="modern-input"
                                      value={settings.textSyncServerPort ?? 48732}
                                      onChange={(e) => updateSetting('textSyncServerPort', Math.max(1, Math.min(65535, Number(e.target.value) || 48732)))}
                                      style={{ marginTop: 6 }}
                                  />
                              </label>
                              <label style={{ color: 'var(--text-muted)', fontSize: '12px' }}>
                                  Token
                                  <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
                                      <input
                                          type="text"
                                          className="modern-input"
                                          value={settings.textSyncServerToken || ""}
                                          onChange={(e) => updateSetting('textSyncServerToken', e.target.value)}
                                          placeholder={settings.appLanguage === 'en' ? 'Fixed token for this Setsuna' : 'Постоянный токен этой Setsuna'}
                                          style={{ flex: 1 }}
                                      />
                                      <button onClick={() => updateSetting('textSyncServerToken', generateToken())} className="btn-primary" style={{ padding: '6px 10px' }}>
                                          {settings.appLanguage === 'en' ? 'Rotate' : 'Сменить'}
                                      </button>
                                  </div>
                              </label>
                              <button
                                  onClick={settings.textSyncServerEnabled ? stopTextSyncServer : startTextSyncServer}
                                  className="btn-primary"
                                  style={{ alignSelf: 'flex-start', padding: '7px 12px' }}
                              >
                                  {settings.textSyncServerEnabled
                                      ? (settings.appLanguage === 'en' ? 'Stop server' : 'Остановить сервер')
                                      : (settings.appLanguage === 'en' ? 'Start server' : 'Запустить сервер')}
                              </button>
                          </div>
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                              <div style={{ color: 'var(--text-main)', fontSize: 13, fontWeight: 'bold' }}>
                                  {settings.appLanguage === 'en' ? 'This device receives text' : 'Это устройство принимает текст'}
                              </div>
                              <label className="checkbox-label">
                                  <input
                                      type="checkbox"
                                      checked={settings.textSyncRemoteEnabled ?? false}
                                      onChange={(e) => updateSetting('textSyncRemoteEnabled', e.target.checked)}
                                  />
                                  {settings.appLanguage === 'en' ? 'Receive lines from another Setsuna' : 'Получать строки с другой Setsuna'}
                              </label>
                              <input
                                  type="text"
                                  className="modern-input"
                                  value={settings.textSyncRemoteUrl || ""}
                                  onChange={(e) => updateSetting('textSyncRemoteUrl', e.target.value)}
                                  placeholder="http://192.168.1.50:48732"
                              />
                              <input
                                  type="text"
                                  className="modern-input"
                                  value={settings.textSyncRemoteToken || ""}
                                  onChange={(e) => updateSetting('textSyncRemoteToken', e.target.value)}
                                  placeholder="Token"
                              />
                              <button onClick={testRemoteTextSync} className="btn-primary" style={{ alignSelf: 'flex-start', padding: '7px 12px' }}>
                                  {settings.appLanguage === 'en' ? 'Test connection' : 'Проверить подключение'}
                              </button>
                          </div>
                      </div>
                          </div>
                      </details>
                      {textSyncStatus && (
                          <div style={{ color: textSyncStatus.startsWith('Connected') || textSyncStatus.startsWith('Подключено') || textSyncStatus.startsWith('Запущено') || textSyncStatus.startsWith('Running') ? '#4CAF50' : 'var(--text-muted)', fontSize: '12px', marginTop: 12, lineHeight: 1.4 }}>
                              {textSyncStatus}
                          </div>
                      )}
                  </div>
                </div>
              )}

              {activeTab === 'jl' && (
                <div className="tab-content-anim">
                    <div id="jl-main" className={`modern-card ${highlightedSection === 'jl-main' ? 'card-highlighted' : ''}`} style={{ background: 'var(--bg-panel)', border: '1px solid var(--border-main)' }}>
                        <div className="card-label" style={{ color: 'var(--text-main)' }}>Setsuna Flow</div>
                        <div style={{ color: 'var(--text-muted)', fontSize: '12px', lineHeight: 1.5, marginBottom: 16 }}>
                            {settings.appLanguage === 'en'
                                ? 'A floating window for the latest hooked line. Move it by the top area, resize from the edges, and look up words by hover or click.'
                                : 'Плавающее окно с последней захуканной строкой. Перетаскивается за верхнюю область, меняет размер за края и открывает лукап по наведению или клику.'}
                        </div>
                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '14px 16px', marginBottom: 16 }}>
                            <label style={{ color: 'var(--text-muted)', fontSize: '12px' }}>
                                {settings.appLanguage === 'en' ? 'Font' : 'Шрифт'}
                                <div style={{ display: 'flex', marginTop: 6 }}>
                                    <FontPicker
                                        english={settings.appLanguage === 'en'}
                                        title={settings.appLanguage === 'en' ? 'Setsuna Flow font' : 'Шрифт Setsuna Flow'}
                                        value={settings.jlModeFontFamily || settings.fontFamily}
                                        onChange={(value) => updateSetting('jlModeFontFamily', value)}
                                        presets={[
                                            { value: "'Noto Serif JP', 'Yu Mincho', 'YuMincho', 'Hiragino Mincho ProN', 'BIZ UDPMincho', 'Meiryo', serif", label: t('wizard.font.serif') },
                                            { value: "'Noto Sans JP', 'Yu Gothic UI', 'Yu Gothic', 'Meiryo', 'BIZ UDPGothic', sans-serif", label: t('wizard.font.sans') },
                                            { value: "'Yu Gothic UI', 'Yu Gothic', 'Meiryo', sans-serif", label: t('wizard.font.yu') },
                                            { value: "'Meiryo', 'Yu Gothic UI', sans-serif", label: t('wizard.font.meiryo') },
                                        ]}
                                        customFont={(settings.customFontData || settings.customFontPath) && settings.customFontFamily
                                            ? { value: `'${settings.customFontFamily}', sans-serif`, label: settings.customFontName || (settings.appLanguage === 'en' ? 'Custom font' : 'Свой шрифт') }
                                            : null}
                                    />
                                </div>
                            </label>
                            <label style={{ color: 'var(--text-muted)', fontSize: '12px' }}>
                                {settings.appLanguage === 'en' ? 'Font size' : 'Размер шрифта'}
                                <input type="number" min="12" max="160" className="modern-input" value={settings.jlModeFontSize ?? 42} onChange={(e) => updateSetting('jlModeFontSize', Math.max(12, Number(e.target.value) || 42))} style={{ marginTop: 6 }} />
                            </label>
                            <label style={{ color: 'var(--text-muted)', fontSize: '12px' }}>
                                <span style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
                                    <span>{settings.appLanguage === 'en' ? 'Window opacity' : 'Прозрачность окна'}</span>
                                    <strong style={{ color: 'var(--text-main)' }}>{settings.jlModeOpacity ?? 72}%</strong>
                                </span>
                                <input type="range" min="5" max="100" value={settings.jlModeOpacity ?? 72} onChange={(e) => updateSetting('jlModeOpacity', Number(e.target.value))} style={{ marginTop: 10, width: '100%' }} />
                            </label>
                            <label style={{ color: 'var(--text-muted)', fontSize: '12px' }}>
                                {settings.appLanguage === 'en' ? 'Padding' : 'Отступ текста'}
                                <input type="number" min="4" max="80" className="modern-input" value={settings.jlModePadding ?? 18} onChange={(e) => updateSetting('jlModePadding', Math.max(4, Number(e.target.value) || 18))} style={{ marginTop: 6 }} />
                            </label>
                            <label style={{ color: 'var(--text-muted)', fontSize: '12px' }}>
                                {settings.appLanguage === 'en' ? 'Text color' : 'Цвет текста'}
                                <input type="color" value={settings.jlModeTextColor || '#f4f4f4'} onChange={(e) => updateSetting('jlModeTextColor', e.target.value)} style={{ display: 'block', marginTop: 6, width: '100%', height: 36, background: 'transparent', border: '1px solid var(--border-main)', borderRadius: 6 }} />
                            </label>
                            <label style={{ color: 'var(--text-muted)', fontSize: '12px' }}>
                                {settings.appLanguage === 'en' ? 'Background' : 'Фон'}
                                <input type="color" value={settings.jlModeBackgroundColor || '#050505'} onChange={(e) => updateSetting('jlModeBackgroundColor', e.target.value)} style={{ display: 'block', marginTop: 6, width: '100%', height: 36, background: 'transparent', border: '1px solid var(--border-main)', borderRadius: 6 }} />
                            </label>
                        </div>
                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: '12px 16px', marginBottom: 16 }}>
                            <label style={{ color: 'var(--text-muted)', fontSize: '12px' }}>
                                {settings.appLanguage === 'en' ? 'Lookup' : 'Лукап'}
                                <select className="modern-select" value={settings.jlModeLookupMode || 'scan'} onChange={(e) => updateSetting('jlModeLookupMode', e.target.value as 'scan' | 'click')} style={{ marginTop: 6 }}>
                                    <option value="scan">{settings.appLanguage === 'en' ? 'Hover scan (like Shift)' : 'Наведение (как Shift-скан)'}</option>
                                    <option value="click">{settings.appLanguage === 'en' ? 'Click on a word' : 'Клик по слову'}</option>
                                </select>
                            </label>
                            <label style={{ color: 'var(--text-muted)', fontSize: '12px' }}>
                                {settings.appLanguage === 'en' ? 'Scan delay, ms' : 'Задержка скана, мс'}
                                <input type="number" min="0" max="1000" className="modern-input" value={settings.jlModeScanDelay ?? 200} onChange={(e) => updateSetting('jlModeScanDelay', Math.max(0, Math.min(1000, Number(e.target.value) || 0)))} style={{ marginTop: 6 }} />
                            </label>
                            <label style={{ color: 'var(--text-muted)', fontSize: '12px' }}>
                                {settings.appLanguage === 'en' ? 'Backlog capacity' : 'Строк в истории'}
                                <input type="number" min="20" max="5000" className="modern-input" value={settings.jlModeBacklogCapacity ?? 300} onChange={(e) => updateSetting('jlModeBacklogCapacity', Math.max(20, Math.min(5000, Number(e.target.value) || 300)))} style={{ marginTop: 6 }} />
                            </label>
                        </div>
                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 14 }}>
                            <label className="checkbox-label"><input type="checkbox" checked={settings.jlModeAlwaysOnTop ?? true} onChange={(e) => updateSetting('jlModeAlwaysOnTop', e.target.checked)} /> {settings.appLanguage === 'en' ? 'Always on top' : 'Поверх всех окон'}</label>
                            <label className="checkbox-label"><input type="checkbox" checked={settings.jlModeShowControls ?? true} onChange={(e) => updateSetting('jlModeShowControls', e.target.checked)} /> {settings.appLanguage === 'en' ? 'Show controls' : 'Показывать управление'}</label>
                            <label className="checkbox-label"><input type="checkbox" checked={settings.jlModeHideLookupOnNewText ?? true} onChange={(e) => updateSetting('jlModeHideLookupOnNewText', e.target.checked)} /> {settings.appLanguage === 'en' ? 'Hide lookup on new text' : 'Закрывать лукап при новой строке'}</label>
                            <label className="checkbox-label"><input type="checkbox" checked={settings.jlModeAutoLookupFirstWord ?? false} onChange={(e) => updateSetting('jlModeAutoLookupFirstWord', e.target.checked)} /> {settings.appLanguage === 'en' ? 'Lookup the first word automatically' : 'Автоматически лукапить первое слово'}</label>
                        </div>
                    </div>
                </div>
              )}

              {activeTab === 'ai' && (
                <SettingsAI settings={settings} updateSetting={updateSetting} highlighted={highlightedSection === 'ai-main'} />
              )}

              {/* === EPUB TAB === */}
              {activeTab === 'epub' && (
                <div className="tab-content-anim">
                    <div id="epub-reader" className={`modern-card ${highlightedSection === 'epub-reader' ? 'card-highlighted' : ''}`} style={{ background: 'var(--bg-panel)', border: '1px solid var(--border-main)' }}>
                        <div className="card-label" style={{ color: 'var(--text-main)' }}>{settings.appLanguage === 'en' ? 'EPUB reading view' : 'Вид EPUB-читалки'}</div>
                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px 16px', marginBottom: 16 }}>
                            <label style={{ color: 'var(--text-muted)', fontSize: '12px' }}>
                                {settings.appLanguage === 'en' ? 'Theme' : 'Тема'}
                                <select className="modern-select" value={settings.epubTheme || 'app'} onChange={(e) => updateSetting('epubTheme', e.target.value as any)} style={{ marginTop: 6 }}>
                                    <option value="app">{settings.appLanguage === 'en' ? 'Use app theme' : 'Как в приложении'}</option>
                                    <option value="dark">{settings.appLanguage === 'en' ? 'Dark reader' : 'Тёмная читалка'}</option>
                                    <option value="paper">{settings.appLanguage === 'en' ? 'Paper' : 'Бумага'}</option>
                                    <option value="sepia">{settings.appLanguage === 'en' ? 'Sepia' : 'Сепия'}</option>
                                </select>
                            </label>
                            <label style={{ color: 'var(--text-muted)', fontSize: '12px' }}>
                                {settings.appLanguage === 'en' ? 'Reading mode' : 'Режим чтения'}
                                <select className="modern-select" value={settings.epubReadingMode || 'paged'} onChange={(e) => updateSetting('epubReadingMode', e.target.value as any)} style={{ marginTop: 6 }}>
                                    <option value="paged">{settings.appLanguage === 'en' ? 'Pages' : 'Страницы'}</option>
                                    <option value="scroll">{settings.appLanguage === 'en' ? 'Continuous scroll' : 'Непрерывный скролл'}</option>
                                </select>
                            </label>
                            <label style={{ color: 'var(--text-muted)', fontSize: '12px' }}>
                                {settings.appLanguage === 'en' ? 'Text direction' : 'Направление текста'}
                                <select className="modern-select" value={settings.epubTextOrientation || 'auto'} onChange={(e) => updateSetting('epubTextOrientation', e.target.value as any)} style={{ marginTop: 6 }}>
                                    <option value="auto">{settings.appLanguage === 'en' ? 'Auto (book default)' : 'Авто (как в книге)'}</option>
                                    <option value="horizontal">{settings.appLanguage === 'en' ? 'Horizontal' : 'Горизонтально'}</option>
                                    <option value="vertical">{settings.appLanguage === 'en' ? 'Vertical right-to-left' : 'Вертикально справа налево'}</option>
                                </select>
                                <span style={{ display: 'block', marginTop: 4, fontSize: '11px', opacity: 0.78 }}>
                                    {settings.appLanguage === 'en'
                                        ? 'Applies to Japanese books; English books always stay horizontal.'
                                        : 'Применяется к японским книгам; английские всегда горизонтальные.'}
                                </span>
                            </label>
                            <div style={{ color: 'var(--text-muted)', fontSize: '12px' }}>
                                <span>{settings.appLanguage === 'en' ? 'Font' : 'Шрифт'}</span>
                                <div style={{ display: 'flex', marginTop: 6 }}>
                                    <FontPicker
                                        english={settings.appLanguage === 'en'}
                                        title={settings.appLanguage === 'en' ? 'EPUB reader font' : 'Шрифт читалки'}
                                        value={settings.epubFontFamily || settings.fontFamily}
                                        onChange={(value) => updateSetting('epubFontFamily', value)}
                                        defaultFilter="all"
                                        showLatinFilter
                                        sampleText="あの日見た花の名前を、僕達はまだ知らない。"
                                        latinSampleText="Down the rabbit-hole went Alice, never once considering how to get out again."
                                        presets={buildEpubFontPresets({
                                            serif: t('wizard.font.serif'),
                                            sans: t('wizard.font.sans'),
                                            yu: t('wizard.font.yu'),
                                            meiryo: t('wizard.font.meiryo'),
                                            english: settings.appLanguage === 'en',
                                        })}
                                        customFont={(settings.customFontData || settings.customFontPath) && settings.customFontFamily
                                            ? {
                                                value: `'${settings.customFontFamily}', sans-serif`,
                                                label: settings.customFontName || (settings.appLanguage === 'en' ? 'Custom font' : 'Свой шрифт'),
                                                hint: settings.appLanguage === 'en' ? 'Font file' : 'Файл шрифта',
                                            }
                                            : null}
                                        onPickFile={() => void handleCustomFontPick()}
                                    />
                                </div>
                            </div>
                            <button className="btn-primary" onClick={() => onSettingsChange({ ...settings, epubFontFamily: settings.fontFamily, epubFontSize: settings.fontSize, epubTextOrientation: settings.textOrientation })} style={{ alignSelf: 'end', padding: '8px 10px', fontSize: '12px' }}>
                                {settings.appLanguage === 'en' ? 'Copy text-hooker look' : 'Скопировать вид текстхукера'}
                            </button>
                        </div>
                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px 16px' }}>
                            <label style={{ color: 'var(--text-muted)', fontSize: '12px' }}>{settings.appLanguage === 'en' ? 'Font size' : 'Размер шрифта'}<input type="number" min="12" max="72" className="modern-input" value={settings.epubFontSize ?? 21} onChange={(e) => updateSetting('epubFontSize', Number(e.target.value))} style={{ marginTop: 6 }} /></label>
                            <label style={{ color: 'var(--text-muted)', fontSize: '12px' }}>{settings.appLanguage === 'en' ? 'Line height' : 'Высота строки'}<input type="number" min="1.1" max="3" step="0.05" className="modern-input" value={settings.epubLineHeight ?? 1.65} onChange={(e) => updateSetting('epubLineHeight', Number(e.target.value))} style={{ marginTop: 6 }} /></label>
                            <label style={{ color: 'var(--text-muted)', fontSize: '12px' }}>{settings.appLanguage === 'en' ? 'Paragraph gap' : 'Отступ абзацев'}<input type="number" min="0" max="80" className="modern-input" value={settings.epubParagraphSpacing ?? 14} onChange={(e) => updateSetting('epubParagraphSpacing', Number(e.target.value))} style={{ marginTop: 6 }} /></label>
                            <label style={{ color: 'var(--text-muted)', fontSize: '12px' }}>{settings.appLanguage === 'en' ? 'Page padding' : 'Поля страницы'}<input type="number" min="0" max="120" className="modern-input" value={settings.epubPagePadding ?? 24} onChange={(e) => updateSetting('epubPagePadding', Number(e.target.value))} style={{ marginTop: 6 }} /></label>
                        </div>
                    </div>

                    <div id="epub-layout" className={`modern-card ${highlightedSection === 'epub-layout' ? 'card-highlighted' : ''}`} style={{ background: 'var(--bg-panel)', border: '1px solid var(--border-main)' }}>
                        <div className="card-label" style={{ color: 'var(--text-main)' }}>{settings.appLanguage === 'en' ? 'Page layout and images' : 'Раскладка и картинки'}</div>
                        <label className="checkbox-label" style={{ marginBottom: 10 }}><input type="checkbox" checked={settings.epubShowImages ?? true} onChange={(e) => updateSetting('epubShowImages', e.target.checked)} /> {settings.appLanguage === 'en' ? 'Show EPUB images' : 'Показывать картинки из EPUB'}</label>
                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px 16px', marginBottom: 14 }}>
                            <label style={{ color: 'var(--text-muted)', fontSize: '12px' }}>
                                {settings.appLanguage === 'en' ? 'Blur illustrations (spoiler-safe)' : 'Блюр иллюстраций (без спойлеров)'}
                                <select
                                    className="modern-select"
                                    value={settings.epubBlurImagesMode || (settings.epubBlurImages ? 'all' : 'off')}
                                    onChange={(e) => {
                                        const mode = e.target.value as 'off' | 'after-toc' | 'all';
                                        onSettingsChange({ ...settings, epubBlurImagesMode: mode, epubBlurImages: mode !== 'off' });
                                    }}
                                    style={{ marginTop: 6 }}
                                >
                                    <option value="off">{settings.appLanguage === 'en' ? 'Off' : 'Выкл'}</option>
                                    <option value="after-toc">{settings.appLanguage === 'en' ? 'After ToC (keep cover clear)' : 'После оглавления (обложка без блюра)'}</option>
                                    <option value="all">{settings.appLanguage === 'en' ? 'All illustrations' : 'Все иллюстрации'}</option>
                                </select>
                            </label>
                            <label style={{ color: 'var(--text-muted)', fontSize: '12px' }}>
                                {settings.appLanguage === 'en' ? 'Furigana' : 'Фуригана'}
                                <select className="modern-select" value={settings.epubFuriganaMode || 'show'} onChange={(e) => updateSetting('epubFuriganaMode', e.target.value as any)} style={{ marginTop: 6 }}>
                                    <option value="show">{settings.appLanguage === 'en' ? 'Show' : 'Показать'}</option>
                                    <option value="hover">{settings.appLanguage === 'en' ? 'Show on hover' : 'По наведению'}</option>
                                    <option value="hide">{settings.appLanguage === 'en' ? 'Hide' : 'Скрыть'}</option>
                                </select>
                            </label>
                            <label style={{ color: 'var(--text-muted)', fontSize: '12px' }}>
                                {settings.appLanguage === 'en' ? 'Paragraph indent' : 'Красная строка'}
                                <select className="modern-select" value={settings.epubTextIndent || 'auto'} onChange={(e) => updateSetting('epubTextIndent', e.target.value as any)} style={{ marginTop: 6 }}>
                                    <option value="auto">{settings.appLanguage === 'en' ? 'Auto' : 'Авто'}</option>
                                    <option value="none">{settings.appLanguage === 'en' ? 'None' : 'Нет'}</option>
                                    <option value="indent">{settings.appLanguage === 'en' ? '1em indent' : 'Отступ 1em'}</option>
                                </select>
                            </label>
                            <label style={{ color: 'var(--text-muted)', fontSize: '12px' }}>
                                {settings.appLanguage === 'en' ? 'Autoscroll speed (px/s)' : 'Скорость автоскролла (px/с)'}
                                <input type="number" min="10" max="200" step="2" className="modern-input" value={settings.epubAutoscrollSpeed ?? 38} onChange={(e) => updateSetting('epubAutoscrollSpeed', Number(e.target.value))} style={{ marginTop: 6 }} />
                            </label>
                        </div>
                        <label className="checkbox-label" style={{ marginBottom: 8 }}><input type="checkbox" checked={settings.epubJustify ?? false} onChange={(e) => updateSetting('epubJustify', e.target.checked)} /> {settings.appLanguage === 'en' ? 'Justify text' : 'Выравнивание текста по ширине'}</label>
                        <label className="checkbox-label" style={{ marginBottom: 8 }}><input type="checkbox" checked={settings.epubPrettyWrap ?? true} onChange={(e) => updateSetting('epubPrettyWrap', e.target.checked)} /> {settings.appLanguage === 'en' ? 'Pretty text wrap' : 'Аккуратный перенос строк'}</label>
                        <label className="checkbox-label" style={{ marginBottom: 8 }}><input type="checkbox" checked={settings.epubVerticalGrid ?? false} onChange={(e) => updateSetting('epubVerticalGrid', e.target.checked)} /> {settings.appLanguage === 'en' ? 'Strict vertical column grid (Japanese)' : 'Строгая сетка колонок в вертикальном режиме'}</label>
                        <label className="checkbox-label" style={{ marginBottom: 8 }}><input type="checkbox" checked={settings.epubAutoSync ?? true} onChange={(e) => updateSetting('epubAutoSync', e.target.checked)} /> {settings.appLanguage === 'en' ? 'Auto-sync EPUB reading progress, bookmarks & notes via Google Drive' : 'Автосинхронизация прогресса, закладок и заметок EPUB через Google Drive'}</label>
                        <label className="checkbox-label" style={{ marginBottom: 8 }}><input type="checkbox" checked={settings.epubSyncUploadFiles ?? true} onChange={(e) => updateSetting('epubSyncUploadFiles', e.target.checked)} /> {settings.appLanguage === 'en' ? 'Also upload book files (.epub) to Google Drive for other devices' : 'Также загружать файлы книг (.epub) в Google Drive для других устройств'}</label>
                        <label className="checkbox-label" style={{ marginBottom: 8 }}><input type="checkbox" checked={settings.epubEinkMode ?? false} onChange={(e) => updateSetting('epubEinkMode', e.target.checked)} /> {settings.appLanguage === 'en' ? 'E-Ink high-contrast mode (pure white, no animations)' : 'Режим E-Ink (максимальный контраст, без анимаций)'}</label>
                        <label className="checkbox-label" style={{ marginBottom: 14 }}><input type="checkbox" checked={settings.epubVolumeKeyPaging ?? true} onChange={(e) => updateSetting('epubVolumeKeyPaging', e.target.checked)} /> {settings.appLanguage === 'en' ? 'Turn pages with hardware volume keys (Android)' : 'Листать страницы кнопками громкости (Android)'}</label>
                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px 16px' }}>
                            <label style={{ color: 'var(--text-muted)', fontSize: '12px' }}>{settings.appLanguage === 'en' ? 'Text column width' : 'Ширина текста'}<input type="number" min="420" max="1400" className="modern-input" value={settings.epubMaxWidth ?? 1040} onChange={(e) => updateSetting('epubMaxWidth', Number(e.target.value))} style={{ marginTop: 6 }} /></label>
                            <label style={{ color: 'var(--text-muted)', fontSize: '12px' }}>{settings.appLanguage === 'en' ? 'Image max width' : 'Макс. ширина картинки'}<input type="number" min="240" max="1400" className="modern-input" value={settings.epubImageMaxWidth ?? 720} onChange={(e) => updateSetting('epubImageMaxWidth', Number(e.target.value))} style={{ marginTop: 6 }} /></label>
                        </div>
                    </div>
                </div>
              )}

              {/* === PLAYER TAB === */}
              {activeTab === 'player' && (
                <div className="tab-content-anim">
                    <div id="player-main" className={`modern-card ${highlightedSection === 'player-main' ? 'card-highlighted' : ''}`} style={{ background: 'var(--bg-panel)', border: '1px solid var(--border-main)' }}>
                        <div className="card-label" style={{ color: 'var(--text-main)' }}>{settings.appLanguage === 'en' ? 'Playback' : 'Воспроизведение'}</div>
                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '15px' }}>
                            <label style={{ color: 'var(--text-muted)', fontSize: '12px' }}>
                                {settings.appLanguage === 'en' ? 'Seek step, seconds' : 'Шаг перемотки, секунды'}
                                <input type="number" min="0.25" max="30" step="0.25" className="modern-input" value={settings.playerRewindSeconds ?? 2} onChange={(e) => updateSetting('playerRewindSeconds', Number(e.target.value))} style={{ marginTop: 6 }} />
                            </label>
                            <label style={{ color: 'var(--text-muted)', fontSize: '12px' }}>
                                {settings.appLanguage === 'en' ? 'Subtitle offset step' : 'Шаг сдвига субтитров'}
                                <input type="number" min="0.05" max="2" step="0.05" className="modern-input" value={settings.playerSubtitleStep ?? 0.1} onChange={(e) => updateSetting('playerSubtitleStep', Number(e.target.value))} style={{ marginTop: 6 }} />
                            </label>
                        </div>
                    </div>

                    <div id="player-mining" className={`modern-card ${highlightedSection === 'player-mining' ? 'card-highlighted' : ''}`} style={{ background: 'var(--bg-panel)', border: '1px solid var(--border-main)' }}>
                        <div className="card-label" style={{ color: 'var(--text-main)' }}>{settings.appLanguage === 'en' ? 'Player card mining' : 'Майнинг карточек из плеера'}</div>
                        <label className="checkbox-label" style={{ marginBottom: '12px' }}><input type="checkbox" checked={settings.playerMiningReplayOnMine ?? true} onChange={(e) => updateSetting('playerMiningReplayOnMine', e.target.checked)} /> {settings.appLanguage === 'en' ? 'Replay the mined subtitle segment' : 'Переигрывать замайненный отрезок по субтитрам'}</label>
                        <label className="checkbox-label" style={{ marginBottom: '12px' }}><input type="checkbox" checked={settings.playerMiningUseClipForAnki ?? true} onChange={(e) => updateSetting('playerMiningUseClipForAnki', e.target.checked)} /> {settings.appLanguage === 'en' ? 'Attach the subtitle scene to Anki' : 'Прикладывать сцену из реплики к карточке Anki'}</label>
                        <label className="checkbox-label">{settings.appLanguage === 'en' ? 'Attachment' : 'Вложение'}
                            <select className="modern-input" value={settings.playerCardFormat ?? 'video'} onChange={e => updateSetting('playerCardFormat', e.target.value as 'audio' | 'video')}>
                                <option value="video">{settings.appLanguage === 'en' ? 'Video with original audio' : 'Видео с оригинальным звуком'}</option>
                                <option value="audio">{settings.appLanguage === 'en' ? 'Original audio only' : 'Только оригинальный звук'}</option>
                            </select>
                        </label>
                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '15px' }}>
                            <label style={{ color: 'var(--text-muted)', fontSize: '12px' }}>
                                {settings.appLanguage === 'en' ? 'Lead-in before subtitle' : 'Запас до реплики'}
                                <input type="number" min="0" max="30" step="0.05" className="modern-input" value={settings.playerCardFormat === 'audio' ? settings.playerMiningLeadIn : settings.playerSceneLeadIn ?? 5} onChange={(e) => updateSetting(settings.playerCardFormat === 'audio' ? 'playerMiningLeadIn' : 'playerSceneLeadIn', Math.min(30, Math.max(0, Number(e.target.value))))} style={{ marginTop: 6 }} />
                            </label>
                            <label style={{ color: 'var(--text-muted)', fontSize: '12px' }}>
                                {settings.appLanguage === 'en' ? 'Lead-out after subtitle' : 'Запас после реплики'}
                                <input type="number" min="0" max="3" step="0.05" className="modern-input" value={settings.playerMiningLeadOut ?? 0.25} onChange={(e) => updateSetting('playerMiningLeadOut', Number(e.target.value))} style={{ marginTop: 6 }} />
                            </label>
                        </div>
                        <div style={{ color: 'var(--text-muted)', fontSize: '12px', marginTop: 12 }}>
                            {settings.appLanguage === 'en' ? 'FFmpeg exports the clip. Set the lead-in in seconds to include the scene before the line.' : 'Для экспорта нужен FFmpeg. Запас до реплики задаётся в секундах и попадает в карточку вместе с репликой.'}
                        </div>
                    </div>

                    <div id="player-binds" className={`modern-card ${highlightedSection === 'player-binds' ? 'card-highlighted' : ''}`} style={{ background: 'var(--bg-panel)', border: '1px solid var(--border-main)' }}>
                        <div className="card-label" style={{ color: 'var(--text-main)' }}>{settings.appLanguage === 'en' ? 'Keybinds' : 'Бинды'}</div>
                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px 15px' }}>
                            {[
                                ['playerKeyPlayPause', settings.appLanguage === 'en' ? 'Play / pause' : 'Пауза / старт'],
                                ['playerKeyBack', settings.appLanguage === 'en' ? 'Back' : 'Назад'],
                                ['playerKeyForward', settings.appLanguage === 'en' ? 'Forward' : 'Вперёд'],
                                ['playerKeyMine', settings.appLanguage === 'en' ? 'Mine clip' : 'Майнить клип'],
                                ['playerKeyOffsetMinus', settings.appLanguage === 'en' ? 'Subs later' : 'Субтитры позже'],
                                ['playerKeyOffsetPlus', settings.appLanguage === 'en' ? 'Subs earlier' : 'Субтитры раньше'],
                            ].map(([key, label]) => (
                                <label key={key} style={{ color: 'var(--text-muted)', fontSize: '12px' }}>
                                    {label}
                                    <input type="text" className="modern-input" value={(settings as any)[key] || ''} onChange={(e) => updateSetting(key as keyof AppSettings, e.target.value as any)} style={{ marginTop: 6 }} />
                                </label>
                            ))}
                        </div>
                    </div>
                </div>
              )}

              {/* === LOOKUP TAB === */}
              {activeTab === 'lookup' && (
                  <SettingsLookup
                      settings={settings}
                      updateSetting={updateSetting}
                      highlightedSection={highlightedSection}
                      isOpen={activeTab === 'lookup' && isOpen}
                      syncDictionaries={syncDictionaries}
                      runDictImport={runDictImport}
                      setConfirmDialog={setConfirmDialog}
                  />
              )}

              {/* === ANKI TAB === */}
              {activeTab === 'anki' && (
                  <SettingsAnki 
                      settings={settings} 
                      updateSetting={updateSetting} 
                      updateMultipleSettings={updateMultipleSettings}
                      highlightedSection={highlightedSection} 
                      isOpen={activeTab === 'anki' && isOpen} 
                  />
              )}

              {/* === CLOUD TAB === */}
              {activeTab === 'cloud' && (
                  <SettingsCloud
                      settings={settings}
                      updateSetting={updateSetting}
                      onSettingsChange={onSettingsChange}
                      tabs={tabs}
                      setTabs={setTabs}
                      syncDictionaries={syncDictionaries}
                      highlightedSection={highlightedSection}
                      isOpen={activeTab === 'cloud' && isOpen}
                  />
              )}

              {/* === DISCORD TAB === */}
              {activeTab === 'discord' && (
                <div className="tab-content-anim" id="discord-main">
                    <SettingsDiscord settings={settings} tabs={tabs} updateSetting={updateSetting} />
                </div>
              )}

              {activeTab === 'feedback' && <SettingsFeedback english={isEnglish} />}
              {activeTab === 'updates' && (
                <div className="tab-content-anim">
                    <div id="updates-main" className={`modern-card ${highlightedSection === 'updates-main' ? 'card-highlighted' : ''}`} style={{ background: 'var(--bg-panel)', border: '1px solid var(--border-main)' }}>
                        <div className="card-label" style={{ color: 'var(--text-main)' }}>{settings.appLanguage === 'en' ? 'Updates' : 'Обновления'}</div>
                        <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 14 }}>
                            <span style={{ color: 'var(--text-muted)', fontSize: 13 }}>{settings.appLanguage === 'en' ? 'Current version' : 'Текущая версия'}</span>
                            <span style={{ color: 'var(--text-main)', fontWeight: 700 }}>{appVersionLabel()}</span>
                        </div>
                        <label className="checkbox-label" style={{ marginBottom: 14 }}>
                            <input type="checkbox" checked={settings.updateAutoCheck ?? true} onChange={(e) => updateSetting('updateAutoCheck', e.target.checked)} />
                            {settings.appLanguage === 'en' ? 'Check for updates on startup' : 'Проверять обновления при запуске'}
                        </label>
                        <button className="btn-primary" disabled={updateChecking} onClick={() => onCheckForUpdates?.(true)} style={{ padding: '8px 14px', opacity: updateChecking ? 0.7 : 1 }}>
                            {updateChecking
                                ? (settings.appLanguage === 'en' ? 'Checking...' : 'Проверяю...')
                                : (settings.appLanguage === 'en' ? 'Check now' : 'Проверить сейчас')}
                        </button>
                    </div>
                </div>
              )}

              </div>
            </main>
          </div>
        </div>
      </div>

      {/* CONFIRM MODAL */}
      {confirmDialog && (
          <div className="modal-overlay" style={{ zIndex: 100000, position: 'fixed', top: 0, left: 0, width: '100vw', height: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }} onClick={() => setConfirmDialog(null)}>
              <div className="modern-modal" onClick={e => e.stopPropagation()} style={{ width: '400px', height: 'auto', minHeight: 'auto', padding: '25px', textAlign: 'center', display: 'block', background: 'var(--bg-panel)', border: '1px solid var(--border-main)', borderRadius: '8px' }}>
                  <h3 style={{ marginTop: 0, color: 'var(--text-main)', fontSize: '18px', fontWeight: 600 }}>{confirmDialog.title}</h3>
                  <p style={{ color: 'var(--text-muted)', marginBottom: '25px', lineHeight: '1.5', fontSize: '14px' }}>{confirmDialog.message}</p>
                  <div style={{ display: 'flex', gap: '10px', justifyContent: 'center' }}>
                      <button className="btn-primary btn-secondary" style={{ padding: '8px 20px' }} onClick={() => setConfirmDialog(null)}>{t('common.cancel')}</button>
                      <button className="btn-primary btn-danger" style={{ padding: '8px 20px' }} onClick={() => { confirmDialog.onConfirm(); setConfirmDialog(null); }}>{t('common.confirm')}</button>
                  </div>
              </div>
          </div>
      )}

      {/* RESET MODAL */}
      {resetDialog && (
          <div className="modal-overlay" style={{ zIndex: 100000, display: 'flex', alignItems: 'center', justifyContent: 'center' }} onClick={() => setResetDialog(false)}>
              <div className="modern-modal" onClick={e => e.stopPropagation()} style={{ width: '400px', padding: '25px', textAlign: 'center', background: 'var(--bg-panel)', border: '1px solid var(--border-main)', borderRadius: '8px' }}>
                  <h3 style={{ marginTop: 0, color: 'var(--text-main)' }}>{t('settings.reset')}</h3>
                  <p style={{ color: 'var(--text-muted)', marginBottom: '20px', fontSize: '14px' }}>{t('settings.resetQuestion')}</p>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                      <button className="btn-primary btn-secondary" onClick={handleResetVisuals}>{t('settings.resetVisuals')}</button>
                      <button className="btn-primary btn-danger" onClick={handleResetAll}>{t('settings.resetAll')}</button>
                      <button className="btn-primary" style={{ background: 'transparent', color: 'var(--text-muted)', border: 'none', marginTop: '10px' }} onClick={() => setResetDialog(false)}>{t('common.cancel')}</button>
                  </div>
              </div>
          </div>
      )}

    </>
  );
}
