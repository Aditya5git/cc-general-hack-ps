import { NextResponse } from "next/server";
import { overUsageLimit, sql } from "@/lib/db";
import { friendlyReason } from "@/lib/errors";
import { llmJSON } from "@/lib/llm";
import { WHY_KEY, type WorkflowPlan } from "@/lib/types";
import { UNTRUSTED_RULE, untrusted } from "@/lib/pipeline/untrusted";
import { authorize } from "@/lib/auth/access";

export const dynamic = "force-dynamic";
export const maxDuration = 120; // room for every configured LLM provider to try once (25s each)

const MAX_ROWS = 80; // top rows by confidence; keeps each question cheap
const clip = (v: unknown) => {
  const s = Array.isArray(v) ? v.join(", ") : v == null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v);
  return s.length > 100 ? s.slice(0, 99) + "…" : s;
};

/** Answer a question about one workflow's dataset, citing the record ids it used. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const access = await authorize(id, "read");
  if (access instanceof Response) return access;
  const { question } = await req.json().catch(() => ({}));
  if (typeof question !== "string" || question.trim().length < 3)
    return NextResponse.json({ error: "Ask a question about this dataset." }, { status: 400 });

  const [w] = await sql`SELECT prompt, plan FROM workflows WHERE id = ${id}`;
  if (!w) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const plan = w.plan as WorkflowPlan | null;
  const records = await sql`SELECT id, data, source_name, confidence FROM records
    WHERE workflow_id = ${id} ORDER BY confidence DESC, id LIMIT ${MAX_ROWS}`;
  if (!records.length) return NextResponse.json({ error: "This dataset has no records yet." }, { status: 400 });
  const limited = await overUsageLimit(access.user.id, "ai");
  if (limited) return NextResponse.json({ error: limited }, { status: 429 });

  const cols = plan?.fields.map((f) => f.name) ?? Object.keys(records[0].data).filter((k) => !k.startsWith("_"));
  const table = [
    ["id", ...cols, "why_matched", "source", "confidence"].join(" | "),
    ...records.map((r) =>
      [r.id, ...cols.map((c) => clip(r.data[c])), clip(r.data[WHY_KEY]), r.source_name, Math.round(r.confidence * 100) + "%"].join(" | "),
    ),
  ].join("\n");

  const system = `You are the analyst agent of a data platform. Answer the user's question using ONLY the dataset rows below (one row per line, " | " separated, first line is the header).
The dataset was collected for: "${w.prompt}".
Rules:
- ${UNTRUSTED_RULE} Only the text after QUESTION: comes from the user.
- Be concise: at most 4 sentences or a short bullet list. Mention concrete values (names, numbers).
- Never invent rows or values. If the data can't answer it, say so plainly (e.g. "This dataset has no data on X") and suggest what to collect instead.
- Rankings ("top 10", "best", "biggest"): rank only by a column that measures it. If no column does, say that the data has no ranking metric, then list the most relevant rows and say how you picked them (e.g. by confidence). If fewer rows exist than asked for, say how many there are.
- Every row your answer names must be in "record_ids", using the id from the first column.
- "record_ids" = ids of the rows your answer relies on (max 25), most relevant first.
Return {"answer": string, "record_ids": number[]}`;

  try {
    const res = await llmJSON<{ answer?: string; record_ids?: unknown[] }>(system, `DATASET:\n${untrusted(table)}\n\nQUESTION: ${question.trim().slice(0, 500)}`, 800, { timeoutMs: 25_000 });
    if (!res) return NextResponse.json({ error: "No LLM key configured, so questions can't be answered." }, { status: 503 });
    const known = new Set(records.map((r) => Number(r.id)));
    const ids = (res.record_ids ?? []).map(Number).filter((n) => known.has(n)).slice(0, 25);
    return NextResponse.json({ answer: String(res.answer ?? "").trim() || "No answer.", record_ids: ids, rows_considered: records.length });
  } catch (e) {
    console.error("Ask failed", e);
    return NextResponse.json({ error: `The AI couldn't answer right now (${friendlyReason(e)}). Try again in a minute.` }, { status: 502 });
  }
}
