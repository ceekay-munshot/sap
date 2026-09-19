#!/usr/bin/env node
/**
 * Reconstruct the weekly history of the index from the corpus.
 *
 * This is a backfill, not an invention. For each past week it takes only the
 * items that had already been published by that date and scores them with the
 * same rollup the live pass uses, with the recency weighting applied relative
 * to that week rather than to today. The result is what the index would have
 * read on that date, given what existed.
 *
 * Reconstructed points are marked so the dashboard can say which part of the
 * line was computed from history and which was collected live.
 */
import fs from 'node:fs';
import { rollupTopic } from './track.mjs';
import { loadCorpus, readJson, writeJson } from './lib/store.mjs';

const WEEKS = Number(process.env.BACKFILL_WEEKS || 22);   // ~5 months
const TREND = 'web/data/trend.json';
const DRY_RUN = process.argv.includes('--dry-run');

/** Week-ending dates, oldest first, ending with the most recent complete week. */
function weekEnds(count, now = new Date()) {
  const out = [];
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  for (let i = count - 1; i >= 0; i -= 1) {
    out.push(new Date(end.getTime() - i * 7 * 86400000));
  }
  return out;
}

function main() {
  const corpus = loadCorpus();
  const { topics } = JSON.parse(fs.readFileSync('config/topics.json', 'utf8'));
  if (!corpus.length) {
    console.error('corpus is empty — run collector/track.mjs first');
    process.exit(1);
  }

  const dated = corpus.filter((item) => {
    const d = item.date ? new Date(item.date) : null;
    return d && !Number.isNaN(d.getTime());
  });
  console.log(`corpus ${corpus.length} items, ${dated.length} dated`);

  const existing = readJson(TREND, { days: [] });
  const live = new Map((existing.days || [])
    .filter((d) => !d.reconstructed)
    .map((d) => [d.date, d]));

  const days = [];
  for (const asOf of weekEnds(WEEKS)) {
    const key = asOf.toISOString().slice(0, 10);
    if (live.has(key)) { days.push(live.get(key)); continue; }   // never overwrite a real run

    const known = dated.filter((item) => new Date(item.date) <= asOf);
    if (known.length < 5) continue;   // too thin to be worth a point

    const perTopic = {};
    for (const topic of topics) {
      const subset = known.filter((i) => (i.topics || []).includes(topic.id));
      const roll = rollupTopic(subset, asOf);
      if (roll) perTopic[topic.id] = roll;
    }
    const overall = rollupTopic(known, asOf);
    if (!overall) continue;

    days.push({ date: key, topics: perTopic, overall, reconstructed: true });
  }

  for (const day of live.values()) {
    if (!days.some((d) => d.date === day.date)) days.push(day);
  }
  days.sort((a, b) => a.date.localeCompare(b.date));

  const out = { updatedAt: new Date().toISOString(), days };
  const rebuilt = days.filter((d) => d.reconstructed).length;

  console.log(`${days.length} weekly points (${rebuilt} reconstructed, ${days.length - rebuilt} live)`);
  for (const d of days) {
    console.log(`  ${d.date}  ${String(d.overall.score).padStart(4)}/5  `
      + `${String(d.overall.pctPositive).padStart(3)}% pos  ${String(d.overall.items).padStart(4)} items`
      + `${d.reconstructed ? '' : '   ← live'}`);
  }

  if (DRY_RUN) { console.log('\n(dry run: nothing written)'); return; }
  writeJson(TREND, out);
  console.log(`\nwrote ${TREND}`);
}

main();
