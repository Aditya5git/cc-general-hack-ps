/**
 * DataPilot evaluation harness.
 *
 *   pnpm eval            run every prompt in eval/prompts.json through the real pipeline (uses LLM quota)
 *   pnpm eval --no-ai    same, with LLM keys ignored (rule-based planner + extractor), costs nothing
 *   pnpm eval --lite     ~4 LLM calls per prompt instead of ~16: 15 items per extraction call, 45 raw items max
 *   pnpm eval --only jobs,crypto
 *   pnpm eval --replay   reuse the plan and fetched pages saved in eval/cache by the last live run: no
 *                        planner call and no Firecrawl credits, only the extraction calls
 *   pnpm eval:score eval/out/<run>/labels.csv    precision (with a 95% Wilson interval) from a hand-labelled sheet
 *
 * Automatic metrics per prompt: rows, quote-verified rate, field fill rate, rows passing all conditions,
 * failed sources, duration, LLM requests and tokens, Firecrawl credits. A rate-limited Gemini request fails
 * instead of retrying on lighter models (LLM_NO_FALLBACK), so the request count stays predictable. Precision needs a human: label.csv gets one line per row with an empty
 * `correct` column (y/n). Workflows are kept (id prefix "eval") so they can be inspected in the UI.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { nanoid } from "nanoid";
import { CONNECTORS } from "../src/lib/connectors";
import { sql } from "../src/lib/db";
import { llmUsage } from "../src/lib/llm";
import { executePlan, runWorkflow } from "../src/lib/pipeline/run";
import { CHECKS_KEY, QUOTE_KEY, QUOTE_OK_KEY, WHY_KEY, type ConnectorId, type ConnectorResult, type Workflow, type WorkflowPlan } from "../src/lib/types";

const args = process.argv.slice(2);
const csvCell = (v: unknown) => {
  const s = v == null ? "" : Array.isArray(v) ? v.join("; ") : typeof v === "object" ? JSON.stringify(v) : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const pct = (n: number, d: number) => (d ? Math.round((n / d) * 100) : 0);

/** 95% Wilson score interval for y successes out of n, as whole percents. */
function wilson(y: number, n: number): [number, number] {
  if (!n) return [0, 0];
  const z = 1.96, p = y / n, d = 1 + (z * z) / n;
  const mid = (p + (z * z) / (2 * n)) / d;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return [Math.round((mid - half) * 100), Math.round((mid + half) * 100)];
}

/** Remaining credits on the first Firecrawl key, or null when there is no key or the call fails. */
async function firecrawlCredits(): Promise<number | null> {
  const key = process.env.FIRECRAWL_API_KEY?.split(",")[0].trim();
  if (!key) return null;
  try {
    const res = await fetch("https://api.firecrawl.dev/v2/team/credit-usage", { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(20_000) });
    return (await res.json()).data?.remainingCredits ?? null;
  } catch {
    return null;
  }
}

// Every connector call goes through here: a live run records results per prompt, --replay serves them back.
type SourceCache = Record<string, ConnectorResult>;
let cache: SourceCache = {};
let replaying = false;
for (const [cid, c] of Object.entries(CONNECTORS)) {
  const live = c.run;
  c.run = async (query, limit) => {
    const key = `${cid as ConnectorId}|${query}|${limit}`;
    if (replaying) return cache[key] ?? (console.warn(`  no saved result for ${key}, treating as empty`), { items: [] });
    return (cache[key] = await live(query, limit));
  };
}

async function score(file: string) {
  const lines = readFileSync(file, "utf8").trim().split("\n").slice(1);
  const by = new Map<string, { y: number; n: number; blank: number }>();
  for (const line of lines) {
    const cells = line.match(/("([^"]|"")*"|[^,]*)(,|$)/g)!.map((c) => c.replace(/,$/, "").replace(/^"|"$/g, ""));
    const [prompt, correct] = [cells[0], (cells[1] ?? "").trim().toLowerCase()];
    const s = by.get(prompt) ?? { y: 0, n: 0, blank: 0 };
    if (correct.startsWith("y")) s.y++;
    else if (correct.startsWith("n")) s.n++;
    else s.blank++;
    by.set(prompt, s);
  }
  let Y = 0, N = 0;
  console.log("prompt".padEnd(12), "precision".padStart(10), "95% CI".padStart(10), "labelled".padStart(9), "unlabelled".padStart(11));
  for (const [p, s] of by) {
    Y += s.y;
    N += s.n;
    const [lo, hi] = wilson(s.y, s.y + s.n);
    console.log(p.padEnd(12), (s.y + s.n ? `${pct(s.y, s.y + s.n)}%` : "—").padStart(10), (s.y + s.n ? `${lo}–${hi}%` : "—").padStart(10), String(s.y + s.n).padStart(9), String(s.blank).padStart(11));
  }
  const [lo, hi] = wilson(Y, Y + N);
  console.log("overall".padEnd(12), `${pct(Y, Y + N)}%`.padStart(10), `${lo}–${hi}%`.padStart(10), String(Y + N).padStart(9));
}

async function run() {
  if (args.includes("--lite")) {
    process.env.EXTRACT_BATCH = "15";
    process.env.MAX_RAW_ITEMS = "45";
  }
  if (!args.includes("--fallback")) process.env.LLM_NO_FALLBACK = "1";
  replaying = args.includes("--replay");
  if (args.includes("--no-ai")) for (const k of ["GEMINI_API_KEY", "OPENROUTER_API_KEY", "ANTHROPIC_API_KEY", "OPENAI_API_KEY"]) delete process.env[k];
  const only = args.includes("--only") ? args[args.indexOf("--only") + 1].split(",") : null;
  const prompts = (JSON.parse(readFileSync(join(__dirname, "../eval/prompts.json"), "utf8")) as { id: string; prompt: string }[]).filter(
    (p) => !only || only.includes(p.id),
  );
  const out = join(__dirname, "../eval/out", new Date().toISOString().replace(/[:.]/g, "-") + (args.includes("--no-ai") ? "-noai" : "") + (args.includes("--lite") ? "-lite" : "") + (replaying ? "-replay" : ""));
  mkdirSync(out, { recursive: true });

  const summary: Record<string, unknown>[] = [];
  const labels = ["prompt,correct,why_wrong,row,source_url,quote_verified,why_matched"];
  for (const p of prompts) {
    const id = `eval${nanoid(6)}`;
    const dir = join(__dirname, "../eval/cache", p.id);
    const before = { ...llmUsage };
    const credits0 = replaying ? null : await firecrawlCredits();
    const t0 = Date.now();
    if (replaying) {
      if (!existsSync(join(dir, "plan.json"))) {
        console.log(JSON.stringify({ id: p.id, skipped: "no saved run in eval/cache, run without --replay first" }));
        continue;
      }
      const plan = JSON.parse(readFileSync(join(dir, "plan.json"), "utf8")) as WorkflowPlan;
      cache = JSON.parse(readFileSync(join(dir, "sources.json"), "utf8"));
      await sql`INSERT INTO workflows (id, prompt, status, plan, title) VALUES (${id}, ${p.prompt}, 'queued', ${JSON.stringify(plan)}::jsonb, ${plan.title})`;
      await executePlan(id, plan);
    } else {
      cache = {};
      await sql`INSERT INTO workflows (id, prompt, status) VALUES (${id}, ${p.prompt}, 'queued')`;
      await runWorkflow(id, p.prompt); // sequential on purpose: keeps LLM rate limits happy
    }
    const secs = Math.round((Date.now() - t0) / 1000);
    const credits1 = credits0 == null ? null : await firecrawlCredits();
    const [w] = (await sql`SELECT status, plan, stats, error FROM workflows WHERE id = ${id}`) as unknown as (Workflow & { plan: WorkflowPlan })[];
    const rows = await sql`SELECT data, source_name, source_url FROM records WHERE workflow_id = ${id} ORDER BY confidence DESC`;
    if (!replaying && w.plan) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "plan.json"), JSON.stringify(w.plan, null, 2));
      writeFileSync(join(dir, "sources.json"), JSON.stringify(cache));
    }
    const fields = w.plan?.fields.map((f) => f.name) ?? [];
    const filled = rows.reduce((n, r) => n + fields.filter((f) => r.data[f] != null && r.data[f] !== "").length, 0);
    const withQuote = rows.filter((r) => r.data[QUOTE_KEY]).length;
    const verified = rows.filter((r) => r.data[QUOTE_OK_KEY] === true).length;
    const checked = rows.filter((r) => Array.isArray(r.data[CHECKS_KEY]));
    const allMet = checked.filter((r) => (r.data[CHECKS_KEY] as (boolean | null)[]).every((c) => c === true)).length;
    const m = {
      id: p.id,
      workflow: id,
      status: w.status,
      planner: w.plan?.planner ?? "-",
      rows: rows.length,
      quote_verified_pct: pct(verified, withQuote),
      fill_pct: pct(filled, rows.length * fields.length),
      all_conditions_met_pct: checked.length ? pct(allMet, checked.length) : null,
      sources_failed: w.stats?.sources_failed ?? 0,
      secs,
      llm_requests: llmUsage.requests - before.requests,
      llm_failed: llmUsage.failed - before.failed,
      tokens_in: llmUsage.input - before.input,
      tokens_out: llmUsage.output - before.output,
      firecrawl_credits: credits0 != null && credits1 != null ? credits0 - credits1 : null,
      error: w.error ?? undefined,
    };
    summary.push(m);
    console.log(JSON.stringify(m));
    for (const r of rows) {
      const short = fields.slice(0, 4).map((f) => `${f}=${csvCell(r.data[f]).slice(0, 60)}`).join(" | ");
      labels.push([p.id, "", "", short, r.source_url, r.data[QUOTE_OK_KEY] ?? "", r.data[WHY_KEY] ?? ""].map(csvCell).join(","));
    }
  }
  const total = (k: "llm_requests" | "tokens_in" | "tokens_out" | "firecrawl_credits") => summary.reduce((n, m) => n + (Number(m[k]) || 0), 0);
  console.log(
    `\nTotal: ${total("llm_requests")} LLM requests (${llmUsage.failed} failed), ${total("tokens_in")} tokens in, ${total("tokens_out")} out, ${total("firecrawl_credits")} Firecrawl credits`,
  );
  writeFileSync(join(out, "summary.json"), JSON.stringify(summary, null, 2));
  writeFileSync(join(out, "labels.csv"), labels.join("\n"));
  console.log(`\nWrote ${join(out, "summary.json")} and labels.csv: fill the "correct" column with y/n, then run pnpm eval:score ${join(out, "labels.csv")}`);
}

(args[0] === "score" ? score(args[1]) : run()).then(() => process.exit(0));
