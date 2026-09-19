/**
 * POST /api/research — start an ad-hoc research run.
 *
 * A Cloudflare Pages Function, so it deploys with the site and shares its
 * origin. The page cannot hold a GitHub token; this can.
 *
 * It does not run the research itself: a pass makes a dozen web fetches and a
 * long model call, which outlives a function invocation. It starts the Actions
 * workflow that does, and /api/status reports progress.
 *
 * Environment (Cloudflare Pages → Settings → Environment variables):
 *   GITHUB_TOKEN          required — fine-grained PAT, this repo, Actions: read and write
 *   GITHUB_REPO           optional — defaults to ceekay-munshot/sap
 *   RESEARCH_PASSPHRASE   optional — when set, callers must supply it
 *   MIN_MINUTES_BETWEEN   optional — cooldown between runs, default 10
 */

const DEFAULT_REPO = 'ceekay-munshot/sap';
const WORKFLOW = 'research.yml';

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });

/** Constant-time compare so the passphrase cannot be guessed a character at a time. */
function safeEqual(a, b) {
  const x = new TextEncoder().encode(String(a ?? ''));
  const y = new TextEncoder().encode(String(b ?? ''));
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i += 1) diff |= x[i] ^ y[i];
  return diff === 0;
}

function gh(env) {
  return {
    repo: env.GITHUB_REPO || DEFAULT_REPO,
    headers: {
      authorization: `Bearer ${env.GITHUB_TOKEN}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'sap-ai-intelligence',
      'content-type': 'application/json',
    },
  };
}

export async function onRequestPost({ request, env }) {
  if (!env.GITHUB_TOKEN) {
    return json({ error: 'This dashboard is not configured to run research yet.' }, 503);
  }

  let body = {};
  try { body = await request.json(); } catch { /* empty body is fine */ }

  if (env.RESEARCH_PASSPHRASE && !safeEqual(body.passphrase, env.RESEARCH_PASSPHRASE)) {
    return json({ error: 'Wrong passphrase.', needsPassphrase: true }, 401);
  }

  const topic = String(body.topic || '').trim();
  if (topic && !/^[a-z0-9_]{1,40}$/.test(topic)) {
    return json({ error: 'Unknown topic.' }, 400);
  }

  const { repo, headers } = gh(env);

  // Spend control without extra storage: GitHub itself remembers the last run.
  // Refuse while one is in flight, and for a short cooldown after the last.
  const cooldown = Number(env.MIN_MINUTES_BETWEEN || 10);
  try {
    const res = await fetch(
      `https://api.github.com/repos/${repo}/actions/workflows/${WORKFLOW}/runs?per_page=1`,
      { headers },
    );
    if (res.ok) {
      const latest = (await res.json()).workflow_runs?.[0];
      if (latest && latest.status !== 'completed') {
        return json({ status: 'already_running', runId: latest.id });
      }
      if (latest?.updated_at) {
        const sinceMin = (Date.now() - new Date(latest.updated_at).getTime()) / 60000;
        if (sinceMin < cooldown) {
          return json({
            error: `A run finished ${Math.round(sinceMin)} min ago. `
              + `Please wait ${Math.ceil(cooldown - sinceMin)} more min.`,
          }, 429);
        }
      }
    }
  } catch { /* if the check fails, fall through and let the dispatch decide */ }

  const dispatch = await fetch(
    `https://api.github.com/repos/${repo}/actions/workflows/${WORKFLOW}/dispatches`,
    {
      method: 'POST',
      headers,
      body: JSON.stringify({
        ref: env.GITHUB_BRANCH || 'main',
        inputs: topic ? { only: topic } : {},
      }),
    },
  );

  if (dispatch.status !== 204) {
    const detail = await dispatch.text();
    return json({ error: 'Could not start the run.', detail: detail.slice(0, 200) }, 502);
  }
  return json({ status: 'started', topic: topic || 'all' });
}

export const onRequestOptions = () =>
  new Response(null, { headers: { allow: 'POST, OPTIONS' } });
