import { getText, pace, stripHtml, truncate } from '../lib/http.mjs';

export const id = 'rss';
export const label = 'Press & vendor feeds';

const tag = (block, name) => {
  const m = block.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, 'i'));
  return m ? m[1] : '';
};
const clean = (v) => stripHtml(v.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1'));

/** Minimal RSS/Atom reader — no parser dependency, tolerant of malformed feeds. */
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
    const date =
      clean(tag(block, 'pubDate')) ||
      clean(tag(block, 'published')) ||
      clean(tag(block, 'updated')) ||
      clean(tag(block, 'dc:date'));
    const body =
      clean(tag(block, 'content:encoded')) ||
      clean(tag(block, 'description')) ||
      clean(tag(block, 'summary')) ||
      clean(tag(block, 'content'));
    return {
      title: clean(tag(block, 'title')),
      link,
      date,
      body,
      guid: clean(tag(block, 'guid')) || clean(tag(block, 'id')) || link,
    };
  });
}

/** Reddit rate-limits hard; space requests to the same host rather than racing them. */
const HOST_DELAY = [
  [/reddit\.com/i, 12000],
  [/news\.google\.com/i, 600],
];
const delayFor = (url) => {
  for (const [pattern, ms] of HOST_DELAY) if (pattern.test(url)) return ms;
  return 400;
};

/**
 * CI runners share addresses, so Reddit throttles them hard. Its 429s clear
 * with patience rather than with a different request, so back off much further
 * than the default before giving up on a feed.
 */
const retryFor = (url) => (/reddit\.com/i.test(url)
  ? { retries: 3, backoffMs: 15000, timeoutMs: 25000 }
  : undefined);

export async function collect(cfg) {
  const items = [];
  const errors = [];
  for (const feed of cfg.feeds) {
    try {
      const xml = await getText(feed.url, undefined, retryFor(feed.url));
      for (const entry of parseFeed(xml)) {
        if (!entry.title && !entry.body) continue;
        const parsed = entry.date ? new Date(entry.date) : null;
        items.push({
          id: `rss:${feed.id}:${entry.guid || entry.link || entry.title}`,
          source: id,
          sourceLabel: feed.label,
          kind: 'article',
          author: null,
          title: entry.title,
          text: truncate(entry.body || entry.title),
          url: entry.link || null,
          date: parsed && !Number.isNaN(parsed.getTime()) ? parsed.toISOString() : null,
          engagement: 0,
          stance: feed.stance || 'press',
        });
      }
    } catch (err) {
      errors.push(`${feed.id}: ${err.message}`);
    }
    await pace(delayFor(feed.url));
  }
  if (errors.length) items.errors = errors;
  return items;
}
