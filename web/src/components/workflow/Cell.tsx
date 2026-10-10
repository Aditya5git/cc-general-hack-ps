import { ExternalLink } from "lucide-react";
import type { FieldType } from "@/lib/types";
import { hostOf } from "@/components/utils";

function looksLikeUrl(v: unknown): v is string {
  return typeof v === "string" && /^https?:\/\//i.test(v);
}

export function formatValue(v: unknown): string {
  if (v === null || v === undefined || v === "") return "";
  if (Array.isArray(v)) return v.map(formatValue).join(", ");
  if (typeof v === "object") return JSON.stringify(v);
  if (typeof v === "number") return v.toLocaleString();
  return String(v);
}

export function Cell({ value, type, full = false }: { value: unknown; type?: FieldType; full?: boolean }) {
  if (value === null || value === undefined || value === "" || (Array.isArray(value) && value.length === 0)) {
    return <span className="text-zinc-700">—</span>;
  }
  if (Array.isArray(value) || type === "list") {
    const arr = Array.isArray(value) ? value : String(value).split(/,\s*/);
    const shown = full ? arr : arr.slice(0, 3);
    return (
      <div className={`flex gap-1 ${full ? "flex-wrap" : "flex-nowrap"}`} title={arr.map(formatValue).join(", ")}>
        {shown.map((x, i) => (
          <span key={i} className="whitespace-nowrap rounded bg-white/[0.06] px-1.5 py-0.5 text-[11px] text-zinc-300">
            {formatValue(x)}
          </span>
        ))}
        {!full && arr.length > 3 && <span className="text-[11px] text-zinc-500">+{arr.length - 3}</span>}
      </div>
    );
  }
  if (type === "url" || looksLikeUrl(value)) {
    const s = String(value);
    return (
      <a
        href={s}
        target="_blank"
        rel="noreferrer"
        onClick={(e) => e.stopPropagation()}
        className="inline-flex max-w-full items-center gap-1 text-accent-soft hover:text-accent-ink hover:underline"
        title={s}
      >
        <span className={full ? "break-all" : "truncate"}>{full ? s : hostOf(s) || s}</span>
        <ExternalLink className="h-3 w-3 shrink-0" />
      </a>
    );
  }
  if (type === "email" && typeof value === "string") {
    return (
      <a href={`mailto:${value}`} onClick={(e) => e.stopPropagation()} className="text-accent-soft hover:underline">
        {value}
      </a>
    );
  }
  if (type === "date") {
    // Year-only and date-only values have no time of day; new Date() would read them as UTC midnight
    // and the local timezone could shift them (2024 → 12/31/2023). Show them without conversion.
    const s = String(value).trim();
    if (/^\d{4}$/.test(s)) return <span className="whitespace-nowrap tabular-nums">{s}</span>;
    if (/^\d{4}-\d{2}(-\d{2})?$/.test(s)) {
      const d = new Date(s);
      if (!Number.isNaN(d.getTime())) {
        const opts: Intl.DateTimeFormatOptions = s.length === 7 ? { timeZone: "UTC", year: "numeric", month: "short" } : { timeZone: "UTC" };
        return <span className="whitespace-nowrap" title={s}>{d.toLocaleDateString(undefined, opts)}</span>;
      }
    }
  }
  if (type === "number" || typeof value === "number") {
    return <span className="tabular-nums">{formatValue(value)}</span>;
  }
  if (type === "date") {
    const d = new Date(String(value));
    if (!Number.isNaN(d.getTime())) {
      return <span className="whitespace-nowrap" title={String(value)}>{d.toLocaleDateString()}</span>;
    }
  }
  const s = formatValue(value);
  if (full) return <span className="whitespace-pre-wrap break-words">{s}</span>;
  return (
    <span className="block truncate" title={s}>
      {s}
    </span>
  );
}

export function ConfidenceBar({ value }: { value: number }) {
  const pct = Math.round((value <= 1 ? value * 100 : value) || 0);
  const color = pct >= 75 ? "bg-success" : pct >= 50 ? "bg-running" : "bg-danger";
  return (
    <div className="flex items-center gap-2" title="Heuristic score: relevance + filled columns. Not a probability.">
      <div className="h-1.5 w-12 overflow-hidden rounded-full bg-white/5">
        <div className={`h-full rounded-full ${color}`} style={{ width: `${pct}%` }} />
      </div>
      <span className="w-8 text-[11px] tabular-nums text-zinc-400">{pct}%</span>
    </div>
  );
}
