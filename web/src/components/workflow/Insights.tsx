"use client";

import { useMemo } from "react";
import { BarChart3 } from "lucide-react";
import type { DataRecord, FieldSpec } from "@/lib/types";
import { connectorLabel, humanize } from "@/components/utils";
import { checksOf } from "./Match";

// Auto-generated charts for any dataset. Every chart is a single-hue magnitude view
// (horizontal bars or a histogram), so identity never depends on color.

type Bar = { label: string; value: number; hint?: string; rest?: boolean };

const fmt = (n: number) =>
  Math.abs(n) >= 1e9 ? `${(n / 1e9).toFixed(1)}B` : Math.abs(n) >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : Math.abs(n) >= 1e4 ? `${(n / 1e3).toFixed(0)}k` : n.toLocaleString(undefined, { maximumFractionDigits: 2 });

function topCounts(values: string[], max = 6): Bar[] {
  const m = new Map<string, number>();
  for (const v of values) m.set(v, (m.get(v) ?? 0) + 1);
  const sorted = [...m.entries()].sort((a, b) => b[1] - a[1]);
  const bars: Bar[] = sorted.slice(0, max).map(([label, value]) => ({ label, value }));
  const rest = sorted.slice(max).reduce((s, [, v]) => s + v, 0);
  if (rest) bars.push({ label: `Other (${sorted.length - max})`, value: rest, rest: true });
  return bars;
}

/** Parse "$90k - $105k", "120000", "€60,000" into a number (midpoint of a range). */
function toNumber(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v !== "string") return null;
  const nums = [...v.replace(/,/g, "").matchAll(/(\d+(?:\.\d+)?)\s*([kKmM])?/g)].map(
    (m) => Number(m[1]) * (m[2]?.toLowerCase() === "k" ? 1e3 : m[2]?.toLowerCase() === "m" ? 1e6 : 1),
  );
  if (!nums.length) return null;
  return nums.length >= 2 ? (nums[0] + nums[1]) / 2 : nums[0];
}

function histogram(nums: number[], bins = 6): Bar[] {
  const min = Math.min(...nums);
  const max = Math.max(...nums);
  if (min === max) return [{ label: fmt(min), value: nums.length }];
  const step = (max - min) / bins;
  const counts = Array(bins).fill(0);
  for (const n of nums) counts[Math.min(bins - 1, Math.floor((n - min) / step))]++;
  return counts.map((value, i) => ({ label: `${fmt(min + i * step)}–${fmt(min + (i + 1) * step)}`, value }));
}

export function Insights({ records, fields, criteria = [] }: { records: DataRecord[]; fields: FieldSpec[] | undefined; criteria?: string[] }) {
  const data = useMemo(() => {
    const fs = fields ?? [];
    const n = records.length;
    const avgConf = n ? records.reduce((s, r) => s + (r.confidence <= 1 ? r.confidence * 100 : r.confidence), 0) / n : 0;
    const withChecks = records.filter((r) => checksOf(r).length);
    const allMet = withChecks.filter((r) => checksOf(r).every((c) => c === true)).length;

    const charts: { title: string; sub?: string; bars: Bar[]; kind: "rank" | "dist" }[] = [];
    charts.push({ title: "Rows per source", bars: topCounts(records.map((r) => connectorLabel(r.source_name))), kind: "rank" });
    charts.push({
      title: "Match score",
      sub: "rows per match-score band",
      kind: "dist",
      bars: [
        ["< 50%", 0, 50],
        ["50–75%", 50, 75],
        ["75–90%", 75, 90],
        ["90%+", 90, 101],
      ].map(([label, lo, hi]) => ({
        label: label as string,
        value: records.filter((r) => {
          const c = r.confidence <= 1 ? r.confidence * 100 : r.confidence;
          return c >= (lo as number) && c < (hi as number);
        }).length,
      })),
    });
    if (criteria.length && withChecks.length)
      charts.push({
        title: "Criteria met (AI-judged)",
        sub: `the AI's reading of each condition (of ${withChecks.length})`,
        kind: "rank",
        bars: criteria.map((c, i) => ({
          label: c,
          value: withChecks.filter((r) => checksOf(r)[i] === true).length,
          hint: `${withChecks.filter((r) => checksOf(r)[i] === null).length} not stated in source`,
        })),
      });

    for (const f of fs) {
      const vals = records.map((r) => r.data[f.name]).filter((v) => v != null && v !== "");
      if (vals.length < 3 || f.type === "url" || f.type === "email") continue;
      if (f.type === "list") {
        const flat = vals.flatMap((v) => (Array.isArray(v) ? v : String(v).split(/,\s*/))).map((x) => String(x).trim().toLowerCase()).filter(Boolean);
        if (flat.length) charts.push({ title: `Top ${humanize(f.name).toLowerCase()}`, bars: topCounts(flat, 8), kind: "rank" });
        continue;
      }
      const nums = vals.map(toNumber).filter((x): x is number => x !== null);
      if ((f.type === "number" || /salary|price|revenue|stars|cap|volume|points|count/i.test(f.name)) && nums.length >= Math.max(3, vals.length * 0.6)) {
        const sorted = [...nums].sort((a, b) => a - b);
        const median = sorted[Math.floor(sorted.length / 2)];
        charts.push({ title: humanize(f.name), sub: `median ${fmt(median)} · range ${fmt(sorted[0])}–${fmt(sorted.at(-1)!)}`, bars: histogram(nums), kind: "dist" });
        continue;
      }
      if (f.type === "string") {
        const strs = vals.map((v) => String(v).trim());
        const distinct = new Set(strs.map((s) => s.toLowerCase())).size;
        // Only fields that group rows (company, location, category...), not free text or unique names.
        if (distinct < strs.length * 0.8 && strs.every((s) => s.length <= 60))
          charts.push({ title: `Top ${humanize(f.name).toLowerCase()}`, bars: topCounts(strs), kind: "rank" });
      }
    }
    return { n, avgConf, withChecks: withChecks.length, allMet, sources: new Set(records.map((r) => r.source_name)).size, charts };
  }, [records, fields, criteria]);

  if (!records.length)
    return (
      <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-white/10 py-16 text-center">
        <BarChart3 className="h-7 w-7 text-zinc-600" />
        <p className="mt-3 text-sm text-zinc-300">No insights yet</p>
        <p className="mt-1 text-xs text-zinc-500">Charts appear as soon as records are collected.</p>
      </div>
    );

  return (
    <div>
      <div className="glass grid grid-cols-2 overflow-hidden rounded-lg md:grid-cols-4">
        <Tile label="Rows" value={data.n.toLocaleString()} />
        <Tile label="Avg. match score" value={`${Math.round(data.avgConf)}%`} hint="Heuristic score: relevance + filled columns. Not a probability." />
        <Tile
          label="All criteria met (AI-judged)"
          value={data.withChecks ? `${Math.round((data.allMet / data.withChecks) * 100)}%` : "—"}
          sub={data.withChecks ? `${data.allMet} of ${data.withChecks} rows` : "no criteria in request"}
        />
        <Tile label="Sources used" value={String(data.sources)} />
      </div>
      <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
        {data.charts.map((c) => (
          <BarChart key={c.title} {...c} />
        ))}
      </div>
    </div>
  );
}

function Tile({ label, value, sub, hint }: { label: string; value: string; sub?: string; hint?: string }) {
  return (
    <div className="border-line px-4 py-3 [&:not(:last-child)]:border-r">
      <div className="text-[11.5px] text-zinc-500" title={hint}>{label}</div>
      <div className="mt-1 text-[22px] font-semibold tabular-nums text-zinc-100">{value}</div>
      {sub && <div className="text-[11px] text-zinc-600">{sub}</div>}
    </div>
  );
}

function BarChart({ title, sub, bars, kind }: { title: string; sub?: string; bars: Bar[]; kind: "rank" | "dist" }) {
  // "Other" lumps many values together; scaling to it would flatten the real bars.
  const max = Math.max(1, ...bars.filter((b) => !b.rest).map((b) => b.value));
  const total = bars.reduce((s, b) => s + b.value, 0) || 1;
  return (
    <figure className="glass rounded-lg p-4">
      <figcaption>
        <div className="text-[13px] font-medium text-zinc-200">{title}</div>
        {sub && <div className="mt-0.5 text-[11.5px] text-zinc-500">{sub}</div>}
      </figcaption>
      {kind === "rank" ? (
        <ul className="mt-3 space-y-1.5">
          {bars.map((b) => (
            <li
              key={b.label}
              className="group grid grid-cols-[minmax(0,9rem)_1fr_2.5rem] items-center gap-2 rounded px-1 py-0.5 hover:bg-white/[0.03]"
              title={`${b.label}: ${b.value} rows (${Math.round((b.value / total) * 100)}%)${b.hint ? ` · ${b.hint}` : ""}`}
            >
              <span className="truncate text-[12px] text-zinc-400 group-hover:text-zinc-200">{b.label}</span>
              <span className="h-2.5 overflow-hidden rounded-sm bg-white/[0.04]">
                <span
                  className={`bar-grow block h-full rounded-r-[4px] group-hover:bg-accent-soft ${b.rest ? "bg-zinc-600" : "bg-accent/80"}`}
                  style={{ width: `${Math.min(100, (b.value / max) * 100)}%` }}
                />
              </span>
              <span className="text-right text-[11.5px] tabular-nums text-zinc-400">{b.value}</span>
            </li>
          ))}
        </ul>
      ) : (
        <div className="mt-3">
          <div className="flex h-28 items-end gap-[2px] border-b border-line">
            {bars.map((b) => (
              <div key={b.label} className="group flex h-full flex-1 flex-col justify-end" title={`${b.label}: ${b.value} rows`}>
                <span className="mb-1 text-center text-[10.5px] tabular-nums text-zinc-500 opacity-0 transition group-hover:opacity-100">{b.value}</span>
                <span
                  className="bar-rise block rounded-t-[4px] bg-accent/80 group-hover:bg-accent-soft"
                  style={{ height: `${(b.value / max) * 80}%`, minHeight: b.value ? 2 : 0 }}
                />
              </div>
            ))}
          </div>
          <div className="mt-1.5 flex gap-[2px]">
            {bars.map((b) => (
              <span key={b.label} className="flex-1 truncate text-center text-[10px] text-zinc-500" title={b.label}>
                {b.label}
              </span>
            ))}
          </div>
        </div>
      )}
    </figure>
  );
}
