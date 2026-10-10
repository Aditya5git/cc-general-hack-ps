"use client";

import { useState } from "react";
import { Columns3, Filter, Globe, Loader2, Play, Plus, X } from "lucide-react";
import type { ConnectorId, FieldSpec, SourceStep, WorkflowPlan } from "@/lib/types";
import { CONNECTOR_LABELS, connectorLabel, fetchJSON, humanize, inferFieldType } from "@/components/utils";

/** Human-in-the-loop step: edit what the planning agent proposed (in plain language), then start collection. */
export function PlanEditor({ workflowId, plan, onStarted }: { workflowId: string; plan: WorkflowPlan; onStarted: () => void }) {
  const [fields, setFields] = useState<FieldSpec[]>(plan.fields);
  const [sources, setSources] = useState<SourceStep[]>(plan.sources);
  const [filters, setFilters] = useState<string[]>(plan.filters);
  const [newField, setNewField] = useState("");
  const [newSource, setNewSource] = useState({ connector: "web_search" as ConnectorId, query: "" });
  const [newFilter, setNewFilter] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function run() {
    setBusy(true);
    setErr(null);
    try {
      await fetchJSON(`/api/workflows/${workflowId}/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ plan: { fields, sources, filters } }),
      });
      onStarted();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to start");
      setBusy(false);
    }
  }

  const input =
    "h-8 rounded-md border border-line-strong bg-zinc-950/40 px-2.5 text-[13px] text-ink placeholder:text-zinc-600 focus:border-zinc-500 focus:outline-none";
  const iconBtn = "grid h-8 w-8 shrink-0 place-items-center rounded-md border border-line-strong text-zinc-300 transition hover:bg-zinc-50/10";

  return (
    <section aria-labelledby="plan-title" className="glass animate-fade-up mt-5 rounded-lg p-4">
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0">
          <h2 id="plan-title" className="text-[14px] font-medium text-ink">
            Here&apos;s the plan. Change anything before it runs.
          </h2>
          <p className="mt-0.5 text-[12.5px] text-ink-muted">
            You&apos;ll get one row per <span className="text-zinc-200">{plan.entity}</span>, with the details below.
          </p>
        </div>
        <button
          type="button"
          onClick={run}
          disabled={busy}
          className="btn-glow ml-auto inline-flex h-9 items-center gap-1.5 rounded-lg px-3.5 text-[13px] font-medium"
        >
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <Play className="h-3.5 w-3.5" aria-hidden />} Looks good, run it
        </button>
      </div>
      {err && (
        <p role="alert" className="mt-2 text-[12.5px] text-danger-soft">
          {err}
        </p>
      )}

      <div className="mt-5 grid gap-6 lg:grid-cols-3">
        {/* Details per row */}
        <div>
          <h3 className="mb-2 flex items-center gap-1.5 text-[12.5px] font-medium text-zinc-300">
            <Columns3 className="h-3.5 w-3.5 text-zinc-500" aria-hidden /> Details for each row
          </h3>
          <ul className="flex flex-wrap gap-1.5">
            {fields.map((f, i) => (
              <li
                key={f.name}
                title={f.description || undefined}
                className="inline-flex h-7 items-center gap-1 rounded-full border border-line-strong bg-zinc-50/[0.03] pl-3 pr-1 text-[12.5px] text-zinc-200"
              >
                {humanize(f.name)}
                <button
                  type="button"
                  onClick={() => setFields(fields.filter((_, j) => j !== i))}
                  aria-label={`Remove ${humanize(f.name)}`}
                  className="grid h-5 w-5 place-items-center rounded-full text-zinc-500 hover:bg-zinc-50/10 hover:text-zinc-200"
                >
                  <X className="h-3 w-3" aria-hidden />
                </button>
              </li>
            ))}
          </ul>
          <form
            className="mt-2.5 flex gap-1.5"
            onSubmit={(e) => {
              e.preventDefault();
              const label = newField.trim();
              const name = label.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
              if (!name || fields.some((f) => f.name === name)) return;
              setFields([...fields, { name, type: inferFieldType(label), description: label }]);
              setNewField("");
            }}
          >
            <label htmlFor="new-field" className="sr-only">
              Add a detail
            </label>
            <input id="new-field" value={newField} onChange={(e) => setNewField(e.target.value)} placeholder="Add a detail, e.g. Funding stage" className={`${input} min-w-0 flex-1`} />
            <button type="submit" aria-label="Add detail" className={iconBtn}>
              <Plus className="h-3.5 w-3.5" aria-hidden />
            </button>
          </form>
        </div>

        {/* Sources */}
        <div>
          <h3 className="mb-2 flex items-center gap-1.5 text-[12.5px] font-medium text-zinc-300">
            <Globe className="h-3.5 w-3.5 text-zinc-500" aria-hidden /> Where to look
          </h3>
          <ul className="space-y-1.5">
            {sources.map((s, i) => (
              <li key={i} className="rounded-md border border-line bg-zinc-50/[0.02] p-2">
                <div className="flex items-center gap-2">
                  <span className="text-[12.5px] font-medium text-zinc-200">{connectorLabel(s.connector)}</span>
                  <button
                    type="button"
                    onClick={() => setSources(sources.filter((_, j) => j !== i))}
                    aria-label={`Remove ${connectorLabel(s.connector)}`}
                    className="ml-auto grid h-6 w-6 place-items-center rounded text-zinc-500 hover:bg-zinc-50/10 hover:text-zinc-200"
                  >
                    <X className="h-3.5 w-3.5" aria-hidden />
                  </button>
                </div>
                <label className="mt-1 flex items-center gap-2 text-[12px] text-zinc-500">
                  <span className="shrink-0">Searching for</span>
                  <input
                    value={s.query}
                    onChange={(e) => setSources(sources.map((x, j) => (j === i ? { ...x, query: e.target.value } : x)))}
                    className={`${input} h-7 min-w-0 flex-1`}
                  />
                </label>
              </li>
            ))}
          </ul>
          <form
            className="mt-2.5 flex gap-1.5"
            onSubmit={(e) => {
              e.preventDefault();
              if (!newSource.query.trim()) return;
              setSources([...sources, { connector: newSource.connector, query: newSource.query.trim(), limit: 20, reason: "Added by you" }]);
              setNewSource({ ...newSource, query: "" });
            }}
          >
            <select
              value={newSource.connector}
              onChange={(e) => setNewSource({ ...newSource, connector: e.target.value as ConnectorId })}
              className={`${input} w-[7.5rem] px-1.5`}
              aria-label="Source to add"
            >
              {Object.entries(CONNECTOR_LABELS).map(([id, label]) => (
                <option key={id} value={id} className="bg-zinc-900">
                  {label}
                </option>
              ))}
            </select>
            <input
              value={newSource.query}
              onChange={(e) => setNewSource({ ...newSource, query: e.target.value })}
              placeholder={newSource.connector === "url_fetch" ? "Paste a link" : "What to search for"}
              aria-label="What to search for"
              className={`${input} min-w-0 flex-1`}
            />
            <button type="submit" aria-label="Add source" className={iconBtn}>
              <Plus className="h-3.5 w-3.5" aria-hidden />
            </button>
          </form>
        </div>

        {/* Conditions */}
        <div>
          <h3 className="mb-2 flex items-center gap-1.5 text-[12.5px] font-medium text-zinc-300">
            <Filter className="h-3.5 w-3.5 text-zinc-500" aria-hidden /> Check each row for
          </h3>
          <ul className="space-y-1">
            {filters.map((f, i) => (
              <li key={i} className="flex items-start gap-2 rounded-md px-1 py-1 text-[13px] text-zinc-200 hover:bg-zinc-50/[0.03]">
                <span className="mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full bg-zinc-500" aria-hidden />
                <span className="min-w-0 flex-1">{f.charAt(0).toUpperCase() + f.slice(1)}</span>
                <button
                  type="button"
                  onClick={() => setFilters(filters.filter((_, j) => j !== i))}
                  aria-label={`Remove condition: ${f}`}
                  className="grid h-6 w-6 shrink-0 place-items-center rounded text-zinc-500 hover:bg-zinc-50/10 hover:text-zinc-200"
                >
                  <X className="h-3.5 w-3.5" aria-hidden />
                </button>
              </li>
            ))}
            {!filters.length && <li className="text-[12.5px] text-zinc-500">No conditions.</li>}
          </ul>
          <form
            className="mt-2.5 flex gap-1.5"
            onSubmit={(e) => {
              e.preventDefault();
              if (!newFilter.trim()) return;
              setFilters([...filters, newFilter.trim()]);
              setNewFilter("");
            }}
          >
            <label htmlFor="new-filter" className="sr-only">
              Add a condition
            </label>
            <input id="new-filter" value={newFilter} onChange={(e) => setNewFilter(e.target.value)} placeholder="Add a condition, e.g. based in India" className={`${input} min-w-0 flex-1`} />
            <button type="submit" aria-label="Add condition" className={iconBtn}>
              <Plus className="h-3.5 w-3.5" aria-hidden />
            </button>
          </form>
        </div>
      </div>
    </section>
  );
}
