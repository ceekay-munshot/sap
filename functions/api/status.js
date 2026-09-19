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

export async function onRequestGet({ env }) {
  if (!env.GITHUB_TOKEN) return json({ configured: false });

  const repo = env.GITHUB_REPO || DEFAULT_REPO;
  const headers = {
    authorization: `Bearer ${env.GITHUB_TOKEN}`,
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
    'user-agent': 'sap-ai-intelligence',
  };

  try {
    const runsRes = await fetch(
      `https://api.github.com/repos/${repo}/actions/workflows/${WORKFLOW}/runs?per_page=1`,
      { headers },
    );
    if (!runsRes.ok) return json({ configured: true, state: 'unknown' });

    const run = (await runsRes.json()).workflow_runs?.[0];
    if (!run) return json({ configured: true, state: 'idle' });

    const done = run.status === 'completed';
    const payload = {
      configured: true,
      state: done ? (run.conclusion === 'success' ? 'success' : 'failed') : 'running',
      runId: run.id,
      startedAt: run.run_started_at,
      updatedAt: run.updated_at,
      step: null,
      stepIndex: 0,
      stepTotal: 0,
    };

    if (!done) {
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
    return json({ configured: true, state: 'unknown', error: String(err.message || err) });
  }
}
