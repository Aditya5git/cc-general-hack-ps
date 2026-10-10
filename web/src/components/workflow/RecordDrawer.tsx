"use client";

import { useEffect, useRef } from "react";
import { Clock, ExternalLink, Link2, X } from "lucide-react";
import type { DataRecord, FieldSpec } from "@/lib/types";
import { connectorLabel, formatDateTime, hostOf, humanize } from "@/components/utils";
import { Cell, ConfidenceBar, formatValue } from "./Cell";
import { Evidence, MatchDetails } from "./Match";

export function RecordDrawer({
  record,
  fields,
  criteria,
  onClose,
}: {
  record: DataRecord | null;
  fields: FieldSpec[];
  criteria: string[];
  onClose: () => void;
}) {
  const panelRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const isOpen = !!record;

  // Modal behaviour: focus moves in, Tab stays inside, Escape closes, the page behind can't scroll,
  // and focus goes back to whatever opened the drawer (the table row).
  useEffect(() => {
    if (!isOpen) return;
    const opener = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") return onClose();
      if (e.key !== "Tab" || !panelRef.current) return;
      const focusable = panelRef.current.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), summary, input, select, textarea, [tabindex]:not([tabindex="-1"])',
      );
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
      opener?.focus?.();
    };
  }, [isOpen, onClose]);

  if (!record) return null;
  const known = new Set(fields.map((f) => f.name));
  const extra = Object.keys(record.data).filter((k) => !known.has(k) && !k.startsWith("_"));
  const rows: { key: string; type?: FieldSpec["type"]; desc?: string }[] = [
    ...fields.map((f) => ({ key: f.name, type: f.type, desc: f.description })),
    ...extra.map((k) => ({ key: k })),
  ];

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-[2px]" onClick={onClose} aria-hidden />
      <aside
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="record-drawer-title"
        className="animate-slide-in relative flex h-full w-full max-w-xl flex-col border-l border-white/10 bg-zinc-950 shadow-2xl"
      >
        <div className="flex items-start justify-between gap-3 border-b border-white/5 px-5 py-4">
          <div className="min-w-0">
            <div className="text-[11px] uppercase tracking-wider text-zinc-500">Record #{record.id}</div>
            <h2 id="record-drawer-title" className="mt-0.5 truncate text-base font-medium text-white">
              {formatValue(record.data[fields[0]?.name] ?? record.data.name ?? record.data.title ?? "Record details")}
            </h2>
          </div>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            className="rounded-md p-1.5 text-zinc-400 hover:bg-white/5 hover:text-white"
            aria-label="Close record details"
          >
            <X className="h-4 w-4" aria-hidden />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto overscroll-contain px-5 py-4">
          <div className="glass rounded-xl p-3.5">
            <div className="flex items-center gap-1.5 text-xs font-medium text-zinc-200">
              <Link2 className="h-3.5 w-3.5" /> Traceability
            </div>
            <p className="mt-1.5 text-sm text-zinc-300">
              Fetched from <span className="font-medium text-zinc-50">{connectorLabel(record.source_name)}</span>
              {record.source_url && (
                <>
                  {" "}
                  (<span className="text-zinc-400">{hostOf(record.source_url)}</span>)
                </>
              )}
            </p>
            <div className="mt-1 flex items-center gap-1 text-xs text-zinc-500">
              <Clock className="h-3 w-3" /> {formatDateTime(record.fetched_at)}
            </div>
            <div className="mt-3 flex items-center justify-between gap-3">
              {record.source_url ? (
                <a
                  href={record.source_url}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1.5 rounded-md bg-zinc-50 px-2.5 py-1.5 text-xs font-medium text-zinc-950 hover:bg-zinc-200"
                >
                  Open source <ExternalLink className="h-3 w-3" />
                </a>
              ) : (
                <span className="text-xs text-zinc-500">No source URL</span>
              )}
              <div className="flex items-center gap-2 text-xs text-zinc-500">
                Confidence <ConfidenceBar value={record.confidence} />
              </div>
            </div>
          </div>

          <Evidence record={record} fields={fields} />
          <MatchDetails record={record} criteria={criteria} />

          <dl className="mt-5 divide-y divide-white/5">
            {rows.map(({ key, type, desc }) => (
              <div key={key} className="grid grid-cols-[140px_1fr] gap-3 py-2.5 text-sm">
                <dt className="text-xs text-zinc-500" title={desc}>
                  {humanize(key)}
                  {fields.find((f) => f.name === key)?.ai && <div className="text-[10px] text-accent-soft">AI column</div>}
                </dt>
                <dd className="min-w-0 text-zinc-200">
                  <Cell value={record.data[key]} type={type} full />
                  {typeof record.data[`_basis_${key}`] === "string" && record.data[`_basis_${key}`] !== "" && (
                    <div className="mt-1 text-[11.5px] text-zinc-500">Based on: {String(record.data[`_basis_${key}`])}</div>
                  )}
                </dd>
              </div>
            ))}
          </dl>

          <details className="mt-5 rounded-lg border border-white/5 bg-black/30">
            <summary className="cursor-pointer px-3 py-2 text-xs text-zinc-400">Raw JSON</summary>
            <pre className="overflow-x-auto px-3 pb-3 font-mono text-[11px] leading-relaxed text-zinc-400">
              {JSON.stringify(record, null, 2)}
            </pre>
          </details>
        </div>
      </aside>
    </div>
  );
}
