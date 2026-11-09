// Simple local auth: scrypt password hash, random bearer tokens in sessions.
// No external auth service. Tokens are checked against the sessions table.
const crypto = require('node:crypto');
const { db } = require('./db');

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

function createToken() {
  return crypto.randomBytes(32).toString('hex');
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
  const row = db.prepare('SELECT user_id FROM sessions WHERE token = ?').get(token);
  if (!row) return res.status(401).json({ error: 'unauthorized', detail: 'Invalid or expired token.' });
  req.userId = row.user_id;
  req.token = token;
  return next();
}

module.exports = { hashPassword, verifyPassword, verifyPasswordAsync, createToken, getUserCount, getBearerToken, requireAuth };
