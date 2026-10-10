import { LLMError, LLMOutputError, llmJSON } from "../llm";
import type { RawItem, WorkflowPlan } from "../types";
import { focusText, hasKeyword, keywordTerms, planTerms } from "./focus";
import { identityField } from "./validate";
import { UNTRUSTED_RULE, untrusted } from "./untrusted";

export interface Extracted {
  data: Record<string, unknown>;
  item: RawItem;
  relevance: number; // 0..1
  why?: string; // one-line evidence for why the row matches the request
  checks?: (boolean | null)[]; // per plan.filters entry: met / violated / unknown
  quote?: string; // excerpt copied from the item as evidence
  quoteVerified?: boolean; // the excerpt really occurs in the item (checked in code, not by the model)
  method?: "keyword"; // built by the keyword fallback, not the AI
}

const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9$€£%.]+/g, " ").trim();

/** Everything the model was shown for an item, for verifying its quotes. */
const haystack = (it: RawItem) => squash(`${it.title}\n${it.text}\n${it.fields ? JSON.stringify(it.fields) : ""}`);

const STRUCTURED_TEXT = 400;
const PAGE_TEXT = 2500;
const PAGE_SOURCES = new Set<RawItem["source"]>(["web_search", "url_fetch", "wikipedia"]);
// Items per LLM call. Env override exists for quota-limited runs (eval --lite); read at call time.
const batchSize = () => Math.min(Math.max(Number(process.env.EXTRACT_BATCH) || 6, 1), 20);
// Two batches at a time: four in parallel tripped per-minute rate limits on free LLM tiers.
const CONCURRENCY = 2;

/** "published: 2026-09-18 (15 days ago)" so the model never has to do date arithmetic for recency checks. */
function published(it: RawItem) {
  const raw = it.published_at ?? (it.fields?.posted_at as string | number | undefined);
  if (raw == null || raw === "") return "";
  const d = new Date(typeof raw === "number" && raw < 1e12 ? raw * 1000 : raw);
  if (isNaN(d.getTime())) return "";
  const days = Math.floor((Date.now() - d.getTime()) / 86_400_000);
  return `\npublished: ${d.toISOString().slice(0, 10)} (${days <= 0 ? "today" : `${days} day${days === 1 ? "" : "s"} ago`})`;
}

function describeItem(i: number, it: RawItem, terms: string[]) {
  // Pages get the passages most relevant to the plan; API items already carry their facts in `fields`.
  const text = PAGE_SOURCES.has(it.source)
    ? focusText(it.text ?? "", terms, PAGE_TEXT)
    : (it.text?.slice(0, it.fields ? STRUCTURED_TEXT : PAGE_TEXT) ?? "");
  return `### ITEM ${i}\nsource: ${it.source}\nurl: ${it.url}${published(it)}\n${untrusted(
    `title: ${it.title}${it.fields ? `\nfields: ${JSON.stringify(it.fields).slice(0, 800)}` : ""}\ntext: ${text}`,
  )}`;
}

/** LLM extraction: turn raw items into rows matching the plan schema. */
async function llmBatch(plan: WorkflowPlan, items: RawItem[]): Promise<Extracted[] | null> {
  const schema = plan.fields.map((f) => `- ${f.name} (${f.type}${f.required ? ", required" : ""}): ${f.description}`).join("\n");
  const system = `You are the extraction agent of a data platform. Convert raw source items into structured rows.
Today's date: ${new Date().toISOString().slice(0, 10)}. For time-based constraints use each item's "published" age (e.g. "15 days ago" fails "last 7 days").
Target: each row is one "${plan.entity}". User intent: ${plan.intent}
Schema:
${schema}
Constraints:
${plan.filters.length ? plan.filters.map((c, i) => `${i + 1}. ${c}`).join("\n") : "none"}

Rules:
- ${UNTRUSTED_RULE}
- Only use facts present in the item; never invent values. Use null when unknown.
- A structured item (with fields) usually yields one row. A web page may contain several ${plan.entity}s (e.g. a list of sponsors) - emit one row per real entity found, max ${MAX_ROWS_PER_PAGE} per item (the most relevant ones).
- Skip items/rows that are irrelevant to the intent. Do NOT skip a row just because a constraint is unmet or not stated; report that in "checks" instead.
- Each row must BE a "${plan.entity}" matching the subject of the intent. Matching only the constraints (e.g. it mentions the right city or date) is NOT a match: an article, event or person that merely mentions the place is not a ${plan.entity}. Skip it, or give relevance 0.
- "relevance" 0-1 = how well the row matches the subject of the intent; constraints are judged separately in "checks".
- For url fields prefer the entity's own URL; otherwise the item url.
- Name/title fields must be specific and unique (e.g. "Girls (TV series)", not just "Girls").
- Drop rows about disambiguation pages, navigation pages, or generic words rather than real entities.
- "why" = one short sentence (max 25 words) citing the concrete evidence from the item that makes this row match the intent.
- "quote" = a short excerpt (10-35 words) copied EXACTLY, character for character, from the item that proves the row's key facts.
- "checks" = one entry per constraint, in order: true if the item shows it is met, false if it shows it is violated, null if the item doesn't say. Use [] when there are no constraints.
- Location constraints: a row located in a different city/state/country is false. A remote role counts as met only if the constraint itself allows remote AND the role is open to people in the named place (e.g. "Remote, Europe only" fails "India or remote").
Return {"rows": [{"item": <ITEM number>, "relevance": number, "why": string, "quote": string, "checks": [true|false|null], "data": {<schema fields>}}]}`;
  const res = await llmJSON<{ rows: ModelRow[] }>(system, items.map((it, i) => describeItem(i, it, planTerms(plan))).join("\n\n"), outputBudget(items));
  if (!res) return null;
  return toExtracted(res.rows ?? [], items);
}

type ModelRow = { item: number | string; relevance: number; why?: string; quote?: string; checks?: unknown[]; data: Record<string, unknown> };

const MAX_ROWS_PER_PAGE = 8;

/** Output room for a batch: about one row per structured item, up to MAX_ROWS_PER_PAGE rows (~220 tokens each) per page. */
const outputBudget = (items: RawItem[]) =>
  Math.min(12_000, Math.max(2500, 400 + items.reduce((n, it) => n + (PAGE_SOURCES.has(it.source) ? MAX_ROWS_PER_PAGE * 220 : 300), 0)));

// some models write the item number as a string ("0"); anything else that isn't a whole number is not an item
const itemIndex = (r: ModelRow): number => (typeof r.item === "string" ? (/^\d+$/.test(r.item) ? Number(r.item) : NaN) : r.item);

function toExtracted(rows: ModelRow[], items: RawItem[]): Extracted[] {
  return rows
    .filter((r) => r && r.data && Number.isInteger(itemIndex(r)) && items[itemIndex(r)])
    .map((r) => ({
      data: r.data,
      item: items[itemIndex(r)],
      relevance: clamp(r.relevance ?? 0.7),
      why: typeof r.why === "string" ? r.why : undefined,
      checks: Array.isArray(r.checks) ? r.checks.map((c) => (typeof c === "boolean" ? c : null)) : undefined,
      ...verifyQuote(r.quote, items[itemIndex(r)]),
    }));
}

/** Complete row objects from an answer that was cut off: every {...} that closed inside the "rows" array. */
export function salvageRows(text: string): ModelRow[] {
  const key = text.indexOf('"rows"');
  const start = key < 0 ? -1 : text.indexOf("[", key);
  if (start < 0) return [];
  const out: ModelRow[] = [];
  let depth = 0;
  let objStart = -1;
  let inString = false;
  let escaped = false;
  for (let i = start + 1; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
    } else if (ch === '"') inString = true;
    else if (ch === "{") {
      if (depth++ === 0) objStart = i;
    } else if (ch === "}") {
      if (--depth === 0) {
        try {
          out.push(JSON.parse(text.slice(objStart, i + 1)));
        } catch {
          // a malformed row: skip it, keep the rest
        }
      }
    } else if (ch === "]" && depth === 0) break;
  }
  return out;
}

/**
 * LLM rows for a batch, recovering from answers that were cut off or broken: the batch is retried once as two
 * halves, and a half that still fails keeps its complete rows. `missed` = items the answer never reached, for the
 * keyword fallback. Null when no LLM is configured.
 */
type Extraction = { rows: Extracted[]; missed: RawItem[]; error?: unknown };

async function llmExtract(plan: WorkflowPlan, items: RawItem[], notes: string[], retry = true): Promise<Extraction | null> {
  try {
    const rows = await llmBatch(plan, items);
    return rows && { rows, missed: [] };
  } catch (e) {
    if (!(e instanceof LLMOutputError)) throw e;
    const what = e.truncated ? "was cut off" : "wasn't valid JSON";
    if (retry && items.length > 1) {
      notes.push(`The AI answer for ${items.length} pages ${what}, so they were retried in two smaller batches`);
      const mid = Math.ceil(items.length / 2);
      // one half after the other, so a retry never adds to the number of calls in flight. A half that fails
      // (rate limit, outage) sends only its own pages to keywords and keeps the other half's rows; the error is
      // passed on so the run can still stop asking a provider that is out of quota.
      const half = async (part: RawItem[]): Promise<Extraction> =>
        llmExtract(plan, part, notes, false)
          .then((r) => r ?? { rows: [], missed: part })
          .catch((error) => ({ rows: [], missed: part, error }));
      const a = await half(items.slice(0, mid));
      const b = a.error ? { rows: [], missed: items.slice(mid), error: a.error } : await half(items.slice(mid));
      return { rows: [...a.rows, ...b.rows], missed: [...a.missed, ...b.missed], error: a.error ?? b.error };
    }
    const rows = toExtracted(salvageRows(e.partial), items);
    const reached = rows.reduce((n, r) => Math.max(n, items.indexOf(r.item)), -1);
    const missed = items.slice(reached + 1);
    notes.push(`The AI answer ${what}: kept ${rows.length} complete row${rows.length === 1 ? "" : "s"}, ${missed.length} page${missed.length === 1 ? "" : "s"} matched by keywords`);
    return { rows, missed };
  }
}

function verifyQuote(quote: unknown, it: RawItem): Pick<Extracted, "quote" | "quoteVerified"> {
  if (typeof quote !== "string" || quote.trim().length < 8) return {};
  const q = quote.replace(/\s+/g, " ").trim().slice(0, 300);
  return { quote: q, quoteVerified: haystack(it).includes(squash(q)) };
}

/** Heuristic evidence: the sentence of the item text that mentions the most keywords (verbatim by construction). */
function bestSentence(it: RawItem, kw: string[]): string | undefined {
  const sentences = `${it.title}. ${it.text ?? ""}`.split(/(?<=[.!?])\s+|\n+/).map((s) => s.trim()).filter((s) => s.length > 20 && s.length < 300);
  let best: string | undefined;
  let bestHits = 0;
  for (const s of sentences) {
    const l = s.toLowerCase();
    const hits = kw.filter((k) => l.includes(k)).length;
    if (hits > bestHits) [best, bestHits] = [s, hits];
  }
  return best;
}

const clamp = (n: number) => Math.max(0, Math.min(1, Number(n) || 0));

const SYNONYMS: Record<string, string[]> = {
  name: ["name", "title", "full_name", "company"],
  title: ["title", "name"],
  url: ["url", "apply_url", "homepage", "hn_url"],
  website: ["homepage", "url"],
  description: ["description", "summary", "snippet"],
  company: ["company", "company_name", "owner"],
  salary: ["salary", "salary_range", "compensation"],
  location: ["location", "candidate_required_location", "headquarters"],
  posted_at: ["posted_at", "published_at", "created_at", "updated_at"],
};

const words = (s: string) => s.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
const filled = (v: unknown) => v != null && v !== "" && !(Array.isArray(v) && !v.length);

/**
 * The item field that best fits a plan column. Planner names vary (job_title, repository_url, company_name), so
 * after exact names and synonyms, a source key must share the column's last word (the attribute: title, url,
 * name...); among those, the one sharing the most words wins. job_title → title, never job_type.
 */
function sourceKeyFor(column: string, src: Record<string, unknown>): string | undefined {
  const direct = [column, ...(SYNONYMS[column] ?? [])].find((k) => filled(src[k]));
  if (direct) return direct;
  const cw = words(column);
  const attr = cw[cw.length - 1];
  const tail = SYNONYMS[attr]?.find((k) => filled(src[k])); // e.g. hq_location → location synonyms
  if (tail) return tail;
  let best: { key: string; score: number } | undefined;
  for (const [key, v] of Object.entries(src)) {
    const kws = words(key);
    if (!filled(v) || !kws.includes(attr)) continue;
    // more shared words first; on a tie, a key made only of the column's words (name ⊂ repository_name)
    const score = kws.filter((w) => cw.includes(w)).length * 2 + (kws.every((w) => cw.includes(w)) ? 1 : 0);
    if (!best || score > best.score) best = { key, score };
  }
  return best?.key;
}

// A page whose title announces a list ("Top 50 IT companies", "List of unicorns") holds many entities; only the
// AI can pull them out, so without it the page itself must not become a row.
// Only real list shapes: "Top 50 …", "26 IT companies in India", "Top IT companies 2026", "List of …", "The ten largest
// …". Not names that merely contain the words (Top Hat, Best Buy, Twenty One Pilots), years or HN threads.
const LIST_NOUNS =
  "companies|startups|firms|brands|tools|apps|websites|sites|platforms|jobs|roles|coins|cryptocurrencies|tokens|databases|libraries|frameworks|repos|repositories|people|founders|ideas|examples|products|services|providers|vendors|agencies|universities|colleges|schools|cities|countries|books|games|movies";
const LIST_PAGE = new RegExp(
  [
    String.raw`\blist of\b`,
    String.raw`^\s*(lists?|rankings?)\b`,
    String.raw`\b(top|best|largest|biggest|leading)\s+\d{1,3}\b`,
    String.raw`^\s*(?!(?:19|20)\d{2}\b)\d{1,3}\s+(?:[\w.-]+\s+){0,3}(?:${LIST_NOUNS})\b`,
    String.raw`^\s*(?:the\s+)?(top|best|largest|biggest|leading)\s+(?:[\w.-]+\s+){0,3}(?:${LIST_NOUNS})\b`,
    String.raw`\b(ten|twenty|fifty|hundred)\s+(best|top|largest|biggest|leading)\b`,
  ].join("|"),
  "i",
);

/** Heuristic mapping when no LLM is available. */
function heuristicMap(plan: WorkflowPlan, it: RawItem, kw: string[]): Extracted {
  const src: Record<string, unknown> = { ...(it.fields ?? {}), title: it.fields?.title ?? it.title, url: it.fields?.url ?? it.url };
  const idField = identityField(plan);
  const data: Record<string, unknown> = {};
  for (const f of plan.fields) {
    const key = sourceKeyFor(f.name, src);
    let v: unknown = key ? src[key] : null;
    if (v == null && /description|summary/.test(f.name)) v = it.text?.slice(0, 280) || null;
    if (v == null && f.type === "url") v = it.url;
    // the naming column must never be empty, or validation drops the row as unnamed
    if (v == null && f.name === idField) v = it.title || null;
    data[f.name] = v;
  }
  const hay = `${it.title} ${it.text} ${JSON.stringify(it.fields ?? {})}`.toLowerCase();
  const matched = kw.filter((k) => hasKeyword(hay, k));
  // share of the request's keywords found; nothing matched → 0, below the validator's drop threshold
  const listPage = PAGE_SOURCES.has(it.source) && LIST_PAGE.test(it.title);
  return {
    data,
    item: it,
    relevance: listPage ? 0 : kw.length ? matched.length / kw.length : 0.5,
    why: matched.length ? `Mentions ${matched.map((k) => `"${k}"`).join(", ")} (keyword match)` : undefined,
    method: "keyword",
    // a sentence picked by keyword count is real text, but not evidence anyone checked: never "verified"
    ...(() => {
      const quote = bestSentence(it, kw);
      return quote ? { quote, quoteVerified: false } : {};
    })(),
  };
}

export async function extractAll(
  plan: WorkflowPlan,
  items: RawItem[],
  onProgress: (done: number, total: number, note?: string, rowsSoFar?: Extracted[]) => Promise<void>,
): Promise<{ rows: Extracted[]; mode: "llm" | "heuristic" | "mixed"; keywordItems: number }> {
  const batches: RawItem[][] = [];
  const BATCH = batchSize();
  for (let i = 0; i < items.length; i += BATCH) batches.push(items.slice(i, i + BATCH));
  const kw = keywordTerms(plan);

  const rows: Extracted[] = [];
  let llmAvailable = true;
  let keywordItems = 0; // items that went to the keyword fallback, for the run's extraction mode
  let done = 0;
  let idx = 0;
  let stopped = false; // set when onProgress throws (e.g. the user cancelled): no new LLM calls start after that
  const worker = async () => {
    while (idx < batches.length && !stopped) {
      const batch = batches[idx++];
      let out: Extracted[] | null = null;
      if (llmAvailable) {
        const notes: string[] = [];
        let failure: unknown;
        try {
          const res = await llmExtract(plan, batch, notes);
          if (res === null) llmAvailable = false;
          else {
            out = [...res.rows, ...res.missed.map((it) => heuristicMap(plan, it, kw))];
            keywordItems += res.missed.length;
            failure = res.error;
          }
        } catch (e) {
          failure = e;
        }
        if (failure) {
          const e = failure;
          const msg = (e as Error).message;
          // llmJSON already tried every provider: on a rate limit, empty balance or bad key, stop asking for
          // the rest of this run instead of failing the same way on every remaining batch
          const quotaHit = e instanceof LLMError && [401, 402, 403, 429].includes(e.status ?? 0);
          const note = quotaHit
            ? llmAvailable && `AI limit reached on every provider (${msg.slice(0, 120)}), so the remaining pages are matched by keywords`
            : `LLM batch failed (${msg.slice(0, 120)}), using heuristic mapping`;
          if (quotaHit) llmAvailable = false;
          if (note) notes.push(note);
        }
        for (const note of notes)
          await onProgress(done, batches.length, note).catch((err) => {
            stopped = true;
            throw err;
          });
      }
      if (!out) keywordItems += batch.length;
      rows.push(...(out ?? batch.map((it) => heuristicMap(plan, it, kw))));
      done++;
      try {
        await onProgress(done, batches.length, undefined, rows);
      } catch (e) {
        stopped = true;
        throw e;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, batches.length) }, worker));
  const mode = keywordItems === 0 ? "llm" : keywordItems >= items.length ? "heuristic" : "mixed";
  return { rows, mode, keywordItems };
}
