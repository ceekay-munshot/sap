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
export function isRelevant(text) {
  const hay = lower(text);
  const mentionsSap = ['sap', 's/4hana', 's4hana', 'joule', 'abap', 'datasphere', 'btp']
    .some((m) => hay.includes(m));
  if (!mentionsSap) return false;
  const mentionsSubject = [...PILLARS, ...TAGS].some((g) => g.match.some((m) => hay.includes(m)));
  const mentionsAi = ['ai', 'genai', 'llm', 'machine learning', 'agent', 'automation']
    .some((m) => hay.includes(m));
  return mentionsSubject || mentionsAi;
}

export const PILLAR_IDS = PILLARS.map((p) => p.id);
export const TAG_IDS = TAGS.map((t) => t.id);
