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

/**
 * How far back one weekly point looks.
 *
 * Every point used to score everything published up to that date, which is why
 * the lines were flat: by week twenty a point averaged five months of
 * accumulated items, and one new opinion could not move it. Joule held exactly
 * 1.8 for fifteen weeks that way.
 *
 * A point now describes what was being said in the eight weeks ending on its
 * date, so it can actually move, and the caption on the chart says so.
 */
export const WINDOW_DAYS = Number(process.env.TREND_WINDOW_DAYS || 56);

/** The items a point at `asOf` is allowed to see. */
export function windowFor(items, asOf, days = WINDOW_DAYS) {
  const end = asOf.getTime();
  const start = end - days * 86400000;
  return items.filter((item) => {
    const t = new Date(item.date).getTime();
    return !Number.isNaN(t) && t > start && t <= end;
  });
}

/** Recency-weighted rollup for one topic's items. */
export function rollupTopic(items, now) {
  let num = 0;
  let den = 0;
  let opinionNum = 0;
  let opinionDen = 0;
  const stance = { positive: 0, negative: 0, neutral: 0, mixed: 0 };
  // The same split as whole posts rather than weights, which the history view
  // draws as bars. Weighted shares cannot be turned back into counts, so they
  // are kept here. Neutral is everything that took no clear side, the hedged
  // "mixed" posts included, so the three add up to every item that counts.
  const counts = { positive: 0, negative: 0, neutral: 0 };
  const tiers = { current: 0, prior: 0, legacy: 0 };
  let vendorItems = 0;

  for (const item of items) {
    if (typeof item.sentiment !== 'number') continue;
    // A vendor's own words are not a practitioner's view of it. SAP's newsroom
    // still counts as read — it shows up in the scanned list — but it does not
    // get a vote in the score it is the subject of.
    if (item.voice === 'vendor') { vendorItems += 1; continue; }
    counts[item.stance === 'positive' || item.stance === 'negative' ? item.stance : 'neutral'] += 1;
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
  const scored = items.filter((i) => typeof i.sentiment === 'number' && i.voice !== 'vendor');
  const withView = scored.filter((i) => i.sentiment !== 0);
  const opinionItems = withView.length;
  // Below a handful of opinions the percentages are noise dressed as measurement.
  const thin = opinionItems < 3;
  const pct = (part) => (opinionated === 0 ? null : Math.round((part / opinionated) * 100));

  return {
    thin,
    opinionItems,
    score: opinionDen === 0 ? null : toFiveScale(opinionNum / opinionDen),
    scoreAllItems: toFiveScale(num / den),
    pctPositive: pct(stance.positive),
    pctNegative: pct(stance.negative),
    pctMixed: pct(stance.mixed),
    pctNoView: Math.round((stance.neutral / den) * 100),
    items: items.length,
    vendorItems,
    counts,
    opinionatedWeight: Math.round(opinionated * 10) / 10,
    tiers,
    // The ids behind the number, so a reader can click a week and check it
    // against the actual posts rather than take the score on trust. They are
    // split out into evidence.json; only the counts stay in the trend file.
    evidence: {
      view: withView.map((i) => i.id).filter(Boolean),
      scanned: items.map((i) => i.id).filter(Boolean),
    },
  };
}

/** The numbers only — what belongs in a file the page loads on every visit. */
export function withoutEvidence(roll) {
  if (!roll) return roll;
  const { evidence, ...rest } = roll;
  return rest;
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
      if (source.id === 'npm' && typeof source.syncSdkDownloads === 'function' && !DRY_RUN) {
        await source.syncSdkDownloads();
      }
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

  /*
   * Everything stored is restated, not just the newcomers.
   *
   * Stance, voice and topic are derived from the text by rules that change —
   * when the vendor check started working, four hundred items already in the
   * corpus still carried the label it gave them before. The text is the
   * record; these are arithmetic over it, so they are recomputed every run and
   * items the relevance rules would no longer admit are dropped.
   */
  const restated = classifyHeuristic(merged.map((item) => byId.get(item.id) || item))
    .map((item) => ({ ...item, topics: topicsFor(`${item.title} ${item.text}`) }));
  const kept = restated.filter((item) => isRelevant(`${item.title} ${item.text}`));
  const dropped = restated.length - kept.length;
  if (dropped) log(`  restated ${restated.length} stored items, dropped ${dropped} no longer on topic`);
  const all = pruneCorpus(kept);

  /* 3. One weighted point per topic, plus an overall ----------------------- */
  // A point describes the eight weeks ending today, not everything ever
  // collected, so today's number can differ from last week's.
  const recent = windowFor(all, startedAt);
  const perTopic = {};
  for (const topic of topics) {
    const subset = recent.filter((i) => (i.topics || []).includes(topic.id));
    const roll = rollupTopic(subset, startedAt);
    if (roll) perTopic[topic.id] = roll;
  }
  const overall = rollupTopic(recent, startedAt);

  report.finishedAt = new Date().toISOString();
  report.corpusSize = all.length;
  report.topicsWithData = Object.keys(perTopic).length;

  if (DRY_RUN) {
    log('\n--- dry run ---');
    log(JSON.stringify({ overall, perTopic }, null, 2));
    return;
  }

  // The trend file carries the numbers; the ids behind them go to evidence.json,
  // which the page fetches only when a reader clicks a week open.
  const slim = Object.fromEntries(Object.entries(perTopic).map(([k, v]) => [k, withoutEvidence(v)]));
  const trend = appendDay(readJson(TREND, { days: [] }), day, {
    topics: slim,
    overall: withoutEvidence(overall),
    windowDays: WINDOW_DAYS,
  });
  saveCorpus(all, { engine: 'heuristic', lastTrack: report.finishedAt });
  writeJson(TREND, trend);
  writeJson('data/track-report.json', report);

  // Surface what the tracker scanned on the page itself: a reader should be able
  // to see which sources fed the trend and which ones failed.
  const feedCount = (config.rss?.feeds || []).length;
  writeJson('web/data/sources.json', {
    updatedAt: report.finishedAt,
    corpusSize: all.length,
    itemsWithView: all.filter((i) => typeof i.sentiment === 'number' && i.sentiment !== 0).length,
    feedCount,
    sources: report.sources.map((src) => ({
      id: src.id,
      status: src.status,
      items: src.items ?? 0,
      errors: (src.errors || []).length,
    })),
    byLabel: Object.entries(all.reduce((acc, item) => {
      const key = item.sourceLabel || item.source;
      acc[key] = acc[key] || { items: 0, views: 0 };
      acc[key].items += 1;
      if (item.sentiment) acc[key].views += 1;
      return acc;
    }, {})).map(([label, v]) => ({ label, ...v }))
      .sort((a, b) => b.views - a.views || b.items - a.items),
  });

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
