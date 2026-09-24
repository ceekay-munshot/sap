#!/usr/bin/env node
/**
 * Offline checks — no network, no API key. Covers the two things that would
 * silently corrupt the dashboard: the recency policy rolling over, and the
 * research parser accepting a malformed payload.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { extractJson, normalise, cleanText, cleanUrl, buildPack, validateScore, validateConfidence } from './lib/research.mjs';
import { quoteAppearsIn, verifyQuotes } from './lib/verify.mjs';
import { rollupTopic, appendDay } from './track.mjs';
import { topicsFor, toFiveScale } from './lib/topicmatch.mjs';
import { frameFor, weightFor, tierFor, explainWeight } from '../web/lib/recency.mjs';

const NOW = new Date('2026-09-19T00:00:00Z');

/* ── the weighting rolls over by itself ─────────────────────────────────── */
assert.equal(frameFor(NOW).tiers[0].label, '2026');
assert.equal(frameFor(NOW).tiers[2].label, 'pre-2025');
assert.equal(frameFor(new Date('2027-01-02Z')).tiers[0].label, '2027');
assert.equal(frameFor(new Date('2027-01-02Z')).tiers[2].label, 'pre-2026');
assert.equal(frameFor(new Date('2031-06-02Z')).tiers[2].label, 'pre-2030');

/* ── recent evidence must dominate legacy evidence ──────────────────────── */
const fresh = weightFor('2026-09-10T00:00:00Z', NOW);      // 9 days old
const twoMonths = weightFor('2026-07-26T00:00:00Z', NOW);   // 55 days old
const june = weightFor('2026-06-05T00:00:00Z', NOW);        // ~106 days old
const legacy = weightFor('2023-04-02T00:00:00Z', NOW);
assert.equal(fresh, 7.5, 'current year x last-30-days boost');
assert.equal(legacy, 0.25, 'legacy floor');
assert.ok(fresh / legacy > 25, `recent must dominate legacy (got ${fresh / legacy}:1)`);
// What a customer cares about is this month and last, so the last two months
// must clearly outweigh anything older within the same year.
assert.ok(twoMonths > june, 'inside 60 days must beat June');
assert.ok(fresh / june > 2, `this month must beat June by more than 2:1 (got ${(fresh / june).toFixed(1)}:1)`);
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
assert.equal(out.score, 3.7, 'valid string score coerced to number');
assert.equal(out.sub.maturity, 2.4, 'valid in-range subscore kept');
assert.equal(out.sub.competitive, 3, 'valid in-range integer subscore kept');
assert.equal(out.sub.adoption, undefined, 'out-of-range subscore (>5.0) rejected and omitted');
assert.equal(out.sub.satisfaction, undefined, 'below-range subscore (<1.0) rejected and omitted');
assert.equal(out.quotes.length, 1, 'quotes under 20 chars dropped');
assert.equal(out.findings.length, 2, 'empty findings dropped');
assert.equal(out.sources.length, 0,
  'with no fetched pages there are no sources — the model cannot supply them');
assert.equal(out.id, 't');

/* ── strict score & confidence unit tests (F05) ─────────────────────────── */
assert.equal(validateScore(null), null, 'null is never coerced to a score');
assert.equal(validateScore(false), null, 'false is never coerced to a score');
assert.equal(validateScore(true), null, 'true is never coerced to a score');
assert.equal(validateScore(''), null, 'empty string is never coerced to a score');
assert.equal(validateScore('   '), null, 'blank string is never coerced to a score');
assert.equal(validateScore(0), null, '0 is out of range and rejected');
assert.equal(validateScore(-1), null, 'negative score is rejected');
assert.equal(validateScore(0.9), null, '<1.0 is rejected');
assert.equal(validateScore(1.0), 1.0, 'boundary 1.0 is valid');
assert.equal(validateScore(5.0), 5.0, 'boundary 5.0 is valid');
assert.equal(validateScore(5.1), null, '>5.0 is rejected');
assert.equal(validateScore(9), null, '9 is rejected');

assert.equal(validateConfidence(0), 0, 'confidence 0 is valid and retained');
assert.equal(validateConfidence(0.55), 0.55, 'confidence in range retained');
assert.equal(validateConfidence(1.0), 1.0, 'confidence 1.0 retained');
assert.equal(validateConfidence(null), null, 'null confidence is null');
assert.equal(validateConfidence(false), null, 'false confidence is null');
assert.equal(validateConfidence(-0.1), null, 'negative confidence rejected');
assert.equal(validateConfidence(1.1), null, '>1.0 confidence rejected');

assert.throws(() => normalise({ sub: {} }, topic, NOW), /missing or invalid overall score/,
  'a payload with no score must fail loudly, not render as zero');
assert.throws(() => normalise({ score: null }, topic, NOW), /missing or invalid overall score/,
  'null score must throw');
assert.throws(() => normalise({ score: false }, topic, NOW), /missing or invalid overall score/,
  'false score must throw');
assert.throws(() => normalise({ score: '' }, topic, NOW), /missing or invalid overall score/,
  'empty score must throw');
assert.throws(() => normalise({ score: 0 }, topic, NOW), /missing or invalid overall score/,
  '0 score must throw');
assert.throws(() => normalise({ score: 6 }, topic, NOW), /missing or invalid overall score/,
  'out of range score must throw');
assert.throws(() => extractJson('no json here'), /no JSON object/);

/* ── the free tracker: weighting must bite, reruns must not stack ───────── */
assert.deepEqual(toFiveScale(-1), 1);
assert.deepEqual(toFiveScale(0), 3);
assert.deepEqual(toFiveScale(1), 5);

const tracked = rollupTopic([
  { sentiment: 0.8, stance: 'positive', date: '2026-09-10T00:00:00Z' },
  { sentiment: -0.9, stance: 'negative', date: '2023-05-10T00:00:00Z' },
], NOW);
assert.ok(tracked.score > 4,
  `one furious 2023 post must not sink a positive current-year reading (got ${tracked.score})`);
assert.equal(tracked.tiers.legacy, 1);
assert.equal(rollupTopic([], NOW), null, 'no items must yield no point, never a zero');

// The bars are counts of posts, not weights: one each way however old, a
// hedged post is neutral, and SAP's own post is read but never counted.
const counted = rollupTopic([
  { sentiment: 0.8, stance: 'positive', date: '2026-09-10T00:00:00Z' },
  { sentiment: -0.9, stance: 'negative', date: '2023-05-10T00:00:00Z' },
  { sentiment: 0, stance: 'mixed', date: '2026-09-11T00:00:00Z' },
  { sentiment: 0, stance: 'neutral', date: '2026-09-12T00:00:00Z' },
  { sentiment: 0.7, stance: 'positive', voice: 'vendor', date: '2026-09-12T00:00:00Z' },
], NOW);
assert.deepEqual(counted.counts, { positive: 1, negative: 1, neutral: 2 });
assert.equal(counted.counts.positive + counted.counts.negative + counted.counts.neutral,
  counted.items - counted.vendorItems, 'the counts must add up to every item that counts');

let trend = appendDay({ days: [] }, '2026-09-19', { overall: tracked });
trend = appendDay(trend, '2026-09-19', { overall: tracked });
assert.equal(trend.days.length, 1, 'a same-day rerun replaces the point');

const buckets = topicsFor('Joule on S/4HANA is fine but Accenture oversold the agent story');
assert.ok(buckets.includes('joule_sentiment') && buckets.includes('partner_views'),
  'an item can count for several topics');
assert.deepEqual(topicsFor('unrelated gardening post'), [], 'no false buckets');

/* ── output must reach the page as plain prose with real links ──────────── */
assert.equal(cleanText('- **CURRENT (Q1 2026)** — Joule is useful.\n--- '),
  'CURRENT (Q1 2026) — Joule is useful.', 'markdown must be stripped, not rendered');
assert.equal(cleanText('## Heading\n- one\n* two'), 'Heading one two');
assert.equal(cleanUrl('https://community.sap.com/t5/x/1'), 'https://community.sap.com/t5/x/1');
assert.equal(cleanUrl('javascript:alert(1)'), '', 'only http(s) survives');
assert.equal(cleanUrl('https://example.invalid/a'), '', 'placeholder hosts rejected');
assert.equal(cleanUrl('notaurl'), '', 'a non-url is dropped rather than rendered');

const PAGES = [
  { url: 'https://community.sap.com/a', title: 'SAP Community thread',
    markdown: 'We piloted the accounts payable agent for four months and it handles the clean '
      + 'invoices fine, but every exception still lands on a human desk.' },
  { url: 'https://diginomica.com/b', title: 'Diginomica', markdown: 'Analysis of SAP AI adoption.' },
];

const dirty = normalise({
  score: 3,
  sub: {},
  summary: '**Bold** claim --- here',
  findings: ['- a finding', '**another**'],
  quotes: [{ text: 'x'.repeat(40), name: '**Anna**', sourceIndex: 1 }],
  sources: [{ title: 'model invented this', url: 'https://not-fetched.example.com/a' }],
}, topic, NOW, PAGES);
assert.equal(dirty.summary, 'Bold claim here');
assert.deepEqual(dirty.findings, ['a finding', 'another']);
assert.equal(dirty.quotes[0].name, 'Anna');
assert.equal(dirty.quotes[0].url, '', 'the model never supplies a link');
assert.equal(dirty.quotes[0].sourceIndex, 1, 'the cited page number is kept for verification');
assert.deepEqual(dirty.sources.map((x) => x.url),
  ['https://community.sap.com/a', 'https://diginomica.com/b'],
  'sources are the pages actually fetched, not anything the model typed');

/* ── a quote that is not in the fetched pages must not survive (F06) ────── */
const { kept, rejected } = verifyQuotes([
  { text: 'handles the clean invoices fine, but every exception still lands on a human desk', sourceIndex: 0 },
  { text: 'Joule has completely transformed our finance organisation beyond recognition', sourceIndex: 0 },
], PAGES);
assert.equal(kept.length, 1, 'only the real quote survives');
assert.equal(rejected.length, 1, 'the fabricated one is dropped, not flagged');
assert.equal(kept[0].url, 'https://community.sap.com/a', 'the link comes from the page it was found in');
assert.ok(quoteAppearsIn('handles the clean invoices fine, but every exception still lands', PAGES[0].markdown),
  'punctuation differences must not fail a real quote');

// F06: A genuine opening followed by invented claims must fail
const partialInvented = 'We piloted the accounts payable agent for four months and it caused massive losses';
assert.equal(quoteAppearsIn(partialInvented, PAGES[0].markdown), false,
  'genuine opening followed by invented claims must be rejected');

// F06: Ellipsis in order must pass
const ellipsisValid = 'piloted the accounts payable agent ... clean invoices fine ... human desk';
assert.equal(quoteAppearsIn(ellipsisValid, PAGES[0].markdown), true,
  'ellipsis-separated spans in source order must match');

// F06: Ellipsis out of source order must fail
const ellipsisOutOfOrder = 'human desk ... piloted the accounts payable agent';
assert.equal(quoteAppearsIn(ellipsisOutOfOrder, PAGES[0].markdown), false,
  'ellipsis spans out of source order must be rejected');

assert.ok(buildPack(PAGES).includes('--- PAGE 0 ---'), 'pages are numbered for citation');

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

/* ── official SAP AI SDK telemetry dataset must be valid ────────────────── */
const sdk = JSON.parse(fs.readFileSync('web/data/sdk-downloads.json', 'utf8'));
assert.ok(sdk.packages?.length === 5, '5 official SAP AI SDK packages');
assert.ok(sdk.summary?.allTimeGrandTotal > 5000000, 'over 5M cumulative SDK downloads');
assert.ok(sdk.summary?.weeklyGrandTotal > 100000, 'over 100k weekly SDK downloads');
assert.ok(sdk.weeklySeries?.length >= 50, 'at least 50 weeks of telemetry history');
assert.ok(sdk.dailySeries?.length >= 365, 'at least 365 days of daily points');

console.log('selftest passed');
console.log(`  ${frameFor(NOW).tiers.map((t) => t.badge).join('  |  ')}`);
console.log(`  recent ${fresh}× vs legacy ${legacy}× = ${(fresh / legacy).toFixed(0)}:1`);
console.log(`  ${config.length} topics in sync between config and web`);
console.log(`  free tracker: legacy-heavy mix scores ${tracked.score}/5`);
console.log(`  sdk telemetry: ${sdk.summary.allTimeGrandTotal.toLocaleString()} cumulative downloads (${sdk.weeklySeries.length} weeks)`);

