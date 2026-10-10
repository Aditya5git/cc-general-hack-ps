import Link from "next/link";
import {
  ArrowRight,
  BadgeCheck,
  Bot,
  Download,
  Eye,
  FileSpreadsheet,
  Globe,
  ListChecks,
  MessageSquareText,
  PenLine,
  Quote,
  ShieldCheck,
  SlidersHorizontal,
  Workflow,
} from "lucide-react";
import { Logo } from "@/components/Logo";
import { DemoRun } from "@/components/landing/DemoRun";

const STEPS = [
  { n: "01", icon: PenLine, title: "Describe it", body: "Type the dataset you need in plain English, like you'd ask a colleague." },
  { n: "02", icon: SlidersHorizontal, title: "Review the plan", body: "A planning agent proposes the details, sources and must-have conditions. Change anything." },
  { n: "03", icon: Bot, title: "Agents collect & verify", body: "Sources are searched in parallel; every row is extracted, checked and de-duplicated live." },
  { n: "04", icon: FileSpreadsheet, title: "Explore & export", body: "Search, filter, chart and question the table, then export to CSV or JSON." },
];

const FEATURES = [
  { icon: Quote, title: "Evidence on every row", body: "The exact sentence each row came from, matched word-for-word against the fetched page in code, not by the AI." },
  { icon: ListChecks, title: "Every condition checked", body: "Each row is marked met, not met or not stated for every condition in your request, with a one-line reason." },
  { icon: Workflow, title: "Mission control", body: "Watch the planner, each source, the extractor and the validator work live, with rows streaming into the table." },
  { icon: MessageSquareText, title: "Ask your data", body: "Ask questions in plain English; answers cite the rows they used so you can check them." },
  { icon: Eye, title: "Watch for changes", body: "Refresh a dataset or put it on a schedule. New rows are badged; removed ones are counted." },
  { icon: Download, title: "Yours to keep", body: "Every workflow is kept; refresh updates in place. Export as CSV or JSON with sources attached." },
];

const HONEST = [
  { icon: Globe, text: "Public APIs and the open web only. Pages we read are checked against robots.txt" },
  { icon: ShieldCheck, text: "Scraped text is treated as untrusted; internal addresses are never fetched" },
  { icon: BadgeCheck, text: "Quotes are verified in code; condition checks are AI judgments and labelled as such" },
];

export default function Landing() {
  return (
    <div className="lp relative min-h-screen overflow-x-clip bg-backdrop text-zinc-200">
      {/* ---------- Nav ---------- */}
      <header className="sticky top-0 z-30 bg-backdrop/40 backdrop-blur-md">
        <nav aria-label="Main" className="mx-auto flex h-16 max-w-[1200px] items-center justify-between px-4 sm:px-6">
          <Link href="/" className="flex items-center gap-2">
            <Logo size={22} />
            <span className="text-[15px] font-semibold tracking-tight text-zinc-50">DataPilot</span>
          </Link>
          <ul className="glass hidden items-center gap-1 rounded-full px-2 py-1.5 text-[13px] md:flex">
            {[
              ["How it works", "#how"],
              ["Features", "#features"],
              ["Trust", "#trust"],
            ].map(([label, href]) => (
              <li key={href}>
                <a href={href} className="rounded-full px-3.5 py-1.5 text-zinc-300 transition hover:bg-zinc-50/[0.06] hover:text-zinc-50">
                  {label}
                </a>
              </li>
            ))}
          </ul>
          <span className="flex items-center gap-2">
            <Link href="/auth/sign-in" className="hidden h-10 items-center rounded-xl px-3.5 text-[13.5px] text-zinc-300 transition hover:text-zinc-50 sm:inline-flex">
              Sign in
            </Link>
            <Link href="/new" className="btn-glow inline-flex h-10 items-center rounded-xl px-4 text-[13.5px] font-medium">
              Open app
            </Link>
          </span>
        </nav>
      </header>

      {/* ---------- Hero ---------- */}
      <section className="lp-hero grain relative -mt-16 overflow-hidden pt-16" aria-labelledby="lp-title">
        <div className="lp-pillars-warm" aria-hidden />
        <div className="lp-pillars-cool" aria-hidden />
        <div className="lp-wordmark" aria-hidden>
          DATAPILOT
        </div>

        <div className="relative z-10 mx-auto max-w-[860px] px-4 pt-28 text-center sm:px-6 md:pt-36">
          <span className="glass inline-flex items-center gap-2 rounded-full px-3.5 py-1.5 text-[12.5px] text-zinc-300">
            <span className="mc-dot h-1.5 w-1.5 rounded-full bg-success" aria-hidden />
            AI-planned pipeline · every row source-backed
          </span>
          <h1 id="lp-title" className="mt-7 text-[42px] font-semibold leading-[1.04] tracking-[-0.035em] text-zinc-50 sm:text-[68px]">
            Turn a sentence into
            <br />a cited dataset
          </h1>
          <p className="mx-auto mt-6 max-w-[560px] text-[16px] leading-relaxed text-zinc-300">
            Describe the data your business needs. AI plans the collection, gathers it from permitted sources, and hands you a clean
            table where every row proves where it came from.
          </p>
          <div className="mt-10 flex flex-wrap items-center justify-center gap-3">
            <Link href="/new" className="btn-glow inline-flex h-12 items-center gap-2 rounded-xl px-6 text-[15px] font-medium">
              Get started <ArrowRight className="h-4 w-4" aria-hidden />
            </Link>
            <a href="#how" className="glass inline-flex h-12 items-center rounded-xl px-5 text-[15px] text-zinc-200 transition hover:text-zinc-50">
              See how it works
            </a>
          </div>
        </div>

        <div className="lp-horizon" aria-hidden>
          <div className="lp-horizon-arc" />
        </div>
      </section>

      {/* ---------- Product preview, rising out of the horizon ---------- */}
      <section className="relative z-10 mx-auto -mt-[220px] max-w-[1040px] px-4 sm:px-6" aria-label="Sample run">
        <div className="lp-frame">
          <div className="flex items-center gap-2 border-b border-line px-4 py-2.5">
            <span className="flex gap-1.5" aria-hidden>
              <span className="h-2.5 w-2.5 rounded-full bg-zinc-700" />
              <span className="h-2.5 w-2.5 rounded-full bg-zinc-700" />
              <span className="h-2.5 w-2.5 rounded-full bg-zinc-700" />
            </span>
            <span className="mx-auto rounded-md bg-zinc-50/[0.04] px-3 py-1 font-mono text-[11px] text-zinc-500">datapilot / workflows / remote-react-jobs</span>
            <span className="text-[11px] text-zinc-600">sample run</span>
          </div>
          <DemoRun />
        </div>
      </section>

      {/* ---------- How it works ---------- */}
      <section id="how" className="relative mx-auto max-w-[1200px] scroll-mt-20 px-4 pt-32 sm:px-6" aria-labelledby="how-title">
        <p className="lp-eyebrow">How it works</p>
        <h2 id="how-title" className="lp-h2">
          From a business question to a dataset you can trust
        </h2>
        <ol className="mt-12 grid gap-4 md:grid-cols-4">
          {STEPS.map(({ n, icon: Icon, title, body }) => (
            <li key={n} className="glass relative rounded-2xl p-5">
              <span className="font-mono text-[12px] text-zinc-500">{n}</span>
              <Icon className="mt-6 h-5 w-5 text-zinc-300" aria-hidden />
              <h3 className="mt-3 text-[15px] font-medium text-zinc-50">{title}</h3>
              <p className="mt-1.5 text-[13.5px] leading-relaxed text-zinc-400">{body}</p>
            </li>
          ))}
        </ol>
      </section>

      {/* ---------- Features ---------- */}
      <section id="features" className="relative mx-auto max-w-[1200px] scroll-mt-20 px-4 pt-32 sm:px-6" aria-labelledby="features-title">
        <div className="lp-side-glow" aria-hidden />
        <p className="lp-eyebrow">Features</p>
        <h2 id="features-title" className="lp-h2">
          Built so you can check the AI&apos;s work
        </h2>
        <ul className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {FEATURES.map(({ icon: Icon, title, body }) => (
            <li key={title} className="glass lp-card rounded-2xl p-6">
              <span className="grid h-10 w-10 place-items-center rounded-xl border border-zinc-50/10 bg-zinc-950/60">
                <Icon className="h-[18px] w-[18px] text-zinc-200" aria-hidden />
              </span>
              <h3 className="mt-5 text-[16px] font-medium text-zinc-50">{title}</h3>
              <p className="mt-2 text-[14px] leading-relaxed text-zinc-400">{body}</p>
            </li>
          ))}
        </ul>
      </section>

      {/* ---------- Trust ---------- */}
      <section id="trust" className="relative mx-auto max-w-[1200px] scroll-mt-20 px-4 pt-32 sm:px-6" aria-labelledby="trust-title">
        <p className="lp-eyebrow">Trust</p>
        <h2 id="trust-title" className="lp-h2">
          What it does, and what it doesn&apos;t claim
        </h2>
        <ul className="glass mt-10 grid overflow-hidden rounded-2xl md:grid-cols-3">
          {HONEST.map(({ icon: Icon, text }) => (
            <li key={text} className="flex items-start gap-3 border-zinc-50/[0.06] p-6 [&:not(:last-child)]:border-b md:[&:not(:last-child)]:border-b-0 md:[&:not(:last-child)]:border-r">
              <Icon className="mt-0.5 h-[18px] w-[18px] shrink-0 text-zinc-300" aria-hidden />
              <p className="text-[14px] leading-relaxed text-zinc-300">{text}</p>
            </li>
          ))}
        </ul>
      </section>

      {/* ---------- Closing CTA + footer ---------- */}
      <footer className="lp-footer grain relative mt-32 overflow-hidden" aria-labelledby="cta-title">
        <div className="relative z-10 mx-auto max-w-[760px] px-4 pt-24 text-center sm:px-6">
          <h2 id="cta-title" className="text-[32px] font-semibold tracking-[-0.03em] text-zinc-50 sm:text-[44px]">
            What data do you need today?
          </h2>
          <p className="mt-3 text-[15px] text-zinc-400">No scrapers to write. No spreadsheets to clean.</p>
          <Link href="/new" className="btn-glow mt-8 inline-flex h-12 items-center gap-2 rounded-xl px-6 text-[15px] font-medium">
            Start a dataset <ArrowRight className="h-4 w-4" aria-hidden />
          </Link>
        </div>
        <div className="lp-footer-mark" aria-hidden>
          DATAPILOT
        </div>
        <div className="relative z-10 mx-auto flex max-w-[1200px] flex-wrap items-center justify-between gap-4 border-t border-zinc-50/[0.06] px-4 py-6 text-[13px] text-zinc-500 sm:px-6">
          <span className="flex items-center gap-2">
            <Logo size={18} /> DataPilot · Code Cubicle 6.0
          </span>
          <span className="flex gap-5">
            <Link href="/new" className="hover:text-zinc-200">
              New dataset
            </Link>
            <Link href="/workflows" className="hover:text-zinc-200">
              Workflows
            </Link>
          </span>
        </div>
      </footer>
    </div>
  );
}
