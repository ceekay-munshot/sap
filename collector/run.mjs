#!/usr/bin/env node
import fs from 'node:fs';
import { researchTopic, makeClient, MODEL, PROVIDER } from './lib/research.mjs';
import { readJson, writeJson } from './lib/store.mjs';
import { frameFor, describePolicy } from '../web/lib/recency.mjs';

const DRY_RUN = process.argv.includes('--dry-run');
const ONLY = (process.argv.find((a) => a.startsWith('--only=')) || '').split('=')[1];
const log = (...args) => console.log(...args);

const DASHBOARD = 'web/data/dashboard.json';

/** One point per topic per run day; a same-day rerun replaces, never duplicates. */
function appendHistory(history, topicId, score, day) {
  const points = (history[topicId] || []).filter((p) => p.date !== day);
  points.push({ date: day, score });
  points.sort((a, b) => a.date.localeCompare(b.date));
  return points.slice(-60);
}

async function main() {
  const startedAt = new Date();
  const day = startedAt.toISOString().slice(0, 10);
  const { topics } = JSON.parse(fs.readFileSync('config/topics.json', 'utf8'));
  const selected = ONLY ? topics.filter((t) => t.id === ONLY) : topics;

  log(`SAP AI Intelligence — research run ${startedAt.toISOString()}`);
  log(`${selected.length} topic(s), model ${MODEL}`);
  if (DRY_RUN) log('(dry run: nothing will be written)');

  if (!process.env.FIRECRAWL_API_KEY) {
    log('\n! No FIRECRAWL_API_KEY. Research cannot fetch anything — nothing collected.');
    process.exit(1);
  }
  const hasModelKey = process.env.ANTHROPIC_API_KEY || process.env.BEDROCK_API_KEY
    || process.env.AWS_BEARER_TOKEN_BEDROCK || process.env.AWS_ACCESS_KEY_ID;
  if (!hasModelKey) {
    log('\n! No model credential. Research needs one — nothing collected.');
    process.exit(1);
  }

  const client = await makeClient();
  log(`provider ${PROVIDER}`);

  const previous = readJson(DASHBOARD, { topics: {}, history: {} });
  const results = { ...(previous.topics || {}) };
  const history = { ...(previous.history || {}) };
  const report = { startedAt: startedAt.toISOString(), topics: [] };

  for (const topic of selected) {
    log(`\n  ${topic.icon} ${topic.label}`);
    const t0 = Date.now();
    try {
      const result = await researchTopic(client, topic, { now: startedAt, log });
      results[topic.id] = result;
      history[topic.id] = appendHistory(history, topic.id, result.score, day);
      report.topics.push({ id: topic.id, status: 'ok', score: result.score, ms: Date.now() - t0 });
      log(`    → ${result.score.toFixed(1)}/5 · ${result.quotes.length} quotes · ${result.sources.length} sources`);
    } catch (err) {
      // One topic failing must not cost the other eight.
      report.topics.push({ id: topic.id, status: 'error', error: err.message, ms: Date.now() - t0 });
      log(`    ! failed: ${err.message}`);
    }
  }

  const ok = report.topics.filter((t) => t.status === 'ok').length;
  report.finishedAt = new Date().toISOString();
  report.durationMs = Date.now() - startedAt.getTime();
  report.succeeded = ok;
  report.failed = report.topics.length - ok;

  const snapshot = {
    generatedAt: startedAt.toISOString(),
    engine: ok > 0 ? 'claude' : 'unknown',
    model: MODEL,
    policy: { frame: frameFor(startedAt), prose: describePolicy(startedAt) },
    topics: results,
    history,
    run: report,
  };

  if (DRY_RUN) {
    log(`\n--- dry run: ${ok}/${report.topics.length} topics scored ---`);
    log(JSON.stringify(report, null, 2));
    return;
  }

  if (ok === 0) {
    log('\n! Every topic failed — leaving the existing dashboard data untouched.');
    writeJson('data/run-report.json', report);
    process.exit(1);
  }

  writeJson(DASHBOARD, snapshot);
  writeJson('web/data/topics.json', { topics });
  writeJson('data/run-report.json', report);

  const scored = Object.values(results).filter((r) => r?.score);
  const mean = scored.reduce((a, r) => a + r.score, 0) / (scored.length || 1);
  log(`\nwrote ${DASHBOARD} — ${ok} topic(s) scored this run, ${scored.length} held in total`);
  log(`overall ${mean.toFixed(1)}/5`);
}

main().catch((err) => {
  console.error('research run failed:', err);
  process.exit(1);
});
