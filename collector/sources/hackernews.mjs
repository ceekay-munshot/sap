import { getJson, pace, truncate } from '../lib/http.mjs';

export const id = 'hackernews';
export const label = 'Hacker News';

/** Algolia's HN API: public, no key, generous limits. */
export async function collect(cfg) {
  const items = [];
  for (const query of cfg.queries) {
    const url = `https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(query)}`
      + `&tags=(story,comment)&hitsPerPage=${cfg.hitsPerQuery || 50}`;
    const data = await getJson(url);
    for (const hit of data.hits || []) {
      const text = hit.comment_text || hit.story_text || '';
      const title = hit.title || hit.story_title || '';
      if (!text && !title) continue;
      items.push({
        id: `hn:${hit.objectID}`,
        source: id,
        sourceLabel: label,
        kind: hit.comment_text ? 'comment' : 'post',
        author: hit.author || null,
        title,
        text: truncate(text || title),
        url: hit.url || `https://news.ycombinator.com/item?id=${hit.objectID}`,
        date: hit.created_at || null,
        engagement: hit.points || hit.num_comments || 0,
        query,
      });
    }
    await pace();
  }
  return items;
}
