import type { WorkflowStatus } from "@/lib/types";

// Linear-style status glyphs: dashed ring (queued), pie that fills with progress
// (running), filled check (done), filled cross (failed).

const RUNNING_FILL: Record<string, number> = { planning: 0.25, collecting: 0.5, processing: 0.75 };

export function StatusIcon({ status, size = 14, mono = false }: { status: WorkflowStatus | string; size?: number; mono?: boolean }) {
  const s = size;
  const done = mono ? "fill-zinc-300" : "fill-success";
  // full class names so Tailwind can see them
  const runStroke = mono ? "stroke-zinc-400" : "stroke-status-running";
  const runFill = mono ? "fill-zinc-400" : "fill-status-running";
  if (status === "completed" || status === "ok")
    return (
      <svg width={s} height={s} viewBox="0 0 14 14" aria-hidden>
        <circle cx="7" cy="7" r="6" className={done} />
        <path d="M4.3 7.2l1.8 1.8 3.6-3.8" className="stroke-zinc-950" strokeWidth="1.6" fill="none" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  if (status === "empty")
    return (
      <svg width={s} height={s} viewBox="0 0 14 14" aria-hidden>
        <circle cx="7" cy="7" r="5.8" fill="none" className="stroke-zinc-400" strokeWidth="1.4" />
        <path d="M4.5 7h5" className="stroke-zinc-400" strokeWidth="1.6" strokeLinecap="round" />
      </svg>
    );
  if (status === "cancelled")
    return (
      <svg width={s} height={s} viewBox="0 0 14 14" aria-hidden>
        <circle cx="7" cy="7" r="5.8" fill="none" className="stroke-zinc-500" strokeWidth="1.4" />
        <rect x="4.6" y="4.6" width="4.8" height="4.8" rx="1" className="fill-zinc-500" />
      </svg>
    );
  if (status === "failed")
    return (
      <svg width={s} height={s} viewBox="0 0 14 14" aria-hidden>
        <circle cx="7" cy="7" r="6" className="fill-danger" />
        <path d="M5 5l4 4M9 5l-4 4" className="stroke-zinc-950" strokeWidth="1.6" strokeLinecap="round" />
      </svg>
    );
  const f = RUNNING_FILL[status];
  if (f != null) {
    const a = f * 2 * Math.PI;
    const x = 7 + 3.5 * Math.sin(a);
    const y = 7 - 3.5 * Math.cos(a);
    return (
      <svg width={s} height={s} viewBox="0 0 14 14" aria-hidden>
        <circle cx="7" cy="7" r="5.8" fill="none" className={runStroke} strokeWidth="1.4" />
        <path d={`M7 7V3.5A3.5 3.5 0 ${f > 0.5 ? 1 : 0} 1 ${x.toFixed(2)} ${y.toFixed(2)}Z`} className={runFill} />
      </svg>
    );
  }
  return (
    <svg width={s} height={s} viewBox="0 0 14 14" aria-hidden>
      <circle cx="7" cy="7" r="5.8" fill="none" className="stroke-zinc-500" strokeWidth="1.4" strokeDasharray="2.2 2" />
    </svg>
  );
}

const LABELS: Record<string, string> = {
  queued: "Queued",
  planning: "Planning",
  review: "Awaiting review",
  collecting: "Collecting",
  processing: "Processing",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Stopped",
  ok: "OK",
  empty: "No results",
  skipped: "Skipped",
};

export function StatusBadge({ status, mono }: { status: WorkflowStatus | "ok" | "skipped" | string; mono?: boolean }) {
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-[12px] text-zinc-300">
      <StatusIcon status={status} size={13} mono={mono} />
      {LABELS[status] ?? status}
    </span>
  );
}
