# SAP AI Intelligence

Numerical practitioner-sentiment scores and verbatim quotes on SAP's AI strategy,
researched daily and weighted so recent evidence outranks stale evidence.

The interface follows the earlier `sap-dashboard` build — same layout, palette, type
system and components — with the research moved onto a schedule instead of a button.

---

## What it tracks

Nine topics, grouped as the original grouped them:

| | Topic | Category |
|---|---|---|
| 🤖 | Joule AI Assistant | Product |
| ⚡ | BTP & AI Agents | Product |
| ☁️ | Business Data Cloud | Product |
| 🏭 | S/4HANA AI Features | Product |
| 🔍 | SAP RPT1 | Product |
| 🤝 | Partner Opinions | Ecosystem |
| 📊 | Customer Satisfaction | Ecosystem |
| ⚔️ | vs. Competitors | Competitive |
| ⚠️ | Risks & Gaps | Competitive |

Each is scored **1.0–5.0** overall plus four sub-scores — Adoption, Maturity,
Satisfaction, Competitive — with the summary, key findings, attributed practitioner
quotes and the sources behind them.

---

## The recency weighting

The point of the rebuild. Most of SAP's AI portfolio only became real recently, so
2023–24 commentary describes a product that no longer exists. It is kept for context
and barely counted.

| Tier | Multiplier | In 2026 | In 2027 |
|---|---|---|---|
| Current year | **3×** | 2026 | 2027 |
| Prior year | **1.5×** | 2025 | 2026 |
| Legacy | **0.25×** | pre-2025 | pre-2026 |

On top of the tier, a freshness boost of **1.35×** for the last 90 days and **1.15×**
for the last 180, so the newest quarter outruns the rest of the current year. A quote
from this month carries **4.05×** against a 2023 quote's **0.25×** — **16:1**.

**It rolls over by itself.** Tiers are derived from the current year *at render time*
in one module, [`web/lib/recency.mjs`](web/lib/recency.mjs), imported by both the Node
collector and the browser. The METHOD strip, the sidebar weighting key, the per-quote
multiplier chips and the research prompt's temporal rules all read from it, so on
1 January they move together. No code change, no config edit, no redeploy.

> The original spec said "2026 = 3×, 2025 = 1.5×, pre-2024 = LEGACY" but also
> "in 2027 … pre-2025 = LEGACY". Those are inconsistent by one year. The implementation
> follows the 2027 example — legacy is everything before the prior year — because that
> rule stays stable as the years roll. Adjust `POLICY` in `recency.mjs` to change it.

Every quote card shows the exact multiplier it carried, and legacy quotes are tagged,
so the weighting is visible at the evidence rather than buried in a methodology note.

---

## Two pipelines, two costs

| | Free daily tracker | Paid research |
|---|---|---|
| What | Scrapes Hacker News, Reddit (posts *and* comments), Stack Overflow, press/news RSS, YouTube, SAP's own pages. Buckets each post into the nine topics, scores it with a keyword lexicon. | Claude reads the web and writes the scored report: summary, key findings, attributed quotes, sources. |
| Cost | **Nothing.** No API key. | Anthropic API, billed per run. |
| When | Daily, 06:00 UTC (`track.yml`) | Only when someone asks (`research.yml`) |
| Feeds | The **Sentiment History** time series | The topic report cards |

The trend line comes from the free pass, so it stays dense without spending
anything; the expensive pass only runs when someone wants depth on a topic.

## The Run Research button

A static page cannot hold an Anthropic key — anything shipped to the browser is
public. So the button works one of two ways:

- **No Worker configured** (default): it links to the GitHub Actions workflow.
- **Worker configured**: it triggers a real run. Deploy `worker/`, set
  `workerUrl` in `web/data/site.json`, and the button asks for a passphrase,
  fires the workflow, and polls until the new report lands.

The Worker deliberately does not call Anthropic itself: a research pass runs for
minutes, longer than a Worker invocation lives. It fires the Actions workflow
that already does the job. See [`worker/README.md`](worker/README.md).

**It guards spend.** A public button spends your money on every click, so the
Worker requires a shared passphrase and enforces a daily run cap (`DAILY_LIMIT`,
default 5) when a KV namespace is bound. Set both before making the URL public.

## Running it

```bash
npm install
node collector/selftest.mjs        # offline: no network, no API key
node collector/track.mjs           # free pass: scrape, score, append a trend point
node collector/track.mjs --dry-run
node collector/run.mjs             # paid pass: all nine topics
node collector/run.mjs --only=joule_sentiment

npm run serve                   # http://localhost:8080
```

Retrieval and reasoning are separate, which is what makes the citations checkable:

1. **Firecrawl** searches and fetches the pages, so the repository holds the real
   URLs and the real page text.
2. **Claude** reads only those pages. It cites a page *number*, never a URL.
3. Every quote is then checked against the page it cites. A quote that cannot be
   found is discarded, not flagged — the report shows how many were thrown away.

The model therefore cannot invent a citation: links are attached from pages that
were actually fetched.

Reasoning runs on **Amazon Bedrock** when AWS credentials are present, otherwise
on the Anthropic API. Bedrock has no server-side web search, which is exactly why
retrieval is Firecrawl's job rather than the model's.

| Setting | Effect |
|---|---|
| `FIRECRAWL_API_KEY` (secret) | Required for research — no retrieval without it. |
| `AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY` (secrets) | Use Bedrock for reasoning. |
| `AWS_REGION` (variable) | Defaults to `us-east-1`. |
| `ANTHROPIC_API_KEY` (secret) | Used instead when no AWS credentials are set. |
| `AI_PROVIDER` (variable) | Force `bedrock` or `anthropic`; auto-detected otherwise. |
| `RESEARCH_MODEL` (variable) | Defaults to `anthropic.claude-opus-5` on Bedrock, `claude-opus-5` otherwise. |
| `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` (secrets) | Enables the Pages deploy step; skipped when absent. |
| `CLOUDFLARE_PAGES_PROJECT` (variable) | Defaults to `sap-dashboard`. |

The daily workflow runs at 06:00 UTC, commits `web/data/dashboard.json`, and appends
one history point per topic per run — that is what the Sentiment History view draws.
A topic that fails does not cost the other eight; if all nine fail the existing data
is left untouched rather than overwritten with nothing.

---

## Layout

```
web/                     the deployed site (Cloudflare Pages output directory)
  index.html             nav · sidebar · method strip · topic grid
  assets/styles.css      design system carried over from the previous build
  assets/app.js          renders topic cards, reports, history
  lib/recency.mjs        weighting policy — shared with the collector
  data/dashboard.json    generated by the paid pass: scores, quotes, sources
  data/trend.json        generated by the free pass: the time series
  data/topics.json       the nine topics, mirrored from config/
  data/site.json         workerUrl for the Run Research button
collector/
  track.mjs              free daily pass: scrape, bucket, score, append trend
  run.mjs                paid pass: Claude research per topic
  lib/research.mjs       prompt, evidence pack, parsing, validation
  lib/firecrawl.mjs      search and page fetching
  lib/verify.mjs         checks every quote against the page it cites
  lib/topicmatch.mjs     keyword buckets for the nine topics
  sources/               one scraper per source, failures isolated
  selftest.mjs           offline checks, both pipelines
worker/                  guarded trigger for the paid pass (Cloudflare Worker)
config/topics.json       topic definitions and research prompts
config/sources.json      feeds, subreddits, queries for the free pass
reference/               captured design of the previous build, for comparison
tools/fetch-reference.mjs  re-captures it (runs in CI, which has open internet)
```

## Honesty rules this repo follows

- No placeholder or synthetic numbers are ever committed. Before the first run the
  dashboard shows an empty state, not a demo.
- A payload with no score fails loudly instead of rendering as zero; out-of-range
  values are clamped, short or empty quotes dropped, sources without a URL discarded.
- The research prompt forbids inventing quotes, names or URLs and tells the model to
  lower confidence and say so when evidence is thin.
- Every quote shows its date, platform, recency tier and exact multiplier, with a link
  out where one was captured.
- Run failures are recorded per topic in `data/run-report.json`.
