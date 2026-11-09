# Security Policy

## Reporting a vulnerability

Do not open a public issue for a security problem. Email the maintainer at saifullahrao089@gmail.com with a description of the issue and, if you can, steps to reproduce it. You will get a reply about what happens next.

## What to know

- The app runs locally on your own machine. There is no hosted service and no data leaves your machine except calls to the OpenRouter API.
- The OpenRouter API key is stored server side only, in `backend/.env`, and is never sent to the browser or logged.
- Passwords are hashed with scrypt. Session tokens are random 32-byte values stored in the local database.
- The kill switch stops AI generation and draft approval. It does not delete data.
- Never commit a `.env` file, a database file, or an API key. The `.gitignore` files cover them, but check before you push.
