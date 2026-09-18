require('dotenv').config();

const express = require('express');
const path = require('path');
const db = require('./db');
const auth = require('./auth');

const app = express();
const PORT = process.env.PORT || 3000;

app.set('trust proxy', true);
app.use(express.json());

// Route de ping pour un service de keep-alive externe (evite la mise en veille
// du plan gratuit Render). Volontairement avant le middleware d'auth.
app.get('/healthz', (req, res) => res.json({ ok: true }));

app.use(auth.authMiddleware);
app.use(express.static(path.join(__dirname, 'public')));

// --- Auth ---

app.post('/api/login', (req, res) => {
  const ip = req.ip || 'unknown';
  if (auth.isRateLimited(ip)) {
    return res.status(429).json({ error: 'TROP_DE_TENTATIVES' });
  }
  const { password } = req.body;
  if (!auth.checkPassword(password)) {
    auth.registerAttempt(ip);
    return res.status(401).json({ error: 'MOT_DE_PASSE_INCORRECT' });
  }
  auth.setSessionCookie(req, res);
  res.json({ ok: true });
});

app.post('/api/logout', (req, res) => {
  auth.clearSessionCookie(res);
  res.json({ ok: true });
});

// --- Trajets ---

app.get('/api/trajets/actif', async (req, res) => {
  const trajet = await db.getActiveTrajet();
  res.json({ trajet, now: new Date().toISOString() });
});

app.post('/api/trajets/start', async (req, res) => {
  const result = await db.startTrajet();
  if (result.error) {
    return res.status(409).json(result);
  }
  res.json({ ...result, now: new Date().toISOString() });
});

app.post('/api/trajets/:id/finish', async (req, res) => {
  const { missionType, missionAutre, vehicule, parkingPaye, parkingMontant, centreLivraison, km } = req.body;
  if (!missionType || !vehicule) {
    return res.status(400).json({ error: 'CHAMPS_MANQUANTS' });
  }
  const result = await db.finishTrajet(req.params.id, {
    missionType,
    missionAutre,
    vehicule,
    parkingPaye,
    parkingMontant,
    centreLivraison,
    km,
  });
  if (result.error) {
    return res.status(400).json(result);
  }
  res.json(result);
});

app.get('/api/trajets', async (req, res) => {
  const date = req.query.date || db.toDateStr(new Date());
  res.json({ trajets: await db.getTrajetsByDate(date) });
});

// --- Pleins ---

app.post('/api/pleins', async (req, res) => {
  const { vehicule, montant } = req.body;
  if (!vehicule || montant === undefined || montant === null || montant === '') {
    return res.status(400).json({ error: 'CHAMPS_MANQUANTS' });
  }
  const result = await db.addPlein({ vehicule, montant });
  res.json(result);
});

app.get('/api/pleins', async (req, res) => {
  const date = req.query.date || db.toDateStr(new Date());
  res.json({ pleins: await db.getPleinsByDate(date) });
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
