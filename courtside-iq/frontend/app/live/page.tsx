"use client";

import { Activity, Radio } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";

import { C, EChart, baseAxis, tooltip } from "@/components/charts/EChart";
import { LineMovementChart, StatusPill } from "@/components/game/game";
import { TeamCrest } from "@/components/identity/identity";
import { Badge, DemoBadge, Empty, LiveDot, PageHeader, Panel, PanelHeader, ProbBar, Segmented, Skeleton, SourceStamp, Stat } from "@/components/ui/primitives";
import { useApi } from "@/lib/api";
import { cn, num, pct, periodLabel, signed } from "@/lib/format";
import type { BoardRow } from "@/lib/types";

export default function LivePage() {
  const [league, setLeague] = useState<"ALL" | "NBA" | "CBB">("ALL");
  const board = useApi<{ generated_at: string; demo: boolean; games: (BoardRow & { live?: any })[] }>(`/api/board?hours=6${league === "ALL" ? "" : `&league=${league}`}`, {
    refetchInterval: 20_000,
  });
  const live = (board.data?.games ?? []).filter((r) => r.game.status === "live");
  const upcoming = (board.data?.games ?? []).filter((r) => r.game.status === "scheduled").slice(0, 8);
  const [sel, setSel] = useState<number | null>(null);
  const selected = live.find((r) => r.game.id === sel) ?? live[0];

  return (
    <div className="space-y-6">
      <PageHeader
        index="04"
        title="Live Analytics"
        subtitle="Real-time game states with pace tracking, live win probability and in-game projected totals. Refreshes every 20 seconds (the ticker streams via Server-Sent Events)."
        right={
          <>
            <Segmented value={league} onChange={setLeague} options={[{ value: "ALL", label: "All" }, { value: "NBA", label: "NBA" }, { value: "CBB", label: "CBB" }]} />
            <SourceStamp at={board.data?.generated_at} demo={board.data?.demo} />
          </>
        }
      />
      {board.isLoading && <Skeleton className="h-64" />}
      {!board.isLoading && live.length === 0 && (
        <Panel>
          <Empty title="No games are live right now" icon={<Radio className="h-6 w-6" />}>
            Live projections appear here automatically when games tip off. Next up:
            <div className="mt-3 flex flex-wrap justify-center gap-2">
              {upcoming.map((r) => (
                <Link key={r.game.id} href={`/games/${r.game.id}`} className="rounded-md border border-line px-2 py-1 text-mist-300 hover:border-volt/40">
                  {r.game.away.abbr} @ {r.game.home.abbr} · {new Date(r.game.start_time).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
                </Link>
              ))}
            </div>
          </Empty>
        </Panel>
      )}
      {live.length > 0 && (
        <>
          <div className="grid gap-4 md:grid-cols-2 2xl:grid-cols-3">
            {live.map((r) => (
              <LiveCard key={r.game.id} r={r} active={selected?.game.id === r.game.id} onClick={() => setSel(r.game.id)} />
            ))}
          </div>
          {selected && <LiveDetail r={selected} />}
        </>
      )}
    </div>
  );
}

function LiveCard({ r, active, onClick }: { r: BoardRow & { live?: any }; active: boolean; onClick: () => void }) {
  const g = r.game;
  const l = r.live;
  return (
    <button onClick={onClick} className={cn("panel panel-hover w-full overflow-hidden text-left", active && "border-volt/60 shadow-glow")}>
      <div className="flex items-center justify-between px-4 pt-3">
        <div className="flex items-center gap-2">
          <Badge tone={g.league === "NBA" ? "volt" : "cyan"}>{g.league}</Badge>
          <DemoBadge show={g.is_demo} />
        </div>
        <span className="flex items-center gap-1.5 font-mono text-xs font-semibold text-loss">
          <LiveDot /> {periodLabel(g.league, g.period, g.clock, g.status)}
        </span>
      </div>
      <div className="space-y-2 px-4 py-3">
        {[
          { t: g.away, s: g.away_score },
          { t: g.home, s: g.home_score },
        ].map(({ t, s }) => (
          <div key={t.id} className="flex items-center gap-3">
            <TeamCrest team={t} size={30} />
            <span className="flex-1 truncate font-display text-[15px] font-semibold text-mist">{t.name}</span>
            <span className="font-mono text-2xl font-bold tabular text-white">{s}</span>
          </div>
        ))}
      </div>
      {l && (
        <>
          <div className="px-4">
            <ProbBar left={1 - l.live_win_prob_home} right={l.live_win_prob_home} leftColor={g.away.primary} rightColor={g.home.primary} leftLabel={pct(1 - l.live_win_prob_home, 0)} rightLabel={pct(l.live_win_prob_home, 0)} />
          </div>
          <div className="mt-3 grid grid-cols-3 divide-x divide-line/60 border-t border-line/60 text-center">
            <div className="px-2 py-2">
              <div className="label">Live total</div>
              <div className="font-mono text-sm font-semibold text-volt-300">{num(l.live_projected_total)}</div>
              <div className="text-[10px] text-mist-500">mkt {r.vs_market.total ? r.vs_market.total.market_line : "—"}</div>
            </div>
            <div className="px-2 py-2">
              <div className="label">Pace</div>
              <div className={cn("font-mono text-sm font-semibold", l.pace_vs_projection > 1.04 ? "text-flare" : l.pace_vs_projection < 0.96 ? "text-cyan" : "text-mist")}>
                {num(l.pace_vs_projection * 100, 0)}%
              </div>
              <div className="text-[10px] text-mist-500">of projection</div>
            </div>
            <div className="px-2 py-2">
              <div className="label">Proj margin</div>
              <div className="font-mono text-sm font-semibold text-mist">{signed(l.live_projected_margin)}</div>
              <div className="text-[10px] text-mist-500">pre {signed(r.projected.margin)}</div>
            </div>
          </div>
        </>
      )}
    </button>
  );
}

function LiveDetail({ r }: { r: BoardRow & { live?: any } }) {
  const d = useApi<any>(`/api/games/${r.game.id}?n_sims=2000`, { refetchInterval: 20_000 });
  const ev = d.data?.events ?? [];
  const g = r.game;
  const l = r.live;
  const series = useMemo(() => ev.map((e: any) => ({ x: `${g.league === "NBA" ? "Q" : "H"}${e.period} ${e.clock}`, h: e.home, a: e.away })), [ev, g.league]);
  return (
    <div className="grid gap-6 xl:grid-cols-[1fr_1fr]">
      <Panel>
        <PanelHeader eyebrow="Game flow" title={`${g.away.abbr} @ ${g.home.abbr}`} icon={<Activity className="h-4 w-4 text-loss" />} right={<Link href={`/games/${g.id}`} className="text-xs text-volt-300 hover:underline">Full game page</Link>} />
        <div className="grid grid-cols-2 gap-4 p-4 md:grid-cols-4">
          <Stat label="Live win prob" value={pct(l?.live_win_prob_home)} sub={`${g.home.abbr} · pre-game ${pct(r.simulation.win_prob_home)}`} tone="volt" />
          <Stat label="Projected total" value={num(l?.live_projected_total)} sub={`pre-game ${num(r.projected.total)}`} />
          <Stat label="Current total" value={l?.current_total ?? "—"} sub={`${num((l?.minutes_elapsed ?? 0), 1)} min played`} />
          <Stat label="Remaining" value={pct(l?.fraction_remaining, 0)} />
        </div>
        <div className="px-2 pb-2">
          {series.length ? (
            <EChart
              height={240}
              option={{
                grid: { left: 36, right: 12, top: 28, bottom: 30 },
                legend: { top: 0, textStyle: { color: C.mist4, fontSize: 11 } },
                tooltip: { ...tooltip },
                xAxis: { type: "category", data: series.map((s: any) => s.x), ...baseAxis, axisLabel: { ...baseAxis.axisLabel, interval: Math.ceil(series.length / 6) } },
                yAxis: { type: "value", ...baseAxis },
                series: [
                  { name: g.away.abbr, type: "line", step: "end", showSymbol: false, data: series.map((s: any) => s.a), lineStyle: { color: C.flare, width: 2 } },
                  { name: g.home.abbr, type: "line", step: "end", showSymbol: false, data: series.map((s: any) => s.h), lineStyle: { color: C.volt, width: 2 } },
                ],
              }}
            />
          ) : (
            <Empty title="Waiting for scoring events" />
          )}
        </div>
      </Panel>
      <Panel>
        <PanelHeader eyebrow="Market" title="Pre-game line movement (spread)" />
        <div className="p-2">{d.data?.movement?.n ? <LineMovementChart series={d.data.movement.series} market="spreads" height={300} /> : <Skeleton className="h-64" />}</div>
        <div className="px-4 pb-3 text-[11px] text-mist-500">
          In-game lines are only shown when the connected odds feed supplies live markets; the demo feed captures pre-game snapshots only. <StatusPill g={g} />
        </div>
      </Panel>
    </div>
  );
}
