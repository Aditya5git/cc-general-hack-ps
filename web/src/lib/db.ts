import { neon, type NeonQueryFunction } from "@neondatabase/serverless";
import type { WorkflowEvent, WorkflowStatus } from "./types";

// Connect lazily so `next build` works without DATABASE_URL; it's only needed at request time.
let client: NeonQueryFunction<false, false> | undefined;
export const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not set");
  client ??= neon(process.env.DATABASE_URL);
  return client(strings, ...values);
}) as NeonQueryFunction<false, false>;

export async function logEvent(
  workflowId: string,
  step: string,
  message: string,
  level: WorkflowEvent["level"] = "info",
) {
  await sql`INSERT INTO workflow_events (workflow_id, step, level, message)
            VALUES (${workflowId}, ${step}, ${level}, ${message})`;
}

export async function setStatus(
  workflowId: string,
  status: WorkflowStatus,
  progress: number,
  extra: { plan?: unknown; title?: string; stats?: unknown; error?: string } = {},
) {
  const done = status === "completed" || status === "failed" || status === "cancelled";
  // a run passes its stats: once a newer run is stamped (Stop, then Resume), the old one can't overwrite its status
  const run = (extra.stats as { run_started_at?: string } | undefined)?.run_started_at ?? null;
  await sql`UPDATE workflows SET
      status = ${status},
      progress = ${progress},
      plan = COALESCE(${extra.plan ? JSON.stringify(extra.plan) : null}::jsonb, plan),
      title = COALESCE(${extra.title ?? null}, title),
      stats = COALESCE(${extra.stats ? JSON.stringify(extra.stats) : null}::jsonb, stats),
      error = ${extra.error ?? null},
      updated_at = now(),
      finished_at = ${done ? new Date().toISOString() : null}
    WHERE id = ${workflowId} AND (status <> 'cancelled' OR ${status} = 'queued')
      AND (${run}::timestamptz IS NULL OR COALESCE((stats->>'run_started_at')::timestamptz <= ${run}::timestamptz, true))`;
}

/**
 * Start a run only if the workflow is still in one of `from`: check and update are one statement, so of two
 * clicks (or tabs) landing together exactly one wins. Returns false for the loser; send it a 409.
 */
export async function claimRun(workflowId: string, from: WorkflowStatus[], to: WorkflowStatus, progress: number, plan?: unknown) {
  const rows = await sql`UPDATE workflows SET
      status = ${to},
      progress = ${progress},
      plan = COALESCE(${plan ? JSON.stringify(plan) : null}::jsonb, plan),
      -- stamp the new run now, so a stopped run still finishing a step can't mark this one completed
      stats = jsonb_set(stats, '{run_started_at}', to_jsonb(now())),
      error = NULL,
      updated_at = now(),
      finished_at = NULL
    WHERE id = ${workflowId} AND status = ANY(${from})
    RETURNING id`;
  return rows.length > 0;
}

export class CancelledError extends Error {
  constructor() {
    super("Stopped by user");
  }
}

/**
 * Throw if the user stopped this workflow, or (with `runStartedAt`) if a newer run of it has started since,
 * e.g. Resume pressed while a stopped run was still finishing a step. Checked between stages and batches.
 */
export async function assertNotCancelled(workflowId: string, runStartedAt?: string) {
  const [w] = await sql`SELECT status, stats->>'run_started_at' AS run FROM workflows WHERE id = ${workflowId}`;
  if (!w || w.status === "cancelled" || (runStartedAt && w.run && w.run !== runStartedAt)) throw new CancelledError();
}

const RUNNING = ["queued", "planning", "collecting", "processing"];
/**
 * Delete a workflow unless a run is in progress (it would keep spending LLM/Firecrawl calls, then fail writing to
 * rows that are gone). One statement, so a run can't start between check and delete. False = still running.
 */
export async function deleteIdleWorkflow(workflowId: string) {
  const rows = await sql`DELETE FROM workflows WHERE id = ${workflowId} AND status <> ALL(${RUNNING}) RETURNING id`;
  return rows.length > 0;
}

/** Runs execute inside a serverless request; if it dies, nothing else would ever finish them. */
export async function failStuckWorkflows(minutes = 8) {
  await sql`UPDATE workflows SET status = 'failed', progress = 100, finished_at = now(), updated_at = now(),
      error = 'This run was interrupted (the server restarted or timed out). Use Rerun or Refresh to try again.'
    WHERE status = ANY(${RUNNING}) AND updated_at < now() - make_interval(mins => ${minutes})`;
}

// Hourly caps per user. "run" = new workflow, Rerun or Refresh; "ai" = Ask question or AI column.
// RUN_LIMIT_PER_HOUR / AI_LIMIT_PER_HOUR override the defaults (e.g. raise them for demo rehearsals).
const hourly = (env: string, fallback: number) => Math.max(Math.floor(Number(process.env[env])) || fallback, 1);
const LIMITS = { run: () => hourly("RUN_LIMIT_PER_HOUR", 5), ai: () => hourly("AI_LIMIT_PER_HOUR", 30) };
const LIMIT_LABEL = { run: "runs", ai: "AI questions and columns" } as const;

/**
 * Count one use of `kind` for this user, or return a friendly message if they're at the hourly cap (send it as a
 * 429). Check and insert are one statement; two requests landing at the same instant can still both get through.
 */
export async function overUsageLimit(userId: string, kind: keyof typeof LIMITS): Promise<string | null> {
  const max = LIMITS[kind]();
  const taken = await sql`INSERT INTO usage_events (user_id, kind)
    SELECT ${userId}, ${kind}
    WHERE (SELECT count(*) FROM usage_events
           WHERE user_id = ${userId} AND kind = ${kind} AND created_at > now() - interval '1 hour') < ${max}
    RETURNING id`;
  if (taken.length) return null;
  const [{ mins }] = await sql`SELECT greatest(1, ceil(extract(epoch FROM min(created_at) + interval '1 hour' - now()) / 60))::int AS mins
    FROM usage_events WHERE user_id = ${userId} AND kind = ${kind} AND created_at > now() - interval '1 hour'`;
  return `You've reached the limit of ${max} ${LIMIT_LABEL[kind]} per hour. Try again in about ${mins ?? 60} minute${mins === 1 ? "" : "s"}.`;
}
