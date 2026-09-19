import {
  frameFor, describePolicy, tierFor, explainWeight, weightFor, round,
} from '../lib/recency.mjs';

/* ----------------------------------------------------------------- helpers */

const $ = (id) => document.getElementById(id);
const SVG_NS = 'http://www.w3.org/2000/svg';

/** Build an element. Text always goes in via textContent — data is untrusted. */
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}
function svg(tag, attrs = {}) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v !== null && v !== undefined) node.setAttribute(k, String(v));
  }
  return node;
}
function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }

const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

const PILLAR_COLORS = { s4hana: '--series-1', bdc: '--series-2', joule: '--series-3', agents: '--series-4' };
const TIER_COLORS = { current: '--tier-current', prior: '--tier-prior', legacy: '--tier-legacy' };

const fmtPct = (n) => `${Math.round(n * 100)}%`;
const fmtIndex = (n) => (n === null || n === undefined ? '—' : (n * 100).toFixed(0));
const fmtNum = (n) => (n === null || n === undefined ? '—' : n.toLocaleString());
const fmtDate = (iso) => {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—'
    : d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
};

/* ------------------------------------------------------------------- state */

const state = {
  data: null,
  trend: null,
  now: new Date(),
  filters: { range: 'all', pillar: 'all', source: 'all', tier: 'all', text: '' },
};

/* --------------------------------------------------------------- tooltip */

const tip = $('tooltip');
function showTip(html, x, y) {
  clear(tip);
  tip.appendChild(html);
  tip.style.opacity = '1';
  const box = tip.getBoundingClientRect();
  const left = Math.min(Math.max(8, x + 14), window.innerWidth - box.width - 8);
  const top = Math.min(Math.max(8, y - box.height - 12), window.innerHeight - box.height - 8);
  tip.style.left = `${left}px`;
  tip.style.top = `${top}px`;
}
function hideTip() { tip.style.opacity = '0'; }

function tipBlock(title, rows) {
  const frag = document.createDocumentFragment();
  frag.appendChild(el('div', 't-title', title));
  for (const row of rows) {
    const line = el('div', 't-row');
    if (row.color) {
      const key = el('span', 't-key');
      key.style.background = row.color;
      line.appendChild(key);
    }
    line.appendChild(el('span', 't-val', row.value));
    line.appendChild(el('span', 't-name', row.name));
    frag.appendChild(line);
  }
  return frag;
}

/* --------------------------------------------------- client-side rollups
   The filter row scopes everything below it, so the numbers are recomputed
   in the browser from the evidence rows using the same shared weighting
   module the collector used. One implementation, two runtimes.            */

function visibleItems() {
  const { range, pillar, source, tier, text } = state.filters;
  const needle = text.trim().toLowerCase();
  const cutoff = range === 'all' ? null
    : new Date(state.now.getTime() - Number(range) * 86400000);

  return (state.data.items || []).filter((item) => {
    if (cutoff) {
      const d = item.date ? new Date(item.date) : null;
      if (!d || Number.isNaN(d.getTime()) || d < cutoff) return false;
    }
    if (pillar !== 'all' && !(item.pillars || []).includes(pillar)) return false;
    if (source !== 'all' && item.source !== source) return false;
    if (tier !== 'all' && tierFor(item.date, state.now) !== tier) return false;
    if (needle) {
      const hay = `${item.title} ${item.quote} ${item.theme} ${item.source}`.toLowerCase();
      if (!hay.includes(needle)) return false;
    }
    return true;
  });
}

function rollup(items) {
  let num = 0; let den = 0; let rawSum = 0; let rawN = 0;
  const dist = { positive: 0, mixed: 0, neutral: 0, negative: 0 };
  for (const item of items) {
    if (typeof item.sentiment !== 'number') continue;
    const w = weightFor(item.date, state.now);
    num += item.sentiment * w;
    den += w;
    rawSum += item.sentiment;
    rawN += 1;
    const stance = dist[item.stance] === undefined ? 'neutral' : item.stance;
    dist[stance] += w;
  }
  const share = {};
  for (const k of Object.keys(dist)) share[k] = den === 0 ? 0 : dist[k] / den;
  return {
    items: items.length,
    weighted: den === 0 ? null : round(num / den, 4),
    raw: rawN === 0 ? null : round(rawSum / rawN, 4),
    totalWeight: round(den, 2),
    share,
  };
}

function rollupByPillar(items) {
  return (state.data.pillars || []).map((pillar) => ({
    id: pillar.id,
    label: pillar.label,
    blurb: pillar.blurb,
    ...rollup(items.filter((i) => (i.pillars || []).includes(pillar.id))),
  }));
}

function rollupThemes(items, direction) {
  const keep = direction === 'praise' ? (s) => s >= 0.25 : (s) => s <= -0.25;
  const buckets = new Map();
  for (const item of items) {
    if (typeof item.sentiment !== 'number' || !keep(item.sentiment)) continue;
    const label = (item.theme || '').trim();
    if (!label) continue;
    const key = label.toLowerCase();
    const bucket = buckets.get(key)
      || { theme: label, items: 0, weight: 0, scoreSum: 0, examples: [] };
    const w = weightFor(item.date, state.now);
    bucket.items += 1;
    bucket.weight += w;
    bucket.scoreSum += item.sentiment * w;
    if (bucket.examples.length < 2 && item.quote) {
      bucket.examples.push({ quote: item.quote, url: item.url, date: item.date, source: item.source });
    }
    buckets.set(key, bucket);
  }
  return [...buckets.values()]
    .map((b) => ({ ...b, score: b.scoreSum / b.weight, weight: round(b.weight, 2) }))
    .sort((a, b) => b.weight - a.weight)
    .slice(0, 8);
}

function rollupByYear(items) {
  const years = new Map();
  for (const item of items) {
    const d = item.date ? new Date(item.date) : null;
    const key = d && !Number.isNaN(d.getTime()) ? String(d.getUTCFullYear()) : 'undated';
    const bucket = years.get(key) || { year: key, items: 0, weight: 0, tier: tierFor(item.date, state.now) };
    bucket.items += 1;
    bucket.weight += weightFor(item.date, state.now);
    years.set(key, bucket);
  }
  return [...years.values()].sort((a, b) => a.year.localeCompare(b.year));
}

function rollupBySource(items) {
  const map = new Map();
  for (const item of items) {
    const bucket = map.get(item.source) || { source: item.source, rows: [] };
    bucket.rows.push(item);
    map.set(item.source, bucket);
  }
  return [...map.values()]
    .map((b) => ({ source: b.source, ...rollup(b.rows) }))
    .sort((a, b) => b.items - a.items);
}

/* ----------------------------------------------------------- policy strip
   Computed from the browser clock, never from the stored snapshot, so the
   labels stay correct even if collection stops. On 1 January every badge,
   banner and footer note below moves together.                           */

function renderPolicy() {
  const frame = frameFor(state.now);
  const prose = describePolicy(state.now);
  const host = $('policy-tiers');
  clear(host);
  for (const tier of frame.tiers) {
    const chip = el('span', 'chip');
    const dot = el('span', 'dot');
    dot.style.background = cssVar(TIER_COLORS[tier.id]);
    chip.appendChild(dot);
    chip.appendChild(el('span', null, `${tier.badge} — ${tier.note}`));
    host.appendChild(chip);
  }
  $('policy-freshness').textContent = prose.freshness;
  $('policy-rollover').textContent = prose.rollover;
  return frame;
}

/* -------------------------------------------------------------- chart util */

/** Rounded only where a mark actually ends — square where it meets a neighbour. */
function roundedRect(x, y, w, h, rl, rr) {
  const width = Math.max(w, 0.5);
  const left = Math.min(rl, width / 2, h / 2);
  const right = Math.min(rr, width / 2, h / 2);
  return `M${x + left},${y}`
    + `H${x + width - right}`
    + (right ? `a${right},${right} 0 0 1 ${right},${right}` : '')
    + `V${y + h - right}`
    + (right ? `a${right},${right} 0 0 1 ${-right},${right}` : '')
    + `H${x + left}`
    + (left ? `a${left},${left} 0 0 1 ${-left},${-left}` : '')
    + `V${y + left}`
    + (left ? `a${left},${left} 0 0 1 ${left},${-left}` : '')
    + 'Z';
}

function legendInto(host, keys, shape = 'line') {
  clear(host);
  for (const key of keys) {
    const item = el('span', 'key');
    const swatch = el('span', shape === 'box' ? 'swatch box' : 'swatch');
    swatch.style.background = key.color;
    swatch.style.boxShadow = 'inset 0 0 0 1px var(--hairline)';
    item.appendChild(swatch);
    item.appendChild(el('span', null, key.label));
    host.appendChild(item);
  }
}

/* --------------------------------------------------------------- the hero */

function renderHero(agg, items) {
  const figure = $('hero-figure');
  figure.textContent = agg.weighted === null ? '—' : (agg.weighted > 0 ? '+' : '') + fmtIndex(agg.weighted);
  figure.style.color = agg.weighted === null ? 'var(--ink)'
    : agg.weighted > 0.05 ? 'var(--pos)' : agg.weighted < -0.05 ? 'var(--neg)' : 'var(--ink)';

  const shift = (agg.weighted === null || agg.raw === null) ? null : agg.weighted - agg.raw;
  $('hero-explain').textContent = agg.weighted === null
    ? 'No scored practitioner evidence in this slice.'
    : `${fmtNum(agg.items)} practitioner items in view, on a −100 to +100 scale. `
      + (shift === null ? ''
        : `Recency weighting moves the reading ${shift >= 0 ? 'up' : 'down'} `
          + `${Math.abs(shift * 100).toFixed(0)} points versus an unweighted average.`);

  // A diverging meter: where this index sits between −100 and +100.
  const host = $('hero-scale');
  clear(host);
  const W = 320; const H = 34;
  const chart = svg('svg', { class: 'chart', viewBox: `0 0 ${W} ${H}`, width: '100%', height: H, role: 'img' });
  chart.setAttribute('aria-label', `Index ${fmtIndex(agg.weighted)} on a scale from minus 100 to plus 100`);
  const trackY = 12; const trackH = 8;
  chart.appendChild(svg('rect', { x: 0, y: trackY, width: W, height: trackH, rx: 4, fill: cssVar('--neutral') }));
  chart.appendChild(svg('line', { x1: W / 2, y1: trackY - 4, x2: W / 2, y2: trackY + trackH + 4, class: 'axis' }));
  if (agg.weighted !== null) {
    const cx = W / 2 + (agg.weighted * W) / 2;
    const fill = agg.weighted >= 0 ? cssVar('--pos') : cssVar('--neg');
    const from = Math.min(W / 2, cx); const to = Math.max(W / 2, cx);
    chart.appendChild(svg('rect', { x: from, y: trackY, width: Math.max(to - from, 2), height: trackH, rx: 4, fill }));
    const dot = svg('circle', { cx, cy: trackY + trackH / 2, r: 6, fill, stroke: cssVar('--surface'), 'stroke-width': 2 });
    chart.appendChild(dot);
  }
  const mkText = (x, anchor, text) => {
    const t = svg('text', { x, y: H - 1, 'text-anchor': anchor });
    t.textContent = text;
    return t;
  };
  chart.appendChild(mkText(0, 'start', '−100 hostile'));
  chart.appendChild(mkText(W / 2, 'middle', '0'));
  chart.appendChild(mkText(W, 'end', 'impressed +100'));
  host.appendChild(chart);

  // KPI row
  const kpis = $('kpis');
  clear(kpis);
  const years = rollupByYear(items);
  const currentCount = years.filter((y) => y.tier === 'current').reduce((a, b) => a + b.items, 0);
  const tiles = [
    { label: 'Practitioner items in view', value: fmtNum(agg.items), note: `${fmtNum(state.data.corpus?.total ?? 0)} in the full corpus` },
    {
      label: 'From the current year',
      value: agg.items ? fmtPct(currentCount / agg.items) : '—',
      note: `${fmtNum(currentCount)} items at ${frameFor(state.now).tiers[0].multiplier}`,
    },
    {
      label: 'Weighting effect',
      value: shift === null ? '—' : `${shift >= 0 ? '+' : '−'}${Math.abs(shift * 100).toFixed(0)}`,
      note: `raw ${fmtIndex(agg.raw)} → weighted ${fmtIndex(agg.weighted)}`,
    },
    { label: 'Sources contributing', value: fmtNum(rollupBySource(items).length), note: 'distinct feeds in view' },
  ];
  for (const tile of tiles) {
    const card = el('div', 'card stat');
    card.appendChild(el('div', 'label', tile.label));
    card.appendChild(el('div', 'value', tile.value));
    card.appendChild(el('div', 'delta', tile.note));
    kpis.appendChild(card);
  }
}

/* ------------------------------------------- pillars: diverging stacked bar */

function renderPillars(pillars) {
  const host = $('pillar-chart');
  clear(host);
  const rows = pillars.filter((p) => p.items > 0);
  if (!rows.length) {
    host.appendChild(el('p', 'sub', 'No pillar has scored evidence in this slice.'));
    clear($('pillar-legend'));
    clear($('pillar-table'));
    return;
  }

  const labelW = 150; const rowH = 40; const barH = 22; const padR = 46;
  const W = 760; const H = rows.length * rowH + 26;
  const plotW = W - labelW - padR;
  const center = labelW + plotW / 2;
  const half = plotW / 2;

  const chart = svg('svg', { class: 'chart', viewBox: `0 0 ${W} ${H}`, width: '100%', height: H, role: 'img' });
  chart.setAttribute('aria-label', 'Share of weighted opinion by pillar, negative left, positive right');

  chart.appendChild(svg('line', { x1: center, y1: 0, x2: center, y2: rows.length * rowH, class: 'axis' }));

  const colors = {
    negative: cssVar('--neg'), neutral: cssVar('--neutral'), positive: cssVar('--pos'),
  };
  const surface = cssVar('--surface');

  rows.forEach((row, i) => {
    const y = i * rowH + (rowH - barH) / 2;
    const neg = row.share.negative;
    const neu = row.share.neutral + row.share.mixed;
    const pos = row.share.positive;

    const name = svg('text', { x: labelW - 12, y: y + barH / 2 + 4, 'text-anchor': 'end' });
    name.textContent = row.label;
    name.setAttribute('fill', cssVar('--ink-2'));
    chart.appendChild(name);

    let x = center - (neg + neu / 2) * half;
    const segments = [
      { key: 'negative', value: neg, color: colors.negative },
      { key: 'neutral', value: neu, color: colors.neutral },
      { key: 'positive', value: pos, color: colors.positive },
    ];
    segments.forEach((seg, idx) => {
      if (seg.value <= 0) return;
      const w = seg.value * half;
      const isFirst = idx === 0 || segments.slice(0, idx).every((s) => s.value <= 0);
      const isLast = idx === segments.length - 1 || segments.slice(idx + 1).every((s) => s.value <= 0);
      const gap = isLast ? 0 : 2; // 2px surface gap between touching fills
      const path = svg('path', {
        d: roundedRect(x, y, w - gap, barH, isFirst ? 4 : 0, isLast ? 4 : 0),
        fill: seg.color,
      });
      path.style.cursor = 'pointer';
      const label = seg.key === 'neutral' ? 'neutral / mixed' : seg.key;
      path.addEventListener('pointermove', (ev) => showTip(tipBlock(row.label, [
        { color: seg.color, value: fmtPct(seg.value), name: `${label} (weighted share)` },
        { value: fmtNum(row.items), name: 'items' },
      ]), ev.clientX, ev.clientY));
      path.addEventListener('pointerleave', hideTip);
      chart.appendChild(path);
      x += w;
    });

    // Direct labels at the two ends — the light-mode contrast relief.
    if (neg > 0.02) {
      const t = svg('text', { x: center - (neg + neu / 2) * half - 8, y: y + barH / 2 + 4, 'text-anchor': 'end', class: 'value' });
      t.textContent = fmtPct(neg);
      chart.appendChild(t);
    }
    if (pos > 0.02) {
      const t = svg('text', { x: center + (pos + neu / 2) * half + 8, y: y + barH / 2 + 4, class: 'value' });
      t.textContent = fmtPct(pos);
      chart.appendChild(t);
    }
  });

  const captionY = rows.length * rowH + 18;
  for (const cap of [
    { x: center - half, anchor: 'start', text: '← more negative' },
    { x: center, anchor: 'middle', text: 'neutral' },
    { x: center + half, anchor: 'end', text: 'more positive →' },
  ]) {
    const t = svg('text', { x: cap.x, y: captionY, 'text-anchor': cap.anchor });
    t.textContent = cap.text;
    chart.appendChild(t);
  }
  host.appendChild(chart);

  legendInto($('pillar-legend'), [
    { label: 'Negative', color: colors.negative },
    { label: 'Neutral / mixed', color: colors.neutral },
    { label: 'Positive', color: colors.positive },
  ], 'box');

  const table = tableFrom(
    ['Pillar', 'Items', 'Weighted index', 'Negative', 'Mixed', 'Neutral', 'Positive'],
    rows.map((r) => [
      r.label, fmtNum(r.items), fmtIndex(r.weighted),
      fmtPct(r.share.negative), fmtPct(r.share.mixed), fmtPct(r.share.neutral), fmtPct(r.share.positive),
    ]),
    [false, true, true, true, true, true, true],
  );
  clear($('pillar-table'));
  $('pillar-table').appendChild(table);
}

/* ---------------------------------------------------------- table builder */

function tableFrom(headers, rows, numeric = []) {
  const table = el('table');
  const thead = el('thead');
  const hr = el('tr');
  headers.forEach((h, i) => {
    const th = el('th', numeric[i] ? 'num' : null, h);
    hr.appendChild(th);
  });
  thead.appendChild(hr);
  table.appendChild(thead);
  const tbody = el('tbody');
  for (const row of rows) {
    const tr = el('tr');
    row.forEach((cell, i) => {
      const td = el('td', numeric[i] ? 'num' : null);
      if (cell instanceof Node) td.appendChild(cell);
      else td.textContent = cell === null || cell === undefined ? '—' : String(cell);
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  return table;
}

function linkCell(text, href) {
  if (!href) return el('span', null, text);
  const a = el('a', null, text);
  a.href = href;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  return a;
}

function tierCell(tier) {
  const frame = frameFor(state.now);
  const meta = frame.tiers.find((t) => t.id === tier) || frame.tiers[2];
  return el('span', `tier-pill tier-${tier}`, meta.label);
}

/* ------------------------------------------------------------ trend chart */

function renderTrend() {
  const host = $('trend-chart');
  clear(host);
  const legendHost = $('trend-legend');
  const { range } = state.filters;
  const cutoff = range === 'all' ? null : new Date(state.now.getTime() - Number(range) * 86400000);

  const days = (state.trend?.days || []).filter((d) => {
    if (!cutoff) return true;
    const dt = new Date(d.date);
    return !Number.isNaN(dt.getTime()) && dt >= cutoff;
  });

  const pillars = state.data.pillars || [];
  if (days.length === 0) {
    host.appendChild(el('p', 'sub', 'No collection days recorded yet — the trend appears after the first workflow run.'));
    clear(legendHost);
    clear($('trend-table'));
    return;
  }

  const W = 760; const H = 260;
  const m = { t: 14, r: 92, b: 30, l: 38 };
  const plotW = W - m.l - m.r;
  const plotH = H - m.t - m.b;
  const times = days.map((d) => new Date(d.date).getTime());
  const tMin = Math.min(...times); const tMax = Math.max(...times);
  const xOf = (t) => (tMax === tMin ? m.l + plotW / 2 : m.l + ((t - tMin) / (tMax - tMin)) * plotW);
  const yOf = (v) => m.t + ((1 - v) / 2) * plotH;

  const chart = svg('svg', { class: 'chart', viewBox: `0 0 ${W} ${H}`, width: '100%', height: H, role: 'img' });
  chart.setAttribute('aria-label', 'Weighted sentiment by pillar over time');

  for (const tick of [1, 0.5, 0, -0.5, -1]) {
    const y = yOf(tick);
    chart.appendChild(svg('line', { x1: m.l, y1: y, x2: m.l + plotW, y2: y, class: tick === 0 ? 'axis' : 'gridline' }));
    const t = svg('text', { x: m.l - 8, y: y + 4, 'text-anchor': 'end' });
    t.textContent = (tick * 100).toFixed(0);
    chart.appendChild(t);
  }
  // Keep the first and last tick, then thin the rest until none are closer than 64px.
  const tickIdx = [];
  const MIN_TICK_PX = 64;
  for (let i = 0; i < days.length; i += 1) {
    const x = xOf(times[i]);
    const isEdge = i === 0 || i === days.length - 1;
    if (i === days.length - 1) {
      while (tickIdx.length && xOf(times[tickIdx[tickIdx.length - 1]]) > x - MIN_TICK_PX) tickIdx.pop();
      tickIdx.push(i);
    } else if (isEdge || !tickIdx.length || x - xOf(times[tickIdx[tickIdx.length - 1]]) >= MIN_TICK_PX) {
      tickIdx.push(i);
    }
  }
  for (const i of tickIdx) {
    const anchor = i === 0 ? 'start' : i === days.length - 1 ? 'end' : 'middle';
    const t = svg('text', { x: xOf(times[i]), y: H - 8, 'text-anchor': anchor });
    t.textContent = new Date(days[i].date).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    chart.appendChild(t);
  }

  const series = pillars.map((pillar) => ({
    id: pillar.id,
    label: pillar.label,
    color: cssVar(PILLAR_COLORS[pillar.id] || '--series-1'),
    points: days.map((d, i) => ({ t: times[i], v: d.byPillar?.[pillar.id] })).filter((p) => typeof p.v === 'number'),
  })).filter((s) => s.points.length > 0);

  const surface = cssVar('--surface');
  for (const s of series) {
    if (s.points.length > 1) {
      const d = s.points.map((p, i) => `${i === 0 ? 'M' : 'L'}${xOf(p.t)},${yOf(p.v)}`).join(' ');
      chart.appendChild(svg('path', {
        d, fill: 'none', stroke: s.color, 'stroke-width': 2,
        'stroke-linejoin': 'round', 'stroke-linecap': 'round',
      }));
    }
    const last = s.points[s.points.length - 1];
    chart.appendChild(svg('circle', {
      cx: xOf(last.t), cy: yOf(last.v), r: 4.5, fill: s.color, stroke: surface, 'stroke-width': 2,
    }));
  }

  // Direct end labels are mandatory at four series, but converging lines put them
  // on top of each other. Nudge them to a minimum spacing and run a leader line
  // back to each series' end dot, so a moved label still reads as attached.
  const MIN_LABEL_GAP = 13;
  const placed = series
    .map((s) => {
      const last = s.points[s.points.length - 1];
      return { s, anchorY: yOf(last.v), anchorX: xOf(last.t), y: yOf(last.v), value: last.v };
    })
    .sort((a, b) => a.anchorY - b.anchorY);
  for (let i = 1; i < placed.length; i += 1) {
    if (placed[i].y - placed[i - 1].y < MIN_LABEL_GAP) placed[i].y = placed[i - 1].y + MIN_LABEL_GAP;
  }
  const overflow = placed.length ? placed[placed.length - 1].y - (m.t + plotH) : 0;
  if (overflow > 0) for (const p of placed) p.y -= overflow;
  for (let i = placed.length - 2; i >= 0; i -= 1) {
    if (placed[i + 1].y - placed[i].y < MIN_LABEL_GAP) placed[i].y = placed[i + 1].y - MIN_LABEL_GAP;
  }
  for (const p of placed) {
    const labelX = m.l + plotW + 12;
    if (Math.abs(p.y - p.anchorY) > 1.5) {
      chart.appendChild(svg('path', {
        d: `M${p.anchorX + 6},${p.anchorY}L${labelX - 5},${p.y}`,
        stroke: p.s.color, 'stroke-width': 1, fill: 'none', opacity: 0.55,
      }));
    }
    const label = svg('text', { x: labelX, y: p.y + 4 });
    label.textContent = `${p.s.label.length > 16 ? `${p.s.label.slice(0, 15)}…` : p.s.label} ${(p.value * 100).toFixed(0)}`;
    label.setAttribute('fill', cssVar('--ink-2'));
    chart.appendChild(label);
  }

  // Crosshair: readers aim at a date, not at a 2px line.
  const crosshair = svg('line', { y1: m.t, y2: m.t + plotH, class: 'crosshair', opacity: 0 });
  chart.appendChild(crosshair);
  const hit = svg('rect', { x: m.l, y: m.t, width: plotW, height: plotH, class: 'hit' });
  chart.appendChild(hit);
  const move = (ev) => {
    const box = chart.getBoundingClientRect();
    const px = ((ev.clientX - box.left) / box.width) * W;
    let nearest = 0;
    let best = Infinity;
    times.forEach((t, i) => {
      const dist = Math.abs(xOf(t) - px);
      if (dist < best) { best = dist; nearest = i; }
    });
    const x = xOf(times[nearest]);
    crosshair.setAttribute('x1', x);
    crosshair.setAttribute('x2', x);
    crosshair.setAttribute('opacity', 1);
    const day = days[nearest];
    const rows = series
      .map((s) => ({ color: s.color, value: fmtIndex(day.byPillar?.[s.id]), name: s.label }))
      .filter((r) => r.value !== '—');
    rows.push({ value: fmtNum(day.items), name: 'items in corpus' });
    showTip(tipBlock(fmtDate(day.date), rows), ev.clientX, ev.clientY);
  };
  hit.addEventListener('pointermove', move);
  hit.addEventListener('pointerleave', () => { hideTip(); crosshair.setAttribute('opacity', 0); });
  host.appendChild(chart);

  legendInto(legendHost, series.map((s) => ({ label: s.label, color: s.color })));

  clear($('trend-table'));
  $('trend-table').appendChild(tableFrom(
    ['Date', 'Index', ...pillars.map((p) => p.label), 'Items'],
    days.slice().reverse().map((d) => [
      fmtDate(d.date), fmtIndex(d.index),
      ...pillars.map((p) => fmtIndex(d.byPillar?.[p.id])),
      fmtNum(d.items),
    ]),
    [false, true, ...pillars.map(() => true), true],
  ));
}

/** Round a maximum up to a clean 1 / 2 / 5 × 10ⁿ so axis ticks read as round numbers. */
function niceMax(value) {
  if (value <= 0) return 1;
  const exp = Math.floor(Math.log10(value));
  const base = 10 ** exp;
  for (const step of [1, 2, 2.5, 5, 10]) {
    if (value <= step * base) return step * base;
  }
  return 10 * base;
}

/* -------------------------------------------------------------- age chart */

function renderAge(items) {
  const host = $('age-chart');
  clear(host);
  const years = rollupByYear(items);
  if (!years.length) {
    host.appendChild(el('p', 'sub', 'No dated evidence in this slice.'));
    clear($('age-legend'));
    return;
  }
  const W = 420; const H = 200;
  const m = { t: 18, r: 8, b: 34, l: 34 };
  const plotW = W - m.l - m.r; const plotH = H - m.t - m.b;
  const max = niceMax(Math.max(...years.map((y) => y.items), 1));
  const band = plotW / years.length;
  const barW = Math.min(24, band - 10);

  const chart = svg('svg', { class: 'chart', viewBox: `0 0 ${W} ${H}`, width: '100%', height: H, role: 'img' });
  chart.setAttribute('aria-label', 'Corpus item count by year, coloured by recency tier');

  for (const frac of [0, 0.5, 1]) {
    const y = m.t + plotH - frac * plotH;
    chart.appendChild(svg('line', { x1: m.l, y1: y, x2: m.l + plotW, y2: y, class: frac === 0 ? 'axis' : 'gridline' }));
    const t = svg('text', { x: m.l - 8, y: y + 4, 'text-anchor': 'end' });
    t.textContent = Math.round(max * frac).toLocaleString();
    chart.appendChild(t);
  }

  years.forEach((year, i) => {
    const h = (year.items / max) * plotH;
    const x = m.l + i * band + (band - barW) / 2;
    const y = m.t + plotH - h;
    const color = cssVar(TIER_COLORS[year.tier]);
    const bar = svg('path', { d: roundedRect(x, y, barW, Math.max(h, 2), 0, 0), fill: color });
    // Square at the baseline, 4px rounded at the data end.
    bar.setAttribute('d', `M${x},${m.t + plotH}V${y + 4}a4,4 0 0 1 4,-4h${barW - 8}a4,4 0 0 1 4,4V${m.t + plotH}Z`);
    bar.style.cursor = 'pointer';
    bar.addEventListener('pointermove', (ev) => showTip(tipBlock(String(year.year), [
      { color, value: fmtNum(year.items), name: 'items' },
      { value: round(year.weight, 1).toLocaleString(), name: 'total weight carried' },
    ]), ev.clientX, ev.clientY));
    bar.addEventListener('pointerleave', hideTip);
    chart.appendChild(bar);

    const value = svg('text', { x: x + barW / 2, y: y - 6, 'text-anchor': 'middle', class: 'value' });
    value.textContent = fmtNum(year.items);
    chart.appendChild(value);

    const label = svg('text', { x: x + barW / 2, y: H - 12, 'text-anchor': 'middle' });
    label.textContent = year.year;
    chart.appendChild(label);
  });
  host.appendChild(chart);

  const frame = frameFor(state.now);
  legendInto($('age-legend'), frame.tiers.map((t) => ({
    label: `${t.label} · ${t.multiplier}`, color: cssVar(TIER_COLORS[t.id]),
  })), 'box');
}

/* ------------------------------------------------------- weighted vs raw */

function renderShift(agg) {
  const host = $('shift-panel');
  clear(host);
  if (agg.weighted === null || agg.raw === null) {
    host.appendChild(el('p', 'sub', 'Not enough scored evidence to compare.'));
    return;
  }
  const W = 420; const H = 120;
  const m = { l: 20, r: 20 };
  const plotW = W - m.l - m.r;
  const xOf = (v) => m.l + ((v + 1) / 2) * plotW;
  const y = 52;
  const chart = svg('svg', { class: 'chart', viewBox: `0 0 ${W} ${H}`, width: '100%', height: H, role: 'img' });
  chart.setAttribute('aria-label', `Raw index ${fmtIndex(agg.raw)} versus weighted index ${fmtIndex(agg.weighted)}`);

  chart.appendChild(svg('line', { x1: m.l, y1: y, x2: m.l + plotW, y2: y, class: 'gridline' }));
  chart.appendChild(svg('line', { x1: xOf(0), y1: y - 14, x2: xOf(0), y2: y + 14, class: 'axis' }));

  const light = cssVar('--tier-legacy');
  const dark = cssVar('--tier-current');
  const surface = cssVar('--surface');
  chart.appendChild(svg('line', {
    x1: xOf(agg.raw), y1: y, x2: xOf(agg.weighted), y2: y, stroke: dark, 'stroke-width': 2, 'stroke-linecap': 'round',
  }));
  for (const point of [
    { v: agg.raw, color: light, name: 'Unweighted average', anchor: 'raw' },
    { v: agg.weighted, color: dark, name: 'Recency weighted', anchor: 'weighted' },
  ]) {
    const dot = svg('circle', { cx: xOf(point.v), cy: y, r: 7, fill: point.color, stroke: surface, 'stroke-width': 2 });
    dot.style.cursor = 'pointer';
    dot.addEventListener('pointermove', (ev) => showTip(tipBlock(point.name, [
      { color: point.color, value: fmtIndex(point.v), name: 'index' },
    ]), ev.clientX, ev.clientY));
    dot.addEventListener('pointerleave', hideTip);
    chart.appendChild(dot);
    const label = svg('text', {
      x: xOf(point.v), y: point.anchor === 'raw' ? y - 18 : y + 26, 'text-anchor': 'middle', class: 'value',
    });
    label.textContent = `${point.name} ${fmtIndex(point.v)}`;
    chart.appendChild(label);
  }
  const scaleL = svg('text', { x: m.l, y: H - 6 });
  scaleL.textContent = '−100';
  const scaleR = svg('text', { x: m.l + plotW, y: H - 6, 'text-anchor': 'end' });
  scaleR.textContent = '+100';
  chart.appendChild(scaleL);
  chart.appendChild(scaleR);
  host.appendChild(chart);

  const delta = agg.weighted - agg.raw;
  const note = el('p', 'sub');
  note.textContent = Math.abs(delta) < 0.02
    ? 'Weighting barely moves this slice — the corpus is already recent.'
    : `Recency weighting moves the reading ${delta > 0 ? 'up' : 'down'} by `
      + `${Math.abs(delta * 100).toFixed(0)} points. Older material was pulling the raw average `
      + `${delta > 0 ? 'down' : 'up'}.`;
  host.appendChild(note);
}

/* ------------------------------------------------------------ themes */

function renderThemes(items) {
  for (const [hostId, direction] of [['concerns', 'concerns'], ['praise', 'praise']]) {
    const host = $(hostId);
    clear(host);
    const themes = rollupThemes(items, direction);
    if (!themes.length) {
      host.appendChild(el('p', 'sub', 'Nothing in this slice yet.'));
      continue;
    }
    const rows = themes.map((t) => {
      const cell = el('div');
      cell.appendChild(el('div', null, t.theme));
      for (const ex of t.examples) {
        const line = el('div', 'quote');
        line.appendChild(document.createTextNode('“'));
        line.appendChild(linkCell(ex.quote, ex.url));
        line.appendChild(document.createTextNode(`” — ${ex.source}, ${fmtDate(ex.date)}`));
        cell.appendChild(line);
      }
      return [cell, fmtNum(t.items), round(t.weight, 1).toLocaleString(), fmtIndex(t.score)];
    });
    host.appendChild(tableFrom(['Theme', 'Items', 'Weight', 'Score'], rows, [false, true, true, true]));
  }
}

/* ---------------------------------------------------------- evidence */

function renderEvidence(items) {
  const host = $('evidence');
  clear(host);
  if (!items.length) {
    host.appendChild(el('p', 'sub', 'No evidence matches these filters.'));
    return;
  }
  const rows = items.slice(0, 300).map((item) => {
    const what = el('div');
    what.appendChild(linkCell(item.title || item.theme || '(untitled)', item.url));
    if (item.quote) what.appendChild(el('div', 'quote', `“${item.quote}”`));
    const w = explainWeight(item.date, state.now);
    return [
      fmtDate(item.date),
      tierCell(w.tier),
      item.source,
      what,
      (item.pillars || []).join(', ') || '—',
      fmtIndex(item.sentiment),
      w.weight.toFixed(2),
      item.engine === 'claude' ? 'Claude' : 'heuristic',
    ];
  });
  host.appendChild(tableFrom(
    ['Date', 'Tier', 'Source', 'Item', 'Pillars', 'Score', 'Weight', 'Scored by'],
    rows,
    [false, false, false, false, false, true, true, false],
  ));
  if (items.length > 300) {
    host.appendChild(el('p', 'sub', `Showing the 300 most recent of ${fmtNum(items.length)} matching items.`));
  }
}

function renderSources(items) {
  const host = $('sources');
  clear(host);
  const rows = rollupBySource(items);
  const runs = state.data.run?.sources || [];
  const statusOf = (label) => {
    const hit = runs.find((r) => r.id === label || label.toLowerCase().includes(r.id));
    return hit ? hit.status : '—';
  };
  if (!rows.length) {
    host.appendChild(el('p', 'sub', 'No sources have contributed evidence in this slice.'));
  } else {
    host.appendChild(tableFrom(
      ['Source', 'Items', 'Weighted index', 'Last run'],
      rows.map((r) => [r.source, fmtNum(r.items), fmtIndex(r.weighted), statusOf(r.source)]),
      [false, true, true, false],
    ));
  }
  if (runs.length) {
    const failed = runs.filter((r) => r.status === 'error' || r.status === 'partial');
    if (failed.length) {
      const warn = el('p', 'sub');
      warn.textContent = `Last run had problems with: ${failed.map((f) => `${f.id} (${f.status})`).join(', ')}.`;
      host.appendChild(warn);
    }
  }
}

/* -------------------------------------------------------------- footer */

function renderFooter() {
  const host = $('footer');
  clear(host);
  const prose = describePolicy(state.now);
  const lines = [
    ['Method. ', 'Public posts and comments are collected daily, filtered to SAP + AI, then each item is '
      + 'scored for sentiment, voice, pillar and theme. Only practitioner voices move the headline index; '
      + 'vendor and press items are tracked separately.'],
    ['Weighting. ', `${prose.headline}. ${prose.freshness} ${prose.rollover}`],
    ['Honesty. ', 'Every number here is computed from collected items. Nothing is estimated, interpolated '
      + 'or filled in. An empty panel means no evidence, not a rendering failure.'],
  ];
  for (const [strong, rest] of lines) {
    const p = el('p');
    p.appendChild(el('strong', null, strong));
    p.appendChild(document.createTextNode(rest));
    host.appendChild(p);
  }
  const engine = state.data?.engine;
  if (engine === 'heuristic' || engine === 'mixed') {
    const p = el('p');
    p.appendChild(el('strong', null, 'Caveat. '));
    p.appendChild(document.createTextNode(
      engine === 'heuristic'
        ? 'These scores come from a keyword lexicon, not a language model. Treat direction as indicative '
          + 'and read the evidence table before drawing conclusions. Set ANTHROPIC_API_KEY to upgrade.'
        : 'Some batches fell back to the keyword lexicon. The "Scored by" column in the evidence table '
          + 'shows which rows that affected.',
    ));
    host.appendChild(p);
  }
}

/* ---------------------------------------------------------------- render */

function renderAll() {
  const items = visibleItems();
  const agg = rollup(items);
  $('f-count').textContent = `${fmtNum(items.length)} of ${fmtNum((state.data.items || []).length)} items`;
  renderHero(agg, items);
  renderPillars(rollupByPillar(items));
  renderTrend();
  renderAge(items);
  renderShift(agg);
  renderThemes(items);
  renderEvidence(items);
  renderSources(items);
}

/* ------------------------------------------------------------------ boot */

function wireFilters() {
  const map = { 'f-range': 'range', 'f-pillar': 'pillar', 'f-source': 'source', 'f-tier': 'tier' };
  for (const [id, key] of Object.entries(map)) {
    $(id).addEventListener('change', (ev) => {
      state.filters[key] = ev.target.value;
      renderAll();
    });
  }
  let timer;
  $('f-text').addEventListener('input', (ev) => {
    clearTimeout(timer);
    const value = ev.target.value;
    timer = setTimeout(() => { state.filters.text = value; renderAll(); }, 180);
  });
}

function populateFilters() {
  const pillarSelect = $('f-pillar');
  for (const pillar of state.data.pillars || []) {
    const opt = el('option', null, pillar.label);
    opt.value = pillar.id;
    pillarSelect.appendChild(opt);
  }
  const sourceSelect = $('f-source');
  const sources = [...new Set((state.data.items || []).map((i) => i.source))].sort();
  for (const source of sources) {
    const opt = el('option', null, source);
    opt.value = source;
    sourceSelect.appendChild(opt);
  }
}

function wireTheme() {
  const button = $('theme-toggle');
  const media = window.matchMedia('(prefers-color-scheme: dark)');
  const read = () => {
    try { return localStorage.getItem('sap-radar-theme'); } catch { return null; }
  };

  /**
   * Only pin data-theme when the reader has actually chosen one. Left unset, the
   * stylesheet's prefers-color-scheme block governs — so the OS setting keeps
   * working, and a mid-session OS switch repaints instead of going stale.
   */
  const apply = () => {
    const choice = read();
    if (choice === 'dark' || choice === 'light') {
      document.documentElement.setAttribute('data-theme', choice);
    } else {
      document.documentElement.removeAttribute('data-theme');
    }
    const dark = choice ? choice === 'dark' : media.matches;
    button.textContent = dark ? 'Light' : 'Dark';
    return dark;
  };

  let dark = apply();

  button.addEventListener('click', () => {
    dark = !dark;
    try { localStorage.setItem('sap-radar-theme', dark ? 'dark' : 'light'); } catch { /* private mode */ }
    apply();
    // SVG fills are attribute values baked at render time, so a theme change
    // has to re-run the charts to pick up the new custom properties.
    if (state.data) renderAll();
  });

  media.addEventListener('change', () => {
    if (read()) return;           // an explicit choice outranks the OS
    dark = apply();
    if (state.data) renderAll();
  });
}

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
  renderPolicy();

  state.data = await loadJson('./data/dashboard.json', null);
  state.trend = await loadJson('./data/trend.json', { days: [] });

  const hasEvidence = Boolean(state.data && (state.data.items || []).length);
  $('chip-updated').textContent = state.data?.generatedAt
    ? `Updated ${fmtDate(state.data.generatedAt)}`
    : 'Never collected';

  const engineChip = $('chip-engine');
  if (state.data?.engine && state.data.engine !== 'unknown') {
    const dot = el('span', 'dot');
    dot.style.background = state.data.engine === 'claude' ? cssVar('--good') : cssVar('--warning');
    engineChip.appendChild(dot);
    engineChip.appendChild(el('span', null,
      state.data.engine === 'claude' ? 'Scored by Claude' : `Scored: ${state.data.engine}`));
  } else {
    engineChip.hidden = true;
  }

  renderFooter();

  if (!hasEvidence) {
    $('empty').hidden = false;
    $('dash').hidden = true;
    return;
  }
  $('empty').hidden = true;
  $('dash').hidden = false;
  populateFilters();
  wireFilters();
  renderAll();
}

boot();
