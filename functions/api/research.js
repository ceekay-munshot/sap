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

  /**
   * A readiness probe must never start a paid run, so it never dispatches for
   * real. It answers the three things that can break the button, in order:
   * can the token see the workflow, does the branch it would run on exist,
   * and may the token start runs at all.
   *
   * The last one has no read-only equivalent, so it asks GitHub to dispatch a
   * ref that cannot exist. A token allowed to start runs gets 422 (no such
   * ref) and nothing runs; one that is not gets 401, 403 or 404 first. The
   * refusal is the answer.
   */
  if (body.probe === true) {
    const branch = env.GITHUB_BRANCH || 'main';
    const checks = {};
    const ask = async (label, url, init) => {
      try {
        const res = await fetch(url, init);
        checks[label] = { status: res.status, detail: res.ok ? '' : (await res.text()).slice(0, 160) };
        return res.status;
      } catch (err) {
        checks[label] = { status: 0, detail: String(err.message || err).slice(0, 160) };
        return 0;
      }
    };

    const base = `https://api.github.com/repos/${repo}`;
    const seen = await ask('workflow', `${base}/actions/workflows/${WORKFLOW}`, { headers });
    const ref = await ask('branch', `${base}/branches/${encodeURIComponent(branch)}`, { headers });
    const may = await ask('dispatch', `${base}/actions/workflows/${WORKFLOW}/dispatches`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ ref: '__readiness_probe_no_such_ref__' }),
    });

    let hint = '';
    if (seen === 404) hint = `The token cannot see ${repo} or its ${WORKFLOW} workflow. Check the repository the token is scoped to.`;
    else if (seen === 401) hint = 'The token is expired or invalid.';
    else if (seen !== 200) hint = `GitHub answered ${seen} when asked for the workflow.`;
    else if (ref === 404) hint = `The branch "${branch}" does not exist. Set GITHUB_BRANCH to a branch that does, or leave it unset for main.`;
    else if (may === 403 || may === 401) hint = 'The token can read the repository but not start runs. Regenerate it with Actions: Read and write.';
    else if (may === 404) hint = 'The token can read the repository but not start runs — GitHub hides the dispatch endpoint from tokens without Actions: Read and write.';
    else if (may === 204) hint = 'Unexpected: GitHub accepted a run on a ref that does not exist.';
    else if (may !== 422) hint = `GitHub answered ${may} to a dispatch. See detail.`;

    const ready = seen === 200 && ref === 200 && may === 422;
    return json({ status: ready ? 'ready' : 'not_ready', repo, branch, checks, ...(hint ? { hint } : {}) });
  }

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
    const hint = dispatch.status === 403 || dispatch.status === 401
      ? 'The token needs Actions: Read and write on this repository.'
      : dispatch.status === 404
        ? 'The token cannot see this repository or workflow.'
        : '';
    return json({
      error: `Could not start the run (GitHub ${dispatch.status}).${hint ? ` ${hint}` : ''}`,
      detail: detail.slice(0, 200),
    }, 502);
  }
  return json({ status: 'started', topic: topic || 'all' });
}

export const onRequestOptions = () =>
  new Response(null, { headers: { allow: 'POST, OPTIONS' } });
