"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Database, Loader2, PenSquare, RotateCw, Search, Trash2 } from "lucide-react";
import type { Workflow } from "@/lib/types";
import { StatusIcon } from "@/components/StatusBadge";
import { fetchJSON, isRunning, timeAgo, formatDateTime, connectorLabel } from "@/components/utils";

const FILTERS = [
  { id: "all", label: "All" },
  { id: "running", label: "Running" },
  { id: "review", label: "Needs review" },
  { id: "completed", label: "Completed" },
  { id: "failed", label: "Failed" },
] as const;

const GROUPS = [
  { id: "running", label: "Running", status: "processing", match: (w: Workflow) => isRunning(w.status) },
  { id: "review", label: "Needs review", status: "review", match: (w: Workflow) => w.status === "review" },
  { id: "completed", label: "Completed", status: "completed", match: (w: Workflow) => w.status === "completed" },
  { id: "failed", label: "Failed / stopped", status: "failed", match: (w: Workflow) => w.status === "failed" || w.status === "cancelled" },
];

export default function WorkflowsPage() {
  const router = useRouter();
  const [workflows, setWorkflows] = useState<Workflow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<string>("all");
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null); // shown inline instead of a browser alert

  const load = useCallback(async () => {
    try {
      const j = await fetchJSON<{ workflows: Workflow[] }>("/api/workflows");
      setWorkflows(j.workflows ?? []);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
      setWorkflows((w) => w ?? []);
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- async fetch
    load();
  }, [load]);

  const anyRunning = !!workflows?.some((w) => isRunning(w.status));
  useEffect(() => {
    if (!anyRunning) return;
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, [anyRunning, load]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (workflows ?? []).filter(
      (w) =>
        (filter === "all" || GROUPS.find((g) => g.id === filter)?.match(w)) &&
        (!needle || `${w.title ?? ""} ${w.prompt}`.toLowerCase().includes(needle)),
    );
  }, [workflows, q, filter]);

  async function rerun(id: string) {
    setBusy(id);
    try {
      const j = await fetchJSON<{ id: string }>(`/api/workflows/${id}/rerun`, { method: "POST" });
      router.push(`/workflows/${j.id}`);
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "Rerun failed");
      setBusy(null);
    }
  }

  async function remove(w: Workflow) {
    if (!confirm(`Delete workflow "${w.title || w.prompt}"? This removes all its records.`)) return;
    setBusy(w.id);
    try {
      await fetchJSON(`/api/workflows/${w.id}`, { method: "DELETE" });
      setWorkflows((ws) => (ws ?? []).filter((x) => x.id !== w.id));
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "Delete failed");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="flex min-h-full flex-col">
      <header className="flex h-11 items-center gap-3 border-b border-line px-5">
        <span className="text-[13px] text-zinc-200">Workflows</span>
        {actionError && (
          <button type="button" onClick={() => setActionError(null)} className="truncate text-[12.5px] text-danger-soft" title="Dismiss">
            {actionError} ✕
          </button>
        )}
        <div className="flex items-center gap-0.5">
          {FILTERS.map((f) => (
            <button
              key={f.id}
              onClick={() => setFilter(f.id)}
              className={`h-6 rounded-md px-2 text-[12px] ${
                filter === f.id ? "bg-white/[0.08] text-zinc-100" : "text-zinc-500 hover:text-zinc-300"
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>
        <div className="relative ml-auto hidden sm:block">
          <Search className="absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-500" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search workflows"
            className="h-7 w-56 rounded-md border border-line bg-canvas pl-7 pr-2 text-[12.5px] text-zinc-100 placeholder:text-zinc-600 focus:border-zinc-600 focus:outline-none"
          />
        </div>
        <Link
          href="/new"
          className="inline-flex h-7 items-center gap-1.5 rounded-md bg-zinc-100 px-2.5 text-[12.5px] font-medium text-zinc-950 hover:bg-white"
        >
          <PenSquare className="h-3.5 w-3.5" /> New
        </Link>
      </header>

      <div className="border-b border-line px-5 py-2 sm:hidden">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search workflows"
          className="h-8 w-full rounded-md border border-line bg-canvas px-2 text-[13px] text-zinc-100 placeholder:text-zinc-600 focus:outline-none"
        />
      </div>

      {error && <p className="px-5 py-2 text-[13px] text-zinc-300">⚠ {error}</p>}

      {workflows === null ? (
        <div className="space-y-px p-2">
          {[0, 1, 2, 3, 4].map((i) => (
            <div key={i} className="h-10 animate-pulse rounded-md bg-white/[0.02]" />
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <div className="grid flex-1 place-items-center py-24 text-center">
          <div>
            <Database className="mx-auto h-5 w-5 text-zinc-600" />
            <p className="mt-3 text-[13px] text-zinc-300">
              {workflows.length === 0 ? "No workflows yet" : "Nothing matches these filters"}
            </p>
            {workflows.length === 0 && (
              <Link href="/new" className="mt-1 inline-block text-[12.5px] text-zinc-500 hover:text-zinc-200">
                Describe the data you need →
              </Link>
            )}
          </div>
        </div>
      ) : (
        GROUPS.map((g) => {
          const rows = filtered.filter(g.match);
          if (!rows.length) return null;
          return (
            <section key={g.id} className="pb-4">
              <div className="flex h-10 items-center gap-2 border-b border-line bg-white/[0.015] px-6 text-[12.5px]">
                <StatusIcon status={g.status} size={13} />
                <span className="font-medium text-zinc-200">{g.label}</span>
                <span className="text-zinc-600">{rows.length}</span>
              </div>
              {rows.map((w) => (
                <Row key={w.id} w={w} busy={busy === w.id} onRerun={() => rerun(w.id)} onDelete={() => remove(w)} />
              ))}
            </section>
          );
        })
      )}
    </div>
  );
}

function Row({ w, busy, onRerun, onDelete }: { w: Workflow; busy: boolean; onRerun: () => void; onDelete: () => void }) {
  const sources = [...new Set((w.plan?.sources ?? []).map((s) => connectorLabel(s.connector)))];
  const running = isRunning(w.status);
  const meta = [
    w.status === "completed" ? `${w.record_count ?? 0} rows` : running ? `${w.progress}% · ${w.status}` : w.status === "failed" ? "Failed" : w.status === "review" ? "Awaiting your review" : null,
    sources.length ? sources.slice(0, 3).join(", ") + (sources.length > 3 ? ` +${sources.length - 3}` : "") : null,
  ].filter(Boolean);
  return (
    <div className="group relative flex items-center gap-3.5 border-b border-line/70 px-6 py-3 hover:bg-white/[0.02]">
      <Link href={`/workflows/${w.id}`} className="absolute inset-0" aria-label={w.title || w.prompt} />
      <StatusIcon status={w.status} size={14} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-[13.5px] text-zinc-100">{w.title || w.prompt}</div>
        <div className="mt-0.5 truncate text-[12px] text-zinc-500">{meta.join("  ·  ")}</div>
        {running && (
          <div className="mt-2 h-[2px] w-40 overflow-hidden rounded-full bg-white/[0.06]">
            <div className="h-full bg-running transition-[width]" style={{ width: `${w.progress}%` }} />
          </div>
        )}
      </div>
      {/* actions replace the timestamp on hover or keyboard focus; touch screens (no hover) always show them */}
      <span
        className="text-[12px] text-zinc-600 group-focus-within:hidden group-hover:hidden [@media(hover:none)]:hidden"
        title={formatDateTime(w.created_at)}
      >
        {timeAgo(w.created_at)}
      </span>
      <div className="relative z-10 hidden gap-0.5 group-focus-within:flex group-hover:flex [@media(hover:none)]:flex">
        <button
          type="button"
          title="Rerun"
          aria-label={`Rerun ${w.title || w.prompt}`}
          onClick={onRerun}
          disabled={busy}
          className="grid h-7 w-7 place-items-center rounded-md text-zinc-500 hover:bg-white/[0.06] hover:text-zinc-200"
        >
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <RotateCw className="h-3.5 w-3.5" aria-hidden />}
        </button>
        <button
          type="button"
          title="Delete"
          aria-label={`Delete ${w.title || w.prompt}`}
          onClick={onDelete}
          disabled={busy}
          className="grid h-7 w-7 place-items-center rounded-md text-zinc-500 hover:bg-white/[0.06] hover:text-zinc-200"
        >
          <Trash2 className="h-3.5 w-3.5" aria-hidden />
        </button>
      </div>
    </div>
  );
}
