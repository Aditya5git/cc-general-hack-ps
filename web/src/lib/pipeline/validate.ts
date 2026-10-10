import { CHECKS_KEY, METHOD_KEY, QUOTE_KEY, QUOTE_OK_KEY, WHY_KEY, type DropReasons, type FieldSpec, type WorkflowPlan } from "../types";
import type { Extracted } from "./extract";

export interface CleanRow {
  data: Record<string, unknown>;
  source_name: string;
  source_url: string;
  confidence: number;
  dedupe_key: string;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function cleanValue(f: FieldSpec, v: unknown): unknown {
  if (v == null) return null;
  if (typeof v === "string") {
    v = v.replace(/\s+/g, " ").trim();
    if (v === "" || /^(n\/a|null|none|unknown|-)$/i.test(v as string)) return null;
  }
  switch (f.type) {
    case "number": {
      if (typeof v === "number") return Number.isFinite(v) ? v : null;
      const n = Number(String(v).replace(/[$,%\s]/g, ""));
      return Number.isFinite(n) ? n : String(v);
    }
    case "url": {
      const s = String(v);
      try {
        const u = new URL(s.startsWith("http") ? s : `https://${s}`);
        return u.hostname.includes(".") ? u.toString() : null;
      } catch {
        return null;
      }
    }
    case "email":
      return EMAIL.test(String(v)) ? String(v).toLowerCase() : null;
    case "date": {
      const d = new Date(typeof v === "number" && v < 1e12 ? v * 1000 : (v as string));
      return isNaN(d.getTime()) ? String(v) : d.toISOString().slice(0, 10);
    }
    case "list":
      if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean).slice(0, 12);
      return String(v).split(/[,;|]/).map((x) => x.trim()).filter(Boolean).slice(0, 12);
    default:
      return typeof v === "object" ? JSON.stringify(v) : String(v).slice(0, 1000);
  }
}

const norm = (v: unknown) =>
  String(v ?? "")
    .toLowerCase()
    .replace(/^https?:\/\/(www\.)?/, "")
    // drop the fragment and tracking params only: many sites identify the item in the query (item?id=123)
    .replace(/#.*$/, "")
    .replace(/([?&])(utm_[a-z]+|ref|fbclid|gclid)=[^&]*/g, "$1")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

const NAMING = /(^|_)(name|title)$/;

/** The column that names a row (job title, company name…). The only field a row must have. A column called
 *  *name / *title wins, so a required "salary" listed first never becomes the name. */
export const identityField = (plan: WorkflowPlan) =>
  (plan.fields.find((f) => f.type === "string" && NAMING.test(f.name)) ??
    plan.fields.find((f) => f.required && f.type === "string") ??
    plan.fields.find((f) => f.type === "string") ??
    plan.fields[0]).name;

// Ranking. Columns the user asked for (required) count REQUIRED_WEIGHT times in the fill share, and each one
// left empty (other than the name) costs MISSING_REQUIRED: a job without the salary you asked for ranks below
// jobs that have it, but stays in the table. Failing a detail filter halves the score.
const REQUIRED_WEIGHT = 3;
const MISSING_REQUIRED = 0.75;

function score(plan: WorkflowPlan, idField: string, data: Record<string, unknown>, relevance: number, failedFilters: number) {
  const weight = (f: FieldSpec) => (f.required ? REQUIRED_WEIGHT : 1);
  const total = plan.fields.reduce((n, f) => n + weight(f), 0);
  const fill = plan.fields.reduce((n, f) => n + (data[f.name] != null ? weight(f) : 0), 0) / total;
  const missing = plan.fields.filter((f) => f.required && f.name !== idField && data[f.name] == null).length;
  const s = (0.6 * relevance + 0.4 * fill) * MISSING_REQUIRED ** missing * (failedFilters ? 0.5 : 1);
  return Math.round(s * 100) / 100;
}

// Rows the extractor (or keyword fallback) scores below this are not the requested thing.
const MIN_RELEVANCE = 0.4;

/**
 * Rows that fail a detail filter are kept, marked ✗ in their checks, at half confidence so they sort below rows
 * that pass; `reasons.failed_filters` counts them (as flagged, not dropped). Unnamed rows, low-relevance rows and
 * rows failing a subject filter are dropped.
 */
export function validateAndDedupe(plan: WorkflowPlan, rows: Extracted[]): {
  clean: CleanRow[];
  invalid: number;
  duplicates: number;
  reasons: DropReasons;
  relaxed: boolean;
} {
  const out = new Map<string, CleanRow>();
  const basis = new Map<string, { relevance: number; failed: number }>(); // per dedupe key, to rescore after a merge
  let invalid = 0;
  let duplicates = 0;
  const reasons: DropReasons = { no_name: 0, irrelevant: 0, failed_filters: {} };
  const idField = identityField(plan);
  const subject = new Set(plan.subject_filters ?? []);

  for (const r of rows) {
    const data: Record<string, unknown> = {};
    for (const f of plan.fields) data[f.name] = cleanValue(f, r.data[f.name]);

    // Keep partial rows (empty columns show as "—") and rows that fail a detail filter (shown ✗). Drop rows with
    // no name, rows the extractor rated as not being the requested thing, and rows that fail a subject filter
    // ("must be a React role"): a sales job is not a weaker match for "React jobs", it is no match.
    const failed = plan.filters.filter((_, i) => r.checks?.[i] === false);
    const offSubject = failed.some((f) => subject.has(f));
    if (data[idField] == null || r.relevance < MIN_RELEVANCE || offSubject) {
      if (data[idField] == null) reasons.no_name++;
      else reasons.irrelevant++;
      invalid++;
      continue;
    }
    for (const f of failed) reasons.failed_filters[f] = (reasons.failed_filters[f] ?? 0) + 1;

    const why = typeof r.why === "string" ? r.why.replace(/\s+/g, " ").trim().slice(0, 240) : "";
    if (why) data[WHY_KEY] = why;
    if (r.quote) {
      data[QUOTE_KEY] = r.quote;
      data[QUOTE_OK_KEY] = !!r.quoteVerified;
    }
    if (r.method) data[METHOD_KEY] = r.method;
    if (plan.filters.length && r.checks?.length)
      data[CHECKS_KEY] = plan.filters.map((_, i) => (typeof r.checks![i] === "boolean" ? r.checks![i] : null));

    const keyFields = plan.dedupe_on.length ? plan.dedupe_on : [plan.fields[0].name];
    let key = keyFields.map((k) => norm(data[k])).join("|");
    if (!key.replace(/\|/g, "")) key = norm(r.item.url);

    const row: CleanRow = {
      data,
      source_name: r.item.source,
      source_url: r.item.url,
      confidence: score(plan, idField, data, r.relevance, failed.length),
      dedupe_key: key.slice(0, 300),
    };
    const prev = out.get(row.dedupe_key);
    if (prev) {
      duplicates++;
      // keep the more complete/confident row, merge in any missing fields, then score the merged row
      const mine = { relevance: r.relevance, failed: failed.length };
      const [keep, other, b] = row.confidence > prev.confidence ? [row, prev, mine] : [prev, row, basis.get(row.dedupe_key)!];
      for (const k of Object.keys(keep.data)) if (keep.data[k] == null) keep.data[k] = other.data[k];
      keep.confidence = score(plan, idField, keep.data, b.relevance, b.failed);
      out.set(row.dedupe_key, keep);
      basis.set(row.dedupe_key, b);
    } else {
      out.set(row.dedupe_key, row);
      basis.set(row.dedupe_key, { relevance: r.relevance, failed: failed.length });
    }
  }

  const clean = [...out.values()].sort((a, b) => b.confidence - a.confidence).slice(0, plan.max_results);
  const relaxed = clean.some((c) => Array.isArray(c.data[CHECKS_KEY]) && (c.data[CHECKS_KEY] as unknown[]).includes(false));
  return { clean, invalid, duplicates, reasons, relaxed };
}
