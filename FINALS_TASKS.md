# Finals fix list

Goal for tonight: remove everything that makes the demo look less credible. New features come later.

## Ground rules (everyone)

- One branch per person (`fix/<name>-<topic>`), small PRs into `master`. Pull before you start.
- **Do not run `pnpm eval`** or many test workflows; Gemini and Firecrawl quota are nearly gone. One test run per fix, max.
- Stay inside the files listed for your tasks. If you need a file that belongs to someone else, ask first.
- Giving a task to Claude: paste the task text and the file paths. Ask it to explain the change before committing.
- Before a PR: `cd web && npx tsc --noEmit && npx eslint .` must pass.

## File ownership

| Person | Owns |
|---|---|
| Monis | `lib/llm.ts`, `lib/pipeline/extract.ts`, `lib/pipeline/validate.ts`, `lib/pipeline/planner.ts` |
| Ujjwal | `lib/pipeline/run.ts`, `lib/db.ts`, `app/api/**`, `lib/connectors/**`, `vercel.json` |
| Aditya | Wording only: `app/page.tsx`, `components/workflow/Insights.tsx`, `components/workflow/Cell.tsx`, `components/workflow/Match.tsx`, `components/workflow/PlanEditor.tsx`, `app/(app)/new/page.tsx`, READMEs |
| Chaubey | `app/(app)/workflows/page.tsx`, `app/(app)/workflows/[id]/page.tsx`, `components/StatusBadge.tsx`, `components/Sidebar.tsx`, `components/workflow/ActivityLog.tsx`, `components/workflow/RecordDrawer.tsx`, `components/workflow/DataTable.tsx`, `app/api/workflows/[id]/export/route.ts` |

All paths are under `web/src/` unless shown otherwise.

---

## Monis: AI, extraction, ranking (critical)

- [ ] **1. AI failover.** `llm.ts` always uses Gemini if its key is set. If every Gemini model fails (429/503/timeout), try OpenRouter next. Give each attempt its own timeout instead of one shared 90s. Keep a separate model name per provider.
- [ ] **2. Stop retrying on rate limits.** On a 429, don't try 3 more Gemini models. In `extract.ts`, after the first 429 stop calling the LLM for the rest of the run. Also cut concurrency from 4 to 2.
- [ ] **3. Output gets cut off.** The extraction budget (`items.length * 450`) is too small for list pages, so the JSON breaks and the whole batch drops to keyword mode. Raise the budget, cap rows per item at about 8, detect `MAX_TOKENS`, and on a parse failure split the batch in half and retry once.
- [ ] **4. Keyword fallback drops every row.** `heuristicMap` only knows `name/title/url/...`. Match fields like `job_title`, `repository_name`, `company_name` to `title`, `full_name`, `company`, and fill the name field from the item title as a last resort.
- [ ] **5. Keyword fallback looks verified.** Set `quoteVerified` to false for heuristic rows (label "auto excerpt"). Start relevance at 0, not 0.4, so non-matching rows get dropped. Remove filler words ("with", "info", "news", ...) from the keywords.
- [ ] **6. Wrong-subject rows are kept.** Have the planner tag each filter `hard` (the subject itself, e.g. "must be React") or `soft` (details). Drop rows that fail a hard filter. Raise the relevance drop threshold from 0.2 to 0.4.
- [ ] **7. Ranking.**
  - Have the planner mark the columns the user asked for as required (salary in "jobs with salary info").
  - Weight required columns higher than optional ones.
  - Treat a missing value for a "must include X" filter as a miss, not "not stated".
  - Recompute the score after duplicates merge.
- [ ] **8. "Top / largest" prompts.** Add `sort_by` (field + direction) to the plan and sort by it before cutting to `max_results`. The heuristic planner should read "top 15" as `max_results: 15`.
- [ ] **9. Store extraction mode.** Save `mode` (`llm` / `mixed` / `heuristic`) in `stats` so the UI can warn about it. Tell Chaubey the field name.
- [ ] **10. Cleaning values.**
  - Parse `$120k`, `1.5M` and `₹12 LPA` (lower bound for ranges); store null if a value can't be parsed.
  - Treat years under 10000 as years, not timestamps.
  - Treat "Not specified", "Competitive", "TBD" and "N/A." as empty.
- [ ] **11. Merges keep the wrong source.** When a merge fills a field from the other row, record that row's URL for the field (e.g. `_field_sources`). If any part of the dedupe key is empty, add the item URL to the key.

## Ujjwal: pipeline safety, API, connectors (critical)

- [ ] **1. Refresh can wipe data.** In `run.ts`, don't prune rows when `clean` is empty, when extraction mode isn't `llm`, or when a source failed (prune only rows from sources that succeeded). Log "kept previous data".
- [ ] **2. Runs past the 5-minute limit.** Give `executePlan` a time budget: at about 240s stop new LLM batches and finish with what you have. Lower `failStuckWorkflows` from 8 to 6 minutes, and run it at most once a minute.
- [ ] **3. Ask timeout.** `ask/route.ts` has `maxDuration = 60` but the LLM waits 90s. Pass a 45s timeout, or raise `maxDuration` to 120. Coordinate with Monis on the `llmJSON` signature.
- [ ] **4. Usage limits.** Add a per-user cap (e.g. 5 runs per hour, 30 Ask/AI-column calls per hour) by counting rows in the DB. Return 429 with a friendly message.
- [ ] **5. Cron is open.** In `cron/refresh/route.ts`, return 401 when `CRON_SECRET` is missing. Set `CRON_SECRET` in Vercel.
- [ ] **6. Double runs.** Claim a run in one SQL statement (`UPDATE ... SET status='queued' WHERE id=$1 AND status IN ('completed','failed','cancelled') RETURNING plan`) in refresh, run, rerun and cron. Return 409 if no row comes back.
- [ ] **7. Cancel race.** `setStatus` must not overwrite `cancelled` with `completed` (`WHERE status <> 'cancelled'`). Reject DELETE while a run is in progress.
- [ ] **8. Friendly errors.** Map 429/503/timeout/402 to "AI service busy, used fallback" (or similar) in `workflows.error`, events and Ask responses. Keep the raw error in `console.error` only.
- [ ] **9. Remotive junk.** `connectors/jobs.ts` appends every non-matching job. Drop jobs with no hit in the title, tags or description. Do the same for RemoteOK `rankByQuery`.
- [ ] **10. Salary hidden in descriptions.** Use `focusText` on API items too (about 1200 chars), not just the first 400 chars.
- [ ] **11. Visible source failures.** When Firecrawl fails (402/out of credits), log a warn event in `collectStep`, not only `console.warn`. Also count the top-up search in the stats.
- [ ] **12. CoinGecko.** Treat "usd", "in", "defi", "meme", "layer" and similar as generic words so "top coins by market cap in usd" returns the market-cap list.

## Aditya: honest wording (simple, text-only changes)

Each task is a text change. Don't change logic. Open the file, find the quoted text, replace it.

- [ ] **1.** `Insights.tsx`: rename "Criteria verified" to "Criteria met (AI-judged)" and "All criteria verified" to "All criteria met (AI-judged)". Change the subtitle "rows where the source confirms each condition" to "the AI's reading of each condition".
- [ ] **2.** `Cell.tsx`, `Insights.tsx` and `DataTable.tsx`: rename "Confidence" to "Match score" everywhere it's shown, with a tooltip: "Heuristic score: relevance + filled columns. Not a probability." (`DataTable.tsx` belongs to Chaubey, so tell them and edit only the label.)
- [ ] **3.** `Match.tsx`:
  - "Found word-for-word in source" → "Quote found in source".
  - "Paraphrased, not verbatim" → "Not found in source".
  - Add "AI judgment" to the tooltip on condition ✓/✗ icons.
- [ ] **4.** `PlanEditor.tsx`: "Every row must" → "Check each row for". "No conditions. Every relevant row is kept." → "No conditions."
- [ ] **5.** `app/page.tsx` (landing):
  - "multi-agent" → "AI-planned pipeline".
  - "verified dataset" → "cited dataset".
  - "Full history of every workflow" → "Every workflow is kept; refresh updates in place".
  - Change the robots.txt line to "Pages we read are checked against robots.txt".
  - Label the demo table "Sample" on mobile too: remove `hidden` from the label.
- [ ] **6.** `new/page.tsx`: remove "every row verified at the source". Replace the "Largest Indian IT services companies" suggestion (it returns 0 rows) with "Open-source vector databases on GitHub".
- [ ] **7.** `Cell.tsx`: show year-only and date-only values without timezone conversion (`"2024"` shows as `2024`, not `1/1/2024`).
- [ ] **8.** Root `README.md`:
  - Fix the AI provider order (Gemini first).
  - List all env var names: `DATABASE_URL`, `NEON_AUTH_BASE_URL`, `NEON_AUTH_COOKIE_SECRET`, `GEMINI_API_KEY`, `OPENROUTER_API_KEY`, `FIRECRAWL_API_KEY`, `CRON_SECRET`.
  - Mention auth, Ask, AI columns, watch and eval.
- [ ] **9.** Replace `web/README.md` (default Next.js text) with 5 lines pointing to the root README.
- [ ] **10.** Create `web/.env.example` with the variable names only (no values). Add `!.env.example` to `web/.gitignore`.

## Chaubey: UI fixes (simple, one file each)

- [ ] **1.** `workflows/page.tsx`: workflows in `review` status show up in no group. Add a "Needs review" group/filter for `status === "review"`.
- [ ] **2.** `workflows/[id]/page.tsx`: Mission Control (`useState(false)`) is collapsed during a run. Open it while the run is in progress, and collapse it when it finishes.
- [ ] **3.** `workflows/[id]/page.tsx`: the stats strip shows "0 / 0 · all responded" and "0 duplicates" while running. Show "—" until the values exist.
- [ ] **4.** `workflows/[id]/page.tsx`:
  - Rename the "Resume" button to "Run again".
  - Disable it, and Rerun, while busy or while a run is in progress, so double-clicks don't start two runs.
- [ ] **5.** `workflows/[id]/page.tsx`: when `stats.mode` is `heuristic` or `mixed` (Monis adds it), show a yellow banner above the table: "AI extraction was unavailable for some pages; those rows were matched by keywords."
- [ ] **6.** `workflows/[id]/page.tsx`: if a running workflow's `updated_at` is older than 90s, show "This run seems stuck" with a Retry button. Show a small "reconnecting…" note when polling fails.
- [ ] **7.** `export/route.ts`:
  - Prefix cells starting with `= + - @` with `'` (blocks Excel formulas).
  - Also quote cells containing `\r`.
  - Add a UTF-8 BOM so ₹ and € show correctly in Excel.
- [ ] **8.** `StatusBadge.tsx`: add a `review` icon, and make "failed" red instead of grey.
- [ ] **9.** `ActivityLog.tsx`: only auto-scroll to the bottom if the user is already at the bottom.
- [ ] **10.** `RecordDrawer.tsx`: the title uses `String(...)`. Use `formatValue` so it never shows "[object Object]".
- [ ] **11.** `DataTable.tsx`: the AI-column message says "for N rows", but only the top 60 are filled. Say "for the top 60 rows".
- [ ] **12.** `Sidebar.tsx`: only poll while something is running, and pause when the tab is hidden. Remove the duplicate "Search" link, or make it focus the search box.
- [ ] **13.** Replace `alert()`/`confirm()` in `workflows/[id]/page.tsx` and `workflows/page.tsx` with inline error text, or the existing toast if there is one.

---

## Before the demo (everyone)

- [ ] Gemini quota reset or a billed key; OpenRouter has credit.
- [ ] Vercel env vars set (see the README list), Fluid compute on, redeployed.
- [ ] Turn off "watch" on demo datasets (or disable the cron) so nothing refreshes overnight.
- [ ] Pre-build 2–3 good datasets. Don't click Refresh on them live.
- [ ] Rehearse one prompt that finishes in under 2 minutes.
- [ ] Sign in to the demo account beforehand; check the production domain is trusted in Neon Auth.
- [ ] Keep a screen recording of a full good run as a backup.
- [ ] Know the honest numbers: no accuracy figure yet (eval not labelled), about 6–23 LLM calls per run, one AI provider active at a time.
