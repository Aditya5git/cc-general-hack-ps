"use client";

import { useRef, useState } from "react";
import { useReducedMotion } from "@/components/landing/DemoRun";
import { useRouter } from "next/navigation";
import {
  ArrowRight,
  ArrowUp,
  Briefcase,
  Coins,
  CornerDownLeft,
  Database,
  GitBranch,
  Handshake,
  Loader2,
  MessagesSquare,
  Sparkles,
} from "lucide-react";
import { fetchJSON } from "@/components/utils";

const USE_CASES = [
  {
    icon: Briefcase,
    tag: "Jobs",
    title: "Hiring market",
    prompt: "Remote React developer jobs with salary info",
    columns: ["title", "company", "salary", "location", "apply_url"],
  },
  {
    icon: GitBranch,
    tag: "Leads",
    title: "Startup leads",
    prompt: "AI startups on GitHub building developer tools",
    columns: ["name", "description", "stars", "language", "homepage"],
  },
  {
    icon: Handshake,
    tag: "Sponsors",
    title: "Event sponsors",
    prompt: "Sponsor opportunities for a college hackathon in India",
    columns: ["company", "category", "location", "contact_url"],
  },
  {
    icon: Coins,
    tag: "Market",
    title: "Live market data",
    prompt: "Top 20 cryptocurrencies by market cap",
    columns: ["name", "symbol", "price_usd", "market_cap", "change_24h"],
  },
  {
    icon: MessagesSquare,
    tag: "Research",
    title: "Community pulse",
    prompt: "Hacker News discussions about AI coding agents this month",
    columns: ["title", "points", "comments", "posted_at", "url"],
  },
  {
    icon: Database,
    tag: "Open source",
    title: "Tool landscape",
    prompt: "Open-source vector databases on GitHub",
    columns: ["name", "description", "stars", "language", "homepage"],
  },
];


export default function NewRequest() {
  const router = useRouter();
  const reduced = useReducedMotion();
  const [prompt, setPrompt] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [review, setReview] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);

  async function submit(text = prompt) {
    const p = text.trim();
    if (!p || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const j = await fetchJSON<{ id: string }>("/api/workflows", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: p, review }),
      });
      router.push(`/workflows/${j.id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong");
      setSubmitting(false);
    }
  }

  function applyPrompt(p: string, scroll = false) {
    setPrompt(p);
    if (scroll) taRef.current?.scrollIntoView({ behavior: reduced ? "auto" : "smooth", block: "center" });
    taRef.current?.focus({ preventScroll: scroll });
  }

  return (
    <div className="ai-home relative overflow-hidden md:rounded-2xl">
      <div className="ai-aura" aria-hidden />
      <header className="relative z-10 flex h-12 items-center justify-between px-6 text-[13px] text-ink-muted">
        <span>New request</span>
        <span className="pill border border-zinc-50/15 text-zinc-200">
          <Sparkles className="h-3.5 w-3.5 text-zinc-400" aria-hidden /> 9 live sources
        </span>
      </header>

      {/* ---------- Hero ---------- */}
      <section className="relative" aria-labelledby="hero-title">
        <div className="relative z-10 mx-auto max-w-[720px] px-4 pb-4 pt-10 text-center sm:px-6 md:pt-16">
          <span className="pill mx-auto border border-line-strong bg-zinc-50/[0.03] text-zinc-300">
            <span className="mc-dot h-1.5 w-1.5 rounded-full bg-success" aria-hidden />
            AI-planned pipeline
          </span>
          <h1 id="hero-title" className="mt-6 text-[36px] font-medium leading-[1.08] tracking-[-0.03em] text-zinc-50 sm:text-[52px]">
            Ask for data.
            <br />
            <span className="text-ai">Get a dataset.</span>
          </h1>
          <p className="mx-auto mt-5 max-w-[540px] text-[15.5px] leading-relaxed text-ink-muted">
            Describe what you need in plain English. AI agents plan the sources, collect from the live web, and return a clean table where
            every row proves where it came from.
          </p>

          {/* Composer */}
          <div className="ai-box mt-12 text-left">
            <div className="ai-box-inner">
              <label htmlFor="prompt" className="sr-only">
                Describe the dataset you need
              </label>
              <textarea
                id="prompt"
                ref={taRef}
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                onKeyDown={(e) => {
                  // Enter sends; Shift+Enter inserts a newline; ignore Enter while an IME is composing
                  if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    submit();
                  }
                }}
                rows={4}
                autoFocus
                placeholder="Ask for any dataset, e.g. SaaS companies in Bangalore hiring backend engineers"
                className="block w-full resize-none bg-transparent px-5 pt-4 text-[15px] leading-relaxed text-ink placeholder:text-zinc-500 focus:outline-none"
              />
              <div className="flex flex-wrap items-center gap-2 px-4 pb-4 pt-2">
                <button
                  type="button"
                  role="switch"
                  aria-checked={review}
                  onClick={() => setReview((v) => !v)}
                  title="Pause after planning so you can edit columns, sources and filters before collecting"
                  className={`inline-flex h-9 items-center gap-2 rounded-full px-3.5 text-[12.5px] transition ${
                    review ? "bg-zinc-50/10 text-zinc-50 ring-1 ring-zinc-50/25" : "bg-zinc-50/[0.07] text-zinc-300 hover:bg-zinc-50/10"
                  }`}
                >
                  <span className={`relative h-3.5 w-6 rounded-full transition ${review ? "bg-accent" : "bg-zinc-50/20"}`} aria-hidden>
                    <span className={`absolute top-0.5 h-2.5 w-2.5 rounded-full bg-zinc-50 transition-all ${review ? "left-3" : "left-0.5"}`} />
                  </span>
                  Review plan first
                </button>
                <span className="ml-auto hidden items-center gap-1 text-[11.5px] text-zinc-500 sm:inline-flex">
                  <kbd className="rounded border border-zinc-50/10 px-1 font-mono text-[10.5px]">
                    <CornerDownLeft className="inline h-2.5 w-2.5" aria-label="Enter" />
                  </kbd>
                  to run
                </span>
                <button
                  type="button"
                  onClick={() => submit()}
                  disabled={!prompt.trim() || submitting}
                  className="btn-glow ml-auto inline-flex h-9 items-center gap-1.5 rounded-full px-4 text-[13px] font-medium sm:ml-1"
                >
                  {submitting ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <ArrowUp className="h-4 w-4" aria-hidden />}
                  {submitting ? "Starting" : "Run"}
                </button>
              </div>
            </div>
          </div>
          {error && (
            <p role="alert" className="mt-4 text-[13px] text-zinc-300">
              ⚠ {error}
            </p>
          )}

          {/* Quick starts */}
          <div className="mt-6 flex flex-wrap justify-center gap-2">
            {USE_CASES.slice(0, 4).map(({ icon: Icon, tag, prompt: p }) => (
              <button
                key={tag}
                type="button"
                onClick={() => applyPrompt(p)}
                className="inline-flex h-9 items-center gap-1.5 rounded-full border border-zinc-50/10 bg-zinc-950/40 px-3.5 text-[12.5px] text-zinc-300 backdrop-blur transition hover:border-line-strong hover:text-ink"
              >
                <Icon className="h-3.5 w-3.5 text-zinc-500" aria-hidden />
                {p.length > 34 ? p.slice(0, 33) + "…" : p}
              </button>
            ))}
          </div>
        </div>
      </section>

      {/* ---------- Use cases ---------- */}
      <section className="relative mx-auto max-w-[960px] px-4 pb-20 pt-14 sm:px-6" aria-labelledby="usecases-title">
        <h2 id="usecases-title" className="text-[20px] font-medium text-zinc-50">
          Start from a use case
        </h2>
        <p className="mt-1 text-[13.5px] text-ink-muted">Pick one to fill the prompt. You can edit it before running.</p>
        <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {USE_CASES.map(({ icon: Icon, tag, title, prompt: p, columns }) => (
            <button
              key={tag}
              type="button"
              onClick={() => applyPrompt(p, true)}
              className="glass lp-card group flex flex-col rounded-xl p-4 text-left transition hover:-translate-y-0.5 hover:border-line-strong hover:bg-zinc-50/[0.03] motion-reduce:hover:translate-y-0"
            >
              <span className="flex w-full items-center gap-2">
                <span className="grid h-8 w-8 place-items-center rounded-lg border border-line bg-zinc-950/60 text-zinc-400 transition group-hover:text-zinc-200">
                  <Icon className="h-4 w-4" aria-hidden />
                </span>
                <span className="text-[14px] font-medium text-ink">{title}</span>
                <span className="ml-auto text-[11px] uppercase tracking-wider text-zinc-600">{tag}</span>
              </span>
              <span className="mt-3 text-[13px] leading-snug text-zinc-300">“{p}”</span>
              <span className="mt-3 flex flex-wrap gap-1">
                {columns.map((c) => (
                  <span key={c} className="rounded border border-line px-1.5 py-0.5 font-mono text-[10.5px] text-zinc-500">
                    {c}
                  </span>
                ))}
              </span>
              <span className="mt-4 inline-flex items-center gap-1 text-[12px] text-zinc-500 transition group-hover:text-zinc-200">
                Use this prompt <ArrowRight className="h-3 w-3 transition group-hover:translate-x-0.5 motion-reduce:transform-none" aria-hidden />
              </span>
            </button>
          ))}
        </div>
      </section>

    </div>
  );
}
