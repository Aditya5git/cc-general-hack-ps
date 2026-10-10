import type { WorkflowPlan } from "../types";

// Query-focused trimming (the idea behind crawl4ai's "fit markdown"): instead of sending the
// first N characters of a page (usually menus and intro), keep the passages that best match
// what the plan is looking for, in their original order.

const STOP = new Set(
  "the a an and or of in on for to with from by at as is are be was were that this these those it its into about over under than then what which who whom whose where when how all any each some such more most other only own same so very can will just must should may might not no nor too also has have had do does did per via e.g i.e etc"
    .split(" "),
);

// Words that say how much or how good, not what: they match almost any page, so keyword scoring ignores them.
const FILLER = new Set(
  "largest biggest top best leading list lists info information details data latest recent new popular famous good great various several many".split(" "),
);

/** The words that say what the user is after (intent + entity), for keyword matching when no LLM is available. */
export function keywordTerms(plan: WorkflowPlan): string[] {
  const words = `${plan.intent} ${plan.entity}`.toLowerCase().match(/[a-z0-9+#]{2,}/g) ?? [];
  return [...new Set(words.filter((w) => !STOP.has(w) && !FILLER.has(w)))].slice(0, 8);
}

const PASSAGE_CHARS = 320;

export function planTerms(plan: WorkflowPlan): string[] {
  const text = [plan.intent, plan.entity, ...plan.filters, ...plan.fields.map((f) => f.name.replace(/_/g, " "))].join(" ");
  const words = text.toLowerCase().match(/[a-z0-9+#.]{3,}/g) ?? [];
  return [...new Set(words.map((w) => w.replace(/\.+$/, "")).filter((w) => w.length > 2 && !STOP.has(w)))].slice(0, 30);
}

/** Group lines into ~PASSAGE_CHARS chunks without splitting a line. */
function passages(text: string): string[] {
  const out: string[] = [];
  let cur = "";
  for (const line of text.split(/\n+/)) {
    if (cur && cur.length + line.length > PASSAGE_CHARS) {
      out.push(cur);
      cur = "";
    }
    cur = cur ? `${cur}\n${line}` : line;
  }
  if (cur) out.push(cur);
  return out;
}

function score(p: string, terms: string[]): number {
  const s = p.toLowerCase();
  let distinct = 0;
  let hits = 0;
  for (const t of terms) {
    let i = s.indexOf(t);
    if (i < 0) continue;
    distinct++;
    while (i >= 0 && hits < 50) {
      hits++;
      i = s.indexOf(t, i + t.length);
    }
  }
  // Lists of short lines (names, links, table rows) are where entities usually live.
  const lines = p.split("\n").length;
  const listy = lines >= 4 ? 1 : 0;
  // Breadth of matched terms matters more than repeating one word.
  return distinct * 3 + Math.min(hits, 12) + listy;
}

/** Trim `text` to about `budget` chars, keeping the opening passage plus the best-matching ones. */
export function focusText(text: string, terms: string[], budget: number): string {
  if (text.length <= budget || !terms.length) return text.slice(0, budget);
  const ps = passages(text);
  const keep = new Set<number>([0]);
  let used = ps[0].length;
  const ranked = ps
    .map((p, i) => ({ i, s: score(p, terms) }))
    .filter((x) => x.i > 0 && x.s > 0)
    .sort((a, b) => b.s - a.s || a.i - b.i);
  for (const { i } of ranked) {
    if (used + ps[i].length + 2 > budget) continue;
    keep.add(i);
    used += ps[i].length + 2;
  }
  // Nothing matched beyond the intro: fall back to the plain prefix.
  if (keep.size === 1) return text.slice(0, budget);
  let out = "";
  let prev = -1;
  for (const i of [...keep].sort((a, b) => a - b)) {
    out += (out ? (i === prev + 1 ? "\n" : "\n…\n") : "") + ps[i];
    prev = i;
  }
  return out.slice(0, budget);
}
