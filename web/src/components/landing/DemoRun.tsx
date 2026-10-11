"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { BadgeCheck, Check } from "lucide-react";
import { StatusIcon } from "@/components/StatusBadge";

function subscribeReducedMotion(cb: () => void) {
  const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
  mq.addEventListener("change", cb);
  return () => mq.removeEventListener("change", cb);
}
export const useReducedMotion = () =>
  useSyncExternalStore(subscribeReducedMotion, () => window.matchMedia("(prefers-reduced-motion: reduce)").matches, () => false);

// ---------- Animated sample run (static data, loops; final frame when motion is reduced) ----------

const DEMO_PROMPT = "Remote React jobs with salary info";
const DEMO_AGENTS = [
  { label: "Planner", detail: "4 columns" },
  { label: "Remotive", detail: "16 items" },
  { label: "Arbeitnow", detail: "14 items" },
  { label: "RemoteOK", detail: "7 items" },
  { label: "Extractor", detail: "37 rows" },
  { label: "Validator", detail: "2 merged" },
];
const DEMO_ROWS = [
  ["Frontend Web Application Developer", "KoboToolbox", "$90k – $105k", "remotive.com"],
  ["Senior React Developer", "Sanctuary Computer", "$80k – $150k", "remotive.com"],
  ["Senior Frontend Engineer", "Hotjar", "$70k – $85k", "remoteok.com"],
  ["React Native Developer", "Toggl", "$75k – $95k", "arbeitnow.com"],
  ["Full-stack Engineer (React/Node)", "Close", "$120k – $160k", "remoteok.com"],
];
const LAST_TICK = 15;

export function DemoRun() {
  const reduced = useReducedMotion();
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (reduced) return;
    const t = setInterval(() => setTick((x) => (x + 1) % (LAST_TICK + 1)), 700);
    return () => clearInterval(t);
  }, [reduced]);
  const t = reduced ? LAST_TICK - 1 : tick;
  const typed = DEMO_PROMPT.slice(0, Math.min(DEMO_PROMPT.length, t * 9));
  const agent = t - 3; // agents start after the prompt is typed
  const rows = Math.max(0, Math.min(DEMO_ROWS.length, t - 7));

  return (
    <div>
      <div className="flex items-center gap-2 border-b border-line px-4 py-2.5 text-[13px]">
        <span className="text-zinc-600" aria-hidden>
          ›
        </span>
        <span className="text-zinc-200">{typed}</span>
        {t < 3 && <span className="animate-caret -ml-1 h-4 w-px bg-zinc-300" aria-hidden />}
      </div>

      {/* mini mission control */}
      <ol className="flex gap-1.5 overflow-x-auto border-b border-line px-4 py-3" aria-label="Agents">
        {DEMO_AGENTS.map((a, i) => {
          const state = agent > i ? "completed" : agent === i ? "processing" : "queued";
          return (
            <li
              key={a.label}
              className={`flex min-w-[118px] flex-1 items-center gap-2 rounded-lg border px-2.5 py-2 transition-colors ${
                state === "processing" ? "border-running/60 bg-node-active" : state === "completed" ? "border-zinc-700 bg-node" : "border-line bg-node"
              }`}
            >
              <StatusIcon status={state} size={13} />
              <span className="min-w-0">
                <span className={`block truncate text-[12px] ${state === "queued" ? "text-zinc-600" : "text-zinc-200"}`}>{a.label}</span>
                <span className={`block truncate text-[10.5px] tabular-nums ${state === "processing" ? "text-running-soft" : "text-zinc-500"}`}>
                  {state === "queued" ? "waiting" : state === "processing" ? "working…" : a.detail}
                </span>
              </span>
            </li>
          );
        })}
      </ol>

      <div className="overflow-x-auto">
        <table className="w-full min-w-[620px] text-[12.5px]">
          <thead>
            <tr className="border-b border-line text-left text-[11.5px] text-zinc-500">
              <th className="px-4 py-2 font-medium">Title</th>
              <th className="px-3 py-2 font-medium">Company</th>
              <th className="px-3 py-2 font-medium">Salary</th>
              <th className="px-3 py-2 font-medium">Checks</th>
              <th className="px-3 py-2 font-medium">Source</th>
            </tr>
          </thead>
          <tbody>
            {DEMO_ROWS.map((r, i) => (
              <tr key={r[0]} className="h-[36px] border-b border-line last:border-0">
                {i < rows ? (
                  <>
                    <td className="animate-fade-up truncate px-4 text-zinc-200">{r[0]}</td>
                    <td className="animate-fade-up truncate px-3 text-zinc-400">{r[1]}</td>
                    <td className="animate-fade-up truncate px-3 tabular-nums text-zinc-400">{r[2]}</td>
                    <td className="animate-fade-up px-3">
                      <span className="inline-flex items-center gap-0.5 rounded bg-zinc-50/[0.04] px-1 py-0.5" aria-label="3 of 3 conditions met">
                        <Check className="h-3 w-3 text-success" aria-hidden />
                        <Check className="h-3 w-3 text-success" aria-hidden />
                        <Check className="h-3 w-3 text-success" aria-hidden />
                      </span>
                    </td>
                    <td className="animate-fade-up px-3">
                      <span className="inline-flex items-center gap-1 text-zinc-400">
                        <BadgeCheck className="h-3 w-3 text-success" aria-hidden />
                        {r[3]}
                      </span>
                    </td>
                  </>
                ) : (
                  <td colSpan={5} className="px-4">
                    <div className="h-2 w-2/3 rounded bg-zinc-50/[0.03]" />
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
