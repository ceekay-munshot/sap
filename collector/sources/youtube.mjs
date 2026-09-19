import { getJson, pace, truncate } from '../lib/http.mjs';

export const id = 'youtube';
export const label = 'YouTube comments';

/**
 * Conference talks and product demos draw exactly the audience we want:
 * consultants and customer-side engineers arguing in the comments.
 * Needs a YOUTUBE_API_KEY; skipped entirely without one.
 */
export async function collect(cfg) {
  const key = process.env.YOUTUBE_API_KEY;
  if (!key) return [];
  const items = [];

  for (const query of cfg.queries) {
    const searchUrl = `https://www.googleapis.com/youtube/v3/search?part=snippet&type=video`
      + `&order=date&maxResults=${cfg.maxVideosPerQuery || 5}`
      + `&q=${encodeURIComponent(query)}&key=${key}`;
    const search = await getJson(searchUrl);
    for (const video of search.items || []) {
      const videoId = video.id?.videoId;
      if (!videoId) continue;
      try {
        const commentsUrl = `https://www.googleapis.com/youtube/v3/commentThreads?part=snippet`
          + `&videoId=${videoId}&maxResults=${Math.min(cfg.maxCommentsPerVideo || 100, 100)}`
          + `&order=relevance&textFormat=plainText&key=${key}`;
        const comments = await getJson(commentsUrl);
        for (const thread of comments.items || []) {
          const c = thread.snippet?.topLevelComment?.snippet;
          if (!c?.textDisplay) continue;
          items.push({
            id: `yt:${thread.id}`,
            source: id,
            sourceLabel: label,
            kind: 'comment',
            author: c.authorDisplayName || null,
            title: video.snippet?.title || '',
            text: truncate(c.textDisplay),
            url: `https://www.youtube.com/watch?v=${videoId}&lc=${thread.id}`,
            date: c.publishedAt || null,
            engagement: c.likeCount || 0,
          });
        }
      } catch {
        // Comments disabled on a video is normal; keep going.
      }
      await pace(300);
    }
    await pace(500);
  }
  return items;
}
