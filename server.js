require('dotenv').config();

const express = require('express');
const path = require('path');
const db = require('./db');
const auth = require('./auth');

const app = express();
const PORT = process.env.PORT || 3000;

// Render place un seul proxy devant l'app : on ne fait confiance qu'a lui pour
// l'IP du client. Avec `true`, n'importe qui pourrait choisir son IP via
// X-Forwarded-For et contourner la limite de tentatives de connexion.
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(express.json({ limit: '10kb' }));

// --- En-tetes de securite ---

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "font-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "object-src 'none'",
].join('; ');

app.use((req, res, next) => {
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  if (req.secure) {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000');
  }
  next();
});

// Express 4 ne transmet pas les erreurs des handlers async : sans ce wrapper,
// une panne de la base ferait planter tout le processus.
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// Route de ping pour un service de keep-alive externe (evite la mise en veille
// du plan gratuit Render). Volontairement avant le middleware d'auth.
app.get('/healthz', (req, res) => res.json({ ok: true }));

app.use(auth.authMiddleware);
app.use(express.static(path.join(__dirname, 'public')));

// --- Validation des saisies ---

const MISSIONS = ['Citiz', 'Controle technique', 'Livraison', 'Autre'];
const VEHICULES = ['Relais Citiz', 'Vehicule perso', 'Vehicule controle technique'];
const CENTRES = ['Eckbolsheim', 'Truchtersheim', 'Marlenheim', 'Neudorf'];
const MAX_MONTANT_PLEIN = 300;
const MAX_MONTANT_PARKING = 100;
const MAX_KM = 1000;
const MAX_MISSION_AUTRE = 80;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_RANGE_DAYS = 366;

// Nombre dans [min, max] ou null si le champ est vide ; undefined si invalide.
function parseNumber(value, min, max) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < min || n > max) return undefined;
  return Math.round(n * 100) / 100;
}

function invalid(res) {
  return res.status(400).json({ error: 'VALEUR_INVALIDE' });
}

function dateParam(req) {
  const date = req.query.date || db.toDateStr(new Date());
  return DATE_RE.test(date) ? date : null;
}

// --- Auth ---

app.post('/api/login', (req, res) => {
  const ip = req.ip || 'unknown';
  if (auth.isRateLimited(ip)) {
    return res.status(429).json({ error: 'TROP_DE_TENTATIVES' });
  }
  const { password } = req.body || {};
  const role = auth.checkPassword(password);
  if (!role) {
    auth.registerAttempt(ip);
    return res.status(401).json({ error: 'MOT_DE_PASSE_INCORRECT' });
  }
  auth.setSessionCookie(req, res, role);
  res.json({ ok: true, role });
});

app.get('/api/session', (req, res) => {
  res.json({ role: req.role });
});

app.post('/api/logout', (req, res) => {
  auth.clearSessionCookie(res);
  res.json({ ok: true });
});

// --- Trajets ---

app.get('/api/trajets/actif', wrap(async (req, res) => {
  const trajet = await db.getActiveTrajet();
  res.json({ trajet, now: new Date().toISOString() });
}));

app.post('/api/trajets/start', wrap(async (req, res) => {
  const result = await db.startTrajet();
  if (result.error) {
    return res.status(409).json(result);
  }
  res.json({ ...result, now: new Date().toISOString() });
}));

app.post('/api/trajets/:id/finish', wrap(async (req, res) => {
  const { missionType, missionAutre, vehicule, parkingPaye, parkingMontant, centreLivraison, km } = req.body || {};
  if (!missionType || !vehicule) {
    return res.status(400).json({ error: 'CHAMPS_MANQUANTS' });
  }
  if (!MISSIONS.includes(missionType) || !VEHICULES.includes(vehicule)) return invalid(res);
  if (missionType === 'Livraison' && !CENTRES.includes(centreLivraison)) return invalid(res);
  if (missionAutre !== undefined && missionAutre !== null && typeof missionAutre !== 'string') return invalid(res);

  const parking = parkingPaye === true;
  const parkingValue = parseNumber(parkingMontant, 0, MAX_MONTANT_PARKING);
  const kmValue = parseNumber(km, 0, MAX_KM);
  if (kmValue === undefined || (parking && (parkingValue === undefined || parkingValue === null))) {
    return invalid(res);
  }

  const result = await db.finishTrajet(req.params.id, {
    missionType,
    missionAutre: typeof missionAutre === 'string' ? missionAutre.trim().slice(0, MAX_MISSION_AUTRE) : null,
    vehicule,
    parkingPaye: parking,
    parkingMontant: parking ? parkingValue : null,
    centreLivraison: missionType === 'Livraison' ? centreLivraison : null,
    km: kmValue,
  });
  if (result.error) {
    return res.status(400).json(result);
  }
  res.json(result);
}));

app.post('/api/trajets/:id/cancel', wrap(async (req, res) => {
  const result = await db.cancelTrajet(req.params.id);
  if (result.error) {
    return res.status(400).json(result);
  }
  res.json(result);
}));

app.get('/api/trajets', wrap(async (req, res) => {
  const date = dateParam(req);
  if (!date) return invalid(res);
  res.json({ trajets: await db.getTrajetsByDate(date) });
}));

// --- Pleins ---

app.post('/api/pleins', wrap(async (req, res) => {
  const { vehicule, montant } = req.body || {};
  if (!vehicule || montant === undefined || montant === null || montant === '') {
    return res.status(400).json({ error: 'CHAMPS_MANQUANTS' });
  }
  const montantValue = parseNumber(montant, 0.01, MAX_MONTANT_PLEIN);
  if (!VEHICULES.includes(vehicule) || montantValue === undefined) return invalid(res);
  const result = await db.addPlein({ vehicule, montant: montantValue });
  res.json(result);
}));

app.get('/api/pleins', wrap(async (req, res) => {
  const date = dateParam(req);
  if (!date) return invalid(res);
  res.json({ pleins: await db.getPleinsByDate(date) });
}));

// --- Admin (tableau de bord) ---

app.get('/api/admin/activite', wrap(async (req, res) => {
  const { from, to } = req.query;
  if (!DATE_RE.test(from || '') || !DATE_RE.test(to || '') || from > to) {
    return res.status(400).json({ error: 'PERIODE_INVALIDE' });
  }
  const days = (new Date(to) - new Date(from)) / 86400000;
  if (days > MAX_RANGE_DAYS) {
    return res.status(400).json({ error: 'PERIODE_TROP_LONGUE' });
  }
  const [trajets, pleins] = await Promise.all([
    db.getTrajetsBetween(from, to),
    db.getPleinsBetween(from, to),
  ]);
  res.json({ trajets, pleins, now: new Date().toISOString() });
}));

// --- Erreurs ---

app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed' || err.type === 'entity.too.large') {
    return res.status(400).json({ error: 'REQUETE_INVALIDE' });
  }
  console.error(`Erreur sur ${req.method} ${req.path}`, err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: 'ERREUR_SERVEUR' });
});

process.on('unhandledRejection', (err) => {
  console.error('Promesse rejetee non geree', err);
});

db.init()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`MobiTrack demarre sur http://localhost:${PORT}`);
    });
  })
  .catch((err) => {
    console.error('Echec d\'initialisation de la base de donnees', err);
    process.exit(1);
  });
