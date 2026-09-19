# Research trigger Worker

Guards the paid research pass. The dashboard is static and cannot hold an API
key; this Worker holds the credentials and fires the GitHub Actions workflow
that does the work.

It deliberately does not call Anthropic itself — a research pass runs for
minutes, longer than a Worker invocation lives.

## Deploy

```bash
cd worker
npx wrangler deploy

npx wrangler secret put RESEARCH_PASSPHRASE   # anything you like; shared with whoever may spend
npx wrangler secret put GITHUB_TOKEN          # fine-grained PAT, this repo, Actions: read and write
```

Then set `workerUrl` in `web/data/site.json` to the deployed Worker URL and
commit — the dashboard reads it at load time.

Recommended: create the budget namespace so a leaked passphrase cannot run up a
bill, and lock `ALLOWED_ORIGIN` to your Pages URL.

```bash
npx wrangler kv namespace create BUDGET
# paste the id into wrangler.toml, uncomment the block, redeploy
```

## What it costs

Nothing by itself — Workers' free tier covers this comfortably. The spend is the
research run it triggers, billed by Anthropic. `DAILY_LIMIT` is the ceiling on
how many of those a day anyone holding the passphrase can start.
