"use client";

import { AnimatePresence, motion } from "framer-motion";
import {
  Activity,
  BarChart3,
  Bot,
  BrainCircuit,
  ClipboardList,
  Database,
  Gauge,
  GraduationCap,
  LayoutDashboard,
  LineChart,
  Menu,
  Settings,
  Sigma,
  Trophy,
  Users,
  X,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

import { AIPanel } from "@/components/shell/AIPanel";
import { Ticker } from "@/components/shell/Ticker";
import { cn } from "@/lib/format";
import { useNow, useStatus } from "@/lib/hooks";

export const NAV = [
  { n: "01", href: "/", label: "Command Center", icon: LayoutDashboard },
  { n: "02", href: "/nba", label: "NBA Game Center", icon: Trophy },
  { n: "03", href: "/cbb", label: "College Basketball", icon: GraduationCap },
  { n: "04", href: "/live", label: "Live Analytics", icon: Activity },
  { n: "05", href: "/totals", label: "Game Totals Lab", icon: Sigma },
  { n: "06", href: "/spreads", label: "Spreads & Odds", icon: LineChart },
  { n: "07", href: "/props", label: "Player Props Lab", icon: Users },
  { n: "08", href: "/trends", label: "Trends Lab", icon: BarChart3 },
  { n: "09", href: "/picks", label: "Picks Tracker", icon: ClipboardList },
  { n: "10", href: "/model", label: "Model Intelligence", icon: BrainCircuit },
  { n: "11", href: "/data", label: "Data Management", icon: Database },
  { n: "12", href: "/ai", label: "COURTSIDE AI", icon: Bot },
  { n: "13", href: "/settings", label: "Settings", icon: Settings },
];

function Logo() {
  return (
    <Link href="/" className="flex items-center gap-2.5 px-1">
      <svg viewBox="0 0 32 32" className="h-8 w-8" aria-hidden>
        <defs>
          <linearGradient id="lg" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#5A97FF" />
            <stop offset="1" stopColor="#22D3EE" />
          </linearGradient>
        </defs>
        <rect x="1" y="1" width="30" height="30" rx="9" fill="#0A1222" stroke="url(#lg)" strokeWidth="1.5" />
        <circle cx="16" cy="16" r="8.5" fill="none" stroke="url(#lg)" strokeWidth="1.6" />
        <path d="M7.5 16 H24.5 M16 7.5 V24.5" stroke="url(#lg)" strokeWidth="1.2" opacity="0.8" />
        <path d="M10 10.5 Q16 16 10 21.5 M22 10.5 Q16 16 22 21.5" stroke="url(#lg)" strokeWidth="1.1" fill="none" opacity="0.8" />
      </svg>
      <div className="leading-none">
        <div className="font-display text-[15px] font-bold tracking-tight text-mist">
          COURTSIDE <span className="bg-gradient-to-r from-volt-400 to-cyan bg-clip-text text-transparent">IQ</span>
        </div>
        <div className="mt-1 text-[9.5px] font-semibold uppercase tracking-[0.2em] text-mist-500">Basketball Intelligence</div>
      </div>
    </Link>
  );
}

function NavList({ onNavigate }: { onNavigate?: () => void }) {
  const path = usePathname();
  return (
    <nav className="flex flex-col gap-0.5">
      {NAV.map((item) => {
        const active = item.href === "/" ? path === "/" : path.startsWith(item.href);
        const Icon = item.icon;
        return (
          <Link
            key={item.href}
            href={item.href}
            onClick={onNavigate}
            className={cn(
              "group relative flex items-center gap-3 rounded-lg px-2.5 py-2 text-[13px] transition-all",
              active ? "bg-volt/10 text-mist" : "text-mist-400 hover:bg-ink-800 hover:text-mist",
            )}
          >
            {active && <motion.span layoutId="nav-active" className="absolute inset-y-1.5 left-0 w-[3px] rounded-full bg-gradient-to-b from-volt to-cyan" />}
            <span className={cn("w-5 font-mono text-[10px]", active ? "text-volt-300" : "text-mist-500")}>{item.n}</span>
            <Icon className={cn("h-4 w-4", active ? "text-volt-300" : "text-mist-500 group-hover:text-mist-300")} />
            <span className="truncate font-medium">{item.label}</span>
          </Link>
        );
      })}
    </nav>
  );
}

function StatusFooter() {
  const { data } = useStatus();
  if (!data) return <div className="skeleton h-16" />;
  const providers = Object.entries<any>(data.providers ?? {});
  return (
    <div className="rounded-xl border border-line bg-ink-900/70 p-3">
      <div className="flex items-center justify-between">
        <span className="label">Data mode</span>
        <span className={cn("rounded px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider", data.demo ? "bg-flare/10 text-flare" : "bg-gain/10 text-gain")}>{data.demo ? "Demo" : "Live"}</span>
      </div>
      <div className="mt-2 space-y-1">
        {providers.map(([k, v]) => (
          <div key={k} className="flex items-center justify-between text-[11px]">
            <span className="text-mist-400">{k.replace(/_/g, " ")}</span>
            <span className={cn("h-1.5 w-1.5 rounded-full", !v.configured ? "bg-mist-500" : v.ok === false ? "bg-loss" : "bg-gain")} title={v.configured ? v.message ?? "configured" : "not configured"} />
          </div>
        ))}
        <div className="flex items-center justify-between text-[11px]">
          <span className="text-mist-400">claude ai</span>
          <span className={cn("h-1.5 w-1.5 rounded-full", data.ai_enabled ? "bg-gain" : "bg-mist-500")} />
        </div>
      </div>
    </div>
  );
}

function TopBar({ onMenu, onAI }: { onMenu: () => void; onAI: () => void }) {
  const now = useNow(1000);
  const { data } = useStatus();
  const path = usePathname();
  const current = NAV.find((n) => (n.href === "/" ? path === "/" : path.startsWith(n.href)));
  return (
    <div className="flex h-12 items-center justify-between gap-3 border-b border-line/60 px-4 lg:px-6">
      <div className="flex items-center gap-3">
        <button className="rounded-md p-1.5 text-mist-300 hover:bg-ink-800 lg:hidden" onClick={onMenu} aria-label="Open navigation">
          <Menu className="h-5 w-5" />
        </button>
        <div className="flex items-center gap-2 text-xs text-mist-400">
          <span className="font-mono text-volt-300">{current?.n}</span>
          <span className="text-mist-500">/</span>
          <span className="font-medium text-mist-300">{current?.label ?? "Detail"}</span>
        </div>
      </div>
      <div className="flex items-center gap-3">
        {data?.demo && (
          <span className="hidden rounded-md border border-flare/30 bg-flare/10 px-2 py-1 text-[10.5px] font-semibold text-flare md:inline">
            DEMO MODE · synthetic data, no live provider connected
          </span>
        )}
        <span className="hidden items-center gap-1.5 font-mono text-[11px] text-mist-400 sm:flex">
          <Gauge className="h-3.5 w-3.5" />
          {now ? now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "--:--:--"}
        </span>
        <button
          onClick={onAI}
          className="flex items-center gap-1.5 rounded-lg border border-volt/30 bg-volt/10 px-2.5 py-1.5 text-xs font-semibold text-volt-300 transition-all hover:bg-volt/20 hover:shadow-glow"
        >
          <Bot className="h-3.5 w-3.5" /> Ask COURTSIDE AI
        </button>
      </div>
    </div>
  );
}

export function Shell({ children }: { children: React.ReactNode }) {
  const [menu, setMenu] = useState(false);
  const [ai, setAI] = useState(false);
  useEffect(() => {
    try {
      document.documentElement.dataset.density = localStorage.getItem("ciq-density") ?? "comfortable";
      document.documentElement.dataset.motion = localStorage.getItem("ciq-motion") ?? "on";
    } catch {}
  }, []);
  return (
    <div className="flex min-h-screen">
      <aside className="sticky top-0 hidden h-screen w-[248px] shrink-0 flex-col gap-5 border-r border-line bg-ink-950/80 px-3 py-4 backdrop-blur lg:flex">
        <Logo />
        <div className="no-scrollbar -mx-1 flex-1 overflow-y-auto px-1">
          <NavList />
        </div>
        <StatusFooter />
      </aside>
      <AnimatePresence>
        {menu && (
          <motion.div className="fixed inset-0 z-[60] lg:hidden" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
            <div className="absolute inset-0 bg-black/60" onClick={() => setMenu(false)} />
            <motion.aside
              initial={{ x: -280 }}
              animate={{ x: 0 }}
              exit={{ x: -280 }}
              transition={{ type: "spring", stiffness: 380, damping: 36 }}
              className="absolute inset-y-0 left-0 flex w-[270px] flex-col gap-5 border-r border-line bg-ink-950 px-3 py-4"
            >
              <div className="flex items-center justify-between">
                <Logo />
                <button onClick={() => setMenu(false)} className="rounded p-1 text-mist-400" aria-label="Close navigation">
                  <X className="h-5 w-5" />
                </button>
              </div>
              <div className="flex-1 overflow-y-auto">
                <NavList onNavigate={() => setMenu(false)} />
              </div>
              <StatusFooter />
            </motion.aside>
          </motion.div>
        )}
      </AnimatePresence>
      <div className="flex min-w-0 flex-1 flex-col">
        <Ticker />
        <TopBar onMenu={() => setMenu(true)} onAI={() => setAI(true)} />
        <main className="mx-auto w-full max-w-[1600px] flex-1 px-4 py-6 lg:px-6">{children}</main>
        <footer className="border-t border-line/60 px-6 py-4 text-[11px] text-mist-500">
          COURTSIDE IQ is research software. Forecasts are probabilistic estimates, not guarantees, and nothing here is betting or financial advice. Team names and colours identify
          franchises and schools; no trademarked logos are bundled — licensed assets can be registered in Settings.
        </footer>
      </div>
      <AIPanel open={ai} onClose={() => setAI(false)} />
    </div>
  );
}
