#!/usr/bin/env node
import fs from 'node:fs';
import { SOURCES } from './sources/index.mjs';
import { isRelevant } from './lib/taxonomy.mjs';
import { classify } from './lib/classify.mjs';
import { aggregate, appendTrend } from './lib/aggregate.mjs';
import { loadCorpus, mergeCorpus, pruneCorpus, saveCorpus, readJson, writeJson } from './lib/store.mjs';

const DRY_RUN = process.argv.includes('--dry-run');
const ONLY = (process.argv.find((a) => a.startsWith('--only=')) || '').split('=')[1];
const log = (...args) => console.log(...args);

async function main() {
  const startedAt = new Date();
  const config = JSON.parse(fs.readFileSync('config/sources.json', 'utf8'));
  log(`SAP AI radar — collection run ${startedAt.toISOString()}`);
  if (DRY_RUN) log('(dry run: nothing will be written)');

  /* 1. Harvest ------------------------------------------------------------ */
  const harvested = [];
  const report = { startedAt: startedAt.toISOString(), sources: [] };

  for (const source of SOURCES) {
    const cfg = config[source.id];
    if (!cfg?.enabled) {
      report.sources.push({ id: source.id, status: 'disabled', items: 0 });
      continue;
    }
    if (ONLY && ONLY !== source.id) continue;
    const t0 = Date.now();
    try {
      const items = await source.collect(cfg);
      harvested.push(...items);
      const entry = { id: source.id, status: 'ok', items: items.length, ms: Date.now() - t0 };
      if (items.errors) { entry.status = 'partial'; entry.errors = items.errors; }
      report.sources.push(entry);
      log(`  ${source.id}: ${items.length} items${items.errors ? ` (${items.errors.length} feed errors)` : ''}`);
    } catch (err) {
      report.sources.push({ id: source.id, status: 'error', items: 0, error: err.message, ms: Date.now() - t0 });
      log(`  ! ${source.id} failed: ${err.message}`);
    }
  }

  /* 2. Filter to the subject ---------------------------------------------- */
  const relevant = harvested.filter((item) => isRelevant(`${item.title} ${item.text}`));
  log(`\n${harvested.length} harvested → ${relevant.length} on-topic`);
  report.harvested = harvested.length;
  report.relevant = relevant.length;

  /* 3. Merge, then classify only what is new ------------------------------ */
  const corpus = loadCorpus();
  const { merged, newcomers } = mergeCorpus(corpus, relevant);
  log(`${newcomers.length} new since last run (corpus held ${corpus.length})`);
  report.newItems = newcomers.length;

  let engine = 'cached';
  let scoredNew = [];
  if (newcomers.length) {
    const result = await classify(newcomers, { log });
    scoredNew = result.rows;
    engine = result.engine;
  }
  report.engine = engine;

  const scoredById = new Map(scoredNew.map((r) => [r.id, r]));
  const all = merged.map((item) => scoredById.get(item.id) || item);
  const pruned = pruneCorpus(all);
  report.corpusSize = pruned.length;

  /* 4. Aggregate and publish ---------------------------------------------- */
  const now = new Date();
  const snapshot = aggregate(pruned, { now, engine, runReport: report });
  const trend = appendTrend(readJson('web/data/trend.json', { days: [] }), snapshot, { now });

  report.finishedAt = new Date().toISOString();
  report.durationMs = Date.now() - startedAt.getTime();

  if (DRY_RUN) {
    log('\n--- dry run summary ---');
    log(JSON.stringify({ ...report, headline: snapshot.headline }, null, 2));
    return;
  }

  saveCorpus(pruned, { engine, lastRun: report.finishedAt });
  writeJson('web/data/dashboard.json', snapshot);
  writeJson('web/data/trend.json', trend);
  writeJson('data/run-report.json', report);

  log(`\nwrote web/data/dashboard.json (${snapshot.corpus.scored} scored, `
    + `${snapshot.corpus.practitioners} practitioner voices)`);
  log(`weighted index ${snapshot.headline.weighted ?? 'n/a'} · raw ${snapshot.headline.raw ?? 'n/a'}`);
}

main().catch((err) => {
  console.error('collection failed:', err);
  process.exit(1);
});
