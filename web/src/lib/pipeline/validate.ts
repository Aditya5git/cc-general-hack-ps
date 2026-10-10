import { CHECKS_KEY, FIELD_SOURCES_KEY, METHOD_KEY, QUOTE_KEY, QUOTE_OK_KEY, WHY_KEY, type DropReasons, type FieldSpec, type WorkflowPlan } from "../types";
import type { Extracted } from "./extract";

export interface CleanRow {
  data: Record<string, unknown>;
  source_name: string;
  source_url: string;
  confidence: number;
  dedupe_key: string;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Values that mean "not given". Kept as text they would fill the cell, raise the row's score and stop a merge
// from filling in the real value from another source.
const EMPTY =
  /^(n\/?a|null|none|nil|unknown|-+|—|–|tbd|tba|undisclosed|confidential|competitive|negotiable|varies|not (specified|disclosed|available|listed|provided|mentioned|stated|applicable)|see (description|website|listing))$/i;

// Scale written right after the number (120k, 1.5M, 2bn) or as its own word (12 lakh, 3 crore, 1,5 Mio). Letters that
// aren't a scale are a unit ("100 mm", "5 L") and leave the number alone.
const SCALE_ATTACHED: Record<string, number> = { k: 1e3, m: 1e6, mn: 1e6, b: 1e9, bn: 1e9 };
const SCALE_WORD: Record<string, number> = {
  thousand: 1e3, lakh: 1e5, lakhs: 1e5, lac: 1e5, lacs: 1e5, lpa: 1e5, million: 1e6, millions: 1e6, mio: 1e6, mn: 1e6,
  crore: 1e7, crores: 1e7, cr: 1e7, billion: 1e9, billions: 1e9, bn: 1e9, trillion: 1e12,
};
const CURRENCY = /[$€£₹]|\b(usd|inr|eur|gbp|rs\.?|us)\b/g;
const QUALIFIER = /^(about|approx\.?|approximately|around|~|over|under|up to|upto|nearly|almost|more than|less than|at least|[<>]=?)\s*/;

/** "12.345" style digits as a number: "1.234,56" / "€50.000" / "1.000.000" (dot thousands), "12,5" (decimal comma). */
function digits(tok: string, euro: boolean): number {
  if (/^\d{1,3}(\.\d{3})+,\d+$/.test(tok)) return Number(tok.replace(/\./g, "").replace(",", "."));
  if (/^\d{1,3}(\.\d{3}){2,}$/.test(tok) || (euro && /^\d{1,3}\.\d{3}$/.test(tok))) return Number(tok.replace(/\./g, ""));
  if (/^\d+,\d{1,2}$/.test(tok)) return Number(tok.replace(",", "."));
  return Number(tok.replace(/,/g, ""));
}

/**
 * A number only when the value IS a number: "$120k" → 120000, "₹12 LPA" → 1200000, "120k–150k" → 120000 (lower
 * bound), "31,956 stars" → 31956, "(5)" → -5, "Free" → 0. Text with other numbers in it ("Top 10: 2,500", "Series 2
 * $30M", a phone number, "v2.3.1") is null: a wrong number sorts and charts as if it were right.
 */
export function parseNumber(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v !== "string") return null;
  let s = v.trim().toLowerCase().replace(/−/g, "-");
  if (s === "free") return 0;
  const money = /[$€£₹]|\b(usd|inr|eur|gbp|rs\.?)\b/.test(s);
  const euro = /€|\beur\b/.test(s);
  s = s.replace(CURRENCY, " ").trim().replace(QUALIFIER, "").trim();
  const paren = /^\(.*\)$/.test(s);
  if (paren) s = s.slice(1, -1).trim();
  const sci = s.match(/^([-+]?\d+(?:\.\d+)?)e([-+]?\d+)$/);
  if (sci) return Number(`${sci[1]}e${sci[2]}`);
  const m = s.match(/^([-+]?)(\.\d+|\d[\d.,]*)([a-z]*)\s*([a-z]+)?\b(.*)$/);
  if (!m) return null;
  const [, sign, tok, attached, word] = m;
  let rest = m[5];
  let n = digits(tok.startsWith(".") ? `0${tok}` : tok.replace(/[.,]$/, ""), euro);
  if (!Number.isFinite(n)) return null;
  let scale = 1;
  if (attached) {
    if (SCALE_ATTACHED[attached]) scale = SCALE_ATTACHED[attached];
    else if (SCALE_WORD[attached]) scale = SCALE_WORD[attached];
  }
  if (word) {
    if (scale === 1 && (SCALE_WORD[word] || (money && SCALE_ATTACHED[word]))) scale = SCALE_WORD[word] ?? SCALE_ATTACHED[word];
    else rest = `${word}${rest}`;
  }
  // a range's upper bound ("- 150k", "to $200,000") may hold digits; anything else after the number may not
  rest = rest.replace(/^\s*(-|–|to)\s*[\d.,]+\s*[a-z]*/, "");
  if (/\d/.test(rest)) return null;
  n *= scale * (sign === "-" || paren ? -1 : 1);
  return Math.round(n * 1e6) / 1e6;
}

const pad = (n: number) => String(n).padStart(2, "0");
const ymd = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`;

/**
 * A date as YYYY-MM-DD, keeping the precision the source gave: "2015" stays "2015", "Mar 2024" becomes "2024-03".
 * Dates without a time are read as calendar dates, so no timezone can move them a day. "3 days ago" is counted
 * from today. Anything unreadable is kept as written.
 */
export function cleanDate(v: unknown, now = new Date()): string | null {
  if (typeof v === "number") {
    if (v >= 1000 && v <= 9999) return String(v); // a year, not a timestamp
    const d = new Date(v < 1e12 ? v * 1000 : v);
    return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
  }
  const s = String(v).trim();
  if (/^\d{4}(-\d{2}){0,2}$/.test(s)) return s;
  const monthYear = s.match(/^([a-z]{3,9})\.?,? (\d{4})$/i);
  if (monthYear) {
    const t = Date.parse(`${monthYear[1]} 1, ${monthYear[2]}`);
    if (!Number.isNaN(t)) return `${monthYear[2]}-${pad(new Date(t).getMonth() + 1)}`;
  }
  const ago = s.toLowerCase().match(/^(\d+|an?) (minute|hour|day|week|month|year)s? ago$/);
  if (ago || /^(today|yesterday|just now)$/i.test(s)) {
    const n = ago ? (/^\d/.test(ago[1]) ? Number(ago[1]) : 1) : /yesterday/i.test(s) ? 1 : 0;
    const unit = ago?.[2] ?? "day";
    // counted on the local calendar, like every other date here ("today" at 01:00 IST is still today)
    const d = new Date(now);
    if (unit === "year" || unit === "month") {
      const day = d.getDate();
      d.setDate(1);
      if (unit === "year") d.setFullYear(d.getFullYear() - n);
      else d.setMonth(d.getMonth() - n);
      d.setDate(Math.min(day, new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate())); // Mar 31 - 1 month → Feb 28
    } else d.setTime(d.getTime() - n * { minute: 6e4, hour: 36e5, day: 864e5, week: 6048e5 }[unit]!);
    return ymd(d.getFullYear(), d.getMonth() + 1, d.getDate());
  }
  // ISO with a time: the date the source wrote ("2026-10-06T02:00+05:30" is Oct 6 where it was posted)
  if (/^\d{4}-\d{2}-\d{2}T/.test(s)) return s.slice(0, 10);
  const t = Date.parse(s);
  if (Number.isNaN(t)) return s;
  const d = new Date(t);
  // parsed as local midnight, so read the local calendar date back
  return ymd(d.getFullYear(), d.getMonth() + 1, d.getDate());
}

// US state and Canadian province codes: the only two-letter words a comma in a list should not split before
const REGION_CODES =
  "AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY|DC|ON|QC|BC|AB|MB|SK|NS|NB|NL|PE";

export function cleanValue(f: FieldSpec, v: unknown): unknown {
  if (v == null) return null;
  if (typeof v === "string") {
    v = v.replace(/\s+/g, " ").trim();
    if (v === "" || EMPTY.test((v as string).replace(/[.!]+$/, ""))) return null;
  }
  switch (f.type) {
    case "number":
      // null rather than raw text: a number column must sort and chart as numbers
      return typeof v === "boolean" ? null : parseNumber(v);
    case "url": {
      const s = String(v);
      try {
        const u = new URL(s.startsWith("http") ? s : `https://${s}`);
        return u.hostname.includes(".") ? u.toString() : null;
      } catch {
        return null;
      }
    }
    case "email": {
      const e = String(v).replace(/^mailto:/i, "");
      return EMAIL.test(e) ? e.toLowerCase() : null;
    }
    case "date":
      return cleanDate(v);
    case "list":
      if (Array.isArray(v)) return v.map((x) => (typeof x === "object" && x ? JSON.stringify(x) : String(x)).trim()).filter(Boolean).slice(0, 12);
      // "San Francisco, CA" stays one item; "Python, ML, AI" is three
      return String(v).split(new RegExp(`[;|]|,(?! (?:${REGION_CODES})\\b)`)).map((x) => x.trim()).filter(Boolean).slice(0, 12);
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

/** A sortable number for a cell: numbers as-is, "$1,234" → 1234, dates → epoch ms; null when there is none. */
function sortValue(v: unknown, type: FieldSpec["type"] | undefined): number | null {
  if (v == null || v === "") return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (type === "date") {
    const t = Date.parse(String(v));
    return Number.isNaN(t) ? null : t;
  }
  return parseNumber(v);
}

/**
 * The order rows are shown, exported and cut to max_results in. Rows that miss a filter (✗) come after rows that
 * don't; then, when the plan asks for an order ("top by market cap"), by that column with empty values last;
 * then by score.
 */
export function rankRows<T extends { data: Record<string, unknown>; confidence: number }>(plan: WorkflowPlan | null, rows: T[]): T[] {
  const flagged = (r: T) => (Array.isArray(r.data[CHECKS_KEY]) && (r.data[CHECKS_KEY] as unknown[]).includes(false) ? 1 : 0);
  const by = plan?.sort_by;
  const type = by && plan.fields.find((f) => f.name === by.field)?.type;
  const dir = by?.direction === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    const f = flagged(a) - flagged(b);
    if (f) return f;
    if (by) {
      const va = sortValue(a.data[by.field], type);
      const vb = sortValue(b.data[by.field], type);
      if (va != null && vb != null && va !== vb) return (va - vb) * dir;
      if ((va == null) !== (vb == null)) return va == null ? 1 : -1;
    }
    return b.confidence - a.confidence;
  });
}

const NAMING = /(^|_)(name|title)$/;

/** The column that names a row (job title, company name…). The only field a row must have. A column called
 *  *name / *title wins, so a required "salary" listed first never becomes the name. */
export const identityField = (plan: WorkflowPlan) =>
  (plan.fields.find((f) => f.required && f.type === "string" && NAMING.test(f.name)) ??
    plan.fields.find((f) => f.type === "string" && NAMING.test(f.name)) ??
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
  // capped at two: past that the row is already low, and a plan with many required columns shouldn't push every
  // partial row under rows that failed a filter
  const s = (0.6 * relevance + 0.4 * fill) * MISSING_REQUIRED ** Math.min(missing, 2) * (failedFilters ? 0.5 : 1);
  return Math.round(s * 100) / 100;
}

// Rows the extractor (or keyword fallback) scores below this are not the requested thing.
const MIN_RELEVANCE = 0.4;
// Keyword rows score the share of request words they contain: a right row often has 2 of 8 (0.25), so they get
// their own, lower bar; one stray word out of 8 (0.125) still fails.
const KEYWORD_MIN_RELEVANCE = 0.2;

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
    // checks are matched to filters by position: only trust a "fails the subject" verdict when the model gave one
    // check per filter, or a skipped check would shift "remote: false" onto the subject filter
    const offSubject = r.checks?.length === plan.filters.length && failed.some((f) => subject.has(f));
    const minRelevance = r.method === "keyword" ? KEYWORD_MIN_RELEVANCE : MIN_RELEVANCE;
    if (data[idField] == null || r.relevance < minRelevance || offSubject) {
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
    const parts = keyFields.map((k) => norm(data[k]));
    let key = parts.join("|");
    if (parts.every((p) => !p)) key = norm(r.item.url);
    // a half-empty key ("senior react developer|") would merge different companies' jobs: only within one page
    else if (parts.some((p) => !p)) key = `${norm(r.item.url)}|${key}`; // page first, so the 300-char cut keeps it

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
      // fill only schema columns (the kept row's quote, why and checks describe its own page) and remember which
      // page each borrowed value came from, since the row's source link points at the kept row's page
      const borrowed = { ...((keep.data[FIELD_SOURCES_KEY] as Record<string, string>) ?? {}) };
      for (const f of plan.fields) {
        if (keep.data[f.name] != null || other.data[f.name] == null) continue;
        keep.data[f.name] = other.data[f.name];
        const from = (other.data[FIELD_SOURCES_KEY] as Record<string, string> | undefined)?.[f.name] ?? other.source_url;
        if (from !== keep.source_url) borrowed[f.name] = from;
      }
      if (Object.keys(borrowed).length) keep.data[FIELD_SOURCES_KEY] = borrowed;
      keep.confidence = score(plan, idField, keep.data, b.relevance, b.failed);
      out.set(row.dedupe_key, keep);
      basis.set(row.dedupe_key, b);
    } else {
      out.set(row.dedupe_key, row);
      basis.set(row.dedupe_key, { relevance: r.relevance, failed: failed.length });
    }
  }

  const clean = rankRows(plan, [...out.values()]).slice(0, plan.max_results);
  const relaxed = clean.some((c) => Array.isArray(c.data[CHECKS_KEY]) && (c.data[CHECKS_KEY] as unknown[]).includes(false));
  return { clean, invalid, duplicates, reasons, relaxed };
}
