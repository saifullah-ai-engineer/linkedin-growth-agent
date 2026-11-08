# LinkedIn Intelligence Assistant

A Chrome extension (Manifest V3) for the LinkedIn Intelligence and Growth Agent. It is a contextual drafting assistant, not an automation tool.

## What it does

- Detects the LinkedIn page you are viewing: profile, feed post, company page, or messaging.
- Reads only visible text you are already viewing on that page: profile name, headline, about text, post text, or conversation text.
- Sends that visible text, plus your own saved settings, to your local backend for drafting.
- Shows each draft in the side panel for your review. You must confirm you reviewed it before it can be copied.
- Saves prospects to your backend database through POST /api/prospects.
- Saves drafts and relationship notes in chrome.storage.local on this device.

Your profile used for drafting context: Saif Ullah, Agentic AI Engineer at TechAurah. Services: lead handling audit, fixed AI build, managed agent service. Targets: US/UK startup founders, CTOs, AI professionals, recruiters, decision-makers.

## Files

- manifest.json: Manifest V3, permissions activeTab, storage, sidePanel. Host permissions for https://www.linkedin.com/* and http://localhost:3000/*
- background.js: service worker. Routes messages, stores drafts, prospects, and notes locally, and calls the local backend with your saved auth token. It holds no API key.
- content.js: detects page type and reads visible text only, only when the panel or popup asks.
- popup.html and popup.js: current page type, kill switch toggle, backend base URL and auth token settings, test connection, open side panel.
- sidepanel.html and sidepanel.js: contextual assistant panel with Analyze Profile, Explain Relevance, Draft Connection Message, Generate Comment, Summarize Conversation, Suggest Follow-up, Save Prospect, and Add Relationship Notes.

## Install steps

1. Open Chrome and go to chrome://extensions
2. Turn on Developer mode (top right).
3. Click Load unpacked.
4. Select this folder: linkedin-growth-agent/extension
5. The extension icon appears in the Chrome toolbar. Pin it if you want it visible.
6. Open https://www.linkedin.com/ and click the extension icon, then Open side panel.

To update after editing files, go to chrome://extensions and press Reload on the extension card.

## Backend setup steps

The extension does not generate drafts on its own. Drafts come from your local backend proxy.

1. Start your local backend. Default base URL is http://localhost:3000
2. Make sure the backend provides these endpoints:
   - POST /api/ai/chat (and task endpoints on the same backend) for drafting. It accepts a JSON body with task, pageType, pageUrl, pageText, sourceText, and settings, and returns a draft in one of these fields: draft, text, reply, message, or result.
   - POST /api/prospects for saving a prospect. It accepts name, headline, pageUrl, pageType, sourceText, and notes.
3. Get your local backend auth token from your backend setup. The extension never embeds an OpenRouter API key, and no provider key belongs in this extension.
4. Click the extension icon to open the popup.
5. Set Backend base URL (default http://localhost:3000) and paste your Backend auth token. The token is stored only in chrome.storage.local on this device.
6. Press Save backend settings, then Test backend connection.
7. Open the side panel and press Check backend. It should show Backend: connected.

If the backend is down or no token is set, the side panel shows a clear backend not connected state with setup steps, drafting buttons are disabled, and no pretend answer is generated.

### Changing the backend origin

The backend base URL is configurable in the popup, but Chrome Manifest V3 host permissions are fixed in manifest.json. The manifest already allows http://localhost:3000/* . If your backend runs on a different origin, add that origin to host_permissions in manifest.json, for example "https://your-backend.example/*", then reload the extension at chrome://extensions. Do not add origins you do not control.

## Compliance limits

- No automation: the extension never clicks, likes, connects, sends messages, or posts for you.
- No bulk actions: every action is one manual press for the page you are viewing.
- No scraping hidden data: only visible text on the page you are already viewing is read.
- No LinkedIn API contact: the extension never contacts LinkedIn or any LinkedIn API.
- No API keys in the extension: no OpenRouter or provider key is embedded or stored here. The backend proxy holds any provider key.
- Manual confirmation required: every draft must be reviewed and confirmed in the panel before it can be copied. Copying does not send anything. You paste and send manually, in your own words, if you choose to.
- Kill switch: turn it on in the popup to disable all extension actions. Turning it off again re-enables them.
- No CAPTCHA bypass: if LinkedIn shows a check, stop and do not try to work around it.
- Local data only: drafts, notes, backend URL, and the auth token live in chrome.storage.local. Prospects go to your own backend database through POST /api/prospects.
- No invented stats or results: drafts are based on the visible page text shown in the panel and your saved settings. Check every draft before you use it.
