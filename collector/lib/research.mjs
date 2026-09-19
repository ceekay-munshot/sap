import { frameFor, POLICY } from '../../web/lib/recency.mjs';

/**
 * One research pass per topic, using Claude with the web-search server tool —
 * the same shape of work the original dashboard's "Run Research" button did,
 * moved onto a schedule so the numbers stay current without anyone clicking.
 *
 * Web search runs on Anthropic's infrastructure, so this works from CI without
 * the runner needing to reach each source itself.
 */

export const MODEL = process.env.RESEARCH_MODEL || 'claude-opus-5';

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

Search the web before answering. Ground every quote in a real, findable source.
If the evidence is thin, say so in the summary and lower your confidence — do not invent
quotes, names, companies or URLs. A fabricated quote is worse than no quote.

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
      "url": "<direct link, or empty string>"
    }
  ],
  "sources": [ { "title": "<page title>", "url": "<url>" } ]
}
Include 3-6 quotes spanning different viewpoints, and every source you actually used.`;
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

const clampScore = (n) => {
  const v = Number(n);
  if (!Number.isFinite(v)) return null;
  return Math.round(Math.min(5, Math.max(1, v)) * 10) / 10;
};

/** Never let a malformed or hallucinated shape through to the dashboard. */
export function normalise(raw, topic, now) {
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
      text: String(q.text).trim(),
      name: String(q.name || '').trim(),
      title: String(q.title || '').trim(),
      company: String(q.company || '').trim(),
      platform: String(q.platform || '').trim(),
      date: String(q.date || '').trim() || null,
      context: String(q.context || '').trim(),
      url: String(q.url || '').trim(),
    }));
  const sources = (Array.isArray(raw.sources) ? raw.sources : [])
    .filter((s) => s && (s.url || s.title))
    .slice(0, 12)
    .map((s) => ({ title: String(s.title || '').trim(), url: String(s.url || '').trim() }));

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
    summary: String(raw.summary || '').trim(),
    findings: (Array.isArray(raw.findings) ? raw.findings : []).map((f) => String(f).trim()).filter(Boolean).slice(0, 8),
    quotes,
    sources,
    ranAt: now.toISOString(),
    model: MODEL,
  };
}

/** Run one topic. Throws on failure so the caller can record it per topic. */
export async function researchTopic(client, topic, { now = new Date(), log = console.log } = {}) {
  const stream = await client.messages.stream({
    model: MODEL,
    max_tokens: 32000,
    system: systemPrompt(now),
    thinking: { type: 'adaptive' },
    output_config: { effort: 'high' },
    tools: [{ type: 'web_search_20260209', name: 'web_search', max_uses: 12 }],
    messages: [{ role: 'user', content: topic.prompt }],
  });
  const message = await stream.finalMessage();

  if (message.stop_reason === 'refusal') {
    throw new Error(`refused: ${message.stop_details?.category || 'unknown'}`);
  }

  const text = message.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n');

  const searches = message.content.filter((b) => b.type === 'web_search_tool_result').length;
  log(`    ${searches} web searches, ${text.length} chars returned`);

  return normalise(extractJson(text), topic, now);
}
