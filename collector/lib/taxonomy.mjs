/**
 * What we are measuring. Four pillars map to SAP's actual AI motion:
 * the migration that unlocks it, the data layer, the assistant, the agents.
 * Cross-cutting tags are filters and theme buckets, not chart series.
 */

export const PILLARS = [
  {
    id: 's4hana',
    label: 'S/4HANA & RISE migration',
    blurb: 'The on-ramp: cloud migration, subscription shift, clean core.',
    match: [
      's/4hana', 's4hana', 's/4 hana', 'rise with sap', 'grow with sap',
      'ecc migration', 'brownfield', 'greenfield', 'clean core', 'ecc 6.0',
      'private cloud edition', 'public cloud edition', 'sap ecc',
    ],
  },
  {
    id: 'bdc',
    label: 'Business Data Cloud',
    blurb: 'Unified SAP + third-party data, no reconciliation, write-back to SAP.',
    match: [
      'business data cloud', 'bdc', 'datasphere', 'sap data warehouse cloud',
      'data product', 'delta share', 'databricks', 'analytics cloud', 'hana cloud',
      'data lake', 'zero copy', 'zero-copy',
    ],
  },
  {
    id: 'joule',
    label: 'Joule',
    blurb: 'The assistant/copilot layer across SAP applications.',
    match: [
      'joule', 'copilot', 'sap assistant', 'ai assistant', 'chatbot',
      'natural language query', 'prompt', 'generative ai hub', 'ai core', 'ai foundation',
    ],
  },
  {
    id: 'agents',
    label: 'Agentic workflows',
    blurb: 'Industry agents doing work end-to-end with humans on exceptions.',
    match: [
      'agent', 'agentic', 'autonomous', 'multi-agent', 'agent builder',
      'accounts payable', 'invoice matching', 'exception handling', 'straight-through',
      'workflow automation', 'joule agent', 'human in the loop',
    ],
  },
];

/** Cross-cutting concerns — an item can carry several. */
export const TAGS = [
  {
    id: 'data-readiness',
    label: 'Data readiness & standardization',
    match: ['data quality', 'master data', 'data cleanup', 'standardize', 'standardisation',
      'bespoke process', 'custom code', 'z-code', 'technical debt', 'harmonize', 'governance'],
  },
  {
    id: 'licensing',
    label: 'Licensing & commercials',
    match: ['license', 'licence', 'pricing', 'subscription', 'maintenance fee', 'audit',
      'cost', 'expensive', 'tco', 'contract', 'upsell', 'price increase', 'credits'],
  },
  {
    id: 'partners',
    label: 'Implementation partners',
    match: ['accenture', 'capgemini', 'deloitte', 'pwc', 'kpmg', 'ey ', 'infosys', 'tcs',
      'wipro', 'ibm consulting', 'cognizant', 'system integrator', ' si ', 'consultant',
      'implementation partner'],
  },
  {
    id: 'competition',
    label: 'Alternatives in the SAP estate',
    match: ['celonis', 'snowflake', 'palantir', 'microsoft', 'copilot studio', 'power bi',
      'salesforce', 'agentforce', 'servicenow', 'workday', 'oracle', 'uipath', 'automation anywhere',
      'openai', 'anthropic', 'claude', 'gemini'],
  },
  {
    id: 'roadmap',
    label: 'Roadmap credibility',
    match: ['roadmap', 'ga ', 'general availability', 'vaporware', 'slideware', 'announced',
      'promised', 'delayed', 'beta', 'early adopter', 'pilot', 'poc', 'teched', 'sapphire'],
  },
];

const lower = (s) => (s || '').toLowerCase();

/** Every pillar an item touches (an item can span several). */
export function pillarsFor(text) {
  const hay = lower(text);
  return PILLARS.filter((p) => p.match.some((m) => hay.includes(m))).map((p) => p.id);
}

export function tagsFor(text) {
  const hay = lower(text);
  return TAGS.filter((t) => t.match.some((m) => hay.includes(m))).map((t) => t.id);
}

/** Is this item about SAP + AI at all? Keeps the corpus honest. */
/**
 * Whole-word containment.
 *
 * Plain substring matching let a third of the corpus in on nothing: "ai" is
 * inside available, maintain, chain and domain, so "SAP is available in more
 * regions" read as a post about SAP and AI. 451 of 1,249 items qualified that
 * way, and 142 of them were being counted as opinions.
 *
 * Terms carrying punctuation (s/4hana, rpt-1) cannot take a word boundary on
 * both sides, so those fall back to substring, where they are distinctive
 * enough not to collide.
 */
const WORDY = /^[a-z0-9]+(?: [a-z0-9]+)*$/;
const mentionCache = new Map();
function mentions(hay, term) {
  if (!WORDY.test(term)) return hay.includes(term);
  let re = mentionCache.get(term);
  if (!re) {
    re = new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
    mentionCache.set(term, re);
  }
  return re.test(hay);
}

/*
 * Adverts dressed as posts. Training outfits flood dev.to and Medium with
 * "Best SAP Datasphere Course | Training In Hyderabad", which mentions the
 * product, reads as enthusiastic to a lexicon, and is nobody's opinion of
 * anything. They were being counted as positive sentiment.
 */
const PROMO = /\b(training (in|institute)|course online|online (course|training)|certification (course|training)|enroll now|free demo|placement assistance|batch starts|book your seat|register (now|today) for)\b/i;

/*
 * A joule is also a unit of energy. "Joule" alone let a heat calculator into a
 * tracker about SAP's assistant, so the name only counts as an SAP artifact
 * when something else in the text places it in that world.
 */
const AMBIGUOUS = { joule: /\bsap\b|erp|s\/?4hana|abap|btp|fiori|business ai|copilot|assistant/i };

export function isRelevant(text) {
  const hay = lower(text);
  if (PROMO.test(hay)) return false;
  // Named SAP artifacts count even where the vendor's name does not appear —
  // a paper on RPT-1 is about SAP whether or not its abstract says so.
  const mentionsSap = ['sap', 's/4hana', 's4hana', 'joule', 'abap', 'datasphere', 'btp',
    'rpt-1', 'rpt1', 'relational foundation model', 'relational transformer']
    .some((m) => mentions(hay, m) && (!AMBIGUOUS[m] || AMBIGUOUS[m].test(hay)));
  if (!mentionsSap) return false;
  const mentionsSubject = [...PILLARS, ...TAGS].some((g) => g.match.some((m) => mentions(hay, m)));
  const mentionsAi = ['ai', 'genai', 'llm', 'machine learning', 'agent', 'agents', 'agentic',
    'automation', 'copilot', 'assistant', 'model', 'models']
    .some((m) => mentions(hay, m));
  return mentionsSubject || mentionsAi;
}

export const PILLAR_IDS = PILLARS.map((p) => p.id);
export const TAG_IDS = TAGS.map((t) => t.id);
