import { after, NextResponse } from "next/server";
import { claimRun, logEvent, sql } from "@/lib/db";
import { executePlan } from "@/lib/pipeline/run";
import { applyPlanEdits } from "@/lib/pipeline/planner";
import type { WorkflowPlan } from "@/lib/types";
import { authorize } from "@/lib/auth/access";

export const maxDuration = 300;

/** Approve a reviewed plan (with the user's edits) and start collecting. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const access = await authorize(id, "write");
  if (access instanceof Response) return access;
  const { plan: edited } = await req.json().catch(() => ({}));
  const [w] = await sql`SELECT status, plan FROM workflows WHERE id = ${id}`;
  if (!w) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (w.status !== "review") return NextResponse.json({ error: "This workflow isn't waiting for review." }, { status: 409 });
  let plan: WorkflowPlan;
  try {
    plan = applyPlanEdits(w.plan as WorkflowPlan, edited ?? {});
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
  if (!(await claimRun(id, ["review"], "collecting", 15, plan)))
    return NextResponse.json({ error: "This workflow isn't waiting for review." }, { status: 409 });
  await logEvent(id, "plan", `Plan approved: ${plan.fields.length} columns, ${plan.sources.length} sources, ${plan.filters.length} filters`, "success");
  after(() => executePlan(id, plan));
  return NextResponse.json({ ok: true });
}
