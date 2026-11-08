// popup.js
// Small popup: shows current page type, kill switch toggle,
// backend base URL and auth token settings, and a button to
// open the side panel. No automation here.

const pageTypeEl = document.getElementById("pageType");
const pageUrlEl = document.getElementById("pageUrl");
const killEl = document.getElementById("killSwitch");
const killNoteEl = document.getElementById("killNote");
const openBtn = document.getElementById("openPanel");
const refreshBtn = document.getElementById("refresh");
const backendUrlEl = document.getElementById("backendUrl");
const authTokenEl = document.getElementById("authToken");
const saveBackendBtn = document.getElementById("saveBackend");
const testBackendBtn = document.getElementById("testBackend");
const backendStatusEl = document.getElementById("backendStatus");

const DEFAULT_BACKEND_URL = "http://localhost:3000";

async function loadKillSwitch() {
  const res = await chrome.runtime.sendMessage({ type: "getKillSwitch" });
  const on = !!(res && res.killSwitchOn);
  killEl.checked = on;
  openBtn.disabled = on;
  killNoteEl.textContent = on
    ? "Kill switch is ON. All extension actions are disabled."
    : "When the kill switch is on, all extension actions are disabled.";
  return on;
}

async function loadBackendConfig() {
  const res = await chrome.runtime.sendMessage({ type: "getBackendConfig" });
  if (res && res.ok) {
    backendUrlEl.value = res.backendUrl || DEFAULT_BACKEND_URL;
    backendStatusEl.textContent = res.hasToken
      ? "Backend: token saved for " + (res.backendUrl || DEFAULT_BACKEND_URL) + ". Press Test backend connection to verify."
      : "Backend: no auth token set. Paste your local backend token above.";
  } else {
    backendUrlEl.value = DEFAULT_BACKEND_URL;
    backendStatusEl.textContent = "Backend: could not load settings.";
  }
}

async function loadPageInfo() {
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const tab = tabs && tabs[0];
    if (!tab || !tab.url) {
      pageTypeEl.textContent = "Page: no active tab found.";
      pageUrlEl.textContent = "";
      return;
    }
    pageUrlEl.textContent = tab.url;
    if (!tab.url.startsWith("https://www.linkedin.com/")) {
      pageTypeEl.textContent = "Page: not a LinkedIn page. Open LinkedIn to use the assistant.";
      return;
    }
    const res = await chrome.tabs.sendMessage(tab.id, { type: "getPageType" });
    if (res && res.ok) {
      pageTypeEl.textContent = "Page: " + res.pageType;
    } else {
      pageTypeEl.textContent = "Page: LinkedIn (type not detected yet, reload the page).";
    }
  } catch (err) {
    pageTypeEl.textContent = "Page: could not read this tab. Reload the LinkedIn page and try again.";
  }
}

killEl.addEventListener("change", async () => {
  const res = await chrome.runtime.sendMessage({ type: "setKillSwitch", value: killEl.checked });
  const on = !!(res && res.killSwitchOn);
  killEl.checked = on;
  openBtn.disabled = on;
  killNoteEl.textContent = on
    ? "Kill switch is ON. All extension actions are disabled."
    : "Kill switch is off. Actions are available.";
});

saveBackendBtn.addEventListener("click", async () => {
  const backendUrl = backendUrlEl.value.trim() || DEFAULT_BACKEND_URL;
  const authToken = authTokenEl.value.trim();
  const res = await chrome.runtime.sendMessage({ type: "saveBackendConfig", backendUrl: backendUrl, authToken: authToken });
  if (res && res.ok) {
    backendStatusEl.textContent = res.hasToken
      ? "Backend settings saved for " + res.backendUrl + ". Press Test backend connection to verify."
      : "Backend URL saved, but no auth token is set. Paste your token to connect.";
    authTokenEl.value = "";
  } else {
    backendStatusEl.textContent = "Could not save backend settings.";
  }
});

testBackendBtn.addEventListener("click", async () => {
  backendStatusEl.textContent = "Backend: testing connection...";
  const res = await chrome.runtime.sendMessage({ type: "testBackend" });
  if (res && res.ok && res.connected) {
    backendStatusEl.textContent = "Backend: connected at " + (res.backendUrl || backendUrlEl.value.trim() || DEFAULT_BACKEND_URL) + ".";
  } else {
    backendStatusEl.textContent = "Backend: not connected. " + ((res && res.detail) || "Check the URL and token, then start the local backend.");
  }
});

openBtn.addEventListener("click", async () => {
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const tab = tabs && tabs[0];
    if (!tab || !tab.id) return;
    await chrome.sidePanel.open({ tabId: tab.id });
    window.close();
  } catch (err) {
    pageTypeEl.textContent = "Could not open the side panel from this tab.";
  }
});

refreshBtn.addEventListener("click", async () => {
  await loadPageInfo();
  await loadKillSwitch();
  await loadBackendConfig();
});

document.addEventListener("DOMContentLoaded", async () => {
  await loadPageInfo();
  await loadKillSwitch();
  await loadBackendConfig();
});
