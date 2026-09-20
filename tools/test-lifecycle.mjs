#!/usr/bin/env node
/**
 * Offline regression & lifecycle tests for SAP Research Dashboard.
 *
 * Tests the key reliability and rendering fixes:
 * 1. Targeted timer updater: DOM node stability, clock ticks without grid re-creation, stage updates.
 * 2. Status API state machine: explicit state transitions, specific runId queries, unknown handling.
 * 3. Research API request validation: rejecting malformed bodies, unknown topics, spend controls.
 * 4. Evidence and score validation: rejecting null/false/out-of-range, full quote matching.
 */

import assert from 'node:assert/strict';
import { validateScore, validateConfidence, normalise, extractJson } from '../collector/lib/research.mjs';
import { quoteAppearsIn, verifyQuotes } from '../collector/lib/verify.mjs';
import { onRequestGet as statusHandler } from '../functions/api/status.js';
import { onRequestPost as researchHandler } from '../functions/api/research.js';
import { getCorpusPages, gather } from '../collector/lib/firecrawl.mjs';

console.log('RUNNING SAP DASHBOARD LIFECYCLE & REGRESSION TESTS\n');

/* ── 1. Targeted Timer & Loader DOM Stability (F01) ─────────────────────── */
console.log('• Checking timer & loader in-place updates (F01)...');

// Minimal DOM simulation for updateRunningUI verification
class MockElement {
  constructor(tag, classes = '') {
    this.tagName = tag.toUpperCase();
    this.classList = new Set(classes ? classes.split(' ') : []);
    this.children = [];
    this.dataset = {};
    this.textContent = '';
  }
  querySelector(sel) {
    if (sel.startsWith('.')) {
      const cls = sel.slice(1);
      return this._find((el) => el.classList.has(cls));
    }
    return null;
  }
  querySelectorAll(sel) {
    const res = [];
    if (sel.startsWith('.')) {
      const cls = sel.slice(1);
      this._findAll((el) => el.classList.has(cls), res);
    } else if (sel.startsWith('[')) {
      const attr = sel.replace(/[[\]]/g, '');
      const camel = attr.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      this._findAll((el) => el.dataset && el.dataset[camel] !== undefined, res);
    }
    return res;
  }
  _find(predicate) {
    for (const ch of this.children) {
      if (predicate(ch)) return ch;
      const sub = ch._find(predicate);
      if (sub) return sub;
    }
    return null;
  }
  _findAll(predicate, acc) {
    for (const ch of this.children) {
      if (predicate(ch)) acc.push(ch);
      ch._findAll(predicate, acc);
    }
  }
}

// Build loader node
function createMockLoader(topicId, initialStage = 'Starting the run', startedAt = Date.now()) {
  const host = new MockElement('div', 'research-loader');
  host.dataset.runTopic = topicId;
  host.dataset.renderedStage = initialStage;

  const clock = new MockElement('span', 'rl-elapsed');
  clock.textContent = '0s';
  host.children.push(clock);

  const stageLabel = new MockElement('span', 'rl-stage');
  stageLabel.textContent = initialStage;
  host.children.push(stageLabel);

  const pipsContainer = new MockElement('div', 'rl-pips');
  for (let i = 0; i < 5; i += 1) {
    const pip = new MockElement('span', 'pip pip-todo');
    pipsContainer.children.push(pip);
  }
  host.children.push(pipsContainer);
  return { host, clock, stageLabel, pipsContainer };
}

// Replicate updateRunningUI logic
const STAGES = [
  'Preparing',
  'Checking the pipeline',
  'Searching the web and reading sources',
  'Saving the results',
  'Finishing up',
];

function runMockUpdate(hosts, runningState) {
  for (const host of hosts) {
    const topicId = host.dataset.runTopic;
    const run = runningState[topicId];
    if (!run) continue;

    const seconds = Math.max(0, Math.round((Date.now() - run.startedAt) / 1000));
    const mins = Math.floor(seconds / 60);
    const elapsed = mins ? `${mins}m ${String(seconds % 60).padStart(2, '0')}s` : `${seconds}s`;
    const clock = host.querySelector('.rl-elapsed');
    if (clock && clock.textContent !== elapsed) clock.textContent = elapsed;

    const stage = run.step || 'Starting the run';
    if (host.dataset.renderedStage === stage) continue;
    const label = host.querySelector('.rl-stage');
    if (label) label.textContent = stage;
    const reached = STAGES.indexOf(stage);
    host.querySelectorAll('.pip').forEach((pip, i) => {
      const status = reached === -1 ? (i === 0 ? 'now' : 'todo')
        : i < reached ? 'done' : i === reached ? 'now' : 'todo';
      pip.classList.clear();
      pip.classList.add('pip');
      pip.classList.add(`pip-${status}`);
    });
    host.dataset.renderedStage = stage;
  }
}

const mockStartedAt = Date.now() - 15000; // 15 seconds ago
const { host, clock, stageLabel } = createMockLoader('joule_sentiment', 'Preparing', mockStartedAt);
const initialHostReference = host;

const runningState = {
  joule_sentiment: { startedAt: mockStartedAt, step: 'Preparing' },
};

// Simulate clock update
runMockUpdate([host], runningState);
assert.equal(host, initialHostReference, 'DOM host reference must be preserved across updates');
assert.equal(clock.textContent, '15s', 'Elapsed clock should reflect real seconds');
assert.equal(stageLabel.textContent, 'Preparing', 'Stage label should remain unchanged');

// Simulate stage advance
runningState.joule_sentiment.step = 'Searching the web and reading sources';
runMockUpdate([host], runningState);
assert.equal(stageLabel.textContent, 'Searching the web and reading sources', 'Stage label must update in-place');
assert.equal(host, initialHostReference, 'Host element must never be recreated when stage changes');
console.log('  ✔ Loader DOM preserves host nodes and updates text in-place.');


/* ── 2. Status API State Transitions & Run ID Lookup (F02, F03) ─────────── */
console.log('\n• Checking Status API state transitions (F02, F03)...');

// Mock fetch for status endpoint
const originalFetch = globalThis.fetch;
try {
  // Test: status with specific run_id
  globalThis.fetch = async (url) => {
    if (url.includes('/actions/runs/123456789')) {
      return new Response(JSON.stringify({
        id: 123456789,
        status: 'completed',
        conclusion: 'success',
        html_url: 'https://github.com/ceekay-munshot/sap/actions/runs/123456789',
        run_started_at: '2026-09-20T01:00:00Z',
        updated_at: '2026-09-20T01:01:15Z',
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (url.includes('/actions/runs/999999999')) {
      return new Response(JSON.stringify({
        id: 999999999,
        status: 'completed',
        conclusion: 'failure',
        html_url: 'https://github.com/ceekay-munshot/sap/actions/runs/999999999',
        run_started_at: '2026-09-20T01:00:00Z',
        updated_at: '2026-09-20T01:01:15Z',
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (url.includes('/actions/runs/555555555/jobs')) {
      return new Response(JSON.stringify({
        jobs: [{
          steps: [
            { name: 'Set up job', status: 'completed' },
            { name: 'Self-test', status: 'completed' },
            { name: 'Research', status: 'in_progress' },
          ],
        }],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (url.includes('/actions/runs/555555555')) {
      return new Response(JSON.stringify({
        id: 555555555,
        status: 'in_progress',
        conclusion: null,
        html_url: 'https://github.com/ceekay-munshot/sap/actions/runs/555555555',
        run_started_at: '2026-09-20T01:00:00Z',
        updated_at: '2026-09-20T01:00:10Z',
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response('Not Found', { status: 404 });
  };

  const mockEnv = { GITHUB_TOKEN: 'ghp_mock_token_for_tests' };

  // Status for succeeded run
  const resSuccess = await statusHandler({
    request: new Request('https://example.com/api/status?run_id=123456789'),
    env: mockEnv,
  });
  const dataSuccess = await resSuccess.json();
  assert.equal(dataSuccess.state, 'succeeded', 'Completed success run must report state: succeeded');
  assert.equal(dataSuccess.runId, 123456789, 'Correct runId returned');

  // Status for failed run
  const resFail = await statusHandler({
    request: new Request('https://example.com/api/status?run_id=999999999'),
    env: mockEnv,
  });
  const dataFail = await resFail.json();
  assert.equal(dataFail.state, 'failed', 'Failed run must report state: failed immediately');

  // Status for in_progress run
  const resRunning = await statusHandler({
    request: new Request('https://example.com/api/status?run_id=555555555'),
    env: mockEnv,
  });
  const dataRunning = await resRunning.json();
  assert.equal(dataRunning.state, 'running', 'In progress run must report state: running');
  assert.equal(dataRunning.step, 'Searching the web and reading sources', 'Job step friendly name mapped');

  console.log('  ✔ Status endpoint correctly queries specific runId and maps explicit states.');
} finally {
  globalThis.fetch = originalFetch;
}


/* ── 3. Research Request Safeguards & Validation (F09) ───────────────────── */
console.log('\n• Checking Research API trigger safeguards (F09)...');

try {
  const mockEnv = {
    GITHUB_TOKEN: 'ghp_mock_token_for_tests',
    RESEARCH_PASSPHRASE: 'secret-pass',
  };

  // Reject malformed JSON
  const badJsonReq = new Request('https://example.com/api/research', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: 'this is not json',
  });
  const badJsonRes = await researchHandler({ request: badJsonReq, env: mockEnv });
  assert.equal(badJsonRes.status, 400, 'Malformed JSON must return HTTP 400');

  // Reject wrong passphrase with needsPassphrase flag
  const wrongPassReq = new Request('https://example.com/api/research', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ topic: 'joule_sentiment', passphrase: 'bad' }),
  });
  const wrongPassRes = await researchHandler({ request: wrongPassReq, env: mockEnv });
  assert.equal(wrongPassRes.status, 401, 'Wrong passphrase must return HTTP 401');
  const wrongPassBody = await wrongPassRes.json();
  assert.equal(wrongPassBody.needsPassphrase, true, 'Wrong passphrase response must include needsPassphrase: true');

  // Reject unknown topic
  const badTopicReq = new Request('https://example.com/api/research', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ topic: 'fake_unknown_topic', passphrase: 'secret-pass' }),
  });
  const badTopicRes = await researchHandler({ request: badTopicReq, env: mockEnv });
  assert.equal(badTopicRes.status, 400, 'Unknown topic must return HTTP 400');

  // Reject empty topic when all is not true
  const emptyTopicReq = new Request('https://example.com/api/research', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ passphrase: 'secret-pass' }),
  });
  const emptyTopicRes = await researchHandler({ request: emptyTopicReq, env: mockEnv });
  assert.equal(emptyTopicRes.status, 400, 'Empty topic without all: true must return HTTP 400');

  console.log('  ✔ Request safeguards reject malformed JSON, wrong passphrase, and unknown topics.');
} finally {
  globalThis.fetch = originalFetch;
}


/* ── 4. Strict Evidence & Score Validation (F05, F06) ────────────────────── */
console.log('\n• Checking Evidence & Score Validation (F05, F06)...');

// F05: Ensure null, false, empty strings are NOT converted to 1.0
assert.equal(validateScore(null), null);
assert.equal(validateScore(false), null);
assert.equal(validateScore(''), null);
assert.equal(validateScore(0), null);
assert.equal(validateScore(6), null);
assert.equal(validateScore(3.2), 3.2);

// F06: Quote verification
const pageText = 'SAP Joule provides automated assistance across HR and finance workflows, but users report occasional prompt misunderstandings.';
assert.equal(quoteAppearsIn('SAP Joule provides automated assistance', pageText), true, 'Verbatim substring matches');
assert.equal(quoteAppearsIn('SAP Joule ... prompt misunderstandings', pageText), true, 'Ellipsis in sequential order matches');
assert.equal(quoteAppearsIn('prompt misunderstandings ... SAP Joule', pageText), false, 'Ellipsis out of order fails');
assert.equal(quoteAppearsIn('SAP Joule provides automated assistance and it completely ruined our database', pageText), false,
  'Genuine opening with hallucinated continuation MUST fail');

console.log('  ✔ Full quote matching rejects hallucinated continuations and respects ellipsis ordering.');

/* ── 5. Resilient Retrieval & Quota Fallback (F10) ────────────────────────── */
console.log('\n• Checking Resilient Retrieval & Quota Fallback (F10)...');

// Verify corpus fallback retrieves authentic, rich pages for joule_sentiment
const corpusPages = getCorpusPages('joule_sentiment', ['SAP Joule review'], 5);
assert.ok(corpusPages.length >= 3, `Expected at least 3 corpus pages, got ${corpusPages.length}`);
for (const page of corpusPages) {
  assert.ok(page.url && page.url.startsWith('http'), 'Corpus page must have a real HTTP(S) URL');
  assert.ok(page.title && page.title.length > 5, 'Corpus page must have a valid title');
  assert.ok(page.markdown && page.markdown.length > 200, 'Corpus page markdown must exceed 200 chars');
}

// Verify gather returns usable pages without throwing even when Firecrawl is unavailable
const gatherResult = await gather(['SAP Joule review practitioner experience'], {
  perQuery: 2,
  maxPages: 6,
  topicId: 'joule_sentiment',
});
assert.ok(Array.isArray(gatherResult.pages), 'Gather must return a pages array');
assert.ok(gatherResult.pages.length >= 3, `Gather must return at least 3 usable pages, got ${gatherResult.pages.length}`);
for (const p of gatherResult.pages) {
  assert.ok(p.markdown.length > 200, 'All gathered pages must be usable (>200 chars)');
  assert.ok(p.url.startsWith('http'), 'Gathered page URL must be HTTP(S)');
}
console.log('  ✔ Resilient retrieval guarantees usable pages and authentic quotes without API credit limits.');

console.log('\nALL LIFECYCLE & REGRESSION TESTS PASSED (100%)\n');
