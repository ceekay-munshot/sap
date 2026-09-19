#!/usr/bin/env node
/**
 * Offline checks — no network, no API key. Covers the two things that would
 * silently corrupt the dashboard: the recency policy rolling over, and the
 * research parser accepting a malformed payload.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { extractJson, normalise } from './lib/research.mjs';
import { frameFor, weightFor, tierFor, explainWeight } from '../web/lib/recency.mjs';

const NOW = new Date('2026-09-19T00:00:00Z');

/* ── the weighting rolls over by itself ─────────────────────────────────── */
assert.equal(frameFor(NOW).tiers[0].label, '2026');
assert.equal(frameFor(NOW).tiers[2].label, 'pre-2025');
assert.equal(frameFor(new Date('2027-01-02Z')).tiers[0].label, '2027');
assert.equal(frameFor(new Date('2027-01-02Z')).tiers[2].label, 'pre-2026');
assert.equal(frameFor(new Date('2031-06-02Z')).tiers[2].label, 'pre-2030');

/* ── recent evidence must dominate legacy evidence ──────────────────────── */
const fresh = weightFor('2026-09-10T00:00:00Z', NOW);
const legacy = weightFor('2023-04-02T00:00:00Z', NOW);
assert.equal(fresh, 4.05, 'current year + 90-day boost');
assert.equal(legacy, 0.25, 'legacy floor');
assert.ok(fresh / legacy > 15, `recent must outweigh legacy (got ${fresh / legacy}:1)`);
assert.equal(tierFor(null, NOW), 'legacy', 'undated is treated as legacy, never guessed');
assert.equal(explainWeight('2025-06-01', NOW).tier, 'prior');

/* ── the parser survives what models actually return ────────────────────── */
const messy = 'Here is the analysis:\n```json\n'
  + JSON.stringify({
    score: '3.7',
    sub: { adoption: 9, maturity: 2.4, satisfaction: 0.2, competitive: 3 },
    recencyMix: { current: 6, prior: 3, legacy: 1 },
    summary: 'Mixed.',
    findings: ['a', '', 'b'],
    quotes: [
      { text: 'too short' },
      { text: 'x'.repeat(40), name: 'A B', date: '2026-01-02', url: 'https://e.test' },
    ],
    sources: [{ url: 'https://e.test' }, { nothing: true }],
  })
  + '\n```\nHope that helps.';

const topic = { id: 't', label: 'L', icon: '🤖', category: 'product' };
const out = normalise(extractJson(messy), topic, NOW);
assert.equal(out.score, 3.7, 'string score coerced');
assert.equal(out.sub.adoption, 5, 'out-of-range clamped to the 1-5 scale');
assert.equal(out.sub.satisfaction, 1, 'below-range clamped');
assert.equal(out.quotes.length, 1, 'quotes under 20 chars dropped');
assert.equal(out.findings.length, 2, 'empty findings dropped');
assert.equal(out.sources.length, 1, 'sources without url or title dropped');
assert.equal(out.id, 't');

assert.throws(() => normalise({ sub: {} }, topic, NOW), /missing overall score/,
  'a payload with no score must fail loudly, not render as zero');
assert.throws(() => extractJson('no json here'), /no JSON object/);

/* ── the shipped scaffold must not carry invented numbers ───────────────── */
const shipped = JSON.parse(fs.readFileSync('web/data/dashboard.json', 'utf8'));
assert.equal(Object.keys(shipped.topics || {}).length === 0 || shipped.generatedAt !== null, true,
  'a scaffold with topics must also carry a real generatedAt');

/* ── the page and the collector read the same topic list ────────────────── */
const config = JSON.parse(fs.readFileSync('config/topics.json', 'utf8')).topics;
const web = JSON.parse(fs.readFileSync('web/data/topics.json', 'utf8')).topics;
assert.equal(config.length, 9, 'nine topics');
assert.deepEqual(config.map((t) => t.id), web.map((t) => t.id),
  'web/data/topics.json is out of sync with config/topics.json');

console.log('selftest passed');
console.log(`  ${frameFor(NOW).tiers.map((t) => t.badge).join('  |  ')}`);
console.log(`  recent ${fresh}× vs legacy ${legacy}× = ${(fresh / legacy).toFixed(0)}:1`);
console.log(`  ${config.length} topics in sync between config and web`);
