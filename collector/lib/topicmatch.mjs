/**
 * Maps a scraped item onto the nine dashboard topics.
 *
 * Deliberately keyword-based and free: this runs every day on every item, so it
 * must cost nothing. The paid Claude pass does the reading; this only decides
 * which bucket a post belongs in so the trend line has something to count.
 */

export const TOPIC_MATCH = {
  joule_sentiment: ['joule', 'ai assistant', 'copilot', 'ai copilot', 'chatbot', 'natural language query'],
  btp_ai: ['btp', 'business technology platform', 'ai core', 'ai foundation', 'generative ai hub',
    'agent builder', 'joule agent', 'ai agent', 'agentic', 'cap ', 'cloud application programming'],
  partner_views: ['accenture', 'capgemini', 'deloitte', 'pwc', 'kpmg', 'infosys', 'tcs', 'wipro',
    'cognizant', 'ibm consulting', 'implementation partner', 'system integrator', 'consultancy', 'consultant'],
  vs_competitors: ['salesforce', 'einstein', 'agentforce', 'microsoft', 'copilot studio', 'power bi',
    'oracle', 'workday', 'servicenow', 'celonis', 'snowflake', 'palantir', 'uipath', 'competitor',
    'compared to', 'versus', ' vs '],
  bdc_cloud: ['business data cloud', 'bdc', 'datasphere', 'databricks', 'data warehouse cloud',
    'data product', 'zero copy', 'zero-copy', 'delta share', 'analytics cloud', 'hana cloud'],
  customer_sat: ['gartner peer insights', 'g2 review', 'trustradius', 'peer insights', 'nps',
    'customer satisfaction', 'satisfied', 'dissatisfied', 'would recommend', 'rating'],
  s4hana_ai: ['s/4hana', 's4hana', 's/4 hana', 'rise with sap', 'grow with sap', 'ecc', 'clean core',
    'private cloud edition', 'public cloud edition', 'brownfield', 'greenfield', 'migration'],
  risks_gaps: ['risk', 'gap', 'concern', 'criticism', 'critical', 'lawsuit', 'security', 'breach',
    'hallucinat', 'privacy', 'compliance', 'audit', 'vaporware', 'slideware', 'overhyped', 'oversold',
    'failed', 'failure', 'delayed'],
  rpt1: ['rpt1', 'rpt-1', 'rpt 1', 'relational foundation model', 'relational transformer',
    'tabular model', 'tabular foundation', 'foundation model for tables', 'sap foundation model',
    'business ai model', 'predictive model', 'sap research model', 'table foundation'],
};

/** Every topic an item plausibly belongs to. An item can count for several. */
export function topicsFor(text) {
  const hay = (text || '').toLowerCase();
  return Object.entries(TOPIC_MATCH)
    .filter(([, words]) => words.some((w) => hay.includes(w)))
    .map(([id]) => id);
}

/**
 * The lexicon returns -1…+1; the dashboard speaks 1.0–5.0.
 * -1 → 1.0, 0 → 3.0, +1 → 5.0.
 */
export function toFiveScale(sentiment) {
  const v = Math.max(-1, Math.min(1, Number(sentiment) || 0));
  return Math.round((3 + v * 2) * 10) / 10;
}
