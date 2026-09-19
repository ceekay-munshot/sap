#!/usr/bin/env node
/**
 * Press the dashboard's Run Research button for real, from outside, and watch
 * what happens.
 *
 * The readiness probe proves the token is allowed to start a run. It cannot
 * prove that a run actually starts, that the topic survives the trip, or that
 * the loader has something to report — only a real press does that. This is
 * that press, run by hand, on one topic so it costs a ninth of a full pass.
 */
const SITE = process.env.SITE_URL || 'https://sap-8nz.pages.dev';
const TOPIC = process.env.TOPIC || 'data-readiness';
const PASS = process.env.RESEARCH_PASSPHRASE || '';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stamp = () => new Date().toISOString().slice(11, 19);

console.log(`PRESSING Run Research on ${SITE} for "${TOPIC}"\n`);

const res = await fetch(`${SITE}/api/research`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ topic: TOPIC, ...(PASS ? { passphrase: PASS } : {}) }),
});
const text = await res.text();
let body = {};
try { body = JSON.parse(text); } catch { /* reported below */ }

console.log(`  HTTP ${res.status} ${text.slice(0, 300)}`);
if (body.status !== 'started' && body.status !== 'already_running') {
  console.log('\nThe button did not start a run.');
  process.exit(1);
}
console.log(`  started via ${body.via || 'an existing run'}\n`);

// The loader reads /api/status, so read it the same way and print what a
// visitor would be shown.
let last = '';
for (let i = 0; i < 100; i += 1) {
  await sleep(10000);
  let s = {};
  try {
    s = await (await fetch(`${SITE}/api/status`, { headers: { accept: 'application/json' } })).json();
  } catch (err) {
    console.log(`  ${stamp()} status unreachable: ${String(err.message || err).slice(0, 80)}`);
    continue;
  }
  const shown = `${s.state}${s.step ? ` · ${s.step} (${s.stepIndex}/${s.stepTotal})` : ''}`;
  if (shown !== last) { console.log(`  ${stamp()} ${shown}`); last = shown; }
  if (s.state === 'success') { console.log('\nThe run finished and the dashboard knows it.'); process.exit(0); }
  if (s.state === 'failed') { console.log(`\nThe run failed: ${s.runId}`); process.exit(1); }
}
console.log('\nStill running after 16 minutes — not a failure, but not confirmed either.');
process.exit(1);
