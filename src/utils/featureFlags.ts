import { isMobilePlatform } from './platform';


// Desktop WebView integration; phone builds do not register its native commands.
export const YATSU_READER_AVAILABLE = import.meta.env.VITE_PRIVATE_READER === '1' && typeof navigator !== 'undefined' && !isMobilePlatform();
export const EPUB_READER_AVAILABLE = true;
export const ANIME_PLAYER_AVAILABLE = true;
export const GOOGLE_DRIVE_AVAILABLE = true;
