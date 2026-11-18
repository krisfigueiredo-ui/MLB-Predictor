"use client";

import Link from "next/link";
import { useState } from "react";

import { TeamCrest } from "@/components/identity/identity";
import { LiveDot, Segmented } from "@/components/ui/primitives";
import { cn, periodLabel, timeShort } from "@/lib/format";
import { useTicker } from "@/lib/hooks";
import type { Game } from "@/lib/types";

function TickerItem({ g }: { g: Game }) {
  const live = g.status === "live";
  const final = g.status === "final";
  const pl = periodLabel(g.league, g.period, g.clock, g.status);
  const hs = g.home_score ?? null;
  const as = g.away_score ?? null;
  const awayLead = final && as != null && hs != null && as > hs;
  const homeLead = final && as != null && hs != null && hs > as;
  const wp = g.model?.win_prob_home;
  return (
    <Link
      href={`/games/${g.id}`}
      className={cn(
        "group flex shrink-0 items-center gap-3 rounded-lg border border-transparent px-3 py-1.5 transition-colors hover:border-volt/30 hover:bg-volt/[0.06]",
        live && "bg-loss/[0.04]",
      )}
    >
      <div className="flex flex-col gap-0.5">
        {[
          { t: g.away, s: as, lead: awayLead },
          { t: g.home, s: hs, lead: homeLead },
        ].map(({ t, s, lead }) => (
          <div key={t.id} className="flex items-center gap-1.5">
            <TeamCrest team={t} size={15} ring={false} />
            <span className={cn("w-11 truncate text-[11.5px] font-semibold", final && !lead ? "text-mist-400" : "text-mist")}>{t.abbr}</span>
            <span className={cn("w-7 text-right font-mono text-[11.5px] tabular", final && !lead ? "text-mist-400" : "text-mist", live && "text-white")}>{s ?? ""}</span>
          </div>
        ))}
      </div>
      <div className="flex w-[68px] flex-col items-start gap-0.5">
        <span className="flex items-center gap-1 text-[9.5px] font-bold uppercase tracking-wider text-mist-500">
          {g.league}
          {g.is_demo && <span className="text-flare/80">· demo</span>}
        </span>
        {live ? (
          <span className="flex items-center gap-1.5 font-mono text-[10.5px] font-semibold text-loss">
            <LiveDot /> {pl}
          </span>
        ) : final ? (
          <span className="font-mono text-[10.5px] font-semibold text-mist-400">FINAL</span>
        ) : (
          <span className="font-mono text-[10.5px] text-mist-300">{timeShort(g.start_time)}</span>
        )}
        {wp != null && !final && (
          <span className="font-mono text-[9.5px] text-volt-300">
            {wp >= 0.5 ? g.home.abbr : g.away.abbr} {Math.round(Math.max(wp, 1 - wp) * 100)}%
          </span>
        )}
      </div>
    </Link>
  );
}

export function Ticker() {
  const [league, setLeague] = useState<"ALL" | "NBA" | "CBB">("ALL");
  const { data, transport } = useTicker(league === "ALL" ? undefined : league);
  const games = data?.games ?? [];
  return (
    <div className="sticky top-0 z-40 border-b border-line bg-ink-950/90 backdrop-blur-md">
      <div className="flex h-[58px] items-center gap-3 px-3">
        <div className="hidden shrink-0 items-center gap-2 sm:flex">
          <Segmented
            size="sm"
            value={league}
            onChange={setLeague}
            options={[
              { value: "ALL", label: "All" },
              { value: "NBA", label: "NBA" },
              { value: "CBB", label: "CBB" },
            ]}
          />
        </div>
        <div className="no-scrollbar mask-fade-x flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
          {games.length === 0 && <div className="px-3 text-xs text-mist-500">No games in the current window.</div>}
          {games.map((g) => (
            <TickerItem key={g.id} g={g} />
          ))}
        </div>
        <div className="hidden shrink-0 items-center gap-1.5 text-[10px] text-mist-500 lg:flex" title={`Ticker transport: ${transport}`}>
          <span className={cn("h-1.5 w-1.5 rounded-full", transport === "stream" ? "bg-gain" : "bg-gold")} />
          {transport === "stream" ? "Live stream" : "Polling"}
        </div>
      </div>
      <div className="flex gap-1 px-3 pb-2 sm:hidden">
        <Segmented
          size="sm"
          value={league}
          onChange={setLeague}
          options={[
            { value: "ALL", label: "All" },
            { value: "NBA", label: "NBA" },
            { value: "CBB", label: "CBB" },
          ]}
        />
      </div>
    </div>
  );
}
