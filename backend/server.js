// LinkedIn Intelligence and Growth Agent backend.
// Express + built-in node:sqlite. No native dependencies. No LinkedIn API use.
const express = require('express');
const compression = require('compression');
const path = require('node:path');
const { db, audit, logError, getKillSwitch, setKillSwitch } = require('./db');
const auth = require('./auth');
const openrouter = require('./openrouter');
const strategist = require('./agents/strategist');

const app = express();
const PORT = process.env.PORT || 3000;
app.use(express.json({ limit: '1mb' }));
app.use(compression());

// Security headers on every response, including static files. The dashboard
// loads one local script and one local stylesheet and no external resource,
// so the content security policy can stay strict: same origin only, no
// inline scripts or styles, no frames, no plugins. No CORS headers are
// emitted anywhere, so a page on another origin cannot read API responses,
// and auth is a Bearer token rather than a cookie, so there is no ambient
// credential for a cross-site request to reuse.
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'"
  );
  next();
});

// Serve a valid robots.txt so crawlers and audits do not parse the HTML
// fallback. Access control for this local dashboard is the login, not
// robots.txt, so the file allows crawling; nothing here is public.
app.get('/robots.txt', (req, res) => {
  res.type('text/plain');
  res.send('User-agent: *\nAllow: /\n');
});
app.get('/favicon.ico', (req, res) => res.status(204).end());

// Frontend lives in backend/public/. Cache static assets for a day,
// but never cache index.html so a new deploy is picked up at once.
app.use(express.static(path.join(__dirname, 'public'), {
  maxAge: '1d',
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('index.html')) res.setHeader('Cache-Control', 'no-cache');
  },
}));

function notConfigured(res) {
  return res.status(503).json({ error: 'not_configured', code: 'not_configured', setup: openrouter.SETUP_STEPS });
}

function aiError(res, err) {
  if (err.code === 'not_configured') return notConfigured(res);
  logError('ai', err.message);
  const status = err.code === 'rate_limited' ? 429 : 502;
  return res.status(status).json({
    error: err.code || 'model_error',
    code: err.code || 'model_error',
    detail: err.detail || err.message,
  });
}

async function runAiOnce(messages) {
  const result = await openrouter.chatWithFallback(messages, {});
  let parsed = openrouter.validateStructured(openrouter.extractJson(result.content));
  if (!parsed) {
    const retry = await openrouter.chatWithFallback(messages, {});
    parsed = openrouter.validateStructured(openrouter.extractJson(retry.content));
    if (parsed) return { ...parsed, modelUsed: retry.modelUsed };
  } else {
    return { ...parsed, modelUsed: result.modelUsed };
  }
  logError('ai', 'Model returned invalid JSON twice.');
  const err = new Error('Model returned invalid JSON.');
  err.code = 'invalid_response';
  err.detail = 'The model did not return valid structured JSON after two attempts.';
  throw err;
}

function killSwitchOn(req, res) {
  if (getKillSwitch()) {
    res.status(403).json({ error: 'kill_switch_on' });
    return true;
  }
  return false;
}

// Auth
app.get('/api/auth/status', (req, res) => {
  const setupNeeded = auth.getUserCount() === 0;
  const token = auth.getBearerToken(req);
  // An expired token counts as logged out; getSession deletes it.
  const loggedIn = !!token && !!auth.getSession(token);
  res.json({ setupNeeded, loggedIn });
});

app.post('/api/auth/setup', (req, res) => {
  if (auth.getUserCount() > 0) {
    return res.status(400).json({ error: 'setup_disabled', detail: 'Setup is already complete.' });
  }
  const password = req.body && req.body.password;
  const weak = auth.validatePassword(password);
  if (weak) {
    return res.status(400).json({ error: 'invalid_password', detail: weak });
  }
  db.prepare('INSERT INTO users (password_hash) VALUES (?)').run(auth.hashPassword(password));
  const user = db.prepare('SELECT id FROM users ORDER BY id LIMIT 1').get();
  const token = auth.createSession(user.id);
  audit('auth_setup', 'First user created.');
  res.json({ ok: true, token });
});

// Change password. The current password must be right, the new one must
// pass the same strength rule as setup, and every other session is signed
// out so a stolen token stops working as soon as the password changes.
// The session that made the request stays valid.
app.post('/api/auth/change-password', auth.requireAuth, async (req, res) => {
  const body = req.body || {};
  const current = body.current_password;
  const next = body.new_password;
  if (typeof current !== 'string' || typeof next !== 'string') {
    return res.status(400).json({ error: 'invalid_request', detail: 'Current password and new password are required.' });
  }
  const user = db.prepare('SELECT * FROM users ORDER BY id LIMIT 1').get();
  if (!user || !(await auth.verifyPasswordAsync(current, user.password_hash))) {
    audit('password_change_failed', 'Change password rejected: wrong current password.');
    return res.status(401).json({ error: 'invalid_credentials', detail: 'Current password is wrong.' });
  }
  const weak = auth.validatePassword(next);
  if (weak) {
    return res.status(400).json({ error: 'invalid_password', detail: weak });
  }
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(auth.hashPassword(next), user.id);
  db.prepare('DELETE FROM sessions WHERE token != ?').run(req.token);
  audit('password_change', 'Password changed. Other sessions signed out.');
  res.json({ ok: true });
});

// Failed-login throttle. Async scrypt keeps the event loop free, but 50
// wrong passwords at once still saturate the CPUs with hash work and slow
// every other request. After 5 failed attempts from one address inside 60
// seconds, login answers 429 without running a password check at all. A
// successful login clears the count. In memory only; a restart resets it.
const LOGIN_WINDOW_MS = 60 * 1000;
const LOGIN_MAX_FAILURES = 5;
const loginFailures = new Map();
function loginRetryAfterSeconds(ip) {
  const entry = loginFailures.get(ip);
  if (!entry) return 0;
  const age = Date.now() - entry.firstAt;
  if (age > LOGIN_WINDOW_MS) {
    loginFailures.delete(ip);
    return 0;
  }
  if (entry.count < LOGIN_MAX_FAILURES) return 0;
  return Math.ceil((LOGIN_WINDOW_MS - age) / 1000);
}
function recordLoginFailure(ip) {
  const now = Date.now();
  const entry = loginFailures.get(ip);
  if (!entry || now - entry.firstAt > LOGIN_WINDOW_MS) loginFailures.set(ip, { count: 1, firstAt: now });
  else entry.count += 1;
}

app.post('/api/auth/login', async (req, res) => {
  const retryAfter = loginRetryAfterSeconds(req.ip);
  if (retryAfter > 0) {
    res.set('Retry-After', String(retryAfter));
    return res.status(429).json({ error: 'too_many_attempts', detail: `Too many failed login attempts. Try again in ${retryAfter} seconds.`, retry_after: retryAfter });
  }
  // Count the attempt up front, before the password check runs. Counting
  // only after a failed check lets a simultaneous burst slip through,
  // because every request in the burst passes the check before any of
  // them has finished hashing. A successful login clears the count.
  recordLoginFailure(req.ip);
  const password = req.body && req.body.password;
  const user = db.prepare('SELECT * FROM users ORDER BY id LIMIT 1').get();
  // Password checks run async so a flood of wrong passwords cannot block
  // the event loop and freeze the whole app for seconds at a time.
  if (!user || typeof password !== 'string' || !(await auth.verifyPasswordAsync(password, user.password_hash))) {
    audit('login_failed', 'Failed login attempt.');
    return res.status(401).json({ error: 'invalid_credentials', detail: 'Wrong password.' });
  }
  loginFailures.delete(req.ip);
  const token = auth.createSession(user.id);
  res.json({ token });
});

app.post('/api/auth/logout', auth.requireAuth, (req, res) => {
  db.prepare('DELETE FROM sessions WHERE token = ?').run(req.token);
  res.json({ ok: true });
});

// Config
app.get('/api/config', auth.requireAuth, (req, res) => {
  const config = openrouter.getConfig();
  res.json({
    primary_model: config.primary_model,
    fallback_model: config.fallback_model,
    temperature: config.temperature,
    max_tokens: config.max_tokens,
    keyConfigured: !!openrouter.getKey(),
  });
});

app.put('/api/config', auth.requireAuth, (req, res) => {
  const body = req.body || {};
  const config = openrouter.getConfig();
  const primary = typeof body.primary_model === 'string' && body.primary_model ? body.primary_model : config.primary_model;
  const fallback = typeof body.fallback_model === 'string' && body.fallback_model ? body.fallback_model : config.fallback_model;
  // Paid models are never allowed. The app uses free models only.
  const isFree = (m) => typeof m === 'string' && m.endsWith(':free');
  if (!isFree(primary) || !isFree(fallback)) {
    return res.status(400).json({ error: 'paid_model_not_allowed', detail: 'Only free OpenRouter models are allowed. Pick a model ending in :free.' });
  }
  const temperature = typeof body.temperature === 'number' ? body.temperature : config.temperature;
  const maxTokens = typeof body.max_tokens === 'number' ? body.max_tokens : config.max_tokens;
  // The dashboard inputs allow temperature 0 to 2 and max tokens 100 to
  // 32000. Anything outside that range is a bad request, not a silent save.
  if (!Number.isFinite(temperature) || temperature < 0 || temperature > 2) {
    return res.status(400).json({ error: 'invalid_config', detail: 'Temperature must be a number between 0 and 2.' });
  }
  if (!Number.isInteger(maxTokens) || maxTokens < 100 || maxTokens > 32000) {
    return res.status(400).json({ error: 'invalid_config', detail: 'Max tokens must be a whole number between 100 and 32000.' });
  }
  db.prepare('UPDATE model_config SET primary_model = ?, fallback_model = ?, temperature = ?, max_tokens = ? WHERE id = 1')
    .run(primary, fallback, temperature, maxTokens);
  audit('config_change', `primary_model=${primary}, fallback_model=${fallback}, temperature=${temperature}, max_tokens=${maxTokens}`);
  res.json({ primary_model: primary, fallback_model: fallback, temperature, max_tokens: maxTokens, keyConfigured: !!openrouter.getKey() });
});

app.post('/api/config/key', auth.requireAuth, (req, res) => {
  const key = req.body && req.body.key;
  if (typeof key !== 'string' || !key.trim()) {
    return res.status(400).json({ error: 'invalid_key', detail: 'A non-empty key is required.' });
  }
  openrouter.saveKey(key.trim());
  audit('config_key_set', 'OpenRouter API key saved to backend/.env.');
  res.json({ ok: true, keyConfigured: true });
});

app.post('/api/config/test', auth.requireAuth, async (req, res) => {
  const result = await openrouter.testConnection();
  res.json(result);
});

app.get('/api/models', auth.requireAuth, async (req, res) => {
  const result = await openrouter.listModels();
  if (!result.ok) {
    if (result.error === 'not_configured') return notConfigured(res);
    return res.status(502).json({ error: result.error, detail: result.detail });
  }
  res.json({ models: result.models });
});

// AI proxy
app.post('/api/ai/chat', auth.requireAuth, async (req, res) => {
  const message = (req.body && req.body.message) || '';
  const task = (req.body && req.body.task) || '';
  const pastedText = (req.body && (req.body.pastedText || req.body.context)) || '';
  // Request shape is validated before the kill switch and the key check,
  // so a bad request is a 400 whatever the app state is.
  if (!message && !task && !pastedText) {
    return res.status(400).json({ error: 'invalid_request', detail: 'Provide a message, task, or pasted text.' });
  }
  if (aiInputTooLong(message, task, pastedText)) {
    return res.status(400).json({ error: 'invalid_request', detail: 'AI input must be at most 20000 characters in total.' });
  }
  if (killSwitchOn(req, res)) return;
  // Fail fast when no key is configured. Building the evidence prompt
  // reads every prospect and takes over 100 ms at 10k prospects, so it
  // must not run for a request that is about to fail with not_configured.
  if (!openrouter.getKey()) return notConfigured(res);
  const classification = strategist.classifyRequest(`${message} ${task}`);
  const system = strategist.buildSystemPrompt(classification);
  const userText = [`Task: ${task || 'general advice'}`, `User message: ${message}`, pastedText ? `User pasted text: ${pastedText}` : ''].filter(Boolean).join('\n');
  try {
    const parsed = await runAiOnce([
      { role: 'system', content: system },
      { role: 'user', content: userText },
    ]);
    res.json(parsed);
  } catch (err) {
    aiError(res, err);
  }
});

app.post('/api/ai/draft', auth.requireAuth, async (req, res) => {
  const type = (req.body && req.body.type) || 'general';
  const inputs = (req.body && req.body.inputs) || {};
  if (!isBoundedString(type, 100)) {
    return res.status(400).json({ error: 'invalid_request', detail: 'Draft type must be text of at most 100 characters.' });
  }
  if (aiInputTooLong(JSON.stringify(inputs))) {
    return res.status(400).json({ error: 'invalid_request', detail: 'AI input must be at most 20000 characters in total.' });
  }
  if (killSwitchOn(req, res)) return;
  if (!openrouter.getKey()) return notConfigured(res);
  const classification = strategist.classifyRequest(type);
  const system = [
    strategist.buildSystemPrompt(classification),
    `Draft type requested: ${type}. Put the finished draft text in the "draft" field of the JSON reply.`,
    'The draft must use only the evidence above and the inputs below. If the inputs do not give enough to draft, say so in the recommendation and ask for the missing input instead of inventing details.',
  ].join('\n');
  try {
    const parsed = await runAiOnce([
      { role: 'system', content: system },
      { role: 'user', content: `Draft inputs: ${JSON.stringify(inputs)}` },
    ]);
    res.json(parsed);
  } catch (err) {
    aiError(res, err);
  }
});

// Strategist and recommendations
app.post('/api/strategist', auth.requireAuth, async (req, res) => {
  const message = (req.body && req.body.message) || '';
  const pastedText = (req.body && (req.body.pastedText || req.body.context)) || '';
  if (!message) return res.status(400).json({ error: 'invalid_request', detail: 'Provide a message.' });
  if (aiInputTooLong(message, pastedText)) {
    return res.status(400).json({ error: 'invalid_request', detail: 'AI input must be at most 20000 characters in total.' });
  }
  if (killSwitchOn(req, res)) return;
  if (!openrouter.getKey()) return notConfigured(res);
  try {
    const result = await strategist.runStrategist(message, pastedText);
    res.json(result);
  } catch (err) {
    aiError(res, err);
  }
});

app.get('/api/recommendations', auth.requireAuth, (req, res) => {
  const rows = db.prepare('SELECT * FROM recommendations ORDER BY created_at DESC').all();
  res.json(rows.map((r) => ({ ...r, evidence: r.evidence_json ? JSON.parse(r.evidence_json) : [] })));
});

app.post('/api/recommendations/:id/feedback', auth.requireAuth, (req, res) => {
  const status = req.body && req.body.status;
  if (!['done', 'ignored', 'not_useful'].includes(status)) {
    return res.status(400).json({ error: 'invalid_status', detail: 'Status must be done, ignored, or not_useful.' });
  }
  const info = db.prepare('UPDATE recommendations SET status = ? WHERE id = ?').run(status, req.params.id);
  if (info.changes === 0) return res.status(404).json({ error: 'not_found' });
  audit('recommendation_feedback', `recommendation ${req.params.id} marked ${status}`);
  res.json({ ok: true, id: Number(req.params.id), status });
});

// Prospects
const PROSPECT_FIELDS = ['name', 'profile_url', 'company', 'title', 'industry', 'expertise', 'source', 'relevance_score', 'relevance_reason', 'opportunity', 'stage', 'notes', 'last_interaction', 'next_action', 'follow_up_date'];
const PROSPECT_STAGES = ['Target', 'Research', 'Connection Requested', 'Connected', 'Conversation', 'Qualified Opportunity', 'Meeting', 'Proposal', 'Won', 'Lost'];
const MAX_TEXT_LEN = 2000;

// Every value that reaches the database is checked for type and length
// first, so a wrong type or an oversized value is a 400, never a row with
// junk in it.
function isBoundedString(v, max) {
  return typeof v === 'string' && v.length <= (max || MAX_TEXT_LEN);
}

function validateProspect(data) {
  for (const field of PROSPECT_FIELDS) {
    const value = data[field];
    if (value === undefined || value === null) continue;
    if (field === 'relevance_score') {
      if (!Number.isInteger(value) || value < 0 || value > 100) {
        return 'Relevance score must be a whole number between 0 and 100.';
      }
      continue;
    }
    if (!isBoundedString(value)) return `Field ${field} must be text of at most ${MAX_TEXT_LEN} characters.`;
  }
  if (data.stage !== undefined && data.stage !== null && !PROSPECT_STAGES.includes(data.stage)) {
    return 'Stage must be one of: ' + PROSPECT_STAGES.join(', ') + '.';
  }
  return null;
}

// AI inputs are bounded so one request cannot push an unbounded prompt
// into the model. The limit is generous for a real message and still caps
// the cost of a careless or hostile one.
const MAX_AI_INPUT_LEN = 20000;
function aiInputTooLong(...parts) {
  return parts.reduce((n, p) => n + (typeof p === 'string' ? p.length : 0), 0) > MAX_AI_INPUT_LEN;
}

function prospectFromBody(body) {
  const out = {};
  for (const field of PROSPECT_FIELDS) {
    if (body[field] !== undefined) out[field] = body[field];
  }
  return out;
}

// Optional ?limit= and ?offset= for list endpoints. No limit means the
// whole list, exactly as before. A bad value is a 400, not a silent default.
function parseLimitOffset(req) {
  const rawLimit = req.query.limit;
  const rawOffset = req.query.offset;
  let limit = null;
  let offset = 0;
  if (rawLimit !== undefined) {
    limit = Number(rawLimit);
    if (!Number.isInteger(limit) || limit < 0 || limit > 1000) {
      return { error: 'limit must be a whole number between 0 and 1000.' };
    }
  }
  if (rawOffset !== undefined) {
    offset = Number(rawOffset);
    if (!Number.isInteger(offset) || offset < 0) {
      return { error: 'offset must be a whole number of 0 or more.' };
    }
  }
  return { limit, offset };
}

function limitOffsetClause(parsed) {
  // SQLite needs a LIMIT clause before OFFSET, so offset alone uses LIMIT -1.
  let clause = '';
  if (parsed.limit !== null) clause += ' LIMIT ?';
  else if (parsed.offset) clause += ' LIMIT -1';
  if (parsed.offset) clause += ' OFFSET ?';
  return clause;
}

function limitOffsetParams(parsed) {
  const params = [];
  if (parsed.limit !== null) params.push(parsed.limit);
  if (parsed.offset) params.push(parsed.offset);
  return params;
}

app.get('/api/prospects', auth.requireAuth, (req, res) => {
  const parsed = parseLimitOffset(req);
  if (parsed.error) return res.status(400).json({ error: 'invalid_request', detail: parsed.error });
  const sql = 'SELECT * FROM prospects ORDER BY created_at DESC' + limitOffsetClause(parsed);
  res.json(db.prepare(sql).all(...limitOffsetParams(parsed)));
});

// Priority score, computed in SQL so the database sorts and limits before
// any JavaScript runs. The formula is the same one the endpoint used
// before, in JavaScript: stage weight times 10, plus half the relevance
// score, plus 15 for a due follow up (5 if scheduled), plus 5 for an
// interaction in the last 15 days. The server runs in UTC, so the
// julianday comparison matches the JavaScript date math exactly.
const PRIORITY_SCORE_SQL = `(
  (CASE stage
    WHEN 'Target' THEN 2 WHEN 'Research' THEN 3 WHEN 'Connection Requested' THEN 3
    WHEN 'Connected' THEN 4 WHEN 'Conversation' THEN 5 WHEN 'Qualified Opportunity' THEN 6
    WHEN 'Meeting' THEN 7 WHEN 'Proposal' THEN 8 WHEN 'Won' THEN 1 WHEN 'Lost' THEN 0
    ELSE 2 END) * 10
  + COALESCE(relevance_score, 0) * 0.5
  + CASE WHEN follow_up_date IS NOT NULL AND follow_up_date <= date('now') THEN 15
         WHEN follow_up_date IS NOT NULL THEN 5 ELSE 0 END
  + CASE WHEN last_interaction IS NOT NULL
          AND julianday('now') - julianday(last_interaction) < 15 THEN 5 ELSE 0 END
)`;

app.get('/api/prospects/prioritized', auth.requireAuth, (req, res) => {
  const parsed = parseLimitOffset(req);
  if (parsed.error) return res.status(400).json({ error: 'invalid_request', detail: parsed.error });
  let sql = `SELECT *, ${PRIORITY_SCORE_SQL} AS priority_score FROM prospects ORDER BY priority_score DESC, id ASC`;
  sql += limitOffsetClause(parsed);
  const rows = db.prepare(sql).all(...limitOffsetParams(parsed));
  const stageWeight = { Target: 2, Research: 3, 'Connection Requested': 3, Connected: 4, Conversation: 5, 'Qualified Opportunity': 6, Meeting: 7, Proposal: 8, Won: 1, Lost: 0 };
  const today = new Date().toISOString().slice(0, 10);
  // Rank reasons are built only for the rows actually returned, not for
  // every row in the table.
  const ranked = rows.map((p) => {
    const weight = stageWeight[p.stage] != null ? stageWeight[p.stage] : 2;
    const reasons = [`Stage ${p.stage} (weight ${weight})`, `relevance score ${p.relevance_score == null ? 'not scored' : p.relevance_score}`];
    if (p.follow_up_date) {
      if (p.follow_up_date <= today) { reasons.push(`follow up due ${p.follow_up_date}`); }
      else { reasons.push(`follow up scheduled ${p.follow_up_date}`); }
    }
    if (p.last_interaction) {
      const ms = Date.now() - Date.parse(p.last_interaction);
      if (!Number.isNaN(ms) && ms < 15 * 86400000) { reasons.push(`recent interaction ${p.last_interaction}`); }
      else if (!Number.isNaN(ms)) { reasons.push(`last interaction ${Math.floor(ms / 86400000)} days ago`); }
    }
    return { ...p, rank_reason: reasons.join('; ') };
  });
  res.json(ranked);
});

app.post('/api/prospects', auth.requireAuth, (req, res) => {
  const body = req.body || {};
  if (!body.name || typeof body.name !== 'string') {
    return res.status(400).json({ error: 'invalid_request', detail: 'Prospect name is required.' });
  }
  const data = prospectFromBody(body);
  const bad = validateProspect(data);
  if (bad) return res.status(400).json({ error: 'invalid_request', detail: bad });
  const fields = Object.keys(data);
  const placeholders = fields.map(() => '?').join(', ');
  const info = db.prepare(`INSERT INTO prospects (${fields.join(', ')}) VALUES (${placeholders})`).run(...fields.map((f) => data[f]));
  const row = db.prepare('SELECT * FROM prospects WHERE id = ?').get(info.lastInsertRowid);
  res.status(201).json(row);
});

app.get('/api/prospects/:id', auth.requireAuth, (req, res) => {
  const row = db.prepare('SELECT * FROM prospects WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'not_found' });
  res.json(row);
});

app.put('/api/prospects/:id', auth.requireAuth, (req, res) => {
  const data = prospectFromBody(req.body || {});
  const fields = Object.keys(data);
  if (fields.length === 0) return res.status(400).json({ error: 'invalid_request', detail: 'No fields to update.' });
  const bad = validateProspect(data);
  if (bad) return res.status(400).json({ error: 'invalid_request', detail: bad });
  const sets = fields.map((f) => `${f} = ?`).join(', ');
  const info = db.prepare(`UPDATE prospects SET ${sets}, updated_at = datetime('now') WHERE id = ?`).run(...fields.map((f) => data[f]), req.params.id);
  if (info.changes === 0) return res.status(404).json({ error: 'not_found' });
  res.json(db.prepare('SELECT * FROM prospects WHERE id = ?').get(req.params.id));
});

app.delete('/api/prospects/:id', auth.requireAuth, (req, res) => {
  const row = db.prepare('SELECT * FROM prospects WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'not_found' });
  db.prepare('DELETE FROM prospects WHERE id = ?').run(req.params.id);
  audit('prospect_delete', `Deleted prospect ${req.params.id} (${row.name}).`);
  res.json({ ok: true });
});

app.get('/api/prospects/:id/interactions', auth.requireAuth, (req, res) => {
  const prospect = db.prepare('SELECT id FROM prospects WHERE id = ?').get(req.params.id);
  if (!prospect) return res.status(404).json({ error: 'not_found' });
  res.json(db.prepare('SELECT * FROM interactions WHERE prospect_id = ? ORDER BY created_at DESC').all(req.params.id));
});

app.post('/api/prospects/:id/interactions', auth.requireAuth, (req, res) => {
  const prospect = db.prepare('SELECT * FROM prospects WHERE id = ?').get(req.params.id);
  if (!prospect) return res.status(404).json({ error: 'not_found' });
  const body = req.body || {};
  // The dashboard form sends kind, text, and happened_on. The older field
  // names type, summary, and date are accepted too, so either shape works.
  const kind = body.kind || body.type || null;
  const text = body.text || body.summary || '';
  const happenedOn = body.happened_on || body.date || null;
  if (!text || typeof text !== 'string') return res.status(400).json({ error: 'invalid_request', detail: 'Interaction text is required.' });
  if (!isBoundedString(text, 5000)) return res.status(400).json({ error: 'invalid_request', detail: 'Interaction text must be at most 5000 characters.' });
  if (kind !== null && !isBoundedString(kind, 100)) return res.status(400).json({ error: 'invalid_request', detail: 'Interaction kind must be text of at most 100 characters.' });
  if (happenedOn !== null && !isBoundedString(happenedOn, 20)) return res.status(400).json({ error: 'invalid_request', detail: 'Interaction date must be text of at most 20 characters.' });
  const info = db.prepare('INSERT INTO interactions (prospect_id, kind, text, happened_on) VALUES (?, ?, ?, ?)').run(req.params.id, kind, text, happenedOn);
  db.prepare("UPDATE prospects SET last_interaction = datetime('now'), updated_at = datetime('now') WHERE id = ?").run(req.params.id);
  res.status(201).json(db.prepare('SELECT * FROM interactions WHERE id = ?').get(info.lastInsertRowid));
});

app.get('/api/prospects/:id/notes', auth.requireAuth, (req, res) => {
  const rows = db.prepare('SELECT * FROM notes WHERE prospect_id = ? ORDER BY created_at DESC').all(req.params.id);
  res.json(rows);
});

app.post('/api/prospects/:id/notes', auth.requireAuth, (req, res) => {
  const prospect = db.prepare('SELECT * FROM prospects WHERE id = ?').get(req.params.id);
  if (!prospect) return res.status(404).json({ error: 'not_found' });
  const text = req.body && req.body.text;
  if (!text || typeof text !== 'string') return res.status(400).json({ error: 'invalid_request', detail: 'Note text is required.' });
  if (!isBoundedString(text, 5000)) return res.status(400).json({ error: 'invalid_request', detail: 'Note text must be at most 5000 characters.' });
  const info = db.prepare('INSERT INTO notes (prospect_id, text) VALUES (?, ?)').run(req.params.id, text);
  res.status(201).json(db.prepare('SELECT * FROM notes WHERE id = ?').get(info.lastInsertRowid));
});

// Goals
// The dashboard goal form sends title, target, deadline, status, and
// description. Older rows only have text and category, so the response
// normalizes title from text and defaults status to Active.
function goalOut(row) {
  if (!row) return row;
  return {
    id: row.id,
    title: row.title || row.text || '',
    text: row.text || row.title || '',
    category: row.category || null,
    target: row.target || null,
    deadline: row.deadline || null,
    status: row.status || 'Active',
    description: row.description || null,
    created_at: row.created_at,
  };
}

app.get('/api/goals', auth.requireAuth, (req, res) => {
  res.json(db.prepare('SELECT * FROM goals ORDER BY created_at DESC').all().map(goalOut));
});
app.post('/api/goals', auth.requireAuth, (req, res) => {
  const body = req.body || {};
  const title = typeof body.title === 'string' ? body.title.trim() : (typeof body.text === 'string' ? body.text.trim() : '');
  if (!title) return res.status(400).json({ error: 'invalid_request', detail: 'Goal text is required.' });
  if (!isBoundedString(title)) return res.status(400).json({ error: 'invalid_request', detail: 'Goal text must be at most 2000 characters.' });
  const GOAL_STATUSES = ['Active', 'Done', 'Paused'];
  if (body.status !== undefined && body.status !== null && !GOAL_STATUSES.includes(body.status)) {
    return res.status(400).json({ error: 'invalid_request', detail: 'Goal status must be Active, Done, or Paused.' });
  }
  for (const f of ['category', 'target', 'deadline', 'description']) {
    if (body[f] !== undefined && body[f] !== null && !isBoundedString(body[f])) {
      return res.status(400).json({ error: 'invalid_request', detail: `Goal ${f} must be text of at most 2000 characters.` });
    }
  }
  const info = db.prepare('INSERT INTO goals (text, title, category, target, deadline, status, description) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(title, title, body.category || null, body.target || null, body.deadline || null, body.status || 'Active', body.description || null);
  res.status(201).json(goalOut(db.prepare('SELECT * FROM goals WHERE id = ?').get(info.lastInsertRowid)));
});
app.put('/api/goals/:id', auth.requireAuth, (req, res) => {
  const body = req.body || {};
  const GOAL_STATUSES = ['Active', 'Done', 'Paused'];
  if (body.status !== undefined && body.status !== null && !GOAL_STATUSES.includes(body.status)) {
    return res.status(400).json({ error: 'invalid_request', detail: 'Goal status must be Active, Done, or Paused.' });
  }
  for (const f of ['title', 'text', 'category', 'target', 'deadline', 'description']) {
    if (body[f] !== undefined && body[f] !== null && !isBoundedString(body[f])) {
      return res.status(400).json({ error: 'invalid_request', detail: `Goal ${f} must be text of at most 2000 characters.` });
    }
  }
  const title = typeof body.title === 'string' ? body.title.trim() : (typeof body.text === 'string' ? body.text.trim() : undefined);
  const info = db.prepare(
    'UPDATE goals SET text = COALESCE(?, text), title = COALESCE(?, title), category = COALESCE(?, category), target = COALESCE(?, target), deadline = COALESCE(?, deadline), status = COALESCE(?, status), description = COALESCE(?, description) WHERE id = ?'
  ).run(title || null, title || null, body.category || null, body.target || null, body.deadline || null, body.status || null, body.description || null, req.params.id);
  if (info.changes === 0) return res.status(404).json({ error: 'not_found' });
  res.json(goalOut(db.prepare('SELECT * FROM goals WHERE id = ?').get(req.params.id)));
});
app.delete('/api/goals/:id', auth.requireAuth, (req, res) => {
  const info = db.prepare('DELETE FROM goals WHERE id = ?').run(req.params.id);
  if (info.changes === 0) return res.status(404).json({ error: 'not_found' });
  audit('goal_delete', `Deleted goal ${req.params.id}.`);
  res.json({ ok: true });
});

// Memory
app.get('/api/memory', auth.requireAuth, (req, res) => {
  res.json(db.prepare('SELECT * FROM memory_items ORDER BY created_at DESC').all());
});
app.post('/api/memory', auth.requireAuth, (req, res) => {
  const body = req.body || {};
  if (!body.key || !body.value) return res.status(400).json({ error: 'invalid_request', detail: 'Memory key and value are required.' });
  if (!isBoundedString(body.key, 100) || !isBoundedString(body.value, 5000)) {
    return res.status(400).json({ error: 'invalid_request', detail: 'Memory key must be text of at most 100 characters and value at most 5000.' });
  }
  if (body.category !== undefined && body.category !== null && !isBoundedString(body.category, 100)) {
    return res.status(400).json({ error: 'invalid_request', detail: 'Memory category must be text of at most 100 characters.' });
  }
  const info = db.prepare('INSERT INTO memory_items (key, value, category) VALUES (?, ?, ?)').run(body.key, body.value, body.category || null);
  res.status(201).json(db.prepare('SELECT * FROM memory_items WHERE id = ?').get(info.lastInsertRowid));
});
app.put('/api/memory/:id', auth.requireAuth, (req, res) => {
  const body = req.body || {};
  if ((body.key !== undefined && body.key !== null && !isBoundedString(body.key, 100)) ||
      (body.value !== undefined && body.value !== null && !isBoundedString(body.value, 5000)) ||
      (body.category !== undefined && body.category !== null && !isBoundedString(body.category, 100))) {
    return res.status(400).json({ error: 'invalid_request', detail: 'Memory key must be text of at most 100 characters and value at most 5000.' });
  }
  const info = db.prepare('UPDATE memory_items SET key = COALESCE(?, key), value = COALESCE(?, value), category = COALESCE(?, category) WHERE id = ?').run(body.key || null, body.value || null, body.category || null, req.params.id);
  if (info.changes === 0) return res.status(404).json({ error: 'not_found' });
  res.json(db.prepare('SELECT * FROM memory_items WHERE id = ?').get(req.params.id));
});
app.delete('/api/memory/:id', auth.requireAuth, (req, res) => {
  const info = db.prepare('DELETE FROM memory_items WHERE id = ?').run(req.params.id);
  if (info.changes === 0) return res.status(404).json({ error: 'not_found' });
  audit('memory_delete', `Deleted memory item ${req.params.id}.`);
  res.json({ ok: true });
});

// Drafts
app.get('/api/drafts', auth.requireAuth, (req, res) => {
  res.json(db.prepare('SELECT * FROM drafts ORDER BY created_at DESC').all());
});
app.post('/api/drafts', auth.requireAuth, (req, res) => {
  const body = req.body || {};
  if ((body.type !== undefined && body.type !== null && !isBoundedString(body.type, 100)) ||
      (body.title !== undefined && body.title !== null && !isBoundedString(body.title)) ||
      (body.content !== undefined && body.content !== null && !isBoundedString(body.content, 50000)) ||
      (body.status !== undefined && body.status !== null && !['pending', 'approved', 'rejected'].includes(body.status)) ||
      (body.prospect_id !== undefined && body.prospect_id !== null && !Number.isInteger(body.prospect_id))) {
    return res.status(400).json({ error: 'invalid_request', detail: 'Draft fields are not valid.' });
  }
  const info = db.prepare('INSERT INTO drafts (type, title, content, status, prospect_id) VALUES (?, ?, ?, ?, ?)').run(
    body.type || null, body.title || null, body.content || '', body.status || 'pending', body.prospect_id || null
  );
  res.status(201).json(db.prepare('SELECT * FROM drafts WHERE id = ?').get(info.lastInsertRowid));
});
app.post('/api/drafts/:id/approve', auth.requireAuth, (req, res) => {
  if (killSwitchOn(req, res)) return;
  const info = db.prepare("UPDATE drafts SET status = 'approved' WHERE id = ?").run(req.params.id);
  if (info.changes === 0) return res.status(404).json({ error: 'not_found' });
  audit('draft_approve', `Approved draft ${req.params.id}.`);
  res.json(db.prepare('SELECT * FROM drafts WHERE id = ?').get(req.params.id));
});
app.post('/api/drafts/:id/reject', auth.requireAuth, (req, res) => {
  const info = db.prepare("UPDATE drafts SET status = 'rejected' WHERE id = ?").run(req.params.id);
  if (info.changes === 0) return res.status(404).json({ error: 'not_found' });
  audit('draft_reject', `Rejected draft ${req.params.id}.`);
  res.json(db.prepare('SELECT * FROM drafts WHERE id = ?').get(req.params.id));
});

// Audit, errors, analytics
app.get('/api/audit', auth.requireAuth, (req, res) => {
  res.json(db.prepare('SELECT * FROM audit_log ORDER BY created_at DESC LIMIT 200').all());
});
app.get('/api/errors', auth.requireAuth, (req, res) => {
  res.json(db.prepare('SELECT * FROM error_log ORDER BY created_at DESC LIMIT 200').all());
});
app.get('/api/analytics', auth.requireAuth, (req, res) => {
  const byStage = db.prepare('SELECT stage, COUNT(*) AS count FROM prospects GROUP BY stage').all();
  const today = new Date().toISOString().slice(0, 10);
  const followUpsDue = db.prepare('SELECT COUNT(*) AS c FROM prospects WHERE follow_up_date IS NOT NULL AND follow_up_date <= ?').get(today).c;
  const draftsByTypeStatus = db.prepare('SELECT type, status, COUNT(*) AS count FROM drafts GROUP BY type, status').all();
  const recommendationsByStatus = db.prepare('SELECT status, COUNT(*) AS count FROM recommendations GROUP BY status').all();
  // Per-day counts for the last 14 days, computed from created_at. Days with
  // no records are included with a count of 0, so the chart is honest.
  const days = [];
  for (let i = 13; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86400000);
    days.push(d.toISOString().slice(0, 10));
  }
  const prospectDayRows = db.prepare("SELECT date(created_at) AS day, COUNT(*) AS count FROM prospects WHERE date(created_at) >= ? GROUP BY day").all(days[0]);
  const draftDayRows = db.prepare("SELECT date(created_at) AS day, COUNT(*) AS count FROM drafts WHERE date(created_at) >= ? GROUP BY day").all(days[0]);
  const byDay = (rows) => {
    const map = {};
    rows.forEach((r) => { map[r.day] = r.count; });
    return days.map((day) => ({ day, count: map[day] || 0 }));
  };
  res.json({
    label: 'App records only. Counts are computed from real database rows in this app, not from LinkedIn.',
    totalProspects: db.prepare('SELECT COUNT(*) AS c FROM prospects').get().c,
    totalDrafts: db.prepare('SELECT COUNT(*) AS c FROM drafts').get().c,
    prospectsByStage: byStage,
    followUpsDue,
    draftsByTypeAndStatus: draftsByTypeStatus,
    recommendationsByStatus,
    prospectsByDay: byDay(prospectDayRows),
    draftsByDay: byDay(draftDayRows),
  });
});

// Kill switch
app.get('/api/killswitch', auth.requireAuth, (req, res) => {
  res.json({ enabled: getKillSwitch() });
});
app.post('/api/killswitch', auth.requireAuth, (req, res) => {
  const enabled = !!(req.body && req.body.enabled);
  setKillSwitch(enabled);
  audit('killswitch_change', `Kill switch set to ${enabled ? 'on' : 'off'}.`);
  res.json({ enabled });
});

// SPA fallback for non API routes.
app.get(/^\/(?!api\/).*/, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.use((err, req, res, next) => {
  // Body parser errors get their real status: 400 for bad JSON, 413 for a
  // body over the 1 MB limit. Anything else is a genuine server error.
  if (err && err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'payload_too_large', detail: 'Request body is larger than the 1 MB limit.' });
  }
  if (err instanceof SyntaxError && err.status === 400) {
    return res.status(400).json({ error: 'invalid_json', detail: 'Request body is not valid JSON.' });
  }
  logError('server', err.message);
  // Never send the real error message to the client. It can hold a file
  // path, a table name, or another internal detail. The full message is
  // in the server log and the error_log table instead.
  res.status(500).json({ error: 'server_error', detail: 'Something went wrong on the server.' });
});

app.listen(PORT, () => {
  console.log(`LinkedIn Growth Agent backend listening on port ${PORT}`);
});
