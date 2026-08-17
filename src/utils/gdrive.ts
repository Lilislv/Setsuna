import { invoke } from '@tauri-apps/api/core';
import { fetch } from '@tauri-apps/plugin-http';

const CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID || '';
const SCOPE = 'https://www.googleapis.com/auth/drive.appdata';
const DEFAULT_REDIRECT_URI = 'http://127.0.0.1:1337';
const BACKUP_PREFIX = 'setsuna_backup_';
const LEGACY_BACKUP_PREFIX = 'txthk_backup_';

export interface GooglePkceSession {
    verifier: string;
    challenge: string;
    state: string;
}

export interface DriveFileInfo {
    id: string;
    name: string;
    createdTime?: string;
    modifiedTime?: string;
    size?: string;
    md5Checksum?: string;
    appProperties?: Record<string, string>;
}

export interface DriveQuotaInfo {
    limit: string | null;
    usage: string;
    usageInDrive: string;
    usageInDriveTrash: string;
    maxUploadSize: string | null;
    unlimited: boolean;
}

const ensureGoogleConfig = () => {
    if (!CLIENT_ID) {
        throw new Error('Google OAuth is not configured. Check VITE_GOOGLE_CLIENT_ID.');
    }
};

const parseGoogleJson = async (res: Response, context: string) => {
    const text = await res.text();
    let data: any = {};
    if (text) {
        try {
            data = JSON.parse(text);
        } catch {
            data = { raw: text };
        }
    }
    if (!res.ok || data.error) {
        const details = data.error_description || data.error?.message || data.error || data.raw || `${res.status}`;
        throw new Error(`${context}: ${details}`);
    }
    return data;
};

const escapeDriveQueryString = (value: string) => value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");

const randomBase64Url = (byteLength: number) => {
    const bytes = new Uint8Array(byteLength);
    crypto.getRandomValues(bytes);
    let raw = '';
    bytes.forEach((byte) => { raw += String.fromCharCode(byte); });
    return btoa(raw).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
};

const sha256Base64Url = async (value: string) => {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
    let raw = '';
    new Uint8Array(digest).forEach((byte) => { raw += String.fromCharCode(byte); });
    return btoa(raw).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
};

export async function createGooglePkceSession(): Promise<GooglePkceSession> {
    const verifier = randomBase64Url(64);
    return {
        verifier,
        challenge: await sha256Base64Url(verifier),
        state: randomBase64Url(32),
    };
}

const callbackData = (codeOrUrl: string, fallbackRedirectUri = DEFAULT_REDIRECT_URI) => {
    const value = codeOrUrl.trim();
    if (!value) return { code: '', redirectUri: fallbackRedirectUri, state: '' };
    if (!value.startsWith('http')) return { code: value, redirectUri: fallbackRedirectUri, state: '' };

    const url = new URL(value);
    const error = url.searchParams.get('error');
    if (error) throw new Error(url.searchParams.get('error_description') || error);
    return {
        code: url.searchParams.get('code') || '',
        state: url.searchParams.get('state') || '',
        redirectUri: `${url.protocol}//${url.host}`,
    };
};

export function getAuthUrl(redirectUri = DEFAULT_REDIRECT_URI, pkce?: Pick<GooglePkceSession, 'challenge' | 'state'>) {
    ensureGoogleConfig();
    const params = new URLSearchParams({
        client_id: CLIENT_ID,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: SCOPE,
        access_type: 'offline',
        prompt: 'consent',
        include_granted_scopes: 'true',
    });
    if (pkce?.challenge) {
        params.set('code_challenge', pkce.challenge);
        params.set('code_challenge_method', 'S256');
    }
    if (pkce?.state) params.set('state', pkce.state);
    return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

export async function exchangeCodeForToken(
    codeOrUrl: string,
    fallbackRedirectUri?: string,
    codeVerifier?: string,
    expectedState?: string,
) {
    ensureGoogleConfig();
    const { code, redirectUri, state } = callbackData(codeOrUrl, fallbackRedirectUri);
    if (!code) throw new Error('Google did not return an authorization code.');
    if (expectedState && state !== expectedState) throw new Error('OAuth state mismatch. Start sign-in again.');

    const body = new URLSearchParams({
        client_id: CLIENT_ID,
        code,
        grant_type: 'authorization_code',
        redirect_uri: redirectUri,
    });
    if (codeVerifier) body.set('code_verifier', codeVerifier);
    const res = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
    });
    return parseGoogleJson(res, 'Token exchange failed');
}

export async function getAccessToken(refreshToken: string) {
    ensureGoogleConfig();
    const res = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            client_id: CLIENT_ID,
            refresh_token: refreshToken,
            grant_type: 'refresh_token',
        }).toString(),
    });
    const data = await parseGoogleJson(res, 'Access token refresh failed');
    return data.access_token as string;
}

export const loadStoredGoogleRefreshToken = () => invoke<string | null>('load_google_refresh_token');
export const storeGoogleRefreshToken = (refreshToken: string) => invoke<void>('store_google_refresh_token', { refreshToken });
export const deleteStoredGoogleRefreshToken = () => invoke<void>('delete_google_refresh_token');

export async function getDriveQuota(accessToken: string): Promise<DriveQuotaInfo> {
    const fields = 'storageQuota(limit,usage,usageInDrive,usageInDriveTrash),maxUploadSize';
    const res = await fetch(`https://www.googleapis.com/drive/v3/about?fields=${encodeURIComponent(fields)}`, {
        headers: { Authorization: `Bearer ${accessToken}` },
    });
    const data = await parseGoogleJson(res, 'Drive quota lookup failed');
    const storage = data.storageQuota || {};
    return {
        limit: storage.limit ?? null,
        usage: storage.usage ?? '0',
        usageInDrive: storage.usageInDrive ?? '0',
        usageInDriveTrash: storage.usageInDriveTrash ?? '0',
        maxUploadSize: data.maxUploadSize ?? null,
        unlimited: storage.limit == null,
    };
}

async function listAllAppDataFiles(accessToken: string): Promise<DriveFileInfo[]> {
    const files: DriveFileInfo[] = [];
    let pageToken = '';
    do {
        const params = new URLSearchParams({
            spaces: 'appDataFolder',
            q: 'trashed=false',
            orderBy: 'createdTime desc',
            pageSize: '1000',
            fields: 'nextPageToken,files(id,name,createdTime,modifiedTime,size,md5Checksum,appProperties)',
        });
        if (pageToken) params.set('pageToken', pageToken);
        const res = await fetch(`https://www.googleapis.com/drive/v3/files?${params.toString()}`, {
            headers: { Authorization: `Bearer ${accessToken}` },
        });
        const data = await parseGoogleJson(res, 'App data list failed');
        files.push(...(data.files || []));
        pageToken = data.nextPageToken || '';
    } while (pageToken);
    return files;
}

export async function getAppDataFile(accessToken: string, name: string) {
    const q = `name='${escapeDriveQueryString(name)}' and trashed=false`;
    const params = new URLSearchParams({
        spaces: 'appDataFolder',
        q,
        orderBy: 'modifiedTime desc',
        pageSize: '10',
        fields: 'files(id,name,createdTime,modifiedTime,size,md5Checksum,appProperties)',
    });
    const res = await fetch(`https://www.googleapis.com/drive/v3/files?${params.toString()}`, {
        headers: { Authorization: `Bearer ${accessToken}` },
    });
    const data = await parseGoogleJson(res, `${name} metadata lookup failed`);
    return data.files?.[0] || null;
}

export async function createAppDataFileMetadata(
    accessToken: string,
    name: string,
    appProperties?: Record<string, string>,
) {
    const res = await fetch('https://www.googleapis.com/drive/v3/files?fields=id', {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, parents: ['appDataFolder'], appProperties }),
    });
    const data = await parseGoogleJson(res, `${name} metadata create failed`);
    if (!data.id) throw new Error(`${name} metadata create failed: Google Drive returned no file id.`);
    return data.id as string;
}

export async function uploadAppDataFile(accessToken: string, name: string, body: string, contentType = 'application/json') {
    let fileId = (await getAppDataFile(accessToken, name))?.id;
    if (!fileId) fileId = await createAppDataFileMetadata(accessToken, name);
    const uploadRes = await fetch(`https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=media`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': contentType },
        body,
    });
    await parseGoogleJson(uploadRes, `${name} upload failed`);
    return fileId;
}

export async function downloadAppDataFileText(accessToken: string, name: string) {
    const file = await getAppDataFile(accessToken, name);
    if (!file?.id) return null;
    const res = await fetch(`https://www.googleapis.com/drive/v3/files/${file.id}?alt=media`, {
        headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`${name} download failed: ${await res.text().catch(() => '') || res.status}`);
    return res.text();
}

export async function uploadAppDataJson(accessToken: string, name: string, data: any) {
    return uploadAppDataFile(accessToken, name, JSON.stringify(data), 'application/json');
}

export async function downloadAppDataJson<T>(accessToken: string, name: string, fallback: T): Promise<T> {
    const text = await downloadAppDataFileText(accessToken, name);
    if (!text) return fallback;
    try {
        return JSON.parse(text) as T;
    } catch (error: any) {
        throw new Error(`${name} parse failed: ${error?.message || String(error)}`);
    }
}

export async function listBackups(accessToken: string): Promise<DriveFileInfo[]> {
    const files = await listAllAppDataFiles(accessToken);
    return files
        .filter((file) => file.appProperties?.setsunaKind === 'backup'
            || file.name.startsWith(BACKUP_PREFIX)
            || file.name.startsWith(LEGACY_BACKUP_PREFIX))
        .sort((a, b) => (b.createdTime || b.modifiedTime || '').localeCompare(a.createdTime || a.modifiedTime || ''));
}

export async function deleteDriveFile(accessToken: string, fileId: string) {
    const res = await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok && res.status !== 404) {
        const details = await res.text().catch(() => '');
        throw new Error(`Backup delete failed: ${details || res.status}`);
    }
}

export async function uploadToDrive(accessToken: string, data: any, onProgress?: (pct: number) => void) {
    onProgress?.(10);
    const createdAt = new Date().toISOString();
    const dateStr = createdAt.replace(/[:.]/g, '-');
    const fileName = `${BACKUP_PREFIX}${dateStr}.json`;
    const payload = {
        schemaVersion: 2,
        ...data,
        metadata: {
            date: createdAt,
            platform: navigator.platform || 'unknown',
            ...(data?.metadata || {}),
        },
    };
    const fileId = await createAppDataFileMetadata(accessToken, fileName, {
        setsunaKind: 'backup',
        schemaVersion: '2',
        platform: String(payload.metadata.platform).slice(0, 120),
    });
    onProgress?.(35);
    try {
        const uploadRes = await fetch(`https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=media&fields=id,name,createdTime,modifiedTime,size,appProperties`, {
            method: 'PATCH',
            headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        });
        const uploaded = await parseGoogleJson(uploadRes, 'Backup upload failed');
        onProgress?.(100);
        return uploaded as DriveFileInfo;
    } catch (error) {
        await deleteDriveFile(accessToken, fileId).catch(() => undefined);
        throw error;
    }
}

export async function downloadFromDrive(accessToken: string, fileId: string, onProgress?: (pct: number) => void) {
    onProgress?.(25);
    const res = await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media`, {
        headers: { Authorization: `Bearer ${accessToken}` },
    });
    const result = await parseGoogleJson(res, 'Backup download failed');
    onProgress?.(100);
    return result;
}

export async function getDictDriveInfo(accessToken: string): Promise<DriveFileInfo | null> {
    const files = await listAllAppDataFiles(accessToken);
    return files.find((file) => file.appProperties?.setsunaKind === 'dictionary' || file.name === 'dictionary.db') || null;
}

export async function createDictFileMetadata(accessToken: string) {
    return createAppDataFileMetadata(accessToken, 'dictionary.db', {
        setsunaKind: 'dictionary',
        schemaVersion: '1',
    });
}

export async function startDictionaryResumableUpload(accessToken: string, fileId: string, fileSize: number) {
    const res = await fetch(`https://www.googleapis.com/upload/drive/v3/files/${encodeURIComponent(fileId)}?uploadType=resumable`, {
        method: 'PATCH',
        headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json; charset=UTF-8',
            'X-Upload-Content-Type': 'application/octet-stream',
            'X-Upload-Content-Length': String(fileSize),
        },
        body: JSON.stringify({ appProperties: { setsunaKind: 'dictionary', schemaVersion: '1' } }),
    });
    if (!res.ok) await parseGoogleJson(res, 'Dictionary resumable upload start failed');
    const sessionUrl = res.headers.get('location');
    if (!sessionUrl) throw new Error('Google Drive did not return a resumable upload URL.');
    return sessionUrl;
}

export const bytesAvailableInDrive = (quota: DriveQuotaInfo) => {
    if (quota.unlimited || !quota.limit) return null;
    return Math.max(0, Number(quota.limit) - Number(quota.usage || 0));
};

export const hasDriveSpace = (quota: DriveQuotaInfo, incomingBytes: number, replacedBytes = 0) => {
    const available = bytesAvailableInDrive(quota);
    if (available == null) return true;
    const growth = Math.max(0, incomingBytes - replacedBytes);
    const safetyMargin = Math.max(32 * 1024 * 1024, Math.ceil(incomingBytes * 0.02));
    return available >= growth + safetyMargin;
};
