# Contributing

## How to run it

```bash
cd backend
npm install
node server.js
```

Open http://localhost:3000, set a password on first run, and sign in.

## Before you send a change

1. Run the tests: `npm test` from the `backend` directory.
2. Rebuild the dashboard bundle if you touched the frontend: `npm run build` from `backend`. The committed `app.min.js` must match a fresh build, or CI fails.
3. Check your code with `node --check` on every file you changed.
4. Start the backend from a clean data directory and check the page or route you changed by hand.

## Rules that do not change

- Free OpenRouter models only. Never add a paid model anywhere, in code, config, or docs.
- No LinkedIn automation, scraping, or anything LinkedIn does not support. The extension reads only visible page text and drafts only. Every draft needs manual approval.
- Never invent data, statistics, or features. If the app has no data, say so in the UI.
- Never commit a secret, a `.env` file, `node_modules`, or a database file.
- Keep the honest limits in the README accurate. If a feature does not work yet, the README must say so.

## Reporting a problem

Open an issue with the bug report template. For a security problem, follow SECURITY.md instead of opening a public issue.
