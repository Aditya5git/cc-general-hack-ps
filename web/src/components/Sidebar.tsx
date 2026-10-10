"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Layers, PenSquare } from "lucide-react";
import type { Workflow } from "@/lib/types";
import { Logo } from "./Logo";
import { StatusIcon } from "./StatusBadge";
import { AccountMenu } from "./AccountMenu";
import { fetchJSON, isRunning } from "./utils";

function useWorkflows() {
  const [workflows, setWorkflows] = useState<Workflow[] | null>(null);
  const pathname = usePathname();
  useEffect(() => {
    let alive = true;
    let anyRunning = true;
    let last = 0;
    const load = () =>
      fetchJSON<{ workflows: Workflow[] }>("/api/workflows")
        .then((j) => {
          if (!alive) return;
          setWorkflows(j.workflows ?? []);
          anyRunning = (j.workflows ?? []).some((w) => isRunning(w.status));
        })
        .catch(() => {}); // keep last good list; retry on next tick
    load();
    // every 5s while something runs, every 30s otherwise, never in a hidden tab: each poll wakes the database
    const t = setInterval(() => {
      if (document.hidden || Date.now() - last < (anyRunning ? 5000 : 30_000)) return;
      last = Date.now();
      load();
    }, 5000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [pathname]);
  return workflows;
}

export function Sidebar() {
  const pathname = usePathname();
  const workflows = useWorkflows();

  return (
    <aside className="sticky top-0 hidden h-screen w-[244px] shrink-0 flex-col bg-[linear-gradient(to_bottom,var(--color-sidebar)_0%,var(--color-sidebar)_62%,color-mix(in_oklab,var(--color-sidebar)_55%,transparent)_100%)] px-2.5 py-3 md:flex">
      <div className="flex items-center justify-between px-1.5">
        <Link href="/" className="flex items-center gap-2 rounded-md px-1 py-1 hover:bg-white/[0.04]">
          <Logo size={20} />
          <span className="text-[13.5px] font-semibold text-zinc-100">DataPilot</span>
        </Link>
        <Link
          href="/new"
          title="New request"
          className="grid h-7 w-7 place-items-center rounded-md border border-line-strong bg-raised text-zinc-300 hover:text-zinc-100"
        >
          <PenSquare className="h-3.5 w-3.5" />
        </Link>
      </div>

      <nav className="mt-4 flex flex-col gap-px">
        <NavItem href="/new" active={pathname === "/new"} icon={<PenSquare className="h-3.5 w-3.5" />}>
          New request
        </NavItem>
        <NavItem
          href="/workflows"
          active={pathname === "/workflows"}
          icon={<Layers className="h-3.5 w-3.5" />}
          trailing={workflows?.length ? String(workflows.length) : undefined}
        >
          Workflows
        </NavItem>
      </nav>

      <Section title="Recent">
        {workflows === null ? (
          [0, 1, 2, 3].map((i) => <div key={i} className="mx-2 my-1.5 h-3.5 animate-pulse rounded bg-white/[0.04]" />)
        ) : workflows.length === 0 ? (
          <p className="px-2.5 py-1 text-[12px] text-zinc-600">No workflows yet</p>
        ) : (
          workflows.slice(0, 14).map((w, i) => {
            const active = pathname === `/workflows/${w.id}`;
            return (
              <Link
                key={w.id}
                href={`/workflows/${w.id}`}
                title={w.prompt}
                style={{ animationDelay: `${i * 35}ms` }}
                className={`animate-fade-up group flex h-7 items-center gap-2 rounded-md px-2.5 text-[12.5px] font-medium ${
                  active ? "bg-white/[0.07] text-zinc-100" : "text-zinc-400 hover:bg-white/[0.04] hover:text-zinc-200"
                }`}
              >
                <StatusIcon status={w.status} size={12} mono={w.status === "completed"} />
                <span className="min-w-0 flex-1 truncate">{w.title || w.prompt}</span>
                {w.status === "completed" && (
                  <span className="font-mono text-[10.5px] tabular-nums text-zinc-600">{w.record_count ?? 0}</span>
                )}
              </Link>
            );
          })
        )}
      </Section>

      <div className="mt-auto pt-3">
        <AccountMenu />
      </div>
    </aside>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mt-5 flex min-h-0 flex-col">
      <div className="mb-1 px-2.5 text-[11.5px] font-semibold text-zinc-500">{title}</div>
      <div className="flex min-h-0 flex-col gap-px overflow-y-auto">{children}</div>
    </div>
  );
}

function NavItem({
  href,
  active,
  icon,
  trailing,
  children,
}: {
  href: string;
  active: boolean;
  icon: React.ReactNode;
  trailing?: string;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      className={`flex h-7 items-center gap-2 rounded-md px-2.5 text-[13px] font-medium ${
        active ? "bg-white/[0.07] text-zinc-100" : "text-zinc-400 hover:bg-white/[0.04] hover:text-zinc-200"
      }`}
    >
      <span className={active ? "text-zinc-200" : "text-zinc-500"}>{icon}</span>
      <span className="flex-1">{children}</span>
      {trailing && <span className="font-mono text-[11px] text-zinc-600">{trailing}</span>}
    </Link>
  );
}

export function MobileNav() {
  const pathname = usePathname();
  return (
    <header className="sticky top-0 z-30 flex items-center justify-between border-b border-line bg-canvas/90 px-4 py-2.5 backdrop-blur md:hidden">
      <Link href="/" className="flex items-center gap-2">
        <Logo size={20} />
        <span className="text-[13.5px] font-semibold text-zinc-100">DataPilot</span>
      </Link>
      <nav className="flex items-center gap-1">
        {[
          { href: "/new", label: "New" },
          { href: "/workflows", label: "Workflows" },
        ].map(({ href, label }) => {
          const active = pathname.startsWith(href);
          return (
            <Link
              key={href}
              href={href}
              className={`rounded-md px-2.5 py-1 text-[12.5px] ${active ? "bg-white/[0.07] text-zinc-100" : "text-zinc-400"}`}
            >
              {label}
            </Link>
          );
        })}
        <span className="ml-1">
          <AccountMenu compact />
        </span>
      </nav>
    </header>
  );
}
