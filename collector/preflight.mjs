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

// The SDK's Mantle client talks to a different endpoint than raw bedrock-runtime
// above, and takes different model ids. Probe the exact path the collector uses.
console.log('\nMANTLE CLIENT (what the collector actually uses)');
try {
  const { AnthropicBedrockMantle } = await import('@anthropic-ai/bedrock-sdk');
  const client = new AnthropicBedrockMantle({ awsRegion: REGION, apiKey: AI_KEY });
  for (const model of [
    'anthropic.claude-opus-5',
    `${REGION_PREFIX}anthropic.claude-opus-5`,
    'claude-opus-5',
    'anthropic.claude-sonnet-5',
    'claude-sonnet-5',
  ]) {
    try {
      const r = await client.messages.create({
        model, max_tokens: 8, messages: [{ role: 'user', content: 'say ok' }],
      });
      const out = r.content.filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
      line(true, model, `WORKS — replied ${JSON.stringify(out)}`);
    } catch (err) {
      line(false, model, String(err.message || err).slice(0, 120));
    }
  }
} catch (err) {
  line(false, 'bedrock-sdk import', String(err.message || err).slice(0, 160));
}

// The dashboard's Run Research button depends on these two endpoints being
// live and configured. This sandbox cannot reach the site; CI can.
const SITE = process.env.SITE_URL || 'https://sap-8nz.pages.dev';
console.log(`\nLIVE SITE (${SITE})`);
try {
  const res = await fetch(`${SITE}/api/status`, { headers: { accept: 'application/json' } });
  const text = await res.text();
  const ctype = res.headers.get('content-type') || '';

  if (!res.ok) {
    line(false, '/api/status', `HTTP ${res.status}`);
  } else if (!ctype.includes('json')) {
    // A Pages Function returns JSON. HTML here means the request fell through
    // to the static asset handler, i.e. the function is not deployed.
    line(false, '/api/status', `returned ${ctype.split(';')[0] || 'no content-type'}, not JSON `
      + '— the Function is not deployed (functions/ must be at the repo root)');
  } else {
    let body = null;
    try { body = JSON.parse(text); } catch { /* handled below */ }
    if (!body || typeof body.configured !== 'boolean') {
      line(false, '/api/status', `unexpected payload: ${text.slice(0, 80)}`);
    } else if (!body.configured) {
      line(false, '/api/status', 'deployed, but GITHUB_TOKEN is not set in the Pages env vars');
    } else {
      line(true, '/api/status', `configured · last run ${body.state || 'unknown'}`);
    }
  }
} catch (err) {
  line(false, '/api/status', String(err.message || err).slice(0, 110));
}

// The button POSTs, so check the method the button actually uses.
try {
  const res = await fetch(`${SITE}/api/research`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    // probe:true asks the Function to verify its token without starting a run,
    // so this health check never spends money.
    body: JSON.stringify({ probe: true }),
  });
  const ctype = res.headers.get('content-type') || '';
  const text = await res.text();
  if (res.status === 405) {
    line(false, 'POST /api/research', '405 — hitting the static handler, not a Function');
  } else if (!ctype.includes('json')) {
    line(false, 'POST /api/research', `returned ${ctype.split(';')[0] || 'no content-type'}, not JSON`);
  } else {
    let body = {};
    try { body = JSON.parse(text); } catch { /* reported below */ }
    if (body.status === 'ready') {
      line(true, 'Run Research button', `ready · ${body.repo} @ ${body.branch} · via ${body.route}`);
    } else {
      line(false, 'Run Research button', body.hint || body.error || text.slice(0, 120));
      // The probe reports each GitHub call separately, so print them: the one
      // that refused is the one to fix.
      for (const [name, c] of Object.entries(body.checks || {})) {
        console.log(`       ${name.padEnd(9)} GitHub ${c.status}${c.detail ? ` — ${c.detail.replace(/\s+/g, ' ').slice(0, 100)}` : ''}`);
      }
    }
  }
} catch (err) {
  line(false, 'POST /api/research', String(err.message || err).slice(0, 110));
}

console.log('\nVERDICT');
console.log(`  Firecrawl version to use: ${fcVersion || 'NONE WORKED'}`);
console.log('  Use whichever MANTLE CLIENT line says OK — that is the path the collector takes.');
