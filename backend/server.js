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
  return res.status(503).json({ error: 'not_configured', setup: openrouter.SETUP_STEPS });
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
  let loggedIn = false;
  if (token) {
    const row = db.prepare('SELECT user_id FROM sessions WHERE token = ?').get(token);
    loggedIn = !!row;
  }
  res.json({ setupNeeded, loggedIn });
});

app.post('/api/auth/setup', (req, res) => {
  if (auth.getUserCount() > 0) {
    return res.status(400).json({ error: 'setup_disabled', detail: 'Setup is already complete.' });
  }
  const password = req.body && req.body.password;
  if (typeof password !== 'string' || password.length < 8) {
    return res.status(400).json({ error: 'invalid_password', detail: 'Password must be at least 8 characters.' });
  }
  db.prepare('INSERT INTO users (password_hash) VALUES (?)').run(auth.hashPassword(password));
  audit('auth_setup', 'First user created.');
  res.json({ ok: true });
});

app.post('/api/auth/login', (req, res) => {
  const password = req.body && req.body.password;
  const user = db.prepare('SELECT * FROM users ORDER BY id LIMIT 1').get();
  if (!user || typeof password !== 'string' || !auth.verifyPassword(password, user.password_hash)) {
    return res.status(401).json({ error: 'invalid_credentials', detail: 'Wrong password.' });
  }
  const token = auth.createToken();
  db.prepare('INSERT INTO sessions (token, user_id) VALUES (?, ?)').run(token, user.id);
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
  if (killSwitchOn(req, res)) return;
  const message = (req.body && req.body.message) || '';
  const task = (req.body && req.body.task) || '';
  const pastedText = (req.body && (req.body.pastedText || req.body.context)) || '';
  if (!message && !task && !pastedText) {
    return res.status(400).json({ error: 'invalid_request', detail: 'Provide a message, task, or pasted text.' });
  }
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
  if (killSwitchOn(req, res)) return;
  const type = (req.body && req.body.type) || 'general';
  const inputs = (req.body && req.body.inputs) || {};
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
  if (killSwitchOn(req, res)) return;
  const message = (req.body && req.body.message) || '';
  const pastedText = (req.body && (req.body.pastedText || req.body.context)) || '';
  if (!message) return res.status(400).json({ error: 'invalid_request', detail: 'Provide a message.' });
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

function prospectFromBody(body) {
  const out = {};
  for (const field of PROSPECT_FIELDS) {
    if (body[field] !== undefined) out[field] = body[field];
  }
  return out;
}

app.get('/api/prospects', auth.requireAuth, (req, res) => {
  const rows = db.prepare('SELECT * FROM prospects ORDER BY created_at DESC').all();
  res.json(rows);
});

app.get('/api/prospects/prioritized', auth.requireAuth, (req, res) => {
  const rows = db.prepare('SELECT * FROM prospects').all();
  const stageWeight = { Target: 2, Research: 3, 'Connection Requested': 3, Connected: 4, Conversation: 5, 'Qualified Opportunity': 6, Meeting: 7, Proposal: 8, Won: 1, Lost: 0 };
  const today = new Date().toISOString().slice(0, 10);
  const ranked = rows.map((p) => {
    const weight = stageWeight[p.stage] != null ? stageWeight[p.stage] : 2;
    const relevance = typeof p.relevance_score === 'number' ? p.relevance_score : 0;
    let score = weight * 10 + relevance * 0.5;
    const reasons = [`Stage ${p.stage} (weight ${weight})`, `relevance score ${p.relevance_score == null ? 'not scored' : p.relevance_score}`];
    if (p.follow_up_date) {
      if (p.follow_up_date <= today) { score += 15; reasons.push(`follow up due ${p.follow_up_date}`); }
      else { score += 5; reasons.push(`follow up scheduled ${p.follow_up_date}`); }
    }
    if (p.last_interaction) {
      const days = Math.floor((Date.now() - Date.parse(p.last_interaction)) / 86400000);
      if (!Number.isNaN(days) && days <= 14) { score += 5; reasons.push(`recent interaction ${p.last_interaction}`); }
      else if (!Number.isNaN(days)) { reasons.push(`last interaction ${days} days ago`); }
    }
    return { ...p, priority_score: score, rank_reason: reasons.join('; ') };
  });
  ranked.sort((a, b) => b.priority_score - a.priority_score);
  res.json(ranked);
});

app.post('/api/prospects', auth.requireAuth, (req, res) => {
  const body = req.body || {};
  if (!body.name || typeof body.name !== 'string') {
    return res.status(400).json({ error: 'invalid_request', detail: 'Prospect name is required.' });
  }
  const data = prospectFromBody(body);
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

app.post('/api/prospects/:id/interactions', auth.requireAuth, (req, res) => {
  const prospect = db.prepare('SELECT * FROM prospects WHERE id = ?').get(req.params.id);
  if (!prospect) return res.status(404).json({ error: 'not_found' });
  const body = req.body || {};
  const info = db.prepare('INSERT INTO interactions (prospect_id, kind, text) VALUES (?, ?, ?)').run(req.params.id, body.kind || null, body.text || '');
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
  const info = db.prepare('INSERT INTO notes (prospect_id, text) VALUES (?, ?)').run(req.params.id, text);
  res.status(201).json(db.prepare('SELECT * FROM notes WHERE id = ?').get(info.lastInsertRowid));
});

// Goals
app.get('/api/goals', auth.requireAuth, (req, res) => {
  res.json(db.prepare('SELECT * FROM goals ORDER BY created_at DESC').all());
});
app.post('/api/goals', auth.requireAuth, (req, res) => {
  const body = req.body || {};
  if (!body.text) return res.status(400).json({ error: 'invalid_request', detail: 'Goal text is required.' });
  const info = db.prepare('INSERT INTO goals (text, category) VALUES (?, ?)').run(body.text, body.category || null);
  res.status(201).json(db.prepare('SELECT * FROM goals WHERE id = ?').get(info.lastInsertRowid));
});
app.put('/api/goals/:id', auth.requireAuth, (req, res) => {
  const body = req.body || {};
  const info = db.prepare('UPDATE goals SET text = COALESCE(?, text), category = COALESCE(?, category) WHERE id = ?').run(body.text || null, body.category || null, req.params.id);
  if (info.changes === 0) return res.status(404).json({ error: 'not_found' });
  res.json(db.prepare('SELECT * FROM goals WHERE id = ?').get(req.params.id));
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
  const info = db.prepare('INSERT INTO memory_items (key, value, category) VALUES (?, ?, ?)').run(body.key, body.value, body.category || null);
  res.status(201).json(db.prepare('SELECT * FROM memory_items WHERE id = ?').get(info.lastInsertRowid));
});
app.put('/api/memory/:id', auth.requireAuth, (req, res) => {
  const body = req.body || {};
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
  logError('server', err.message);
  res.status(500).json({ error: 'server_error', detail: err.message });
});

app.listen(PORT, () => {
  console.log(`LinkedIn Growth Agent backend listening on port ${PORT}`);
});
