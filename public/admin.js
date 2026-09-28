// Tableau de bord admin : comprendre les trajets du jockey sur une periode.

const GAP_THRESHOLD_MIN = 5; // meme seuil que la vue Historique de l'app
const LONG_TRAJET_MIN = 180;
const LONG_GAP_MIN = 60;
const FORGOTTEN_TRAJET_HOURS = 12;

// Ordre fixe (couleur = type de mission, jamais le rang). Palette validee
// daltonisme/contraste, slot 1 = bleu Mobileo.
const MISSIONS = [
  { key: 'Citiz', label: 'Citiz', color: '#2c558f' },
  { key: 'Controle technique', label: 'Contrôle technique', color: '#d97706' },
  { key: 'Livraison', label: 'Livraison', color: '#0f9488' },
  { key: 'Autre', label: 'Autre', color: '#9d4edd' },
];
const MISSION_BY_KEY = Object.fromEntries(MISSIONS.map((m) => [m.key, m]));
const EN_COURS = { label: 'En cours ou non clôturé', color: '#6b7280' };

const VEHICULE_LABELS = {
  'Relais Citiz': 'Relais Citiz',
  'Vehicule perso': 'Véhicule perso',
  'Vehicule controle technique': 'Véhicule contrôle technique',
};

const state = { from: null, to: null, data: null, loadId: 0 };

// --- Helpers ---

const pad = (n) => String(n).padStart(2, '0');
const EUR = new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR' });
const NUM = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 1 });
const DAY_LABEL = new Intl.DateTimeFormat('fr-FR', { weekday: 'short', day: '2-digit', month: '2-digit' });
const DAY_LONG = new Intl.DateTimeFormat('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });
const DAY_SHORT = new Intl.DateTimeFormat('fr-FR', { day: '2-digit', month: '2-digit' });

function toDateStr(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function parseDateStr(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function addDays(d, n) {
  const r = new Date(d);
  r.setDate(r.getDate() + n);
  return r;
}

function daysBetween(fromStr, toStr) {
  const out = [];
  for (let d = parseDateStr(fromStr); toDateStr(d) <= toStr; d = addDays(d, 1)) out.push(toDateStr(d));
  return out;
}

function fmtDur(min) {
  min = Math.round(min || 0);
  if (min < 60) return `${min} min`;
  return `${Math.floor(min / 60)} h ${pad(min % 60)}`;
}

function fmtTime(date) {
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function fmtDay(dateStr, fmt = DAY_LABEL) {
  return fmt.format(parseDateStr(dateStr));
}

function missionOf(t) {
  if (t.status === 'en_cours') return EN_COURS;
  return MISSION_BY_KEY[t.missionType] || MISSION_BY_KEY.Autre;
}

function missionText(t) {
  if (t.status === 'en_cours') return 'En cours';
  if (t.missionType === 'Autre') return t.missionAutre ? `Autre : ${t.missionAutre}` : 'Autre';
  if (t.missionType === 'Livraison' && t.centreLivraison) return `Livraison (${t.centreLivraison})`;
  return missionOf(t).label;
}

function vehiculeText(v) {
  return VEHICULE_LABELS[v] || v || '-';
}

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'style') Object.assign(node.style, v);
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of [].concat(children)) {
    if (c === null || c === undefined || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

// Graduation "propre" pour un axe en minutes
function niceStepMinutes(maxMin) {
  const steps = [15, 30, 60, 120, 180, 240, 360, 480, 720];
  return steps.find((s) => maxMin / s <= 5) || 1440;
}

// --- Analyse ---

function analyse(trajets, pleins, from, to, nowIso) {
  const now = new Date(nowIso);
  const days = daysBetween(from, to).map((date) => ({
    date, trajets: [], forgotten: [], pleins: [], trajetMin: 0, mortMin: 0, amplitudeMin: 0, gaps: [],
  }));
  const byDate = Object.fromEntries(days.map((d) => [d.date, d]));

  const items = trajets.map((t) => {
    const start = new Date(t.heureDebut);
    const enCours = t.status === 'en_cours';
    // Un trajet jamais cloture ne doit pas gonfler les totaux : il est signale a part.
    const forgotten = enCours && now - start > FORGOTTEN_TRAJET_HOURS * 3600000;
    const end = t.heureFin ? new Date(t.heureFin) : enCours && !forgotten ? now : start;
    const dur = t.dureeMinutes != null ? t.dureeMinutes : Math.max(0, Math.round((end - start) / 60000));
    return { ...t, start, end, dur, enCours, forgotten, gapBefore: null };
  });

  // Les trajets oublies restent visibles sur la frise mais hors calculs de la journee
  items.forEach((t) => byDate[t.date] && byDate[t.date][t.forgotten ? 'forgotten' : 'trajets'].push(t));
  pleins.forEach((p) => byDate[p.date] && byDate[p.date].pleins.push({ ...p, time: new Date(p.heure) }));

  for (const day of days) {
    const list = day.trajets.sort((a, b) => a.start - b.start);
    for (let i = 0; i < list.length; i++) {
      const t = list[i];
      day.trajetMin += t.dur;
      if (i > 0 && !list[i - 1].enCours) {
        const gap = Math.round((t.start - list[i - 1].end) / 60000);
        if (gap >= GAP_THRESHOLD_MIN) {
          t.gapBefore = gap;
          day.mortMin += gap;
          day.gaps.push({ from: list[i - 1].end, to: t.start, min: gap });
        }
      }
    }
    if (list.length) {
      const lastEnd = Math.max(...list.map((t) => t.end.getTime()));
      day.amplitudeMin = Math.round((lastEnd - list[0].start) / 60000);
    }
  }

  const activeDays = days.filter((d) => d.trajets.length);
  const finished = items.filter((t) => !t.enCours);
  const sum = (arr, f) => arr.reduce((s, x) => s + (f(x) || 0), 0);
  const trajetMin = sum(days, (d) => d.trajetMin);
  const mortMin = sum(days, (d) => d.mortMin);
  const amplitudeMin = sum(days, (d) => d.amplitudeMin);
  const allGaps = days.flatMap((d) => d.gaps.map((g) => ({ ...g, date: d.date })));

  return {
    days,
    activeDays,
    items,
    finished,
    pleins,
    totals: {
      count: items.filter((t) => !t.forgotten).length,
      trajetMin,
      mortMin,
      gapCount: allGaps.length,
      longestGap: allGaps.sort((a, b) => b.min - a.min)[0] || null,
      occupation: amplitudeMin ? trajetMin / amplitudeMin : null,
      km: sum(items, (t) => t.km),
      kmMissing: finished.filter((t) => !t.km).length,
      parking: sum(items, (t) => t.parkingMontant),
      carburant: sum(pleins, (p) => p.montant),
      avgDur: finished.length ? sum(finished, (t) => t.dur) / finished.length : 0,
    },
    now,
  };
}

// --- Chargement ---

async function fetchPeriod(from, to) {
  const res = await fetch(`/api/admin/activite?from=${from}&to=${to}`);
  if (res.status === 401) {
    window.location.href = '/login.html';
    return new Promise(() => {});
  }
  if (!res.ok) throw new Error('HTTP_' + res.status);
  return res.json();
}

async function load() {
  const { from, to } = state;
  const loadId = ++state.loadId;
  const content = document.getElementById('admin-content');
  const errorEl = document.getElementById('admin-error');
  content.classList.add('is-loading');
  content.setAttribute('aria-busy', 'true');

  // Periode precedente de meme longueur, pour comparer
  const len = daysBetween(from, to).length;
  const prevTo = toDateStr(addDays(parseDateStr(from), -1));
  const prevFrom = toDateStr(addDays(parseDateStr(from), -len));

  try {
    const [cur, prev] = await Promise.all([fetchPeriod(from, to), fetchPeriod(prevFrom, prevTo)]);
    if (loadId !== state.loadId) return; // une requete plus recente a pris le relais
    const a = analyse(cur.trajets, cur.pleins, from, to, cur.now);
    const p = analyse(prev.trajets, prev.pleins, prevFrom, prevTo, prev.now);
    errorEl.classList.add('hidden');
    render(a, p);
  } catch (e) {
    if (loadId !== state.loadId) return;
    errorEl.textContent = 'Impossible de charger les données. Vérifie la connexion et réessaie.';
    errorEl.classList.remove('hidden');
  } finally {
    if (loadId === state.loadId) {
      content.classList.remove('is-loading');
      content.removeAttribute('aria-busy');
    }
  }
}

function render(a, p) {
  state.data = a;
  renderKpis(a, p);
  renderAlerts(a);
  renderDaily(a);
  renderGantt(a);
  renderMissions(a);
  renderHours(a);
  renderBars('chart-vehicules', groupCount(a.finished, (t) => vehiculeText(t.vehicule)), 'trajet');
  renderBars(
    'chart-centres',
    groupCount(a.finished.filter((t) => t.missionType === 'Livraison'), (t) => t.centreLivraison || 'Non précisé'),
    'livraison'
  );
  renderTable(a);
}

// --- Indicateurs ---

// judge : 'higher' (hausse = bien), 'lower' (baisse = bien) ou null (volume, pas de jugement)
function delta(cur, prev, fmt, judge = null) {
  if (prev === null || prev === undefined || cur === null) return null;
  const diff = cur - prev;
  if (Math.abs(diff) < 1e-9) return { text: 'stable', dir: 'flat', tone: '' };
  const up = diff > 0;
  const tone = !judge ? '' : (judge === 'higher') === up ? 'is-good' : 'is-bad';
  return { text: `${up ? '+' : '−'}${fmt(Math.abs(diff))}`, dir: up ? 'up' : 'down', tone };
}

const ARROWS = {
  up: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 19V5M5 12l7-7 7 7" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  down: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12l7 7 7-7" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  flat: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/></svg>',
};

function kpi({ label, value, sub, d, hero }) {
  const tile = el('div', { class: `kpi${hero ? ' kpi-hero' : ''}` }, [
    el('div', { class: 'kpi-label', text: label }),
    el('div', { class: 'kpi-value', text: value }),
  ]);
  if (d) {
    const dEl = el('div', { class: `kpi-delta ${d.tone}` });
    dEl.innerHTML = ARROWS[d.dir];
    dEl.append(el('span', { class: 'sr-only', text: 'Évolution : ' }), document.createTextNode(d.text));
    tile.append(dEl);
  }
  if (sub) tile.append(el('div', { class: 'kpi-sub', text: sub }));
  return tile;
}

function renderKpis(a, p) {
  const t = a.totals;
  const pt = p.totals;
  const pct = (x) => (x === null ? '-' : `${Math.round(x * 100)} %`);
  const pts = (x) => `${Math.round(x * 100)} pts`;
  const container = document.getElementById('kpis');
  container.replaceChildren(
    kpi({
      label: "Taux d'occupation",
      value: pct(t.occupation),
      hero: true,
      d: t.occupation !== null && pt.occupation !== null ? delta(t.occupation, pt.occupation, pts, 'higher') : null,
      sub: 'Part du temps passé en trajet entre le premier départ et la dernière arrivée de chaque journée',
    }),
    kpi({
      label: 'Trajets',
      value: NUM.format(t.count),
      d: delta(t.count, pt.count, (x) => NUM.format(x)),
      sub: a.activeDays.length
        ? `${a.activeDays.length} jour${a.activeDays.length > 1 ? 's' : ''} actif${a.activeDays.length > 1 ? 's' : ''}, ${(t.count / a.activeDays.length).toLocaleString('fr-FR', { maximumFractionDigits: 1 })} par jour`
        : 'Aucun jour actif',
    }),
    kpi({
      label: 'Temps en trajet',
      value: fmtDur(t.trajetMin),
      d: delta(t.trajetMin, pt.trajetMin, fmtDur),
      sub: `Durée moyenne ${fmtDur(t.avgDur)}`,
    }),
    kpi({
      label: 'Temps mort',
      value: fmtDur(t.mortMin),
      d: delta(t.mortMin, pt.mortMin, fmtDur, 'lower'),
      sub: t.gapCount
        ? `${t.gapCount} pause${t.gapCount > 1 ? 's' : ''}, la plus longue ${fmtDur(t.longestGap.min)}`
        : 'Aucun temps mort',
    }),
    kpi({
      label: 'Kilomètres',
      value: `${NUM.format(t.km)} km`,
      d: delta(t.km, pt.km, (x) => `${NUM.format(x)} km`),
      sub: t.kmMissing ? `${t.kmMissing} trajet${t.kmMissing > 1 ? 's' : ''} sans km saisi` : 'Km saisis sur tous les trajets',
    }),
    kpi({
      label: 'Dépenses',
      value: EUR.format(t.parking + t.carburant),
      sub: `Carburant ${EUR.format(t.carburant)}, parking ${EUR.format(t.parking)}`,
    })
  );
  const prevFrom = p.days[0].date;
  const prevTo = p.days[p.days.length - 1].date;
  document.getElementById('kpi-note').textContent =
    `Évolutions comparées à la période précédente de même durée (${prevFrom === prevTo ? 'le ' + fmtDay(prevFrom, DAY_LONG) : 'du ' + fmtDay(prevFrom, DAY_SHORT) + ' au ' + fmtDay(prevTo, DAY_SHORT)}).`;
}

// --- Points d'attention ---

const ALERT_ICONS = {
  critical: '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
  warning: '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>',
  info: '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15 15"/></svg>',
  good: '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><polyline points="8 12 11 15 16 9"/></svg>',
};
const ALERT_LEVEL_LABEL = { critical: 'Critique', warning: 'À vérifier', info: 'Info', good: 'OK' };

function renderAlerts(a) {
  const alerts = [];
  const oublis = a.items.filter((t) => t.forgotten);
  oublis.forEach((t) =>
    alerts.push({
      level: 'critical',
      text: `Trajet démarré ${fmtDay(t.date, DAY_LONG)} à ${fmtTime(t.start)} toujours en cours : clôture probablement oubliée. Il n'est pas compté dans les totaux, et le jockey ne peut pas démarrer de nouveau trajet tant qu'il n'est pas terminé.`,
    })
  );

  const longs = a.finished.filter((t) => t.dur >= LONG_TRAJET_MIN).sort((x, y) => y.dur - x.dur);
  if (longs.length) {
    const top = longs[0];
    alerts.push({
      level: 'warning',
      text: `${longs.length} trajet${longs.length > 1 ? 's' : ''} de plus de ${LONG_TRAJET_MIN / 60} h. Le plus long : ${fmtDur(top.dur)} ${fmtDay(top.date, DAY_LONG)} (${missionText(top)}).`,
    });
  }

  const g = a.totals.longestGap;
  if (g && g.min >= LONG_GAP_MIN) {
    alerts.push({
      level: 'warning',
      text: `Plus long temps mort : ${fmtDur(g.min)} ${fmtDay(g.date, DAY_LONG)}, de ${fmtTime(g.from)} à ${fmtTime(g.to)}.`,
    });
  }

  if (a.totals.kmMissing) {
    alerts.push({
      level: 'info',
      text: `${a.totals.kmMissing} trajet${a.totals.kmMissing > 1 ? 's' : ''} terminé${a.totals.kmMissing > 1 ? 's' : ''} sans kilométrage : le total des km est sous-estimé.`,
    });
  }

  if (!alerts.length) alerts.push({ level: 'good', text: 'Rien à signaler sur la période.' });

  document.getElementById('alerts').replaceChildren(
    ...alerts.map((al) => {
      const icon = el('span', { class: 'alert-icon' });
      icon.innerHTML = ALERT_ICONS[al.level];
      return el('li', { class: `alert alert-${al.level}` }, [
        icon,
        el('span', { class: 'alert-level', text: ALERT_LEVEL_LABEL[al.level] }),
        el('span', { class: 'alert-text', text: al.text }),
      ]);
    })
  );
}

// --- Tooltip (survol souris, focus clavier, toucher) ---

const tooltip = document.getElementById('tooltip');

function tooltipContent(title, rows) {
  const frag = [el('div', { class: 'tt-title', text: title })];
  rows.forEach(([key, value, color, hatched]) => {
    frag.push(
      el('div', { class: 'tt-row' }, [
        color || hatched ? el('span', { class: `tt-key${hatched ? ' tt-key-hatched' : ''}`, style: color ? { background: color } : {} }) : null,
        el('span', { class: 'tt-value', text: value }),
        el('span', { class: 'tt-label', text: key }),
      ])
    );
  });
  return frag;
}

function showTooltip(target, content, clientX, clientY) {
  tooltip.replaceChildren(...content);
  tooltip.classList.remove('hidden');
  const r = target.getBoundingClientRect();
  const x = clientX ?? r.left + r.width / 2;
  const y = clientY ?? r.top;
  const tw = tooltip.offsetWidth;
  const th = tooltip.offsetHeight;
  let left = x + 14;
  if (left + tw > window.innerWidth - 8) left = x - tw - 14;
  left = Math.max(8, left);
  let top = y - th - 12;
  if (top < 8) top = y + 18;
  tooltip.style.left = `${left}px`;
  tooltip.style.top = `${top}px`;
}

function hideTooltip() {
  tooltip.classList.add('hidden');
}

function bindTooltip(node, getContent) {
  node.addEventListener('pointermove', (e) => showTooltip(node, getContent(), e.clientX, e.clientY));
  node.addEventListener('pointerleave', hideTooltip);
  node.addEventListener('focus', () => showTooltip(node, getContent()));
  node.addEventListener('blur', hideTooltip);
}

document.addEventListener('pointerdown', (e) => {
  if (!e.target.closest('[data-tip]')) hideTooltip();
});
window.addEventListener('scroll', hideTooltip, { passive: true });

// --- Graphique : temps par jour (colonnes empilees) ---

function renderDaily(a) {
  const container = document.getElementById('chart-daily');
  const maxMin = Math.max(60, ...a.days.map((d) => d.trajetMin + d.mortMin));
  const step = niceStepMinutes(maxMin);
  const top = Math.ceil(maxMin / step) * step;

  const grid = el('div', { class: 'col-grid', 'aria-hidden': 'true' });
  for (let v = 0; v <= top; v += step) {
    grid.append(el('div', { class: 'gridline', style: { bottom: `${(v / top) * 100}%` } }, [
      el('span', { class: 'gridline-label', text: v === 0 ? '0' : fmtDur(v) }),
    ]));
  }

  const labelEvery = Math.ceil(a.days.length / 16);
  const cols = el('div', { class: 'cols' });
  a.days.forEach((d, i) => {
    const total = d.trajetMin + d.mortMin;
    const occ = d.amplitudeMin ? `${Math.round((d.trajetMin / d.amplitudeMin) * 100)} %` : '-';
    const stack = el('div', { class: 'col-stack', style: { height: `${(total / top) * 100}%` } }, [
      d.mortMin ? el('div', { class: 'seg seg-mort', style: { flexGrow: d.mortMin } }) : null,
      d.trajetMin ? el('div', { class: 'seg seg-trajet', style: { flexGrow: d.trajetMin } }) : null,
    ]);
    const col = el(
      'div',
      {
        class: 'col',
        tabindex: '0',
        'data-tip': '',
        'aria-label': `${fmtDay(d.date, DAY_LONG)} : ${fmtDur(d.trajetMin)} en trajet, ${fmtDur(d.mortMin)} de temps mort, ${d.trajets.length} trajets`,
      },
      [
        el('div', { class: 'col-plot' }, [stack]),
        el('div', { class: 'col-label', text: i % labelEvery === 0 ? fmtDay(d.date, a.days.length > 10 ? DAY_SHORT : DAY_LABEL) : '' }),
      ]
    );
    bindTooltip(col, () =>
      tooltipContent(fmtDay(d.date, DAY_LONG), [
        ['en trajet', fmtDur(d.trajetMin), '#2c558f'],
        ['de temps mort', fmtDur(d.mortMin), null, true],
        ['trajets', String(d.trajets.length)],
        ["d'occupation", occ],
      ])
    );
    cols.append(col);
  });

  container.replaceChildren(el('div', { class: 'col-chart' }, [grid, cols]));
}

// --- Graphique : journees en detail (frise horaire) ---

function renderGantt(a) {
  const container = document.getElementById('chart-gantt');
  const legend = document.getElementById('gantt-legend');
  const used = new Set(a.items.map((t) => missionOf(t)));
  legend.replaceChildren(
    ...[...MISSIONS, EN_COURS]
      .filter((m) => used.has(m))
      .map((m) => el('li', {}, [el('span', { class: 'swatch', style: { background: m.color } }), m.label])),
    el('li', {}, [el('span', { class: 'swatch swatch-mort' }), 'Temps mort']),
    a.pleins.length ? el('li', {}, [el('span', { class: 'swatch swatch-plein' }), 'Plein']) : null
  );

  const days = a.days.filter((d) => d.trajets.length || d.forgotten.length).reverse();
  if (!days.length) {
    container.replaceChildren(el('p', { class: 'empty', text: 'Aucun trajet sur la période.' }));
    return;
  }

  // Axe horaire cale sur l'activite reelle, arrondi a l'heure
  const minutesOfDay = (d) => d.getHours() * 60 + d.getMinutes();
  let minH = 24;
  let maxH = 0;
  days.forEach((d) => {
    [...d.trajets, ...d.forgotten].forEach((t) => {
      minH = Math.min(minH, Math.floor(minutesOfDay(t.start) / 60));
      const endMin = t.end.toDateString() === t.start.toDateString() ? minutesOfDay(t.end) : 24 * 60;
      maxH = Math.max(maxH, Math.ceil(endMin / 60));
    });
    d.pleins.forEach((p) => {
      minH = Math.min(minH, p.time.getHours());
      maxH = Math.max(maxH, p.time.getHours() + 1);
    });
  });
  minH = Math.max(0, Math.min(minH, 8));
  maxH = Math.min(24, Math.max(maxH, minH + 4));
  const span = (maxH - minH) * 60;
  const pos = (date) => {
    const m = minutesOfDay(date) - minH * 60;
    return Math.min(100, Math.max(0, (m / span) * 100));
  };

  const hourStep = maxH - minH > 12 ? 2 : 1;
  const axis = el('div', { class: 'gantt-axis', 'aria-hidden': 'true' });
  for (let h = minH; h <= maxH; h += hourStep) {
    axis.append(el('span', { class: 'gantt-tick', style: { left: `${((h - minH) / (maxH - minH)) * 100}%` }, text: `${h}h` }));
  }

  const rows = days.map((d) => {
    const track = el('div', { class: 'gantt-track' });
    for (let h = minH; h <= maxH; h += hourStep) {
      track.append(el('span', { class: 'gantt-hour', style: { left: `${((h - minH) / (maxH - minH)) * 100}%` } }));
    }
    d.gaps.forEach((g) => {
      const gap = el('div', {
        class: 'gantt-gap',
        tabindex: '0',
        'data-tip': '',
        'aria-label': `Temps mort de ${fmtDur(g.min)}, de ${fmtTime(g.from)} à ${fmtTime(g.to)}`,
        style: { left: `${pos(g.from)}%`, width: `${pos(g.to) - pos(g.from)}%` },
      });
      bindTooltip(gap, () => tooltipContent('Temps mort', [[`de ${fmtTime(g.from)} à ${fmtTime(g.to)}`, fmtDur(g.min), null, true]]));
      track.append(gap);
    });
    [...d.trajets, ...d.forgotten].forEach((t) => {
      const m = missionOf(t);
      const end = t.end.toDateString() === t.start.toDateString() ? t.end : new Date(t.start.getFullYear(), t.start.getMonth(), t.start.getDate(), 23, 59);
      const block = el('div', {
        class: `gantt-block${t.enCours ? ' is-live' : ''}${t.forgotten ? ' is-forgotten' : ''}`,
        tabindex: '0',
        'data-tip': '',
        'aria-label': `${missionText(t)}, de ${fmtTime(t.start)} à ${t.enCours ? 'maintenant' : fmtTime(t.end)}, ${fmtDur(t.dur)}`,
        style: { left: `${pos(t.start)}%`, width: `${Math.max(pos(end) - pos(t.start), 0.6)}%`, background: m.color },
      });
      bindTooltip(block, () =>
        tooltipContent(missionText(t), [
          t.forgotten
            ? [`démarré à ${fmtTime(t.start)}`, 'non clôturé', m.color]
            : [`de ${fmtTime(t.start)} à ${t.enCours ? 'maintenant' : fmtTime(t.end)}`, fmtDur(t.dur), m.color],
          ['véhicule', vehiculeText(t.vehicule)],
          t.km ? ['parcourus', `${NUM.format(t.km)} km`] : null,
          t.parkingMontant ? ['de parking', EUR.format(t.parkingMontant)] : null,
          t.gapBefore ? ['de temps mort avant', fmtDur(t.gapBefore), null, true] : null,
        ].filter(Boolean))
      );
      track.append(block);
    });
    d.pleins.forEach((p) => {
      const mark = el('div', {
        class: 'gantt-plein',
        tabindex: '0',
        'data-tip': '',
        'aria-label': `Plein de ${EUR.format(p.montant)} à ${fmtTime(p.time)}`,
        style: { left: `${pos(p.time)}%` },
      });
      bindTooltip(mark, () => tooltipContent(`Plein à ${fmtTime(p.time)}`, [['', EUR.format(p.montant)], ['véhicule', vehiculeText(p.vehicule)]]));
      track.append(mark);
    });
    const occ = d.amplitudeMin ? Math.round((d.trajetMin / d.amplitudeMin) * 100) : null;
    return el('div', { class: 'gantt-row' }, [
      el('div', { class: 'gantt-day' }, [
        el('span', { class: 'gantt-day-name', text: fmtDay(d.date) }),
        el('span', { class: 'gantt-day-meta', text: `${d.trajets.length} trajet${d.trajets.length > 1 ? 's' : ''}${occ !== null ? `, ${occ} %` : ''}` }),
      ]),
      track,
    ]);
  });

  const skipped = a.days.length - days.length;
  container.replaceChildren(
    el('div', { class: 'gantt-scroll' }, [
      el('div', { class: 'gantt-inner' }, [el('div', { class: 'gantt-row gantt-head' }, [el('div', { class: 'gantt-day' }), axis]), ...rows]),
    ]),
    skipped ? el('p', { class: 'panel-note', text: `${skipped} jour${skipped > 1 ? 's' : ''} sans activité masqué${skipped > 1 ? 's' : ''}.` }) : null
  );
}

// --- Graphique : types de mission ---

function renderMissions(a) {
  const container = document.getElementById('chart-missions');
  const stats = MISSIONS.map((m) => {
    const list = a.finished.filter((t) => missionOf(t) === m);
    const min = list.reduce((s, t) => s + t.dur, 0);
    return { m, count: list.length, min, avg: list.length ? min / list.length : 0 };
  }).filter((s) => s.count);
  if (!stats.length) {
    container.replaceChildren(el('p', { class: 'empty', text: 'Aucun trajet terminé sur la période.' }));
    return;
  }
  const max = Math.max(...stats.map((s) => s.count));
  const total = stats.reduce((s, x) => s + x.count, 0);
  container.replaceChildren(
    el('ul', { class: 'hbars' }, stats.map((s) => {
      const row = el('li', {
        class: 'hbar',
        tabindex: '0',
        'data-tip': '',
        'aria-label': `${s.m.label} : ${s.count} trajets, ${fmtDur(s.min)} au total, ${fmtDur(s.avg)} en moyenne`,
      }, [
        el('div', { class: 'hbar-head' }, [
          el('span', { class: 'hbar-label' }, [el('span', { class: 'swatch', style: { background: s.m.color } }), s.m.label]),
          el('span', { class: 'hbar-value', text: `${s.count} (${Math.round((s.count / total) * 100)} %)` }),
        ]),
        el('div', { class: 'hbar-track' }, [el('div', { class: 'hbar-fill', style: { width: `${(s.count / max) * 100}%`, background: s.m.color } })]),
        el('div', { class: 'hbar-sub', text: `${fmtDur(s.min)} au total, ${fmtDur(s.avg)} en moyenne` }),
      ]);
      bindTooltip(row, () => tooltipContent(s.m.label, [
        ['trajets', String(s.count), s.m.color],
        ['au total', fmtDur(s.min)],
        ['en moyenne', fmtDur(s.avg)],
      ]));
      return row;
    }))
  );
}

// --- Graphique : heures de depart ---

function renderHours(a) {
  const container = document.getElementById('chart-hours');
  if (!a.items.length) {
    container.replaceChildren(el('p', { class: 'empty', text: 'Aucun trajet sur la période.' }));
    return;
  }
  const counts = new Array(24).fill(0);
  a.items.forEach((t) => counts[t.start.getHours()]++);
  const used = counts.map((c, h) => (c ? h : null)).filter((h) => h !== null);
  const from = Math.min(7, used[0]);
  const to = Math.max(19, used[used.length - 1]);
  const max = Math.max(...counts);
  const peak = counts.indexOf(max);

  const cols = el('div', { class: 'cols cols-hours' });
  for (let h = from; h <= to; h++) {
    const c = counts[h];
    const col = el('div', {
      class: 'col',
      tabindex: '0',
      'data-tip': '',
      'aria-label': `${h}h : ${c} trajet${c > 1 ? 's' : ''} démarré${c > 1 ? 's' : ''}`,
    }, [
      el('div', { class: 'col-plot' }, [
        el('div', { class: 'col-stack', style: { height: `${(c / max) * 100}%` } }, [
          c ? el('div', { class: 'seg seg-trajet', style: { flexGrow: 1 } }) : null,
        ]),
        h === peak ? el('span', { class: 'col-peak', style: { bottom: `${(c / max) * 100}%` }, text: String(c) }) : null,
      ]),
      el('div', { class: 'col-label', text: h % 2 === 0 ? `${h}h` : '' }),
    ]);
    bindTooltip(col, () => tooltipContent(`${h}h - ${h + 1}h`, [['trajets démarrés', String(c), '#2c558f']]));
    cols.append(col);
  }
  container.replaceChildren(el('div', { class: 'col-chart col-chart-short' }, [cols]));
}

// --- Barres horizontales simples (vehicules, centres) ---

function groupCount(list, keyFn) {
  const map = new Map();
  list.forEach((t) => map.set(keyFn(t), (map.get(keyFn(t)) || 0) + 1));
  return [...map.entries()].sort((x, y) => y[1] - x[1]);
}

function renderBars(id, entries, unit) {
  const container = document.getElementById(id);
  if (!entries.length) {
    container.replaceChildren(el('p', { class: 'empty', text: 'Aucune donnée sur la période.' }));
    return;
  }
  const max = entries[0][1];
  container.replaceChildren(
    el('ul', { class: 'hbars' }, entries.map(([label, count]) =>
      el('li', { class: 'hbar' }, [
        el('div', { class: 'hbar-head' }, [
          el('span', { class: 'hbar-label', text: label }),
          el('span', { class: 'hbar-value', text: `${count} ${unit}${count > 1 ? 's' : ''}` }),
        ]),
        el('div', { class: 'hbar-track' }, [el('div', { class: 'hbar-fill', style: { width: `${(count / max) * 100}%` } })]),
      ])
    ))
  );
}

// --- Tableau ---

function renderTable(a) {
  const tbody = document.querySelector('#table-trajets tbody');
  const rows = a.items.slice().sort((x, y) => y.start - x.start);
  document.getElementById('table-sub').textContent = rows.length
    ? `${rows.length} trajet${rows.length > 1 ? 's' : ''}, du plus récent au plus ancien`
    : '';
  if (!rows.length) {
    tbody.replaceChildren(el('tr', {}, [el('td', { colspan: '9', class: 'empty', text: 'Aucun trajet sur la période.' })]));
    return;
  }
  tbody.replaceChildren(...rows.map((t) =>
    el('tr', {}, [
      el('td', { text: fmtDay(t.date) }),
      el('td', { text: fmtTime(t.start) }),
      el('td', { text: t.enCours ? 'en cours' : fmtTime(t.end) }),
      el('td', { class: 'num', text: fmtDur(t.dur) }),
      el('td', { class: 'num', text: t.gapBefore ? fmtDur(t.gapBefore) : '' }),
      el('td', {}, [el('span', { class: 'swatch', style: { background: missionOf(t).color } }), missionText(t)]),
      el('td', { text: vehiculeText(t.vehicule) }),
      el('td', { class: 'num', text: t.km ? NUM.format(t.km) : '' }),
      el('td', { class: 'num', text: t.parkingMontant ? EUR.format(t.parkingMontant) : '' }),
    ])
  ));
}

// --- Export CSV (separateur ; pour Excel en francais) ---

function exportCsv() {
  const a = state.data;
  if (!a) return;
  const esc = (v) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[";\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const num = (n) => (n === null || n === undefined ? '' : String(n).replace('.', ','));
  const header = ['Date', 'Début', 'Fin', 'Durée (min)', 'Temps mort avant (min)', 'Mission', 'Centre', 'Véhicule', 'Km', 'Parking (€)'];
  const lines = a.items.map((t) => [
    t.date,
    fmtTime(t.start),
    t.enCours ? '' : fmtTime(t.end),
    t.dur,
    t.gapBefore ?? '',
    t.enCours ? 'En cours' : t.missionType === 'Autre' ? `Autre : ${t.missionAutre || ''}` : missionOf(t).label,
    t.centreLivraison || '',
    vehiculeText(t.vehicule),
    num(t.km),
    num(t.parkingMontant),
  ].map(esc).join(';'));
  const blob = new Blob(['﻿' + [header.join(';'), ...lines].join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const link = el('a', { href: URL.createObjectURL(blob), download: `mobitrack_${state.from}_${state.to}.csv` });
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(link.href);
}

// --- Filtres de periode ---

function presetRange(preset) {
  const today = new Date();
  const t = toDateStr(today);
  switch (preset) {
    case 'today': return [t, t];
    case '7d': return [toDateStr(addDays(today, -6)), t];
    case '30d': return [toDateStr(addDays(today, -29)), t];
    case 'month': return [toDateStr(new Date(today.getFullYear(), today.getMonth(), 1)), t];
    case 'lastmonth': return [
      toDateStr(new Date(today.getFullYear(), today.getMonth() - 1, 1)),
      toDateStr(new Date(today.getFullYear(), today.getMonth(), 0)),
    ];
    default: return null;
  }
}

function setRange(from, to, { push = true } = {}) {
  if (!from || !to) return;
  if (from > to) [from, to] = [to, from];
  state.from = from;
  state.to = to;
  document.getElementById('input-from').value = from;
  document.getElementById('input-to').value = to;
  document.querySelectorAll('.preset').forEach((b) => {
    const r = presetRange(b.dataset.preset);
    b.setAttribute('aria-checked', String(r[0] === from && r[1] === to));
  });
  const url = `${location.pathname}?from=${from}&to=${to}`;
  if (push) history.pushState({ from, to }, '', url);
  else history.replaceState({ from, to }, '', url);
  load();
}

document.querySelectorAll('.preset').forEach((b) =>
  b.addEventListener('click', () => setRange(...presetRange(b.dataset.preset)))
);
['input-from', 'input-to'].forEach((id) =>
  document.getElementById(id).addEventListener('change', () =>
    setRange(document.getElementById('input-from').value, document.getElementById('input-to').value)
  )
);
window.addEventListener('popstate', (e) => {
  if (e.state) setRange(e.state.from, e.state.to, { push: false });
});
document.getElementById('btn-export').addEventListener('click', exportCsv);

// --- Init : periode depuis l'URL (lien partageable), sinon 7 derniers jours ---

(function init() {
  const params = new URLSearchParams(location.search);
  const re = /^\d{4}-\d{2}-\d{2}$/;
  const from = params.get('from');
  const to = params.get('to');
  if (re.test(from || '') && re.test(to || '')) setRange(from, to, { push: false });
  else setRange(...presetRange('7d'), { push: false });
})();
