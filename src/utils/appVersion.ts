import releaseInfo from "../release-info.json";
import { isMobilePlatform } from "./platform";

/** Human-readable version: the desktop and Android builds have separate lines. */
export const appVersionLabel = () => {
    const info = releaseInfo as { displayVersion: string; desktopLabel?: string; mobileLabel?: string };
    if (isMobilePlatform()) return info.mobileLabel || info.displayVersion;
    return info.desktopLabel || info.displayVersion;
};
