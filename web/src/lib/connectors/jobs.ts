import type { ConnectorResult, RawItem } from "../types";
import { clip, fetchJson, htmlToText, queryWords } from "./http";

/** Rank items by how many query words appear in their haystack; drop zero-score items if query has words. */
function rankByQuery<T>(items: T[], query: string, hay: (t: T) => string): T[] {
  const words = queryWords(query);
  if (!words.length) return items;
  const scored = items
    .map((it, i) => {
      const h = hay(it).toLowerCase();
      const score = words.reduce((s, w) => s + (h.includes(w) ? 1 : 0), 0);
      return { it, score, i };
    })
    .filter((x) => x.score > 0);
  scored.sort((a, b) => b.score - a.score || a.i - b.i);
  return scored.map((x) => x.it);
}

// Seniority and role words appear in most postings, so they can't be the only reason a job matches.
const GENERIC = new Set(["senior", "junior", "mid", "lead", "staff", "principal", "head", "engineer", "engineering", "developer", "development", "manager", "specialist", "intern", "software", "full", "time", "part", "contract", "freelance"]);

/**
 * Keep jobs that mention at least half the query words, best first (all words, title hits count most). Tags and
 * descriptions are weak on their own: boards tag freely (a "Quality Dispense Technician" tagged golang) and
 * descriptions list whole stacks. So a job also needs a specific word (not "senior", "engineer"...) in its title,
 * or in both its tags and description.
 */
function matchJobs<T>(items: T[], query: string, parts: (t: T) => { title: string; tags: string; text?: string }): T[] {
  const words = queryWords(query);
  if (!words.length) return items;
  const specific = words.some((w) => !GENERIC.has(w)) ? words.filter((w) => !GENERIC.has(w)) : words;
  const squash = (s: string) => s.replace(/[-\s]+/g, "");
  // "front-end" / "front end" match "frontend"; only for longer words, where joining can't fake a match
  // short words match whole words only: "ai" mustn't hit "maintenance", nor "go" hit "google"
  const short = new Map(words.filter((w) => w.length <= 3).map((w) => [w, new RegExp(`(^|[^a-z0-9])${w.replace(/[+#.]/g, "\\$&")}(?![a-z0-9])`)]));
  const has = (hay: string, w: string) => short.get(w)?.test(hay) ?? (hay.includes(w) || (w.length >= 5 && squash(hay).includes(w)));
  const scored = items.map((it, i) => {
    const p = parts(it);
    const [title, tags, text] = [p.title.toLowerCase(), p.tags.toLowerCase(), (p.text ?? "").toLowerCase()];
    let found = 0;
    let strong = false;
    let score = 0;
    for (const w of words) {
      const [inTitle, inTags, inText] = [has(title, w), has(tags, w), has(text, w)];
      if (inTitle || inTags || inText) found++;
      if (specific.includes(w) && (inTitle || (inTags && inText))) strong = true;
      score += (inTitle ? 3 : 0) + (inTags ? 1 : 0) + (inText ? 1 : 0);
    }
    return { it, i, found, strong, score };
  });
  const need = Math.ceil(words.length / 2);
  return scored
    .filter((x) => x.strong && x.found >= need)
    .sort((a, b) => b.found - a.found || b.score - a.score || a.i - b.i)
    .map((x) => x.it);
}

// Pay in English and German (Arbeitnow): a salary-sized amount (3+ digits or "90k") next to a currency or pay word.
const MONEY = /[$€£₹]\s?\d|\d\s?[$€£₹]|\b(usd|eur|gbp|chf|inr)\s?\d|\d\s?(usd|eur|gbp|chf|inr)\b/i;
const AMOUNT = /(\d[\d,.\s]*\d\d|\d{2,3}\s?k\b|\d{1,3}(\.\d+)?\s?(lpa|lakhs?|lacs?)\b)(?!\s?%)/i; // "100%" is not an amount; "12 LPA" is
const PAY_WORD = /\b(salary|salaries|compensation|pay|wage|stipend|ctc|lpa|lakhs?|gehalt|vergütung|bezahlung)\b|per (year|annum|month|hour)|\/\s?(yr|year|month|hr|hour)\b/i;
// Money that isn't the job's pay: funding, market size, product prices, perks
const NOT_PAY = /\d\s?[mb]\b|million|billion|\b(raised|funding|valuation|revenue|market|series [a-e]|investors?|paid out|start for|price|allowance|voucher|gutschein|ticket|coupon|discount|holiday|vacation|urlaub|coworking|401\s?\(?k\)?)/i;

/**
 * Job APIs often leave salary empty and state it deep in the description, but extraction only reads the start of
 * an API item's text. Put the sentences that state pay at the front so the AI sees them.
 */
function payFirst(text: string): string {
  const pay = text
    .split(/[.!?]\s+|\n+|\\n/) // some feeds keep "\n" as literal text
    .map((s) => s.trim())
    .filter((s) => s.length > 8 && s.length < 300 && AMOUNT.test(s) && (MONEY.test(s) || PAY_WORD.test(s)) && !NOT_PAY.test(s))
    .slice(0, 3);
  return pay.length ? `Pay mentioned: ${pay.join(" … ")}`.slice(0, 350) + `\n\n${text}` : text;
}

// ---------------- Remotive ----------------
interface RemotiveJob {
  id: number;
  url: string;
  title: string;
  company_name: string;
  category?: string;
  tags?: string[];
  job_type?: string;
  publication_date?: string;
  candidate_required_location?: string;
  salary?: string;
  description?: string;
}

export async function remotiveJobs(query: string, limit: number): Promise<ConnectorResult> {
  const q = query.trim();
  const url = `https://remotive.com/api/remote-jobs?${q ? `search=${encodeURIComponent(q)}&` : ""}limit=${Math.max(limit * 2, 20)}`;
  const data = await fetchJson<{ jobs?: RemotiveJob[] }>(url);
  let jobs = data.jobs ?? [];
  // Remotive's search is phrase-ish; if nothing, retry with the first keyword.
  if (!jobs.length && queryWords(q).length > 1) {
    const kw = queryWords(q)[0];
    const d2 = await fetchJson<{ jobs?: RemotiveJob[] }>(
      `https://remotive.com/api/remote-jobs?search=${encodeURIComponent(kw)}&limit=${Math.max(limit * 3, 30)}`,
    );
    jobs = d2.jobs ?? [];
  }
  // Remotive's search also returns jobs that don't mention the query anywhere; drop those instead of padding with them
  const desc = new Map(jobs.map((j) => [j, htmlToText(j.description)]));
  jobs = matchJobs(jobs, q, (j) => ({ title: j.title, tags: `${(j.tags ?? []).join(" ")} ${j.category ?? ""}`, text: desc.get(j) }));
  const items: RawItem[] = jobs.slice(0, limit).map((j) => {
    const text = desc.get(j) ?? "";
    const fields = {
      title: j.title,
      company: j.company_name,
      location: j.candidate_required_location ?? null,
      salary: j.salary || null,
      job_type: j.job_type ?? null,
      tags: j.tags ?? [],
      category: j.category ?? null,
      posted_at: j.publication_date ?? null,
      apply_url: j.url,
    };
    return {
      source: "remotive_jobs",
      url: j.url,
      title: `${j.title} — ${j.company_name}`,
      text: clip(j.salary ? text : payFirst(text), 4000),
      fields,
      published_at: j.publication_date,
    };
  });
  return { items, url };
}

// ---------------- Arbeitnow ----------------
interface ArbeitnowJob {
  slug: string;
  company_name: string;
  title: string;
  description: string;
  remote: boolean;
  url: string;
  tags: string[];
  job_types: string[];
  location: string;
  created_at: number;
}

export async function arbeitnowJobs(query: string, limit: number): Promise<ConnectorResult> {
  const base = "https://www.arbeitnow.com/api/job-board-api";
  const all: ArbeitnowJob[] = [];
  // Pull a few pages so client-side filtering has something to chew on.
  for (let page = 1; page <= 3; page++) {
    const d = await fetchJson<{ data?: ArbeitnowJob[] }>(`${base}?page=${page}`).catch((e) => {
      if (page === 1) throw e;
      return { data: [] as ArbeitnowJob[] };
    });
    const batch = d.data ?? [];
    all.push(...batch);
    if (!batch.length) break;
    const matched = rankByQuery(all, query, (j) => `${j.title} ${j.company_name} ${j.tags.join(" ")} ${j.location}`);
    if (matched.length >= limit) break;
  }
  const ranked = rankByQuery(all, query, (j) => `${j.title} ${j.company_name} ${j.tags.join(" ")} ${j.location} ${j.remote ? "remote" : ""}`);
  const items: RawItem[] = ranked.slice(0, limit).map((j) => {
    const posted = j.created_at ? new Date(j.created_at * 1000).toISOString() : undefined;
    return {
      source: "arbeitnow_jobs",
      url: j.url,
      title: `${j.title} — ${j.company_name}`,
      text: clip(payFirst(htmlToText(j.description)), 4000), // Arbeitnow has no salary field
      fields: {
        title: j.title,
        company: j.company_name,
        location: j.location || null,
        remote: j.remote,
        salary: null,
        job_type: (j.job_types ?? []).join(", ") || null,
        tags: j.tags ?? [],
        posted_at: posted ?? null,
        apply_url: j.url,
      },
      published_at: posted,
    };
  });
  return { items, url: base };
}

// ---------------- RemoteOK ----------------
interface RemoteOkJob {
  id?: string;
  slug?: string;
  epoch?: number;
  date?: string;
  company?: string;
  position?: string;
  tags?: string[];
  description?: string;
  location?: string;
  salary_min?: number;
  salary_max?: number;
  apply_url?: string;
  url?: string;
  legal?: string;
}

export async function remoteokJobs(query: string, limit: number): Promise<ConnectorResult> {
  const url = "https://remoteok.com/api";
  const data = await fetchJson<RemoteOkJob[]>(url);
  const jobs = (Array.isArray(data) ? data : []).filter((j) => !j.legal && j.position);
  // any single word used to be enough ("senior" kept a Senior Accountant); now every word, title or description first
  const desc = new Map(jobs.map((j) => [j, htmlToText(j.description)]));
  const ranked = matchJobs(jobs, query, (j) => ({
    title: j.position ?? "",
    tags: `${(j.tags ?? []).join(" ")} ${j.company ?? ""} ${j.location ?? ""}`,
    text: desc.get(j),
  }));
  const items: RawItem[] = ranked.slice(0, limit).map((j) => {
    const pageUrl = j.url || `https://remoteok.com/remote-jobs/${j.slug ?? j.id}`;
    const salary =
      j.salary_min || j.salary_max
        ? `$${j.salary_min ?? "?"} - $${j.salary_max ?? "?"}`
        : null;
    return {
      source: "remoteok_jobs",
      url: pageUrl,
      title: `${j.position} — ${j.company}`,
      text: clip(salary ? (desc.get(j) ?? "") : payFirst(desc.get(j) ?? ""), 4000),
      fields: {
        title: j.position,
        company: j.company,
        location: j.location || null,
        salary,
        job_type: null,
        tags: j.tags ?? [],
        posted_at: j.date ?? null,
        apply_url: j.apply_url || pageUrl,
      },
      published_at: j.date,
    };
  });
  return { items, url };
}
