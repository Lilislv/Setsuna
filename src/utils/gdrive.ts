import { fetch } from '@tauri-apps/plugin-http';

const CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID || "";
const CLIENT_SECRET = import.meta.env.VITE_GOOGLE_CLIENT_SECRET || "";
const SCOPE = "https://www.googleapis.com/auth/drive.appdata";
const REDIRECT_URI = "http://127.0.0.1:1337"; 

export function getAuthUrl() {
    const params = new URLSearchParams({
        client_id: CLIENT_ID, redirect_uri: REDIRECT_URI, response_type: 'code',
        scope: SCOPE, access_type: 'offline', prompt: 'consent' 
    });
    return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

export async function exchangeCodeForToken(codeOrUrl: string) {
    let cleanCode = codeOrUrl.trim();
    if (cleanCode.startsWith('http')) {
        try { cleanCode = new URL(cleanCode).searchParams.get('code') || cleanCode; } catch (e) {}
    }
    const res = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, code: cleanCode, grant_type: 'authorization_code', redirect_uri: REDIRECT_URI }).toString()
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error_description || data.error);
    return data; 
}

export async function getAccessToken(refreshToken: string) {
    const res = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, refresh_token: refreshToken, grant_type: 'refresh_token' }).toString()
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error_description || data.error);
    return data.access_token;
}

export async function listBackups(accessToken: string) {
    const res = await fetch('https://www.googleapis.com/drive/v3/files?spaces=appDataFolder&q=name contains "txthk_backup"&orderBy=createdTime desc&fields=files(id,name,createdTime)', {
        headers: { Authorization: `Bearer ${accessToken}` }
    });
    const data = await res.json();
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
    const fileId = (await createRes.json()).id;
    if(onProgress) onProgress(70);

    await fetch(`https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=media`, {
        method: 'PATCH', headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify(data)
    });
    if(onProgress) onProgress(90);

    const files = await listBackups(accessToken);
    if (files.length > 30) {
        for (let i = 30; i < files.length; i++) {
            await fetch(`https://www.googleapis.com/drive/v3/files/${files[i].id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${accessToken}` } });
        }
    }
    if(onProgress) onProgress(100);
}

export async function downloadFromDrive(accessToken: string, fileId: string, onProgress?: (pct: number) => void) {
    if(onProgress) onProgress(40);
    const dlRes = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, { headers: { Authorization: `Bearer ${accessToken}` } });
    const result = await dlRes.json();
    if(onProgress) onProgress(100);
    return result;
}

// „N„O„B„O„E: „U„…„~„{„ˆ„y„y „t„|„‘ „„€„y„ƒ„{„p „†„p„z„|„p „ƒ„|„€„r„p„‚„‘
export async function getDictDriveInfo(accessToken: string) {
    const res = await fetch('https://www.googleapis.com/drive/v3/files?spaces=appDataFolder&q=name="dictionary.db"&fields=files(id,modifiedTime,size)', {
        headers: { Authorization: `Bearer ${accessToken}` }
    });
    const data = await res.json();
    return data.files && data.files.length > 0 ? data.files[0] : null;
}

export async function createDictFileMetadata(accessToken: string) {
    const res = await fetch('https://www.googleapis.com/drive/v3/files', {
        method: 'POST', headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'dictionary.db', parents: ['appDataFolder'] })
    });
    return (await res.json()).id;
}