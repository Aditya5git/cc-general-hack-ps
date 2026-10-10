"use client";

import { use, useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  AlertTriangle,
  Square,
  Eye,
  RefreshCw,
  BarChart3,
  ChevronDown,
  Copy,
  FileJson,
  FileSpreadsheet,
  Loader2,
  Plug,
  RotateCw,
  ScrollText,
  Table2,
  Trash2,
  XOctagon,
  Workflow as WorkflowIcon,
} from "lucide-react";
import type { DataRecord, SourceRun, Workflow, WorkflowEvent } from "@/lib/types";
import { StatusBadge, StatusIcon } from "@/components/StatusBadge";
import { ProgressBar } from "@/components/ProgressBar";
import { fetchJSON, formatDateTime, isRunning, timeAgo } from "@/components/utils";
import { Pipeline } from "@/components/workflow/Pipeline";
import { DataTable } from "@/components/workflow/DataTable";
import { SourcesTable } from "@/components/workflow/SourcesTable";
import { ActivityLog } from "@/components/workflow/ActivityLog";
import { Insights } from "@/components/workflow/Insights";
import { AskData } from "@/components/workflow/AskData";
import { MissionControl } from "@/components/workflow/MissionControl";
import { PlanEditor } from "@/components/workflow/PlanEditor";

interface Detail {
  workflow: Workflow;
  events: WorkflowEvent[];
  sources: SourceRun[];
  record_count: number;
  can_edit: boolean;
}

type Tab = "data" | "insights" | "sources" | "log";

export default function WorkflowPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const [detail, setDetail] = useState<Detail | null>(null);
  const [records, setRecords] = useState<DataRecord[]>([]);
  const [recordsLoaded, setRecordsLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("data");
  const [busy, setBusy] = useState<"rerun" | "refresh" | "delete" | "stop" | null>(null);
  const [pollKey, setPollKey] = useState(0); // bump to resume polling after review/refresh
  const [cited, setCited] = useState<number[] | null>(null);
  const [actionError, setActionError] = useState<string | null>(null); // shown inline instead of a browser alert
  const [confirmDelete, setConfirmDelete] = useState(false); // inline "Delete / Cancel" bar instead of a browser confirm
  const [now, setNow] = useState(() => Date.now()); // ticks while running so the "stuck" check re-evaluates
  const [showBuild, setShowBuild] = useState(true); // "How this dataset was built": opens while a run is in progress, collapses when it finishes
  const lastRecordFetch = useRef(0);

  const loadRecords = useCallback(async () => {
    lastRecordFetch.current = Date.now();
    try {
      const j = await fetchJSON<{ records: DataRecord[] }>(`/api/workflows/${id}/records`);
      setRecords(j.records ?? []);
    } catch {
      /* ignore transient */
    } finally {
      setRecordsLoaded(true);
    }
  }, [id]);

  const load = useCallback(async () => {
    try {
      const j = await fetchJSON<Detail>(`/api/workflows/${id}`);
      setDetail(j);
      setError(null);
      return j;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load workflow");
      return null;
    }
  }, [id]);

  const status = detail?.workflow.status;
  const running = status ? isRunning(status) : true;

  // Mission control follows the run: open when it starts, closed when it ends (the reader can still toggle it).
  const [prevRunning, setPrevRunning] = useState(running);
  if (prevRunning !== running) {
    setPrevRunning(running);
    setShowBuild(running);
  }

  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setNow(Date.now()), 10_000);
    return () => clearInterval(t);
  }, [running]);

  // Poll workflow detail while running
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      const j = await load();
      if (!alive) return;
      const st = j?.workflow.status;
      if (st && !isRunning(st)) {
        loadRecords();
        return;
      }
      if (st === "processing" && Date.now() - lastRecordFetch.current > 2000) loadRecords();
      timer = setTimeout(tick, 1500);
    };
    tick();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [load, loadRecords, pollKey]);

  async function rerun() {
    setBusy("rerun");
    try {
      const j = await fetchJSON<{ id: string }>(`/api/workflows/${id}/rerun`, { method: "POST" });
      router.push(`/workflows/${j.id}`);
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "Rerun failed");
      setBusy(null);
    }
  }

  async function refresh() {
    setBusy("refresh");
    try {
      await fetchJSON(`/api/workflows/${id}/refresh`, { method: "POST" });
      setCited(null);
      setPollKey((k) => k + 1);
      // stay disabled a few seconds so a second click can't land before polling shows the run started
      await new Promise((r) => setTimeout(r, 3000));
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "Refresh failed");
    } finally {
      setBusy(null);
    }
  }

  async function stop() {
    setBusy("stop");
    try {
      await fetchJSON(`/api/workflows/${id}/cancel`, { method: "POST" });
      await load();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "Couldn't stop the workflow");
    } finally {
      setBusy(null);
    }
  }

  async function setWatch(hours: number) {
    try {
      await fetchJSON(`/api/workflows/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ watch_hours: hours }),
      });
      await load();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "Couldn't update watch");
    }
  }

  async function remove() {
    setConfirmDelete(false);
    setBusy("delete");
    try {
      await fetchJSON(`/api/workflows/${id}`, { method: "DELETE" });
      router.push("/workflows");
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "Delete failed");
      setBusy(null);
    }
  }

  if (!detail) {
    return (
      <div className="mx-auto max-w-7xl px-4 py-10 sm:px-6">
        {error ? (
          <div className="mx-auto mt-16 max-w-md rounded-xl border border-danger/20 bg-danger/5 p-6 text-center">
            <XOctagon className="mx-auto h-7 w-7 text-danger" />
            <p className="mt-3 text-sm text-zinc-200">Couldn&apos;t load this workflow</p>
            <p className="mt-1 text-xs text-zinc-500">{error}</p>
            <Link href="/workflows" className="mt-4 inline-block text-xs text-accent-soft hover:underline">
              ← Back to workflows
            </Link>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="h-8 w-1/2 animate-pulse rounded bg-white/[0.04]" />
            <div className="h-4 w-1/3 animate-pulse rounded bg-white/[0.04]" />
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              {[0, 1, 2, 3].map((i) => (
                <div key={i} className="h-24 animate-pulse rounded-xl bg-white/[0.03]" />
              ))}
            </div>
            <div className="h-80 animate-pulse rounded-xl bg-white/[0.03]" />
          </div>
        )}
      </div>
    );
  }

  const w = detail.workflow;
  const canEdit = detail.can_edit !== false; // shared examples are read-only; Rerun makes your own copy
  const s = w.stats ?? {};
  const recordCount = detail.record_count ?? w.record_count ?? records.length;
  const sourcesOk = s.sources_ok ?? detail.sources.filter((x) => x.status === "ok").length;
  const sourcesFailed = s.sources_failed ?? detail.sources.filter((x) => x.status === "failed").length;
  // Last sign of life: the row's updated_at (stage changes, batches) or the newest log event (each source start/finish).
  // Collecting can run a long time between stage changes, so updated_at alone would cry "stuck" too early.
  const lastActivity = Math.max(new Date(w.updated_at).getTime() || 0, new Date(detail.events.at(-1)?.created_at ?? 0).getTime() || 0);
  // 3 minutes: one AI call may take up to 2 (provider failover), and planning logs nothing while it thinks
  const stuck = running && now - lastActivity > 180_000;
  const sourcesTotal = sourcesOk + sourcesFailed;

  return (
    <div>
      <header className="flex h-11 items-center gap-2 border-b border-line px-5 text-[13px]">
        {/* on phones the breadcrumb gives way to the actions (MobileNav already links to Workflows) */}
        <Link href="/workflows" className="hidden text-zinc-500 hover:text-zinc-200 sm:inline">Workflows</Link>
        <span className="hidden text-zinc-700 sm:inline" aria-hidden>›</span>
        <span className="hidden min-w-0 truncate text-zinc-200 sm:inline">{w.title || w.plan?.title || w.prompt}</span>
        <div className="ml-auto flex shrink-0 items-center gap-1 sm:gap-1.5">
          {w.plan && canEdit && (
            <label
              className={`inline-flex h-7 items-center gap-1.5 rounded-md border px-2 text-[12.5px] transition ${
                w.plan.watch ? "border-accent/40 bg-accent/10 text-accent-ink" : "border-line-strong bg-raised text-zinc-200"
              }`}
              title="Automatically refresh this dataset and badge new rows"
            >
              <Eye className="hidden h-3.5 w-3.5 sm:block" aria-hidden />
              <select
                value={w.plan.watch?.every_hours ?? 0}
                onChange={(e) => setWatch(Number(e.target.value))}
                className="cursor-pointer bg-transparent"
                aria-label="Watch this dataset"
              >
                <option value={0} className="bg-zinc-900">Watch: off</option>
                <option value={24} className="bg-zinc-900">Watch: daily</option>
                <option value={168} className="bg-zinc-900">Watch: weekly</option>
              </select>
            </label>
          )}
          <Btn label="Refresh" onClick={refresh} disabled={!canEdit || busy !== null || running || !w.plan || w.status === "review"}>
            {busy === "refresh" ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <RefreshCw className="h-3.5 w-3.5" aria-hidden />}
          </Btn>
          <Btn label="Rerun" onClick={rerun} disabled={busy !== null || running}>
            {busy === "rerun" ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <RotateCw className="h-3.5 w-3.5" aria-hidden />}
          </Btn>
          <ExportLink label="CSV" title="Export as CSV" href={`/api/workflows/${id}/export?format=csv`} disabled={!recordCount}>
            <FileSpreadsheet className="h-3.5 w-3.5" aria-hidden />
          </ExportLink>
          <ExportLink label="JSON" title="Export as JSON" href={`/api/workflows/${id}/export?format=json`} disabled={!recordCount}>
            <FileJson className="h-3.5 w-3.5" aria-hidden />
          </ExportLink>
          <Btn label="Delete workflow" iconOnly onClick={() => setConfirmDelete(true)} disabled={!canEdit || busy !== null || confirmDelete} danger>
            {busy === "delete" ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <Trash2 className="h-3.5 w-3.5" aria-hidden />}
          </Btn>
        </div>
      </header>

      <div className="mx-auto max-w-[1400px] px-5 py-6">
      {confirmDelete && (
        <div role="alertdialog" aria-label="Confirm delete" className="mb-4 flex flex-wrap items-center gap-3 rounded-lg border border-danger/30 bg-danger/5 px-4 py-3 text-[13px]">
          <span className="text-zinc-200">Delete this workflow and all of its records?</span>
          <span className="ml-auto flex gap-2">
            <button type="button" onClick={remove} className="h-7 rounded-md bg-danger/20 px-2.5 text-[12.5px] font-medium text-danger-soft hover:bg-danger/30">
              Delete
            </button>
            <button type="button" onClick={() => setConfirmDelete(false)} className="h-7 rounded-md border border-line-strong px-2.5 text-[12.5px] text-zinc-300 hover:bg-white/[0.06]">
              Cancel
            </button>
          </span>
        </div>
      )}
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-[22px] font-semibold text-zinc-100">{w.title || w.plan?.title || w.prompt}</h1>
          <StatusBadge status={w.status} />
          {actionError && (
            <button type="button" onClick={() => setActionError(null)} className="text-left text-[12.5px] text-danger-soft" title="Dismiss">
              {actionError} ✕
            </button>
          )}
          {error && <span className="text-[12px] text-zinc-500">reconnecting…</span>}
          {!canEdit && (
            <span
              className="rounded-full border border-line-strong px-2 py-0.5 text-[11.5px] text-zinc-400"
              title="Shared example from before sign-in existed. Use Rerun to make your own editable copy."
            >
              Example · read-only
            </span>
          )}
        </div>
        <div className="mt-2 flex items-start gap-2 text-[13px] text-zinc-400">
          <span className="text-zinc-600">Prompt</span>
          <span className="min-w-0">{w.prompt}</span>
          <button title="Copy prompt" onClick={() => navigator.clipboard?.writeText(w.prompt)} className="text-zinc-600 hover:text-zinc-300">
            <Copy className="h-3.5 w-3.5" />
          </button>
        </div>
        <p className="mt-1 text-[12px] text-zinc-600" title={formatDateTime(w.created_at)}>
          Created {timeAgo(w.created_at)}
          {w.finished_at && <> · finished {timeAgo(w.finished_at)}</>} · <span className="font-mono">{w.id}</span>
        </p>
      </div>

      {running && (
        <div className="mt-5 rounded-lg border border-line bg-canvas px-4 py-3">
          <div className="mb-2 flex items-center justify-between text-[12.5px]">
            <span className="inline-flex items-center gap-2 text-zinc-300">
              <StatusIcon status={w.status} size={13} />
              {detail.events.at(-1)?.message ?? "Starting workflow…"}
            </span>
            <span className="ml-auto flex items-center gap-3">
              <span className="font-mono text-[11.5px] tabular-nums text-zinc-500">{Math.round(w.progress)}%</span>
              <button
                type="button"
                onClick={stop}
                disabled={!canEdit || busy !== null}
                className="inline-flex h-7 items-center gap-1.5 rounded-md border border-line-strong bg-raised px-2.5 text-[12.5px] text-zinc-200 transition hover:border-danger/40 hover:text-danger-soft disabled:opacity-40"
              >
                {busy === "stop" ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden /> : <Square className="h-3 w-3" aria-hidden />} Stop
              </button>
            </span>
          </div>
          <ProgressBar value={w.progress} />
        </div>
      )}

      {stuck && (
        <div className="mt-3 flex items-start gap-3 rounded-lg border border-line bg-canvas px-4 py-3">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" aria-hidden />
          <div className="min-w-0 flex-1">
            <p className="text-[13px] font-medium text-zinc-200">This run seems stuck</p>
            <p className="mt-0.5 text-[12.5px] text-zinc-500">No progress for about three minutes. You can start it again as a new run.</p>
          </div>
          <button
            type="button"
            onClick={rerun}
            disabled={busy !== null}
            className="h-7 shrink-0 rounded-md bg-zinc-50 px-2.5 text-[12.5px] font-medium text-zinc-950 hover:bg-zinc-200 disabled:opacity-40"
          >
            Retry
          </button>
        </div>
      )}

      {(w.status === "failed" || w.status === "cancelled") && (
        <div className="mt-5 flex items-start gap-3 rounded-lg border border-line bg-canvas px-4 py-3">
          {w.status === "cancelled" ? (
            <Square className="mt-0.5 h-4 w-4 shrink-0 text-zinc-500" aria-hidden />
          ) : (
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-danger" aria-hidden />
          )}
          <div className="min-w-0 flex-1">
            <p className="text-[13px] font-medium text-zinc-200">{w.status === "cancelled" ? "You stopped this workflow" : "Workflow failed"}</p>
            <p className="mt-0.5 break-words text-[12.5px] text-zinc-500">
              {w.status === "cancelled"
                ? recordCount
                  ? `The ${recordCount} rows collected before stopping are kept below.`
                  : "Nothing was collected before it stopped."
                : w.error || "An unknown error occurred."}
            </p>
          </div>
          <button
            type="button"
            onClick={w.plan && canEdit ? refresh : rerun}
            disabled={busy !== null || running}
            className="h-7 shrink-0 rounded-md bg-zinc-50 px-2.5 text-[12.5px] font-medium text-zinc-950 hover:bg-zinc-200 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {w.status === "cancelled" ? "Run again" : "Try again"}
          </button>
        </div>
      )}

      {w.status === "review" && w.plan && canEdit && <PlanEditor workflowId={id} plan={w.plan} onStarted={() => setPollKey((k) => k + 1)} />}


      {w.status === "completed" && (s.runs ?? 1) > 1 && (
        <div className="glass animate-fade-up mt-5 flex flex-wrap items-center gap-x-4 gap-y-1 rounded-lg px-4 py-3 text-[13px]">
          <span className="inline-flex items-center gap-2 font-medium text-zinc-100">
            <RefreshCw className="h-3.5 w-3.5 text-accent-soft" /> What changed
          </span>
          <span className="text-accent-ink">+{s.added ?? 0} new</span>
          <span className="text-zinc-400">{s.removed ?? 0} no longer listed</span>
          <span className="text-zinc-400">{Math.max(0, (s.stored ?? 0) - (s.added ?? 0))} still there</span>
          <span className="ml-auto text-[12px] text-zinc-500">
            Refresh #{(s.runs ?? 1) - 1} · {timeAgo(w.finished_at)}
            {w.plan?.watch && <> · auto-refreshing every {w.plan.watch.every_hours >= 168 ? "week" : "day"}</>}
          </span>
        </div>
      )}

      {/* Stats */}
{w.status !== "review" && (
      <div className="glass mt-5 grid grid-cols-2 overflow-hidden rounded-lg md:grid-cols-4">
        <Stat label="Records" value={recordCount} sub={s.raw !== undefined ? `from ${s.raw} raw items` : undefined} />
        <Stat
          label="Sources"
          value={running && !sourcesTotal ? "—" : <>{sourcesOk}<span className="text-zinc-600"> / {sourcesTotal}</span></>}
          sub={running && !sourcesTotal ? undefined : sourcesFailed ? `${sourcesFailed} failed` : "all responded"}
        />
        <Stat label="Duplicates merged" value={running && s.duplicates === undefined ? "—" : (s.duplicates ?? 0)} />
        <Stat label="Invalid dropped" value={running && s.invalid === undefined ? "—" : (s.invalid ?? 0)} />
      </div>
      )}

      {/* Data first: tabs span the full width */}
      <div className="mt-6">
        <section className="min-w-0" aria-label="Dataset">
          <div className="mb-4 flex gap-1 border-b border-line">
            <TabBtn active={tab === "data"} onClick={() => setTab("data")} icon={Table2} label="Data" count={recordCount} />
            <TabBtn active={tab === "insights"} onClick={() => setTab("insights")} icon={BarChart3} label="Insights" count={recordCount} />
            <TabBtn active={tab === "sources"} onClick={() => setTab("sources")} icon={Plug} label="Sources" count={detail.sources.length} />
            <TabBtn active={tab === "log"} onClick={() => setTab("log")} icon={ScrollText} label="Activity log" count={detail.events.length} />
          </div>
          {tab === "data" && (s.extraction === "heuristic" || s.extraction === "mixed") && (
            <div role="status" className="mb-3 flex items-start gap-2 rounded-lg border border-amber-400/30 bg-amber-400/10 px-3.5 py-2.5 text-[12.5px] text-amber-200">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
              AI extraction was unavailable for some pages; those rows were matched by keywords.
            </div>
          )}
          {tab === "data" && !!w.plan && w.status !== "review" && (records.length > 0 || !running) && (
            <AskData workflowId={id} fields={w.plan.fields} entity={w.plan.entity} disabled={running || !records.length} onCite={setCited} />
          )}
          {tab === "data" && (
            <DataTable
              records={records}
              fields={w.plan?.fields}
              criteria={w.plan?.filters}
              cited={cited}
              newSince={(s.runs ?? 1) > 1 ? s.run_started_at : null}
              onAddColumn={
                !canEdit || running || !records.length
                  ? undefined
                  : async (question) => {
                      await fetchJSON(`/api/workflows/${id}/columns`, {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ question }),
                      });
                      await Promise.all([load(), loadRecords()]);
                    }
              }
              onClearCited={() => setCited(null)}
              loading={running || !recordsLoaded}
              emptyHint={
                w.status === "failed"
                  ? "The workflow failed before producing records. Check the activity log for details."
                  : w.status === "review"
                    ? "Approve the plan above and rows will stream in here."
                    : w.status === "completed"
                      ? emptyReason(s)
                      : undefined
              }
            />
          )}
          {tab === "insights" && <Insights records={records} fields={w.plan?.fields} criteria={w.plan?.filters} />}
          {tab === "sources" && <SourcesTable sources={detail.sources} running={running} />}
          {tab === "log" && <ActivityLog events={detail.events} running={running} />}
        </section>

        {/* How it was built: agents + plan steps, on demand */}
        {w.status !== "review" && (
          <section className="mt-8" aria-labelledby="build-toggle">
            <button
              id="build-toggle"
              type="button"
              aria-expanded={showBuild}
              aria-controls="build-panel"
              onClick={() => setShowBuild((v) => !v)}
              className="glass flex w-full items-center gap-3 rounded-lg px-4 py-3 text-left transition hover:bg-zinc-50/[0.05]"
            >
              <WorkflowIcon className="h-4 w-4 shrink-0 text-zinc-400" aria-hidden />
              <span className="min-w-0">
                <span className="block text-[13.5px] font-medium text-zinc-100">How this dataset was built</span>
                <span className="block truncate text-[12px] text-zinc-500">
                  {running ? "Agents are working. Open to watch them live." : "Mission control, the plan, and every source the agents used"}
                </span>
              </span>
              <ChevronDown className={`ml-auto h-4 w-4 shrink-0 text-zinc-400 transition-transform ${showBuild ? "rotate-180" : ""}`} aria-hidden />
            </button>
            {showBuild && (
              <div id="build-panel" className="animate-fade-up">
                <MissionControl workflow={w} sources={detail.sources} />
                <div className="glass mt-4 rounded-lg p-4">
                  <Pipeline workflow={w} sources={detail.sources} />
                </div>
              </div>
            )}
          </section>
        )}
      </div>
      </div>
    </div>
  );
}

function Stat({ label, value, sub }: { label: string; value: React.ReactNode; sub?: string }) {
  return (
    <div className="border-line px-4 py-3 [&:not(:last-child)]:border-r max-md:[&:nth-child(2)]:border-r-0 max-md:[&:nth-child(-n+2)]:border-b">
      <div className="text-[12px] text-zinc-500">{label}</div>
      <div className="mt-1 text-[22px] font-semibold tabular-nums text-zinc-100">{value}</div>
      {sub && <div className="text-[11.5px] text-zinc-600">{sub}</div>}
    </div>
  );
}

/** Why a finished run has no rows, from the validator's drop counts. */
function emptyReason(s: Workflow["stats"]): string | undefined {
  if (!s.raw) return "No source returned anything. Check the Sources tab, then rephrase the request or add a source in the plan.";
  const d = s.dropped;
  if (!d) return undefined;
  const parts = [
    d.no_name && `${d.no_name} had no name`,
    d.irrelevant && `${d.irrelevant} didn't match the request`,
  ].filter(Boolean);
  return `Collected ${s.raw} items, but none passed: ${parts.join(", ") || "nothing usable was found"}. Rerun with a looser filter or a broader request.`;
}

function TabBtn({
  active,
  onClick,
  icon: Icon,
  label,
  count,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  count: number;
}) {
  return (
    <button
      onClick={onClick}
      className={`-mb-px inline-flex items-center gap-1.5 border-b px-3 py-2 text-[13px] transition ${
        active ? "border-zinc-200 text-zinc-100" : "border-transparent text-zinc-500 hover:text-zinc-300"
      }`}
    >
      <Icon className="h-3.5 w-3.5" />
      {label}
      <span className={`rounded-full px-1.5 text-[10px] tabular-nums ${active ? "bg-white/[0.08] text-zinc-300" : "bg-white/[0.04] text-zinc-500"}`}>
        {count}
      </span>
    </button>
  );
}

/** Header action: icon plus a text label that collapses to icon-only on phones so the header fits. */
function Btn({
  children,
  label,
  iconOnly,
  onClick,
  disabled,
  danger,
}: {
  children: React.ReactNode;
  label: string;
  iconOnly?: boolean;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      className={`inline-flex h-7 items-center gap-1.5 rounded-md border border-line-strong bg-raised px-2 text-[12.5px] transition disabled:opacity-40 sm:px-2.5 ${
        danger ? "text-zinc-500 hover:text-zinc-200" : "text-zinc-200 hover:bg-white/[0.06]"
      }`}
    >
      {children}
      {!iconOnly && <span className="hidden sm:inline">{label}</span>}
    </button>
  );
}

function ExportLink({
  href,
  children,
  label,
  title,
  disabled,
}: {
  href: string;
  children: React.ReactNode;
  label: string;
  title: string;
  disabled?: boolean;
}) {
  const text = <span className="sr-only sm:not-sr-only">{label}</span>;
  if (disabled) {
    return (
      <span
        title="Nothing to export yet"
        className="inline-flex h-7 cursor-not-allowed items-center gap-1.5 rounded-md border border-line px-2 text-[12.5px] text-zinc-600 sm:px-2.5"
      >
        {children}
        {text}
      </span>
    );
  }
  return (
    <a
      href={href}
      download
      title={title}
      aria-label={title}
      className="inline-flex h-7 items-center gap-1.5 rounded-md border border-line-strong bg-raised px-2 text-[12.5px] text-zinc-200 transition hover:bg-white/[0.06] sm:px-2.5"
    >
      {children}
      {text}
    </a>
  );
}
