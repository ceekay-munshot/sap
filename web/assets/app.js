import { frameFor, describePolicy, tierFor, explainWeight, POLICY } from '../lib/recency.mjs';

/* ─── helpers ──────────────────────────────────────────────────────────────── */

const $ = (id) => document.getElementById(id);

/** Everything below renders web content — quotes, names, URLs — so nothing
 *  reaches innerHTML unescaped. */
const esc = (v) => String(v ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/** Only http(s) links survive; anything else becomes inert. */
function safeUrl(url) {
  try {
    const u = new URL(String(url), window.location.href);
    return (u.protocol === 'http:' || u.protocol === 'https:') ? u.href : '';
  } catch { return ''; }
}

const CATEGORIES = [
  { id: 'all', label: 'All Topics', icon: '🌐' },
  { id: 'product', label: 'Products', icon: '📦' },
  { id: 'ecosystem', label: 'Ecosystem', icon: '🌱' },
  { id: 'competitive', label: 'Competitive', icon: '🎯' },
  { id: 'history', label: 'Sentiment History', icon: '📈' },
];

const WORKFLOW_URL =
  'https://github.com/ceekay-munshot/sap/actions/workflows/collect.yml';

const CAT_LABEL = { product: 'PRODUCT', ecosystem: 'ECOSYSTEM', competitive: 'COMPETITIVE' };

function scoreColor(s) {
  if (!s) return '#475569';
  if (s >= 4.2) return '#22c55e';
  if (s >= 3.5) return '#4ade80';
  if (s >= 2.8) return '#f59e0b';
  if (s >= 2.0) return '#fb923c';
  return '#ef4444';
}

function scoreBand(s) {
  if (!s) return { label: 'N/A', color: '#475569' };
  if (s >= 4.2) return { label: 'BULLISH', color: '#22c55e' };
  if (s >= 3.5) return { label: 'POSITIVE', color: '#4ade80' };
  if (s >= 2.8) return { label: 'MIXED', color: '#f59e0b' };
  if (s >= 2.0) return { label: 'WEAK', color: '#fb923c' };
  return { label: 'BEARISH', color: '#ef4444' };
}

const TIER_COLOR = { current: '#22c55e', prior: '#3b82f6', legacy: '#f59e0b' };

const fmtDate = (iso) => {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—'
    : d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
};

/* ─── state ────────────────────────────────────────────────────────────────── */

const state = {
  data: null,
  trend: null,
  site: { workerUrl: '' },
  running: {},
  runNote: {},
  topics: [],
  metric: 'pctPositive',
  historyTopic: 'overall',
  now: new Date(),
  category: 'all',
  open: null,
};

const reportFor = (id) => state.data?.topics?.[id] || null;
const hasReport = (id) => Boolean(reportFor(id)?.score);

/* ─── sidebar ──────────────────────────────────────────────────────────────── */

function renderStatus() {
  const dot = $('statusDot');
  const text = $('statusText');
  const done = state.topics.filter((t) => hasReport(t.id)).length;
  $('coverage').textContent = `${done}/${state.topics.length}`;

  if (!state.data || done === 0) {
    dot.style.background = 'var(--text5)';
    text.textContent = 'NO COLLECTION RUN YET';
    return;
  }
  const engine = state.data.engine;
  dot.style.background = engine === 'claude' ? '#22c55e' : '#f59e0b';
  dot.style.boxShadow = engine === 'claude' ? '0 0 6px rgba(34,197,94,0.53)' : 'none';
  text.textContent = engine === 'claude'
    ? `READY — ${fmtDate(state.data.generatedAt)}`
    : `HEURISTIC — ${fmtDate(state.data.generatedAt)}`;
}

function renderMiniTracker() {
  const scored = state.topics.map((t) => reportFor(t.id)).filter((r) => r?.score);
  if (!scored.length) { $('miniTracker').innerHTML = ''; return; }
  const mean = scored.reduce((a, r) => a + r.score, 0) / scored.length;
  const band = scoreBand(mean);
  const rows = `
    <div class="tracker-row">
      <span class="tracker-label">OVERALL</span>
      <span class="tracker-score" style="color:${band.color}">${mean.toFixed(1)}/5</span>
    </div>
    <div class="tracker-row">
      <span class="tracker-label">${esc(band.label)}</span>
      <span class="tracker-score" style="color:var(--text4)">${scored.length} topics</span>
    </div>`;
  $('miniTracker').innerHTML = `<div class="tracker-box"><div class="section-label">TRACKER</div>${rows}</div>`;
}

function renderFilters() {
  $('categoryFilters').innerHTML = CATEGORIES.map((cat) => {
    const active = state.category === cat.id;
    return `<button class="filter-btn${active ? ' active' : ''}" data-cat="${esc(cat.id)}" type="button">`
      + `<span style="font-size:12px">${cat.icon}</span>`
      + `<span class="filter-btn-text">${esc(cat.label)}</span></button>`;
  }).join('');
  for (const btn of $('categoryFilters').querySelectorAll('.filter-btn')) {
    btn.addEventListener('click', () => {
      state.category = btn.dataset.cat;
      state.open = null;
      render();
    });
  }
}

function renderTopicList() {
  $('topicList').innerHTML = state.topics.map((t) => {
    const report = reportFor(t.id);
    const score = report?.score;
    const color = scoreColor(score);
    const scoreDisplay = score
      ? `<span style="font-size:9px;font-family:'DM Mono',monospace;color:${color}">${score.toFixed(1)}</span>`
      : '';
    return `<button class="topic-btn" data-topic="${esc(t.id)}" type="button">
      <div style="display:flex;align-items:center;gap:6px">
        <span style="font-size:11px">${t.icon}</span>
        <span class="topic-btn-label">${esc(t.label)}</span>
      </div>
      <div style="display:flex;align-items:center;gap:4px">${scoreDisplay}
        <span style="font-size:9px;color:var(--text4)">${score ? '→' : '·'}</span>
      </div>
    </button>`;
  }).join('');
  for (const btn of $('topicList').querySelectorAll('.topic-btn')) {
    btn.addEventListener('click', () => {
      state.open = btn.dataset.topic;
      state.category = 'all';
      render();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });
  }
}

/** The weighting key, generated from the shared policy so it rolls over. */
function renderWeightKey() {
  const frame = frameFor(state.now);
  $('weightKey').innerHTML = frame.tiers.map((tier) => `
    <div class="tracker-row">
      <span class="tracker-label" style="color:${TIER_COLOR[tier.id]}">${esc(tier.label)}</span>
      <span class="tracker-score" style="color:var(--text4)">${esc(tier.multiplier)}</span>
    </div>`).join('');
}

/* ─── the method strip ─────────────────────────────────────────────────────── */

function methodStrip() {
  const frame = frameFor(state.now);
  const [current, prior, legacy] = frame.tiers;
  const sep = '<span style="color:var(--border3)">|</span>';
  return `<div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:8px 14px;background:var(--tracker-bg);border:1px solid var(--border);border-radius:8px;margin-bottom:14px;font-family:'DM Mono',monospace;font-size:9px;color:var(--text5)">
    <span style="color:var(--text4);font-weight:700;letter-spacing:0.08em">ℹ️ METHOD</span>
    ${sep}
    <span>Scores 1–5 · ${current.label} sources weighted ${current.multiplier}</span>
    ${sep}
    <span>${prior.label} = ${prior.multiplier}</span>
    ${sep}
    <span>Sub-scores: Adoption · Maturity · Satisfaction · Competitive</span>
    ${sep}
    <span>Pre-${prior.label} = <span style="color:#f59e0b">[LEGACY]</span> ${legacy.multiplier}</span>
  </div>`;
}

/* ─── topic launch cards ───────────────────────────────────────────────────── */

function topicCard(topic) {
  const report = reportFor(topic.id);
  const score = report?.score;
  const cardClass = score ? 'has-result' : '';
  const color = scoreColor(score);
  const desc = `${topic.prompt.replace(/\s+/g, ' ').slice(0, 90)}…`;

  const scorePill = score
    ? `<div class="tlc-score-row">
         <span class="tlc-score-pill" style="background:${color}18;border:1px solid ${color}44;color:${color}">${score.toFixed(1)}/5</span>
         <span class="tlc-score-label">${esc(scoreBand(score).label)} · ${esc(fmtDate(report.ranAt))}</span>
       </div>`
    : '';

  const running = Boolean(state.running[topic.id]);
  const note = state.runNote[topic.id];
  const runBtn = running
    ? `<button class="run-btn loading" type="button" disabled style="opacity:.75">
         <span class="loading-label">RESEARCHING…</span>
       </button>
       <div class="shimmer-bar"><div class="shimmer-inner"></div></div>`
    : state.site.workerUrl
      ? `<button class="run-btn" type="button" data-research="${esc(topic.id)}"
           title="Runs a fresh paid research pass for this topic">▶ Run Research</button>`
      : `<a class="run-btn" href="${esc(WORKFLOW_URL)}" target="_blank" rel="noopener noreferrer"
           style="display:block;text-align:center;text-decoration:none"
           title="Opens the GitHub Actions workflow that researches and scores every topic">▶ Run Research</a>`;
  const noteHTML = note
    ? `<div class="${note.error ? 'tlc-error-msg' : 'loading-sub'}">${esc(note.text)}</div>`
    : '';
  const viewBtn = score
    ? `<button class="tlc-view-btn" data-open="${esc(topic.id)}" type="button">VIEW REPORT →</button>`
    : '';

  return `<div class="topic-launch-card ${cardClass}">
    <div class="tlc-header">
      <span class="tlc-icon">${topic.icon}</span>
      <div style="flex:1;min-width:0">
        <div class="tlc-label">${esc(topic.label)}</div>
        <div class="tlc-cat">${esc(CAT_LABEL[topic.category] || topic.category.toUpperCase())}</div>
      </div>
    </div>
    <div class="tlc-desc">${esc(desc)}</div>
    ${scorePill}
    ${runBtn}
    ${noteHTML}
    ${viewBtn}
  </div>`;
}

/** The passphrase guards someone else's money; keep it out of the markup. */
function passphrase(forget = false) {
  try {
    if (forget) localStorage.removeItem('sap-research-pass');
    let value = localStorage.getItem('sap-research-pass');
    if (!value) {
      value = window.prompt('Research passphrase (set on the Worker):');
      if (value) localStorage.setItem('sap-research-pass', value);
    }
    return value;
  } catch {
    return window.prompt('Research passphrase:');
  }
}

/**
 * Research runs in GitHub Actions and takes minutes, so the page watches for the
 * committed result rather than holding a connection open.
 */
async function pollForResult(topicId, before) {
  const deadline = Date.now() + 12 * 60 * 1000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 20000));
    const fresh = await loadJson('./data/dashboard.json', null);
    const ranAt = fresh?.topics?.[topicId]?.ranAt;
    if (ranAt && ranAt !== before) {
      state.data = fresh;
      state.running[topicId] = false;
      state.runNote[topicId] = { text: 'Updated just now.' };
      render();
      return true;
    }
  }
  state.running[topicId] = false;
  state.runNote[topicId] = {
    text: 'Still running, or the deploy has not refreshed yet. Reload in a minute.',
  };
  render();
  return false;
}

async function startResearch(topicId) {
  const pass = passphrase();
  if (!pass) return;

  const before = reportFor(topicId)?.ranAt || null;
  state.running[topicId] = true;
  state.runNote[topicId] = null;
  render();

  try {
    const res = await fetch(`${state.site.workerUrl.replace(/\/$/, '')}/api/research`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ topic: topicId, passphrase: pass }),
    });
    const body = await res.json().catch(() => ({}));

    if (res.status === 401) {
      passphrase(true);
      throw new Error('Wrong passphrase — it has been cleared, try again.');
    }
    if (!res.ok) throw new Error(body.error || `request failed (${res.status})`);

    state.runNote[topicId] = {
      text: `Started${body.dailyLimit ? ` · ${body.runsToday}/${body.dailyLimit} today` : ''} · takes a few minutes`,
    };
    render();
    pollForResult(topicId, before);
  } catch (err) {
    state.running[topicId] = false;
    state.runNote[topicId] = { error: true, text: err.message };
    render();
  }
}

/* ─── the report view ──────────────────────────────────────────────────────── */

function gauge(report) {
  const s = report.score;
  const color = scoreColor(s);
  const r = 28;
  const circ = 2 * Math.PI * r;
  const dash = (Math.max(0, Math.min(5, s)) / 5) * circ;

  const subs = [
    { key: 'adoption', label: 'Adoption' },
    { key: 'maturity', label: 'Maturity' },
    { key: 'satisfaction', label: 'Satisfaction' },
    { key: 'competitive', label: 'Competitive' },
  ];
  const subHTML = subs.map((sub) => {
    const val = report.sub?.[sub.key];
    if (typeof val !== 'number') return '';
    const c = scoreColor(val);
    return `<div class="sub-score-row">
      <span class="sub-score-label">${sub.label}</span>
      <div class="sub-score-bar-track"><div class="sub-score-bar-fill" style="width:${(val / 5) * 100}%;background:${c}"></div></div>
      <span class="sub-score-val" style="color:${c}">${val.toFixed(1)}</span>
    </div>`;
  }).join('');

  return `<div class="score-gauge">
    <div class="gauge-circle">
      <svg width="64" height="64" viewBox="0 0 64 64">
        <circle class="gauge-circle-bg" cx="32" cy="32" r="${r}"/>
        <circle class="gauge-circle-fill" cx="32" cy="32" r="${r}" stroke="${color}"
          stroke-dasharray="${dash} ${circ}" stroke-dashoffset="0"/>
      </svg>
      <div class="gauge-center-text">
        <span class="gauge-score-num" style="color:${color}">${s.toFixed(1)}</span>
        <span class="gauge-score-denom">/5.0</span>
      </div>
    </div>
    <div class="sub-scores">${subHTML}</div>
  </div>`;
}

function recencyBar(report) {
  const mix = report.recencyMix || {};
  const total = (mix.current || 0) + (mix.prior || 0) + (mix.legacy || 0);
  const frame = frameFor(state.now);
  const pct = (n) => (total ? Math.round((n / total) * 100) : 0);
  const text = total
    ? `${pct(mix.current)}% ${frame.currentYear} · ${pct(mix.prior)}% ${frame.priorYear} · ${pct(mix.legacy)}% pre-${frame.priorYear}`
    : (report.recency || 'not reported');
  const legacyHeavy = total && (mix.legacy / total) > 0.4;
  const warn = legacyHeavy
    ? `<span class="recency-warn">⚠ LEGACY-HEAVY</span>`
    : '';
  return `<div class="recency-bar">
    <span class="recency-label">🕐 DATA RECENCY</span>
    <span class="recency-value">${esc(text)}</span>
    ${warn}
  </div>`;
}

function quoteCard(quote) {
  const tier = tierFor(quote.date, state.now);
  const color = TIER_COLOR[tier];
  const weight = explainWeight(quote.date, state.now);
  const name = quote.name || '';
  const initials = name ? name.split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase() : '“';
  const url = safeUrl(quote.url);

  const chip = (label, value) => value
    ? `<span class="quote-chip">${esc(label)}${esc(value)}</span>` : '';

  const recencyChip = `<span class="quote-chip${tier === 'legacy' ? ' quote-chip-legacy' : ''}"
    style="margin-left:auto;color:${color};border-color:${color}44">
    ${tier === 'legacy' ? 'LEGACY ' : ''}${weight.weight.toFixed(2)}×</span>`;

  return `<div class="quote-card" style="border-left-color:${color}">
    <div class="quote-text">${esc(quote.text)}</div>
    <div class="quote-attribution-block">
      <div class="quote-person-row">
        <div class="quote-avatar" style="background:${color}22;color:${color}">${esc(initials)}</div>
        <div>
          ${name ? `<div class="quote-name">${esc(name)}</div>` : ''}
          ${quote.title ? `<div class="quote-role">${esc(quote.title)}</div>` : ''}
        </div>
        ${recencyChip}
      </div>
      <div class="quote-chips-row">
        ${chip('', quote.company)}
        ${quote.platform ? `<span class="quote-chip quote-chip-platform">${esc(quote.platform)}</span>` : ''}
        ${quote.date ? `<span class="quote-chip quote-chip-date">${esc(fmtDate(quote.date))}</span>` : ''}
      </div>
      ${quote.context ? `<div class="quote-context">${esc(quote.context)}</div>` : ''}
      ${url
    ? `<a class="quote-source-btn direct" href="${esc(url)}" target="_blank" rel="noopener noreferrer">OPEN SOURCE ↗</a>`
    : `<span class="quote-no-src">no direct link captured</span>`}
    </div>
  </div>`;
}

function scorecard(report) {
  const frame = frameFor(state.now);
  const defs = [
    { key: 'adoption', label: 'ADOPTION', desc: '1.0 barely piloted · 3.0 growing but uneven · 5.0 pervasive' },
    { key: 'maturity', label: 'MATURITY', desc: '1.0 pre-GA/alpha · 3.0 stable for common use-cases · 5.0 battle-tested at scale' },
    { key: 'satisfaction', label: 'SATISFACTION', desc: '1.0 mostly complaints · 3.0 mixed/divided · 5.0 strong advocates' },
    { key: 'competitive', label: 'COMPETITIVE', desc: '1.0 significantly behind peers · 3.0 roughly on par · 5.0 clear market leader' },
  ];
  const cells = defs.map((d) => {
    const val = report.sub?.[d.key];
    if (typeof val !== 'number') return '';
    const c = scoreColor(val);
    return `<div class="sc-cell" title="${esc(d.desc)}">
      <div class="sc-cell-accent" style="background:${c}"></div>
      <div class="sc-label">${d.label}</div>
      <div class="sc-value" style="color:${c}">${val.toFixed(1)}</div>
      <div class="sc-band" style="color:${c}">${esc(scoreBand(val).label)}</div>
      <div class="sc-bar-track"><div class="sc-bar-fill" style="width:${(val / 5) * 100}%;background:${c}"></div></div>
    </div>`;
  }).join('');

  const legend = [
    { color: '#22c55e', label: '4.2–5.0 BULLISH' },
    { color: '#4ade80', label: '3.5–4.1 POSITIVE' },
    { color: '#f59e0b', label: '2.8–3.4 MIXED' },
    { color: '#fb923c', label: '2.0–2.7 WEAK' },
    { color: '#ef4444', label: '1.0–1.9 BEARISH' },
  ].map((l) => `<span class="sc-legend-item"><span class="sc-legend-dot" style="background:${l.color}"></span>${l.label}</span>`).join('');

  return `<div class="scorecard">
    <div class="scorecard-title">📊 HOW SCORES ARE COMPUTED — ${frame.currentYear} TEMPORAL WEIGHTING<span style="font-size:8px;color:var(--text4);font-family:'Lora',serif;font-style:italic;font-weight:400"> · Hover cells for definitions · Scale 1.0–5.0</span></div>
    <div class="scorecard-grid">${cells}</div>
    <div class="scorecard-legend">${legend}</div>
  </div>`;
}

function reportView(topic) {
  const report = reportFor(topic.id);
  if (!report?.score) {
    return `<div class="empty-state">
      <div class="empty-icon">${topic.icon}</div>
      <div class="empty-title">${esc(topic.label)} — not collected yet</div>
      <div class="empty-text">This topic has no report. It is filled by the daily collection run.</div>
    </div>`;
  }
  const findings = (report.findings || []).map((f) =>
    `<div class="finding-item"><span class="finding-bullet">▸</span><span class="finding-text">${esc(f)}</span></div>`).join('');
  const quotes = (report.quotes || []).map(quoteCard).join('');
  const sources = (report.sources || []).map((src, i) => {
    const url = safeUrl(src.url);
    let domain = '';
    try { domain = url ? new URL(url).hostname.replace(/^www\./, '') : ''; } catch { domain = ''; }
    return `<div class="src-card">
      <div class="src-header">
        <span class="src-num">${i + 1}</span>
        <span class="src-title">${esc(src.title || domain || 'source')}</span>
      </div>
      ${domain ? `<div class="src-domain">${esc(domain)}</div>` : ''}
      ${url ? `<a class="src-open-btn" href="${esc(url)}" target="_blank" rel="noopener noreferrer">OPEN ↗</a>` : ''}
    </div>`;
  }).join('');

  return `<div class="result-card">
    <div class="card-header">
      <span class="tlc-icon" style="flex:0 0 auto">${topic.icon}</span>
      <div style="flex:1 1 auto;min-width:0">
        <div class="card-title" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(topic.label)}</div>
        <div class="card-meta" style="white-space:nowrap">${esc(CAT_LABEL[topic.category] || '')} · COLLECTED ${esc(fmtDate(report.ranAt))}</div>
      </div>
      <button class="tlc-view-btn" data-open="" type="button"
        style="width:auto;flex:0 0 auto;white-space:nowrap;padding:6px 12px">← ALL TOPICS</button>
    </div>
    <div class="card-body">
      ${gauge(report)}
      ${recencyBar(report)}
      ${report.summary ? `<div class="summary-text">${esc(report.summary)}</div>` : ''}
      ${findings ? `<div class="findings-label">KEY FINDINGS</div>${findings}` : ''}
      ${scorecard(report)}
      ${quotes ? `<div class="quotes-section"><div class="quotes-section-label">PRACTITIONER QUOTES · weighted by recency</div>${quotes}</div>` : ''}
      ${sources ? `<div class="sources-panel"><div class="sources-label">SOURCES <span class="sources-count">${(report.sources || []).length}</span></div><div class="sources-grid">${sources}</div></div>` : ''}
    </div>
  </div>`;
}

/* ─── sentiment history ────────────────────────────────────────────────────── */

const METRICS = {
  pctPositive: { label: '% positive', short: 'positive', max: 100, minSpan: 15, pad: 5, fmt: (v) => `${Math.round(v)}%` },
  pctNegative: { label: '% negative', short: 'negative', max: 100, minSpan: 15, pad: 5, fmt: (v) => `${Math.round(v)}%` },
  score: { label: 'score /5', short: 'score', max: 5, minSpan: 1, pad: 0.3, fmt: (v) => v.toFixed(1) },
};

/**
 * A full-scale axis flattens a real move into a straight line, which defeats the
 * point of a trend. Fit the axis to the data instead, with padding, a minimum
 * span, and the range stated under the chart so nobody misreads the slope.
 */
function domainFor(points, spec) {
  const values = points.map((p) => p.value);
  let lo = Math.min(...values);
  let hi = Math.max(...values);
  lo -= spec.pad;
  hi += spec.pad;
  if (hi - lo < spec.minSpan) {
    const mid = (hi + lo) / 2;
    lo = mid - spec.minSpan / 2;
    hi = mid + spec.minSpan / 2;
  }
  lo = Math.max(0, lo);
  hi = Math.min(spec.max, hi);
  if (hi <= lo) { lo = 0; hi = spec.max; }
  const step = (hi - lo) / 4;
  return { lo, hi, ticks: [0, 1, 2, 3, 4].map((i) => lo + step * i), full: lo === 0 && hi === spec.max };
}

/** Pull one metric's series for a topic ('overall' or a topic id). */
function series(topicId, metric) {
  return (state.trend?.days || []).map((day) => {
    const bucket = topicId === 'overall' ? day.overall : day.topics?.[topicId];
    const value = bucket?.[metric];
    return typeof value === 'number' ? { date: day.date, value, items: bucket.items } : null;
  }).filter(Boolean);
}

/**
 * The trend chart. One series, so no legend box — the title names it.
 * Crosshair finds the date; every value is also in the table view below.
 */
function trendChart(points, metric, { width = 860, height = 260 } = {}) {
  const spec = METRICS[metric];
  if (points.length === 0) {
    return `<div class="no-history-text">No points yet for this metric.</div>`;
  }

  const m = { t: 16, r: 54, b: 28, l: 42 };
  const plotW = width - m.l - m.r;
  const plotH = height - m.t - m.b;
  const times = points.map((p) => new Date(p.date).getTime());
  const tMin = Math.min(...times);
  const tMax = Math.max(...times);
  const dom = domainFor(points, spec);
  const xOf = (t) => (tMax === tMin ? m.l + plotW / 2 : m.l + ((t - tMin) / (tMax - tMin)) * plotW);
  const yOf = (v) => m.t + plotH - ((Math.max(dom.lo, Math.min(dom.hi, v)) - dom.lo) / (dom.hi - dom.lo)) * plotH;

  const grid = dom.ticks.map((tick) => {
    const y = yOf(tick);
    return `<line x1="${m.l}" y1="${y}" x2="${m.l + plotW}" y2="${y}"
      stroke="var(--border2)" stroke-width="1"/>
      <text x="${m.l - 8}" y="${y + 4}" text-anchor="end" fill="var(--text5)"
        font-size="9" font-family="'DM Mono',monospace">${spec.fmt(tick)}</text>`;
  }).join('');

  // Thin out date labels so they never collide.
  const MIN_TICK_PX = 74;
  const keep = [];
  points.forEach((p, i) => {
    const x = xOf(times[i]);
    if (i === points.length - 1) {
      while (keep.length && xOf(times[keep[keep.length - 1]]) > x - MIN_TICK_PX) keep.pop();
      keep.push(i);
    } else if (!keep.length || x - xOf(times[keep[keep.length - 1]]) >= MIN_TICK_PX) {
      keep.push(i);
    }
  });
  const dateLabels = keep.map((i) => {
    const anchor = i === 0 ? 'start' : i === points.length - 1 ? 'end' : 'middle';
    const label = new Date(points[i].date).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    return `<text x="${xOf(times[i])}" y="${height - 8}" text-anchor="${anchor}"
      fill="var(--text5)" font-size="9" font-family="'DM Mono',monospace">${esc(label)}</text>`;
  }).join('');

  const line = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${xOf(times[i])},${yOf(p.value)}`).join(' ');
  const area = points.length > 1
    ? `<path d="${line} L${xOf(times[points.length - 1])},${m.t + plotH} L${xOf(times[0])},${m.t + plotH} Z"
        fill="#3b82f6" opacity="0.10"/>`
    : '';

  const last = points[points.length - 1];
  const lastX = xOf(times[points.length - 1]);
  const lastY = yOf(last.value);

  return `<svg class="trend-svg" viewBox="0 0 ${width} ${height}" width="100%" height="${height}"
      role="img" aria-label="${esc(spec.label)} over time">
    ${grid}
    ${area}
    ${points.length > 1 ? `<path d="${line}" fill="none" stroke="#3b82f6" stroke-width="2"
      stroke-linejoin="round" stroke-linecap="round"/>` : ''}
    <circle cx="${lastX}" cy="${lastY}" r="4.5" fill="#3b82f6" stroke="var(--bg)" stroke-width="2"/>
    <text x="${lastX + 9}" y="${lastY + 4}" fill="var(--text2)" font-size="11"
      font-family="'DM Mono',monospace" font-weight="600">${spec.fmt(last.value)}</text>
    ${dateLabels}
    <line class="trend-crosshair" y1="${m.t}" y2="${m.t + plotH}" stroke="var(--border3)"
      stroke-width="1" opacity="0"/>
    <rect class="trend-hit" x="${m.l}" y="${m.t}" width="${plotW}" height="${plotH}" fill="transparent"/>
  </svg>`;
}

/** A 9-up grid of small multiples — one topic each, same scale. */
function sparkline(points, metric, width = 150, height = 34) {
  if (points.length < 2) return `<svg width="${width}" height="${height}"></svg>`;
  const spec = METRICS[metric];
  const times = points.map((p) => new Date(p.date).getTime());
  const tMin = Math.min(...times);
  const tMax = Math.max(...times);
  const dom = domainFor(points, spec);
  const xOf = (t) => (tMax === tMin ? width / 2 : ((t - tMin) / (tMax - tMin)) * (width - 6) + 3);
  const yOf = (v) => height - 4
    - ((Math.max(dom.lo, Math.min(dom.hi, v)) - dom.lo) / (dom.hi - dom.lo)) * (height - 8);
  const d = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${xOf(times[i])},${yOf(p.value)}`).join(' ');
  const last = points[points.length - 1];
  return `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" aria-hidden="true">
    <path d="${d}" fill="none" stroke="#3b82f6" stroke-width="1.5" stroke-linejoin="round"/>
    <circle cx="${xOf(times[times.length - 1])}" cy="${yOf(last.value)}" r="2.5" fill="#3b82f6"/>
  </svg>`;
}

/** Crosshair + tooltip on the trend chart. Readers aim at a date, not a 2px line. */
function wireCrosshair(root) {
  const svg = root.querySelector('.trend-svg');
  const hit = root.querySelector('.trend-hit');
  const cross = root.querySelector('.trend-crosshair');
  if (!svg || !hit || !cross) return;

  const points = series(state.historyTopic, state.metric);
  if (!points.length) return;
  const spec = METRICS[state.metric];
  const box = svg.viewBox.baseVal;
  const m = { l: 42, r: 54 };
  const plotW = box.width - m.l - m.r;
  const times = points.map((p) => new Date(p.date).getTime());
  const tMin = Math.min(...times);
  const tMax = Math.max(...times);
  const xOf = (t) => (tMax === tMin ? m.l + plotW / 2 : m.l + ((t - tMin) / (tMax - tMin)) * plotW);

  const move = (ev) => {
    const rect = svg.getBoundingClientRect();
    const px = ((ev.clientX - rect.left) / rect.width) * box.width;
    let nearest = 0;
    let best = Infinity;
    times.forEach((t, i) => {
      const dist = Math.abs(xOf(t) - px);
      if (dist < best) { best = dist; nearest = i; }
    });
    const x = xOf(times[nearest]);
    cross.setAttribute('x1', x);
    cross.setAttribute('x2', x);
    cross.setAttribute('opacity', '1');

    const point = points[nearest];
    const tip = $('tooltip');
    tip.innerHTML = `<div class="t-title">${esc(fmtDate(point.date))}</div>`
      + `<div class="t-row"><span class="t-val">${esc(spec.fmt(point.value))}</span>`
      + `<span class="t-name">${esc(spec.short)}</span></div>`
      + `<div class="t-row"><span class="t-val">${point.items ?? '—'}</span>`
      + `<span class="t-name">items in corpus</span></div>`;
    tip.style.opacity = '1';
    const tb = tip.getBoundingClientRect();
    tip.style.left = `${Math.min(Math.max(8, ev.clientX + 14), window.innerWidth - tb.width - 8)}px`;
    tip.style.top = `${Math.max(8, ev.clientY - tb.height - 12)}px`;
  };

  hit.addEventListener('pointermove', move);
  hit.addEventListener('pointerleave', () => {
    cross.setAttribute('opacity', '0');
    $('tooltip').style.opacity = '0';
  });
}

function historyView() {
  const days = state.trend?.days || [];
  if (days.length === 0) {
    return `<div class="no-history">
      <div class="no-history-icon">📈</div>
      <div class="no-history-title">No trend data yet</div>
      <div class="no-history-text">The free daily tracker appends one point per topic per day.
        The line appears after the first run, and becomes a trend after the second.</div>
    </div>`;
  }

  const metric = state.metric;
  const spec = METRICS[metric];
  const points = series(state.historyTopic, metric);
  const topicLabel = state.historyTopic === 'overall'
    ? 'All topics'
    : (state.topics.find((t) => t.id === state.historyTopic)?.label || state.historyTopic);

  const first = points[0];
  const last = points[points.length - 1];
  const delta = points.length >= 2 ? last.value - first.value : null;
  const deltaHTML = delta === null ? ''
    : `<span class="change-badge" style="color:${Math.abs(delta) < (metric === 'score' ? 0.15 : 2) ? 'var(--text4)' : delta > 0 ? '#22c55e' : '#ef4444'}">
        ${Math.abs(delta) < (metric === 'score' ? 0.15 : 2) ? 'STABLE' : `${delta > 0 ? '▲' : '▼'} ${spec.fmt(Math.abs(delta))}`}
        over ${points.length} day${points.length === 1 ? '' : 's'}</span>`;

  const metricBtns = Object.entries(METRICS).map(([key, def]) =>
    `<button class="filter-btn${metric === key ? ' active' : ''}" data-metric="${key}" type="button"
      style="display:inline-flex;width:auto;margin:0 6px 0 0">
      <span class="filter-btn-text">${esc(def.label)}</span></button>`).join('');

  const topicOptions = ['overall', ...state.topics.map((t) => t.id)].map((id) => {
    const label = id === 'overall' ? 'All topics' : state.topics.find((t) => t.id === id)?.label || id;
    return `<option value="${esc(id)}"${id === state.historyTopic ? ' selected' : ''}>${esc(label)}</option>`;
  }).join('');

  const smalls = state.topics.map((topic) => {
    const tp = series(topic.id, metric);
    const cur = tp.length ? tp[tp.length - 1].value : null;
    const prev = tp.length > 1 ? tp[0].value : null;
    const dir = cur === null || prev === null ? '' :
      (cur - prev) > (metric === 'score' ? 0.15 : 2) ? '<span style="color:#22c55e">▲</span>'
        : (prev - cur) > (metric === 'score' ? 0.15 : 2) ? '<span style="color:#ef4444">▼</span>'
          : '<span style="color:var(--text5)">■</span>';
    return `<button class="timeline-card" data-history="${esc(topic.id)}" type="button"
        style="text-align:left;cursor:pointer;width:100%">
      <div class="timeline-row">
        <span class="tlc-icon">${topic.icon}</span>
        <span class="card-title" style="font-size:12px">${esc(topic.label)}</span>
        <span class="change-badge" style="margin-left:auto;color:var(--text2)">${dir}
          <span style="font-weight:700">${cur === null ? '—' : esc(spec.fmt(cur))}</span></span>
      </div>
      ${sparkline(tp, metric)}
      <div class="card-meta">${tp.length} point${tp.length === 1 ? '' : 's'}</div>
    </button>`;
  }).join('');

  const rows = days.slice().reverse().slice(0, 30).map((day) => {
    const bucket = state.historyTopic === 'overall' ? day.overall : day.topics?.[state.historyTopic];
    if (!bucket) return '';
    return `<tr>
      <td>${esc(fmtDate(day.date))}</td>
      <td class="num">${bucket.score?.toFixed(1) ?? '—'}</td>
      <td class="num">${bucket.pctPositive ?? '—'}%</td>
      <td class="num">${bucket.pctNegative ?? '—'}%</td>
      <td class="num">${bucket.items ?? '—'}</td>
    </tr>`;
  }).join('');

  return `<div class="result-card">
    <div class="card-header" style="cursor:default">
      <span class="tlc-icon">📈</span>
      <div style="flex:1;min-width:0">
        <div class="card-title">Sentiment over time — ${esc(topicLabel)}</div>
        <div class="card-meta">${esc(spec.label.toUpperCase())} · ${days.length} COLLECTION DAY${days.length === 1 ? '' : 'S'} · FREE DAILY TRACKER</div>
      </div>
      ${deltaHTML}
    </div>
    <div class="card-body">
      <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:14px">
        ${metricBtns}
        <select id="historyTopic" class="history-select" aria-label="Topic">${topicOptions}</select>
      </div>
      ${trendChart(points, metric)}
      <div class="card-meta" style="text-align:right;margin-top:6px">${(() => {
    const d = domainFor(points, spec);
    return d.full ? 'axis at full scale'
      : `axis ${spec.fmt(d.lo)}–${spec.fmt(d.hi)}, fitted to the data`;
  })()}</div>
      <div class="findings-label" style="margin-top:18px">BY TOPIC</div>
      <div class="stable-grid">${smalls}</div>
      <details style="margin-top:16px">
        <summary style="cursor:pointer;font-size:11px;color:var(--text3);font-family:'DM Mono',monospace">TABLE VIEW</summary>
        <div class="scroll"><table class="trend-table">
          <thead><tr><th>Date</th><th class="num">Score</th><th class="num">% pos</th><th class="num">% neg</th><th class="num">Items</th></tr></thead>
          <tbody>${rows}</tbody>
        </table></div>
      </details>
    </div>
  </div>`;
}

/* ─── main render ──────────────────────────────────────────────────────────── */

function emptyState() {
  return `<div class="empty-state">
    <div class="empty-icon">⬡</div>
    <div class="empty-title">No collection run yet</div>
    <div class="empty-text">
      Nothing has been collected, so no scores are shown. No placeholder numbers appear
      here on purpose — an empty dashboard is honest, a fabricated one is not.<br><br>
      Add <span class="legacy-tag">ANTHROPIC_API_KEY</span> as a repository secret, then run the
      <strong>Collect SAP AI signal</strong> workflow (or wait for the 06:00 UTC schedule).
      It researches all nine topics, scores them 1–5 with recency weighting, and commits the result.
    </div>
  </div>`;
}

function render() {
  renderStatus();
  renderMiniTracker();
  renderFilters();
  renderTopicList();
  renderWeightKey();

  const main = $('main');
  let body = '';

  if (state.category === 'history') {
    body = methodStrip() + historyView();
  } else if (state.open) {
    const topic = state.topics.find((t) => t.id === state.open);
    body = methodStrip() + (topic ? reportView(topic) : emptyState());
  } else {
    const visible = state.category === 'all'
      ? state.topics
      : state.topics.filter((t) => t.category === state.category);
    const anyReport = state.topics.some((t) => hasReport(t.id));
    body = methodStrip()
      + (anyReport || visible.length
        ? `<div class="topic-grid">${visible.map(topicCard).join('')}</div>`
        : '')
      + (anyReport ? '' : emptyState());
  }

  main.innerHTML = body;

  for (const btn of main.querySelectorAll('[data-research]')) {
    btn.addEventListener('click', () => startResearch(btn.dataset.research));
  }
  for (const btn of main.querySelectorAll('[data-metric]')) {
    btn.addEventListener('click', () => { state.metric = btn.dataset.metric; render(); });
  }
  for (const btn of main.querySelectorAll('[data-history]')) {
    btn.addEventListener('click', () => { state.historyTopic = btn.dataset.history; render(); });
  }
  const topicSelect = main.querySelector('#historyTopic');
  if (topicSelect) {
    topicSelect.addEventListener('change', (ev) => { state.historyTopic = ev.target.value; render(); });
  }
  wireCrosshair(main);
  for (const btn of main.querySelectorAll('[data-open]')) {
    btn.addEventListener('click', () => {
      state.open = btn.dataset.open || null;
      render();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });
  }
}

/* ─── theme ────────────────────────────────────────────────────────────────── */

function wireTheme() {
  const read = () => {
    try { return localStorage.getItem('sap-ai-theme'); } catch { return null; }
  };

  // Dark is the stylesheet's default; [data-theme="light"] is the opt-in.
  // The button shows the theme currently in effect, as the original did.
  const apply = () => {
    const light = read() === 'light';
    if (light) document.documentElement.setAttribute('data-theme', 'light');
    else document.documentElement.removeAttribute('data-theme');
    $('themeIcon').textContent = light ? '☀️' : '🌙';
    $('themeLabel').textContent = light ? 'LIGHT' : 'DARK';
    return light;
  };

  let light = apply();
  $('themeToggle').addEventListener('click', () => {
    light = !light;
    try { localStorage.setItem('sap-ai-theme', light ? 'light' : 'dark'); } catch { /* private mode */ }
    apply();
    render();
  });
}

/* ─── boot ─────────────────────────────────────────────────────────────────── */

async function loadJson(url, fallback) {
  try {
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) return fallback;
    return await res.json();
  } catch {
    return fallback;
  }
}

async function boot() {
  wireTheme();
  const [topics, data, trend, site] = await Promise.all([
    loadJson('./data/topics.json', { topics: [] }),
    loadJson('./data/dashboard.json', null),
    loadJson('./data/trend.json', { days: [] }),
    loadJson('./data/site.json', { workerUrl: '' }),
  ]);
  state.site = site || { workerUrl: '' };
  state.topics = topics.topics || [];
  state.data = data;
  state.trend = trend;
  render();
}

boot();
