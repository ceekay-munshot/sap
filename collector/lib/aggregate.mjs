import {
  frameFor, tierFor, weightFor, explainWeight, weightedMean, rawMean, describePolicy, round,
} from '../../web/lib/recency.mjs';
import { PILLARS, TAGS } from './taxonomy.mjs';

const STANCES = ['positive', 'mixed', 'neutral', 'negative'];

/** The headline index is the practitioner view. Vendor copy never moves it. */
const isPractitioner = (r) => r.voice === 'practitioner' || r.voice === 'unknown';

function distribution(rows, now) {
  const weight = Object.fromEntries(STANCES.map((s) => [s, 0]));
  const count = Object.fromEntries(STANCES.map((s) => [s, 0]));
  let total = 0;
  for (const row of rows) {
    const stance = STANCES.includes(row.stance) ? row.stance : 'neutral';
    const w = weightFor(row.date, now);
    weight[stance] += w;
    count[stance] += 1;
    total += w;
  }
  const share = Object.fromEntries(
    STANCES.map((s) => [s, total === 0 ? 0 : round(weight[s] / total, 4)]),
  );
  return { count, weight: Object.fromEntries(STANCES.map((s) => [s, round(weight[s], 3)])), share, totalWeight: round(total, 3) };
}

function scoreGroup(rows, now) {
  const weighted = weightedMean(rows.map((r) => ({ score: r.sentiment, date: r.date })), now);
  const raw = rawMean(rows.map((r) => ({ score: r.sentiment })));
  return {
    items: rows.length,
    weighted,
    raw,
    shift: weighted === null || raw === null ? null : round(weighted - raw, 4),
    dist: distribution(rows, now),
  };
}

function themeRoll(rows, now, direction) {
  const wanted = direction === 'praise'
    ? (r) => r.sentiment >= 0.25
    : (r) => r.sentiment <= -0.25;
  const buckets = new Map();
  for (const row of rows) {
    if (!wanted(row)) continue;
    const key = (row.theme || '').trim().toLowerCase();
    if (!key) continue;
    const bucket = buckets.get(key) || {
      theme: row.theme.trim(), items: 0, weight: 0, scoreSum: 0, examples: [],
    };
    const w = weightFor(row.date, now);
    bucket.items += 1;
    bucket.weight += w;
    bucket.scoreSum += row.sentiment * w;
    if (bucket.examples.length < 3 && row.quote) {
      bucket.examples.push({
        quote: row.quote, url: row.url, date: row.date,
        source: row.sourceLabel, tier: tierFor(row.date, now),
      });
    }
    buckets.set(key, bucket);
  }
  return [...buckets.values()]
    .map((b) => ({
      theme: b.theme,
      items: b.items,
      weight: round(b.weight, 3),
      score: round(b.scoreSum / b.weight, 3),
      examples: b.examples,
    }))
    .sort((a, b) => b.weight - a.weight)
    .slice(0, 8);
}

export function aggregate(rows, { now = new Date(), engine = 'unknown', runReport = {} } = {}) {
  const frame = frameFor(now);
  const scored = rows.filter((r) => typeof r.sentiment === 'number');
  const practitioners = scored.filter(isPractitioner);

  const byYear = {};
  for (const row of scored) {
    const year = row.date ? new Date(row.date).getUTCFullYear() : null;
    const key = Number.isFinite(year) ? String(year) : 'undated';
    byYear[key] = byYear[key] || { year: key, items: 0, tier: tierFor(row.date, now), weight: 0 };
    byYear[key].items += 1;
    byYear[key].weight = round(byYear[key].weight + weightFor(row.date, now), 3);
  }

  const byTier = { current: 0, prior: 0, legacy: 0 };
  for (const row of scored) byTier[tierFor(row.date, now)] += 1;

  const bySource = new Map();
  for (const row of scored) {
    const key = row.sourceLabel || row.source;
    const bucket = bySource.get(key) || { source: key, engine: row.source, rows: [] };
    bucket.rows.push(row);
    bySource.set(key, bucket);
  }

  const byVoice = {};
  for (const voice of ['practitioner', 'press', 'vendor', 'unknown']) {
    const subset = scored.filter((r) => r.voice === voice);
    if (subset.length) byVoice[voice] = scoreGroup(subset, now);
  }

  return {
    generatedAt: now.toISOString(),
    engine,
    policy: { frame, prose: describePolicy(now) },
    headline: scoreGroup(practitioners, now),
    corpus: {
      total: rows.length,
      scored: scored.length,
      practitioners: practitioners.length,
      byTier,
      byYear: Object.values(byYear).sort((a, b) => String(a.year).localeCompare(String(b.year))),
      currentYearShare: scored.length ? round(byTier.current / scored.length, 4) : 0,
    },
    pillars: PILLARS.map((pillar) => {
      const subset = practitioners.filter((r) => (r.pillars || []).includes(pillar.id));
      return { id: pillar.id, label: pillar.label, blurb: pillar.blurb, ...scoreGroup(subset, now) };
    }),
    tags: TAGS.map((tag) => {
      const subset = practitioners.filter((r) => (r.tags || []).includes(tag.id));
      return { id: tag.id, label: tag.label, ...scoreGroup(subset, now) };
    }),
    voices: byVoice,
    sources: [...bySource.values()]
      .map((b) => ({ source: b.source, ...scoreGroup(b.rows, now) }))
      .sort((a, b) => b.items - a.items),
    themes: {
      praise: themeRoll(practitioners, now, 'praise'),
      concerns: themeRoll(practitioners, now, 'concerns'),
    },
    run: runReport,
    items: [...practitioners]
      .sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0))
      .slice(0, 500)
      .map((r) => ({
        id: r.id,
        date: r.date,
        source: r.sourceLabel,
        kind: r.kind,
        author: r.author,
        title: r.title,
        quote: r.quote || '',
        theme: r.theme || '',
        url: r.url,
        sentiment: r.sentiment,
        stance: r.stance,
        pillars: r.pillars || [],
        tags: r.tags || [],
        confidence: r.confidence,
        engine: r.engine,
        ...explainWeight(r.date, now),
      })),
  };
}

/** One row per run day, so the dashboard can draw a real trend. */
export function appendTrend(trend, snapshot, { now = new Date() } = {}) {
  const day = now.toISOString().slice(0, 10);
  const row = {
    date: day,
    index: snapshot.headline.weighted,
    raw: snapshot.headline.raw,
    items: snapshot.corpus.scored,
    practitioners: snapshot.corpus.practitioners,
    currentYearShare: snapshot.corpus.currentYearShare,
    byPillar: Object.fromEntries(snapshot.pillars.map((p) => [p.id, p.weighted])),
  };
  const days = (trend?.days || []).filter((d) => d.date !== day);
  days.push(row);
  days.sort((a, b) => a.date.localeCompare(b.date));
  return { updatedAt: now.toISOString(), days };
}
