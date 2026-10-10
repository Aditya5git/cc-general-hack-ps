import { sql } from "@/lib/db";
import { CHECKS_KEY, WHY_KEY, type DataRecord, type WorkflowPlan } from "@/lib/types";
import { authorize } from "@/lib/auth/access";
import { rankRows } from "@/lib/pipeline/validate";

export const dynamic = "force-dynamic";

const csvCell = (v: unknown) => {
  const s = v == null ? "" : Array.isArray(v) ? v.join("; ") : typeof v === "object" ? JSON.stringify(v) : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const access = await authorize(id, "read");
  if (access instanceof Response) return access;
  const format = new URL(req.url).searchParams.get("format") === "json" ? "json" : "csv";
  const [w] = await sql`SELECT title, prompt, plan FROM workflows WHERE id = ${id}`;
  if (!w) return new Response("Not found", { status: 404 });
  // same order as the table: the plan's sort ("top by market cap"), then score
  const records = rankRows(
    w.plan as WorkflowPlan | null,
    (await sql`SELECT data, source_name, source_url, confidence, fetched_at FROM records WHERE workflow_id = ${id} ORDER BY confidence DESC, id`) as DataRecord[],
  );
  const slug = String(w.title || "dataset").toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 50);
  const plan = w.plan as WorkflowPlan | null;
  const cols = plan?.fields.map((f) => f.name) ?? [...new Set(records.flatMap((r) => Object.keys(r.data)))].filter((k) => !k.startsWith("_"));
  const criteria = plan?.filters ?? [];
  // { "posted in last 7 days": true, ... } keyed by the plan's plain-English filters
  const checksOf = (data: Record<string, unknown>) => {
    const c = Array.isArray(data[CHECKS_KEY]) ? (data[CHECKS_KEY] as (boolean | null)[]) : [];
    return c.length ? Object.fromEntries(criteria.map((name, i) => [name, c[i] ?? null])) : null;
  };
  const criteriaMet = (data: Record<string, unknown>) => {
    const c = checksOf(data);
    return c ? `${Object.values(c).filter((v) => v === true).length}/${criteria.length}` : "";
  };

  if (format === "json") {
    const body = JSON.stringify({ title: w.title, prompt: w.prompt, schema: plan?.fields, count: records.length,
      criteria,
      records: records.map((r) => ({ ...Object.fromEntries(cols.map((c) => [c, r.data[c] ?? null])), _why: r.data[WHY_KEY] ?? null,
        _criteria: checksOf(r.data), _source: r.source_name, _source_url: r.source_url, _confidence: r.confidence, _fetched_at: r.fetched_at })) }, null, 2);
    return new Response(body, { headers: { "content-type": "application/json", "content-disposition": `attachment; filename="${slug}.json"` } });
  }
  const header = [...cols, "why_matched", "criteria_met", "source", "source_url", "confidence", "fetched_at"];
  const lines = [header.join(","), ...records.map((r) =>
    [...cols.map((c) => r.data[c]), r.data[WHY_KEY], criteriaMet(r.data), r.source_name, r.source_url, r.confidence, new Date(r.fetched_at).toISOString()].map(csvCell).join(","))];
  return new Response(lines.join("\n"), { headers: { "content-type": "text/csv", "content-disposition": `attachment; filename="${slug}.csv"` } });
}
