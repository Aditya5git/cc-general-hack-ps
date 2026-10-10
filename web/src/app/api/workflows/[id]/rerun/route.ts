import { NextResponse } from "next/server";
import { overUsageLimit, sql } from "@/lib/db";
import { createWorkflow } from "@/lib/workflows";
import { authorize } from "@/lib/auth/access";
import { blockedReason } from "@/lib/pipeline/safety";

export const maxDuration = 300;

export async function POST(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const access = await authorize(id, "read");
  if (access instanceof Response) return access;
  const [w] = await sql`SELECT prompt FROM workflows WHERE id = ${id}`;
  if (!w) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const blocked = blockedReason(w.prompt as string);
  if (blocked) return NextResponse.json({ error: blocked }, { status: 400 });
  // a double click (or two tabs) gets the copy the first click just started instead of a second one
  const [recent] = await sql`SELECT id FROM workflows WHERE owner_id = ${access.user.id} AND prompt = ${w.prompt}
    AND id <> ${id} AND created_at > now() - interval '15 seconds' ORDER BY created_at DESC LIMIT 1`;
  if (recent) return NextResponse.json({ id: recent.id });
  const limited = await overUsageLimit(access.user.id, "run");
  if (limited) return NextResponse.json({ error: limited }, { status: 429 });
  return NextResponse.json({ id: await createWorkflow(w.prompt as string, { ownerId: access.user.id }) });
}
