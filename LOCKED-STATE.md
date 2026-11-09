# LinkedIn Growth Agent, locked state

Locked by Abd on 2026-11-09. "Lock this" means: this state is saved in the pipeline as the frozen reference. Future work builds on it and does not silently change it. Nothing here is a promise about live AI or rankings, only what was verified on the dates shown.

## Repo

- https://github.com/saifullah-ai-engineer/linkedin-growth-agent
- Public, MIT, head commit fabc9d7 on 2026-11-09
- v0.1.0 release on commit dc51f39, marked Latest

## Commits locked in

- dc51f39, Add Chrome extension: Manifest V3 background, content, popup (v0.1.0 base, 29 files)
- a77b4ec, Professional dashboard redesign, free-model fallback, new README and screenshots
- 17fce38, docs/screenshots, six PNGs
- 50c5eff, Backend: compression and robots, free-model fallback chain, analytics by day
- 5b63fbe, Dashboard redesign: design system, CRM table, pipeline chart, analytics charts
- c8dc983, backend/public/index.html, current head before CI
- fabc9d7, Add CI workflow: tests and build on every push

## What is locked

- Dashboard: 13 pages, professional redesign, grouped sidebar, command-center Overview with pipeline donut and recent activity, CRM table for Prospects, per-day Analytics charts. All charts and counts come from real database rows only.
- Backend: Node and Express with SQLite, local login with first-run password setup, server-side OpenRouter proxy, key never in the repo.
- AI: six specialized agents (Strategist, Audience, Relationship, Content, Outreach, Profile). Evidence-based strategist, structured JSON with reasoning, evidence, and next action.
- Free models only, enforced at three layers: the chat chain accepts only models ending in :free, the config save rejects paid models with 400 paid_model_not_allowed, and the dashboard free-only filter is on by default. Full fallback chain of all 12 free models in order, starting with google/gemma-4-26b-a4b-it:free. No paid model reference remains anywhere in the project.
- Extension: Manifest V3, permissions only activeTab, storage, sidePanel. Reads only visible page text, drafts only, every draft needs manual approval. No auto-connect, auto-like, auto-comment, or auto-message. Those are unsupported by LinkedIn and intentionally not built.
- Safety: approval queue, kill switch, audit log, error log. AI: not configured badge until a key is set.

## Measured results locked in

- Lighthouse 13.6.0, real runs, Nov 9: setup screen 100/100/100/100; authenticated dashboard 100/100/100/100, then 99/100/100/100 after the redesign (setup 94 on the redesign re-run, normal variance). All categories 90+.
- Backend API: p50 about 1 ms, p95 under 2.1 ms on auth status, prospects, prioritized, analytics, memory, goals, drafts.
- CI: workflows live on four repos (linkedin-growth-agent, lead-catcher-agent, mcp-agent-starter, voice-receptionist-agent). First runs on all four completed with no failures. One warning on every run: Node.js 20 is deprecated on GitHub runners.

## OpenRouter key, locked facts

- Connected Nov 9 via secure entry (custom.openrouter, Bearer key). Key verified valid, free tier, 50 free-model requests per day, 0 used at check, 425 models with 12 free.
- Two live chat attempts (gemma-4-26b and gemma-4-31b, both free) returned HTTP 429, account-level free-tier throttling at that moment. The key itself is valid.
- The backend still needs the key in its own server-side config (Model Configuration page or OPENROUTER_API_KEY in backend/.env) before its live AI can be verified end to end. The key is never committed to any repo.

## Not locked yet (in flight on 2026-11-09)

- Full visual documentation enhancement: architecture diagrams, workflow diagrams, README upgrade.
- Promo video: HTML/CSS/JS animated visuals, narration in Abd's cloned voice, subtitles, 16:9.
- README visuals (hero, agents illustration, repo-structure diagram) are done locally and go up with the docs work.

## Rules locked with this state

- Never use a paid model. Free models only, full fallback chain.
- Never delete any repo of Abd's.
- GitHub writes go through the browser web UI; the connector fails with 403 because the Muse GitHub App is not installed on his repos.
- No em dash anywhere.
- No fake scores, badges, statistics, or features. Every claim must be verified against the real code or a real run.

## Addendum: upgrade, 2026-11-09 (supersedes the lock above)

Abd asked to upgrade the repo so it is genuinely working and efficient. This addendum overrides the frozen state above. The remote head is still 44c530f; everything below is local and uncommitted, to be pushed through the browser web UI.

### Bugs found by end-to-end verification and fixed

1. First-run setup returned no token, so a new user was bounced straight back to the login screen. Setup now creates a session and returns the token.
2. The goal form could not save anything. The form sends title, target, deadline, status, and description, but the API only accepted a text field and answered 400. The goals table gained those columns with a migration on first start, and the API accepts the dashboard shape. Older text-only rows still read back with title set from text.
3. Interactions were saved empty and never shown. The form sent type, date, and summary, but the API stored kind and text, so every interaction saved with no kind and no text, and there was no endpoint to list them, so the CRM log was always empty. The API now accepts both field shapes, stores the date as happened_on, and `GET /api/prospects/:id/interactions` lists them.
4. AI pages showed a bare `not_configured` error instead of the setup steps. API errors now carry their response body, and every AI form shows the setup guidance when no key is configured. The 503 body also now includes `code: "not_configured"` for consistency.
5. Config accepted impossible values. Temperature outside 0 to 2 and max tokens outside 100 to 32000 now return 400 `invalid_config`.
6. Logout never told the server, so session rows piled up. Logout now deletes the server-side session and still signs out locally if that call fails.

### Efficiency

- `/api/analytics` now returns `totalDrafts`, so the Analytics page no longer relies on a possibly stale dashboard cache.
- Content Studio and Analytics refresh now load their two cache calls in parallel instead of one after the other.
- CSS minification was measured and skipped: styles.css gzips to 5,119 bytes on the wire, so minifying would save about 1 KB, not worth a new build dependency.

### Tests and maintenance

- New automated API test suite, `backend/test/api.test.js`, Node built-in test runner, 10 tests, about 5 seconds, also in CI. It starts the real server against a throwaway data directory (`LIGA_DATA_DIR` env override, new in db.js).
- CI moved to Node 24 (node:sqlite needs 22.5 or newer; this also clears the Node 20 deprecation warning) and now runs `npm test` plus a README placeholder check that fails on `your-username`, `<YOUR_GIT_URL>`, or `<YOUR_PROJECT_NAME>`.
- Added issue and pull request templates, CONTRIBUTING.md, SECURITY.md, and Dependabot (weekly npm updates for the backend).
- Root `.gitignore` now covers `data/`, the gap the account audit found.

### Measured results after the upgrade

- API probe, 57 checks against the live server: 57 pass. Browser E2E in headless Chrome, all 13 pages plus setup, prospect creation, CRM interactions and notes, goal creation, draft approval, kill switch, and logout: 19 checks, 19 pass, no console errors. `npm test`: 10 pass, 0 fail.
- API timing, 20 runs per endpoint: p50 1.4 to 3.0 ms, p95 2.6 to 6.9 ms. Before the upgrade: p50 1.0 to 1.9 ms, p95 1.3 to 12.0 ms. The difference is run-to-run noise, not a speedup. The API was already fast.
- Lighthouse 13.6.0, two real runs: first run setup 100/100/100/100 and dashboard 100/100/100/100; second run setup 99/100/100/100 and dashboard 95/100/100/100. All categories 90 or above.
- Bundle sizes: `app.min.js` 49,270 bytes (12,560 bytes gzipped on the wire), `styles.css` 19,814 bytes (5,119 bytes gzipped), `index.html` 29,943 bytes (6,832 bytes gzipped).

### Still pending

- The OpenRouter key is still not configured in the backend. Live AI verification (connection test, one strategist request, one draft of each type, fallback on a real 429) still needs Abd to paste his key into the app's Model Configuration page or set OPENROUTER_API_KEY in backend/.env.
- The "Not locked yet" section above is now stale: the visual documentation enhancement is done and pushed, and the promo video is done and delivered. Both are part of the repo state now.

### Unchanged by this upgrade

- Free-models-only chain, all 12 models, enforced at the same three layers. No paid model reference anywhere.
- Extension permissions and limits. No LinkedIn automation, scraping, or anything LinkedIn does not support.
- No secret, `.env`, database file, or node_modules in the changes. The project ships clean: no data directory, no `.env`.
