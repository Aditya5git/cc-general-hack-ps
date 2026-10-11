import { Brain, Database, Download, Filter, ListChecks, ScanText, ShieldCheck } from "lucide-react";
import type { Workflow, SourceRun } from "@/lib/types";
import { connectorLabel, humanize } from "@/components/utils";
import { StatusBadge, StatusIcon } from "@/components/StatusBadge";

type StepState = "done" | "active" | "pending" | "failed";
const ORDER = ["understand", "plan", "collect", "extract", "validate", "store"] as const;
type StepId = (typeof ORDER)[number];

function stepStates(w: Workflow): Record<StepId, StepState> {
  let activeIdx: number;
  switch (w.status) {
    case "queued":
      activeIdx = 0;
      break;
    case "planning":
      activeIdx = w.plan ? 1 : 0;
      if (activeIdx === 0 && w.progress > 5) activeIdx = 1;
      break;
    case "review":
    case "collecting":
      activeIdx = 2;
      break;
    case "processing":
      activeIdx = w.stats?.valid !== undefined || w.progress >= 85 ? 4 : 3;
      break;
    case "completed":
      activeIdx = ORDER.length;
      break;
    case "cancelled":
    case "failed":
      activeIdx = !w.plan ? 1 : w.stats?.raw === undefined ? 2 : w.stats?.valid === undefined ? 3 : 5;
      break;
  }
  const out = {} as Record<StepId, StepState>;
  ORDER.forEach((id, i) => {
    out[id] =
      i < activeIdx ? "done" : i === activeIdx && w.status !== "review" ? (w.status === "failed" || w.status === "cancelled" ? "failed" : "active") : "pending";
  });
  return out;
}

function Dot({ state }: { state: StepState }) {
  const status = state === "done" ? "completed" : state === "active" ? "processing" : state === "failed" ? "failed" : "queued";
  return (
    <div className="grid h-7 w-7 place-items-center rounded-full border border-line bg-panel">
      <StatusIcon status={status} size={14} mono />
    </div>
  );
}

export function Pipeline({ workflow: w, sources }: { workflow: Workflow; sources: SourceRun[] }) {
  const st = stepStates(w);
  const plan = w.plan;
  const s = w.stats ?? {};

  const steps: { id: StepId; title: string; icon: React.ComponentType<{ className?: string }>; body: React.ReactNode }[] = [
    {
      id: "understand",
      title: "Understand request",
      icon: Brain,
      body: plan ? (
        <div className="space-y-1">
          <p className="text-zinc-300">{plan.intent}</p>
          <p className="text-zinc-500">
            One row per <span className="text-zinc-300">{plan.entity}</span>
          </p>
        </div>
      ) : (
        <p className="text-zinc-500">Parsing intent and constraints…</p>
      ),
    },
    {
      id: "plan",
      title: "Plan details & sources",
      icon: ListChecks,
      body: plan ? (
        <div className="space-y-2.5">
          <div className="flex flex-wrap gap-1.5">
            {plan.fields.map((f) => (
              <span
                key={f.name}
                title={f.description || undefined}
                className="inline-flex items-center rounded-full border border-line-strong bg-zinc-50/[0.03] px-2 py-0.5 text-[11.5px] text-zinc-300"
              >
                {humanize(f.name)}
              </span>
            ))}
          </div>
          {plan.filters?.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5">
              <Filter className="h-3 w-3 text-zinc-500" />
              {plan.filters.map((f) => (
                <span key={f} className="rounded-md border border-line px-1.5 py-0.5 text-[11px] text-zinc-300">
                  {f.charAt(0).toUpperCase() + f.slice(1)}
                </span>
              ))}
            </div>
          )}
          <p className="text-[11.5px] text-zinc-500">
            Up to {plan.max_results} rows
            {plan.dedupe_on?.length > 0 && <> · duplicates matched on {plan.dedupe_on.map(humanize).join(" + ")}</>}
            {plan.planner !== "llm" && <> · planned without AI</>}
          </p>
        </div>
      ) : (
        <p className="text-zinc-500">Designing fields and choosing connectors…</p>
      ),
    },
    {
      id: "collect",
      title: "Collect from sources",
      icon: Download,
      body: plan ? (
        <div className="space-y-1.5">
          {plan.sources.map((src, i) => {
            const run = sources.find((r) => r.connector === src.connector && (r.query ?? "") === (src.query ?? "")) ?? sources[i];
            const matched = run && run.connector === src.connector ? run : undefined;
            return (
              <div key={i} className="flex items-start gap-2 rounded-lg border border-white/5 bg-black/20 px-2.5 py-2">
                <span className="mt-0.5 shrink-0 rounded border border-line px-1.5 py-0.5 text-[10.5px] text-zinc-300">
                  {connectorLabel(src.connector)}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[11.5px] text-zinc-300" title={src.query}>
                    <span className="text-zinc-500">Searching for </span>“{src.query}”
                  </div>
                  {src.reason && <div className="text-[11px] text-zinc-500">{src.reason}</div>}
                </div>
                {matched && (
                  <div className="flex shrink-0 items-center gap-1.5">
                    <span className="text-[11px] tabular-nums text-zinc-500">{matched.items} items</span>
                    <StatusBadge mono status={matched.status} />
                  </div>
                )}
              </div>
            );
          })}
          {s.raw !== undefined && <p className="pt-1 text-[11px] text-zinc-500">{s.raw} raw items collected</p>}
        </div>
      ) : (
        <p className="text-zinc-500">Waiting for plan…</p>
      ),
    },
    {
      id: "extract",
      title: "Extract structured fields",
      icon: ScanText,
      body: (
        <p className="text-zinc-500">
          {s.extracted !== undefined ? (
            <>
              <span className="text-zinc-300">{s.extracted}</span> records extracted into schema
            </>
          ) : w.status === "processing" && w.record_count ? (
            <span className="inline-flex items-center gap-1.5 text-running-soft">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-running" />
              {w.record_count} validated rows streaming into the table
            </span>
          ) : (
            "Map raw items onto the planned schema."
          )}
        </p>
      ),
    },
    {
      id: "validate",
      title: "Validate & dedupe",
      icon: ShieldCheck,
      body: (
        <p className="text-zinc-500">
          {s.valid !== undefined ? (
            <>
              <span className="text-zinc-200">{s.valid}</span> valid ·{" "}
              <span className="text-zinc-200">{s.duplicates ?? 0}</span> duplicates removed ·{" "}
              <span className="text-zinc-200">{s.invalid ?? 0}</span> invalid dropped
            </>
          ) : (
            "Apply filters, check required fields, remove duplicates, compute match score."
          )}
        </p>
      ),
    },
    {
      id: "store",
      title: "Store dataset",
      icon: Database,
      body: (
        <p className="text-zinc-500">
          {w.status === "completed" ? (
            <>
              <span className="text-zinc-300">{s.stored ?? w.record_count ?? 0}</span> records stored with source traceability
            </>
          ) : (
            "Persist clean records with source links."
          )}
        </p>
      ),
    },
  ];

  return (
    <ol className="relative">
      {steps.map((step, i) => {
        const state = st[step.id];
        const Icon = step.icon;
        return (
          <li key={step.id} className="relative flex gap-3 pb-5 last:pb-0">
            {i < steps.length - 1 && (
              <span
                className={`absolute left-[13px] top-8 bottom-0 w-px ${
                  state === "done" ? "bg-zinc-700" : "bg-zinc-800"
                }`}
              />
            )}
            <Dot state={state} />
            <div className="min-w-0 flex-1 pt-0.5 text-xs">
              <div className="mb-1.5 flex items-center gap-1.5">
                <Icon className={`h-3.5 w-3.5 ${state === "pending" ? "text-zinc-600" : "text-zinc-400"}`} />
                <span className={`text-sm font-medium ${state === "pending" ? "text-zinc-500" : "text-zinc-100"}`}>
                  {step.title}
                </span>
                {state === "active" && <span className="text-[10px] uppercase tracking-wider text-zinc-400">running</span>}
              </div>
              <div className={state === "pending" ? "opacity-60" : ""}>{step.body}</div>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
