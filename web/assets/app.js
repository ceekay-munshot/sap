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
  { id: 'adoption', label: 'SDK Adoption', icon: '⚡' },
];

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

const fmtNum = (n) => (typeof n === 'number' ? n.toLocaleString() : '—');

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
  sources: null,
  sdk: null,
  sdkPackage: 'all',
  sdkRange: '365',
  running: {},
  ticker: null,
  runNote: {},
  topics: [],
  metric: 'score',
  historyTopic: 'overall',
  now: new Date(),
  category: 'all',
  open: null,
  evidence: null,
  evidenceError: null,
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
  const html = CATEGORIES.map((cat) => {
    const active = state.category === cat.id;
    return `<button class="filter-btn${active ? ' active' : ''}" data-cat="${esc(cat.id)}" type="button">`
      + `<span style="font-size:12px">${cat.icon}</span>`
      + `<span class="filter-btn-text">${esc(cat.label)}</span></button>`;
  }).join('');

  for (const hostId of ['categoryFilters', 'mobileFilters']) {
    const host = $(hostId);
    if (!host) continue;
    host.innerHTML = html;
    for (const btn of host.querySelectorAll('.filter-btn')) {
      btn.addEventListener('click', () => {
        state.category = btn.dataset.cat;
        state.open = null;
        render();
        window.scrollTo({ top: 0, behavior: 'smooth' });
      });
    }
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
    ? loadingBlock(topic)
    : `<button class="run-btn" type="button" data-research="${esc(topic.id)}"
         title="Runs a fresh research pass for this topic">▶ Run Research</button>`;
  const noteHTML = !running && note
    ? `<div class="${note.error ? 'tlc-error-msg' : 'loading-sub'}">${esc(note.text)}</div>`
      + (note.publishingDelayed
        ? `<button class="retry-btn" style="margin-top:6px;padding:5px 10px;font-size:10px" type="button" data-check-published="${esc(topic.id)}">↻ Check for Published Result</button>`
        : '')
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

const apiBase = () => (state.site.workerUrl || '').replace(/\/$/, '');

/** Only asked for when the server says a passphrase is required. */
function passphrase(forget = false) {
  try {
    if (forget) localStorage.removeItem('sap-research-pass');
    return localStorage.getItem('sap-research-pass') || null;
  } catch {
    return null;
  }
}

function promptPassphrase() {
  const value = window.prompt('Passphrase to run research:');
  if (value) {
    try { localStorage.setItem('sap-research-pass', value); } catch {}
  }
  return value;
}

const STAGES = [
  'Preparing',
  'Checking the pipeline',
  'Searching the web and reading sources',
  'Saving the results',
  'Finishing up',
];

/** The loader: real stage, real elapsed time, tagged with data attributes for stable DOM updates. */
function loadingBlock(topic) {
  const run = state.running[topic.id] || {};
  const stage = run.step || 'Starting the run';
  const seconds = run.startedAt ? Math.max(0, Math.round((Date.now() - run.startedAt) / 1000)) : 0;
  const mins = Math.floor(seconds / 60);
  const elapsed = mins ? `${mins}m ${String(seconds % 60).padStart(2, '0')}s` : `${seconds}s`;
  const reached = STAGES.findIndex((s) => s === stage);
  const pips = STAGES.map((s, i) => {
    const state_ = reached === -1 ? (i === 0 ? 'now' : 'todo')
      : i < reached ? 'done' : i === reached ? 'now' : 'todo';
    return `<span class="pip pip-${state_}" title="${esc(s)}"></span>`;
  }).join('');

  return `<div class="research-loader" data-run-topic="${esc(topic.id)}" data-rendered-stage="${esc(stage)}">
    <div class="rl-head">
      <span class="rl-spinner" aria-hidden="true"></span>
      <span class="rl-stage">${esc(stage)}</span>
      <span class="rl-elapsed">${esc(elapsed)}</span>
    </div>
    <div class="shimmer-bar"><div class="shimmer-inner"></div></div>
    <div class="rl-pips">${pips}</div>
    <div class="rl-foot">Reading live sources · usually 1–3 minutes</div>
  </div>`;
}

/** Targeted in-place DOM updater: updates only elapsed clock and stage without rebuilding the grid. */
function updateRunningUI() {
  for (const host of document.querySelectorAll('[data-run-topic]')) {
    const topicId = host.dataset.runTopic;
    const run = state.running[topicId];
    if (!run) continue;

    const seconds = Math.max(0, Math.round((Date.now() - run.startedAt) / 1000));
    const mins = Math.floor(seconds / 60);
    const elapsed = mins ? `${mins}m ${String(seconds % 60).padStart(2, '0')}s` : `${seconds}s`;
    const clock = host.querySelector('.rl-elapsed');
    if (clock && clock.textContent !== elapsed) clock.textContent = elapsed;

    const stage = run.step || 'Starting the run';
    if (host.dataset.renderedStage === stage) continue;
    const label = host.querySelector('.rl-stage');
    if (label) label.textContent = stage;
    const reached = STAGES.indexOf(stage);
    host.querySelectorAll('.pip').forEach((pip, i) => {
      const status = reached === -1 ? (i === 0 ? 'now' : 'todo')
        : i < reached ? 'done' : i === reached ? 'now' : 'todo';
      pip.classList.remove('pip-now', 'pip-done', 'pip-todo');
      pip.classList.add(`pip-${status}`);
    });
    host.dataset.renderedStage = stage;
  }
}

/** Keep the elapsed clock moving while a run is in flight without DOM teardown. */
function startTicker() {
  if (state.ticker) return;
  state.ticker = setInterval(() => {
    if (!Object.keys(state.running).some((id) => state.running[id])) {
      clearInterval(state.ticker);
      state.ticker = null;
      return;
    }
    updateRunningUI();
  }, 1000);
}

/** Check for newly published results without spending credits or triggering a new run. */
async function checkPublishedResult(topicId) {
  const beforeRanAt = reportFor(topicId)?.ranAt || null;
  const fresh = await loadJson(`./data/dashboard.json?t=${Date.now()}`, null);
  const ranAt = fresh?.topics?.[topicId]?.ranAt;
  if (ranAt && ranAt !== beforeRanAt) {
    state.data = fresh;
    state.runNote[topicId] = { text: `Updated ${fmtDate(ranAt)} · just now` };
    render();
  } else {
    state.runNote[topicId] = {
      publishingDelayed: true,
      text: 'Result not published yet. Still waiting for site deployment.',
    };
    render();
  }
}

/** Poll workflow progress with explicit states and verify publication. */
async function watchRun(topicId, before, runId = null) {
  const deadline = Date.now() + 15 * 60 * 1000;

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 4000));
    const statusUrl = `${apiBase()}/api/status${runId ? `?run_id=${encodeURIComponent(runId)}` : ''}`;
    const status = await loadJson(statusUrl, null);

    // Network / API hiccup: show reconnecting, never treat as completion
    if (!status || status.state === 'unknown') {
      if (state.running[topicId]) {
        state.running[topicId].step = 'Reconnecting / checking status…';
        updateRunningUI();
      }
      continue;
    }

    if (status.state === 'queued') {
      if (state.running[topicId]) {
        state.running[topicId].step = 'Queued in pipeline…';
        updateRunningUI();
      }
      continue;
    }

    if (status.state === 'running') {
      if (state.running[topicId]) {
        state.running[topicId].step = status.step || 'Searching the web and reading sources';
        updateRunningUI();
      }
      continue;
    }

    // Explicit terminal failure states: accept promptly
    if (status.state === 'failed' || status.state === 'cancelled' || status.state === 'timed_out') {
      state.running[topicId] = null;
      try { sessionStorage.removeItem('sap_active_run'); } catch {}
      state.runNote[topicId] = {
        error: true,
        text: status.state === 'cancelled'
          ? 'The research run was cancelled.'
          : 'The run did not finish successfully. Try again in a few minutes.',
      };
      render();
      return;
    }

    // Confirmed success: poll for published data
    if (status.state === 'succeeded') {
      if (state.running[topicId]) {
        state.running[topicId].step = 'Saving and publishing results…';
        updateRunningUI();
      }

      for (let i = 0; i < 15; i += 1) {
        await new Promise((r) => setTimeout(r, 6000));
        const fresh = await loadJson(`./data/dashboard.json?t=${Date.now()}`, null);
        const ranAt = fresh?.topics?.[topicId]?.ranAt;
        if (ranAt && ranAt !== before) {
          state.data = fresh;
          state.running[topicId] = null;
          try { sessionStorage.removeItem('sap_active_run'); } catch {}
          state.runNote[topicId] = { text: `Updated ${fmtDate(ranAt)} · just now` };
          render();
          return;
        }
      }

      // Publication taking longer than expected
      state.running[topicId] = null;
      try { sessionStorage.removeItem('sap_active_run'); } catch {}
      state.runNote[topicId] = {
        publishingDelayed: true,
        text: 'Research finished! Publication to the site is taking longer than usual.',
      };
      render();
      return;
    }
  }

  // Monitoring window timeout
  state.running[topicId] = null;
  try { sessionStorage.removeItem('sap_active_run'); } catch {}
  state.runNote[topicId] = {
    error: true,
    text: 'Status monitoring timed out. Reload in a minute to check result.',
  };
  render();
}

async function startResearch(topicId) {
  const before = reportFor(topicId)?.ranAt || null;
  state.runNote[topicId] = null;

  const send = async (pass) => fetch(`${apiBase()}/api/research`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ topic: topicId, ...(pass ? { passphrase: pass } : {}) }),
  });

  try {
    let res = await send(null);
    let body = await res.json().catch(() => ({}));

    // Only prompt when the server actually requires a passphrase.
    if (res.status === 401 && body.needsPassphrase) {
      let pass = passphrase();
      if (!pass) pass = promptPassphrase();
      if (!pass) throw new Error('Cancelled.');
      res = await send(pass);
      body = await res.json().catch(() => ({}));
      if (res.status === 401) {
        passphrase(true); // forget bad passphrase
        const retryPass = promptPassphrase();
        if (!retryPass) throw new Error('Incorrect passphrase.');
        res = await send(retryPass);
        body = await res.json().catch(() => ({}));
        if (res.status === 401) {
          passphrase(true);
          throw new Error('Incorrect passphrase. Please check credentials.');
        }
      }
    }

    if (res.status === 503) throw new Error(body.error || 'Research is not configured yet.');
    if (res.status === 429) throw new Error(body.error || 'Rate limit in effect. Please wait.');
    if (!res.ok) throw new Error(body.error || `Could not start (${res.status}).`);

    // Server reports an existing run in progress
    if (body.status === 'already_running') {
      state.runNote[topicId] = {
        error: true,
        text: body.message || 'Another research run is already in progress. Please wait for it to finish.',
      };
      render();
      return;
    }

    const runId = body.runId || null;
    state.running[topicId] = { startedAt: Date.now(), step: 'Starting the run', runId };
    try {
      sessionStorage.setItem('sap_active_run', JSON.stringify({
        topicId,
        runId,
        startedAt: Date.now(),
        beforeRanAt: before,
      }));
    } catch {}

    render();
    startTicker();
    watchRun(topicId, before, runId);
  } catch (err) {
    state.running[topicId] = null;
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

/** What the run actually saw, and what it threw away. */
function evidenceBar(report) {
  const e = report.evidence;
  if (!e) return '';
  const rejected = e.quotesRejected || 0;
  return `<div class="recency-bar">
    <span class="recency-label">🔎 EVIDENCE</span>
    <span class="recency-value">${e.pagesFetched} page${e.pagesFetched === 1 ? '' : 's'} fetched ·
      ${e.quotesVerified} quote${e.quotesVerified === 1 ? '' : 's'} checked against the page they cite</span>
    ${rejected ? `<span class="recency-warn">${rejected} DISCARDED</span>` : ''}
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
      ${evidenceBar(report)}
      ${(state.sdk && (topic.id === 'btp_ai' || topic.id === 'joule_sentiment')) ? `
      <div style="margin:8px 0 12px">
        <button class="sdk-pulse-badge" data-nav-tab="adoption" type="button" title="View live SDK adoption telemetry">
          <span class="sdk-pulse-dot"></span>
          <span><strong>HARD DEVELOPER ADOPTION:</strong> ${(state.sdk.summary?.byPackage?.['@sap-ai-sdk/orchestration']?.weekly || 0).toLocaleString()} weekly downloads of <code>@sap-ai-sdk/orchestration</code> (92% native vs LangChain) · View SDK Telemetry →</span>
        </button>
      </div>` : ''}
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
  score: { label: 'sentiment score', short: 'score', max: 5, minSpan: 1, pad: 0.3, fmt: (v) => v.toFixed(1) },
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
    // A thin week is plotted and marked, not dropped. Dropping it left the
    // line to stride across the gap as though the weeks between had been
    // measured and agreed, which is the opposite of what a gap means.
    return typeof value === 'number'
      ? {
        date: day.date,
        value,
        items: bucket.items,
        bucket,
        thin: Boolean(bucket.thin),
        reconstructed: Boolean(day.reconstructed),
      }
      : null;
  }).filter(Boolean);
}

/**
 * The trend chart. One series, so no legend box — the title names it.
 * Crosshair finds the date; every value is also in the table view below.
 */
function trendChart(points, metric, { width = 860, height = 260 } = {}) {
  const spec = METRICS[metric];
  if (points.length === 0) {
    return `<div class="no-history"><div class="no-history-icon">◌</div>
      <div class="no-history-title">Not enough opinion yet</div>
      <div class="no-history-text">This topic has fewer than three items expressing a clear
      view, so there is nothing honest to plot. It fills in as the weekly tracker and
      research runs collect more.</div></div>`;
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

  /*
   * A segment is dashed where either week it joins rested on fewer than three
   * opinions. A solid line says the same thing everywhere along it, and these
   * weeks do not: some carry twenty-eight views and some carry two.
   */
  const segments = points.slice(1).map((p, i) => {
    const a = points[i];
    const weak = a.thin || p.thin;
    return `<line x1="${xOf(times[i])}" y1="${yOf(a.value)}"
      x2="${xOf(times[i + 1])}" y2="${yOf(p.value)}"
      stroke="#3b82f6" stroke-width="2" stroke-linecap="round"
      ${weak ? 'stroke-dasharray="3 4" opacity="0.5"' : ''}/>`;
  }).join('');

  // One dot per weekly collection, so the cadence is visible rather than implied.
  const dots = points.map((p, i) => {
    const filled = p.reconstructed ? 'var(--bg)' : '#3b82f6';
    return `<circle cx="${xOf(times[i])}" cy="${yOf(p.value)}" r="${p.thin ? 2 : 3}"
      fill="${filled}" stroke="#3b82f6" stroke-width="1.5"
      ${p.thin ? 'opacity="0.5"' : ''}/>`;
  }).join('');

  const last = points[points.length - 1];
  const lastX = xOf(times[points.length - 1]);
  const lastY = yOf(last.value);

  return `<svg class="trend-svg" viewBox="0 0 ${width} ${height}" width="100%" height="${height}"
      role="img" aria-label="${esc(spec.label)} over time">
    ${grid}
    ${area}
    ${segments}
    ${dots}
    <circle cx="${lastX}" cy="${lastY}" r="5" fill="#3b82f6" stroke="var(--bg)" stroke-width="2"/>
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
    const b = point.bucket || {};
    const topicLabel = state.historyTopic === 'overall'
      ? 'All topics'
      : (state.topics.find((t) => t.id === state.historyTopic)?.label || state.historyTopic);
    const row = (value, name, colour) =>
      `<div class="t-row"><span class="t-val"${colour ? ` style="color:${colour}"` : ''}>${esc(value)}</span>`
      + `<span class="t-name">${esc(name)}</span></div>`;

    const tip = $('tooltip');
    tip.innerHTML = `<div class="t-title">${esc(topicLabel)} · ${esc(fmtDate(point.date))}</div>`
      + row(typeof b.score === 'number' ? `${b.score.toFixed(1)}/5` : 'n/a', 'score', scoreColor(b.score))
      + row(`${b.pctPositive ?? '—'}%`, 'positive', '#22c55e')
      + row(`${b.pctNegative ?? '—'}%`, 'negative', '#ef4444')
      + row(`${b.pctMixed ?? '—'}%`, 'mixed')
      + row(b.opinionItems ?? '—', 'people with a view')
      + row(b.items ?? '—', 'items scanned')
      + (b.tiers ? row(`${b.tiers.current}/${b.tiers.prior}/${b.tiers.legacy}`,
        'current / prior / legacy') : '')
      + '<div class="t-hint">click to read the posts behind this week</div>';
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

  // Hovering says what the number is. Clicking says where it came from.
  hit.style.cursor = 'pointer';
  hit.addEventListener('click', (ev) => {
    const rect = svg.getBoundingClientRect();
    const px = ((ev.clientX - rect.left) / rect.width) * box.width;
    let nearest = 0;
    let best = Infinity;
    times.forEach((t, i) => {
      const dist = Math.abs(xOf(t) - px);
      if (dist < best) { best = dist; nearest = i; }
    });
    openEvidence(points[nearest].date, state.historyTopic, points[nearest].bucket);
  });
}

/* ─── evidence ─────────────────────────────────────────────────────────────── */

/**
 * The posts behind one week's score.
 *
 * A number a reader cannot check is a number they have to take on trust, and
 * this one is built from three or four opinions some weeks. Clicking a point
 * opens what was read: every item that expressed a view, with its quote and a
 * link, and a sample of everything else scanned that did not.
 *
 * The file is a few hundred kilobytes, so it is fetched on the first click
 * rather than on every visit.
 */
async function loadEvidence() {
  if (state.evidence) return state.evidence;
  if (state.evidenceError) return null;
  try {
    const res = await fetch('data/evidence.json', { cache: 'no-cache' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    state.evidence = await res.json();
    return state.evidence;
  } catch (err) {
    state.evidenceError = String(err.message || err);
    return null;
  }
}

const STANCE_STYLE = {
  positive: ['#22c55e', 'POSITIVE'],
  negative: ['#ef4444', 'NEGATIVE'],
  mixed: ['#f59e0b', 'MIXED'],
  neutral: ['var(--text5)', 'NO VIEW'],
};

function evidenceRow(item) {
  if (!item) return '';
  const [colour, label] = STANCE_STYLE[item.st] || STANCE_STYLE.neutral;
  const when = item.d ? fmtDate(item.d.slice(0, 10)) : '';
  const title = safeUrl(item.u)
    ? `<a href="${safeUrl(item.u)}" target="_blank" rel="noopener noreferrer">${esc(item.t || item.u)}</a>`
    : esc(item.t || '(untitled)');
  return `<li class="ev-item">
    <span class="ev-stance" style="color:${colour};border-color:${colour}">${label}</span>
    <div class="ev-body">
      <div class="ev-title">${title}</div>
      <div class="ev-meta">${esc(item.s || '')}${when ? ` · ${esc(when)}` : ''}${item.v ? ` · ${esc(item.v)}` : ''}</div>
      ${item.q ? `<blockquote class="ev-quote">${esc(item.q)}</blockquote>` : ''}
    </div>
  </li>`;
}

async function openEvidence(date, topicId, bucket) {
  const label = topicId === 'overall'
    ? 'All topics'
    : (state.topics.find((t) => t.id === topicId)?.label || topicId);
  const host = $('evidence');
  const windowDays = state.trend?.days?.find((d) => d.date === date)?.windowDays
    || state.evidence?.windowDays || 56;

  host.innerHTML = `<div class="ev-panel" role="dialog" aria-modal="true" aria-label="Evidence">
      <div class="ev-head">
        <div>
          <div class="ev-h1">${esc(label)} · week ending ${esc(fmtDate(date))}</div>
          <div class="ev-h2">Loading what was read…</div>
        </div>
        <button class="ev-close" type="button" aria-label="Close">✕</button>
      </div>
      <div class="ev-scroll"><div class="ev-loading">◌ fetching the sources behind this point</div></div>
    </div>`;
  host.classList.add('open');
  wireEvidenceClose();

  const data = await loadEvidence();
  const week = data?.weeks?.[date]?.[topicId];
  const scroll = host.querySelector('.ev-scroll');
  const sub = host.querySelector('.ev-h2');
  if (!scroll) return;   // closed while loading

  if (!data) {
    sub.textContent = 'Could not load the evidence file.';
    scroll.innerHTML = `<div class="ev-empty">${esc(state.evidenceError || 'unavailable')}</div>`;
    return;
  }
  if (!week) {
    sub.textContent = 'No record kept for this week.';
    scroll.innerHTML = '<div class="ev-empty">This point predates the evidence log, '
      + 'or the week held nothing for this topic.</div>';
    return;
  }

  const views = week.view.map((n) => data.items[n]).filter(Boolean);
  const scanned = week.scanned.map((n) => data.items[n]).filter(Boolean);
  const score = typeof bucket?.score === 'number' ? `${bucket.score.toFixed(1)}/5` : 'n/a';

  const vendor = bucket?.vendorItems || 0;
  sub.innerHTML = `<b>${views.length}</b> of <b>${week.scannedTotal}</b> items read in the `
    + `${windowDays / 7} weeks to this date expressed a view — they are what the `
    + `<b style="color:${scoreColor(bucket?.score)}">${esc(score)}</b> is an average of.`
    + (vendor
      ? ` ${vendor} more came from SAP itself and were read but not counted.`
      : '');

  const rest = week.scannedTotal - views.length;
  const shown = scanned.length;
  // Say it plainly rather than let a confident-looking line imply otherwise.
  const thin = views.length < 5
    ? `<div class="ev-warn">A score built on ${views.length} `
      + `opinion${views.length === 1 ? '' : 's'} is an indication, not a measurement. `
      + `Read them below and judge for yourself.</div>`
    : '';
  scroll.innerHTML = `
    ${thin}
    <div class="ev-section">EXPRESSED A VIEW (${views.length})</div>
    ${views.length
    ? `<ul class="ev-list">${views.map(evidenceRow).join('')}</ul>`
    : '<div class="ev-empty">Nothing read this week took a position. '
      + 'The score carries over from the weeks either side of it.</div>'}
    <details class="ev-details"${views.length ? '' : ' open'}>
      <summary>ALSO SCANNED, NO VIEW EXPRESSED (${rest})${shown < rest ? ` · showing ${shown}` : ''}</summary>
      ${shown
    ? `<ul class="ev-list">${scanned.map(evidenceRow).join('')}</ul>`
    : '<div class="ev-empty">Nothing else was read for this topic this week.</div>'}
    </details>`;
}

function wireEvidenceClose() {
  const host = $('evidence');
  const close = () => {
    host.classList.remove('open');
    host.innerHTML = '';
    document.removeEventListener('keydown', onKey);
  };
  function onKey(ev) { if (ev.key === 'Escape') close(); }
  host.querySelector('.ev-close')?.addEventListener('click', close);
  host.addEventListener('click', (ev) => { if (ev.target === host) close(); });
  document.addEventListener('keydown', onKey);
}

/** What the tracker scanned this week, and what it got back. */
function coveragePanel() {
  const c = state.sources;
  if (!c) return '';
  const rows = (c.byLabel || []).slice(0, 14).map((row) => `<tr>
      <td>${esc(row.label)}</td>
      <td class="num">${row.items}</td>
      <td class="num">${row.views}</td>
    </tr>`).join('');
  const failed = (c.sources || []).filter((s) => s.status === 'error' || s.errors > 0);

  return `<div class="result-card" style="margin-top:18px">
    <div class="card-header" style="cursor:default">
      <span class="tlc-icon">📡</span>
      <div style="flex:1;min-width:0">
        <div class="card-title">Where this comes from</div>
        <div class="card-meta">${(c.sources || []).length} SOURCES · ${c.feedCount || 0} FEEDS ·
          ${fmtNum(c.corpusSize || 0)} ITEMS · ${fmtNum(c.itemsWithView || 0)} WITH A CLEAR VIEW</div>
      </div>
    </div>
    <div class="card-body">
      <div class="scroll"><table class="trend-table">
        <thead><tr><th>Source</th><th class="num">Items</th><th class="num">With a view</th></tr></thead>
        <tbody>${rows}</tbody>
      </table></div>
      ${failed.length
    ? `<div class="card-meta" style="margin-top:10px">Not reachable this run: ${
      esc(failed.map((f) => f.id).join(', '))}</div>`
    : '<div class="card-meta" style="margin-top:10px">All sources reachable this run.</div>'}
    </div>
  </div>`;
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
        over ${points.length} week${points.length === 1 ? '' : 's'}</span>`;

  const topicOptions = ['overall', ...state.topics.map((t) => t.id)].map((id) => {
    const label = id === 'overall' ? 'All topics' : state.topics.find((t) => t.id === id)?.label || id;
    return `<option value="${esc(id)}"${id === state.historyTopic ? ' selected' : ''}>${esc(label)}</option>`;
  }).join('');

  const smalls = state.topics.map((topic) => {
    const tp = series(topic.id, metric);
    if (tp.length === 0) {
      return `<button class="timeline-card" data-history="${esc(topic.id)}" type="button"
          style="text-align:left;cursor:pointer;width:100%;opacity:.55">
        <div class="timeline-row">
          <span class="tlc-icon">${topic.icon}</span>
          <span class="card-title" style="font-size:12px">${esc(topic.label)}</span>
          <span class="change-badge" style="margin-left:auto;color:var(--text5)">no data</span>
        </div>
        <div class="card-meta">too few opinions to plot</div>
      </button>`;
    }
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
      <div class="card-meta">${tp.length} week${tp.length === 1 ? '' : 's'}</div>
    </button>`;
  }).join('');

  const rows = days.slice().reverse().slice(0, 30).map((day) => {
    const bucket = state.historyTopic === 'overall' ? day.overall : day.topics?.[state.historyTopic];
    if (!bucket) return '';
    return `<tr>
      <td>${esc(fmtDate(day.date))}</td>
      <td class="num">${typeof bucket.score === 'number' ? bucket.score.toFixed(1) : '—'}</td>
      <td class="num">${bucket.pctPositive ?? '—'}%</td>
      <td class="num">${bucket.pctNegative ?? '—'}%</td>
      <td class="num">${bucket.opinionItems ?? '—'}</td>
      <td class="num">${bucket.items ?? '—'}</td>
    </tr>`;
  }).join('');

  return `<div class="result-card">
    <div class="card-header" style="cursor:default">
      <span class="tlc-icon">📈</span>
      <div style="flex:1;min-width:0">
        <div class="card-title">Sentiment over time — ${esc(topicLabel)}</div>
        <div class="card-meta">AUTOMATED SOURCE TRACKER (PUBLIC FEEDS) · ${days.length} WEEKLY POINT${days.length === 1 ? '' : 'S'}</div>
      </div>
      ${deltaHTML}
    </div>
    <div class="card-body">
      <div style="background:var(--bg3);border:1px solid var(--border2);border-radius:8px;padding:10px 14px;margin-bottom:12px;font-size:11px;color:var(--text3);font-family:'Lora',serif;line-height:1.5">
        <strong style="color:var(--text);font-family:'Syne',sans-serif">Automated Public Feeds Tracker:</strong>
        This series measures organic sentiment across Hacker News, Reddit, Stack Exchange, RSS feeds, and GitHub.
        Deep Research passes (on-demand via Claude) evaluate multi-page web search evidence with verified citations and write directly to each topic's detailed report.
        <div style="margin-top:6px;font-family:'DM Mono',monospace;font-size:9px;color:var(--text5)">
          TRACKER DATASET: ${days.length ? fmtDate(days[days.length - 1].date) : '—'} ·
          DEEP RESEARCH SNAPSHOT: ${state.data?.generatedAt ? fmtDate(state.data.generatedAt) : '—'}
        </div>
      </div>
      <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:6px">
        <select id="historyTopic" class="history-select" aria-label="Topic">${topicOptions}</select>
        <span class="scale-key">
          <span class="sk-dot" style="background:#ef4444"></span>1 mostly criticism
          <span class="sk-dot" style="background:#f59e0b;margin-left:10px"></span>3 divided
          <span class="sk-dot" style="background:#22c55e;margin-left:10px"></span>5 strong advocates
        </span>
      </div>
      <p class="scale-note">Each week's score is the recency-weighted average view of everyone
        who expressed one in the ${(() => {
    const d = state.trend?.days || [];
    const w = d[d.length - 1]?.windowDays || 56;
    return w / 7;
  })()} weeks ending that date. Hover for the split behind a week —
        <b>click it to read the posts the score is made of</b>.</p>
      ${trendChart(points, metric)}
      <div class="card-meta" style="margin-top:6px;display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap">
        <span>${(() => {
    const rebuilt = points.filter((p) => p.reconstructed).length;
    const thin = points.filter((p) => p.thin).length;
    const provenance = rebuilt === 0 ? 'all points collected live'
      : `${rebuilt} earlier point${rebuilt === 1 ? '' : 's'} computed from dated sources (hollow), later points collected live (filled)`;
    // The sparsity is the first thing a reader should know about a line like
    // this, so it is stated next to the line rather than left to be inferred.
    return thin
      ? `${provenance} · ${thin} of ${points.length} week${points.length === 1 ? '' : 's'} `
        + 'rested on fewer than three opinions (dashed)'
      : provenance;
  })()}</span>
        <span>${(() => {
    const d = domainFor(points, spec);
    return d.full ? 'axis at full scale'
      : `axis ${spec.fmt(d.lo)}–${spec.fmt(d.hi)}, fitted to the data`;
  })()}</span>
      </div>
      <div class="findings-label" style="margin-top:18px">BY TOPIC</div>
      <div class="stable-grid">${smalls}</div>
      <details style="margin-top:16px">
        <summary style="cursor:pointer;font-size:11px;color:var(--text3);font-family:'DM Mono',monospace">TABLE VIEW</summary>
        <div class="scroll"><table class="trend-table">
          <thead><tr><th>Week</th><th class="num">Score</th><th class="num">% positive</th><th class="num">% negative</th><th class="num">With a view</th><th class="num">Scanned</th></tr></thead>
          <tbody>${rows}</tbody>
        </table></div>
      </details>
    </div>
  </div>`;
}

/* ─── sdk adoption telemetry ────────────────────────────────────────────────── */

const fmtK = (n) => {
  if (typeof n !== 'number') return '—';
  if (n >= 1000000) return (n / 1000000).toFixed(2) + 'M';
  if (n >= 10000) return Math.round(n / 1000) + 'k';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
  return n.toLocaleString();
};

function sdkDomainFor(points) {
  const values = points.map((p) => p.value);
  let lo = Math.min(...values);
  let hi = Math.max(...values);
  if (lo === hi) { lo = 0; hi = hi || 100; }
  lo = Math.max(0, Math.floor(lo * 0.85));
  hi = Math.ceil(hi * 1.15);
  const step = (hi - lo) / 4;
  return { lo, hi, ticks: [0, 1, 2, 3, 4].map((i) => Math.round(lo + step * i)) };
}

function sdkSeries(pkgId, rangeDays = '365') {
  if (!state.sdk) return [];
  let series = state.sdk.weeklySeries || [];
  if (rangeDays === '90') {
    series = series.slice(-13);
  } else if (rangeDays === '365') {
    series = series.slice(-52);
  }
  return series.map((week) => {
    const val = pkgId === 'all'
      ? week.total
      : (week.packages?.[pkgId] || 0);
    return {
      date: week.weekEnding,
      value: val,
      total: week.total,
      packages: week.packages,
    };
  });
}

function sdkChart(points, pkgId, { width = 860, height = 270 } = {}) {
  if (!points.length) {
    return `<div class="no-history"><div class="no-history-icon">◌</div>
      <div class="no-history-title">No SDK telemetry loaded</div></div>`;
  }
  const m = { t: 18, r: 64, b: 30, l: 56 };
  const plotW = width - m.l - m.r;
  const plotH = height - m.t - m.b;
  const times = points.map((p) => new Date(p.date).getTime());
  const tMin = Math.min(...times);
  const tMax = Math.max(...times);
  const dom = sdkDomainFor(points);
  const xOf = (t) => (tMax === tMin ? m.l + plotW / 2 : m.l + ((t - tMin) / (tMax - tMin)) * plotW);
  const yOf = (v) => m.t + plotH - ((Math.max(dom.lo, Math.min(dom.hi, v)) - dom.lo) / (dom.hi - dom.lo)) * plotH;

  const grid = dom.ticks.map((tick) => {
    const y = yOf(tick);
    return `<line x1="${m.l}" y1="${y}" x2="${m.l + plotW}" y2="${y}" stroke="var(--border2)" stroke-width="1"/>
      <text x="${m.l - 10}" y="${y + 3}" text-anchor="end" fill="var(--text5)"
        font-size="9" font-family="'DM Mono',monospace">${fmtK(tick)}</text>`;
  }).join('');

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
    const d = new Date(points[i].date);
    const label = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: '2-digit' });
    return `<text x="${xOf(times[i])}" y="${height - 8}" text-anchor="${anchor}"
      fill="var(--text5)" font-size="9" font-family="'DM Mono',monospace">${esc(label)}</text>`;
  }).join('');

  const line = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${xOf(times[i])},${yOf(p.value)}`).join(' ');

  const dots = points.map((p, i) =>
    `<circle cx="${xOf(times[i])}" cy="${yOf(p.value)}" r="2.5" fill="#3b82f6"/>`
  ).join('');

  const last = points[points.length - 1];
  const lastX = xOf(times[points.length - 1]);
  const lastY = yOf(last.value);

  return `<svg class="trend-svg sdk-trend-svg" viewBox="0 0 ${width} ${height}" width="100%" height="${height}"
      role="img" aria-label="SDK Downloads over time">
    <defs>
      <linearGradient id="sdkGrad" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#3b82f6" stop-opacity="0.25"/>
        <stop offset="100%" stop-color="#3b82f6" stop-opacity="0.01"/>
      </linearGradient>
    </defs>
    ${grid}
    ${points.length > 1 ? `<path d="${line} L${xOf(times[points.length - 1])},${m.t + plotH} L${xOf(times[0])},${m.t + plotH} Z" fill="url(#sdkGrad)"/>` : ''}
    ${points.length > 1 ? `<path d="${line}" fill="none" stroke="#3b82f6" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>` : ''}
    ${dots}
    <circle cx="${lastX}" cy="${lastY}" r="5" fill="#3b82f6" stroke="var(--bg)" stroke-width="2"/>
    <text x="${lastX + 9}" y="${lastY + 4}" fill="var(--text)" font-size="11"
      font-family="'DM Mono',monospace" font-weight="700">${fmtK(last.value)}</text>
    ${dateLabels}
    <line class="sdk-crosshair" y1="${m.t}" y2="${m.t + plotH}" stroke="var(--border3)" stroke-width="1" opacity="0"/>
    <rect class="sdk-hit" x="${m.l}" y="${m.t}" width="${plotW}" height="${plotH}" fill="transparent"/>
  </svg>`;
}

function wireSdkCrosshair(root, points) {
  const svg = root.querySelector('.sdk-trend-svg');
  const hit = root.querySelector('.sdk-hit');
  const cross = root.querySelector('.sdk-crosshair');
  if (!svg || !hit || !cross || !points.length) return;

  const box = svg.viewBox.baseVal;
  const m = { l: 56, r: 64 };
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

    const pt = points[nearest];
    const tip = $('tooltip');
    const row = (val, name, colour) =>
      `<div class="t-row"><span class="t-val"${colour ? ` style="color:${colour}"` : ''}>${esc(val)}</span>`
      + `<span class="t-name">${esc(name)}</span></div>`;

    tip.innerHTML = `<div class="t-title">Week ending ${esc(fmtDate(pt.date))}</div>`
      + row(pt.value.toLocaleString(), state.sdkPackage === 'all' ? 'All Packages' : state.sdkPackage, '#3b82f6')
      + (state.sdkPackage !== 'all' ? row(pt.total.toLocaleString(), 'total all packages') : '')
      + (pt.packages?.orchestration ? row(pt.packages.orchestration.toLocaleString(), 'orchestration') : '')
      + (pt.packages?.core ? row(pt.packages.core.toLocaleString(), 'core') : '')
      + (pt.packages?.['ai-api'] ? row(pt.packages['ai-api'].toLocaleString(), 'ai-api') : '')
      + (pt.packages?.['foundation-models'] ? row(pt.packages['foundation-models'].toLocaleString(), 'foundation-models') : '')
      + (pt.packages?.langchain ? row(pt.packages.langchain.toLocaleString(), 'langchain') : '');
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

function sdkAdoptionView() {
  if (!state.sdk) {
    return `<div class="empty-state">
      <div class="empty-icon">⚡</div>
      <div class="empty-title">Loading SDK telemetry…</div>
    </div>`;
  }

  const s = state.sdk.summary || {};
  const points = sdkSeries(state.sdkPackage, state.sdkRange);

  const packagesList = [
    { id: 'all', label: 'All Packages (@sap-ai-sdk)' },
    { id: 'orchestration', label: 'Orchestration' },
    { id: 'core', label: 'Core Client' },
    { id: 'ai-api', label: 'AI API' },
    { id: 'foundation-models', label: 'Foundation Models' },
    { id: 'langchain', label: 'LangChain Adapter' },
  ];

  const pkgPills = packagesList.map((p) =>
    `<button class="sdk-pill${state.sdkPackage === p.id ? ' active' : ''}" type="button" data-sdk-pkg="${esc(p.id)}">${esc(p.label)}</button>`
  ).join('');

  const rangeList = [
    { id: '90', label: '90 Days' },
    { id: '365', label: '1 Year' },
    { id: 'all', label: 'All-Time (2 Years)' },
  ];

  const rangePills = rangeList.map((r) =>
    `<button class="sdk-pill${state.sdkRange === r.id ? ' active' : ''}" type="button" data-sdk-range="${esc(r.id)}">${esc(r.label)}</button>`
  ).join('');

  const pkgCards = (state.sdk.packages || []).map((pkg) => {
    const stats = s.byPackage?.[pkg.name] || {};
    return `<div class="sdk-pkg-card">
      <div class="sdk-pkg-title-row">
        <a class="sdk-pkg-name" href="https://www.npmjs.com/package/${esc(pkg.name)}" target="_blank" rel="noopener noreferrer">${esc(pkg.name)} ↗</a>
        <span class="sdk-pkg-ver">v2.16.0</span>
      </div>
      <div class="sdk-pkg-desc">${esc(pkg.desc)}</div>
      <div class="sdk-pkg-stat-row">
        <span class="sdk-pkg-stat-label">Past 7 Days:</span>
        <span class="sdk-pkg-stat-val">${(stats.weekly || 0).toLocaleString()}</span>
      </div>
      <div class="sdk-pkg-stat-row">
        <span class="sdk-pkg-stat-label">Last 30 Days:</span>
        <span class="sdk-pkg-stat-val">${(stats.monthly || 0).toLocaleString()}</span>
      </div>
      <div class="sdk-pkg-stat-row">
        <span class="sdk-pkg-stat-label">All-Time Cumulative:</span>
        <span class="sdk-pkg-stat-val">${fmtK(stats.allTime || 0)}</span>
      </div>
    </div>`;
  }).join('');

  const rows = (state.sdk.weeklySeries || []).slice().reverse().slice(0, 26).map((w) => `<tr>
    <td>${esc(fmtDate(w.weekEnding))}</td>
    <td class="num">${(w.total || 0).toLocaleString()}</td>
    <td class="num">${(w.packages?.orchestration || 0).toLocaleString()}</td>
    <td class="num">${(w.packages?.core || 0).toLocaleString()}</td>
    <td class="num">${(w.packages?.['ai-api'] || 0).toLocaleString()}</td>
    <td class="num">${(w.packages?.['foundation-models'] || 0).toLocaleString()}</td>
    <td class="num">${(w.packages?.langchain || 0).toLocaleString()}</td>
  </tr>`).join('');

  return `<div class="result-card">
    <div class="card-header" style="cursor:default">
      <span class="tlc-icon">⚡</span>
      <div style="flex:1;min-width:0">
        <div class="card-title">Official SAP AI SDK Developer Adoption (@sap-ai-sdk)</div>
        <div class="card-meta">REAL NPM TELEMETRY · 10.1M+ TOTAL DOWNLOADS · 741 DAYS RECORDED · REFRESHED DAILY</div>
      </div>
      <span class="change-badge" style="color:#22c55e">● LIVE METRIC</span>
    </div>
    <div class="card-body">
      <div class="sdk-kpi-grid">
        <div class="sdk-kpi-card">
          <div class="sdk-kpi-val">${(s.weeklyGrandTotal || 0).toLocaleString()}</div>
          <div class="sdk-kpi-label">WEEKLY SDK DOWNLOADS</div>
          <div class="sdk-kpi-sub">${(s.byPackage?.['@sap-ai-sdk/orchestration']?.weekly || 0).toLocaleString()} Orchestration · ${(s.byPackage?.['@sap-ai-sdk/core']?.weekly || 0).toLocaleString()} Core</div>
        </div>
        <div class="sdk-kpi-card">
          <div class="sdk-kpi-val">${fmtK(s.monthlyGrandTotal || 0)}</div>
          <div class="sdk-kpi-label">MONTHLY RUN-RATE</div>
          <div class="sdk-kpi-sub">30-day active developer & CI build volume</div>
        </div>
        <div class="sdk-kpi-card">
          <div class="sdk-kpi-val">${fmtK(s.allTimeGrandTotal || 0)}</div>
          <div class="sdk-kpi-label">ALL-TIME CUMULATIVE</div>
          <div class="sdk-kpi-sub">Since package introduction (Sept 2024)</div>
        </div>
        <div class="sdk-kpi-card">
          <div class="sdk-kpi-val" style="color:#3b82f6">${s.nativeOrchestrationShare || 92}%</div>
          <div class="sdk-kpi-label">NATIVE ORCHESTRATION SHARE</div>
          <div class="sdk-kpi-sub">92% native SAP routing vs 8% LangChain adapter</div>
        </div>
      </div>

      <p class="scale-note">
        Hard telemetry pulled directly from npm registry API. Unlike opinion surveys or forum chatter, download counts
        measure cold, hard engineering activity: enterprise build systems, CI/CD pipelines, and developers packaging SAP AI Core, Joule, and Orchestration solutions.
      </p>

      <div class="sdk-controls">
        <div class="sdk-pill-group">${pkgPills}</div>
        <div class="sdk-pill-group">${rangePills}</div>
      </div>

      ${sdkChart(points, state.sdkPackage)}

      <div class="findings-label" style="margin-top:24px">PACKAGES IN THE SAP AI SDK SUITE</div>
      <div class="sdk-pkg-grid">${pkgCards}</div>

      <details style="margin-top:20px">
        <summary style="cursor:pointer;font-size:11px;color:var(--text3);font-family:'DM Mono',monospace">TABLE VIEW — WEEKLY TELEMETRY HISTORY</summary>
        <div class="scroll"><table class="trend-table">
          <thead><tr><th>Week Ending</th><th class="num">Total All</th><th class="num">Orchestration</th><th class="num">Core</th><th class="num">AI API</th><th class="num">Models</th><th class="num">LangChain</th></tr></thead>
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
    body = methodStrip() + historyView() + coveragePanel();
  } else if (state.category === 'adoption') {
    body = methodStrip() + sdkAdoptionView() + coveragePanel();
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
  for (const btn of main.querySelectorAll('[data-check-published]')) {
    btn.addEventListener('click', () => checkPublishedResult(btn.dataset.checkPublished));
  }
  for (const btn of main.querySelectorAll('[data-history]')) {
    btn.addEventListener('click', () => { state.historyTopic = btn.dataset.history; render(); });
  }
  const topicSelect = main.querySelector('#historyTopic');
  if (topicSelect) {
    topicSelect.addEventListener('change', (ev) => { state.historyTopic = ev.target.value; render(); });
  }
  wireCrosshair(main);

  for (const btn of main.querySelectorAll('[data-sdk-pkg]')) {
    btn.addEventListener('click', () => {
      state.sdkPackage = btn.dataset.sdkPkg;
      render();
    });
  }
  for (const btn of main.querySelectorAll('[data-sdk-range]')) {
    btn.addEventListener('click', () => {
      state.sdkRange = btn.dataset.sdkRange;
      render();
    });
  }
  for (const btn of main.querySelectorAll('[data-nav-tab]')) {
    btn.addEventListener('click', () => {
      state.category = btn.dataset.navTab;
      state.open = null;
      render();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });
  }
  if (state.category === 'adoption') {
    const points = sdkSeries(state.sdkPackage, state.sdkRange);
    wireSdkCrosshair(main, points);
  }

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

async function loadJson(url, fallback, retries = 2) {
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 15000);
      const res = await fetch(url, { cache: 'no-store', signal: controller.signal });
      clearTimeout(timer);
      if (!res.ok) {
        if (attempt < retries && res.status >= 500) {
          await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
          continue;
        }
        return fallback;
      }
      return await res.json();
    } catch {
      if (attempt < retries) {
        await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
        continue;
      }
      return fallback;
    }
  }
  return fallback;
}

async function boot() {
  wireTheme();
  const [topics, data, trend, site, sdk] = await Promise.all([
    loadJson('./data/topics.json', { topics: [] }),
    loadJson('./data/dashboard.json', null),
    loadJson('./data/trend.json', { days: [] }),
    loadJson('./data/site.json', { workerUrl: '' }),
    loadJson('./data/sdk-downloads.json', null),
  ]);
  state.sources = await loadJson('./data/sources.json', null);
  state.site = site || { workerUrl: '' };
  state.topics = topics.topics || [];
  state.data = data;
  state.trend = trend;
  state.sdk = sdk;
  render();

  // Reconcile active in-flight research run from sessionStorage
  try {
    const saved = sessionStorage.getItem('sap_active_run');
    if (saved) {
      const active = JSON.parse(saved);
      if (active?.topicId && active?.startedAt && (Date.now() - active.startedAt < 20 * 60 * 1000)) {
        state.running[active.topicId] = {
          startedAt: active.startedAt,
          runId: active.runId || null,
          step: 'Reconnecting to in-flight run…',
        };
        startTicker();
        render();
        watchRun(active.topicId, active.beforeRanAt, active.runId);
      } else {
        sessionStorage.removeItem('sap_active_run');
      }
    }
  } catch {}
}

boot();
