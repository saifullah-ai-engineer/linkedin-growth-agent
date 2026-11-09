// Database layer for the LinkedIn Intelligence and Growth Agent.
// Uses only the built-in node:sqlite module (DatabaseSync). No native modules.
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const dataDir = process.env.LIGA_DATA_DIR || path.join(__dirname, 'data');
fs.mkdirSync(dataDir, { recursive: true });
const dbPath = path.join(dataDir, 'app.db');

const db = new DatabaseSync(dbPath);
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id)
);
CREATE TABLE IF NOT EXISTS prospects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  profile_url TEXT,
  company TEXT,
  title TEXT,
  industry TEXT,
  expertise TEXT,
  source TEXT,
  relevance_score INTEGER,
  relevance_reason TEXT,
  opportunity TEXT,
  stage TEXT NOT NULL DEFAULT 'Target',
  notes TEXT,
  last_interaction TEXT,
  next_action TEXT,
  follow_up_date TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS interactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  prospect_id INTEGER NOT NULL,
  kind TEXT,
  text TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (prospect_id) REFERENCES prospects(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  prospect_id INTEGER NOT NULL,
  text TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (prospect_id) REFERENCES prospects(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS goals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  text TEXT NOT NULL,
  category TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS memory_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  category TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS drafts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT,
  title TEXT,
  content TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  prospect_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (prospect_id) REFERENCES prospects(id) ON DELETE SET NULL
);
CREATE TABLE IF NOT EXISTS recommendations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  text TEXT NOT NULL,
  reasoning TEXT,
  evidence_json TEXT,
  next_action TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  action TEXT NOT NULL,
  detail TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS model_config (
  id INTEGER PRIMARY KEY,
  primary_model TEXT,
  fallback_model TEXT,
  temperature REAL,
  max_tokens INTEGER,
  key_present INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS error_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT,
  message TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value TEXT
);
`);

// Lightweight migrations: add columns the dashboard uses. Old databases
// gain the columns on first start; no data is lost and no rewrite is needed.
function ensureColumn(table, column, type) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!cols.includes(column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }
}
ensureColumn('goals', 'title', 'TEXT');
ensureColumn('goals', 'target', 'TEXT');
ensureColumn('goals', 'deadline', 'TEXT');
ensureColumn('goals', 'status', "TEXT NOT NULL DEFAULT 'Active'");
ensureColumn('goals', 'description', 'TEXT');
ensureColumn('interactions', 'happened_on', 'TEXT');
ensureColumn('sessions', 'expires_at', 'TEXT');
// Sessions created before expiry existed have no expires_at. Give them a
// 24 hour expiry from now so old tokens do not live forever.
db.prepare("UPDATE sessions SET expires_at = datetime('now', '+24 hours') WHERE expires_at IS NULL").run();

function rowCount(table) {
  return db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get().c;
}

function audit(action, detail) {
  try {
    db.prepare('INSERT INTO audit_log (action, detail) VALUES (?, ?)').run(action, detail || '');
    pruneLog('audit_log', 1000);
  } catch (err) {
    console.error('audit write failed', err.message);
  }
}

function logError(source, message) {
  try {
    db.prepare('INSERT INTO error_log (source, message) VALUES (?, ?)').run(source, String(message).slice(0, 2000));
    pruneLog('error_log', 500);
  } catch (err) {
    console.error('error log write failed', err.message);
  }
}

// Keep the logs bounded: once a log passes its limit, drop the oldest rows.
// The tables grow without bound otherwise, one row per audited action.
function pruneLog(table, limit) {
  try {
    const count = db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get().c;
    if (count > limit) {
      db.prepare(`DELETE FROM ${table} WHERE id NOT IN (SELECT id FROM ${table} ORDER BY id DESC LIMIT ?)`).run(limit);
    }
  } catch (err) {
    console.error('log prune failed', err.message);
  }
}

// Default model config row.
if (rowCount('model_config') === 0) {
  db.prepare(
    'INSERT INTO model_config (id, primary_model, fallback_model, temperature, max_tokens, key_present) VALUES (1, ?, ?, ?, ?, 0)'
  ).run('google/gemma-4-26b-a4b-it:free', 'google/gemma-4-31b-it:free', 0.7, 1000);
}

// Seed on first run only, when the tables are empty.
function seedIfEmpty() {
  if (rowCount('memory_items') === 0) {
    const items = [
      ['identity', 'Saif Ullah, Agentic AI Engineer at TechAurah', 'identity'],
      ['linkedin', 'linkedin.com/in/saif-ullah-ai-engineer/', 'identity'],
      ['portfolio', 'saifullah-ai-engineer.me', 'identity'],
      ['github', 'saifullah-ai-engineer', 'identity'],
      ['services', 'Lead handling audit, fixed AI build, managed agent service', 'services'],
      ['target_audiences', 'US/UK startup founders, CTOs, AI professionals, recruiters, decision-makers', 'audience'],
      ['positioning', 'Agentic AI Engineer building AI agents and automations that save businesses time and catch lost leads', 'positioning'],
    ];
    const stmt = db.prepare('INSERT INTO memory_items (key, value, category) VALUES (?, ?, ?)');
    for (const item of items) stmt.run(item[0], item[1], item[2]);
  }
  if (rowCount('goals') === 0) {
    const goals = [
      ['Reach US/UK startup founders, CTOs, and decision makers on LinkedIn', 'growth'],
      ['Win lead handling audit and fixed AI build clients', 'outreach'],
      ['Publish proof of AI agents and automations that save businesses time and catch lost leads', 'content'],
    ];
    const stmt = db.prepare('INSERT INTO goals (text, category) VALUES (?, ?)');
    for (const goal of goals) stmt.run(goal[0], goal[1]);
  }
  if (rowCount('prospects') === 0) {
    db.prepare(
      `INSERT INTO prospects (name, profile_url, company, title, industry, expertise, source, relevance_score, relevance_reason, opportunity, stage, notes, next_action)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'EXAMPLE, delete me',
      '',
      'Example Company',
      'Example Title',
      'Example Industry',
      '',
      'seed',
      null,
      'This is a seeded example prospect so the UI empty state and pipeline can be demonstrated. It is not a real person. Delete it.',
      'Demonstrate the pipeline stages in the UI.',
      'Target',
      'EXAMPLE prospect. Delete this row before real use.',
      'Delete this example prospect.'
    );
  }
}
seedIfEmpty();

function getKillSwitch() {
  const row = db.prepare("SELECT value FROM app_settings WHERE key = 'kill_switch'").get();
  return row ? row.value === '1' : false;
}

function setKillSwitch(enabled) {
  db.prepare('INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run('kill_switch', enabled ? '1' : '0');
}

module.exports = { db, audit, logError, getKillSwitch, setKillSwitch, rowCount };
