import { getText, pace, stripHtml, truncate } from '../lib/http.mjs';

export const id = 'vendorpages';
export const label = 'SAP product pages';

/**
 * SAP's own claims, tracked so the dashboard can set them against what
 * practitioners report. Always scored as voice "vendor", so this never moves
 * the practitioner index — it is the control, not the signal.
 *
 * The learning.sap.com course the brief mentions sits behind a login and is not
 * fetched: authenticated scraping is out of scope here. Its public product pages
 * carry the same positioning.
 */
export async function collect(cfg) {
  const items = [];
  const errors = [];
  for (const page of cfg.pages || []) {
    try {
      const html = await getText(page.url);
      const title = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || page.label;
      const body = stripHtml(html);
      if (!body) continue;
      items.push({
        id: `vendor:${page.id}:${new Date().toISOString().slice(0, 7)}`, // monthly snapshot
        source: id,
        sourceLabel: page.label,
        kind: 'article',
        stance: 'vendor',
        author: 'SAP',
        title: stripHtml(title),
        text: truncate(body, 2000),
        url: page.url,
        date: new Date().toISOString(),
        engagement: 0,
      });
    } catch (err) {
      errors.push(`${page.id}: ${err.message}`);
    }
    await pace(600);
  }
  if (errors.length) items.errors = errors;
  return items;
}
