/**
 * Research trigger — the paid path's front door.
 *
 * The dashboard is static, so it cannot hold an Anthropic key: anything shipped
 * to the browser is public. This Worker holds the credentials instead.
 *
 * It does NOT call Anthropic itself. A research pass makes a dozen web searches
 * and runs for minutes, which outlives a Worker invocation. Instead it triggers
 * the GitHub Actions workflow that already does that job, which commits the
 * result and republishes the site. The Worker's whole role is to be the guarded
 * button: check the passphrase, check the budget, fire the workflow.
 *
 * Secrets (wrangler secret put ...):
 *   RESEARCH_PASSPHRASE  shared secret the page must present
 *   GITHUB_TOKEN         fine-grained PAT with Actions: read and write
 * Vars (wrangler.toml):
 *   GITHUB_REPO, ALLOWED_ORIGIN, DAILY_LIMIT
 * Optional binding:
 *   BUDGET (KV namespace) — enforces DAILY_LIMIT; without it the cap is skipped
 */

const WORKFLOW = 'research.yml';

function cors(env, extra = {}) {
  return {
    'access-control-allow-origin': env.ALLOWED_ORIGIN || '*',
    'access-control-allow-methods': 'POST, OPTIONS',
    'access-control-allow-headers': 'content-type',
    'access-control-max-age': '86400',
    ...extra,
  };
}

const json = (env, body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...cors(env) },
  });

/** Constant-time compare so the passphrase can't be guessed a character at a time. */
function safeEqual(a, b) {
  const x = new TextEncoder().encode(String(a ?? ''));
  const y = new TextEncoder().encode(String(b ?? ''));
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i += 1) diff |= x[i] ^ y[i];
  return diff === 0;
}

/** A public button spends real money, so cap the number of runs per day. */
async function checkBudget(env) {
  const limit = Number(env.DAILY_LIMIT || 5);
  if (!env.BUDGET) return { ok: true, used: null, limit, enforced: false };
  const key = `runs:${new Date().toISOString().slice(0, 10)}`;
  const used = Number((await env.BUDGET.get(key)) || 0);
  if (used >= limit) return { ok: false, used, limit, enforced: true };
  // Expire a day after the day ends, so old counters clean themselves up.
  await env.BUDGET.put(key, String(used + 1), { expirationTtl: 172800 });
  return { ok: true, used: used + 1, limit, enforced: true };
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors(env) });

    const url = new URL(request.url);
    if (url.pathname !== '/api/research') return json(env, { error: 'not found' }, 404);
    if (request.method !== 'POST') return json(env, { error: 'method not allowed' }, 405);

    if (!env.RESEARCH_PASSPHRASE || !env.GITHUB_TOKEN || !env.GITHUB_REPO) {
      return json(env, { error: 'worker is not configured' }, 500);
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return json(env, { error: 'expected JSON' }, 400);
    }

    if (!safeEqual(body.passphrase, env.RESEARCH_PASSPHRASE)) {
      return json(env, { error: 'wrong passphrase' }, 401);
    }

    // Only ids the dashboard actually knows about reach the workflow input.
    const topic = String(body.topic || '').trim();
    if (topic && !/^[a-z0-9_]{1,40}$/.test(topic)) {
      return json(env, { error: 'bad topic id' }, 400);
    }

    const budget = await checkBudget(env);
    if (!budget.ok) {
      return json(env, {
        error: `daily limit reached (${budget.used}/${budget.limit} runs today)`,
      }, 429);
    }

    const res = await fetch(
      `https://api.github.com/repos/${env.GITHUB_REPO}/actions/workflows/${WORKFLOW}/dispatches`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${env.GITHUB_TOKEN}`,
          accept: 'application/vnd.github+json',
          'x-github-api-version': '2022-11-28',
          'user-agent': 'sap-ai-intelligence-worker',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          ref: env.GITHUB_BRANCH || 'main',
          inputs: topic ? { only: topic } : {},
        }),
      },
    );

    if (res.status !== 204) {
      const detail = await res.text();
      return json(env, { error: 'could not start the run', status: res.status, detail: detail.slice(0, 300) }, 502);
    }

    return json(env, {
      status: 'started',
      topic: topic || 'all',
      runsToday: budget.used,
      dailyLimit: budget.limit,
      budgetEnforced: budget.enforced,
      note: 'Research runs in GitHub Actions and takes a few minutes. '
        + 'The page updates once the result is committed and republished.',
    });
  },
};
