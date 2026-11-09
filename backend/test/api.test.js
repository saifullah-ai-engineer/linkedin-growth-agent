// Automated API tests for the LinkedIn Growth Agent backend.
// Node built-in test runner only, no extra dependency. The suite starts
// the real server as a child process against a throwaway data directory
// (LIGA_DATA_DIR), so it never touches a real database or a real key.
// Run: npm test
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PORT = 3101;
const BASE = `http://localhost:${PORT}`;
const PASSWORD = 'testpass123';
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'liga-test-'));
let child;
let token = '';

async function req(method, p, body, useAuth = true) {
  const headers = { 'Content-Type': 'application/json' };
  if (useAuth && token) headers.Authorization = 'Bearer ' + token;
  const res = await fetch(BASE + p, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch (e) { /* non JSON body */ }
  return { status: res.status, data };
}

async function waitForServer() {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(BASE + '/api/auth/status');
      if (res.ok) return;
    } catch (e) { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('Server did not start in time.');
}

before(async () => {
  child = spawn('node', ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(PORT), LIGA_DATA_DIR: tmpDir },
    stdio: 'ignore',
  });
  await waitForServer();
});

after(() => {
  if (child) child.kill();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('auth: setup is needed first, then setup returns a token', async () => {
  let r = await req('GET', '/api/auth/status', null, false);
  assert.equal(r.status, 200);
  assert.equal(r.data.setupNeeded, true);
  assert.equal(r.data.loggedIn, false);

  r = await req('POST', '/api/auth/setup', { password: 'short' }, false);
  assert.equal(r.status, 400);
  assert.equal(r.data.error, 'invalid_password');

  r = await req('POST', '/api/auth/setup', { password: PASSWORD }, false);
  assert.equal(r.status, 200);
  assert.equal(r.data.ok, true);
  assert.equal(typeof r.data.token, 'string');
  assert.equal(r.data.token.length, 64);
  token = r.data.token;

  r = await req('POST', '/api/auth/setup', { password: PASSWORD }, false);
  assert.equal(r.status, 400);
  assert.equal(r.data.error, 'setup_disabled');
});

test('auth: wrong password fails, right password logs in, logout invalidates', async () => {
  let r = await req('POST', '/api/auth/login', { password: 'wrongpass' }, false);
  assert.equal(r.status, 401);
  r = await req('POST', '/api/auth/login', { password: PASSWORD }, false);
  assert.equal(r.status, 200);
  assert.equal(typeof r.data.token, 'string');
  token = r.data.token;

  r = await req('GET', '/api/prospects', null, false);
  assert.equal(r.status, 401);

  r = await req('POST', '/api/auth/logout', {});
  assert.equal(r.status, 200);
  r = await req('GET', '/api/prospects');
  assert.equal(r.status, 401);

  r = await req('POST', '/api/auth/login', { password: PASSWORD }, false);
  assert.equal(r.status, 200);
  token = r.data.token;
});

test('config: free defaults, paid model rejected, ranges validated', async () => {
  let r = await req('GET', '/api/config');
  assert.equal(r.status, 200);
  assert.equal(r.data.primary_model, 'google/gemma-4-26b-a4b-it:free');
  assert.equal(r.data.fallback_model, 'google/gemma-4-31b-it:free');
  assert.equal(r.data.keyConfigured, false);

  r = await req('PUT', '/api/config', { primary_model: 'openai/gpt-4o-mini', fallback_model: 'google/gemma-4-31b-it:free' });
  assert.equal(r.status, 400);
  assert.equal(r.data.error, 'paid_model_not_allowed');

  r = await req('PUT', '/api/config', { primary_model: 'google/gemma-4-31b-it:free', fallback_model: 'google/gemma-4-26b-a4b-it:free', temperature: 99 });
  assert.equal(r.status, 400);
  assert.equal(r.data.error, 'invalid_config');

  r = await req('PUT', '/api/config', { primary_model: 'google/gemma-4-31b-it:free', fallback_model: 'google/gemma-4-26b-a4b-it:free', max_tokens: -5 });
  assert.equal(r.status, 400);
  assert.equal(r.data.error, 'invalid_config');

  r = await req('PUT', '/api/config', { primary_model: 'google/gemma-4-31b-it:free', fallback_model: 'google/gemma-4-26b-a4b-it:free', temperature: 0.5, max_tokens: 500 });
  assert.equal(r.status, 200);
  assert.equal(r.data.primary_model, 'google/gemma-4-31b-it:free');
  assert.equal(r.data.temperature, 0.5);

  r = await req('PUT', '/api/config', { primary_model: 'google/gemma-4-26b-a4b-it:free', fallback_model: 'google/gemma-4-31b-it:free', temperature: 0.7, max_tokens: 1000 });
  assert.equal(r.status, 200);
});

test('ai routes: no key means 503 not_configured with setup steps', async () => {
  let r = await req('POST', '/api/ai/chat', { message: 'hello' });
  assert.equal(r.status, 503);
  assert.equal(r.data.error, 'not_configured');
  assert.equal(r.data.code, 'not_configured');
  assert.ok(Array.isArray(r.data.setup) && r.data.setup.length === 3);

  r = await req('POST', '/api/ai/draft', { type: 'post', inputs: { topic: 'AI' } });
  assert.equal(r.status, 503);

  r = await req('POST', '/api/strategist', { message: 'who should I target' });
  assert.equal(r.status, 503);

  r = await req('GET', '/api/models');
  assert.equal(r.status, 503);

  r = await req('POST', '/api/config/test', {});
  assert.equal(r.status, 200);
  assert.equal(r.data.error, 'not_configured');
});

test('prospects: full CRUD and prioritized ranking', async () => {
  let r = await req('POST', '/api/prospects', { company: 'NoName Inc' });
  assert.equal(r.status, 400);

  r = await req('POST', '/api/prospects', {
    name: 'Amina Raza', company: 'Acme', title: 'CTO', stage: 'Conversation',
    relevance_score: 85, relevance_reason: 'Fits ICP', follow_up_date: '2026-11-09',
  });
  assert.equal(r.status, 201);
  const p1 = r.data.id;
  assert.ok(p1);

  r = await req('POST', '/api/prospects', { name: 'Bilal Khan', company: 'Beta', stage: 'Target', relevance_score: 40 });
  assert.equal(r.status, 201);
  const p2 = r.data.id;

  r = await req('GET', '/api/prospects');
  assert.equal(r.status, 200);
  assert.equal(r.data.length, 3); // seeded example plus the two above

  r = await req('GET', '/api/prospects/prioritized');
  assert.equal(r.status, 200);
  assert.equal(r.data[0].id, p1);
  assert.equal(typeof r.data[0].priority_score, 'number');
  assert.ok(r.data[0].rank_reason.includes('Stage Conversation'));

  r = await req('GET', '/api/prospects/99999');
  assert.equal(r.status, 404);

  r = await req('PUT', '/api/prospects/' + p2, { stage: 'Connected' });
  assert.equal(r.status, 200);
  assert.equal(r.data.stage, 'Connected');

  r = await req('PUT', '/api/prospects/' + p2, {});
  assert.equal(r.status, 400);

  r = await req('DELETE', '/api/prospects/' + p2);
  assert.equal(r.status, 200);
  r = await req('DELETE', '/api/prospects/' + p2);
  assert.equal(r.status, 404);
});

test('interactions and notes: create, read, and list', async () => {
  let r = await req('POST', '/api/prospects', { name: 'Sara Malik', stage: 'Target' });
  const pid = r.data.id;

  r = await req('POST', `/api/prospects/${pid}/interactions`, { kind: 'call', text: 'Intro call, interested', happened_on: '2026-11-09' });
  assert.equal(r.status, 201);
  assert.equal(r.data.kind, 'call');
  assert.equal(r.data.text, 'Intro call, interested');
  assert.equal(r.data.happened_on, '2026-11-09');

  r = await req('POST', `/api/prospects/${pid}/interactions`, { type: 'message', summary: 'Sent a follow-up', date: '2026-11-08' });
  assert.equal(r.status, 201);
  assert.equal(r.data.kind, 'message');
  assert.equal(r.data.text, 'Sent a follow-up');

  r = await req('POST', `/api/prospects/${pid}/interactions`, { kind: 'call', text: '' });
  assert.equal(r.status, 400);

  r = await req('GET', `/api/prospects/${pid}/interactions`);
  assert.equal(r.status, 200);
  assert.equal(r.data.length, 2);

  r = await req('GET', '/api/prospects/99999/interactions');
  assert.equal(r.status, 404);

  r = await req('POST', `/api/prospects/${pid}/notes`, { text: 'Prefers email' });
  assert.equal(r.status, 201);
  assert.equal(r.data.text, 'Prefers email');

  r = await req('GET', `/api/prospects/${pid}/notes`);
  assert.equal(r.status, 200);
  assert.equal(r.data.length, 1);

  r = await req('POST', `/api/prospects/${pid}/notes`, {});
  assert.equal(r.status, 400);
});

test('goals: dashboard shape works end to end', async () => {
  let r = await req('POST', '/api/goals', {
    title: 'Win 3 clients', target: '3', deadline: '2026-12-31',
    status: 'Active', description: 'Close three audit clients',
  });
  assert.equal(r.status, 201);
  assert.equal(r.data.title, 'Win 3 clients');
  assert.equal(r.data.text, 'Win 3 clients');
  assert.equal(r.data.target, '3');
  assert.equal(r.data.status, 'Active');
  const gid = r.data.id;

  r = await req('GET', '/api/goals');
  assert.equal(r.status, 200);
  assert.equal(r.data.length, 4); // 3 seeded plus the one above
  const seeded = r.data.find((g) => g.text.startsWith('Reach US/UK'));
  assert.ok(seeded);
  assert.equal(seeded.title, seeded.text); // title falls back to text

  r = await req('PUT', '/api/goals/' + gid, { title: 'Win 5 clients', status: 'Done' });
  assert.equal(r.status, 200);
  assert.equal(r.data.title, 'Win 5 clients');
  assert.equal(r.data.text, 'Win 5 clients');
  assert.equal(r.data.status, 'Done');

  r = await req('PUT', '/api/goals/99999', { title: 'Nope' });
  assert.equal(r.status, 404);

  r = await req('DELETE', '/api/goals/' + gid);
  assert.equal(r.status, 200);
  r = await req('DELETE', '/api/goals/' + gid);
  assert.equal(r.status, 404);
});

test('memory: full CRUD', async () => {
  let r = await req('POST', '/api/memory', { key: 'niche', value: 'US founders', category: 'audience' });
  assert.equal(r.status, 201);
  const mid = r.data.id;

  r = await req('POST', '/api/memory', { key: 'only-key' });
  assert.equal(r.status, 400);

  r = await req('PUT', '/api/memory/' + mid, { value: 'US/UK founders' });
  assert.equal(r.status, 200);
  assert.equal(r.data.value, 'US/UK founders');

  r = await req('DELETE', '/api/memory/' + mid);
  assert.equal(r.status, 200);
  r = await req('DELETE', '/api/memory/' + mid);
  assert.equal(r.status, 404);
});

test('drafts: create, approve, reject, and kill switch blocks approval', async () => {
  let r = await req('POST', '/api/drafts', { type: 'post', title: 'Test post', content: 'Hello world', status: 'pending' });
  assert.equal(r.status, 201);
  const d1 = r.data.id;

  r = await req('POST', '/api/drafts/99999/approve', {});
  assert.equal(r.status, 404);

  r = await req('POST', `/api/drafts/${d1}/approve`, {});
  assert.equal(r.status, 200);
  assert.equal(r.data.status, 'approved');

  r = await req('POST', '/api/drafts', { type: 'comment', title: 'Test comment', content: 'Nice post' });
  const d2 = r.data.id;
  r = await req('POST', `/api/drafts/${d2}/reject`, {});
  assert.equal(r.status, 200);
  assert.equal(r.data.status, 'rejected');

  r = await req('GET', '/api/drafts');
  assert.equal(r.status, 200);
  assert.ok(r.data.length >= 2);

  r = await req('GET', '/api/killswitch');
  assert.equal(r.status, 200);
  assert.equal(r.data.enabled, false);

  r = await req('POST', '/api/killswitch', { enabled: true });
  assert.equal(r.status, 200);
  assert.equal(r.data.enabled, true);

  r = await req('POST', '/api/ai/chat', { message: 'hello' });
  assert.equal(r.status, 403);
  assert.equal(r.data.error, 'kill_switch_on');

  r = await req('POST', '/api/strategist', { message: 'hello' });
  assert.equal(r.status, 403);

  r = await req('POST', `/api/drafts/${d2}/approve`, {});
  assert.equal(r.status, 403);

  r = await req('POST', '/api/killswitch', { enabled: false });
  assert.equal(r.status, 200);
  assert.equal(r.data.enabled, false);
});

test('recommendations, analytics, audit, and errors', async () => {
  let r = await req('GET', '/api/recommendations');
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.data));

  r = await req('POST', '/api/recommendations/1/feedback', { status: 'bogus' });
  assert.equal(r.status, 400);

  r = await req('POST', '/api/recommendations/99999/feedback', { status: 'done' });
  assert.equal(r.status, 404);

  r = await req('GET', '/api/analytics');
  assert.equal(r.status, 200);
  assert.equal(typeof r.data.totalProspects, 'number');
  assert.equal(typeof r.data.totalDrafts, 'number');
  assert.equal(r.data.prospectsByDay.length, 14);
  assert.equal(r.data.draftsByDay.length, 14);
  assert.ok(r.data.label.includes('App records only'));

  r = await req('GET', '/api/audit');
  assert.equal(r.status, 200);
  assert.ok(r.data.length > 0);

  r = await req('GET', '/api/errors');
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.data));
});
