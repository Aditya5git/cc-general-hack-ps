import { NextResponse } from "next/server";
import { failStuckWorkflows, overUsageLimit, sql } from "@/lib/db";
import { createWorkflow } from "@/lib/workflows";
import { requireUser } from "@/lib/auth/access";
import { blockedReason } from "@/lib/pipeline/safety";

export const maxDuration = 300;
export const dynamic = "force-dynamic";

export async function GET() {
  const user = await requireUser();
  if (user instanceof Response) return user;
  await failStuckWorkflows();
  const workflows = await sql`
    SELECT w.*, (SELECT count(*)::int FROM records r WHERE r.workflow_id = w.id) AS record_count
    FROM workflows w WHERE w.owner_id = ${user.id} OR w.owner_id IS NULL
    ORDER BY (w.owner_id IS NULL), w.created_at DESC LIMIT 200`;
  return NextResponse.json({ workflows });
}

export async function POST(req: Request) {
  const user = await requireUser();
  if (user instanceof Response) return user;
  const { prompt, review } = await req.json().catch(() => ({}));
  if (typeof prompt !== "string" || prompt.trim().length < 5)
    return NextResponse.json({ error: "Describe the data you need (at least a few words)." }, { status: 400 });
  const blocked = blockedReason(prompt);
  if (blocked) return NextResponse.json({ error: blocked }, { status: 400 });
  const limited = await overUsageLimit(user.id, "run");
  if (limited) return NextResponse.json({ error: limited }, { status: 429 });
  const id = await createWorkflow(prompt.trim().slice(0, 2000), { review: review === true, ownerId: user.id });
  return NextResponse.json({ id });
}
