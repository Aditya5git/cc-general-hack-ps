import { CONNECTORS } from "../connectors";
import { assertNotCancelled, CancelledError, logEvent, setStatus, sql } from "../db";
import { friendlyReason, UserFacingError } from "../errors";
import { llmProvider } from "../llm";
import type { ConnectorId, DropReasons, RawItem, SourceStep, Workflow, WorkflowPlan } from "../types";
import { extractAll } from "./extract";
import { planWorkflow } from "./planner";
import { RejectedRequestError } from "./safety";
import { identityField, validateAndDedupe, type CleanRow } from "./validate";

// Raw items kept per run; env override for quota-limited runs (eval --lite).
const maxRaw = () => Math.min(Math.max(Number(process.env.MAX_RAW_ITEMS) || 120, 6), 150);

/**
 * Upsert rows by dedupe key so ids (and fetched_at = first seen) stay stable across live batches and refreshes.
 * Existing keys are merged (`old || new`) so AI-column values added later survive. With `prune`, rows no longer in
 * `clean` are removed if this run added them (live batches) or their source is in `prune.sources`; returns how many were.
 */
async function syncRecords(id: string, clean: CleanRow[], prune?: { since: string; sources: string[] }): Promise<number> {
  if (clean.length) {
    await sql`INSERT INTO records (workflow_id, data, source_name, source_url, confidence, dedupe_key)
      SELECT ${id}, x.data, x.source_name, x.source_url, x.confidence, x.dedupe_key
      FROM jsonb_to_recordset(${JSON.stringify(clean)}::jsonb)
        AS x(data jsonb, source_name text, source_url text, confidence real, dedupe_key text)
      ON CONFLICT (workflow_id, dedupe_key) DO UPDATE SET
        -- AI-column answers and other columns survive (||), but _quote/_why/_checks/... from the previous run are replaced,
        -- never mixed with the new ones: they describe one page, the one in source_url
        data = (SELECT COALESCE(jsonb_object_agg(k, v), '{}'::jsonb) FROM jsonb_each(records.data) AS e(k, v) WHERE left(k, 1) <> '_')
          || EXCLUDED.data,
        source_name = EXCLUDED.source_name,
        source_url = EXCLUDED.source_url, confidence = EXCLUDED.confidence`;
  }
  if (!prune) return 0;
  const gone = await sql`DELETE FROM records WHERE workflow_id = ${id}
    AND (fetched_at >= ${prune.since}
      OR source_name IN (SELECT jsonb_array_elements_text(${JSON.stringify(prune.sources)}::jsonb)))
    AND dedupe_key NOT IN (SELECT jsonb_array_elements_text(${JSON.stringify(clean.map((c) => c.dedupe_key))}::jsonb))
    RETURNING id`;
  return gone.length;
}

/** Run one source step, recording it in `sources` and the activity log. Failures return no items. */
async function collectStep(id: string, step: SourceStep): Promise<RawItem[]> {
  const c = CONNECTORS[step.connector];
  const t0 = Date.now();
  await logEvent(id, "collect", `→ ${c.label}: "${step.query}"`);
  try {
    const r = await c.run(step.query, step.limit ?? 20);
    const ms = Date.now() - t0;
    // "empty" rather than "ok" so a search that silently found nothing stands out in the Sources tab
    const pages = [...new Set(r.items.map((it) => it.url).filter((u) => /^https?:\/\//.test(u)))].slice(0, 40);
    await sql`INSERT INTO sources (workflow_id, connector, query, url, status, items, duration_ms, pages)
              VALUES (${id}, ${step.connector}, ${step.query}, ${r.url ?? null}, ${r.items.length ? "ok" : "empty"}, ${r.items.length}, ${ms}, ${JSON.stringify(pages)}::jsonb)`;
    if (r.items.length && r.items.every((it) => it.source === "wikipedia") && step.connector === "web_search")
      await logEvent(id, "collect", `Web search engines returned nothing for "${step.query}", so these results come from Wikipedia search and may only mention the topic`, "warn");
    await logEvent(id, "collect", r.items.length ? `✓ ${c.label} returned ${r.items.length} items in ${(ms / 1000).toFixed(1)}s` : `${c.label} found nothing for "${step.query}"`, r.items.length ? "success" : "warn");
    return r.items;
  } catch (e) {
    console.error(`${step.connector} failed for "${step.query}"`, e);
    const msg = friendlyReason(e);
    await sql`INSERT INTO sources (workflow_id, connector, query, status, duration_ms, error)
              VALUES (${id}, ${step.connector}, ${step.query}, 'failed', ${Date.now() - t0}, ${msg})`;
    await logEvent(id, "collect", `✗ ${c.label} failed: ${msg}`, "error");
    return [];
  }
}

/**
 * Source names a refresh may prune: those from connectors whose every step returned items this run. A step that
 * failed or found nothing says nothing about whether its old rows are gone.
 */
function prunableSources(collected: { connector: ConnectorId; items: RawItem[] }[]) {
  const down = new Set<string>(collected.filter((c) => !c.items.length).map((c) => c.connector));
  // fallbacks store rows under another name, so a down connector may own those rows too
  if (down.has("web_search")) down.add("wikipedia");
  if (down.has("coingecko")) down.add("coinpaprika");
  const ok = new Set<string>();
  for (const c of collected)
    if (!down.has(c.connector))
      for (const it of c.items) {
        // same naming as validate.ts source_name
        const name = it.fields?.data_provider === "coinpaprika" ? "coinpaprika" : it.source;
        if (!down.has(name)) ok.add(name);
      }
  return { ok: [...ok], down: [...down] };
}

/** Text for a failed run: our own wording as-is, anything else reduced to a plain reason (raw error to the log). */
function runFailure(id: string, e: unknown) {
  if (e instanceof UserFacingError) return e.message;
  console.error(`workflow ${id} failed`, e);
  return `This run failed (${friendlyReason(e)}). Try again.`;
}

/** Extraction notes end with "(<raw provider error>), ..."; swap that for a plain reason before it reaches the log. */
function tidyNote(note: string) {
  return note.replace(/\(([\s\S]+)\)(?=,|$)/, (_, raw: string) => {
    console.error("extraction:", raw);
    return `(${friendlyReason(raw)})`;
  });
}

/** One line per drop reason, e.g. `3 had no title · 5 failed "located in Uttar Pradesh"`. */
function describeDrops(r: DropReasons, idField: string) {
  return [
    r.no_name && `${r.no_name} had no ${idField.replace(/_/g, " ")}`,
    r.irrelevant && `${r.irrelevant} didn't match the request`,
  ]
    .filter(Boolean)
    .join(" · ");
}

/** Stage 1: understand + plan. With `review`, stop so the user can edit the plan before running it. */
export async function runWorkflow(id: string, prompt: string, opts: { review?: boolean } = {}) {
  let plan: WorkflowPlan;
  try {
    await setStatus(id, "planning", 5);
    const provider = llmProvider();
    await logEvent(id, "understand", provider ? `Analyzing request with ${provider} planning agent…` : "No LLM key configured, so the rule-based planner is used");
    plan = await planWorkflow(prompt);
    await assertNotCancelled(id);
    await logEvent(id, "plan", `Planned "${plan.title}": ${plan.fields.length} fields, ${plan.sources.length} source steps (${plan.planner} planner)`, "success");
    await logEvent(id, "plan", `Schema: ${plan.fields.map((f) => f.name).join(", ")}`);
    if (opts.review) {
      await setStatus(id, "review", 15, { plan, title: plan.title });
      await logEvent(id, "plan", "Plan ready for review: edit columns, sources and filters, then run it");
      return;
    }
    await setStatus(id, "collecting", 15, { plan, title: plan.title });
  } catch (e) {
    if (e instanceof CancelledError) return void (await logEvent(id, "cancel", "Stopped by you before collection started", "warn"));
    if (e instanceof RejectedRequestError) {
      await setStatus(id, "failed", 100, { error: e.message, title: "Request not supported" });
      return void (await logEvent(id, "plan", `Refused: ${e.message}`, "warn"));
    }
    const msg = runFailure(id, e);
    await setStatus(id, "failed", 100, { error: msg });
    await logEvent(id, "error", msg, "error");
    return;
  }
  await executePlan(id, plan);
}

/** Stage 2: collect → extract → validate/dedupe → store. Also used to refresh a dataset with its saved plan. */
export async function executePlan(id: string, plan: WorkflowPlan, opts: { refresh?: boolean } = {}) {
  const [prev] = await sql`SELECT stats, now() AS started FROM workflows WHERE id = ${id}`;
  const prevRuns = (prev?.stats as Workflow["stats"])?.runs ?? 0;
  const runs = (opts.refresh ? Math.max(prevRuns, 1) : prevRuns) + 1; // datasets from before run counting still refresh as #2
  // DB clock, so it compares cleanly with records.fetched_at (default now()) for NEW badges
  const startedAt = new Date(prev.started).toISOString();
  const stats: Workflow["stats"] = { runs, run_started_at: startedAt };
  // AI columns are filled on demand, not extracted from sources; keep their stored values untouched.
  const work: WorkflowPlan = { ...plan, fields: plan.fields.filter((f) => !f.ai) };
  try {
    if (opts.refresh) {
      await sql`DELETE FROM sources WHERE workflow_id = ${id}`;
      await logEvent(id, "refresh", `Refresh #${runs - 1}: re-collecting with the saved plan (no planning call needed)`);
    }
    await setStatus(id, "collecting", 15, { stats });

    // Collect (all sources in parallel)
    const results = await Promise.all(work.sources.map((step) => collectStep(id, step)));
    const collected = work.sources.map((s, i) => ({ connector: s.connector, items: results[i] }));
    stats.sources_ok = results.filter((r) => r.length).length;
    stats.sources_failed = work.sources.length - stats.sources_ok;

    // interleave sources so a cap doesn't starve any one of them; drop exact-URL repeats
    const seen = new Set<string>();
    const raw: RawItem[] = [];
    const MAX_RAW = maxRaw();
    for (let i = 0; raw.length < MAX_RAW && results.some((r) => r[i]); i++)
      for (const r of results)
        if (r[i] && !seen.has(r[i].url) && raw.length < MAX_RAW) {
          seen.add(r[i].url);
          raw.push(r[i]);
        }
    stats.raw = raw.length;
    await assertNotCancelled(id, stats.run_started_at);
    if (!raw.length) throw new UserFacingError("No data could be collected from any source. Try rephrasing the request.");
    await logEvent(id, "collect", `Collected ${raw.length} raw items from ${stats.sources_ok} sources`, "success");

    // Extract, streaming validated rows into the table after every batch
    await setStatus(id, "processing", 45, { stats });
    await logEvent(id, "extract", `Extracting structured "${work.entity}" rows…`);
    let sync = Promise.resolve(); // batches finish concurrently; apply their snapshots in order
    let lastLive = 0;
    const { rows, mode, keywordItems } = await extractAll(work, raw, async (done, total, note, rowsSoFar) => {
      await assertNotCancelled(id, stats.run_started_at); // throwing here stops the remaining batches
      if (note) await logEvent(id, "extract", tidyNote(note), "warn");
      await sql`UPDATE workflows SET progress = ${45 + Math.round((done / total) * 40)}, updated_at = now() WHERE id = ${id}`;
      if (!rowsSoFar || done === total) return; // the final sync happens after validation below
      const snapshot = validateAndDedupe(work, [...rowsSoFar]).clean;
      sync = sync
        .then(async () => {
          await syncRecords(id, snapshot);
          if (snapshot.length > lastLive) {
            await logEvent(id, "stream", `${snapshot.length} validated rows live (batch ${done}/${total})`);
            lastLive = snapshot.length;
          }
        })
        .catch((e) => console.error("live sync failed", e));
      await sync;
    });
    let llmOnly = mode === "llm";
    let keywordPages = keywordItems;
    stats.extracted = rows.length;
    await logEvent(id, "extract", `Extracted ${rows.length} candidate rows (${mode} extraction)`, "success");

    // Validate + dedupe
    let { clean, invalid, duplicates, reasons, relaxed } = validateAndDedupe(work, rows);

    // Thin result: one extra web search phrased from the dataset title, then validate everything again
    const want = Math.min(20, work.max_results);
    const topUpQuery = work.title.slice(0, 120);
    if (clean.length < want && !work.sources.some((s) => s.connector === "web_search" && s.query.toLowerCase() === topUpQuery.toLowerCase())) {
      await assertNotCancelled(id, stats.run_started_at);
      await logEvent(id, "collect", `Only ${clean.length} row${clean.length === 1 ? "" : "s"} so far, so running one extra web search`);
      const topUp = await collectStep(id, { connector: "web_search", query: topUpQuery, limit: 10 });
      collected.push({ connector: "web_search", items: topUp });
      const fresh = topUp.filter((it) => !seen.has(it.url));
      if (fresh.length) {
        fresh.forEach((it) => seen.add(it.url));
        stats.raw = (stats.raw ?? 0) + fresh.length;
        const more = await extractAll(work, fresh, async (_d, _t, note) => {
          await assertNotCancelled(id, stats.run_started_at);
          if (note) await logEvent(id, "extract", tidyNote(note), "warn");
        });
        llmOnly &&= more.mode === "llm";
        keywordPages += more.keywordItems;
        rows.push(...more.rows);
        ({ clean, invalid, duplicates, reasons, relaxed } = validateAndDedupe(work, rows));
        await logEvent(id, "extract", `Extra search added ${more.rows.length} candidate rows`, "success");
      }
    }
    stats.extracted = rows.length;
    // saved for the UI's "AI was unavailable for N pages" notice; the log line alone was easy to miss
    stats.keyword_pages = keywordPages;
    stats.extraction = keywordPages === 0 ? "llm" : keywordPages >= (stats.raw ?? 0) ? "heuristic" : "mixed";
    Object.assign(stats, { invalid, duplicates, valid: clean.length, dropped: reasons });
    const drops = describeDrops(reasons, identityField(work));
    const flagged = Object.entries(reasons.failed_filters).map(([f, n]) => `${n} marked ✗ for "${f}"`).join(" · ");
    if (relaxed) await logEvent(id, "validate", `Kept rows that miss a filter, ranked lower and marked ✗: ${flagged}`, "warn");
    await logEvent(id, "validate", `Validation: kept ${clean.length}, dropped ${invalid}${drops ? ` (${drops})` : ""}, merged ${duplicates} duplicates`);

    // Store the final snapshot; live batches already inserted most rows
    await sync;
    await assertNotCancelled(id, stats.run_started_at);
    // A bad run (nothing kept, AI fell back to keywords, a source down) must not delete rows it couldn't re-check
    const { ok, down } = prunableSources(collected);
    const skipPrune = !clean.length ? "no rows passed validation" : !llmOnly ? "AI extraction was unavailable for some pages" : null;
    const removed = await syncRecords(id, clean, { since: startedAt, sources: skipPrune ? [] : ok });
    if (runs > 1 && skipPrune) await logEvent(id, "refresh", `Kept previous data: ${skipPrune}, so older rows were not removed`, "warn");
    else if (runs > 1 && down.length) await logEvent(id, "refresh", `Kept previous data from ${down.join(", ")} (failed or found nothing this time)`, "warn");
    stats.stored = clean.length;
    if (runs > 1) {
      const [{ added }] = await sql`SELECT count(*)::int AS added FROM records WHERE workflow_id = ${id} AND fetched_at >= ${stats.run_started_at}`;
      Object.assign(stats, { added, removed });
      await logEvent(id, "refresh", `What changed: +${added} new, ${removed} no longer listed, ${clean.length - added} still there`, "success");
    }
    if (!clean.length)
      await logEvent(id, "validate", `No records matched the request${drops ? `: ${drops}` : ""}. Try loosening a filter in the plan, or say what kind of entity, where, and which details you need.`, "warn");
    await setStatus(id, "completed", 100, { stats });
    await logEvent(id, "store", `Dataset ready: ${clean.length} clean, source-backed records`, "success");
  } catch (e) {
    if (e instanceof CancelledError) {
      await logEvent(id, "cancel", `Stopped by you. ${(await sql`SELECT count(*)::int AS c FROM records WHERE workflow_id = ${id}`)[0].c} rows collected so far were kept.`, "warn");
      return;
    }
    const msg = runFailure(id, e);
    await setStatus(id, "failed", 100, { stats, error: msg });
    await logEvent(id, "error", msg, "error");
  }
}
