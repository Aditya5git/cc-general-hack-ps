import { after, NextResponse } from "next/server";
import { setStatus, sql } from "@/lib/db";
import { executePlan } from "@/lib/pipeline/run";
import type { WorkflowPlan } from "@/lib/types";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** Called by Vercel Cron (see vercel.json): refresh watched datasets whose interval has elapsed. */
export async function GET(req: Request) {
  // fail closed: without a secret anyone could trigger refreshes and spend LLM/Firecrawl quota
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.get("authorization") !== `Bearer ${secret}`) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const due = await sql`SELECT id, plan FROM workflows
    WHERE status IN ('completed', 'failed', 'cancelled') AND plan ? 'watch'
      AND COALESCE(finished_at, updated_at) < now() - make_interval(hours => (plan->'watch'->>'every_hours')::int)
    ORDER BY finished_at LIMIT 3`;
  for (const w of due) await setStatus(w.id, "queued", 10);
  after(() => Promise.all(due.map((w) => executePlan(w.id, w.plan as WorkflowPlan, { refresh: true }))));
  return NextResponse.json({ refreshed: due.map((w) => w.id) });
}
