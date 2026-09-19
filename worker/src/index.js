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

const FRIENDLY = [
  [/checkout|set up job|setup node|install/i, 'Preparing'],
  [/self-?test/i, 'Checking the pipeline'],
  [/research/i, 'Searching the web and reading sources'],
  [/commit/i, 'Saving the results'],
  [/upload|summary|post |complete/i, 'Finishing up'],
];

const friendly = (name) => {
  for (const [pattern, label] of FRIENDLY) if (pattern.test(name)) return label;
  return name;
};

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors(env) });

    const url = new URL(request.url);

    // GET /api/status
    if (url.pathname === '/api/status' && request.method === 'GET') {
      if (!env.GITHUB_TOKEN || !env.GITHUB_REPO) {
        return json(env, { configured: false });
      }
      const runIdParam = url.searchParams.get('run_id') || url.searchParams.get('runId');
      const headers = {
        authorization: `Bearer ${env.GITHUB_TOKEN}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'user-agent': 'sap-ai-intelligence-worker',
      };
      try {
        let run = null;
        if (runIdParam && /^\d+$/.test(runIdParam)) {
          const runRes = await fetch(`https://api.github.com/repos/${env.GITHUB_REPO}/actions/runs/${runIdParam}`, { headers });
          if (!runRes.ok) return json(env, { configured: true, state: 'unknown' }, 502);
          run = await runRes.json();
        } else {
          const runsRes = await fetch(
            `https://api.github.com/repos/${env.GITHUB_REPO}/actions/workflows/${WORKFLOW}/runs?per_page=1`,
            { headers },
          );
          if (!runsRes.ok) return json(env, { configured: true, state: 'unknown' }, 502);
          run = (await runsRes.json()).workflow_runs?.[0];
        }

        if (!run) return json(env, { configured: true, state: 'idle' });

        let state = 'unknown';
        if (run.status === 'queued' || run.status === 'waiting') state = 'queued';
        else if (run.status === 'in_progress') state = 'running';
        else if (run.status === 'completed') {
          if (run.conclusion === 'success') state = 'succeeded';
          else if (run.conclusion === 'failure') state = 'failed';
          else if (run.conclusion === 'cancelled') state = 'cancelled';
          else if (run.conclusion === 'timed_out') state = 'timed_out';
          else state = 'failed';
        }

        const payload = {
          configured: true,
          state,
          conclusion: run.conclusion || null,
          runId: run.id,
          htmlUrl: run.html_url,
          startedAt: run.run_started_at || run.created_at,
          updatedAt: run.updated_at,
          step: null,
          stepIndex: 0,
          stepTotal: 0,
        };

        if (run.status !== 'completed') {
          const jobsRes = await fetch(
            `https://api.github.com/repos/${env.GITHUB_REPO}/actions/runs/${run.id}/jobs`, { headers },
          );
          if (jobsRes.ok) {
            const job = (await jobsRes.json()).jobs?.[0];
            const steps = job?.steps || [];
            const current = steps.find((s) => s.status === 'in_progress')
              || [...steps].reverse().find((s) => s.status === 'completed');
            if (current) {
              payload.step = friendly(current.name);
              payload.stepIndex = steps.indexOf(current) + 1;
              payload.stepTotal = steps.length;
            }
          }
        }
        return json(env, payload);
      } catch (err) {
        return json(env, { configured: true, state: 'unknown', error: String(err.message || err) }, 502);
      }
    }

    if (url.pathname !== '/api/research') return json(env, { error: 'not found' }, 404);
    if (request.method !== 'POST') return json(env, { error: 'method not allowed' }, 405);

    if (!env.RESEARCH_PASSPHRASE || !env.GITHUB_TOKEN || !env.GITHUB_REPO) {
      return json(env, { error: 'worker is not configured' }, 500);
    }

    let body;
    try {
      body = await request.json();
      if (typeof body !== 'object' || body === null || Array.isArray(body)) {
        return json(env, { error: 'expected JSON object' }, 400);
      }
    } catch {
      return json(env, { error: 'expected JSON' }, 400);
    }

    if (!safeEqual(body.passphrase, env.RESEARCH_PASSPHRASE)) {
      return json(env, { error: 'wrong passphrase', needsPassphrase: true }, 401);
    }

    // Only ids the dashboard actually knows about reach the workflow input.
    const topic = String(body.topic || '').trim();
    if (topic && !/^[a-z0-9_-]{1,40}$/.test(topic)) {
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

    if (res.status !== 204 && res.status !== 200 && res.status !== 201) {
      const detail = await res.text();
      return json(env, { error: 'could not start the run', status: res.status, detail: detail.slice(0, 300) }, 502);
    }

    let runId = null;
    try {
      const rRes = await fetch(
        `https://api.github.com/repos/${env.GITHUB_REPO}/actions/workflows/${WORKFLOW}/runs?per_page=1`,
        {
          headers: {
            authorization: `Bearer ${env.GITHUB_TOKEN}`,
            accept: 'application/vnd.github+json',
            'x-github-api-version': '2022-11-28',
            'user-agent': 'sap-ai-intelligence-worker',
          },
        },
      );
      if (rRes.ok) {
        const latest = (await rRes.json()).workflow_runs?.[0];
        if (latest) runId = latest.id;
      }
    } catch {}

    return json(env, {
      status: 'started',
      topic: topic || 'all',
      runId,
      runsToday: budget.used,
      dailyLimit: budget.limit,
      budgetEnforced: budget.enforced,
      note: 'Research runs in GitHub Actions and takes a few minutes. '
        + 'The page updates once the result is committed and republished.',
    });
  },
};
