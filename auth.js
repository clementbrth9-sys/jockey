const crypto = require('crypto');

const COOKIE_NAME = 'session';
const SESSION_DURATION_MS = 30 * 24 * 60 * 60 * 1000; // 30 jours : mot de passe a retaper une fois par mois

const SESSION_SECRET = process.env.SESSION_SECRET;
const APP_PASSWORD = process.env.APP_PASSWORD;
// Optionnel : sans ADMIN_PASSWORD, le mot de passe de l'app donne aussi acces a l'admin.
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || null;

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

function sameSecret(input, secret) {
  return crypto.timingSafeEqual(sha256(input), sha256(secret));
}

// Renvoie le role donne par le mot de passe ('admin' ou 'jockey'), ou null.
function checkPassword(password) {
  if (typeof password !== 'string' || password.length === 0) return null;
  if (ADMIN_PASSWORD && sameSecret(password, ADMIN_PASSWORD)) return 'admin';
  if (sameSecret(password, APP_PASSWORD)) return ADMIN_PASSWORD ? 'jockey' : 'admin';
  return null;
}

function sign(value) {
  return crypto.createHmac('sha256', SESSION_SECRET).update(value).digest('hex');
}

function createSessionToken(role) {
  const expiry = Date.now() + SESSION_DURATION_MS;
  const payload = `${expiry}~${role}`;
  return `${payload}.${sign(payload)}`;
}

// Renvoie le role de la session, ou null si elle est absente, invalide ou expiree.
function verifySessionToken(token) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return null;
  const [payload, signature] = token.split('.');
  if (!signature) return null;
  const sigBuf = Buffer.from(signature);
  const expectedBuf = Buffer.from(sign(payload));
  if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) {
    return null;
  }
  const [expiryStr, role] = payload.split('~');
  const expiry = Number(expiryStr);
  const now = Date.now();
  // Les anciens jetons de 180 jours (sans role) sont refuses : une reconnexion unique.
  if (!Number.isFinite(expiry) || now >= expiry || expiry - now > SESSION_DURATION_MS) return null;
  if (role !== 'admin' && role !== 'jockey') return null;
  // Si ADMIN_PASSWORD est retire, tout le monde redevient admin comme avant.
  return ADMIN_PASSWORD ? role : 'admin';
}

function getCookie(req, name) {
  const header = req.headers.cookie;
  if (!header) return null;
  const parts = header.split(';').map((c) => c.trim());
  const found = parts.find((c) => c.startsWith(`${name}=`));
  return found ? decodeURIComponent(found.slice(name.length + 1)) : null;
}

function getRole(req) {
  return verifySessionToken(getCookie(req, COOKIE_NAME));
}

function setSessionCookie(req, res, role) {
  const token = createSessionToken(role);
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

// Pages et API reservees a l'admin
const ADMIN_PATHS = new Set(['/admin.html', '/admin.js', '/admin.css']);
const isAdminPath = (p) => ADMIN_PATHS.has(p) || p.startsWith('/api/admin/');

function authMiddleware(req, res, next) {
  if (OPEN_PATHS.has(req.path) || FONT_PATH_RE.test(req.path)) return next();
  const role = getRole(req);
  if (role && (role === 'admin' || !isAdminPath(req.path))) {
    req.role = role;
    return next();
  }
  if (req.path.startsWith('/api/')) {
    return res.status(role ? 403 : 401).json({ error: role ? 'ACCES_ADMIN_REQUIS' : 'UNAUTHORIZED' });
  }
  return res.redirect(isAdminPath(req.path) ? '/login.html?admin=1' : '/login.html');
}

module.exports = {
  authMiddleware,
  checkPassword,
  setSessionCookie,
  clearSessionCookie,
  isRateLimited,
  registerAttempt,
};
