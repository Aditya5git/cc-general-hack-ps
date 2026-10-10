# DataPilot: AI-powered data intelligence platform

Describe the data you need in plain English. DataPilot's AI planner builds a collection workflow, pulls from permitted sources, then structures, validates and deduplicates the results into a cited dataset you can explore and export.

## How it works

```
prompt ──▶ Planner (LLM) ──▶ workflow plan: schema + source steps + filters
            │
            ▼
        Collectors (parallel, robots.txt-aware, public APIs)
        remotive · arbeitnow · remoteok · hackernews · github · wikipedia · coingecko · web search · url fetch
            │
            ▼
        Extractor (LLM, batched) ──▶ rows matching the schema, with relevance score
            │
            ▼
        Validator: type coercion, required fields, URL/email/date checks, dedupe + merge, match score
            │
            ▼
        Neon Postgres: workflows · events · sources · records (each row keeps source + URL + fetched_at)
            │
            ▼
        Dashboard: live progress, pipeline view, data table (search/filter/sort), sources, activity log, CSV/JSON export, rerun
```

Each row keeps the source excerpt it came from; the quote is checked against the fetched page in code. Condition checks (met / not met / not stated) are AI judgments and labelled as such. The match score is a heuristic (relevance + filled columns), not a probability.

## Features
- **Auth**: sign up / sign in with Neon Auth; each user sees their own workflows plus shared read-only examples.
- **Ask your data**: ask a question in plain English; the answer cites the rows it used (top 80 rows by match score).
- **AI columns**: add a column by asking a question; the AI fills it for the top 60 rows.
- **Watch**: refresh a dataset by hand or on a schedule. Vercel Cron calls `/api/cron/refresh` daily and refreshes watched datasets whose interval has passed. Refresh updates rows in place; new rows are badged.
- **Eval**: `pnpm eval` runs the prompts in `web/eval/prompts.json` through the real pipeline and reports rows, quote-verified rate, fill rate and LLM usage. It uses real LLM and Firecrawl quota; `--no-ai` and `--replay` avoid most of it. Precision needs hand labels (`pnpm eval:score`).

## Stack
- `web/`: Next.js 16 (App Router) with the UI and API routes. The pipeline runs in the background via `after()` on Vercel.
- Neon serverless Postgres for workflow and dataset storage; Neon Auth for sign-in.
- LLM providers, tried in this order: `GEMINI_API_KEY` → `OPENROUTER_API_KEY` → `ANTHROPIC_API_KEY` → `OPENAI_API_KEY`. Every configured key is used; when one provider is busy (rate limit, overload, out of credits, timeout) the next one answers. Set a model per provider with `GEMINI_MODEL`, `OPENROUTER_MODEL`, etc. If no key is set, a rule-based planner and heuristic field mapping take over, so the app still works.

## Environment variables
Set these in `web/.env.local` for local runs and in Vercel for deploys:

| Variable | Used for |
|---|---|
| `DATABASE_URL` | Neon Postgres connection |
| `NEON_AUTH_BASE_URL` | Neon Auth endpoint |
| `NEON_AUTH_COOKIE_SECRET` | Signing the auth session cookie |
| `GEMINI_API_KEY` | First LLM provider |
| `OPENROUTER_API_KEY` | Fallback LLM provider |
| `FIRECRAWL_API_KEY` | Web search and JS-heavy pages (optional; built-in scrapers are used without it; comma-separate several keys) |
| `CRON_SECRET` | Protects `/api/cron/refresh` |

Optional: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GITHUB_TOKEN` (higher GitHub API limits), `GEMINI_MODEL` / `OPENROUTER_MODEL` / `LLM_MODEL`.

## Run locally
```bash
cd web
pnpm install
# web/.env.local: the variables above
pnpm dev
```

Database schema: see `web/schema.sql`.
