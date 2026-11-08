// OpenRouter client. The API key is server side only: it lives in backend/.env
// as OPENROUTER_API_KEY and is never logged or returned to clients.
const fs = require('node:fs');
const path = require('node:path');
const { db, logError } = require('./db');

const ENV_PATH = path.join(__dirname, '.env');
const MODELS_URL = 'https://openrouter.ai/api/v1/models';
const AUTH_KEY_URL = 'https://openrouter.ai/api/v1/auth/key';
const CHAT_URL = 'https://openrouter.ai/api/v1/chat/completions';
const TIMEOUT_MS = 20000;

const SETUP_STEPS = [
  'Create an account at https://openrouter.ai and copy your API key.',
  'Open the app Settings and paste the key, or set OPENROUTER_API_KEY in backend/.env.',
  'Click Test connection, then retry your request.',
];

function readEnvFile() {
  try {
    return fs.readFileSync(ENV_PATH, 'utf8');
  } catch (err) {
    return '';
  }
}

function getKey() {
  if (process.env.OPENROUTER_API_KEY) return process.env.OPENROUTER_API_KEY.trim();
  const text = readEnvFile();
  const match = text.match(/^OPENROUTER_API_KEY=(.*)$/m);
  if (!match) return '';
  return match[1].trim().replace(/^["']|["']$/g, '');
}

function saveKey(key) {
  const text = readEnvFile();
  const line = `OPENROUTER_API_KEY=${key}`;
  let next;
  if (/^OPENROUTER_API_KEY=/m.test(text)) {
    next = text.replace(/^OPENROUTER_API_KEY=.*$/m, line);
  } else {
    next = text ? `${text.replace(/\n$/, '')}\n${line}\n` : `${line}\n`;
  }
  fs.writeFileSync(ENV_PATH, next, { mode: 0o600 });
  process.env.OPENROUTER_API_KEY = key;
  db.prepare('UPDATE model_config SET key_present = 1 WHERE id = 1').run();
}

function getConfig() {
  const row = db.prepare('SELECT * FROM model_config WHERE id = 1').get();
  return row || { primary_model: '', fallback_model: '', temperature: 0.7, max_tokens: 1000, key_present: 0 };
}

async function fetchWithTimeout(url, options, ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms || TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function testConnection() {
  const key = getKey();
  if (!key) return { ok: false, error: 'not_configured', setup: SETUP_STEPS };
  try {
    // The models list is public and does not check the key, so validate the
    // key first against the authenticated key endpoint. A bad key must fail.
    const authRes = await fetchWithTimeout(AUTH_KEY_URL, {
      headers: { Authorization: `Bearer ${key}` },
    });
    if (!authRes.ok) {
      const detail = authRes.status === 401
        ? 'OpenRouter rejected the API key (HTTP 401). Check the key and try again.'
        : `OpenRouter returned HTTP ${authRes.status}.`;
      logError('openrouter/test', detail);
      return { ok: false, error: 'openrouter_error', detail, setup: SETUP_STEPS };
    }
    const res = await fetchWithTimeout(MODELS_URL, {
      headers: { Authorization: `Bearer ${key}` },
    });
    if (!res.ok) {
      const detail = `OpenRouter returned HTTP ${res.status}.`;
      logError('openrouter/test', detail);
      return { ok: false, error: 'openrouter_error', detail, setup: SETUP_STEPS };
    }
    const data = await res.json();
    const count = Array.isArray(data.data) ? data.data.length : 0;
    return { ok: true, modelCount: count };
  } catch (err) {
    const detail = err.name === 'AbortError' ? 'Request timed out after 20 seconds.' : err.message;
    logError('openrouter/test', detail);
    return { ok: false, error: 'request_failed', detail, setup: SETUP_STEPS };
  }
}

async function listModels() {
  const key = getKey();
  if (!key) return { ok: false, error: 'not_configured', setup: SETUP_STEPS };
  try {
    const res = await fetchWithTimeout(MODELS_URL, {
      headers: { Authorization: `Bearer ${key}` },
    });
    if (!res.ok) {
      const detail = `OpenRouter returned HTTP ${res.status}.`;
      logError('openrouter/models', detail);
      return { ok: false, error: 'openrouter_error', detail };
    }
    const data = await res.json();
    const models = (Array.isArray(data.data) ? data.data : []).map((m) => {
      const promptPrice = m.pricing ? Number(m.pricing.prompt) : NaN;
      return { id: m.id, name: m.name || m.id, free: promptPrice === 0 };
    });
    return { ok: true, models };
  } catch (err) {
    const detail = err.name === 'AbortError' ? 'Request timed out after 20 seconds.' : err.message;
    logError('openrouter/models', detail);
    return { ok: false, error: 'request_failed', detail };
  }
}

function isRetryableStatus(status) {
  return status === 429 || status === 404 || status === 400 || status >= 500;
}

async function callModel(key, model, messages, temperature, maxTokens) {
  const res = await fetchWithTimeout(CHAT_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'http://localhost:3000',
      'X-Title': 'LinkedIn Intelligence and Growth Agent',
    },
    body: JSON.stringify({
      model,
      messages,
      temperature,
      max_tokens: maxTokens,
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    let message = `OpenRouter returned HTTP ${res.status}.`;
    try {
      const parsed = JSON.parse(text);
      if (parsed && parsed.error && parsed.error.message) message = String(parsed.error.message);
    } catch (err) {
      // Keep the plain HTTP message when the body is not JSON.
    }
    const err = new Error(message);
    err.status = res.status;
    err.detail = message;
    throw err;
  }
  const data = await res.json();
  const content = data && data.choices && data.choices[0] && data.choices[0].message
    ? data.choices[0].message.content
    : '';
  return String(content || '');
}

// Call chat completions with the primary model, retry once with the fallback
// on 429, timeout, or model unavailable. Returns { content, modelUsed }.
// Throws a structured error object { code, detail, status } on failure.
async function chatWithFallback(messages, opts) {
  const key = getKey();
  if (!key) {
    const err = new Error('No OpenRouter key configured.');
    err.code = 'not_configured';
    err.setup = SETUP_STEPS;
    throw err;
  }
  const config = getConfig();
  const primary = (opts && opts.primary) || config.primary_model;
  const fallback = (opts && opts.fallback) || config.fallback_model;
  const temperature = opts && opts.temperature != null ? opts.temperature : config.temperature;
  const maxTokens = opts && opts.max_tokens != null ? opts.max_tokens : config.max_tokens;
  try {
    const content = await callModel(key, primary, messages, temperature, maxTokens);
    return { content, modelUsed: primary };
  } catch (err) {
    const retryable = err.name === 'AbortError' || !err.status || isRetryableStatus(err.status);
    logError('openrouter/chat', `primary model ${primary} failed: ${err.message}`);
    if (!retryable || !fallback || fallback === primary) {
      const wrapped = new Error(err.message);
      wrapped.code = err.status === 429 ? 'rate_limited' : 'model_error';
      wrapped.detail = err.detail || err.message;
      wrapped.status = err.status || 502;
      throw wrapped;
    }
    try {
      const content = await callModel(key, fallback, messages, temperature, maxTokens);
      return { content, modelUsed: fallback };
    } catch (err2) {
      logError('openrouter/chat', `fallback model ${fallback} failed: ${err2.message}`);
      const wrapped = new Error(err2.message);
      wrapped.code = err2.status === 429 ? 'rate_limited' : 'model_error';
      wrapped.detail = err2.detail || err2.message;
      wrapped.status = err2.status || 502;
      throw wrapped;
    }
  }
}

// Extract a JSON object from model output, tolerating surrounding text.
function extractJson(text) {
  if (!text) return null;
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch (err) {
    return null;
  }
}

function validateStructured(parsed) {
  if (!parsed || typeof parsed !== 'object') return null;
  if (typeof parsed.recommendation !== 'string' || !parsed.recommendation.trim()) return null;
  if (parsed.evidence && !Array.isArray(parsed.evidence)) return null;
  return {
    recommendation: parsed.recommendation,
    reasoning: typeof parsed.reasoning === 'string' ? parsed.reasoning : '',
    evidence: Array.isArray(parsed.evidence) ? parsed.evidence.map((e) => ({
      type: String((e && e.type) || 'note'),
      ref: String((e && e.ref) || ''),
      detail: String((e && e.detail) || ''),
    })) : [],
    nextAction: typeof parsed.nextAction === 'string' ? parsed.nextAction : '',
    draft: typeof parsed.draft === 'string' ? parsed.draft : '',
  };
}

module.exports = {
  SETUP_STEPS,
  getKey,
  saveKey,
  getConfig,
  testConnection,
  listModels,
  chatWithFallback,
  extractJson,
  validateStructured,
  fetchWithTimeout,
};
