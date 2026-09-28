import { isMobilePlatform } from './platform';

const WORK_IN_PROGRESS_AVAILABLE = import.meta.env.DEV;

// Desktop WebView integration; phone builds do not register its native commands.
export const YATSU_READER_AVAILABLE = import.meta.env.VITE_PRIVATE_READER === '1' && typeof navigator !== 'undefined' && !isMobilePlatform();
export const EPUB_READER_AVAILABLE = YATSU_READER_AVAILABLE || WORK_IN_PROGRESS_AVAILABLE;
export const ANIME_PLAYER_AVAILABLE = WORK_IN_PROGRESS_AVAILABLE;
export const GOOGLE_DRIVE_AVAILABLE = true;
