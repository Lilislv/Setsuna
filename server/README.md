# Setsuna Account API

Minimal Cloudflare Worker + D1 backend for Setsuna account sync.

## Endpoints

- `GET /api/health`
- `POST /api/auth/register`
- `POST /api/auth/login`
- `GET /api/devices`
- `POST /api/devices`

`/devices` requires `Authorization: Bearer <token>`.

The account API is only used for device presence and screenshot-capable device discovery. It does not store tabs, hooked text, timer state, or archive state.

## Deploy Shape

1. Create a D1 database.
2. Apply `schema.sql`.
3. Deploy `setsuna-account-worker.js` with a `DB` D1 binding.
4. Route it under `https://setsunalookup.ru/api/*`.

The app default API URL is `https://setsunalookup.ru/api`.

## Cloudflare Commands

From `C:\pr\txthk\server`:

```powershell
npx wrangler login
npx wrangler d1 create setsuna-account
```

Copy the returned `database_id` into `wrangler.toml` (use `wrangler.example.toml` as the template), then run:

```powershell
npx wrangler d1 execute setsuna-account --remote --file .\schema.sql
npx wrangler deploy
```

After deploy, this URL must return JSON:

```text
https://setsunalookup.ru/api/health
```
