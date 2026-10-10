import { LLMError, llmJSON } from "../llm";
import type { RawItem, WorkflowPlan } from "../types";
import { focusText, planTerms } from "./focus";
import { UNTRUSTED_RULE, untrusted } from "./untrusted";

export interface Extracted {
  data: Record<string, unknown>;
  item: RawItem;
  relevance: number; // 0..1
  why?: string; // one-line evidence for why the row matches the request
  checks?: (boolean | null)[]; // per plan.filters entry: met / violated / unknown
  quote?: string; // excerpt copied from the item as evidence
  quoteVerified?: boolean; // the excerpt really occurs in the item (checked in code, not by the model)
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
- A structured item (with fields) usually yields one row. A web page may contain several ${plan.entity}s (e.g. a list of sponsors) - emit one row per real entity found, max 15 per item.
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
  const res = await llmJSON<{
    rows: { item: number; relevance: number; why?: string; quote?: string; checks?: unknown[]; data: Record<string, unknown> }[];
  }>(
    system,
    items.map((it, i) => describeItem(i, it, planTerms(plan))).join("\n\n"),
    Math.max(2500, items.length * 450), // room for every row's fields, why, quote and checks
  );
  if (!res) return null;
  return (res.rows ?? [])
    .filter((r) => r && r.data && items[r.item])
    .map((r) => ({
      data: r.data,
      item: items[r.item],
      relevance: clamp(r.relevance ?? 0.7),
      why: typeof r.why === "string" ? r.why : undefined,
      checks: Array.isArray(r.checks) ? r.checks.map((c) => (typeof c === "boolean" ? c : null)) : undefined,
      ...verifyQuote(r.quote, items[r.item]),
    }));
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
  description: ["description", "summary"],
  company: ["company", "company_name", "owner"],
};

/** Heuristic mapping when no LLM is available. */
function heuristicMap(plan: WorkflowPlan, it: RawItem, kw: string[]): Extracted {
  const src = { ...(it.fields ?? {}), title: it.fields?.title ?? it.title, url: it.fields?.url ?? it.url };
  const data: Record<string, unknown> = {};
  for (const f of plan.fields) {
    const keys = [f.name, ...(SYNONYMS[f.name] ?? [])];
    let v: unknown = null;
    for (const k of keys) if (src[k as keyof typeof src] != null && src[k as keyof typeof src] !== "") { v = src[k as keyof typeof src]; break; }
    if (v == null && f.name === "description") v = it.text?.slice(0, 280) || null;
    if (v == null && f.type === "url") v = it.url;
    data[f.name] = v;
  }
  const hay = `${it.title} ${it.text} ${JSON.stringify(it.fields ?? {})}`.toLowerCase();
  const matched = kw.filter((k) => hay.includes(k));
  return {
    data,
    item: it,
    relevance: kw.length ? 0.4 + 0.6 * (matched.length / kw.length) : 0.6,
    why: matched.length ? `Mentions ${matched.map((k) => `"${k}"`).join(", ")} (keyword match)` : undefined,
    ...(() => {
      const quote = bestSentence(it, kw);
      return quote ? { quote, quoteVerified: true } : {};
    })(),
  };
}

export async function extractAll(
  plan: WorkflowPlan,
  items: RawItem[],
  onProgress: (done: number, total: number, note?: string, rowsSoFar?: Extracted[]) => Promise<void>,
): Promise<{ rows: Extracted[]; mode: "llm" | "heuristic" | "mixed" }> {
  const batches: RawItem[][] = [];
  const BATCH = batchSize();
  for (let i = 0; i < items.length; i += BATCH) batches.push(items.slice(i, i + BATCH));
  const kw = plan.intent.toLowerCase().split(/\W+/).filter((w) => w.length > 3).slice(0, 8);

  const rows: Extracted[] = [];
  let llmAvailable = true;
  let llmBatches = 0;
  let done = 0;
  let idx = 0;
  let stopped = false; // set when onProgress throws (e.g. the user cancelled): no new LLM calls start after that
  const worker = async () => {
    while (idx < batches.length && !stopped) {
      const batch = batches[idx++];
      let out: Extracted[] | null = null;
      if (llmAvailable) {
        try {
          out = await llmBatch(plan, batch);
          if (out === null) llmAvailable = false;
          else llmBatches++;
        } catch (e) {
          const msg = (e as Error).message;
          // llmJSON already tried every provider: on a rate limit, empty balance or bad key, stop asking for
          // the rest of this run instead of failing the same way on every remaining batch
          const quotaHit = e instanceof LLMError && [401, 402, 403, 429].includes(e.status ?? 0);
          const note = quotaHit
            ? llmAvailable && `AI limit reached on every provider (${msg.slice(0, 120)}), so the remaining pages are matched by keywords`
            : `LLM batch failed (${msg.slice(0, 120)}), using heuristic mapping`;
          if (quotaHit) llmAvailable = false;
          if (note)
            await onProgress(done, batches.length, note).catch((err) => {
              stopped = true;
              throw err;
            });
        }
      }
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
  const mode = llmBatches === batches.length ? "llm" : llmBatches === 0 ? "heuristic" : "mixed";
  return { rows, mode };
}
