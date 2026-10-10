import { NextResponse } from "next/server";
import { deleteIdleWorkflow, failStuckWorkflows, logEvent, sql } from "@/lib/db";
import { authorize } from "@/lib/auth/access";

export const dynamic = "force-dynamic";

export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const access = await authorize(id, "read");
  if (access instanceof Response) return access;
  await failStuckWorkflows();
  const [workflow] = await sql`SELECT * FROM workflows WHERE id = ${id}`;
  if (!workflow) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const [events, sources, [{ count }]] = await Promise.all([
    sql`SELECT id, step, level, message, created_at FROM workflow_events WHERE workflow_id = ${id} ORDER BY id`,
    sql`SELECT id, connector, query, url, status, items, duration_ms, error, pages FROM sources WHERE workflow_id = ${id} ORDER BY id`,
    sql`SELECT count(*)::int AS count FROM records WHERE workflow_id = ${id}`,
  ]);
  const can_edit = workflow.owner_id === access.user.id; // shared examples (no owner) are read-only
  return NextResponse.json({ workflow: { ...workflow, record_count: count }, events, sources, record_count: count, can_edit });
}

export async function DELETE(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const access = await authorize(id, "write");
  if (access instanceof Response) return access;
  if (!(await deleteIdleWorkflow(id)))
    return NextResponse.json({ error: "This workflow is still running. Stop it first, then delete it." }, { status: 409 });
  return NextResponse.json({ ok: true });
}

/** Watch a dataset: refresh it every N hours (0 turns watching off). */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const access = await authorize(id, "write");
  if (access instanceof Response) return access;
  const { watch_hours } = await req.json().catch(() => ({}));
  const hours = Number(watch_hours);
  if (!Number.isInteger(hours) || hours < 0 || hours > 24 * 30) return NextResponse.json({ error: "watch_hours must be 0–720" }, { status: 400 });
  const [w] = hours
    ? await sql`UPDATE workflows SET plan = jsonb_set(plan, '{watch}', ${JSON.stringify({ every_hours: hours })}::jsonb) WHERE id = ${id} AND plan IS NOT NULL RETURNING id`
    : await sql`UPDATE workflows SET plan = plan - 'watch' WHERE id = ${id} AND plan IS NOT NULL RETURNING id`;
  if (!w) return NextResponse.json({ error: "Not found" }, { status: 404 });
  await logEvent(id, "watch", hours ? `Watching: auto-refresh every ${hours >= 24 ? `${hours / 24} day(s)` : `${hours}h`}` : "Stopped watching");
  return NextResponse.json({ ok: true });
}
