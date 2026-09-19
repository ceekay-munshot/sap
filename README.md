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

## Running it

```bash
npm install
node collector/selftest.mjs     # offline: no network, no API key
node collector/run.mjs --dry-run
node collector/run.mjs                      # all nine topics
node collector/run.mjs --only=joule_sentiment

npm run serve                   # http://localhost:8080
```

Research uses Claude with the web-search server tool, so the searching happens on
Anthropic's infrastructure rather than from the runner. `ANTHROPIC_API_KEY` is
required — without it the run exits rather than writing anything.

| Setting | Effect |
|---|---|
| `ANTHROPIC_API_KEY` (secret) | Required for research. |
| `RESEARCH_MODEL` (variable) | Defaults to `claude-opus-5`. |
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
  data/dashboard.json    generated: scores, quotes, sources, history
  data/topics.json       the nine topics, mirrored from config/
collector/
  run.mjs                orchestrator
  lib/research.mjs       prompt, web search, parsing, validation
  selftest.mjs           offline checks
config/topics.json       topic definitions and research prompts
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
