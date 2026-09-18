const state = {
  activeTrajet: null,
  timerInterval: null,
  currentJourDate: null,
};

// --- Helpers ---

function pad(n) {
  return String(n).padStart(2, '0');
}

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function formatTime(iso) {
  const d = new Date(iso);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function formatDurationMin(minutes) {
  if (minutes === null || minutes === undefined) return '-';
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m}min`;
  return `${h}h${pad(m)}`;
}

function formatElapsed(ms) {
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  return `${pad(h)}:${pad(m)}:${pad(s)}`;
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function labelMissionType(t) {
  if (t.missionType === 'Autre') return escapeHtml(t.missionAutre || 'Autre');
  return t.missionType;
}

// --- Gamification (légère et discrète) ---

const POSITIVE_MESSAGES = [
  'Trajet enregistré, bravo ! 👍',
  'Encore un de fait ✅',
  'Nickel, trajet noté.',
  'Bien joué, c\'est enregistré.',
  'Trajet bouclé, au suivant !',
  'C\'est noté, merci !',
];

const SAFETY_MESSAGES = [
  'Pense à boucler ta ceinture 🚗',
  'Pas de tél au volant, on souffle 2 min si besoin.',
  'Fatigue = pause, même 5 min ça compte.',
  'Une gorgée d\'eau, ça fait pas de mal 💧',
  'Doucement sur les ronds-points, on a le temps.',
];

let lastMessage = null;
function pickMessage(pool) {
  if (pool.length === 1) return pool[0];
  let msg;
  do {
    msg = pool[Math.floor(Math.random() * pool.length)];
  } while (msg === lastMessage);
  lastMessage = msg;
  return msg;
}

let toastTimeout = null;
function showToast(message) {
  const toast = document.getElementById('toast');
  clearTimeout(toastTimeout);
  toast.textContent = message;
  toast.classList.remove('hidden');
  toastTimeout = setTimeout(() => toast.classList.add('hidden'), 3500);
}

function showPostTrajetMessage() {
  const showSafety = Math.random() < 0.22; // environ 1 fois sur 4-5
  const pool = showSafety ? SAFETY_MESSAGES : POSITIVE_MESSAGES;
  showToast(pickMessage(pool));
}

// --- Réseau (avec timeout + tolérance aux réveils de serveur lents) ---

async function api(url, options = {}, timeoutMs = 15000) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(url, {
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      ...options,
    });
  } catch (err) {
    throw Object.assign(new Error('CONNEXION_IMPOSSIBLE'), { networkError: true });
  } finally {
    clearTimeout(timeoutId);
  }
  if (res.status === 401) {
    window.location.href = '/login.html';
    return new Promise(() => {}); // stoppe l'exécution, la navigation prend le relais
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw Object.assign(new Error(data.error || 'ERREUR'), { data });
  }
  return data;
}

// Reessaie automatiquement en cas de souci reseau/timeout (ex: le serveur
// gratuit qui se reveille apres une pause), mais pas sur une vraie erreur
// metier (ex: trajet deja termine).
async function apiWithNetworkRetry(url, options, btn, baseLabel, { retries = 3, delayMs = 3000 } = {}) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await api(url, options);
    } catch (err) {
      const isNetworkIssue = !!err.networkError;
      if (!isNetworkIssue || attempt === retries) throw err;
      if (btn) btn.textContent = `Nouvelle tentative (${attempt + 1}/${retries})…`;
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
}

// --- Navigation ---

function showView(id) {
  document.querySelectorAll('.view').forEach((v) => v.classList.add('hidden'));
  document.getElementById(id).classList.remove('hidden');
}

function openModal(id) {
  document.getElementById(id).classList.remove('hidden');
}

function closeModal(id) {
  document.getElementById(id).classList.add('hidden');
}

// --- Bandeau de reconnexion ---

const DEFAULT_RECONNECT_TEXT =
  'Connexion au serveur en cours (réveil après une pause), ça peut prendre jusqu\'à une minute…';

function showReconnectBanner(visible, text) {
  const banner = document.getElementById('reconnect-banner');
  if (!banner) return;
  if (!visible) {
    banner.classList.add('hidden');
    return;
  }
  banner.innerHTML = `${escapeHtml(text || DEFAULT_RECONNECT_TEXT)} <button id="btn-retry-connection" class="reconnect-retry-btn">Réessayer</button>`;
  banner.classList.remove('hidden');
  document.getElementById('btn-retry-connection').addEventListener('click', () => ensureHomeFresh());
}

// --- Home / trajet status ---

let homeLoading = false;

async function ensureHomeFresh() {
  if (homeLoading) return;
  homeLoading = true;
  try {
    await refreshHome();
    showReconnectBanner(false);
  } catch (e) {
    showReconnectBanner(true);
    const MAX_RETRIES = 6;
    let success = false;
    for (let i = 0; i < MAX_RETRIES; i++) {
      await new Promise((r) => setTimeout(r, 3000));
      try {
        await refreshHome();
        success = true;
        break;
      } catch (err) {
        // on continue les tentatives
      }
    }
    showReconnectBanner(
      !success,
      success ? undefined : 'Toujours pas de réponse du serveur. Vérifie ta connexion et réessaie.'
    );
  } finally {
    homeLoading = false;
  }
  refreshTrajetCounter().catch(() => {});
}

async function refreshHome() {
  const { trajet } = await api('/api/trajets/actif');
  state.activeTrajet = trajet;
  renderTrajetCard();
}

async function refreshTrajetCounter() {
  const el = document.getElementById('trajet-counter');
  if (!el) return;
  const { trajets } = await api(`/api/trajets?date=${todayStr()}`);
  const count = trajets.filter((t) => t.status === 'termine').length;
  el.textContent =
    count === 0 ? '' : count === 1 ? '1 trajet effectué aujourd\'hui' : `${count} trajets effectués aujourd'hui`;
}

function renderTrajetCard() {
  const card = document.getElementById('trajet-status-card');
  clearInterval(state.timerInterval);

  if (state.activeTrajet) {
    card.className = 'card trajet-active';
    card.innerHTML = `
      <div class="status-label">Trajet en cours</div>
      <div class="trajet-timer" id="trajet-timer">00:00:00</div>
      <button id="btn-finish" class="btn btn-danger btn-big">⏹ Terminer le trajet</button>
    `;
    const debut = new Date(state.activeTrajet.heureDebut).getTime();
    const timerEl = document.getElementById('trajet-timer');
    const tick = () => {
      timerEl.textContent = formatElapsed(Date.now() - debut);
    };
    tick();
    state.timerInterval = setInterval(tick, 1000);
    document.getElementById('btn-finish').addEventListener('click', onOpenFinish);
  } else {
    card.className = 'card trajet-idle';
    card.innerHTML = `
      <div class="status-label">Aucun trajet en cours</div>
      <button id="btn-start" class="btn btn-primary btn-big">▶ Démarrer un trajet</button>
    `;
    document.getElementById('btn-start').addEventListener('click', onStartTrajet);
  }
}

async function onStartTrajet(e) {
  const btn = e.currentTarget;
  const originalText = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Démarrage…';
  try {
    const { trajet } = await apiWithNetworkRetry('/api/trajets/start', { method: 'POST' }, btn, originalText);
    state.activeTrajet = trajet;
    renderTrajetCard();
  } catch (err) {
    btn.disabled = false;
    btn.textContent = originalText;
    alert('Impossible de démarrer le trajet : ' + err.message);
  }
}

function onOpenFinish() {
  document.getElementById('form-finish').reset();
  document.getElementById('mission-autre-input').classList.add('hidden');
  document.getElementById('centre-livraison-select').classList.add('hidden');
  document.getElementById('parking-montant-input').classList.add('hidden');
  openModal('modal-finish');
}

document.getElementById('btn-cancel-finish').addEventListener('click', () => closeModal('modal-finish'));

document.querySelectorAll('#mission-type-group input[name="missionType"]').forEach((input) => {
  input.addEventListener('change', () => {
    const value = document.querySelector('#mission-type-group input[name="missionType"]:checked').value;
    document.getElementById('mission-autre-input').classList.toggle('hidden', value !== 'Autre');
    document.getElementById('centre-livraison-select').classList.toggle('hidden', value !== 'Livraison');
  });
});

document.querySelectorAll('input[name="parkingPaye"]').forEach((input) => {
  input.addEventListener('change', () => {
    const isOui = document.querySelector('input[name="parkingPaye"]:checked').value === 'oui';
    document.getElementById('parking-montant-input').classList.toggle('hidden', !isOui);
  });
});

document.getElementById('form-finish').addEventListener('submit', async (e) => {
  e.preventDefault();
  const missionType = document.querySelector('input[name="missionType"]:checked')?.value;
  const missionAutre = document.getElementById('mission-autre-input').value;
  const centreLivraison = document.getElementById('centre-livraison-select').value;
  const vehicule = document.querySelector('input[name="vehicule"]:checked')?.value;
  const parkingPaye = document.querySelector('input[name="parkingPaye"]:checked')?.value === 'oui';
  const parkingMontant = document.getElementById('parking-montant-input').value;
  const km = document.getElementById('km-input').value;

  if (!missionType || !vehicule) {
    alert('Merci de remplir tous les champs.');
    return;
  }
  if (missionType === 'Livraison' && !centreLivraison) {
    alert('Merci de préciser le centre de livraison.');
    return;
  }

  const btn = e.submitter || document.querySelector('#form-finish button[type="submit"]');
  const originalText = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Enregistrement…';

  try {
    await apiWithNetworkRetry(
      `/api/trajets/${state.activeTrajet.id}/finish`,
      {
        method: 'POST',
        body: JSON.stringify({ missionType, missionAutre, centreLivraison, vehicule, parkingPaye, parkingMontant, km }),
      },
      btn,
      originalText
    );
    closeModal('modal-finish');
    state.activeTrajet = null;
    renderTrajetCard();
    refreshTrajetCounter().catch(() => {});
    showPostTrajetMessage();
  } catch (err) {
    alert('Erreur : ' + err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = originalText;
  }
});

// --- Plein ---

document.getElementById('btn-plein').addEventListener('click', () => {
  document.getElementById('form-plein').reset();
  openModal('modal-plein');
});

document.getElementById('btn-cancel-plein').addEventListener('click', () => closeModal('modal-plein'));

document.getElementById('form-plein').addEventListener('submit', async (e) => {
  e.preventDefault();
  const vehicule = document.querySelector('input[name="vehiculePlein"]:checked')?.value;
  const montant = document.getElementById('montant-plein-input').value;

  if (!vehicule || montant === '') {
    alert('Merci de remplir tous les champs.');
    return;
  }

  const btn = e.submitter || document.querySelector('#form-plein button[type="submit"]');
  const originalText = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Enregistrement…';

  try {
    await apiWithNetworkRetry(
      '/api/pleins',
      {
        method: 'POST',
        body: JSON.stringify({ vehicule, montant }),
      },
      btn,
      originalText
    );
    closeModal('modal-plein');
  } catch (err) {
    alert('Erreur : ' + err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = originalText;
  }
});

// --- Vue jour ---

document.getElementById('btn-go-jour').addEventListener('click', () => {
  const today = todayStr();
  document.getElementById('input-date').value = today;
  showView('view-jour');
  loadJour(today);
});

document.getElementById('btn-go-date').addEventListener('click', () => {
  const date = document.getElementById('input-date').value || todayStr();
  document.getElementById('input-date').value = date;
  showView('view-jour');
  loadJour(date);
});

document.getElementById('btn-back-home').addEventListener('click', () => {
  showView('view-home');
  ensureHomeFresh();
});

document.getElementById('input-date').addEventListener('change', (e) => {
  loadJour(e.target.value);
});

async function loadJour(dateStr) {
  state.currentJourDate = dateStr;
  try {
    const [{ trajets }, { pleins }] = await Promise.all([
      apiWithNetworkRetry(`/api/trajets?date=${dateStr}`, {}, null),
      apiWithNetworkRetry(`/api/pleins?date=${dateStr}`, {}, null),
    ]);
    renderJourSummary(trajets, pleins);
    renderTimeline(trajets, pleins);
  } catch (err) {
    document.getElementById('jour-timeline').innerHTML =
      '<div class="empty-state">Impossible de charger ces données, vérifie ta connexion et réessaie.</div>';
  }
}

function renderJourSummary(trajets, pleins) {
  const totalMinutes = trajets.reduce((sum, t) => {
    if (t.dureeMinutes != null) return sum + t.dureeMinutes;
    if (t.status === 'en_cours') {
      return sum + Math.round((Date.now() - new Date(t.heureDebut).getTime()) / 60000);
    }
    return sum;
  }, 0);
  const totalParking = trajets.reduce((sum, t) => sum + (t.parkingMontant || 0), 0);
  const totalPleins = pleins.reduce((sum, p) => sum + (p.montant || 0), 0);
  const totalKm = trajets.reduce((sum, t) => sum + (t.km || 0), 0);

  const summary = document.getElementById('jour-summary');
  summary.innerHTML = `
    <div class="summary-row"><span class="summary-label">Nombre de trajets</span><span class="summary-value">${trajets.length}</span></div>
    <div class="summary-row"><span class="summary-label">Temps total en trajet</span><span class="summary-value">${formatDurationMin(totalMinutes)}</span></div>
    <div class="summary-row"><span class="summary-label">Total km parcourus</span><span class="summary-value">${totalKm} km</span></div>
    <div class="summary-row"><span class="summary-label">Total parking</span><span class="summary-value">${totalParking.toFixed(2)} €</span></div>
    <div class="summary-row"><span class="summary-label">Total pleins</span><span class="summary-value">${totalPleins.toFixed(2)} €</span></div>
  `;
}

function renderTimeline(trajets, pleins) {
  const container = document.getElementById('jour-timeline');

  if (trajets.length === 0 && pleins.length === 0) {
    container.innerHTML = `<div class="empty-state">Aucune activité ce jour-là.</div>`;
    return;
  }

  const events = [];
  trajets.forEach((t) => events.push({ type: 'trajet', time: t.heureDebut, data: t }));
  pleins.forEach((p) => events.push({ type: 'plein', time: p.heure, data: p }));
  events.sort((a, b) => new Date(a.time) - new Date(b.time));

  const finishedSorted = trajets
    .filter((t) => t.heureFin)
    .sort((a, b) => new Date(a.heureDebut) - new Date(b.heureDebut));
  const gapAfter = {};
  const GAP_THRESHOLD_MIN = 5;
  for (let i = 0; i < finishedSorted.length - 1; i++) {
    const cur = finishedSorted[i];
    const next = finishedSorted[i + 1];
    const gapMin = Math.round((new Date(next.heureDebut) - new Date(cur.heureFin)) / 60000);
    if (gapMin >= GAP_THRESHOLD_MIN) {
      gapAfter[cur.id] = gapMin;
    }
  }

  let html = '';
  events.forEach((e) => {
    if (e.type === 'trajet') {
      const t = e.data;
      const enCours = t.status === 'en_cours';
      html += `
        <div class="timeline-item">
          <div class="timeline-top">
            <span>${formatTime(t.heureDebut)} → ${enCours ? 'en cours' : formatTime(t.heureFin)}</span>
            <span>${enCours ? '' : formatDurationMin(t.dureeMinutes)}</span>
          </div>
          <div class="timeline-detail">
            <span>🚗 ${enCours ? 'Trajet en cours' : labelMissionType(t)}</span>
            ${t.missionType === 'Livraison' && t.centreLivraison ? `<span>🏭 ${escapeHtml(t.centreLivraison)}</span>` : ''}
            ${t.vehicule ? `<span>🔑 ${t.vehicule}</span>` : ''}
            ${t.parkingPaye ? `<span>🅿️ ${t.parkingMontant.toFixed(2)} €</span>` : ''}
            ${t.km ? `<span>📏 ${t.km} km</span>` : ''}
          </div>
        </div>
      `;
      if (gapAfter[t.id]) {
        html += `<div class="timeline-item gap">⏳ Temps mort : ${formatDurationMin(gapAfter[t.id])}</div>`;
      }
    } else {
      const p = e.data;
      html += `
        <div class="timeline-item plein">
          <div class="timeline-top">
            <span>${formatTime(p.heure)} · Plein</span>
            <span>${p.montant.toFixed(2)} €</span>
          </div>
          <div class="timeline-detail"><span>🔑 ${p.vehicule}</span></div>
        </div>
      `;
    }
  });

  container.innerHTML = html;
}

// --- Logout ---

document.getElementById('btn-logout').addEventListener('click', async () => {
  await fetch('/api/logout', { method: 'POST' });
  window.location.href = '/login.html';
});

// --- Reprise apres pause (veille du telephone, app en arriere-plan, etc.) ---

document.addEventListener('visibilitychange', () => {
  const homeVisible = !document.getElementById('view-home').classList.contains('hidden');
  if (document.visibilityState === 'visible' && homeVisible) {
    ensureHomeFresh();
  }
});

window.addEventListener('pageshow', (e) => {
  if (e.persisted) {
    ensureHomeFresh();
  }
});

// --- Init ---

ensureHomeFresh();
