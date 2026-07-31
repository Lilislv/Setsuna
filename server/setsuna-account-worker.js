const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Authorization,Content-Type",
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
};

let deviceColumnsPromise = null;

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: CORS_HEADERS });

const now = () => new Date().toISOString();

const randomId = () => crypto.randomUUID();

const randomToken = () => {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
};

const normalizeEmail = (email) => String(email || "").trim().toLowerCase();

const toBase64 = (buffer) => {
  let binary = "";
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
};

const fromBase64 = (value) => {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
};

async function hashPassword(password, saltBase64) {
  const salt = saltBase64 ? fromBase64(saltBase64) : crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations: 120000 },
    key,
    256,
  );
  return { hash: toBase64(bits), salt: toBase64(salt) };
}

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

async function requireUser(request, env) {
  const header = request.headers.get("Authorization") || "";
  const token = header.replace(/^Bearer\s+/i, "").trim();
  if (!token) return null;
  const session = await env.DB.prepare(
    "SELECT sessions.token, users.id, users.email FROM sessions JOIN users ON users.id = sessions.user_id WHERE sessions.token = ?",
  ).bind(token).first();
  if (!session) return null;
  await env.DB.prepare("UPDATE sessions SET last_seen_at = ? WHERE token = ?").bind(now(), token).run();
  return { id: session.id, email: session.email, token };
}

async function ensureDeviceColumns(env) {
  if (!deviceColumnsPromise) {
    deviceColumnsPromise = (async () => {
      try {
        await env.DB.prepare("ALTER TABLE devices ADD COLUMN capture_agent_url TEXT NOT NULL DEFAULT ''").run();
      } catch {}
      try {
        await env.DB.prepare("ALTER TABLE devices ADD COLUMN capture_agent_token TEXT NOT NULL DEFAULT ''").run();
      } catch {}
    })();
  }
  await deviceColumnsPromise;
}

async function upsertDevice(env, userId, deviceId, deviceName, captureAgentUrl, captureAgentToken) {
  await ensureDeviceColumns(env);
  const safeDeviceId = String(deviceId || "").trim() || "setsuna";
  const safeDeviceName = String(deviceName || "").trim() || "Setsuna PC";
  const timestamp = now();
  const existing = await env.DB.prepare(
    "SELECT id, capture_agent_url AS captureAgentUrl, capture_agent_token AS captureAgentToken FROM devices WHERE user_id = ? AND device_id = ?",
  ).bind(userId, safeDeviceId).first();
  const safeCaptureAgentUrl = typeof captureAgentUrl === "string"
    ? captureAgentUrl.trim()
    : String(existing?.captureAgentUrl || "");
  const safeCaptureAgentToken = typeof captureAgentToken === "string"
    ? captureAgentToken.trim()
    : String(existing?.captureAgentToken || "");
  if (existing) {
    await env.DB.prepare(
      "UPDATE devices SET device_name = ?, capture_agent_url = ?, capture_agent_token = ?, updated_at = ?, last_seen_at = ? WHERE id = ?",
    ).bind(safeDeviceName, safeCaptureAgentUrl, safeCaptureAgentToken, timestamp, timestamp, existing.id).run();
    return existing.id;
  }
  const id = randomId();
  await env.DB.prepare(
    "INSERT INTO devices (id, user_id, device_id, device_name, capture_agent_url, capture_agent_token, created_at, updated_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).bind(id, userId, safeDeviceId, safeDeviceName, safeCaptureAgentUrl, safeCaptureAgentToken, timestamp, timestamp, timestamp).run();
  return id;
}

async function listDevices(env, userId) {
  await ensureDeviceColumns(env);
  const result = await env.DB.prepare(
    "SELECT id, device_id AS deviceId, device_name AS deviceName, capture_agent_url AS captureAgentUrl, capture_agent_token AS captureAgentToken, created_at AS createdAt, updated_at AS updatedAt, last_seen_at AS lastSeenAt FROM devices WHERE user_id = ? ORDER BY last_seen_at DESC",
  ).bind(userId).all();
  return result.results || [];
}

async function createSession(env, userId) {
  const token = randomToken();
  const timestamp = now();
  await env.DB.prepare(
    "INSERT INTO sessions (token, user_id, created_at, last_seen_at) VALUES (?, ?, ?, ?)",
  ).bind(token, userId, timestamp, timestamp).run();
  return token;
}

async function register(request, env) {
  const body = await readJson(request);
  const email = normalizeEmail(body.email);
  const password = String(body.password || "");
  if (!email || password.length < 8) return json({ error: "Email and password with at least 8 characters are required." }, 400);
  const exists = await env.DB.prepare("SELECT id FROM users WHERE email = ?").bind(email).first();
  if (exists) return json({ error: "Account already exists." }, 409);

  const userId = randomId();
  const passwordData = await hashPassword(password);
  const timestamp = now();
  await env.DB.prepare(
    "INSERT INTO users (id, email, password_hash, password_salt, created_at) VALUES (?, ?, ?, ?, ?)",
  ).bind(userId, email, passwordData.hash, passwordData.salt, timestamp).run();
  await upsertDevice(env, userId, body.deviceId, body.deviceName, body.captureAgentUrl, body.captureAgentToken);
  const token = await createSession(env, userId);
  return json({ token, user: { id: userId, email }, devices: await listDevices(env, userId) });
}

async function login(request, env) {
  const body = await readJson(request);
  const email = normalizeEmail(body.email);
  const password = String(body.password || "");
  const user = await env.DB.prepare("SELECT id, email, password_hash AS passwordHash, password_salt AS passwordSalt FROM users WHERE email = ?")
    .bind(email)
    .first();
  if (!user) return json({ error: "Invalid email or password." }, 401);
  const passwordData = await hashPassword(password, user.passwordSalt);
  if (passwordData.hash !== user.passwordHash) return json({ error: "Invalid email or password." }, 401);
  await upsertDevice(env, user.id, body.deviceId, body.deviceName, body.captureAgentUrl, body.captureAgentToken);
  const token = await createSession(env, user.id);
  return json({ token, user: { id: user.id, email: user.email }, devices: await listDevices(env, user.id) });
}

async function devices(request, env) {
  const user = await requireUser(request, env);
  if (!user) return json({ error: "Unauthorized." }, 401);
  if (request.method === "POST") {
    const body = await readJson(request);
    await upsertDevice(env, user.id, body.deviceId, body.deviceName, body.captureAgentUrl, body.captureAgentToken);
  }
  return json({ devices: await listDevices(env, user.id) });
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });
    const url = new URL(request.url);
    const path = url.pathname.replace(/^\/api/, "");
    try {
      if (request.method === "GET" && path === "/health") return json({ ok: true, service: "setsuna-account-api" });
      if (request.method === "POST" && path === "/auth/register") return register(request, env);
      if (request.method === "POST" && path === "/auth/login") return login(request, env);
      if ((request.method === "GET" || request.method === "POST") && path === "/devices") return devices(request, env);
      return json({ error: "Not found." }, 404);
    } catch (error) {
      return json({ error: error?.message || String(error) }, 500);
    }
  },
};
