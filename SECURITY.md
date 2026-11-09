# Security Policy

## Reporting a vulnerability

Do not open a public issue for a security problem. Email the maintainer at saifullahrao089@gmail.com with a description of the issue and, if you can, steps to reproduce it. You will get a reply about what happens next.

## What is protected

- **Password**: scrypt hash with a random salt. The rule is 12 or more characters with upper and lower case, a digit, and a symbol, enforced at setup and at password change. Change the password in Settings; it signs out every other session. There is no password reset; if the password is lost, delete `backend/data/app.db` to reset the app to first-run setup, which also deletes all data.
- **Sessions**: random 32-byte bearer tokens with a 24 hour expiry, enforced on every authenticated route and on the auth status check. Logout deletes the server-side session row. An expired token is deleted when it is seen.
- **Login throttle**: after 5 failed logins from one address inside 60 seconds, login answers 429 without running a password check. A successful login clears the count.
- **Headers**: every response carries a strict content security policy (same origin only, no inline scripts or styles, no frames), X-Frame-Options DENY, X-Content-Type-Options nosniff, Referrer-Policy no-referrer, and a restrictive permissions policy.
- **CORS**: no CORS headers are emitted, so a page on another origin cannot read API responses. Auth is a Bearer token, not a cookie, so there is no ambient credential for a cross-site request to reuse.
- **Input validation**: prospect stage must be one of the 10 real stages, relevance score a whole number from 0 to 100, and text fields are type-checked and length-capped. AI inputs are capped at 20000 characters in total. All SQL uses parameters; dashboard output escapes user data.
- **Errors**: server errors return a generic message to the client; the real message goes to the server log and the error_log table only.
- **API key**: the OpenRouter key is server side only, written to `backend/.env` with mode 0600 enforced on every save, and never sent to the browser or logged.
- **Logs**: audit_log keeps the latest 1000 rows and error_log the latest 500, so neither grows without bound.

## What to know

- The app runs locally on your own machine. There is no hosted service and no data leaves your machine except calls to the OpenRouter API.
- This is a local single-user app, not a multi-user production service. There is no per-user separation, no account lockout beyond the login throttle, and no global rate limit. Never expose port 3000 to the internet.
- The kill switch stops AI generation and draft approval. It does not delete data.
- Never commit a `.env` file, a database file, or an API key. The `.gitignore` files cover them, but check before you push.
