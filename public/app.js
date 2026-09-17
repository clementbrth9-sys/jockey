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

async function api(url, options) {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
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

// --- Home / trajet status ---

async function refreshHome() {
  const { trajet } = await api('/api/trajets/actif');
  state.activeTrajet = trajet;
  renderTrajetCard();
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

async function onStartTrajet() {
  try {
    const { trajet } = await api('/api/trajets/start', { method: 'POST' });
    state.activeTrajet = trajet;
    renderTrajetCard();
  } catch (e) {
    alert("Impossible de démarrer le trajet : " + e.message);
  }
}

function onOpenFinish() {
  document.getElementById('form-finish').reset();
  document.getElementById('mission-autre-input').classList.add('hidden');
  document.getElementById('parking-montant-input').classList.add('hidden');
  openModal('modal-finish');
}

document.getElementById('btn-cancel-finish').addEventListener('click', () => closeModal('modal-finish'));

document.querySelectorAll('#mission-type-group input[name="missionType"]').forEach((input) => {
  input.addEventListener('change', () => {
    const isAutre = document.querySelector('#mission-type-group input[name="missionType"]:checked').value === 'Autre';
    document.getElementById('mission-autre-input').classList.toggle('hidden', !isAutre);
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
  const vehicule = document.querySelector('input[name="vehicule"]:checked')?.value;
  const parkingPaye = document.querySelector('input[name="parkingPaye"]:checked')?.value === 'oui';
  const parkingMontant = document.getElementById('parking-montant-input').value;

  if (!missionType || !vehicule) {
    alert('Merci de remplir tous les champs.');
    return;
  }

  try {
    await api(`/api/trajets/${state.activeTrajet.id}/finish`, {
      method: 'POST',
      body: JSON.stringify({ missionType, missionAutre, vehicule, parkingPaye, parkingMontant }),
    });
    closeModal('modal-finish');
    state.activeTrajet = null;
    renderTrajetCard();
  } catch (err) {
    alert('Erreur : ' + err.message);
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

  try {
    await api('/api/pleins', {
      method: 'POST',
      body: JSON.stringify({ vehicule, montant }),
    });
    closeModal('modal-plein');
  } catch (err) {
    alert('Erreur : ' + err.message);
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
  refreshHome();
});

document.getElementById('input-date').addEventListener('change', (e) => {
  loadJour(e.target.value);
});

async function loadJour(dateStr) {
  state.currentJourDate = dateStr;
  const [{ trajets }, { pleins }] = await Promise.all([
    api(`/api/trajets?date=${dateStr}`),
    api(`/api/pleins?date=${dateStr}`),
  ]);
  renderJourSummary(trajets, pleins);
  renderTimeline(trajets, pleins);
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

  const summary = document.getElementById('jour-summary');
  summary.innerHTML = `
    <div class="summary-row"><span class="summary-label">Nombre de trajets</span><span class="summary-value">${trajets.length}</span></div>
    <div class="summary-row"><span class="summary-label">Temps total en trajet</span><span class="summary-value">${formatDurationMin(totalMinutes)}</span></div>
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
            ${t.vehicule ? `<span>🔑 ${t.vehicule}</span>` : ''}
            ${t.parkingPaye ? `<span>🅿️ ${t.parkingMontant.toFixed(2)} €</span>` : ''}
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

// --- Init ---

refreshHome();
