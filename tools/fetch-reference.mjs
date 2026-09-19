#!/usr/bin/env node
/**
 * Capture a reference page so its design can be matched exactly.
 *
 * Runs in GitHub Actions, which has open internet — this sandbox does not.
 * Saves: the rendered DOM, the raw HTML, every same-origin stylesheet and
 * script, full-page screenshots, and a tally of the computed styles actually
 * in use (colours, fonts, radii, spacing) so values can be copied rather than
 * guessed at.
 */
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const TARGET = process.env.REFERENCE_URL || 'https://sap-dashboard-bh1.pages.dev/';
const OUT = 'reference';

fs.mkdirSync(`${OUT}/assets`, { recursive: true });

const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 1440, height: 1000 },
  deviceScaleFactor: 1,
});
const page = await context.newPage();

const console_errors = [];
page.on('pageerror', (e) => console_errors.push(String(e.message)));

console.log(`fetching ${TARGET}`);
const response = await page.goto(TARGET, { waitUntil: 'networkidle', timeout: 60000 });
await page.waitForTimeout(2500);

/* ------------------------------------------------ markup + network assets */

fs.writeFileSync(`${OUT}/rendered.html`, await page.content());
try {
  const raw = await fetch(TARGET).then((r) => r.text());
  fs.writeFileSync(`${OUT}/raw.html`, raw);
} catch (err) {
  console.log(`raw fetch failed: ${err.message}`);
}

const assetUrls = await page.evaluate(() => {
  const urls = new Set();
  for (const link of document.querySelectorAll('link[rel="stylesheet"]')) urls.add(link.href);
  for (const script of document.querySelectorAll('script[src]')) urls.add(script.src);
  return [...urls];
});

const manifest = [];
for (const url of assetUrls) {
  try {
    const res = await fetch(url);
    const body = await res.text();
    const name = path.basename(new URL(url).pathname) || 'asset';
    const safe = name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80);
    fs.writeFileSync(`${OUT}/assets/${safe}`, body);
    manifest.push({ url, file: `assets/${safe}`, bytes: body.length });
    console.log(`  asset ${safe} (${body.length}b)`);
  } catch (err) {
    manifest.push({ url, error: err.message });
  }
}

/* --------------------------------------------- inline <style> stylesheets */

const inlineStyles = await page.evaluate(() =>
  [...document.querySelectorAll('style')].map((s) => s.textContent).filter(Boolean));
if (inlineStyles.length) {
  fs.writeFileSync(`${OUT}/assets/inline-styles.css`, inlineStyles.join('\n\n/* --- next <style> --- */\n\n'));
  console.log(`  ${inlineStyles.length} inline <style> blocks`);
}

/* ------------------------------------------------- the design token tally */

const tokens = await page.evaluate(() => {
  const count = (map, key) => { if (key) map[key] = (map[key] || 0) + 1; };
  const bg = {}; const fg = {}; const fonts = {}; const sizes = {};
  const weights = {}; const radii = {}; const borders = {}; const shadows = {};
  const nodes = [...document.querySelectorAll('*')].slice(0, 4000);
  for (const node of nodes) {
    const cs = getComputedStyle(node);
    if (cs.backgroundColor && cs.backgroundColor !== 'rgba(0, 0, 0, 0)') count(bg, cs.backgroundColor);
    if (node.textContent && node.children.length === 0) {
      count(fg, cs.color);
      count(sizes, cs.fontSize);
      count(weights, cs.fontWeight);
    }
    count(fonts, cs.fontFamily);
    if (cs.borderRadius && cs.borderRadius !== '0px') count(radii, cs.borderRadius);
    if (cs.borderTopWidth !== '0px') count(borders, `${cs.borderTopWidth} ${cs.borderTopStyle} ${cs.borderTopColor}`);
    if (cs.boxShadow && cs.boxShadow !== 'none') count(shadows, cs.boxShadow);
  }
  const top = (map, n = 18) => Object.entries(map).sort((a, b) => b[1] - a[1]).slice(0, n)
    .map(([value, uses]) => ({ value, uses }));

  const rootVars = {};
  const rootStyle = document.documentElement.style;
  for (let i = 0; i < rootStyle.length; i += 1) {
    const prop = rootStyle[i];
    if (prop.startsWith('--')) rootVars[prop] = rootStyle.getPropertyValue(prop).trim();
  }
  // Custom properties declared in stylesheets, not just inline.
  for (const sheet of document.styleSheets) {
    try {
      for (const rule of sheet.cssRules) {
        if (rule.selectorText && /^(:root|html|body)\b/.test(rule.selectorText)) {
          for (let i = 0; i < rule.style.length; i += 1) {
            const prop = rule.style[i];
            if (prop.startsWith('--')) rootVars[prop] = rule.style.getPropertyValue(prop).trim();
          }
        }
      }
    } catch { /* cross-origin sheet */ }
  }

  const bodyCs = getComputedStyle(document.body);
  return {
    title: document.title,
    bodyBackground: bodyCs.backgroundColor,
    bodyColor: bodyCs.color,
    bodyFont: bodyCs.fontFamily,
    bodyFontSize: bodyCs.fontSize,
    cssCustomProperties: rootVars,
    backgrounds: top(bg),
    textColors: top(fg),
    fontFamilies: top(fonts, 8),
    fontSizes: top(sizes),
    fontWeights: top(weights, 8),
    borderRadii: top(radii, 10),
    borders: top(borders, 10),
    shadows: top(shadows, 8),
  };
});

/* ------------------------------------------------------------- structure */

const structure = await page.evaluate(() => {
  const describe = (node, depth) => {
    if (depth > 4) return null;
    const cs = getComputedStyle(node);
    const rect = node.getBoundingClientRect();
    if (rect.width < 2 && rect.height < 2) return null;
    return {
      tag: node.tagName.toLowerCase(),
      id: node.id || undefined,
      class: typeof node.className === 'string' && node.className ? node.className : undefined,
      text: node.children.length === 0 ? (node.textContent || '').trim().slice(0, 120) || undefined : undefined,
      box: { w: Math.round(rect.width), h: Math.round(rect.height) },
      display: cs.display,
      bg: cs.backgroundColor !== 'rgba(0, 0, 0, 0)' ? cs.backgroundColor : undefined,
      children: [...node.children].map((c) => describe(c, depth + 1)).filter(Boolean),
    };
  };
  return describe(document.body, 0);
});

const headings = await page.evaluate(() =>
  [...document.querySelectorAll('h1,h2,h3,h4,button,a,th,label')].slice(0, 120).map((n) => ({
    tag: n.tagName.toLowerCase(),
    text: (n.textContent || '').trim().slice(0, 90),
  })).filter((n) => n.text));

fs.writeFileSync(`${OUT}/tokens.json`, JSON.stringify(tokens, null, 2));
fs.writeFileSync(`${OUT}/structure.json`, JSON.stringify(structure, null, 2));
fs.writeFileSync(`${OUT}/headings.json`, JSON.stringify(headings, null, 2));
fs.writeFileSync(`${OUT}/manifest.json`, JSON.stringify({
  url: TARGET,
  status: response?.status(),
  capturedAt: new Date().toISOString(),
  pageErrors: console_errors,
  assets: manifest,
}, null, 2));

/* ----------------------------------------------------------- screenshots
   JPEG at modest quality: these have to be small enough to read back.     */

await page.screenshot({ path: `${OUT}/desktop-full.jpg`, type: 'jpeg', quality: 62, fullPage: true });
await page.screenshot({ path: `${OUT}/desktop-fold.jpg`, type: 'jpeg', quality: 80, fullPage: false });

const mobile = await context.newPage();
await mobile.setViewportSize({ width: 390, height: 844 });
await mobile.goto(TARGET, { waitUntil: 'networkidle', timeout: 60000 });
await mobile.waitForTimeout(1500);
await mobile.screenshot({ path: `${OUT}/mobile-full.jpg`, type: 'jpeg', quality: 62, fullPage: true });

await browser.close();

for (const file of fs.readdirSync(OUT)) {
  const stat = fs.statSync(path.join(OUT, file));
  if (stat.isFile()) console.log(`  ${file}: ${(stat.size / 1024).toFixed(0)} KB`);
}
console.log('reference capture complete');
