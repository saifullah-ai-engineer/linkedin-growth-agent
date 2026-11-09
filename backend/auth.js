// Simple local auth: scrypt password hash, random bearer tokens in sessions.
// No external auth service. Tokens are checked against the sessions table.
// Sessions expire 24 hours after they are created; expired tokens are
// rejected and deleted when they are seen.
const crypto = require('node:crypto');
const { db } = require('./db');

const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  if (!stored || !stored.includes(':')) return false;
  const [salt, hash] = stored.split(':');
  const check = crypto.scryptSync(password, salt, 64).toString('hex');
  const a = Buffer.from(check, 'hex');
  const b = Buffer.from(hash, 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// Async verification runs scrypt in the libuv thread pool instead of
// blocking the event loop. Login uses this; the sync version above is kept
// only for the one-time setup path and for tests that call it directly.
function verifyPasswordAsync(password, stored) {
  return new Promise((resolve) => {
    if (!stored || !stored.includes(':')) return resolve(false);
    const [salt, hash] = stored.split(':');
    crypto.scrypt(password, salt, 64, (err, derived) => {
      if (err) return resolve(false);
      const b = Buffer.from(hash, 'hex');
      if (derived.length !== b.length) return resolve(false);
      resolve(crypto.timingSafeEqual(derived, b));
    });
  });
}

// Password rule: at least 12 characters, with an upper case letter, a lower
// case letter, a digit, and a symbol. Returns null when the password is
// acceptable, or a plain description of the rule when it is not. The
// description never includes the password itself.
function validatePassword(password) {
  if (typeof password !== 'string' || password.length < 12) {
    return 'Password must be at least 12 characters.';
  }
  if (!/[a-z]/.test(password)) return 'Password must include a lower case letter.';
  if (!/[A-Z]/.test(password)) return 'Password must include an upper case letter.';
  if (!/[0-9]/.test(password)) return 'Password must include a digit.';
  if (!/[^A-Za-z0-9]/.test(password)) return 'Password must include a symbol.';
  return null;
}

function createToken() {
  return crypto.randomBytes(32).toString('hex');
}

function sessionExpiryIso() {
  return new Date(Date.now() + SESSION_TTL_MS).toISOString();
}

// Create a session row with a 24 hour expiry and return the token.
function createSession(userId) {
  const token = createToken();
  db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)').run(token, userId, sessionExpiryIso());
  return token;
}

// Look up a session token. An expired row is deleted and treated as
// missing, so an old token can never be used again.
function getSession(token) {
  if (!token) return null;
  const row = db.prepare('SELECT user_id, expires_at FROM sessions WHERE token = ?').get(token);
  if (!row) return null;
  if (row.expires_at && Date.parse(row.expires_at) <= Date.now()) {
    db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
    return null;
  }
  return row;
}

function getUserCount() {
  return db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
}

function getBearerToken(req) {
  const header = req.headers.authorization || '';
  if (!header.startsWith('Bearer ')) return null;
  return header.slice('Bearer '.length).trim() || null;
}

function requireAuth(req, res, next) {
  const token = getBearerToken(req);
  if (!token) return res.status(401).json({ error: 'unauthorized', detail: 'Missing Bearer token.' });
  const session = getSession(token);
  if (!session) return res.status(401).json({ error: 'unauthorized', detail: 'Invalid or expired token.' });
  req.userId = session.user_id;
  req.token = token;
  return next();
}

module.exports = { hashPassword, verifyPassword, verifyPasswordAsync, validatePassword, createToken, createSession, getSession, getUserCount, getBearerToken, requireAuth, SESSION_TTL_MS };
