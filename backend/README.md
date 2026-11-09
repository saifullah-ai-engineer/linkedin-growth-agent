# LinkedIn Intelligence and Growth Agent, Backend

Local backend for Saif Ullah's LinkedIn Intelligence and Growth Agent. Express plus the built-in `node:sqlite` module. No native dependencies. It never contacts LinkedIn or any LinkedIn API.

## Start

```bash
cd backend
npm install
node server.js
```

The server listens on port 3000. The API base is `http://localhost:3000/api`.

The dashboard loads `public/app.min.js`, the minified build of `public/app.js`. After editing `app.js`, rebuild it with `npm run build` (uses terser, installed as a dev dependency). The readable `app.js` stays in the repo as the source of truth.

## Setup steps

1. Start the server with the commands above.
2. Open the app (or call the API) and set a local password. `POST /api/auth/setup` accepts `{ "password": "..." }` with at least 12 characters, including an upper case letter, a lower case letter, a digit, and a symbol. Setup is disabled after the first user is created. Setup returns a bearer token, so the first run signs you straight in.
3. Log in with `POST /api/auth/login` using that password. It returns a bearer token. Send it as `Authorization: Bearer <token>` on every `/api/*` call except `/api/auth/status`, `/api/auth/setup`, and `/api/auth/login`.
4. Add your OpenRouter key in Settings, or set `OPENROUTER_API_KEY` in `backend/.env` (see `.env.example`). The key is server side only and is never returned by the API.
5. Test the connection with `POST /api/config/test`. It calls `https://openrouter.ai/api/v1/models` and returns `{ ok, modelCount }` or a structured error.
6. Pick a primary and fallback model in Settings. `GET /api/models` lists live models with a `free` flag (prompt price 0) so the UI can filter free models.

## What is seeded

On first run, with empty tables, the database seeds Saif Ullah's real profile facts as memory items (identity, LinkedIn, portfolio, GitHub, services, target audiences, positioning) and three goals derived from them. It seeds zero fake prospects. It seeds one example prospect named "EXAMPLE, delete me" in stage Target so the UI empty state and pipeline can be demonstrated. Delete that row before real use.

## Endpoints

Auth: `GET /api/auth/status`, `POST /api/auth/setup`, `POST /api/auth/login`, `POST /api/auth/logout`, `POST /api/auth/change-password`. The change-password endpoint needs the current password, applies the same strength rule to the new one, and signs out every other session. Sessions expire 24 hours after sign-in; an expired token is rejected and deleted.

Config and models: `GET /api/config`, `PUT /api/config`, `POST /api/config/key`, `POST /api/config/test`, `GET /api/models`. `PUT /api/config` rejects paid models with 400 `paid_model_not_allowed`, and rejects a temperature outside 0 to 2 or max tokens outside 100 to 32000 with 400 `invalid_config`.

AI: `POST /api/ai/chat`, `POST /api/ai/draft`, `POST /api/strategist`. All three build prompts from real database evidence only (goals, memory, prospects, interactions) plus text the user pasted. With no key configured they return HTTP 503 `{ error: "not_configured", setup: [...] }` and generate no answer. The app uses free models only, with a full fallback chain of all 12 free models in order. On 429, timeout, or model unavailable it walks the whole chain, then returns a structured error and writes to `error_log`.

CRM: `GET/POST /api/prospects`, `GET/PUT/DELETE /api/prospects/:id`, `GET /api/prospects/prioritized`, `GET/POST /api/prospects/:id/interactions`, `GET/POST /api/prospects/:id/notes`, `GET/POST/PUT/DELETE /api/goals`, `GET/POST/PUT/DELETE /api/memory`, `GET/POST /api/drafts`, `POST /api/drafts/:id/approve`, `POST /api/drafts/:id/reject`. Goals accept the dashboard fields title, target, deadline, status, and description; older rows with only text still read back with title set from text. Interactions accept kind, text, and happened_on, and the older type, summary, and date field names still work.

Feedback and reporting: `GET /api/recommendations`, `POST /api/recommendations/:id/feedback`, `GET /api/audit`, `GET /api/errors`, `GET /api/analytics`. The analytics response also returns `totalDrafts`, `prospectsByDay` and `draftsByDay`, per-day counts for the last 14 days computed from `created_at`, with zero-count days included, so the Analytics charts are honest.

Kill switch: `GET /api/killswitch`, `POST /api/killswitch { enabled }`. When enabled, all `/api/ai/*` and draft approve endpoints return 403 `{ error: "kill_switch_on" }`.

## Testing

```bash
npm test
```

The suite uses Node's built-in test runner, no extra dependency. It starts the real server as a child process against a throwaway data directory (`LIGA_DATA_DIR` points at a temp folder), so it never touches a real database or a real key. 16 tests cover auth and setup, password strength, change password, expired sessions, config validation including the paid-model rejection, the not-configured AI responses, prospect CRUD and prioritized ranking, interactions and notes, goals, memory, drafts and approval, the kill switch, recommendations, analytics, audit, login throttling, body errors, security headers, input validation, and error hygiene. They run in about 5 seconds and also run in CI on every push.

## Security

- **Password**: scrypt hash with a random salt. The rule is 12 or more characters with upper and lower case, a digit, and a symbol, enforced at setup and at password change. Change the password in Settings; it signs out every other session.
- **Sessions**: random 32-byte bearer tokens with a 24 hour expiry, enforced on every authenticated route and on the auth status check. Logout deletes the server-side session row. An expired token is deleted when it is seen.
- **Login throttle**: after 5 failed logins from one address inside 60 seconds, login answers 429 without running a password check. A successful login clears the count.
- **Headers**: every response carries a strict content security policy (same origin only, no inline scripts or styles, no frames), X-Frame-Options DENY, X-Content-Type-Options nosniff, Referrer-Policy no-referrer, and a restrictive permissions policy.
- **CORS**: no CORS headers are emitted, so a page on another origin cannot read API responses. Auth is a Bearer token, not a cookie, so there is no ambient credential for a cross-site request to reuse.
- **Input validation**: prospect stage must be one of the 10 real stages, relevance score a whole number from 0 to 100, and text fields are type-checked and length-capped. AI inputs are capped at 20000 characters in total. Request shape is validated before the kill switch and key checks, so a bad request is a 400 whatever the app state is.
- **Errors**: server errors return a generic message to the client; the real message goes to the server log and the error_log table only.
- **API key**: the OpenRouter key is server side only, written to `backend/.env` with mode 0600 enforced on every save, and never logged or returned by any API response.
- **Logs**: audit_log keeps the latest 1000 rows and error_log the latest 500, so neither grows without bound.
- **Honest limits**: this is a local single-user app, not a multi-user production service. There is no per-user separation, no account lockout beyond the login throttle, and no global rate limit; the login is a single local password and the app must never be exposed to the internet.

## Files

- `server.js`: Express app and all routes.
- `db.js`: SQLite setup, tables, seed data, audit and error logging. The data directory defaults to `backend/data` and can be overridden with the `LIGA_DATA_DIR` environment variable.
- `test/api.test.js`: automated API test suite, Node built-in test runner.
- `auth.js`: scrypt password hashing, the password strength rule, bearer token auth with 24 hour session expiry, and the login throttle helpers.
- `openrouter.js`: OpenRouter client, key storage, model list, chat with fallback, structured JSON validation.
- `agents/strategist.js`: orchestrator that classifies requests, gathers evidence, and stores recommendations.
- `agents/audience.js`, `agents/relationship.js`, `agents/content.js`, `agents/outreach.js`, `agents/profile.js`: prompt sections built from real database rows.
- `data/app.db`: SQLite database file, created on first run.

## Notes

- No em dash is used anywhere in this project.
- No invented stars, users, results, or LinkedIn stats appear anywhere. Analytics counts come only from real database rows and are labeled as app records.
- Approving a draft, deleting a prospect, and changing config each write an `audit_log` row.
