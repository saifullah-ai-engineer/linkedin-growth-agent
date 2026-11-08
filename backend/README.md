# LinkedIn Intelligence and Growth Agent, Backend

Local backend for Saif Ullah's LinkedIn Intelligence and Growth Agent. Express plus the built-in `node:sqlite` module. No native dependencies. It never contacts LinkedIn or any LinkedIn API.

## Start

```bash
cd backend
npm install
node server.js
```

The server listens on port 3000. The API base is `http://localhost:3000/api`.

## Setup steps

1. Start the server with the commands above.
2. Open the app (or call the API) and set a local password. `POST /api/auth/setup` accepts `{ "password": "..." }` with at least 8 characters. Setup is disabled after the first user is created.
3. Log in with `POST /api/auth/login` using that password. It returns a bearer token. Send it as `Authorization: Bearer <token>` on every `/api/*` call except `/api/auth/status`, `/api/auth/setup`, and `/api/auth/login`.
4. Add your OpenRouter key in Settings, or set `OPENROUTER_API_KEY` in `backend/.env` (see `.env.example`). The key is server side only and is never returned by the API.
5. Test the connection with `POST /api/config/test`. It calls `https://openrouter.ai/api/v1/models` and returns `{ ok, modelCount }` or a structured error.
6. Pick a primary and fallback model in Settings. `GET /api/models` lists live models with a `free` flag (prompt price 0) so the UI can filter free models.

## What is seeded

On first run, with empty tables, the database seeds Saif Ullah's real profile facts as memory items (identity, LinkedIn, portfolio, GitHub, services, target audiences, positioning) and three goals derived from them. It seeds zero fake prospects. It seeds one example prospect named "EXAMPLE, delete me" in stage Target so the UI empty state and pipeline can be demonstrated. Delete that row before real use.

## Endpoints

Auth: `GET /api/auth/status`, `POST /api/auth/setup`, `POST /api/auth/login`, `POST /api/auth/logout`.

Config and models: `GET /api/config`, `PUT /api/config`, `POST /api/config/key`, `POST /api/config/test`, `GET /api/models`.

AI: `POST /api/ai/chat`, `POST /api/ai/draft`, `POST /api/strategist`. All three build prompts from real database evidence only (goals, memory, prospects, interactions) plus text the user pasted. With no key configured they return HTTP 503 `{ error: "not_configured", setup: [...] }` and generate no answer. On 429, timeout, or model unavailable they retry once with the fallback model, then return a structured error and write to `error_log`.

CRM: `GET/POST /api/prospects`, `GET/PUT/DELETE /api/prospects/:id`, `GET /api/prospects/prioritized`, `POST /api/prospects/:id/interactions`, `GET/POST /api/prospects/:id/notes`, `GET/POST/PUT/DELETE /api/goals`, `GET/POST/PUT/DELETE /api/memory`, `GET/POST /api/drafts`, `POST /api/drafts/:id/approve`, `POST /api/drafts/:id/reject`.

Feedback and reporting: `GET /api/recommendations`, `POST /api/recommendations/:id/feedback`, `GET /api/audit`, `GET /api/errors`, `GET /api/analytics`.

Kill switch: `GET /api/killswitch`, `POST /api/killswitch { enabled }`. When enabled, all `/api/ai/*` and draft approve endpoints return 403 `{ error: "kill_switch_on" }`.

## Files

- `server.js`: Express app and all routes.
- `db.js`: SQLite setup, tables, seed data, audit and error logging.
- `auth.js`: scrypt password hashing and bearer token auth.
- `openrouter.js`: OpenRouter client, key storage, model list, chat with fallback, structured JSON validation.
- `agents/strategist.js`: orchestrator that classifies requests, gathers evidence, and stores recommendations.
- `agents/audience.js`, `agents/relationship.js`, `agents/content.js`, `agents/outreach.js`, `agents/profile.js`: prompt sections built from real database rows.
- `data/app.db`: SQLite database file, created on first run.

## Notes

- No em dash is used anywhere in this project.
- No invented stars, users, results, or LinkedIn stats appear anywhere. Analytics counts come only from real database rows and are labeled as app records.
- Approving a draft, deleting a prospect, and changing config each write an `audit_log` row.
