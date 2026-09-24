#!/usr/bin/env node
/**
 * Open the dashboard in a real browser and click through it.
 *
 * Twice now a single undefined function has emptied a whole view, and both
 * times it reached the published site, because nothing here ever rendered the
 * page against the real data. This does: every topic report, the trend chart
 * for every topic, both themes. Any page error, failed request or view that
 * comes back empty fails the run.
 *
 *   node tools/rendercheck.mjs [url]     default http://127.0.0.1:8099
 */
import { chromium } from 'playwright';

const BASE = process.argv[2] || process.env.SITE_URL || 'http://127.0.0.1:8099';
// Google Fonts is a nice-to-have; a sandbox without egress must not fail a
// check about our own code.
const EXTERNAL = /fonts\.googleapis\.com|fonts\.gstatic\.com/;

const problems = [];
const note = (s) => problems.push(s);

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH || undefined,
});
const page = await browser.newPage();
page.on('pageerror', (e) => note(`page error: ${e.message}`));
page.on('console', (m) => {
  const t = m.text();
  if (m.type() === 'error' && !EXTERNAL.test(t) && !/Failed to load resource/.test(t)) note(`console error: ${t}`);
});
page.on('requestfailed', (r) => {
  if (!EXTERNAL.test(r.url())) note(`request failed: ${r.url()} ${r.failure()?.errorText}`);
});

const bodyText = async () => ((await page.textContent('body')) || '').trim();
const check = async (label, min = 400) => {
  const len = (await bodyText()).length;
  console.log(`  ${String(len).padStart(6)} chars  ${label}`);
  if (len < min) note(`${label} rendered almost nothing (${len} chars)`);
};

console.log(`RENDER CHECK ${BASE}\n`);
await page.goto(BASE, { waitUntil: 'networkidle' });
await page.waitForTimeout(700);
await check('home');

const cards = await page.locator('[data-open]').count();
const runButtons = await page.locator('[data-research]').count();
console.log(`\n  ${cards} report links, ${runButtons} Run Research buttons`);
if (cards < 9) note(`expected nine topic reports to be reachable, found ${cards}`);

// Every report, opened the way a reader opens it.
for (let i = 0; i < cards; i += 1) {
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForTimeout(400);
  const link = page.locator('[data-open]').nth(i);
  const id = await link.getAttribute('data-open');
  if (!id) continue;
  await link.click();
  await page.waitForTimeout(500);
  await check(`report: ${id}`, 800);
}

// The trend chart, per topic, since that is the thing the customer asked for.
// It lives behind the SENTIMENT HISTORY filter, not on the front page.
await page.goto(BASE, { waitUntil: 'networkidle' });
await page.waitForTimeout(500);
const historyFilter = page.locator('[data-cat="history"]:visible').first();
if (!(await historyFilter.count())) note('no SENTIMENT HISTORY filter');
else {
  await historyFilter.click();
  await page.waitForTimeout(600);
  await check('sentiment history', 800);
}

const select = page.locator('#historyTopic').first();
if (await select.count()) {
  for (const value of await select.locator('option').evaluateAll((os) => os.map((o) => o.value))) {
    await select.selectOption(value);
    await page.waitForTimeout(300);
    const svg = await page.locator('svg').count();
    console.log(`  trend: ${value.padEnd(18)} ${svg} chart element(s)`);
    if (!svg) note(`trend chart for ${value} drew nothing`);
  }
} else {
  note('no trend topic selector on the page');
}

// Clicking a week opens the posts behind its score. That panel fetches a
// separate file and renders from it, so it can break on its own.
const hit = page.locator('.trend-hit:visible').first();
if (await hit.count()) {
  const bb = await hit.boundingBox();
  await page.mouse.click(bb.x + bb.width * 0.88, bb.y + bb.height * 0.5);
  await page.waitForTimeout(2500);
  const open = await page.locator('.evidence.open').count();
  const rows = await page.locator('.ev-item').count();
  const head = (await page.locator('.ev-h2').textContent().catch(() => '')) || '';
  console.log(`  evidence panel: ${open ? 'opens' : 'DID NOT OPEN'}, ${rows} row(s)`);
  console.log(`    ${head.trim().slice(0, 110)}`);
  if (!open) note('clicking a week did not open the evidence panel');
  else if (!rows) note('the evidence panel opened with nothing in it');
  else if (!/expressed a view/.test(head)) note('the evidence panel did not say what it counted');

  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);
  if (await page.locator('.evidence.open').count()) note('the evidence panel did not close on Escape');
} else {
  note('no chart hit area to click');
}

// The same history as review-count bars. One toggle switches the whole view,
// so every topic has to draw columns — main chart and card alike — and a
// column has to open its week just as a point on the line does.
const barsToggle = page.locator('[data-chart-mode="bars"]').first();
if (await barsToggle.count() && await select.count()) {
  await barsToggle.click();
  await page.waitForTimeout(400);
  for (const value of await select.locator('option').evaluateAll((os) => os.map((o) => o.value))) {
    await select.selectOption(value);
    await page.waitForTimeout(250);
    const columns = await page.locator('.trend-svg .trend-bar').count();
    console.log(`  bars:  ${value.padEnd(18)} ${columns} column(s)`);
    if (!columns) note(`bar chart for ${value} drew no columns`);
  }
  const cardBars = await page.locator('.stable-grid .bars').count();
  if (cardBars < 9) note(`expected all nine topic cards in bars, found ${cardBars}`);

  // Midway along, where every week is on the weekly grid and kept its evidence.
  await select.selectOption('overall');
  await page.waitForTimeout(250);
  const barHit = page.locator('.trend-hit:visible').first();
  const bb = await barHit.boundingBox();
  await page.mouse.click(bb.x + bb.width * 0.5, bb.y + bb.height * 0.5);
  await page.waitForTimeout(1500);
  const rows = await page.locator('.ev-item').count();
  console.log(`  evidence from a column: ${rows} row(s)`);
  if (!rows) note('clicking a column did not open the posts behind it');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
} else {
  note('no line/bars toggle on the history view');
}

// Light mode is a second set of colour variables; it has broken on its own.
const toggle = page.locator('#themeToggle').first();
if (await toggle.count()) {
  await toggle.click();
  await page.waitForTimeout(400);
  await check('light theme');
} else {
  note('no theme toggle');
}

await browser.close();

if (problems.length) {
  console.log('\nPROBLEMS');
  for (const p of [...new Set(problems)]) console.log(`  ${p}`);
  process.exit(1);
}
console.log('\nEvery view rendered, no page errors.');
