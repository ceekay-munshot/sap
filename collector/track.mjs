#!/usr/bin/env node
/**
 * The free daily pass.
 *
 * Scrapes public sources, buckets each post into the nine topics, scores it with
 * a keyword lexicon, and appends one recency-weighted point per topic per day.
 * No API key, no cost. This is what draws the trend line.
 *
 * The paid Claude pass (collector/run.mjs) writes the deep reports on demand.
 */
import fs from 'node:fs';
import { SOURCES } from './sources/index.mjs';
import { isRelevant } from './lib/taxonomy.mjs';
import { classifyHeuristic } from './lib/classify.mjs';
import { topicsFor, toFiveScale } from './lib/topicmatch.mjs';
import { readJson, writeJson, loadCorpus, mergeCorpus, pruneCorpus, saveCorpus } from './lib/store.mjs';
import { weightFor, tierFor, frameFor, round } from '../web/lib/recency.mjs';

const DRY_RUN = process.argv.includes('--dry-run');
const ONLY = (process.argv.find((a) => a.startsWith('--only=')) || '').split('=')[1];
const log = (...args) => console.log(...args);

const TREND = 'web/data/trend.json';

/** Recency-weighted rollup for one topic's items. */
export function rollupTopic(items, now) {
  let num = 0;
  let den = 0;
  let opinionNum = 0;
  let opinionDen = 0;
  const stance = { positive: 0, negative: 0, neutral: 0, mixed: 0 };
  const tiers = { current: 0, prior: 0, legacy: 0 };

  for (const item of items) {
    if (typeof item.sentiment !== 'number') continue;
    const w = weightFor(item.date, now);
    num += item.sentiment * w;
    den += w;
    // A mean taken over everything is dominated by neutral press headlines and
    // sits on 3.0 forever. The score describes the items with a view.
    if (item.sentiment !== 0) {
      opinionNum += item.sentiment * w;
      opinionDen += w;
    }
    const key = stance[item.stance] === undefined ? 'neutral' : item.stance;
    stance[key] += w;
    tiers[tierFor(item.date, now)] += 1;
  }
  if (den === 0) return null;

  // Most press headlines are genuinely neutral, so a share taken over everything
  // is ~90% neutral and never moves. The headline percentages are therefore taken
  // over the items that actually express a view; the share that did not is
  // reported separately rather than hidden.
  const opinionated = stance.positive + stance.negative + stance.mixed;
  const pct = (part) => (opinionated === 0 ? 0 : Math.round((part / opinionated) * 100));

  return {
    score: opinionDen === 0 ? 3 : toFiveScale(opinionNum / opinionDen),
    scoreAllItems: toFiveScale(num / den),
    pctPositive: pct(stance.positive),
    pctNegative: pct(stance.negative),
    pctMixed: pct(stance.mixed),
    pctNoView: Math.round((stance.neutral / den) * 100),
    items: items.length,
    opinionatedWeight: Math.round(opinionated * 10) / 10,
    tiers,
  };
}

/** Same-day reruns replace the day's point rather than stacking a second one. */
export function appendDay(trend, day, payload) {
  const days = (trend?.days || []).filter((d) => d.date !== day);
  days.push({ date: day, ...payload });
  days.sort((a, b) => a.date.localeCompare(b.date));
  return { updatedAt: new Date().toISOString(), days: days.slice(-400) };
}

async function main() {
  const startedAt = new Date();
  const day = startedAt.toISOString().slice(0, 10);
  const config = JSON.parse(fs.readFileSync('config/sources.json', 'utf8'));
  const { topics } = JSON.parse(fs.readFileSync('config/topics.json', 'utf8'));

  log(`SAP AI Intelligence — free tracking pass ${startedAt.toISOString()}`);
  if (DRY_RUN) log('(dry run: nothing will be written)');

  /* 1. Scrape ------------------------------------------------------------- */
  const harvested = [];
  const report = { startedAt: startedAt.toISOString(), sources: [] };

  for (const source of SOURCES) {
    const cfg = config[source.id];
    if (!cfg?.enabled || (ONLY && ONLY !== source.id)) {
      report.sources.push({ id: source.id, status: 'skipped', items: 0 });
      continue;
    }
    const t0 = Date.now();
    try {
      const items = await source.collect(cfg);
      harvested.push(...items);
      const entry = { id: source.id, status: 'ok', items: items.length, ms: Date.now() - t0 };
      if (items.errors) { entry.status = 'partial'; entry.errors = items.errors; }
      report.sources.push(entry);
      log(`  ${source.id}: ${items.length} items`);
    } catch (err) {
      report.sources.push({ id: source.id, status: 'error', error: err.message, ms: Date.now() - t0 });
      log(`  ! ${source.id} failed: ${err.message}`);
    }
  }

  /* 2. Filter, bucket, score ---------------------------------------------- */
  const relevant = harvested.filter((i) => isRelevant(`${i.title} ${i.text}`));
  const corpus = loadCorpus();
  const { merged, newcomers } = mergeCorpus(corpus, relevant);
  log(`\n${harvested.length} harvested → ${relevant.length} on-topic → ${newcomers.length} new`);

  const scoredNew = classifyHeuristic(newcomers).map((item) => ({
    ...item,
    topics: topicsFor(`${item.title} ${item.text}`),
  }));
  const byId = new Map(scoredNew.map((r) => [r.id, r]));
  const all = pruneCorpus(merged.map((item) => byId.get(item.id) || item));

  /* 3. One weighted point per topic, plus an overall ----------------------- */
  const perTopic = {};
  for (const topic of topics) {
    const subset = all.filter((i) => (i.topics || []).includes(topic.id));
    const roll = rollupTopic(subset, startedAt);
    if (roll) perTopic[topic.id] = roll;
  }
  const overall = rollupTopic(all, startedAt);

  report.finishedAt = new Date().toISOString();
  report.corpusSize = all.length;
  report.topicsWithData = Object.keys(perTopic).length;

  if (DRY_RUN) {
    log('\n--- dry run ---');
    log(JSON.stringify({ overall, perTopic }, null, 2));
    return;
  }

  const trend = appendDay(readJson(TREND, { days: [] }), day, { topics: perTopic, overall });
  saveCorpus(all, { engine: 'heuristic', lastTrack: report.finishedAt });
  writeJson(TREND, trend);
  writeJson('data/track-report.json', report);

  log(`\nwrote ${TREND} — ${trend.days.length} day(s) of history`);
  log(`corpus ${all.length} items · ${Object.keys(perTopic).length}/${topics.length} topics have data`);
  if (overall) log(`overall ${overall.score}/5 · ${overall.pctPositive}% positive · ${overall.pctNegative}% negative`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error('tracking run failed:', err);
    process.exit(1);
  });
}
