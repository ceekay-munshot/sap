#!/usr/bin/env node
/**
 * Preflight: works out what the supplied keys actually are, and what works.
 * Prints key shapes only — never a key. Costs a fraction of a cent.
 */
const shape = (v) => (v ? `${v.slice(0, 7)}… (${v.length} chars)` : 'NOT SET');
const line = (ok, label, detail = '') =>
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);

const AI_KEY = process.env.ANTHROPIC_API_KEY || '';
const FC_KEY = process.env.FIRECRAWL_API_KEY || '';
const REGION = process.env.AWS_REGION || 'us-east-1';

console.log('KEYS');
console.log(`  ANTHROPIC_API_KEY   ${shape(AI_KEY)}`);
console.log(`  FIRECRAWL_API_KEY   ${shape(FC_KEY)}`);
console.log(`  AWS_ACCESS_KEY_ID   ${shape(process.env.AWS_ACCESS_KEY_ID || '')}`);
console.log(`  AWS_REGION          ${REGION}`);

const looksAnthropic = AI_KEY.startsWith('sk-ant-');
console.log(`\n  key looks like: ${looksAnthropic ? 'Anthropic first-party' : 'NOT an Anthropic key — probably AWS Bedrock'}`);

console.log('\nFIRECRAWL');
let fcVersion = null;
for (const v of ['v2', 'v1']) {
  try {
    const res = await fetch(`https://api.firecrawl.dev/${v}/search`, {
      method: 'POST',
      headers: { authorization: `Bearer ${FC_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ query: 'SAP Joule review', limit: 2 }),
    });
    const text = await res.text();
    if (res.ok) {
      const body = JSON.parse(text);
      const rows = body?.data?.web || body?.data || body?.results || [];
      line(true, v, `${Array.isArray(rows) ? rows.length : 0} results, keys: ${Object.keys(body).join(',')}`);
      if (Array.isArray(rows) && rows[0]) {
        console.log(`       result fields: ${Object.keys(rows[0]).join(', ')}`);
      }
      fcVersion = fcVersion || v;
    } else {
      line(false, v, `HTTP ${res.status} ${text.slice(0, 120)}`);
    }
  } catch (err) {
    line(false, v, err.message);
  }
}

console.log('\nMODEL');
// 1. Anthropic first-party
try {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': AI_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'claude-opus-5', max_tokens: 8, messages: [{ role: 'user', content: 'say ok' }] }),
  });
  line(res.ok, 'Anthropic API', res.ok ? 'key works here' : `HTTP ${res.status} ${(await res.text()).slice(0, 110)}`);
} catch (err) { line(false, 'Anthropic API', err.message); }

// 2. Bedrock bearer token (AWS's long-lived API key)
const REGION_PREFIX = /^eu-/.test(REGION) ? 'eu.' : /^ap-/.test(REGION) ? 'apac.' : 'us.';
const CANDIDATES = [
  `${REGION_PREFIX}anthropic.claude-opus-5`,
  `${REGION_PREFIX}anthropic.claude-sonnet-5`,
  `${REGION_PREFIX}anthropic.claude-haiku-4-5`,
  'anthropic.claude-opus-5',
];
for (const model of CANDIDATES) {
  try {
    const res = await fetch(`https://bedrock-runtime.${REGION}.amazonaws.com/model/${model}/invoke`, {
      method: 'POST',
      headers: { authorization: `Bearer ${AI_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ anthropic_version: 'bedrock-2023-05-31', max_tokens: 8, messages: [{ role: 'user', content: 'say ok' }] }),
    });
    line(res.ok, `Bedrock ${model}`, res.ok ? 'WORKS — use this id' : `HTTP ${res.status} ${(await res.text()).slice(0, 130)}`);
  } catch (err) { line(false, `Bedrock bearer ${model}`, err.message); }
}

console.log('\nVERDICT');
console.log(`  Firecrawl version to use: ${fcVersion || 'NONE WORKED'}`);
console.log('  Use whichever MODEL line says OK above.');
