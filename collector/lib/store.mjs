import fs from 'node:fs';
import path from 'node:path';

const CORPUS = 'data/corpus.json';

export function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

export function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

export function loadCorpus() {
  const data = readJson(CORPUS, { items: [] });
  return Array.isArray(data.items) ? data.items : [];
}

/**
 * Merge today's harvest into the corpus.
 * Existing items keep their original classification (we do not pay to re-read
 * the same comment every day); genuinely new items are returned for scoring.
 */
export function mergeCorpus(existing, fresh) {
  const byId = new Map(existing.map((item) => [item.id, item]));
  const newcomers = [];
  for (const item of fresh) {
    if (byId.has(item.id)) {
      const prior = byId.get(item.id);
      // Engagement moves; the text and the verdict do not.
      byId.set(item.id, { ...prior, engagement: item.engagement ?? prior.engagement });
    } else {
      byId.set(item.id, item);
      newcomers.push(item);
    }
  }
  return { merged: [...byId.values()], newcomers };
}

/** Keep the repo from growing without bound; legacy items are the first to go. */
export function pruneCorpus(items, { maxItems = 20000, maxAgeYears = 4 } = {}) {
  const cutoff = new Date();
  cutoff.setUTCFullYear(cutoff.getUTCFullYear() - maxAgeYears);
  const withinAge = items.filter((item) => {
    if (!item.date) return true;
    const d = new Date(item.date);
    return Number.isNaN(d.getTime()) ? true : d >= cutoff;
  });
  if (withinAge.length <= maxItems) return withinAge;
  return [...withinAge]
    .sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0))
    .slice(0, maxItems);
}

export function saveCorpus(items, meta) {
  writeJson(CORPUS, { updatedAt: new Date().toISOString(), count: items.length, meta, items });
}
