/**
 * GET /api/data — serve the latest dashboard dataset directly from GitHub.
 *
 * Bypasses Cloudflare Pages static asset CDN caching and deployment delays
 * so any browser requesting the latest data gets it immediately upon git push.
 */

const DEFAULT_REPO = 'ceekay-munshot/sap';

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'no-store, no-cache, must-revalidate',
      'access-control-allow-origin': '*',
    },
  });

export async function onRequestGet({ env }) {
  const repo = env.GITHUB_REPO || DEFAULT_REPO;
  const headers = {
    accept: 'application/vnd.github.raw+json',
    'x-github-api-version': '2022-11-28',
    'user-agent': 'sap-ai-intelligence',
    ...(env.GITHUB_TOKEN ? { authorization: `Bearer ${env.GITHUB_TOKEN}` } : {}),
  };

  try {
    const res = await fetch(`https://api.github.com/repos/${repo}/contents/web/data/dashboard.json?ref=main`, { headers });
    if (res.ok) {
      const data = await res.json();
      return json(data);
    }
  } catch {}

  // Fallback to raw github
  try {
    const res = await fetch(`https://raw.githubusercontent.com/${repo}/main/web/data/dashboard.json?t=${Date.now()}`);
    if (res.ok) {
      const data = await res.json();
      return json(data);
    }
  } catch {}

  return json({ error: 'Could not fetch live dashboard data' }, 502);
}
