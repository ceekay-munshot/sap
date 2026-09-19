import { getJson, pace, truncate } from '../lib/http.mjs';

export const id = 'github';
export const label = 'GitHub';

/**
 * Developers complain in issues before they blog about it, so this is the
 * earliest honest signal on the BTP and agent tooling. Uses the token the
 * workflow already has; without one GitHub's search rate limit is too low to
 * be useful, so the source skips rather than half-working.
 */
export async function collect(cfg) {
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (!token) return [];

  const items = [];
  const errors = [];
  const headers = {
    authorization: `Bearer ${token}`,
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
  };

  for (const query of cfg.queries || []) {
    try {
      const url = 'https://api.github.com/search/issues'
        + `?q=${encodeURIComponent(query)}&sort=updated&order=desc&per_page=${cfg.perQuery || 25}`;
      const data = await getJson(url, { headers });
      for (const issue of data?.items || []) {
        const body = issue.body || '';
        if (!issue.title) continue;
        items.push({
          id: `gh:${issue.id}`,
          source: id,
          sourceLabel: label,
          kind: issue.pull_request ? 'pull request' : 'issue',
          author: issue.user?.login || null,
          title: issue.title,
          text: truncate(body || issue.title),
          url: issue.html_url,
          date: issue.created_at || null,
          engagement: issue.comments || 0,
          query,
        });
      }
    } catch (err) {
      errors.push(`${query}: ${err.message}`);
    }
    await pace(2500);   // GitHub search is rate-limited separately and tightly
  }

  if (errors.length) items.errors = errors;
  return items;
}
