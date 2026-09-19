import { PILLAR_IDS, TAG_IDS, pillarsFor, tagsFor } from './taxonomy.mjs';

/**
 * Two classifiers, one interface.
 *
 *   engine: 'claude'    — real reading comprehension; needs ANTHROPIC_API_KEY
 *   engine: 'heuristic' — a domain lexicon; no key needed, and clearly labelled
 *                         as such everywhere it shows up on the dashboard.
 *
 * The dashboard always states which engine produced the numbers. A heuristic
 * score must never be passed off as a read.
 */

export const MODEL = process.env.CLASSIFIER_MODEL || 'claude-opus-5';
const BATCH_SIZE = Number(process.env.CLASSIFIER_BATCH || 15);

/**
 * The SDK and zod are imported on demand so the heuristic path — and the offline
 * self-test — run with no node_modules at all.
 */
async function loadClaude() {
  const [{ default: Anthropic }, { z }, { zodOutputFormat }] = await Promise.all([
    import('@anthropic-ai/sdk'),
    import('zod'),
    import('@anthropic-ai/sdk/helpers/zod'),
  ]);
  const Verdict = z.object({
    ref: z.number().int(),
    sentiment: z.number().min(-1).max(1),
    stance: z.enum(['positive', 'mixed', 'neutral', 'negative']),
    voice: z.enum(['practitioner', 'press', 'vendor', 'unknown']),
    pillars: z.array(z.enum(PILLAR_IDS)),
    tags: z.array(z.enum(TAG_IDS)),
    theme: z.string(),
    quote: z.string(),
    confidence: z.number().min(0).max(1),
  });
  const Batch = z.object({ verdicts: z.array(Verdict) });
  return { client: new Anthropic(), format: zodOutputFormat(Batch) };
}

const SYSTEM = `You read what technical practitioners say about SAP's AI strategy and score it for an equity research dashboard.

Score ONLY the author's expressed view of SAP's AI-related products and direction. Four pillars:
- s4hana: S/4HANA + RISE migration, clean core, the move off ECC
- bdc: Business Data Cloud, Datasphere, the unified data layer
- joule: Joule, the assistant/copilot layer
- agents: agentic workflows, industry agents, autonomous processing

sentiment: -1 (damning) to +1 (genuinely impressed). 0 means neutral or purely factual.
Be strict. Marketing copy restating features is NOT positive sentiment — it is neutral, voice "vendor".
A practitioner listing real limitations while staying constructive is "mixed", around -0.2 to +0.2.

voice: "practitioner" = works with SAP (customer-side engineer, consultant, integrator, admin).
"press"/"vendor" = journalism or SAP/partner marketing. Judge from the writing, not the source.

theme: at most 6 words naming the specific point ("Joule answers are shallow", "BDC pricing unclear").
quote: the single most telling verbatim sentence, copied exactly from the text, max 200 chars. Empty string if none.
pillars/tags: only what the text genuinely addresses. Empty arrays are correct when it addresses none.
confidence: how sure you are, given how short or ambiguous the text is.

Return exactly one verdict per input, echoing its ref.`;

/* ---------------------------------------------------------------- heuristic */

const POSITIVE = [
  'impressive', 'impressed', 'works well', 'works great', 'game changer', 'solid', 'great',
  'love', 'loved', 'excellent', 'huge win', 'saves us', 'saved us', 'time saver', 'delivers',
  'delivered', 'mature', 'reliable', 'smooth', 'seamless', 'productive', 'worth it',
  'recommend', 'promising', 'finally', 'genuinely useful', 'useful', 'valuable', 'strong',
  'powerful', 'intuitive', 'easy to use', 'straightforward', 'well designed', 'robust',
  'stable', 'fast', 'efficient', 'improvement', 'improved', 'better than', 'pleased',
  'satisfied', 'happy with', 'success', 'successful', 'pays off', 'paid off', 'no issues',
  'good experience', 'positive', 'excited', 'adopting', 'rolled out', 'in production',
];

const NEGATIVE = [
  'disappointing', 'disappointed', 'useless', 'garbage', 'vaporware', 'slideware',
  'overpriced', 'expensive', 'nightmare', 'broken', 'buggy', 'bug', 'fails', 'failed',
  'failure', 'terrible', 'awful', 'frustrating', 'frustrated', 'oversold', 'hype', 'hyped',
  'half-baked', 'immature', 'clunky', 'painful', 'pain', 'lacking', 'lacks', 'not ready',
  "doesn't work", 'does not work', 'regret', 'avoid', 'lipstick', 'rebrand', 'struggle',
  'struggling', 'difficult', 'hard to', 'confusing', 'confused', 'unreliable', 'slow',
  'sluggish', 'limited', 'limitation', 'shortcoming', 'gap', 'missing', 'cannot', "can't",
  'blocker', 'blocked', 'complaint', 'complain', 'criticism', 'concern', 'worried', 'risk',
  'hallucinat', 'wrong answer', 'inaccurate', 'misleading', 'downtime', 'outage', 'delay',
  'delayed', 'postponed', 'abandoned', 'rip out', 'ripped out', 'churn', 'waste',
];

/** Flipping words invert the polarity of a nearby match. */
const NEGATORS = ['not ', "n't", 'never ', 'no ', 'without ', 'hardly ', 'barely ', 'far from '];
const INTENSIFIERS = ['very ', 'extremely ', 'incredibly ', 'really ', 'massively ', 'hugely '];
const HEDGE = ['but ', 'however', 'although', 'though', 'mixed', 'depends', 'in theory',
  'on paper', 'that said', 'caveat', 'yet '];

/** Is this match negated by something just before it? */
function negatedAt(hay, index) {
  const window = hay.slice(Math.max(0, index - 24), index);
  return NEGATORS.some((n) => window.includes(n));
}

function heuristicScore(text) {
  const hay = (text || '').toLowerCase();
  let score = 0;
  let hits = 0;

  const tally = (words, polarity) => {
    for (const word of words) {
      const at = hay.indexOf(word);
      if (at === -1) continue;
      hits += 1;
      const flipped = negatedAt(hay, at) ? -polarity : polarity;
      const before = hay.slice(Math.max(0, at - 16), at);
      score += flipped * (INTENSIFIERS.some((i) => before.includes(i)) ? 1.5 : 1);
    }
  };
  tally(POSITIVE, 1);
  tally(NEGATIVE, -1);

  if (hits === 0) return { sentiment: 0, stance: 'neutral', confidence: 0.1 };

  const hedged = HEDGE.some((h) => hay.includes(h));
  // Divide by a soft count so a long rant does not peg at -1 on volume alone.
  let normalised = Math.max(-1, Math.min(1, score / Math.max(1.5, Math.sqrt(hits) * 1.4)));
  if (hedged) normalised *= 0.65;

  const stance = normalised > 0.15 ? 'positive'
    : normalised < -0.15 ? 'negative'
      : hedged || hits > 1 ? 'mixed' : 'neutral';
  return {
    sentiment: Number(normalised.toFixed(3)),
    stance,
    confidence: Math.min(0.5, 0.15 + hits * 0.07),
  };
}

function heuristicVoice(item) {
  if (item.stance === 'vendor' || item.source === 'rss') {
    return item.stance === 'vendor' ? 'vendor' : 'press';
  }
  return item.kind === 'article' ? 'press' : 'practitioner';
}

export function classifyHeuristic(items) {
  return items.map((item) => {
    const blob = `${item.title} ${item.text}`;
    const { sentiment, stance, confidence } = heuristicScore(blob);
    return {
      ...item,
      sentiment,
      stance,
      voice: heuristicVoice(item),
      pillars: pillarsFor(blob),
      tags: tagsFor(blob),
      theme: '',
      quote: '',
      confidence,
      engine: 'heuristic',
    };
  });
}

/* ------------------------------------------------------------------- claude */

async function classifyChunk(client, format, chunk) {
  const payload = chunk.map((item, i) => ({
    ref: i,
    source: item.sourceLabel,
    kind: item.kind,
    date: item.date,
    title: item.title,
    text: item.text,
  }));

  const response = await client.messages.parse({
    model: MODEL,
    max_tokens: 16000,
    system: SYSTEM,
    thinking: { type: 'adaptive' },
    output_config: { effort: 'low', format },
    messages: [{ role: 'user', content: JSON.stringify(payload, null, 2) }],
  });

  if (response.stop_reason === 'refusal') {
    throw new Error(`classifier refused: ${response.stop_details?.category || 'unknown'}`);
  }
  const parsed = response.parsed_output;
  if (!parsed) throw new Error('classifier returned unparseable output');

  const byRef = new Map(parsed.verdicts.map((v) => [v.ref, v]));
  return chunk.map((item, i) => {
    const v = byRef.get(i);
    if (!v) return classifyHeuristic([item])[0];
    return {
      ...item,
      sentiment: v.sentiment,
      stance: v.stance,
      voice: v.voice,
      pillars: v.pillars,
      tags: v.tags,
      theme: v.theme,
      quote: v.quote,
      confidence: v.confidence,
      engine: 'claude',
    };
  });
}

export async function classify(items, { log = console.log } = {}) {
  const hasKey = Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
  if (!hasKey) {
    log('! ANTHROPIC_API_KEY not set — falling back to the heuristic lexicon.');
    log('  Scores will be labelled "heuristic" on the dashboard.');
    return { rows: classifyHeuristic(items), engine: 'heuristic' };
  }

  const { client, format } = await loadClaude();
  const rows = [];
  let failures = 0;
  for (let i = 0; i < items.length; i += BATCH_SIZE) {
    const chunk = items.slice(i, i + BATCH_SIZE);
    try {
      rows.push(...(await classifyChunk(client, format, chunk)));
      log(`  classified ${Math.min(i + BATCH_SIZE, items.length)}/${items.length}`);
    } catch (err) {
      failures += 1;
      log(`  ! batch at ${i} failed (${err.message}) — heuristic for these ${chunk.length}`);
      rows.push(...classifyHeuristic(chunk));
    }
  }
  const engine = failures === 0 ? 'claude'
    : rows.some((r) => r.engine === 'claude') ? 'mixed' : 'heuristic';
  return { rows, engine };
}
