# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

DataPilot: the user describes a dataset in plain English, and agents plan, collect, extract, validate and store it as a source-backed table. All code lives in `web/` (Next.js 16 App Router, React 19, Tailwind 4, Neon Postgres, Neon Auth). It's a hackathon repo, and `FINALS_TASKS.md` holds the current fix list and who owns which file.

**Next.js 16 differs from older versions** (see `web/AGENTS.md`). Read `web/node_modules/next/dist/docs/` before using a Next API you aren't sure of. For example, route protection lives in `src/proxy.ts`, not `middleware.ts`.

## Commands (run from `web/`, pnpm)

```bash
pnpm dev                          # on WSL, Neon may need: NODE_OPTIONS=--dns-result-order=ipv4first pnpm dev
npx tsc --noEmit && npx eslint .  # required before every PR (no unit-test suite exists)
pnpm build
npx tsx scripts/test-connectors.ts [connector_id ...]   # smoke-test data connectors (hits real APIs)
pnpm eval [--no-ai|--lite|--replay|--only jobs,crypto]  # end-to-end eval over eval/prompts.json
pnpm eval:score eval/out/<run>/labels.csv
```

**Quota:** `pnpm eval` and real workflow runs use up Gemini and Firecrawl quota. Don't run them unless asked. Use `pnpm eval --no-ai` (free) or `--replay` (only extraction calls).

Env (`web/.env.local`): `DATABASE_URL`, `NEON_AUTH_BASE_URL`, `NEON_AUTH_COOKIE_SECRET`. Optional: LLM keys, `FIRECRAWL_API_KEY` (comma-separated keys rotate), `GITHUB_TOKEN`, `CRON_SECRET`, `MAX_RAW_ITEMS`, `EXTRACT_BATCH`, `LLM_NO_FALLBACK`. Schema: `web/schema.sql`. There are no migrations; it's applied by hand, with `ALTER ... IF NOT EXISTS` additions at the bottom.

## Architecture

**Pipeline** (`src/lib/pipeline/run.ts`). `createWorkflow` (`lib/workflows.ts`) inserts a row and starts the pipeline with `after()`, so it runs in the background past the HTTP response. API routes set `maxDuration = 300`. The stages are:
1. `runWorkflow`: `planner.ts` turns the prompt into a `WorkflowPlan` (fields, source steps, filters, dedupe keys). With `review: true` it stops at status `review` so the user can edit the plan in `PlanEditor`. `/api/workflows/[id]/run` then continues it.
2. `executePlan`: runs every connector step in parallel, interleaves results up to `MAX_RAW`, and then `extract.ts` (LLM batches) builds rows. As each batch finishes, the rows are validated and upserted, so the table fills live. Then `validate.ts` (coerce, filter, dedupe/merge, confidence) runs, plus one top-up web search if results are thin. Refresh (manual, or Vercel cron `/api/cron/refresh` for plans with `watch`) reruns `executePlan` with the saved plan and prunes rows that no longer show up.
- Progress and the activity log are written to the DB (`setStatus`, `logEvent` in `lib/db.ts`). The UI polls. Cancellation works through `assertNotCancelled` checks between stages and batches, which throw `CancelledError`. `failStuckWorkflows` cleans up runs that died.
- `records` upsert on `(workflow_id, dedupe_key)` and merge `data` with `||`, so values in AI columns (fields with `ai: true`, filled on demand via `/columns`) survive refreshes.

**Status values** (`lib/types.ts`): `queued → planning → [review] → collecting → processing → completed | failed | cancelled`. `isRunning` in `components/utils.ts` treats `review` as not running.

**LLM** (`lib/llm.ts`): one JSON-completion API that works with any provider and fails over in the order Gemini → OpenRouter → Anthropic → OpenAI, using whichever keys are set. Each provider's model can be overridden with `<PROVIDER>_MODEL`. If no key is set it returns null, and callers fall back to the heuristic planner and keyword extraction. Keyword-fallback rows must never be marked as quote-verified.

**Connectors** (`lib/connectors/`): the `CONNECTORS` registry maps a `ConnectorId` to `{label, description, run}`. The planner reads the `description` text to choose sources, so editing it changes planning. Fetching respects robots.txt (`http.ts`) and is SSRF-guarded (`safe-url.ts`). Firecrawl is optional, and on any error the code falls back to the built-in scrapers.

**Safety:** `pipeline/safety.ts` blocks disallowed prompts before a workflow is created, and the LLM planner can also reject them. Scraped text sent to an LLM must be wrapped with `untrusted()` and include `UNTRUSTED_RULE` (`pipeline/untrusted.ts`).

**Auth and ownership:** Neon Auth (`lib/auth/`). `src/proxy.ts` protects `/new` and `/workflows`. API routes check auth themselves: they call `requireUser()` or `authorize(id, "read"|"write")` from `lib/auth/access.ts` and return 401/404 JSON. Workflows with `owner_id IS NULL` (old ones and eval runs) are shared read-only examples.

## Conventions

- Branch per change (`fix/<name>-<topic>`), small PRs into `master`. Keep edits inside the files `FINALS_TASKS.md` assigns, unless asked otherwise.
- Comments explain *why*, and they're short. Match the dense one-line style already in the code.
