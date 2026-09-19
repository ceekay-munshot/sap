/**
 * Recency weighting — the single source of truth for the whole project.
 *
 * Imported by BOTH the Node collector (scoring) and the browser (labels, badges,
 * banners, footer notes). Change a number here and every surface moves together.
 *
 * The policy is expressed RELATIVE TO THE CURRENT YEAR, never as hard-coded years,
 * so it rolls over by itself:
 *
 *   in 2026 →  2026 = 3×   ·  2025 = 1.5×  ·  pre-2025 = LEGACY
 *   in 2027 →  2027 = 3×   ·  2026 = 1.5×  ·  pre-2026 = LEGACY
 *
 * No code change, no config edit, no redeploy is needed on 1 January.
 */

export const POLICY = {
  /** Tier multipliers. The current year counts 3× a legacy item's 0.25×, i.e. 12:1. */
  weights: { current: 3, prior: 1.5, legacy: 0.25 },

  /**
   * Sub-year freshness boost, applied ON TOP of the tier weight, so "the last few
   * months and quarters" outrun the rest of the current year. First match wins.
   */
  freshness: [
    { maxDays: 30, factor: 2.5, label: 'last 30 days' },
    { maxDays: 60, factor: 1.9, label: 'last 60 days' },
    { maxDays: 90, factor: 1.4, label: 'last 90 days' },
    { maxDays: 180, factor: 1.1, label: 'last 180 days' },
  ],

  /** Items with no usable date are treated as legacy rather than guessed at. */
  undatedTier: 'legacy',
};

const DAY_MS = 86_400_000;

/** Parse to a UTC Date, or null when the value is unusable. */
export function parseDate(value) {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * The live frame: which years are which tier, and the exact strings the UI shows.
 * Everything user-facing is derived from here — never typed literally in markup.
 */
export function frameFor(now = new Date()) {
  const currentYear = now.getUTCFullYear();
  const priorYear = currentYear - 1;
  return {
    evaluatedAt: now.toISOString(),
    currentYear,
    priorYear,
    legacyBefore: priorYear,
    tiers: [
      {
        id: 'current',
        label: String(currentYear),
        weight: POLICY.weights.current,
        multiplier: `${POLICY.weights.current}×`,
        badge: `${currentYear} · ${POLICY.weights.current}×`,
        note: 'Current year — full weight',
      },
      {
        id: 'prior',
        label: String(priorYear),
        weight: POLICY.weights.prior,
        multiplier: `${POLICY.weights.prior}×`,
        badge: `${priorYear} · ${POLICY.weights.prior}×`,
        note: 'Prior year — reduced weight',
      },
      {
        id: 'legacy',
        label: `pre-${priorYear}`,
        weight: POLICY.weights.legacy,
        multiplier: `${POLICY.weights.legacy}×`,
        badge: `pre-${priorYear} · LEGACY`,
        note: 'Legacy — retained for context, barely counted',
      },
    ],
  };
}

/** Which tier a date falls in: 'current' | 'prior' | 'legacy'. */
export function tierFor(value, now = new Date()) {
  const d = parseDate(value);
  if (!d) return POLICY.undatedTier;
  const year = d.getUTCFullYear();
  const currentYear = now.getUTCFullYear();
  if (year >= currentYear) return 'current';
  if (year === currentYear - 1) return 'prior';
  return 'legacy';
}

/** The sub-year boost for an item, and why it got it. */
export function freshnessFor(value, now = new Date()) {
  const d = parseDate(value);
  if (!d) return { factor: 1, label: null };
  const ageDays = (now.getTime() - d.getTime()) / DAY_MS;
  if (ageDays < 0) return { factor: 1, label: null };
  for (const band of POLICY.freshness) {
    if (ageDays <= band.maxDays) return { factor: band.factor, label: band.label };
  }
  return { factor: 1, label: null };
}

/** Final multiplier for one item: tier weight × freshness boost. */
export function weightFor(value, now = new Date()) {
  const tier = tierFor(value, now);
  const { factor } = freshnessFor(value, now);
  return round(POLICY.weights[tier] * factor, 4);
}

/** Everything about one item's weighting, for the evidence table and tooltips. */
export function explainWeight(value, now = new Date()) {
  const tier = tierFor(value, now);
  const fresh = freshnessFor(value, now);
  const base = POLICY.weights[tier];
  return {
    tier,
    baseWeight: base,
    freshnessFactor: fresh.factor,
    freshnessLabel: fresh.label,
    weight: round(base * fresh.factor, 4),
  };
}

/** Prose for the banner and the footer — regenerated every render. */
export function describePolicy(now = new Date()) {
  const f = frameFor(now);
  const boosts = POLICY.freshness
    .map((b) => `${b.factor}× for the ${b.label}`)
    .join(', ');
  return {
    headline: `${f.currentYear} counts ${POLICY.weights.current}× · ${f.priorYear} counts ${POLICY.weights.prior}× · anything before ${f.priorYear} is legacy at ${POLICY.weights.legacy}×`,
    freshness: `Inside those tiers, a further ${boosts}.`,
    rollover: `Tiers are computed from the current year at render time, so on 1 January ${f.currentYear + 1} this reads ${f.currentYear + 1} = ${POLICY.weights.current}×, ${f.currentYear} = ${POLICY.weights.prior}×, pre-${f.currentYear} = LEGACY — with no code change.`,
  };
}

/** Weighted mean of {score, date} rows. Returns null rather than a fake zero. */
export function weightedMean(rows, now = new Date()) {
  let num = 0;
  let den = 0;
  for (const row of rows) {
    if (typeof row.score !== 'number' || Number.isNaN(row.score)) continue;
    const w = weightFor(row.date, now);
    num += row.score * w;
    den += w;
  }
  return den === 0 ? null : round(num / den, 4);
}

/** Unweighted mean, so the dashboard can show what the weighting actually changed. */
export function rawMean(rows) {
  const scores = rows.map((r) => r.score).filter((s) => typeof s === 'number' && !Number.isNaN(s));
  if (scores.length === 0) return null;
  return round(scores.reduce((a, b) => a + b, 0) / scores.length, 4);
}

export function round(n, places = 2) {
  const f = 10 ** places;
  return Math.round(n * f) / f;
}
