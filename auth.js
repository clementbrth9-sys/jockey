const crypto = require('crypto');

const COOKIE_NAME = 'session';
const SESSION_DURATION_MS = 180 * 24 * 60 * 60 * 1000; // 180 jours

const SESSION_SECRET = process.env.SESSION_SECRET;
const APP_PASSWORD = process.env.APP_PASSWORD;

if (!SESSION_SECRET || !APP_PASSWORD) {
  throw new Error(
    'Variables d\'environnement manquantes : SESSION_SECRET et APP_PASSWORD sont obligatoires.'
  );
}

// Anti brute-force minimal : limite les tentatives par IP.
const attempts = new Map(); // ip -> { count, resetAt }
const MAX_ATTEMPTS = 10;
const WINDOW_MS = 15 * 60 * 1000;

// Plafond global en plus du plafond par IP : une attaque repartie sur beaucoup
// d'adresses reste bornee. Contrepartie assumee : pendant une attaque, les vraies
// connexions peuvent etre bloquees jusqu'a 15 min (les sessions deja ouvertes
// continuent de fonctionner).
const MAX_GLOBAL_ATTEMPTS = 100;
const MAX_TRACKED_IPS = 5000;
const globalAttempts = { count: 0, resetAt: 0 };

function isRateLimited(ip) {
  const now = Date.now();
  if (now > globalAttempts.resetAt) {
    globalAttempts.count = 0;
    globalAttempts.resetAt = now + WINDOW_MS;
  }
  if (globalAttempts.count >= MAX_GLOBAL_ATTEMPTS) return true;

  const entry = attempts.get(ip);
  if (!entry || now > entry.resetAt) {
    if (attempts.size >= MAX_TRACKED_IPS) {
      for (const [key, value] of attempts) {
        if (now > value.resetAt) attempts.delete(key);
      }
    }
    attempts.set(ip, { count: 0, resetAt: now + WINDOW_MS });
    return false;
  }
  return entry.count >= MAX_ATTEMPTS;
}

function registerAttempt(ip) {
  globalAttempts.count += 1;
  const entry = attempts.get(ip);
  if (entry) entry.count += 1;
}

function sha256(input) {
  return crypto.createHash('sha256').update(input).digest();
}

function checkPassword(password) {
  if (typeof password !== 'string' || password.length === 0) return false;
  const a = sha256(password);
  const b = sha256(APP_PASSWORD);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function sign(value) {
  return crypto.createHmac('sha256', SESSION_SECRET).update(value).digest('hex');
}

function createSessionToken() {
  const expiry = Date.now() + SESSION_DURATION_MS;
  const payload = String(expiry);
  return `${payload}.${sign(payload)}`;
}

function verifySessionToken(token) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return false;
  const [payload, signature] = token.split('.');
  const expected = sign(payload);
  const sigBuf = Buffer.from(signature);
  const expectedBuf = Buffer.from(expected);
  if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) {
    return false;
  }
  const expiry = Number(payload);
  return Number.isFinite(expiry) && Date.now() < expiry;
}

function getCookie(req, name) {
  const header = req.headers.cookie;
  if (!header) return null;
  const parts = header.split(';').map((c) => c.trim());
  const found = parts.find((c) => c.startsWith(`${name}=`));
  return found ? decodeURIComponent(found.slice(name.length + 1)) : null;
}

function isAuthenticated(req) {
  return verifySessionToken(getCookie(req, COOKIE_NAME));
}

function setSessionCookie(req, res) {
  const token = createSessionToken();
  const secure = req.secure || req.headers['x-forwarded-proto'] === 'https';
  const maxAgeSec = Math.floor(SESSION_DURATION_MS / 1000);
  res.setHeader(
    'Set-Cookie',
    `${COOKIE_NAME}=${encodeURIComponent(token)}; HttpOnly; Path=/; Max-Age=${maxAgeSec}; SameSite=Lax${secure ? '; Secure' : ''}`
  );
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax`);
}

const OPEN_PATHS = new Set(['/login.html', '/login.js', '/style.css', '/logo.png', '/logo-mark.png', '/api/login']);

// Polices de la page de connexion. Motif strict (pas de "/" ni de ".." dans le
// nom) pour qu'un chemin comme /fonts/../admin.html ne contourne pas l'auth.
const FONT_PATH_RE = /^\/fonts\/[\w-]+\.woff2$/;

function authMiddleware(req, res, next) {
  if (OPEN_PATHS.has(req.path) || FONT_PATH_RE.test(req.path)) return next();
  if (isAuthenticated(req)) return next();
  if (req.path.startsWith('/api/')) {
    return res.status(401).json({ error: 'UNAUTHORIZED' });
  }
  return res.redirect('/login.html');
}

module.exports = {
  authMiddleware,
  checkPassword,
  setSessionCookie,
  clearSessionCookie,
  isRateLimited,
  registerAttempt,
};
