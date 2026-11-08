// sidepanel.js
// Contextual assistant panel. Backend driven drafting only.
// The extension sends visible page text the user is already viewing
// plus the user's own saved settings to the local backend proxy
// (POST /api/ai/chat and task endpoints). The backend holds any
// provider key. This panel holds no API key, makes no provider
// call, and never generates a pretend answer. If the backend is
// down or no token is set, it shows a clear backend not connected
// state and disables drafting. Every draft needs manual
// confirmation before it can be copied. Nothing is sent to
// LinkedIn automatically.

const USER = {
  name: "Saif Ullah",
  role: "Agentic AI Engineer",
  company: "TechAurah",
  services: ["lead handling audit", "fixed AI build", "managed agent service"],
  targets: ["US/UK startup founders", "CTOs", "AI professionals", "recruiters", "decision-makers"]
};

// Backend task names sent to POST /api/ai/chat.
const TASK_FOR_ACTION = {
  analyze: "analyze-profile",
  relevance: "explain-relevance",
  connect: "draft-connection-message",
  comment: "generate-comment",
  summarize: "summarize-conversation",
  followup: "suggest-follow-up"
};

let currentContext = null;
let currentDraftKind = "";
let currentDraftText = "";
let backendConnected = false;
let backendUrl = "http://localhost:3000";

const pageInfoEl = document.getElementById("pageInfo");
const killStatusEl = document.getElementById("killStatus");
const backendBoxEl = document.getElementById("backendBox");
const sourceTextEl = document.getElementById("sourceText");
const draftOutputEl = document.getElementById("draftOutput");
const statusEl = document.getElementById("status");
const confirmEl = document.getElementById("confirmReview");
const copyBtn = document.getElementById("copyDraft");
const saveDraftBtn = document.getElementById("saveDraft");

function setStatus(text) {
  statusEl.textContent = text || "";
}

function snippet(text, limit) {
  const value = (text || "").replace(/\s+/g, " ").trim();
  if (!value) return "";
  return value.length > limit ? value.slice(0, limit) + "..." : value;
}

function sourceSummary(ctx) {
  if (!ctx) return "";
  const parts = [];
  if (ctx.name) parts.push("Name: " + ctx.name);
  if (ctx.author) parts.push("Author: " + ctx.author);
  if (ctx.headline) parts.push("Headline: " + ctx.headline);
  if (ctx.tagline) parts.push("Tagline: " + ctx.tagline);
  if (ctx.about) parts.push("About: " + ctx.about);
  if (ctx.postText) parts.push("Post: " + ctx.postText);
  if (ctx.conversationText) parts.push("Conversation: " + ctx.conversationText);
  if (ctx.visibleText) parts.push("Visible page text: " + ctx.visibleText);
  return parts.join("\n\n");
}

function setDraft(kind, text) {
  currentDraftKind = kind;
  currentDraftText = text;
  draftOutputEl.textContent = text;
  confirmEl.checked = false;
  copyBtn.disabled = true;
  setStatus("Draft ready for your review. Confirm below before copying.");
}

function showBackendNotConnected(detail) {
  backendConnected = false;
  backendBoxEl.classList.remove("ok");
  backendBoxEl.innerHTML = "<strong>Backend: not connected</strong>"
    + "<p>" + (detail || "Drafts come from your local backend. No draft will be generated until the backend is connected.") + "</p>"
    + "<p>Setup steps:<br>1. Start your local backend (default http://localhost:3000).<br>2. Open the extension popup and set the backend base URL.<br>3. Paste your local backend auth token in the popup.<br>4. Press Test backend connection in the popup, then press Check backend below.</p>";
  updateActionButtons();
}

function showBackendConnected(url) {
  backendConnected = true;
  backendUrl = url || backendUrl;
  backendBoxEl.classList.add("ok");
  backendBoxEl.innerHTML = "<strong>Backend: connected</strong>"
    + "<p>Connected to " + backendUrl + ". Drafts come from your local backend.</p>";
  updateActionButtons();
}

function updateActionButtons() {
  const disabled = !backendConnected;
  document.querySelectorAll(".actions button").forEach((btn) => {
    // Save Prospect and Notes need the backend or local notes;
    // drafting actions need the backend. Keep all actions gated
    // on the backend state except Add Relationship Notes, which
    // is local only. Save Prospect needs the backend.
    if (btn.dataset.action === "notes") {
      btn.disabled = false;
    } else {
      btn.disabled = disabled;
    }
  });
  copyBtn.disabled = disabled || !(confirmEl.checked && currentDraftText);
  saveDraftBtn.disabled = disabled && !currentDraftText;
}

async function checkBackend() {
  setStatus("Checking backend connection...");
  const res = await chrome.runtime.sendMessage({ type: "testBackend" });
  if (res && res.ok && res.connected) {
    showBackendConnected(res.backendUrl);
    setStatus("Backend connected.");
    return true;
  }
  showBackendNotConnected((res && res.detail) || "Backend is not reachable. Start the local backend and check the URL and token in the popup settings.");
  setStatus("Backend not connected. No draft was generated.");
  return false;
}

confirmEl.addEventListener("change", () => {
  copyBtn.disabled = !backendConnected || !(confirmEl.checked && currentDraftText);
});

async function loadContext() {
  setStatus("Reading visible page text...");
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const tab = tabs && tabs[0];
    if (!tab || !tab.id || !tab.url || !tab.url.startsWith("https://www.linkedin.com/")) {
      pageInfoEl.textContent = "Page: not a LinkedIn page. Open a LinkedIn profile, post, company page, or conversation.";
      sourceTextEl.textContent = "No LinkedIn page text available.";
      setStatus("");
      return;
    }
    const res = await chrome.tabs.sendMessage(tab.id, { type: "getPageContext" });
    if (!res || !res.ok || !res.context) {
      pageInfoEl.textContent = "Page: could not read visible text. Reload the LinkedIn page and try again.";
      setStatus("");
      return;
    }
    currentContext = res.context;
    pageInfoEl.textContent = "Page: " + currentContext.pageType + " | " + currentContext.url;
    const summary = sourceSummary(currentContext);
    sourceTextEl.textContent = summary || "No readable visible text on this page.";
    setStatus("Page text loaded. Choose an action.");
  } catch (err) {
    pageInfoEl.textContent = "Page: could not read visible text. Reload the LinkedIn page and try again.";
    setStatus("");
  }
}

async function loadKillSwitch() {
  const res = await chrome.runtime.sendMessage({ type: "getKillSwitch" });
  const on = !!(res && res.killSwitchOn);
  killStatusEl.textContent = on
    ? "Kill switch is ON. All actions are disabled. Turn it off in the popup."
    : "Kill switch is off.";
  if (on) {
    document.querySelectorAll(".actions button").forEach((btn) => { btn.disabled = true; });
    copyBtn.disabled = true;
    saveDraftBtn.disabled = true;
  }
  return on;
}

async function handleAction(action) {
  if (await loadKillSwitch()) {
    setStatus("Kill switch is on. All actions are disabled.");
    return;
  }
  if (action === "notes") {
    const key = document.getElementById("noteKey").value.trim() || (currentContext && (currentContext.name || currentContext.author)) || "";
    document.getElementById("noteKey").value = key;
    document.getElementById("noteText").focus();
    setStatus(key ? "Add notes for " + key + " below, then press Save notes locally." : "Enter a name above, add notes, then press Save notes locally.");
    return;
  }
  if (!backendConnected) {
    const connected = await checkBackend();
    if (!connected) {
      setStatus("Backend not connected. No draft was generated.");
      return;
    }
  }
  if (!currentContext) {
    await loadContext();
    if (!currentContext) {
      setStatus("Load a LinkedIn page first.");
      return;
    }
  }
  if (action === "saveProspect") {
    await saveProspect(currentContext);
    return;
  }
  const task = TASK_FOR_ACTION[action];
  if (!task) {
    setStatus("Unknown action.");
    return;
  }
  setStatus("Asking your local backend for a draft...");
  draftOutputEl.textContent = "Waiting for your local backend...";
  const res = await chrome.runtime.sendMessage({
    type: "requestGeneration",
    task: task,
    pageType: currentContext.pageType || "unknown",
    pageUrl: currentContext.url || "",
    pageText: sourceSummary(currentContext).slice(0, 4000),
    sourceText: sourceSummary(currentContext).slice(0, 4000)
  });
  if (!res || !res.ok) {
    draftOutputEl.textContent = "No draft generated. Backend not connected.";
    showBackendNotConnected((res && res.detail) || "Backend is not reachable. Start the local backend and check the URL and token in the popup settings.");
    setStatus("Backend not connected. No draft was generated.");
    return;
  }
  setDraft(task, res.draft);
}

async function saveProspect(ctx) {
  const name = ctx.name || ctx.author || "";
  if (!name) {
    setStatus("No prospect name visible on this page. Save Prospect needs a visible name.");
    return;
  }
  setStatus("Saving prospect to your backend...");
  const res = await chrome.runtime.sendMessage({
    type: "saveProspect",
    prospect: {
      name: name,
      headline: ctx.headline || ctx.tagline || "",
      pageUrl: ctx.url || "",
      pageType: ctx.pageType || "profile",
      sourceText: sourceSummary(ctx).slice(0, 2000),
      notes: ""
    }
  });
  if (res && res.ok) setStatus("Prospect saved to backend: " + name + ".");
  else {
    showBackendNotConnected((res && res.detail) || "Backend is not reachable. Start the local backend and check the URL and token in the popup settings.");
    setStatus("Prospect was not saved. " + ((res && res.detail) || "Backend not connected."));
  }
}

document.querySelectorAll(".actions button").forEach((btn) => {
  btn.addEventListener("click", () => handleAction(btn.dataset.action));
});

document.getElementById("refreshContext").addEventListener("click", loadContext);
document.getElementById("checkBackend").addEventListener("click", checkBackend);

copyBtn.addEventListener("click", async () => {
  if (!confirmEl.checked || !currentDraftText) {
    setStatus("Confirm you reviewed the draft before copying.");
    return;
  }
  try {
    await navigator.clipboard.writeText(currentDraftText);
    setStatus("Draft copied. Paste it manually where you choose. Nothing was sent.");
  } catch (err) {
    setStatus("Copy failed in this panel. Select the draft text and copy it manually.");
  }
});

saveDraftBtn.addEventListener("click", async () => {
  if (!currentDraftText) {
    setStatus("No draft to save yet. Choose an action first.");
    return;
  }
  const res = await chrome.runtime.sendMessage({
    type: "saveDraft",
    draft: {
      kind: currentDraftKind || "draft",
      pageType: currentContext ? currentContext.pageType : "unknown",
      pageUrl: currentContext ? currentContext.url : "",
      sourceText: sourceSummary(currentContext).slice(0, 2000),
      text: currentDraftText
    }
  });
  if (res && res.ok) setStatus("Draft saved locally.");
  else setStatus("Could not save draft: " + ((res && res.error) || "unknown error."));
});

document.getElementById("saveNotes").addEventListener("click", async () => {
  const key = document.getElementById("noteKey").value.trim();
  const notes = document.getElementById("noteText").value.trim();
  if (!key || !notes) {
    setStatus("Enter both a name and notes before saving.");
    return;
  }
  const res = await chrome.runtime.sendMessage({
    type: "saveNotes",
    key: key,
    notes: notes,
    pageUrl: currentContext ? currentContext.url : ""
  });
  if (res && res.ok) setStatus("Notes saved locally for " + key + ".");
  else setStatus("Could not save notes: " + ((res && res.error) || "unknown error."));
});

document.addEventListener("DOMContentLoaded", async () => {
  await loadKillSwitch();
  await checkBackend();
  await loadContext();
  const settingsRes = await chrome.runtime.sendMessage({ type: "getSettings" });
  if (settingsRes && settingsRes.ok && settingsRes.settings) {
    const s = settingsRes.settings;
    const info = document.getElementById("settingsInfo");
    info.textContent = (s.userName || USER.name) + ", " + (s.userRole || USER.role) + " at " + (s.userCompany || USER.company) + ". Services: " + (s.services || USER.services).join(", ") + ". Targets: " + (s.targets || USER.targets).join(", ") + ".";
  }
});
