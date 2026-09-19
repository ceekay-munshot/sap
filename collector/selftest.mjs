#!/usr/bin/env node
/**
 * Offline pipeline check. Runs the taxonomy → heuristic classifier → aggregate →
 * trend path over synthetic fixtures and asserts the recency weighting actually
 * bites. Writes nothing to web/data — fixtures must never reach the dashboard.
 */
import assert from 'node:assert/strict';
import { classifyHeuristic } from './lib/classify.mjs';
import { aggregate, appendTrend } from './lib/aggregate.mjs';
import { frameFor, weightFor } from '../web/lib/recency.mjs';

const NOW = new Date('2026-09-19T00:00:00Z');

const fixtures = [
  { id: 'f1', source: 'reddit', sourceLabel: 'r/SAP', kind: 'comment', date: '2023-04-02T00:00:00Z',
    title: '', text: 'SAP AI is vaporware, the Joule demo was terrible and overpriced', engagement: 5 },
  { id: 'f2', source: 'reddit', sourceLabel: 'r/SAP', kind: 'comment', date: '2024-02-02T00:00:00Z',
    title: '', text: 'Joule is half-baked and clunky on S/4HANA, useless for real work', engagement: 3 },
  { id: 'f3', source: 'hackernews', sourceLabel: 'Hacker News', kind: 'comment', date: '2026-08-20T00:00:00Z',
    title: '', text: 'Business Data Cloud finally delivers, zero copy to Databricks works well and saves us weeks', engagement: 40 },
  { id: 'f4', source: 'hackernews', sourceLabel: 'Hacker News', kind: 'comment', date: '2026-09-10T00:00:00Z',
    title: '', text: 'The accounts payable agent is impressive, straight-through processing is solid', engagement: 12 },
  { id: 'f5', source: 'rss', sourceLabel: 'SAP News Center', kind: 'article', stance: 'vendor',
    date: '2026-09-01T00:00:00Z', title: 'SAP announces Joule agents', text: 'SAP today announced new AI agents for S/4HANA.' },
];

const rows = classifyHeuristic(fixtures);
const snapshot = aggregate(rows, { now: NOW, engine: 'heuristic' });

const frame = frameFor(NOW);
assert.equal(frame.currentYear, 2026);
assert.equal(frame.tiers[2].label, 'pre-2025', 'legacy label must roll with the year');

// The 2023 comment must be worth a fraction of the fresh ones.
assert.ok(weightFor('2026-09-10T00:00:00Z', NOW) / weightFor('2023-04-02T00:00:00Z', NOW) > 15,
  'recent items must dominate legacy ones');

// Vendor copy must not reach the practitioner headline.
assert.equal(snapshot.corpus.practitioners, 4, 'vendor article must be excluded from practitioner set');
assert.ok(snapshot.voices.vendor, 'vendor voice still tracked separately');

// The whole point: weighting must pull the index up off the 2023/24 negativity.
assert.ok(snapshot.headline.weighted > snapshot.headline.raw,
  `weighting should lift the index (weighted ${snapshot.headline.weighted} vs raw ${snapshot.headline.raw})`);

// byTier describes the whole corpus, vendor copy included (3 items dated 2026);
// the practitioner cut is tracked separately above.
assert.equal(snapshot.corpus.byTier.legacy, 2);
assert.equal(snapshot.corpus.byTier.current, 3);
assert.equal(snapshot.corpus.byTier.prior, 0);

const trend = appendTrend({ days: [] }, snapshot, { now: NOW });
assert.equal(trend.days.length, 1);
const again = appendTrend(trend, snapshot, { now: NOW });
assert.equal(again.days.length, 1, 'same-day reruns must replace, not duplicate');

const bdc = snapshot.pillars.find((p) => p.id === 'bdc');
assert.ok(bdc.items >= 1, 'BDC pillar should catch the Business Data Cloud comment');

console.log('selftest passed');
console.log(`  weighted ${snapshot.headline.weighted}  vs  raw ${snapshot.headline.raw}`
  + `  (shift ${snapshot.headline.shift})`);
console.log(`  tiers: ${JSON.stringify(snapshot.corpus.byTier)}`);
console.log(`  policy: ${snapshot.policy.prose.headline}`);
