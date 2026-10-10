import { Fragment } from "react";
import { BadgeCheck, Check, HelpCircle, Quote, X } from "lucide-react";
import { CHECKS_KEY, METHOD_KEY, QUOTE_KEY, QUOTE_OK_KEY, WHY_KEY, type DataRecord, type FieldSpec } from "@/lib/types";

export const whyOf = (r: DataRecord) => (typeof r.data[WHY_KEY] === "string" ? (r.data[WHY_KEY] as string) : "");
export const checksOf = (r: DataRecord) => (Array.isArray(r.data[CHECKS_KEY]) ? (r.data[CHECKS_KEY] as (boolean | null)[]) : []);

/** Criteria passed, out of the ones the source could answer. Used for sorting. */
export function matchScore(r: DataRecord): number | null {
  const known = checksOf(r).filter((c) => c !== null);
  return known.length ? known.filter(Boolean).length / known.length : null;
}

function CheckIcon({ value, className = "h-3 w-3" }: { value: boolean | null; className?: string }) {
  if (value === true) return <Check className={`${className} text-success`} />;
  if (value === false) return <X className={`${className} text-danger`} />;
  return <HelpCircle className={`${className} text-zinc-600`} />;
}

const stateLabel = (v: boolean | null) => (v === true ? "met" : v === false ? "not met" : "not stated in source");

/** Compact table cell: one icon per criterion, then the reason. */
export function MatchCell({ record, criteria }: { record: DataRecord; criteria: string[] }) {
  const checks = checksOf(record);
  const why = whyOf(record);
  if (!why && !checks.length) return <span className="text-zinc-700">—</span>;
  return (
    <div className="flex min-w-0 items-center gap-2">
      {checks.length > 0 && (
        <span className="flex shrink-0 items-center gap-0.5 rounded bg-white/[0.04] px-1 py-0.5">
          {checks.map((c, i) => (
            <span key={i} title={`${criteria[i] ?? `Criterion ${i + 1}`}: ${stateLabel(c)}`}>
              <CheckIcon value={c} />
            </span>
          ))}
        </span>
      )}
      {why && (
        <span className="block truncate text-xs text-zinc-400" title={why}>
          {why}
        </span>
      )}
    </div>
  );
}

/** Full breakdown for the record drawer. */
export function MatchDetails({ record, criteria }: { record: DataRecord; criteria: string[] }) {
  const checks = checksOf(record);
  const why = whyOf(record);
  if (!why && !checks.length) return null;
  return (
    <div className="mt-4 rounded-xl border border-white/10 bg-white/[0.02] p-3.5">
      <div className="text-xs font-medium text-zinc-200">Why it matched</div>
      {why && <p className="mt-1.5 text-sm text-zinc-300">{why}</p>}
      {checks.length > 0 && (
        <ul className="mt-3 space-y-1.5">
          {checks.map((c, i) => (
            <li key={i} className="flex items-start gap-2 text-sm">
              <CheckIcon value={c} className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span className={c === false ? "text-zinc-400" : "text-zinc-300"}>{criteria[i] ?? `Criterion ${i + 1}`}</span>
              <span className="ml-auto shrink-0 text-[11px] text-zinc-500">{stateLabel(c)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Highlight the row's own values inside the source excerpt. */
function highlight(quote: string, terms: string[]) {
  const usable = [...new Set(terms.map((t) => t.trim()).filter((t) => t.length >= 2 && t.length <= 80))].sort((a, b) => b.length - a.length);
  if (!usable.length) return quote;
  const re = new RegExp(`(${usable.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`, "gi");
  return quote.split(re).map((part, i) =>
    i % 2 ? (
      <mark key={i} className="rounded-sm bg-zinc-50/12 px-0.5 text-zinc-50">
        {part}
      </mark>
    ) : (
      <Fragment key={i}>{part}</Fragment>
    ),
  );
}

/** "Evidence from source": the verbatim excerpt the row was built from, verified in code. */
export function Evidence({ record, fields }: { record: DataRecord; fields: FieldSpec[] }) {
  const quote = typeof record.data[QUOTE_KEY] === "string" ? (record.data[QUOTE_KEY] as string) : "";
  if (!quote) return null;
  const verified = record.data[QUOTE_OK_KEY] === true;
  const keyword = record.data[METHOD_KEY] === "keyword";
  const terms = fields
    .filter((f) => f.type !== "url")
    .flatMap((f) => {
      const v = record.data[f.name];
      return Array.isArray(v) ? v.map(String) : v == null ? [] : [String(v)];
    });
  return (
    <div className="mt-4 rounded-xl border border-white/10 bg-white/[0.02] p-3.5">
      <div className="flex items-center gap-1.5 text-xs font-medium text-zinc-200">
        <Quote className="h-3.5 w-3.5 text-zinc-400" /> Evidence from source
        <span
          className={`ml-auto inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10.5px] font-normal ${
            verified ? "bg-success/15 text-success-soft" : "bg-white/[0.05] text-zinc-400"
          }`}
          title={
            keyword
              ? "The AI was unavailable, so this sentence was picked because it has the most words from your request"
              : verified
                ? "This exact text was found in the page DataPilot fetched"
                : "Couldn't match this text word-for-word in the fetched page"
          }
        >
          {verified ? <BadgeCheck className="h-3 w-3" /> : <HelpCircle className="h-3 w-3" />}
          {keyword ? "Picked by keyword match, not by AI" : verified ? "Found word-for-word in source" : "Paraphrased, not verbatim"}
        </span>
      </div>
      <blockquote className="mt-2 border-l-2 border-zinc-600 pl-3 text-sm italic leading-relaxed text-zinc-300">“{highlight(quote, terms)}”</blockquote>
    </div>
  );
}
