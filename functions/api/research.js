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

const KNOWN_TOPICS = new Set([
  'joule_sentiment', 'btp_ai', 'partner_views', 'vs_competitors',
  'bdc_cloud', 'customer_sat', 's4hana_ai', 'risks_gaps', 'rpt1',
]);

/** A GitHub call reduced to status, response JSON/body, and why if it failed. */
async function call(url, init) {
  try {
    const res = await fetch(url, init);
    const text = await res.text();
    let data = null;
    try { data = JSON.parse(text); } catch {}
    return {
      status: res.status,
      ok: res.ok,
      headers: res.headers,
      data,
      detail: res.ok ? '' : text.slice(0, 200),
    };
  } catch (err) {
    return { status: 0, ok: false, data: null, detail: String(err.message || err).slice(0, 160) };
  }
}

export async function onRequestPost({ request, env }) {
  if (!env.GITHUB_TOKEN) {
    return json({ error: 'This dashboard is not configured to run research yet.' }, 503);
  }

  let body = {};
  try {
    const rawBody = await request.text();
    if (rawBody && rawBody.trim()) {
      body = JSON.parse(rawBody);
      if (typeof body !== 'object' || body === null || Array.isArray(body)) {
        return json({ error: 'Request body must be a JSON object.' }, 400);
      }
    } else {
      return json({ error: 'Request body cannot be empty.' }, 400);
    }
  } catch {
    return json({ error: 'Malformed JSON in request body.' }, 400);
  }

  if (env.RESEARCH_PASSPHRASE && !safeEqual(body.passphrase, env.RESEARCH_PASSPHRASE)) {
    return json({ error: 'Wrong passphrase.', needsPassphrase: true }, 401);
  }

  const { repo, branch, headers } = gh(env);
  const base = `https://api.github.com/repos/${repo}`;

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

  // Validate topic
  const topic = String(body.topic || '').trim();
  const runAll = body.all === true || topic === 'all';
  if (!runAll) {
    if (!topic) {
      return json({ error: 'Topic ID is required. Pass a valid topic id or set all: true.' }, 400);
    }
    if (!KNOWN_TOPICS.has(topic)) {
      return json({ error: `Unknown topic "${topic}". Known topics: ${Array.from(KNOWN_TOPICS).join(', ')}` }, 400);
    }
  }

  // Spend control without extra storage: GitHub itself remembers the last run.
  const cooldown = Number(env.MIN_MINUTES_BETWEEN || 10);
  try {
    const res = await fetch(`${base}/actions/workflows/${WORKFLOW}/runs?per_page=1`, { headers });
    if (res.ok) {
      const latest = (await res.json()).workflow_runs?.[0];
      if (latest && latest.status !== 'completed') {
        return json({
          status: 'already_running',
          runId: latest.id,
          htmlUrl: latest.html_url,
          startedAt: latest.run_started_at,
          message: 'A research run is already in progress.',
        });
      }
      if (latest?.updated_at) {
        const wait = latest.conclusion === 'success' ? cooldown : Math.min(2, cooldown);
        const sinceMin = (Date.now() - new Date(latest.updated_at).getTime()) / 60000;
        if (sinceMin < wait) {
          return json({
            error: latest.conclusion === 'success'
              ? `A run finished ${Math.round(sinceMin)} min ago. `
                + `Please wait ${Math.ceil(wait - sinceMin)} more min.`
              : `The last run just failed. Please wait ${Math.ceil(wait - sinceMin)} min and try again.`,
          }, 429);
        }
      }
    }
  } catch { /* if check fails, let dispatch decide */ }

  const requestId = `req_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
  const inputs = topic && !runAll ? { only: topic } : {};

  // Preferred route: workflow_dispatch
  const wf = await call(`${base}/actions/workflows/${WORKFLOW}/dispatches`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ ref: branch, inputs }),
  });

  let runDetails = null;
  if (wf.status === 200 || wf.status === 201 || wf.status === 204) {
    if (wf.data && (wf.data.workflow_run_id || wf.data.id)) {
      runDetails = {
        runId: wf.data.workflow_run_id || wf.data.id,
        htmlUrl: wf.data.html_url || null,
      };
    }
    if (!runDetails) {
      try {
        await new Promise((r) => setTimeout(r, 600));
        const rRes = await fetch(`${base}/actions/workflows/${WORKFLOW}/runs?per_page=1`, { headers });
        if (rRes.ok) {
          const latest = (await rRes.json()).workflow_runs?.[0];
          if (latest) {
            runDetails = { runId: latest.id, htmlUrl: latest.html_url };
          }
        }
      } catch {}
    }
    return json({
      status: 'started',
      topic: runAll ? 'all' : topic,
      runId: runDetails?.runId || null,
      htmlUrl: runDetails?.htmlUrl || null,
      startedAt: new Date().toISOString(),
      via: 'workflow_dispatch',
    });
  }

  // Fallback route: repository_dispatch
  if (wf.status === 401 || wf.status === 403 || wf.status === 404) {
    const rd = await call(`${base}/dispatches`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        event_type: EVENT_TYPE,
        client_payload: {
          ...(topic && !runAll ? { only: topic } : {}),
          request_id: requestId,
          started_at: new Date().toISOString(),
        },
      }),
    });
    if (rd.status === 204 || rd.status === 200) {
      let rdRunDetails = null;
      try {
        await new Promise((r) => setTimeout(r, 600));
        const rRes = await fetch(`${base}/actions/workflows/${WORKFLOW}/runs?per_page=1`, { headers });
        if (rRes.ok) {
          const latest = (await rRes.json()).workflow_runs?.[0];
          if (latest) {
            rdRunDetails = { runId: latest.id, htmlUrl: latest.html_url };
          }
        }
      } catch {}
      return json({
        status: 'started',
        topic: runAll ? 'all' : topic,
        runId: rdRunDetails?.runId || null,
        htmlUrl: rdRunDetails?.htmlUrl || null,
        requestId,
        startedAt: new Date().toISOString(),
        via: 'repository_dispatch',
      });
    }

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
