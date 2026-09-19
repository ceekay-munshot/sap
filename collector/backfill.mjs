#!/usr/bin/env node
/**
 * Reconstruct the weekly history of the index from the corpus.
 *
 * This is a backfill, not an invention. For each past week it takes the items
 * published in the eight weeks ending on that date and scores them with the
 * same rollup the live pass uses, with the recency weighting applied relative
 * to that week rather than to today. The result is what the index would have
 * read on that date, given what existed.
 *
 * The window is why the lines can move. Scoring everything published up to a
 * date instead meant a point at week twenty averaged five months of items, so
 * one new opinion could not shift it and the line sat flat for months.
 *
 * Reconstructed points are marked so the dashboard can say which part of the
 * line was computed from history and which was collected live.
 */
import fs from 'node:fs';
import { rollupTopic, withoutEvidence, windowFor, WINDOW_DAYS } from './track.mjs';
import { loadCorpus, readJson, writeJson } from './lib/store.mjs';

const WEEKS = Number(process.env.BACKFILL_WEEKS || 22);   // ~5 months
const TREND = 'web/data/trend.json';
const EVIDENCE = 'web/data/evidence.json';
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
  /*
   * A live point is kept as collected — except one computed under a different
   * window, which would sit on the same line as points that mean something
   * else. Mixing a cumulative point with windowed ones is what produced the
   * cliff at the right edge that looked like sentiment collapsing and was only
   * the sample changing size. Those get recomputed from the corpus, which is
   * the collected data; the rollup is just arithmetic over it.
   */
  const live = new Map((existing.days || [])
    .filter((d) => !d.reconstructed && d.windowDays === WINDOW_DAYS)
    .map((d) => [d.date, d]));
  const restated = (existing.days || [])
    .filter((d) => !d.reconstructed && d.windowDays !== WINDOW_DAYS).length;
  if (restated) console.log(`restating ${restated} live point(s) computed under a different window`);

  const liveDates = new Set((existing.days || []).filter((d) => !d.reconstructed).map((d) => d.date));
  const days = [];
  const weeks = {};   // date → topic → { view: ids, scanned: ids }
  for (const asOf of weekEnds(WEEKS)) {
    const key = asOf.toISOString().slice(0, 10);
    const known = windowFor(dated, asOf);
    if (known.length < 5) continue;   // too thin to be worth a point

    const perTopic = {};
    for (const topic of topics) {
      const subset = known.filter((i) => (i.topics || []).includes(topic.id));
      const roll = rollupTopic(subset, asOf);
      if (roll) perTopic[topic.id] = roll;
    }
    const overall = rollupTopic(known, asOf);
    if (!overall) continue;

    // Every week gets its evidence, including a live point whose numbers are
    // kept as collected — otherwise clicking the most recent week, the one a
    // reader is most likely to click, would open on nothing.
    weeks[key] = {
      overall: overall.evidence,
      ...Object.fromEntries(Object.entries(perTopic).map(([id, r]) => [id, r.evidence])),
    };

    if (live.has(key)) { days.push(live.get(key)); continue; }   // never overwrite a real run
    days.push({
      date: key,
      topics: Object.fromEntries(Object.entries(perTopic).map(([id, r]) => [id, withoutEvidence(r)])),
      overall: withoutEvidence(overall),
      windowDays: WINDOW_DAYS,
      // A restated live point stays live: it was collected on the day, only the
      // arithmetic over it has been redone.
      reconstructed: !liveDates.has(key),
    });
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

  /*
   * The evidence behind every point, in a file the page fetches only when a
   * reader clicks a week open. Items are stored once and referenced by id from
   * each week, because eight-week windows overlap seven ways and storing them
   * per week would repeat the same posts eight times over.
   */
  const byId = new Map(corpus.map((i) => [i.id, i]));

  // Ids are interned to positions in one array. Written out as strings they
  // came to 2.3 MB, because an eight-week window overlaps its neighbour seven
  // ways and every post is therefore listed eight times over.
  const index = new Map();
  const items = [];
  const ref = (id) => {
    if (index.has(id)) return index.get(id);
    const it = byId.get(id);
    if (!it) return -1;
    const n = items.push({
      t: it.title, u: it.url, s: it.sourceLabel || it.source, d: it.date,
      k: it.kind, v: it.voice, st: it.stance,
      ...(it.quote ? { q: it.quote } : {}),
      ...(it.author ? { a: it.author } : {}),
    }) - 1;
    index.set(id, n);
    return n;
  };

  // A reader checking a week wants the opinions in full and a fair sample of
  // what else was read, not two hundred headlines.
  const SCANNED_SHOWN = 60;
  const packed = {};
  for (const [date, buckets] of Object.entries(weeks)) {
    packed[date] = {};
    for (const [topicId, ev] of Object.entries(buckets)) {
      const view = ev.view.map(ref).filter((n) => n >= 0);
      const viewSet = new Set(ev.view);
      const rest = ev.scanned.filter((id) => !viewSet.has(id));
      packed[date][topicId] = {
        view,
        scanned: rest.slice(0, SCANNED_SHOWN).map(ref).filter((n) => n >= 0),
        scannedTotal: ev.scanned.length,
      };
    }
  }

  writeJson(EVIDENCE, {
    updatedAt: new Date().toISOString(),
    windowDays: WINDOW_DAYS,
    scannedShown: SCANNED_SHOWN,
    items,
    weeks: packed,
  });

  const kb = (f) => Math.round(fs.statSync(f).size / 1024);
  console.log(`\nwrote ${TREND} (${kb(TREND)} KB) and ${EVIDENCE} `
    + `(${kb(EVIDENCE)} KB, ${items.length} items cited)`);
}

main();
