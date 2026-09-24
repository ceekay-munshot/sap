#!/usr/bin/env node
/**
 * Give the points already in trend.json the counts the bars are drawn from.
 *
 * The rollup now records how many positive, negative and neutral posts sit
 * behind each point (collector/track.mjs). Points written before that carry
 * weighted percentages only, and a weighted share cannot be turned back into a
 * count, so the counts are recovered from the evidence log instead: every run
 * logged the posts behind its points, each with its stance. The current
 * evidence.json covers the weekly grid; a live point that has since dropped off
 * the grid is found in the evidence.json of the commit that wrote it.
 *
 * A log is used only when it describes the same point — the same number of
 * items read and of items with a view — so nothing is estimated. A point with
 * no matching log keeps no counts, and the chart leaves it out rather than guess.
 *
 * Safe to rerun: points that already have counts are left alone. Run it from the
 * repository root, where the git history it reads from is.
 *
 *   node tools/backfill-counts.mjs [--dry-run]
 */
import { execFileSync } from 'node:child_process';
import { readJson, writeJson } from '../collector/lib/store.mjs';

const TREND = 'web/data/trend.json';
const EVIDENCE = 'web/data/evidence.json';
const DRY_RUN = process.argv.includes('--dry-run');

/** Evidence logs, newest first: the working copy, then every committed version. */
function* evidenceLogs() {
  const current = readJson(EVIDENCE, null);
  if (current) yield { from: 'working copy', log: current };
  const shas = execFileSync('git', ['log', '--format=%H', '--', EVIDENCE], { encoding: 'utf8' })
    .split('\n').filter(Boolean);
  for (const sha of shas) {
    try {
      const text = execFileSync('git', ['show', `${sha}:${EVIDENCE}`],
        { encoding: 'utf8', maxBuffer: 1 << 28 });
      yield { from: sha.slice(0, 7), log: JSON.parse(text) };
    } catch { /* not present or not parseable at that commit */ }
  }
}

/** Counts for one point from a log of it, or null when the log describes something else. */
function countsFrom(log, date, id, bucket) {
  const week = log.weeks?.[date]?.[id];
  if (!week || week.view.length !== bucket.opinionItems || week.scannedTotal !== bucket.items) return null;
  let positive = 0;
  let negative = 0;
  for (const n of week.view) {
    const item = log.items?.[n];
    if (!item) return null;
    if (item.st === 'positive') positive += 1;
    else if (item.st === 'negative') negative += 1;
  }
  // A post that leans either way always expressed a view, so every one of them
  // is in the view list; the rest of what counted took no clear side.
  const neutral = bucket.items - bucket.vendorItems - positive - negative;
  return neutral < 0 ? null : { positive, negative, neutral };
}

/** The bucket with counts in the place the collector writes them. */
function withCounts(bucket, counts) {
  const out = {};
  for (const [key, value] of Object.entries(bucket)) {
    out[key] = value;
    if (key === 'vendorItems') out.counts = counts;
  }
  if (!out.counts) out.counts = counts;
  return out;
}

function main() {
  const trend = readJson(TREND, null);
  if (!trend?.days?.length) {
    console.error(`no points in ${TREND} to fill`);
    process.exit(1);
  }

  const missing = new Map();   // "date|id" → { day, id }
  for (const day of trend.days) {
    for (const id of ['overall', ...Object.keys(day.topics || {})]) {
      const bucket = id === 'overall' ? day.overall : day.topics[id];
      if (bucket && !bucket.counts) missing.set(`${day.date}|${id}`, { day, id });
    }
  }
  const wanted = missing.size;
  if (!wanted) {
    console.log('every point already has its counts');
    return;
  }

  const source = new Map();   // date → where its counts came from
  for (const { from, log } of evidenceLogs()) {
    for (const [key, { day, id }] of missing) {
      const bucket = id === 'overall' ? day.overall : day.topics[id];
      const counts = countsFrom(log, day.date, id, bucket);
      if (!counts) continue;
      const filled = withCounts(bucket, counts);
      if (id === 'overall') day.overall = filled;
      else day.topics[id] = filled;
      missing.delete(key);
      source.set(day.date, [...new Set([...(source.get(day.date) || []), from])]);
    }
    if (!missing.size) break;
  }

  for (const day of trend.days) {
    const buckets = [day.overall, ...Object.values(day.topics || {})].filter(Boolean);
    const done = buckets.filter((b) => b.counts).length;
    const o = day.overall?.counts;
    console.log(`  ${day.date}  ${String(done).padStart(2)}/${buckets.length} buckets  `
      + `${o ? `overall ${o.positive}+ ${o.negative}- ${o.neutral} neutral` : 'overall —'}`
      + `  ${(source.get(day.date) || ['already had counts']).join(', ')}`);
  }

  if (missing.size) {
    console.log(`\n${missing.size} bucket(s) left without counts — no log matches them:`);
    for (const key of missing.keys()) console.log(`  ${key}`);
  }
  console.log(`\nfilled ${wanted - missing.size} of ${wanted} bucket(s)`);

  if (DRY_RUN) { console.log('(dry run: nothing written)'); return; }
  writeJson(TREND, trend);
  console.log(`wrote ${TREND}`);
}

main();
