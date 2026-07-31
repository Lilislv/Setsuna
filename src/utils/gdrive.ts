import { fetch } from '@tauri-apps/plugin-http';

const CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID || "";
const CLIENT_SECRET = import.meta.env.VITE_GOOGLE_CLIENT_SECRET || "";
const SCOPE = "https://www.googleapis.com/auth/drive.appdata";
const DEFAULT_REDIRECT_URI = "http://127.0.0.1:1337";

const ensureGoogleConfig = () => {
    if (!CLIENT_ID || !CLIENT_SECRET) {
        throw new Error("Google OAuth is not configured. Check VITE_GOOGLE_CLIENT_ID and VITE_GOOGLE_CLIENT_SECRET.");
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

const escapeDriveQueryString = (value: string) => value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");

export async function getAppDataFile(accessToken: string, name: string) {
    const q = `name='${escapeDriveQueryString(name)}'`;
    const res = await fetch(`https://www.googleapis.com/drive/v3/files?spaces=appDataFolder&q=${encodeURIComponent(q)}&fields=files(id,name,modifiedTime,size)`, {
        headers: { Authorization: `Bearer ${accessToken}` }
    });
    const data = await parseGoogleJson(res, `${name} metadata lookup failed`);
    return data.files && data.files.length > 0 ? data.files[0] : null;
}

export async function createAppDataFileMetadata(accessToken: string, name: string) {
    const res = await fetch('https://www.googleapis.com/drive/v3/files', {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, parents: ['appDataFolder'] })
    });
    const data = await parseGoogleJson(res, `${name} metadata create failed`);
    if (!data.id) throw new Error(`${name} metadata create failed: Google Drive returned no file id.`);
    return data.id;
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

    const dlRes = await fetch(`https://www.googleapis.com/drive/v3/files/${file.id}?alt=media`, {
        headers: { Authorization: `Bearer ${accessToken}` }
    });
    if (dlRes.status === 404) return null;
    if (!dlRes.ok) {
        const text = await dlRes.text().catch(() => "");
        throw new Error(`${name} download failed: ${text || dlRes.status}`);
    }
    return dlRes.text();
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

const callbackData = (codeOrUrl: string, fallbackRedirectUri = DEFAULT_REDIRECT_URI) => {
    const value = codeOrUrl.trim();
    if (!value) return { code: "", redirectUri: fallbackRedirectUri };
    if (!value.startsWith("http")) return { code: value, redirectUri: fallbackRedirectUri };

    const url = new URL(value);
    const error = url.searchParams.get("error");
    if (error) {
        throw new Error(url.searchParams.get("error_description") || error);
    }
    return {
        code: url.searchParams.get("code") || value,
        redirectUri: `${url.protocol}//${url.host}`,
    };
};

export function getAuthUrl(redirectUri = DEFAULT_REDIRECT_URI) {
    ensureGoogleConfig();
    const params = new URLSearchParams({
        client_id: CLIENT_ID, redirect_uri: redirectUri, response_type: 'code',
        scope: SCOPE, access_type: 'offline', prompt: 'consent' 
    });
    return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

export async function exchangeCodeForToken(codeOrUrl: string, fallbackRedirectUri?: string) {
    ensureGoogleConfig();
    const { code, redirectUri } = callbackData(codeOrUrl, fallbackRedirectUri);
    const res = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, code, grant_type: 'authorization_code', redirect_uri: redirectUri }).toString()
    });
    return parseGoogleJson(res, "Token exchange failed");
}

export async function getAccessToken(refreshToken: string) {
    ensureGoogleConfig();
    const res = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, refresh_token: refreshToken, grant_type: 'refresh_token' }).toString()
    });
    const data = await parseGoogleJson(res, "Access token refresh failed");
    return data.access_token;
}

export async function listBackups(accessToken: string) {
    const res = await fetch('https://www.googleapis.com/drive/v3/files?spaces=appDataFolder&q=name contains "txthk_backup"&orderBy=createdTime desc&fields=files(id,name,createdTime)', {
        headers: { Authorization: `Bearer ${accessToken}` }
    });
    const data = await parseGoogleJson(res, "Backup list failed");
    return data.files || [];
}

export async function uploadToDrive(accessToken: string, data: any, onProgress?: (pct: number) => void) {
    if(onProgress) onProgress(20);
    const dateStr = new Date().toISOString().replace(/[:.]/g, '-');
    const fileName = `txthk_backup_${dateStr}.json`;
    if(onProgress) onProgress(40);

    const createRes = await fetch('https://www.googleapis.com/drive/v3/files', {
        method: 'POST', headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: fileName, parents: ['appDataFolder'] })
    });
    const fileId = (await parseGoogleJson(createRes, "Backup metadata create failed")).id;
    if (!fileId) throw new Error("Backup metadata create failed: Google Drive returned no file id.");
    if(onProgress) onProgress(70);

    const uploadRes = await fetch(`https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=media`, {
        method: 'PATCH', headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify(data)
    });
    await parseGoogleJson(uploadRes, "Backup upload failed");
    if(onProgress) onProgress(90);

    const files = await listBackups(accessToken);
    if (files.length > 30) {
        for (let i = 30; i < files.length; i++) {
            const deleteRes = await fetch(`https://www.googleapis.com/drive/v3/files/${files[i].id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${accessToken}` } });
            if (!deleteRes.ok) console.warn("Old Google Drive backup cleanup failed", deleteRes.status);
        }
    }
    if(onProgress) onProgress(100);
}

export async function downloadFromDrive(accessToken: string, fileId: string, onProgress?: (pct: number) => void) {
    if(onProgress) onProgress(40);
    const dlRes = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, { headers: { Authorization: `Bearer ${accessToken}` } });
    const result = await parseGoogleJson(dlRes, "Backup download failed");
    if(onProgress) onProgress(100);
    return result;
}

// „N„O„B„O„E: „U„…„~„{„€„y„y „t„|„‘ „Ѓ„Ђ„y„ѓ„{„p „†„p„z„|„p „ѓ„|„Ђ„r„p„‚„‘
// Dictionary database file helpers.
export async function getDictDriveInfo(accessToken: string) {
    const res = await fetch('https://www.googleapis.com/drive/v3/files?spaces=appDataFolder&q=name="dictionary.db"&fields=files(id,modifiedTime,size)', {
        headers: { Authorization: `Bearer ${accessToken}` }
    });
    const data = await parseGoogleJson(res, "Dictionary metadata lookup failed");
    return data.files && data.files.length > 0 ? data.files[0] : null;
}

export async function createDictFileMetadata(accessToken: string) {
    const res = await fetch('https://www.googleapis.com/drive/v3/files', {
        method: 'POST', headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'dictionary.db', parents: ['appDataFolder'] })
    });
    const data = await parseGoogleJson(res, "Dictionary metadata create failed");
    if (!data.id) throw new Error("Dictionary metadata create failed: Google Drive returned no file id.");
    return data.id;
}
