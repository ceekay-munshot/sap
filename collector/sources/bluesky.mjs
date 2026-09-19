import { getJson, pace, truncate } from '../lib/http.mjs';

export const id = 'bluesky';
export const label = 'Bluesky';

/**
 * Where a lot of the enterprise-tech conversation moved. The public search
 * endpoint needs no account and no key, and unlike news feeds the posts are
 * people saying what they think.
 */
export async function collect(cfg) {
  const items = [];
  const errors = [];

  for (const query of cfg.queries || []) {
    try {
      const url = 'https://public.api.bsky.app/xrpc/app.bsky.feed.searchPosts'
        + `?q=${encodeURIComponent(query)}&limit=${cfg.perQuery || 40}&sort=latest`;
      const data = await getJson(url);
      for (const post of data?.posts || []) {
        const text = post.record?.text;
        if (!text) continue;
        const rkey = String(post.uri || '').split('/').pop();
        const handle = post.author?.handle;
        items.push({
          id: `bsky:${post.uri}`,
          source: id,
          sourceLabel: label,
          kind: 'comment',
          author: post.author?.displayName || handle || null,
          title: '',
          text: truncate(text),
          url: handle && rkey ? `https://bsky.app/profile/${handle}/post/${rkey}` : null,
          date: post.record?.createdAt || post.indexedAt || null,
          engagement: (post.likeCount || 0) + (post.replyCount || 0),
          query,
        });
      }
    } catch (err) {
      errors.push(`${query}: ${err.message}`);
    }
    await pace(700);
  }

  if (errors.length) items.errors = errors;
  return items;
}
