import { getJson, pace, stripHtml, truncate } from '../lib/http.mjs';

export const id = 'stackexchange';
export const label = 'Stack Overflow';

export async function collect(cfg) {
  const items = [];
  const key = process.env.STACKEXCHANGE_KEY ? `&key=${process.env.STACKEXCHANGE_KEY}` : '';
  for (const query of cfg.queries) {
    const url = `https://api.stackexchange.com/2.3/search/advanced?order=desc&sort=creation`
      + `&q=${encodeURIComponent(query)}&site=${cfg.site || 'stackoverflow'}`
      + `&pagesize=${cfg.pageSize || 50}&filter=withbody${key}`;
    const data = await getJson(url);
    for (const q of data.items || []) {
      items.push({
        id: `se:${q.question_id}`,
        source: id,
        sourceLabel: label,
        kind: 'question',
        author: q.owner?.display_name || null,
        title: q.title || '',
        text: truncate(stripHtml(q.body || q.title)),
        url: q.link || null,
        date: q.creation_date ? new Date(q.creation_date * 1000).toISOString() : null,
        engagement: q.score || 0,
        answered: Boolean(q.is_answered),
        query,
      });
    }
    await pace(500);
  }
  return items;
}
