#!/usr/bin/env node
/**
 * Open the dashboard in a real browser and click through it.
 *
 * Twice now a single undefined function has emptied a whole view, and both
 * times it reached the published site, because nothing here ever rendered the
 * page against the real data. This does: every topic report, the trend chart
 * for every topic, both themes, and the front page at phone widths. Any page
 * error, failed request, view that comes back empty or page wider than a
 * phone screen fails the run.
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

// Phones. The nav once ran ~70px past a 375px screen, which zooms the whole
// page out or slides it sideways, and nothing here looked at a narrow screen.
// The theme toggle is the nav's one control, so its tap target is held too.
console.log('');
for (const theme of ['dark', 'light']) {
  for (const width of [320, 375, 414, 768]) {
    await page.setViewportSize({ width, height: 800 });
    await page.evaluate((t) => localStorage.setItem('sap-ai-theme', t), theme);
    await page.goto(BASE, { waitUntil: 'networkidle' });
    await page.waitForTimeout(300);
    const m = await page.evaluate(() => {
      const de = document.documentElement;
      const t = document.getElementById('themeToggle')?.getBoundingClientRect();
      return { sw: de.scrollWidth, cw: de.clientWidth, w: t?.width || 0, h: t?.height || 0, right: t?.right ?? Infinity };
    });
    const label = `${width}px ${theme}`;
    console.log(`  phone ${label.padEnd(12)} page ${m.sw}px wide, toggle ${Math.round(m.w)}×${Math.round(m.h)}`);
    if (m.sw > m.cw) note(`${label}: the page is ${m.sw}px wide on a ${m.cw}px screen`);
    if (m.w < 44 || m.h < 44 || m.right > m.cw) note(`${label}: the theme toggle is not a full 44px target on screen`);
  }
}

// The SDK chart is drawn at the width it is shown at and redrawn when that
// changes. Drawn at a fixed width and scaled instead, its labels shrank to 3px
// on a phone and, on a wide screen, the pointer landed weeks away from the
// point under it. So at a phone, a laptop and a wide desktop width: the plot
// fills its box at 1:1, its dates do not collide, and the last dot names the
// last week.
await page.goto(BASE, { waitUntil: 'networkidle' });
await page.waitForTimeout(500);
const adoption = page.locator('[data-cat="adoption"]:visible').first();
if (!(await adoption.count())) note('no SDK ADOPTION filter');
else {
  await adoption.click();
  await page.waitForTimeout(600);
  await check('sdk adoption', 800);
  for (const width of [1440, 1000, 375]) {
    await page.setViewportSize({ width, height: 900 });
    await page.waitForTimeout(600);   // the redraw waits for the resize to settle
    const fit = await page.evaluate(() => {
      const svg = document.querySelector('.sdk-trend-svg');
      if (!svg) return null;
      svg.scrollIntoView({ block: 'center', behavior: 'instant' });   // the page scrolls smoothly otherwise
      const box = svg.getBoundingClientRect();
      const ctm = svg.getScreenCTM();
      const bottom = svg.viewBox.baseVal.height - 8;
      const dates = [...svg.querySelectorAll('text')]
        .filter((t) => Number(t.getAttribute('y')) === bottom)
        .map((t) => t.getBoundingClientRect());
      const collide = dates.some((d, i) => i > 0 && d.left < dates[i - 1].right);
      const dots = svg.querySelectorAll('circle[r="2.5"]');   // one per week
      const last = dots[dots.length - 1]?.getBoundingClientRect();
      return {
        drawn: svg.viewBox.baseVal.width,
        shown: box.width,
        scale: ctm.a,
        bands: Math.abs(ctm.e - box.left) + Math.abs(ctm.f - box.top),
        collide,
        dates: dates.length,
        lastCx: dots[dots.length - 1]?.getAttribute('cx'),
        lastAt: last && { x: last.x + last.width / 2, y: last.y + last.height / 2 },
      };
    });
    if (!fit) { note(`sdk chart missing at ${width}px`); continue; }

    await page.mouse.move(fit.lastAt.x, fit.lastAt.y);
    await page.waitForTimeout(150);
    const hover = await page.evaluate(async () => {
      const weeks = (await fetch('./data/sdk-downloads.json').then((r) => r.json())).weeklySeries;
      const want = new Date(weeks[weeks.length - 1].weekEnding)
        .toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }).toUpperCase();
      return {
        want,
        title: document.querySelector('#tooltip .t-title')?.textContent || '',
        crossX: document.querySelector('.sdk-crosshair')?.getAttribute('x1'),
      };
    });
    await page.mouse.move(0, 0);

    console.log(`  sdk @${String(width).padStart(4)}px  drawn ${fit.drawn} / shown ${fit.shown.toFixed(1)}, `
      + `scale ${fit.scale.toFixed(3)}, ${fit.dates} dates, last dot → ${hover.title || 'nothing'}`);
    if (Math.abs(fit.scale - 1) > 0.01) note(`sdk chart scaled ${fit.scale.toFixed(3)}× at ${width}px instead of drawn at its width`);
    if (fit.bands > 1) note(`sdk chart letterboxed by ${fit.bands.toFixed(1)}px at ${width}px`);
    if (fit.collide) note(`sdk chart date labels collide at ${width}px`);
    if (!hover.title.includes(hover.want) || hover.crossX !== fit.lastCx) {
      note(`hovering the last sdk week at ${width}px showed "${hover.title}", not ${hover.want}`);
    }
  }
}

await browser.close();

if (problems.length) {
  console.log('\nPROBLEMS');
  for (const p of [...new Set(problems)]) console.log(`  ${p}`);
  process.exit(1);
}
console.log('\nEvery view rendered, no page errors.');
