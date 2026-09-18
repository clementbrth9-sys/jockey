const path = require('path');
const crypto = require('crypto');
const { createClient } = require('@libsql/client');

const client = createClient({
  url: process.env.TURSO_DATABASE_URL || `file:${path.join(__dirname, 'data', 'local.db')}`,
  authToken: process.env.TURSO_AUTH_TOKEN || undefined,
});

async function addColumnIfMissing(table, column, definition) {
  try {
    await client.execute(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  } catch (err) {
    if (!/duplicate column name/i.test(err.message)) throw err;
  }
}

async function init() {
  await client.execute(`
    CREATE TABLE IF NOT EXISTS trajets (
      id TEXT PRIMARY KEY,
      date TEXT NOT NULL,
      heureDebut TEXT NOT NULL,
      heureFin TEXT,
      dureeMinutes INTEGER,
      missionType TEXT,
      missionAutre TEXT,
      vehicule TEXT,
      parkingPaye INTEGER NOT NULL DEFAULT 0,
      parkingMontant REAL,
      status TEXT NOT NULL
    )
  `);
  await client.execute(`
    CREATE TABLE IF NOT EXISTS pleins (
      id TEXT PRIMARY KEY,
      date TEXT NOT NULL,
      heure TEXT NOT NULL,
      vehicule TEXT NOT NULL,
      montant REAL NOT NULL
    )
  `);
  await addColumnIfMissing('trajets', 'centreLivraison', 'TEXT');
  await addColumnIfMissing('trajets', 'km', 'REAL');
}

function toDateStr(d) {
  // YYYY-MM-DD in local time
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function rowToTrajet(row) {
  if (!row) return null;
  return {
    id: row.id,
    date: row.date,
    heureDebut: row.heureDebut,
    heureFin: row.heureFin,
    dureeMinutes: row.dureeMinutes,
    missionType: row.missionType,
    missionAutre: row.missionAutre,
    vehicule: row.vehicule,
    parkingPaye: !!row.parkingPaye,
    parkingMontant: row.parkingMontant,
    centreLivraison: row.centreLivraison,
    km: row.km,
    status: row.status,
  };
}

function rowToPlein(row) {
  if (!row) return null;
  return {
    id: row.id,
    date: row.date,
    heure: row.heure,
    vehicule: row.vehicule,
    montant: row.montant,
  };
}

async function getActiveTrajet() {
  const result = await client.execute({
    sql: `SELECT * FROM trajets WHERE status = 'en_cours' LIMIT 1`,
    args: [],
  });
  return rowToTrajet(result.rows[0]);
}

async function startTrajet() {
  const existing = await getActiveTrajet();
  if (existing) {
    return { error: 'TRAJET_DEJA_EN_COURS', trajet: existing };
  }
  const now = new Date();
  const trajet = {
    id: crypto.randomUUID(),
    date: toDateStr(now),
    heureDebut: now.toISOString(),
    heureFin: null,
    dureeMinutes: null,
    missionType: null,
    missionAutre: null,
    vehicule: null,
    parkingPaye: false,
    parkingMontant: null,
    centreLivraison: null,
    km: null,
    status: 'en_cours',
  };
  await client.execute({
    sql: `INSERT INTO trajets (id, date, heureDebut, heureFin, dureeMinutes, missionType, missionAutre, vehicule, parkingPaye, parkingMontant, status)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      trajet.id,
      trajet.date,
      trajet.heureDebut,
      trajet.heureFin,
      trajet.dureeMinutes,
      trajet.missionType,
      trajet.missionAutre,
      trajet.vehicule,
      trajet.parkingPaye ? 1 : 0,
      trajet.parkingMontant,
      trajet.status,
    ],
  });
  return { trajet };
}

async function finishTrajet(id, details) {
  const result = await client.execute({
    sql: `SELECT * FROM trajets WHERE id = ?`,
    args: [id],
  });
  const trajet = rowToTrajet(result.rows[0]);
  if (!trajet) {
    return { error: 'TRAJET_INTROUVABLE' };
  }
  if (trajet.status !== 'en_cours') {
    return { error: 'TRAJET_DEJA_TERMINE' };
  }
  const now = new Date();
  const debut = new Date(trajet.heureDebut);
  const dureeMinutes = Math.round((now.getTime() - debut.getTime()) / 60000);

  const missionAutre = details.missionType === 'Autre' ? (details.missionAutre || '') : null;
  const centreLivraison = details.missionType === 'Livraison' ? (details.centreLivraison || '') : null;
  const parkingPaye = !!details.parkingPaye;
  const parkingMontant = parkingPaye ? Number(details.parkingMontant) || 0 : null;
  const km = details.km !== undefined && details.km !== null && details.km !== ''
    ? Number(details.km)
    : null;

  await client.execute({
    sql: `UPDATE trajets SET heureFin = ?, dureeMinutes = ?, missionType = ?, missionAutre = ?, vehicule = ?, parkingPaye = ?, parkingMontant = ?, centreLivraison = ?, km = ?, status = 'termine' WHERE id = ?`,
    args: [
      now.toISOString(),
      dureeMinutes,
      details.missionType,
      missionAutre,
      details.vehicule,
      parkingPaye ? 1 : 0,
      parkingMontant,
      centreLivraison,
      km,
      id,
    ],
  });

  return {
    trajet: {
      ...trajet,
      heureFin: now.toISOString(),
      dureeMinutes,
      missionType: details.missionType,
      missionAutre,
      vehicule: details.vehicule,
      parkingPaye,
      parkingMontant,
      centreLivraison,
      km,
      status: 'termine',
    },
  };
}

async function getTrajetsByDate(dateStr) {
  const result = await client.execute({
    sql: `SELECT * FROM trajets WHERE date = ? ORDER BY heureDebut ASC`,
    args: [dateStr],
  });
  return result.rows.map(rowToTrajet);
}

async function addPlein({ vehicule, montant }) {
  const now = new Date();
  const plein = {
    id: crypto.randomUUID(),
    date: toDateStr(now),
    heure: now.toISOString(),
    vehicule,
    montant: Number(montant) || 0,
  };
  await client.execute({
    sql: `INSERT INTO pleins (id, date, heure, vehicule, montant) VALUES (?, ?, ?, ?, ?)`,
    args: [plein.id, plein.date, plein.heure, plein.vehicule, plein.montant],
  });
  return { plein };
}

async function getPleinsByDate(dateStr) {
  const result = await client.execute({
    sql: `SELECT * FROM pleins WHERE date = ? ORDER BY heure ASC`,
    args: [dateStr],
  });
  return result.rows.map(rowToPlein);
}

module.exports = {
  init,
  getActiveTrajet,
  startTrajet,
  finishTrajet,
  getTrajetsByDate,
  addPlein,
  getPleinsByDate,
  toDateStr,
};
