// background.js
// Service worker for LinkedIn Intelligence Assistant.
// Role: message routing, local storage, and calls to the user's own
// local backend. It holds no API key and never embeds an OpenRouter
// API key. The backend proxy holds any provider key. This worker
// never contacts LinkedIn or any LinkedIn API, never automates
// clicks, likes, connects, or sends, and never bypasses a CAPTCHA.

const KILL_SWITCH_KEY = "killSwitchOn";
const DRAFTS_KEY = "drafts";
const PROSPECTS_KEY = "prospects";
const NOTES_KEY = "relationshipNotes";
const SETTINGS_KEY = "settings";
const BACKEND_URL_KEY = "backendUrl";
const BACKEND_TOKEN_KEY = "backendAuthToken";

const DEFAULT_BACKEND_URL = "http://localhost:3000";

// Default user settings. These are the user's own saved settings,
// editable from the side panel. No secrets are stored here.
const DEFAULT_SETTINGS = {
  userName: "Saif Ullah",
  userRole: "Agentic AI Engineer",
  userCompany: "TechAurah",
  services: [
    "lead handling audit",
    "fixed AI build",
    "managed agent service"
  ],
  targets: [
    "US/UK startup founders",
    "CTOs",
    "AI professionals",
    "recruiters",
    "decision-makers"
  ]
};

async function getStored(key, fallback) {
  const result = await chrome.storage.local.get(key);
  if (result[key] === undefined) return fallback;
  return result[key];
}

async function isKillSwitchOn() {
  return await getStored(KILL_SWITCH_KEY, false);
}

async function getBackendConfig() {
  const url = await getStored(BACKEND_URL_KEY, DEFAULT_BACKEND_URL);
  const token = await getStored(BACKEND_TOKEN_KEY, "");
  const cleanUrl = String(url || DEFAULT_BACKEND_URL).trim().replace(/\/+$/, "");
  return {
    backendUrl: cleanUrl || DEFAULT_BACKEND_URL,
    hasToken: typeof token === "string" && token.trim().length > 0,
    token: typeof token === "string" ? token : ""
  };
}

async function ensureDefaults() {
  const settings = await getStored(SETTINGS_KEY, null);
  if (!settings) {
    await chrome.storage.local.set({ [SETTINGS_KEY]: DEFAULT_SETTINGS });
  }
  const kill = await getStored(KILL_SWITCH_KEY, null);
  if (kill === null) {
    await chrome.storage.local.set({ [KILL_SWITCH_KEY]: false });
  }
  const url = await getStored(BACKEND_URL_KEY, null);
  if (url === null) {
    await chrome.storage.local.set({ [BACKEND_URL_KEY]: DEFAULT_BACKEND_URL });
  }
}

chrome.runtime.onInstalled.addListener(async () => {
  await ensureDefaults();
});

chrome.runtime.onStartup.addListener(async () => {
  await ensureDefaults();
});

// Open the side panel when the extension action icon is clicked.
chrome.action.onClicked.addListener(async (tab) => {
  if (await isKillSwitchOn()) return;
  if (!tab || !tab.id) return;
  try {
    await chrome.sidePanel.open({ tabId: tab.id });
  } catch (err) {
    // Side panel open can fail if the tab is not a LinkedIn tab.
    // Log locally only; do not retry automatically.
    console.warn("Could not open side panel:", err && err.message ? err.message : err);
  }
});

// Call the local backend with the user's saved auth token.
// Returns { ok, status, data, error }. Never logs the token.
async function callBackend(path, body) {
  const config = await getBackendConfig();
  if (!config.hasToken) {
    return { ok: false, error: "backend_not_connected", detail: "No backend auth token is set. Paste your local backend token in the popup settings." };
  }
  let response;
  try {
    response = await fetch(config.backendUrl + path, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + config.token
      },
      body: JSON.stringify(body || {})
    });
  } catch (err) {
    return { ok: false, error: "backend_not_connected", detail: "Backend is not reachable at " + config.backendUrl + ". Start the local backend and check the URL in the popup settings." };
  }
  let data = null;
  try {
    data = await response.json();
  } catch (err) {
    data = null;
  }
  if (!response.ok) {
    return { ok: false, error: "backend_error", status: response.status, detail: "Backend returned HTTP " + response.status + ". Check the backend logs and your token." };
  }
  return { ok: true, status: response.status, data: data };
}

async function testBackend() {
  const config = await getBackendConfig();
  if (!config.hasToken) {
    return { ok: false, connected: false, error: "backend_not_connected", detail: "No backend auth token is set. Paste your local backend token in the popup settings." };
  }
  let response;
  try {
    response = await fetch(config.backendUrl + "/api/ai/chat", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + config.token
      },
      body: JSON.stringify({ task: "ping", pageType: "other", pageText: "" })
    });
  } catch (err) {
    return { ok: false, connected: false, error: "backend_not_connected", detail: "Backend is not reachable at " + config.backendUrl + ". Start the local backend and check the URL in the popup settings." };
  }
  if (!response.ok) {
    return { ok: false, connected: false, error: "backend_error", status: response.status, detail: "Backend returned HTTP " + response.status + ". Check the backend logs and your token." };
  }
  return { ok: true, connected: true, backendUrl: config.backendUrl };
}

function extractDraftText(data) {
  if (!data) return "";
  if (typeof data === "string") return data;
  if (typeof data.draft === "string") return data.draft;
  if (typeof data.text === "string") return data.text;
  if (typeof data.reply === "string") return data.reply;
  if (typeof data.message === "string") return data.message;
  if (typeof data.result === "string") return data.result;
  if (data.data && typeof data.data === "string") return data.data;
  if (data.data && typeof data.data.draft === "string") return data.data.draft;
  if (data.data && typeof data.data.text === "string") return data.data.text;
  return "";
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    if (!message || typeof message.type !== "string") {
      sendResponse({ ok: false, error: "Unknown message." });
      return;
    }

    // Kill switch check: when on, all actions are disabled.
    if (await isKillSwitchOn()) {
      if (message.type === "getKillSwitch") {
        sendResponse({ ok: true, killSwitchOn: true });
        return;
      }
      if (message.type === "setKillSwitch") {
        // Turning the kill switch off is the one action allowed while on.
        if (message.value === false) {
          await chrome.storage.local.set({ [KILL_SWITCH_KEY]: false });
          sendResponse({ ok: true, killSwitchOn: false });
        } else {
          sendResponse({ ok: true, killSwitchOn: true });
        }
        return;
      }
      sendResponse({ ok: false, error: "Kill switch is on. All actions are disabled." });
      return;
    }

    switch (message.type) {
      case "getKillSwitch": {
        sendResponse({ ok: true, killSwitchOn: false });
        break;
      }
      case "setKillSwitch": {
        const value = message.value === true;
        await chrome.storage.local.set({ [KILL_SWITCH_KEY]: value });
        sendResponse({ ok: true, killSwitchOn: value });
        break;
      }
      case "getSettings": {
        const settings = await getStored(SETTINGS_KEY, DEFAULT_SETTINGS);
        sendResponse({ ok: true, settings });
        break;
      }
      case "saveSettings": {
        const next = message.settings && typeof message.settings === "object"
          ? message.settings
          : DEFAULT_SETTINGS;
        await chrome.storage.local.set({ [SETTINGS_KEY]: next });
        sendResponse({ ok: true, settings: next });
        break;
      }
      case "getBackendConfig": {
        const config = await getBackendConfig();
        sendResponse({ ok: true, backendUrl: config.backendUrl, hasToken: config.hasToken });
        break;
      }
      case "saveBackendConfig": {
        const rawUrl = typeof message.backendUrl === "string" ? message.backendUrl.trim().replace(/\/+$/, "") : "";
        const nextUrl = rawUrl || DEFAULT_BACKEND_URL;
        const nextToken = typeof message.authToken === "string" ? message.authToken.trim() : "";
        await chrome.storage.local.set({ [BACKEND_URL_KEY]: nextUrl, [BACKEND_TOKEN_KEY]: nextToken });
        sendResponse({ ok: true, backendUrl: nextUrl, hasToken: nextToken.length > 0 });
        break;
      }
      case "testBackend": {
        const result = await testBackend();
        sendResponse(result);
        break;
      }
      case "getPageContext": {
        // Content script sends this after the user opens the panel.
        // The background worker only forwards it to the panel caller.
        sendResponse({ ok: true, received: true });
        break;
      }
      case "saveDraft": {
        if (!message.draft || typeof message.draft.text !== "string") {
          sendResponse({ ok: false, error: "No draft text provided." });
          break;
        }
        const drafts = await getStored(DRAFTS_KEY, []);
        const entry = {
          id: "draft-" + Date.now(),
          createdAt: new Date().toISOString(),
          kind: message.draft.kind || "draft",
          pageType: message.draft.pageType || "unknown",
          pageUrl: message.draft.pageUrl || "",
          sourceText: message.draft.sourceText || "",
          text: message.draft.text,
          status: "draft, awaiting manual confirmation"
        };
        drafts.push(entry);
        await chrome.storage.local.set({ [DRAFTS_KEY]: drafts });
        sendResponse({ ok: true, id: entry.id });
        break;
      }
      case "getDrafts": {
        const drafts = await getStored(DRAFTS_KEY, []);
        sendResponse({ ok: true, drafts });
        break;
      }
      case "saveProspect": {
        if (!message.prospect || typeof message.prospect.name !== "string") {
          sendResponse({ ok: false, error: "No prospect name provided." });
          break;
        }
        // Save Prospect writes to the backend database through
        // POST /api/prospects with the auth token. If the backend
        // is down or no token is set, report that clearly and do
        // not claim the prospect was saved.
        const settings = await getStored(SETTINGS_KEY, DEFAULT_SETTINGS);
        const result = await callBackend("/api/prospects", {
          name: message.prospect.name,
          headline: message.prospect.headline || "",
          pageUrl: message.prospect.pageUrl || "",
          pageType: message.prospect.pageType || "profile",
          sourceText: message.prospect.sourceText || "",
          notes: message.prospect.notes || "",
          user: settings
        });
        if (!result.ok) {
          sendResponse({ ok: false, error: result.error || "backend_error", detail: result.detail || "Backend not connected." });
          break;
        }
        const prospects = await getStored(PROSPECTS_KEY, []);
        const entry = {
          id: "prospect-" + Date.now(),
          createdAt: new Date().toISOString(),
          name: message.prospect.name,
          headline: message.prospect.headline || "",
          pageUrl: message.prospect.pageUrl || "",
          pageType: message.prospect.pageType || "profile",
          sourceText: message.prospect.sourceText || "",
          notes: message.prospect.notes || "",
          backend: result.data || null
        };
        prospects.push(entry);
        await chrome.storage.local.set({ [PROSPECTS_KEY]: prospects });
        sendResponse({ ok: true, id: entry.id, backend: result.data || null });
        break;
      }
      case "getProspects": {
        const prospects = await getStored(PROSPECTS_KEY, []);
        sendResponse({ ok: true, prospects });
        break;
      }
      case "saveNotes": {
        if (!message.key || typeof message.notes !== "string") {
          sendResponse({ ok: false, error: "No note key or text provided." });
          break;
        }
        const notes = await getStored(NOTES_KEY, {});
        notes[message.key] = {
          text: message.notes,
          updatedAt: new Date().toISOString(),
          pageUrl: message.pageUrl || ""
        };
        await chrome.storage.local.set({ [NOTES_KEY]: notes });
        sendResponse({ ok: true });
        break;
      }
      case "getNotes": {
        const notes = await getStored(NOTES_KEY, {});
        sendResponse({ ok: true, notes });
        break;
      }
      case "requestGeneration": {
        // Generation goes through the local backend proxy:
        // POST /api/ai/chat (and task endpoints on the same backend).
        // The extension sends only visible page text the user is
        // already viewing plus the user's own saved settings.
        // It makes no provider call itself and holds no API key.
        // If the backend is down or no token is set, return the
        // backend_not_connected state. Never invent a draft here.
        const settings = await getStored(SETTINGS_KEY, DEFAULT_SETTINGS);
        const task = typeof message.task === "string" ? message.task : "chat";
        const result = await callBackend("/api/ai/chat", {
          task: task,
          pageType: message.pageType || "unknown",
          pageUrl: message.pageUrl || "",
          pageText: typeof message.pageText === "string" ? message.pageText : "",
          sourceText: typeof message.sourceText === "string" ? message.sourceText : "",
          settings: settings,
          user: settings
        });
        if (!result.ok) {
          sendResponse({ ok: false, error: result.error || "backend_error", detail: result.detail || "Backend not connected." });
          break;
        }
        const draftText = extractDraftText(result.data);
        if (!draftText) {
          sendResponse({ ok: false, error: "backend_error", detail: "Backend replied without a draft. Check the backend logs." });
          break;
        }
        sendResponse({ ok: true, task: task, draft: draftText, data: result.data });
        break;
      }
      default: {
        sendResponse({ ok: false, error: "Unknown message type: " + message.type });
        break;
      }
    }
  })();
  // Keep the message channel open for the async reply.
  return true;
});
