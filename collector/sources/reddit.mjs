import { getJson, fetchWithRetry, pace, truncate, USER_AGENT } from '../lib/http.mjs';

export const id = 'reddit';
export const label = 'Reddit';

/**
 * Reddit blocks datacenter IPs on the anonymous .json endpoints more often than not.
 * With REDDIT_CLIENT_ID / REDDIT_CLIENT_SECRET set (a free "script" app), we use the
 * official OAuth API instead, which works fine from CI.
 */
async function getToken() {
  const clientId = process.env.REDDIT_CLIENT_ID;
  const clientSecret = process.env.REDDIT_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;
  const res = await fetchWithRetry('https://www.reddit.com/api/v1/access_token', {
    method: 'POST',
    headers: {
      authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
      'content-type': 'application/x-www-form-urlencoded',
      'user-agent': USER_AGENT,
    },
    body: 'grant_type=client_credentials',
  });
  const json = await res.json();
  return json.access_token || null;
}

function normalise(post, kind) {
  const d = post.data || post;
  const body = d.selftext || d.body || '';
  const title = d.title || '';
  if (!body && !title) return null;
  return {
    id: `reddit:${d.name || d.id}`,
    source: id,
    sourceLabel: `r/${d.subreddit || 'unknown'}`,
    kind,
    author: d.author || null,
    title,
    text: truncate(body || title),
    url: d.permalink ? `https://www.reddit.com${d.permalink}` : d.url || null,
    date: d.created_utc ? new Date(d.created_utc * 1000).toISOString() : null,
    engagement: d.score || 0,
    subreddit: d.subreddit || null,
  };
}

export async function collect(cfg) {
  const token = await getToken();
  const base = token ? 'https://oauth.reddit.com' : 'https://www.reddit.com';
  const headers = token ? { authorization: `Bearer ${token}` } : {};
  const suffix = token ? '' : '.json';
  const items = [];
  const postIds = [];

  for (const sub of cfg.subreddits) {
    for (const listing of cfg.listings || ['new']) {
      const url = `${base}/r/${sub}/${listing}${suffix}?limit=${cfg.limit || 100}`
        + (listing === 'top' ? '&t=year' : '');
      const data = await getJson(url, { headers });
      for (const child of data?.data?.children || []) {
        const item = normalise(child, 'post');
        if (item) {
          items.push(item);
          if ((child.data?.num_comments || 0) > 3) postIds.push({ sub, id: child.data.id });
        }
      }
      await pace(700);
    }
    for (const query of cfg.queries || []) {
      const url = `${base}/r/${sub}/search${suffix}?q=${encodeURIComponent(query)}`
        + `&restrict_sr=1&sort=new&limit=${cfg.limit || 100}`;
      const data = await getJson(url, { headers });
      for (const child of data?.data?.children || []) {
        const item = normalise(child, 'post');
        if (item) items.push(item);
      }
      await pace(700);
    }
  }

  // The opinions live in the comments; pull them for the busiest threads only.
  for (const { sub, id: postId } of postIds.slice(0, cfg.maxCommentThreads || 40)) {
    try {
      const url = `${base}/r/${sub}/comments/${postId}${suffix}?limit=100&depth=2`;
      const data = await getJson(url, { headers });
      const listing = Array.isArray(data) ? data[1] : null;
      for (const child of listing?.data?.children || []) {
        if (child.kind !== 't1') continue;
        const item = normalise(child, 'comment');
        if (item) items.push(item);
      }
      await pace(700);
    } catch {
      // A single unavailable thread is not a run failure.
    }
  }
  return items;
}
