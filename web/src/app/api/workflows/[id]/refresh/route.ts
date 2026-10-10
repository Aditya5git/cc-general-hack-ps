import { after, NextResponse } from "next/server";
import { claimRun, overUsageLimit, sql } from "@/lib/db";
import { executePlan } from "@/lib/pipeline/run";
import type { WorkflowPlan } from "@/lib/types";
import { authorize } from "@/lib/auth/access";

export const maxDuration = 300;

/** Re-collect with the saved plan in place; rows first seen in this run get NEW badges. */
export async function POST(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const access = await authorize(id, "write");
  if (access instanceof Response) return access;
  const [w] = await sql`SELECT status, plan FROM workflows WHERE id = ${id}`;
  if (!w) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (!["completed", "failed", "cancelled"].includes(w.status)) return NextResponse.json({ error: "Wait for the current run to finish." }, { status: 409 });
  if (!w.plan) return NextResponse.json({ error: "This workflow has no plan to refresh." }, { status: 400 });
  const limited = await overUsageLimit(access.user.id, "run");
  if (limited) return NextResponse.json({ error: limited }, { status: 429 });
  if (!(await claimRun(id, ["completed", "failed", "cancelled"], "queued", 10)))
    return NextResponse.json({ error: "Wait for the current run to finish." }, { status: 409 });
  after(() => executePlan(id, w.plan as WorkflowPlan, { refresh: true }));
  return NextResponse.json({ ok: true });
}
