import { NextResponse } from "next/server";
import { sql } from "@/lib/db";
import { llmJSON } from "@/lib/llm";
import { WHY_KEY, type FieldSpec, type WorkflowPlan } from "@/lib/types";
import { UNTRUSTED_RULE, untrusted } from "@/lib/pipeline/untrusted";
import { authorize } from "@/lib/auth/access";

export const dynamic = "force-dynamic";
export const maxDuration = 120; // batches run in parallel; each LLM attempt is capped at 25s so failover fits

const MAX_ROWS = 60;
const BATCH = 30; // ≤ 2 LLM calls per column
const clip = (v: unknown) => {
  const s = Array.isArray(v) ? v.join(", ") : v == null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v);
  return s.length > 120 ? s.slice(0, 119) + "…" : s;
};

const host = (u: unknown) => {
  try { return new URL(String(u)).hostname; } catch { return ""; }
};

function columnName(question: string, taken: Set<string>) {
  const words = question.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/)
    .filter((w) => w && !/^(is|are|does|do|the|a|an|this|it|its|of|for|to|in|on|what|which|how|has|have|they|their)$/.test(w));
  const base = words.slice(0, 4).join("_").slice(0, 40) || "ai_column";
  let name = base;
  for (let i = 2; taken.has(name); i++) name = `${base}_${i}`;
  return name;
}

/** "Add AI column": answer one question for every row, store it as a new plan field. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const access = await authorize(id, "write");
  if (access instanceof Response) return access;
  const { question } = await req.json().catch(() => ({}));
  if (typeof question !== "string" || question.trim().length < 3)
    return NextResponse.json({ error: "Describe what the new column should contain." }, { status: 400 });
  const q = question.trim().slice(0, 200);

  const [w] = await sql`SELECT prompt, plan, status FROM workflows WHERE id = ${id}`;
  if (!w) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (!["completed", "failed", "cancelled"].includes(w.status)) return NextResponse.json({ error: "Wait for the workflow to finish first." }, { status: 409 });
  const plan = w.plan as WorkflowPlan | null;
  if (!plan) return NextResponse.json({ error: "This workflow has no plan." }, { status: 400 });

  const records = await sql`SELECT id, data, source_url FROM records WHERE workflow_id = ${id} ORDER BY confidence DESC, id LIMIT ${MAX_ROWS}`;
  if (!records.length) return NextResponse.json({ error: "No records to enrich." }, { status: 400 });

  const name = columnName(q, new Set(plan.fields.map((f) => f.name)));
  const cols = plan.fields.map((f) => f.name);
  const system = `You are the enrichment agent of a data platform. For every row, answer this question as a new spreadsheet column:
"${q}"
Dataset purpose: "${w.prompt}". Each row is one ${plan.entity}.
Rules:
- ${UNTRUSTED_RULE}
- Use ONLY the row's own values. Do not use outside or remembered knowledge, even about famous entities. If the row doesn't contain the answer, value is null.
- "value": the cell content, max 12 words. Start yes/no questions with "Yes" or "No". Use null if it can't be determined.
- "basis": max 15 words naming which of the row's values the answer is based on.
Return {"answers": [{"id": number, "value": string|null, "basis": string}]}`;

  const batches: (typeof records)[] = [];
  for (let i = 0; i < records.length; i += BATCH) batches.push(records.slice(i, i + BATCH));
  const answers = new Map<number, { value: string | null; basis: string }>();
  let failed = 0;
  await Promise.all(
    batches.map(async (rows) => {
      const lines = rows.map((r) => `id=${r.id} | ` + [...cols.map((c) => `${c}: ${clip(r.data[c])}`), `why_matched: ${clip(r.data[WHY_KEY])}`, `source: ${host(r.source_url)}`].join(" | "));
      try {
        const res = await llmJSON<{ answers?: { id: number; value: unknown; basis?: unknown }[] }>(system, untrusted(lines.join("\n")), 2000, { timeoutMs: 25_000 });
        if (!res) throw new Error("No LLM key configured");
        for (const a of res.answers ?? [])
          if (rows.some((r) => Number(r.id) === Number(a.id)))
            answers.set(Number(a.id), { value: a.value == null || a.value === "" ? null : String(a.value).slice(0, 160), basis: String(a.basis ?? "").slice(0, 160) });
      } catch (e) {
        failed++;
        console.error("AI column batch failed", e);
      }
    }),
  );
  if (!answers.size) return NextResponse.json({ error: "The AI couldn't fill this column right now. Try again in a minute." }, { status: 502 });

  const updates = [...answers].map(([rid, a]) => ({ id: rid, patch: { [name]: a.value, [`_basis_${name}`]: a.basis } }));
  await sql`UPDATE records r SET data = r.data || u.patch
    FROM jsonb_to_recordset(${JSON.stringify(updates)}::jsonb) AS u(id bigint, patch jsonb)
    WHERE r.id = u.id AND r.workflow_id = ${id}`;
  const field: FieldSpec = { name, type: "string", description: q, ai: true };
  await sql`UPDATE workflows SET plan = jsonb_set(plan, '{fields}', (plan->'fields') || ${JSON.stringify([field])}::jsonb), updated_at = now() WHERE id = ${id}`;
  await sql`INSERT INTO workflow_events (workflow_id, step, level, message)
    VALUES (${id}, 'enrich', 'success', ${`AI column "${q}" filled for ${answers.size} of ${records.length} rows${failed ? ` (${failed} batch${failed > 1 ? "es" : ""} failed)` : ""}`})`;
  return NextResponse.json({ field, filled: answers.size, total: records.length });
}
