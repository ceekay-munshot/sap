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
 * There are two ways to start that workflow and they need different token
 * permissions, so this tries both. workflow_dispatch needs Actions: write;
 * repository_dispatch needs Contents: write. A token with either one runs the
 * button, which is one fewer thing to get right when setting this up.
 *
 * Environment (Cloudflare Pages → Settings → Environment variables):
 *   GITHUB_TOKEN          required — fine-grained PAT on this repo, with
 *                         Actions: read and write, or Contents: read and write
 *   GITHUB_REPO           optional — defaults to ceekay-munshot/sap
 *   GITHUB_BRANCH         optional — branch to run on, defaults to main
 *   RESEARCH_PASSPHRASE   optional — when set, callers must supply it
 *   MIN_MINUTES_BETWEEN   optional — cooldown between runs, default 10
 */

const DEFAULT_REPO = 'ceekay-munshot/sap';
const WORKFLOW = 'research.yml';
const EVENT_TYPE = 'research';

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
    branch: env.GITHUB_BRANCH || 'main',
    headers: {
      authorization: `Bearer ${env.GITHUB_TOKEN}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'sap-ai-intelligence',
      'content-type': 'application/json',
    },
  };
}

/** A GitHub call reduced to what the caller needs: the status, and why if it failed. */
async function call(url, init) {
  try {
    const res = await fetch(url, init);
    return { status: res.status, detail: res.ok ? '' : (await res.text()).slice(0, 160) };
  } catch (err) {
    return { status: 0, detail: String(err.message || err).slice(0, 160) };
  }
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

  // Topic ids are hyphenated (data-readiness), and this value reaches a shell
  // variable in the workflow, so keep it to the characters an id can contain.
  const topic = String(body.topic || '').trim();
  if (topic && !/^[a-z0-9][a-z0-9_-]{0,39}$/.test(topic)) {
    return json({ error: 'Unknown topic.' }, 400);
  }

  const { repo, branch, headers } = gh(env);
  const base = `https://api.github.com/repos/${repo}`;

  /**
   * A readiness probe must never start a paid run, so it never really
   * dispatches. It asks the questions that can break the button: can the token
   * see the workflow, does the branch it would run on exist, and may it start
   * runs either way.
   *
   * Permission to start a run has no read-only form, so each route is asked for
   * something it will refuse on its own terms. workflow_dispatch is given a ref
   * that cannot exist: allowed means 422, and nothing runs. repository_dispatch
   * is given an event type no workflow listens for: allowed means 204, and
   * nothing runs. In both cases the answer separates "not permitted" from
   * "permitted, but that request was nonsense".
   */
  if (body.probe === true) {
    const checks = {};
    checks.workflow = await call(`${base}/actions/workflows/${WORKFLOW}`, { headers });
    checks.branch = await call(`${base}/branches/${encodeURIComponent(branch)}`, { headers });
    checks.workflow_dispatch = await call(`${base}/actions/workflows/${WORKFLOW}/dispatches`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ ref: '__readiness_probe_no_such_ref__' }),
    });
    checks.repository_dispatch = await call(`${base}/dispatches`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ event_type: '__readiness_probe_no_listener__' }),
    });

    const canWorkflow = checks.workflow_dispatch.status === 422;
    const canRepository = checks.repository_dispatch.status === 204;
    const route = canWorkflow ? 'workflow_dispatch' : canRepository ? 'repository_dispatch' : null;

    let hint = '';
    if (checks.workflow.status === 401) hint = 'The token is expired or invalid.';
    else if (checks.workflow.status === 404) hint = `The token cannot see ${repo} or its ${WORKFLOW} workflow. Check the repository it is scoped to.`;
    else if (checks.workflow.status !== 200) hint = `GitHub answered ${checks.workflow.status} when asked for the workflow.`;
    else if (checks.branch.status === 404) hint = `The branch "${branch}" does not exist. Set GITHUB_BRANCH to one that does, or leave it unset for main.`;
    else if (!route) hint = 'The token can read the repository but not start runs. Regenerate it with Actions: Read and write (or Contents: Read and write) on this repository.';

    const ready = checks.workflow.status === 200 && checks.branch.status === 200 && Boolean(route);
    return json({ status: ready ? 'ready' : 'not_ready', repo, branch, route, checks, ...(hint ? { hint } : {}) });
  }

  // Spend control without extra storage: GitHub itself remembers the last run.
  // Refuse while one is in flight, and for a short cooldown after the last.
  const cooldown = Number(env.MIN_MINUTES_BETWEEN || 10);
  try {
    const res = await fetch(`${base}/actions/workflows/${WORKFLOW}/runs?per_page=1`, { headers });
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

  // Preferred route: it reports the run under the workflow, with the inputs
  // visible in the Actions UI.
  const wf = await call(`${base}/actions/workflows/${WORKFLOW}/dispatches`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ ref: branch, inputs: topic ? { only: topic } : {} }),
  });
  if (wf.status === 204) return json({ status: 'started', topic: topic || 'all', via: 'workflow_dispatch' });

  // Refused for permissions only — try the route that needs Contents: write
  // instead. Any other refusal (a bad ref, say) would fail the same way twice.
  if (wf.status === 401 || wf.status === 403 || wf.status === 404) {
    const rd = await call(`${base}/dispatches`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ event_type: EVENT_TYPE, client_payload: topic ? { only: topic } : {} }),
    });
    if (rd.status === 204) return json({ status: 'started', topic: topic || 'all', via: 'repository_dispatch' });

    return json({
      error: 'Could not start the run: the saved GitHub token is not allowed to. '
        + 'It needs Actions: Read and write, or Contents: Read and write, on this repository.',
      detail: `workflow_dispatch ${wf.status}; repository_dispatch ${rd.status} ${rd.detail}`.slice(0, 200),
    }, 502);
  }

  return json({
    error: `Could not start the run (GitHub ${wf.status}).`,
    detail: wf.detail.slice(0, 200),
  }, 502);
}

export const onRequestOptions = () =>
  new Response(null, { headers: { allow: 'POST, OPTIONS' } });
