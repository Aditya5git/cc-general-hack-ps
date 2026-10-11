"use client";

import type { SourceRun, Workflow } from "@/lib/types";
import { connectorLabel } from "@/components/utils";

// Live agent graph: Planner → one node per source → Extractor → Validator → Dataset.
// Pure function of the polled workflow + source runs; no extra requests.

type State = "pending" | "active" | "done" | "failed";
interface Node {
  id: string;
  x: number;
  y: number;
  w: number;
  title: string;
  sub: string;
  state: State;
}

const H = 54;
const ROW = 66;
const STROKE: Record<State, string> = { pending: "stroke-line-strong", active: "stroke-running", done: "stroke-zinc-600", failed: "stroke-zinc-400" };

function sourceStates(w: Workflow, runs: SourceRun[]) {
  const used = new Set<number>();
  return (w.plan?.sources ?? []).map((s) => {
    const run = runs.find((r) => !used.has(r.id) && r.connector === s.connector && r.query === s.query);
    if (run) used.add(run.id);
    if (run?.status === "ok")
      return { state: "done" as State, sub: `${run.items} items · ${((run.duration_ms ?? 0) / 1000).toFixed(1)}s` };
    if (run?.status === "failed") return { state: "failed" as State, sub: "failed" };
    if (w.status === "collecting") return { state: "active" as State, sub: "fetching…" };
    return { state: "pending" as State, sub: w.status === "review" ? "planned" : "waiting" };
  });
}

export function MissionControl({ workflow: w, sources: runs }: { workflow: Workflow; sources: SourceRun[] }) {
  if (!w.plan) return null;
  const s = w.stats ?? {};
  const st = w.status;
  const failedAt = st === "failed" || st === "cancelled" ? (s.raw === undefined ? "collect" : s.valid === undefined ? "extract" : "store") : null;
  const src = sourceStates(w, runs);
  const n = Math.max(src.length, 1);
  const height = n * ROW + 12;
  const mid = height / 2 - H / 2;
  const extractPct = Math.max(0, Math.min(100, Math.round(((w.progress - 45) / 40) * 100)));

  const planner: Node = {
    id: "plan",
    x: 4,
    y: mid,
    w: 150,
    title: "Planning step",
    sub: `${w.plan.fields.length} columns · ${w.plan.sources.length} sources`,
    state: st === "queued" && !s.runs ? "active" : "done",
  };
  const srcNodes: Node[] = (w.plan.sources.length ? w.plan.sources : [null]).map((step, i) => ({
    id: `src${i}`,
    x: 214,
    y: 6 + i * ROW + (n === 1 ? mid - 6 : 0),
    w: 196,
    title: step ? connectorLabel(step.connector) : "No sources",
    sub: src[i]?.sub ?? "",
    state: src[i]?.state ?? "pending",
  }));
  const extractor: Node = {
    id: "extract",
    x: 470,
    y: mid,
    w: 156,
    title: "Extraction step",
    sub: st === "processing" ? `reading pages… ${extractPct}%` : s.extracted !== undefined ? `${s.extracted} rows extracted` : "waiting",
    state: st === "processing" ? "active" : failedAt === "extract" ? "failed" : s.extracted !== undefined ? "done" : "pending",
  };
  const validator: Node = {
    id: "validate",
    x: 664,
    y: mid,
    w: 150,
    title: "Validator",
    sub: s.valid !== undefined ? `${s.duplicates ?? 0} merged · ${s.invalid ?? 0} dropped` : st === "processing" ? "checking rows…" : "waiting",
    state: st === "processing" ? "active" : s.valid !== undefined && st !== "collecting" && st !== "queued" ? "done" : "pending",
  };
  const count = w.record_count ?? 0;
  const dataset: Node = {
    id: "data",
    x: 852,
    y: mid,
    w: 144,
    title: "Dataset",
    sub: count ? `${count} rows${st === "completed" && (s.added ?? 0) > 0 && (s.runs ?? 1) > 1 ? ` · +${s.added} new` : ""}` : "empty",
    state: st === "completed" ? "done" : st === "processing" && count ? "active" : failedAt === "store" ? "failed" : "pending",
  };

  const edge = (a: Node, b: Node, flowing: boolean, done: boolean, key: string) => {
    const x1 = a.x + a.w;
    const y1 = a.y + H / 2;
    const x2 = b.x;
    const y2 = b.y + H / 2;
    const c = (x2 - x1) / 2;
    return (
      <path
        key={key}
        d={`M${x1},${y1} C${x1 + c},${y1} ${x2 - c},${y2} ${x2},${y2}`}
        fill="none"
        strokeWidth={flowing ? 2 : 1.5}
        className={flowing ? "mc-flow stroke-running" : done ? "stroke-zinc-700" : "stroke-line"}
      />
    );
  };

  const nodes = [planner, ...srcNodes, extractor, validator, dataset];
  return (
    <section className="glass mt-5 overflow-hidden rounded-lg">
      <div className="flex items-center gap-2 border-b border-line px-4 py-2.5 text-[12.5px]">
        <span className={`h-1.5 w-1.5 rounded-full ${["completed", "failed", "review", "cancelled"].includes(st) ? "bg-zinc-600" : "mc-dot bg-running"}`} />
        <span className="font-medium text-zinc-200">Mission control</span>
        <span className="text-zinc-500">
          {st === "review" ? "waiting for your approval" : st === "completed" ? "all steps finished" : st === "cancelled" ? "stopped by you" : st === "failed" ? "stopped on an error" : "pipeline working live"}
        </span>
      </div>
      <div className="overflow-x-auto px-3 py-3">
        <svg viewBox={`0 0 1000 ${height}`} className="h-auto min-w-[680px] w-full" role="img" aria-label="Pipeline status">
          {srcNodes.map((sn, i) => edge(planner, sn, sn.state === "active", sn.state !== "pending", `e-p-${i}`))}
          {srcNodes.map((sn, i) => edge(sn, extractor, extractor.state === "active" && sn.state === "done", extractor.state !== "pending" && sn.state === "done", `e-x-${i}`))}
          {edge(extractor, validator, validator.state === "active", validator.state === "done", "e-v")}
          {edge(validator, dataset, dataset.state === "active", dataset.state === "done", "e-d")}
          {nodes.map((nd) => (
            <g key={nd.id} className={nd.state === "active" ? "mc-active" : undefined}>
              {nd.state === "active" && <rect x={nd.x - 3} y={nd.y - 3} width={nd.w + 6} height={H + 6} rx={11} fill="none" strokeOpacity={0.35} className="mc-glow stroke-running" />}
              <rect x={nd.x} y={nd.y} width={nd.w} height={H} rx={9} className={`${nd.state === "active" ? "fill-node-active" : "fill-node"} ${STROKE[nd.state]}`} strokeWidth={nd.state === "active" ? 1.5 : 1} strokeDasharray={nd.state === "failed" ? "4 3" : undefined} />
              <text x={nd.x + 12} y={nd.y + 22} fontSize="13" fontWeight={500} className={nd.state === "pending" ? "fill-zinc-500" : "fill-zinc-200"}>
                {nd.title}
              </text>
              <text x={nd.x + 12} y={nd.y + 40} fontSize="11.5" className={`tabular-nums ${nd.state === "active" ? "fill-running-soft" : "fill-zinc-400"}`}>
                {nd.sub}
              </text>
              {nd.state === "done" && (
                <g transform={`translate(${nd.x + nd.w - 20}, ${nd.y + 10})`}>
                  <circle cx="5" cy="5" r="5.5" className="fill-success" />
                  <path d="M2.6 5.2l1.6 1.6 3.2-3.4" className="stroke-zinc-950" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
                </g>
              )}
            </g>
          ))}
        </svg>
      </div>
    </section>
  );
}
