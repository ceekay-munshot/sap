/**
 * GET /api/status — real progress for the running research pass.
 *
 * Reports the workflow run's state and the step it is actually on, so the
 * dashboard's loader shows what is happening rather than a spinner that
 * means nothing.
 */

const DEFAULT_REPO = 'ceekay-munshot/sap';
const WORKFLOW = 'research.yml';

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });

/** Workflow step names are for maintainers; say what a reader cares about. */
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

export async function onRequestGet({ request, env }) {
  if (!env.GITHUB_TOKEN) return json({ configured: false });

  const url = new URL(request.url);
  const runIdParam = url.searchParams.get('run_id') || url.searchParams.get('runId');
  const repo = env.GITHUB_REPO || DEFAULT_REPO;
  const headers = {
    authorization: `Bearer ${env.GITHUB_TOKEN}`,
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
    'user-agent': 'sap-ai-intelligence',
  };

  try {
    let run = null;
    if (runIdParam && /^\d+$/.test(runIdParam)) {
      const runRes = await fetch(`https://api.github.com/repos/${repo}/actions/runs/${runIdParam}`, { headers });
      if (runRes.status === 404) {
        return json({ configured: true, state: 'unknown', error: `Run ${runIdParam} not found.` }, 404);
      }
      if (!runRes.ok) {
        return json({ configured: true, state: 'unknown', error: `GitHub returned ${runRes.status}` }, 502);
      }
      run = await runRes.json();
    } else {
      const runsRes = await fetch(
        `https://api.github.com/repos/${repo}/actions/workflows/${WORKFLOW}/runs?per_page=1`,
        { headers },
      );
      if (!runsRes.ok) return json({ configured: true, state: 'unknown' }, 502);
      run = (await runsRes.json()).workflow_runs?.[0];
    }

    if (!run) return json({ configured: true, state: 'idle' });

    let state = 'unknown';
    if (run.status === 'queued' || run.status === 'waiting') {
      state = 'queued';
    } else if (run.status === 'in_progress') {
      state = 'running';
    } else if (run.status === 'completed') {
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
      dashboard: null,
    };

    if (state === 'succeeded') {
      try {
        const ref = run.head_sha || 'main';
        const dataRes = await fetch(
          `https://api.github.com/repos/${repo}/contents/web/data/dashboard.json?ref=${ref}`,
          {
            headers: {
              ...headers,
              accept: 'application/vnd.github.raw+json',
            },
          },
        );
        if (dataRes.ok) {
          payload.dashboard = await dataRes.json();
        }
      } catch {}
    }

    if (run.status !== 'completed') {
      const jobsRes = await fetch(
        `https://api.github.com/repos/${repo}/actions/runs/${run.id}/jobs`, { headers },
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
    return json(payload);
  } catch (err) {
    return json({ configured: true, state: 'unknown', error: String(err.message || err) }, 502);
  }
}
