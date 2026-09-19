#!/usr/bin/env node
/**
 * Try candidate sources and measure the only thing that matters: how much of
 * what they return is somebody's opinion.
 *
 * The corpus is 1,249 items and 78% of them express no view, because 62% come
 * from Google News, which yields an opinion 7% of the time. Reddit yields one
 * 56% of the time off 89 items. Guessing which feeds to add would repeat that
 * mistake, so this fetches each candidate, runs the real classifier over it,
 * and prints the yield. Feeds that carry opinion get promoted into
 * config/sources.json; the rest are dropped with a number beside them.
 *
 *   node collector/sourcescout.mjs [--json out.json]
 */
import fs from 'node:fs';
import { getText, pace, stripHtml } from './lib/http.mjs';
import { classifyHeuristic } from './lib/classify.mjs';

const OUT = (process.argv.find((a) => a.startsWith('--json=')) || '').split('=')[1];

/* Candidates, grouped by the bet each one represents. */
const CANDIDATES = [
  // Practitioners writing at length. SAP Community is where SAP's own
  // ecosystem argues with itself, and it is missing entirely.
  ['sap-community-blogs', 'https://community.sap.com/t5/s/lpgnf16017/rss/Community?interaction.style=blog'],
  ['sap-community-alt', 'https://community.sap.com/khhcw49343/rss/Community?interaction.style=blog'],
  ['blogs-sap-legacy', 'https://blogs.sap.com/feed/'],
  ['news-google-community', 'https://news.google.com/rss/search?q=site:community.sap.com+AI+OR+Joule&hl=en-US&gl=US&ceid=US:en'],

  // Reddit is the best yielding source already; there is simply not enough of it.
  ['r/SAP-top', 'https://www.reddit.com/r/SAP/top/.rss?t=month'],
  ['r/SAP-joule', 'https://www.reddit.com/r/SAP/search.rss?q=Joule+OR+%22Business+Data+Cloud%22+OR+RPT&restrict_sr=1&sort=new'],
  ['r/SAP-rise', 'https://www.reddit.com/r/SAP/search.rss?q=RISE+OR+licensing+OR+S4HANA&restrict_sr=1&sort=new'],
  ['r/sap_basis', 'https://www.reddit.com/r/sap_basis/new/.rss'],
  ['r/ABAP', 'https://www.reddit.com/r/ABAP/new/.rss'],
  ['r/SAPBusinessOne', 'https://www.reddit.com/r/SAPBusinessOne/new/.rss'],
  ['r/ERP-ai', 'https://www.reddit.com/r/ERP/search.rss?q=AI+OR+SAP&restrict_sr=1&sort=new'],
  ['r/dataengineering-sap', 'https://www.reddit.com/r/dataengineering/search.rss?q=SAP+OR+Datasphere&restrict_sr=1&sort=new'],
  ['r/BusinessIntelligence-sap', 'https://www.reddit.com/r/BusinessIntelligence/search.rss?q=SAP&restrict_sr=1&sort=new'],
  ['r/sysadmin-sap', 'https://www.reddit.com/r/sysadmin/search.rss?q=SAP&restrict_sr=1&sort=new'],
  ['r/consulting-comments', 'https://www.reddit.com/r/consulting/comments/.rss'],
  ['r/ERP-comments', 'https://www.reddit.com/r/ERP/comments/.rss'],

  // dev.to yields an opinion three times in four, off twelve items.
  ['devto-abap', 'https://dev.to/feed/tag/abap'],
  ['devto-erp', 'https://dev.to/feed/tag/erp'],
  ['devto-sapbtp', 'https://dev.to/feed/tag/sapbtp'],
  ['devto-hana', 'https://dev.to/feed/tag/hana'],
  ['devto-cap', 'https://dev.to/feed/tag/cap'],

  // Untried publics that cost nothing to ask.
  ['mastodon-sap', 'https://mastodon.social/tags/SAP.rss'],
  ['mastodon-s4hana', 'https://mastodon.social/tags/S4HANA.rss'],
  ['fosstodon-sap', 'https://fosstodon.org/tags/SAP.rss'],
  ['so-tag-sap', 'https://stackoverflow.com/feeds/tag/sap'],
  ['so-tag-abap', 'https://stackoverflow.com/feeds/tag/abap'],
  ['so-tag-sap-btp', 'https://stackoverflow.com/feeds/tag/sap-cloud-platform'],
  ['medium-s4hana', 'https://medium.com/feed/tag/s4hana'],
  ['medium-sap-ai', 'https://medium.com/feed/tag/sap-ai'],
  ['medium-joule', 'https://medium.com/feed/tag/joule'],
  ['hashnode-sap', 'https://hashnode.com/n/sap/rss'],
  ['lobsters-erp', 'https://lobste.rs/t/business.rss'],

  // Trade press that runs comment sections and opinion columns.
  ['theregister-sap', 'https://www.theregister.com/software/erp/headlines.atom'],
  ['diginomica-sap', 'https://diginomica.com/tags/sap/feed'],
  ['erptoday-ai', 'https://erp.today/tag/artificial-intelligence/feed/'],
  ['cio-erp', 'https://www.cio.com/tag/erp/feed/'],
  ['computerweekly-erp', 'https://www.computerweekly.com/rss/Enterprise-software.xml'],
  ['itpro-sap', 'https://www.itpro.com/feeds/tag/sap'],
  ['sapinsider', 'https://sapinsider.org/feed/'],
];

const tag = (block, name) => {
  const m = block.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, 'i'));
  return m ? m[1] : '';
};
const clean = (v) => stripHtml(v.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1'));

function parseFeed(xml) {
  const blocks = [
    ...xml.matchAll(/<item[\s>][\s\S]*?<\/item>/gi),
    ...xml.matchAll(/<entry[\s>][\s\S]*?<\/entry>/gi),
  ].map((m) => m[0]);
  return blocks.map((block) => {
    let link = clean(tag(block, 'link'));
    if (!link) {
      const href = block.match(/<link[^>]*href=["']([^"']+)["']/i);
      link = href ? href[1] : '';
    }
    return {
      title: clean(tag(block, 'title')),
      url: link,
      date: clean(tag(block, 'pubDate')) || clean(tag(block, 'published'))
        || clean(tag(block, 'updated')) || clean(tag(block, 'dc:date')),
      text: clean(tag(block, 'content:encoded')) || clean(tag(block, 'description'))
        || clean(tag(block, 'summary')) || clean(tag(block, 'content')),
    };
  });
}

// Anything that never mentions SAP is noise however opinionated it is.
const ON_TOPIC = /\bSAP\b|S\/?4HANA|HANA|ABAP|Joule|Datasphere|BTP|Ariba|SuccessFactors|Fieldglass|Concur|RISE with/i;

const results = [];
for (const [name, url] of CANDIDATES) {
  await pace(/reddit\.com/i.test(url) ? 12000 : 700);
  const row = { name, url, ok: false, items: 0, dated: 0, onTopic: 0, opinions: 0, note: '', sample: [] };
  try {
    const xml = await getText(url, undefined, { retries: 1, timeoutMs: 20000, backoffMs: 3000 });
    const entries = parseFeed(xml).filter((e) => e.title);
    row.items = entries.length;
    if (!entries.length) row.note = xml.slice(0, 60).replace(/\s+/g, ' ');
    row.dated = entries.filter((e) => e.date && !Number.isNaN(Date.parse(e.date))).length;
    const topical = entries.filter((e) => ON_TOPIC.test(`${e.title} ${e.text}`));
    row.onTopic = topical.length;
    const scored = classifyHeuristic(topical.map((e) => ({ ...e, sourceLabel: name, kind: 'article' })));
    const withView = scored.filter((s) => s.stance !== 'neutral');
    row.opinions = withView.length;
    row.sample = withView.slice(0, 2).map((s) => `${s.stance}: ${s.title.slice(0, 70)}`);
    row.ok = true;
  } catch (err) {
    row.note = String(err.message || err).slice(0, 70);
  }
  results.push(row);
  const rate = row.onTopic ? `${Math.round((100 * row.opinions) / row.onTopic)}%` : '—';
  console.log(
    `${row.ok ? 'OK  ' : 'FAIL'} ${name.padEnd(28)}`
    + `${String(row.items).padStart(4)} items ${String(row.onTopic).padStart(4)} on-topic `
    + `${String(row.opinions).padStart(3)} opinions ${rate.padStart(5)}`
    + `${row.note ? `  ${row.note}` : ''}`,
  );
  for (const s of row.sample) console.log(`       ${s}`);
}

const keep = results.filter((r) => r.ok && r.opinions >= 2).sort((a, b) => b.opinions - a.opinions);
console.log(`\nWORTH ADDING (2+ opinions in one fetch): ${keep.length} of ${CANDIDATES.length}`);
for (const r of keep) console.log(`  ${String(r.opinions).padStart(3)} opinions / ${String(r.onTopic).padStart(3)} on-topic   ${r.name}`);

if (OUT) fs.writeFileSync(OUT, `${JSON.stringify(results, null, 2)}\n`);
