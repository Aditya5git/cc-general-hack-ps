import { NextResponse } from "next/server";
import { sql } from "@/lib/db";
import { authorize } from "@/lib/auth/access";
import { rankRows } from "@/lib/pipeline/validate";
import type { DataRecord, WorkflowPlan } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const access = await authorize(id, "read");
  if (access instanceof Response) return access;
  const [w] = await sql`SELECT plan FROM workflows WHERE id = ${id}`;
  const records = await sql`SELECT id, data, source_name, source_url, confidence, fetched_at
    FROM records WHERE workflow_id = ${id} ORDER BY confidence DESC, id`;
  // in the plan's order ("top by market cap"), not just by score; ids arrive as strings, send numbers so they
  // match the ids "Ask" answers cite
  const ranked = rankRows(w?.plan as WorkflowPlan | null, records as DataRecord[]);
  return NextResponse.json({ records: ranked.map((r) => ({ ...r, id: Number(r.id) })) });
}
