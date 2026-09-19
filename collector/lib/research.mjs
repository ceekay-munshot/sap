import { frameFor, POLICY } from '../../web/lib/recency.mjs';
import { gather } from './firecrawl.mjs';
import { verifyQuotes } from './verify.mjs';

/**
 * One research pass per topic, using Claude with the web-search server tool —
 * the same shape of work the original dashboard's "Run Research" button did,
 * moved onto a schedule so the numbers stay current without anyone clicking.
 *
 * Web search runs on Anthropic's infrastructure, so this works from CI without
 * the runner needing to reach each source itself.
 */

/**
 * Bedrock has no server-side web search, so retrieval is Firecrawl's job and the
 * model only ever reads text we fetched. Provider is chosen from the environment.
 */
/**
 * The credential may be an Anthropic key (sk-ant-…) or one of AWS's long-lived
 * Bedrock API keys, which is a bearer token the Bedrock client accepts as
 * `apiKey`. Either can arrive in ANTHROPIC_API_KEY, so tell them apart by shape
 * rather than making anyone rename a secret.
 */
const RAW_KEY = process.env.BEDROCK_API_KEY
  || process.env.AWS_BEARER_TOKEN_BEDROCK
  || process.env.ANTHROPIC_API_KEY
  || '';

const LOOKS_ANTHROPIC = RAW_KEY.startsWith('sk-ant-');

export const PROVIDER = process.env.AI_PROVIDER || (
  LOOKS_ANTHROPIC ? 'anthropic'
    : (RAW_KEY || process.env.AWS_ACCESS_KEY_ID) ? 'bedrock'
      : 'anthropic'
);

/**
 * The SDK's Mantle client wants `anthropic.<model>` and nothing else.
 * Confirmed against the live account: `anthropic.claude-opus-5` answers,
 * while `us.anthropic.claude-opus-5` and bare `claude-opus-5` both 404.
 * (The region-prefixed inference profile is for the raw bedrock-runtime
 * InvokeModel endpoint, which is a different API.)
 */
export function bedrockModelId(base) {
  const bare = String(base).replace(/^(us|eu|apac|us-gov)\./, '');
  return bare.startsWith('anthropic.') ? bare : `anthropic.${bare}`;
}

export const MODEL = process.env.RESEARCH_MODEL
  ? (PROVIDER === 'bedrock' ? bedrockModelId(process.env.RESEARCH_MODEL) : process.env.RESEARCH_MODEL)
  : (PROVIDER === 'bedrock' ? bedrockModelId('anthropic.claude-opus-5') : 'claude-opus-5');

/** Page text is capped so a single long page cannot dominate the bill. */
const MAX_PAGE_CHARS = Number(process.env.MAX_PAGE_CHARS || 6000);

export async function makeClient() {
  if (PROVIDER === 'bedrock') {
    const { AnthropicBedrockMantle } = await import('@anthropic-ai/bedrock-sdk');
    return new AnthropicBedrockMantle({
      awsRegion: process.env.AWS_REGION || 'us-east-1',
      // With no key the client falls back to the normal AWS credential chain.
      ...(RAW_KEY && !LOOKS_ANTHROPIC ? { apiKey: RAW_KEY } : {}),
    });
  }
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  return new Anthropic();
}

/** The temporal rule is generated from the shared policy, so the prompt rolls
 *  over with the calendar exactly as the dashboard's labels do. */
function systemPrompt(now) {
  const frame = frameFor(now);
  const [current, prior, legacy] = frame.tiers;
  return `You are an elite enterprise-technology analyst specialising in SAP. Synthesise real practitioner sentiment from the SAP Community Network, LinkedIn, Reddit (r/SAP, r/ERP), G2 / Gartner Peer Insights / TrustRadius reviews, analyst reports (Gartner, Forrester, IDC), and technology journalism.

TEMPORAL WEIGHTING (mandatory):
- ${current.label} sources: weight ${current.multiplier} — these dominate the score
- ${prior.label} sources: weight ${prior.multiplier}
- Anything before ${prior.label}: weight ${legacy.multiplier} — label these [LEGACY PRE-${prior.label}]

Most of SAP's AI portfolio only became real recently. Commentary older than ${prior.label} describes a product that no longer exists; cite it for context, never let it drive the score.

SCORING RULES (1.0–5.0, one decimal place):
- adoption: 1.0 barely piloted, 3.0 growing but uneven, 5.0 pervasive
- maturity: 1.0 pre-GA/alpha, 3.0 stable for common use-cases, 5.0 battle-tested at scale
- satisfaction: 1.0 mostly complaints, 3.0 mixed/divided, 5.0 strong advocates
- competitive: 1.0 significantly behind peers, 3.0 roughly on par, 5.0 clear market leader
- overall: an honest recency-weighted average. NEVER round to a safe middle number.

You will be given numbered pages that have already been fetched from the web.
Work ONLY from those pages. Do not use anything you remember about SAP that is not
in them, and do not describe what you cannot see in them.

Every quote must be copied from one of the pages, word for word, and must carry the
number of the page it came from. Quotes are checked against the page text afterwards
and silently discarded if they are not there, so paraphrasing costs you the quote.
If the pages do not support a confident read, say so in the summary and lower the
confidence score. Thin evidence honestly reported is useful; invented evidence is not.

WRITING STYLE — this is read by investors, not engineers:
- Plain English. Short sentences. Explain jargon the first time you use it.
- Write prose, not notes. No markdown at all: no asterisks, no bold markers, no
  hyphens starting a line, no "---", no headings. The page does the formatting.
- Every finding is ONE sentence, under 30 words, that states something concrete.
  Say what happened and why it matters. Do not label findings "CURRENT" or "RECENT" —
  the date does that.
- The summary is 2-3 sentences a non-technical reader understands on first pass.
- Never write a number without saying what it counts.

Do not write any urls. Links are attached from the fetched pages, using the page
number you cite, so a page number is all that is needed.

Return ONLY a JSON object, no prose around it, in exactly this shape:
{
  "score": <number 1.0-5.0>,
  "sub": { "adoption": <n>, "maturity": <n>, "satisfaction": <n>, "competitive": <n> },
  "recencyMix": { "current": <count of ${current.label} sources used>, "prior": <count from ${prior.label}>, "legacy": <count older> },
  "confidence": <0.0-1.0>,
  "summary": "<2-3 sentences of analytical synthesis>",
  "findings": ["<finding>", "... 4 to 6 of them"],
  "quotes": [
    {
      "text": "<verbatim or near-verbatim, at least 25 words>",
      "name": "<full name, or empty string if anonymous>",
      "title": "<job title>",
      "company": "<employer>",
      "platform": "<where it was published>",
      "date": "<YYYY-MM-DD, best known date>",
      "context": "<one sentence of context>",
      "sourceIndex": <the number of the page this quote came from>
    }
  ]
}
Include 3-6 quotes spanning different viewpoints, each from a page you were given.`;
}

/** Models sometimes wrap JSON in prose or fences; take the outermost object. */
export function extractJson(text) {
  if (!text) throw new Error('empty response');
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start === -1 || end <= start) throw new Error('no JSON object in response');
  return JSON.parse(body.slice(start, end + 1));
}

/** Models leak markdown even when told not to; strip it rather than render it. */
export function cleanText(value) {
  return String(value ?? '')
    .replace(/\*\*/g, '')
    .replace(/(^|\n)\s*[-*\u2022]\s+/g, '$1')
    .replace(/(^|\n)\s*#{1,6}\s*/g, '$1')
    .replace(/^\s*-{3,}\s*$/gm, '')
    // A horizontal rule can also land mid-sentence; 3+ hyphens are never prose.
    .replace(/(^|\s)-{3,}(?=\s|$)/g, ' ')
    .replace(/`/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Only a real absolute http(s) link survives; anything else becomes empty. */
export function cleanUrl(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  try {
    const u = new URL(raw);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
    if (!u.hostname.includes('.')) return '';
    if (/^(example|test|placeholder|your-?site)\./i.test(u.hostname)) return '';
    return u.href;
  } catch {
    return '';
  }
}

const clampScore = (n) => {
  const v = Number(n);
  if (!Number.isFinite(v)) return null;
  return Math.round(Math.min(5, Math.max(1, v)) * 10) / 10;
};

/** Never let a malformed or hallucinated shape through to the dashboard. */
export function normalise(raw, topic, now, pages = []) {
  const score = clampScore(raw.score);
  if (score === null) throw new Error('missing overall score');
  const sub = {};
  for (const key of ['adoption', 'maturity', 'satisfaction', 'competitive']) {
    const v = clampScore(raw.sub?.[key]);
    if (v !== null) sub[key] = v;
  }
  const mix = raw.recencyMix || {};
  const quotes = (Array.isArray(raw.quotes) ? raw.quotes : [])
    .filter((q) => q && typeof q.text === 'string' && q.text.trim().length > 20)
    .slice(0, 8)
    .map((q) => ({
      sourceIndex: Number.isFinite(Number(q.sourceIndex)) ? Number(q.sourceIndex) : null,
      text: cleanText(q.text),
      name: cleanText(q.name),
      title: cleanText(q.title),
      company: cleanText(q.company),
      platform: cleanText(q.platform),
      date: String(q.date || '').trim() || null,
      context: cleanText(q.context),
      url: '',
    }));
  // Sources are the pages we actually fetched, never something the model typed.
  const sources = (pages || []).slice(0, 12)
    .map((p) => ({ title: cleanText(p.title) || p.url, url: cleanUrl(p.url) }))
    .filter((s) => s.url);

  return {
    id: topic.id,
    label: topic.label,
    icon: topic.icon,
    category: topic.category,
    score,
    sub,
    recencyMix: {
      current: Number(mix.current) || 0,
      prior: Number(mix.prior) || 0,
      legacy: Number(mix.legacy) || 0,
    },
    confidence: Number(raw.confidence) || null,
    summary: cleanText(raw.summary),
    findings: (Array.isArray(raw.findings) ? raw.findings : [])
      .map(cleanText).filter(Boolean).slice(0, 8),
    quotes,
    sources,
    ranAt: now.toISOString(),
    model: MODEL,
  };
}

/** Build the numbered pack the model reads, and the page list we verify against. */
export function buildPack(pages) {
  return pages.map((page, i) =>
    `--- PAGE ${i} ---\nTITLE: ${page.title || '(untitled)'}\nURL: ${page.url}\n`
    + `${String(page.markdown || '').slice(0, MAX_PAGE_CHARS)}`).join('\n\n');
}

/** Run one topic: fetch, read, score, then verify every quote. */
export async function researchTopic(client, topic, { now = new Date(), log = console.log } = {}) {
  const base = topic.queries?.length ? topic.queries : [topic.label, `SAP ${topic.label} review`];
  // One extra, year-stamped query so retrieval leans on the current year. The
  // year comes from the shared policy, so this rolls over like everything else.
  const queries = [...base, `SAP ${topic.label} ${frameFor(now).currentYear}`];
  const { pages, errors } = await gather(queries, { log });
  if (!pages.length) {
    throw new Error(`no usable pages fetched${errors.length ? ` (${errors[0]})` : ''}`);
  }

  const message = await client.messages.create({
    model: MODEL,
    max_tokens: 16000,
    system: systemPrompt(now),
    thinking: { type: 'adaptive' },
    output_config: { effort: 'high' },
    messages: [{
      role: 'user',
      content: `${topic.prompt}\n\nHere are the pages that were fetched for this topic.\n\n${buildPack(pages)}`,
    }],
  });

  if (message.stop_reason === 'refusal') {
    throw new Error(`refused: ${message.stop_details?.category || 'unknown'}`);
  }

  const text = message.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
  const result = normalise(extractJson(text), topic, now, pages);

  const { kept, rejected } = verifyQuotes(result.quotes, pages);
  if (rejected.length) {
    log(`    ${rejected.length} quote(s) dropped — not found in the fetched pages`);
    for (const bad of rejected) log(`      × "${bad.text}…"`);
  }
  result.quotes = kept.map(({ sourceIndex, ...q }) => q);
  result.evidence = {
    pagesFetched: pages.length,
    quotesVerified: kept.length,
    quotesRejected: rejected.length,
    searchErrors: errors,
  };
  log(`    ${pages.length} pages · ${kept.length} quotes verified`);
  return result;
}
