"use client";

import { ArrowUpRight, Flame, Radio, Target, TrendingUp } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";

import { C, EChart, baseAxis, tooltip } from "@/components/charts/EChart";
import { MatchupCard, PropCard, StatusPill } from "@/components/game/game";
import { pairColors, TeamCrest } from "@/components/identity/identity";
import { Badge, Empty, PageHeader, Panel, PanelHeader, ResultBadge, Segmented, Skeleton, SourceStamp, Stat } from "@/components/ui/primitives";
import { useApi } from "@/lib/api";
import { cn, MARKET_LABEL, num, pct, signed, spreadLine } from "@/lib/format";
import { useTicker } from "@/lib/hooks";
import type { BoardRow, PerfBlock, PredictionRow, PropProjection } from "@/lib/types";

export default function CommandCenter() {
  const [league, setLeague] = useState<"ALL" | "NBA" | "CBB">("ALL");
  const q = league === "ALL" ? "" : `?league=${league}`;
  const board = useApi<{ generated_at: string; demo: boolean; games: BoardRow[] }>(`/api/board${q}`, { refetchInterval: 60_000 });
  const perf = useApi<any>(`/api/performance/summary${q}`);
  const recent = useApi<PredictionRow[]>(`/api/predictions?limit=60&settled=true&games_only=true${league === "ALL" ? "" : `&league=${league}`}`);
  const props = useApi<{ props: PropProjection[] }>("/api/props?league=NBA");
  const { data: ticker } = useTicker(league === "ALL" ? undefined : league);

  const games = board.data?.games ?? [];
  const featured = useMemo(
    () =>
      [...games]
        .filter((r) => r.game.status === "scheduled")
        .sort((a, b) => Math.abs(b.vs_market.spread?.line_diff ?? 0) + Math.abs(b.vs_market.total?.line_diff ?? 0) / 2 - (Math.abs(a.vs_market.spread?.line_diff ?? 0) + Math.abs(a.vs_market.total?.line_diff ?? 0) / 2))
        .slice(0, 6),
    [games],
  );
  const live = (ticker?.games ?? []).filter((g) => g.status === "live");
  const total: PerfBlock | undefined = perf.data?.total;
  const topEdge = featured[0];

  return (
    <div className="space-y-6">
      <PageHeader
        index="01"
        title="Command Center"
        subtitle="Today's slate, model outlook versus the market, player-prop signals and the model's track record, all in one place."
        right={
          <>
            <Segmented
              value={league}
              onChange={setLeague}
              options={[
                { value: "ALL", label: "All leagues" },
                { value: "NBA", label: "NBA" },
                { value: "CBB", label: "College" },
              ]}
            />
          </>
        }
      />

      {/* KPI strip */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <Panel className="p-4">
          <Stat label="On the board" value={games.length || "—"} sub={`${games.filter((g) => g.game.league === "NBA").length} NBA · ${games.filter((g) => g.game.league === "CBB").length} CBB`} />
        </Panel>
        <Panel className="p-4">
          <Stat label={<span className="flex items-center gap-1"><Radio className="h-3 w-3 text-loss" /> Live now</span>} value={live.length} sub={live[0] ? `${live[0].away.abbr} ${live[0].away_score}–${live[0].home_score} ${live[0].home.abbr}` : "no live games"} tone={live.length ? "loss" : undefined} />
        </Panel>
        <Panel className="p-4">
          <Stat label="Settled forecasts" value={total ? total.decided.toLocaleString() : "—"} sub={`${perf.data?.pending ?? 0} pending`} />
        </Panel>
        <Panel className="p-4">
          <Stat
            label="Hit rate"
            value={pct(total?.win_pct)}
            sub={total ? `95% CI ${pct(total.win_pct_ci[0], 0)}–${pct(total.win_pct_ci[1], 0)}` : ""}
            tone="volt"
            hint="Share of decided pre-game forecasts (all markets) where the model's side won. Pushes excluded."
          />
        </Panel>
        <Panel className="p-4">
          <Stat label="Brier score" value={num(total?.brier, 3)} sub={`ECE ${num(total?.ece, 3)} · lower is better`} hint="Mean squared error of predicted probabilities; 0.25 = coin flip." />
        </Panel>
        <Panel className="p-4">
          <Stat
            label="Largest disagreement"
            value={topEdge ? signed(topEdge.vs_market.spread?.line_diff, 1) : "—"}
            sub={topEdge ? `${topEdge.game.away.abbr} @ ${topEdge.game.home.abbr} spread` : "—"}
            tone="flare"
          />
        </Panel>
      </div>

      <div className="grid gap-6 xl:grid-cols-[1fr_380px]">
        <div className="space-y-6">
          <Panel>
            <PanelHeader
              eyebrow="Featured matchups"
              title="Biggest model vs market disagreements"
              icon={<Flame className="h-4 w-4 text-flare" />}
              right={<SourceStamp at={board.data?.generated_at} demo={board.data?.demo} />}
            />
            <div className="grid gap-4 p-4 md:grid-cols-2 2xl:grid-cols-3">
              {board.isLoading && Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-[230px]" />)}
              {featured.map((r, i) => (
                <MatchupCard key={r.game.id} row={r} index={i} />
              ))}
              {!board.isLoading && featured.length === 0 && <Empty title="No upcoming games in the next 36 hours" />}
            </div>
          </Panel>

          <div className="grid gap-6 lg:grid-cols-2">
            <Panel>
              <PanelHeader eyebrow="Model outlook" title="Model win probability vs no-vig market" icon={<Target className="h-4 w-4 text-volt" />} />
              <div className="p-2">
                <OutlookScatter rows={games} />
              </div>
              <p className="px-4 pb-3 text-[11px] text-mist-500">Points above the diagonal: the model rates the home team higher than the market does. Hover for the matchup.</p>
            </Panel>
            <Comparison rows={games} />
          </div>

          <Panel>
            <PanelHeader eyebrow="Market intelligence" title="Lines, model projections and edges" right={<Link href="/spreads" className="flex items-center gap-1 text-xs text-volt-300 hover:underline">Spreads & odds <ArrowUpRight className="h-3 w-3" /></Link>} />
            <MarketTable rows={games.slice(0, 14)} />
          </Panel>
        </div>

        <div className="space-y-6">
          <Panel>
            <PanelHeader eyebrow="Track record" title="Rolling accuracy" icon={<TrendingUp className="h-4 w-4 text-cyan" />} right={<Link href="/picks" className="text-xs text-volt-300 hover:underline">Tracker</Link>} />
            <div className="p-2">
              {perf.data?.rolling?.length ? (
                <EChart
                  height={170}
                  option={{
                    grid: { left: 36, right: 10, top: 12, bottom: 22 },
                    tooltip: { ...tooltip, valueFormatter: (v: any) => `${(v * 100).toFixed(1)}%` },
                    xAxis: { type: "category", data: perf.data.rolling.map((r: any) => r.t.slice(5, 10)), ...baseAxis },
                    yAxis: { type: "value", min: 0.3, max: 0.8, ...baseAxis, axisLabel: { ...baseAxis.axisLabel, formatter: (v: number) => `${Math.round(v * 100)}%` } },
                    series: [
                      {
                        type: "line",
                        smooth: true,
                        showSymbol: false,
                        data: perf.data.rolling.map((r: any) => r.rate),
                        lineStyle: { color: C.cyan, width: 2 },
                        areaStyle: { color: { type: "linear", x: 0, y: 0, x2: 0, y2: 1, colorStops: [{ offset: 0, color: "rgba(34,211,238,0.25)" }, { offset: 1, color: "rgba(34,211,238,0)" }] } },
                        markLine: { symbol: "none", data: [{ yAxis: 0.5 }], lineStyle: { color: C.mist5, type: "dashed" }, label: { show: false } },
                      },
                    ],
                  }}
                />
              ) : (
                <Skeleton className="m-2 h-[150px]" />
              )}
            </div>
            <div className="grid grid-cols-2 gap-px border-t border-line/60 bg-line/40">
              {Object.entries<PerfBlock>(perf.data?.by_market ?? {})
                .slice(0, 6)
                .map(([k, v]) => (
                  <div key={k} className="bg-ink-850 px-4 py-2.5">
                    <div className="label">{MARKET_LABEL[k] ?? k}</div>
                    <div className="mt-0.5 flex items-baseline gap-2">
                      <span className="font-mono text-sm font-semibold text-mist">{pct(v.win_pct)}</span>
                      <span className="text-[10.5px] text-mist-500">n={v.decided}</span>
                    </div>
                  </div>
                ))}
            </div>
          </Panel>

          <Panel>
            <PanelHeader eyebrow="Recent predictions" title="Outcomes" right={<Link href="/picks" className="text-xs text-volt-300 hover:underline">All</Link>} />
            <ul className="divide-y divide-line/50">
              {(recent.data ?? [])
                .slice(0, 9)
                .map((p) => (
                  <li key={p.id}>
                    <Link href={`/games/${p.game_id}`} className="flex items-center gap-3 px-4 py-2.5 hover:bg-volt/[0.04]">
                      <div className="flex -space-x-1.5">
                        <TeamCrest team={p.away} size={20} />
                        <TeamCrest team={p.home} size={20} />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-xs font-medium text-mist">
                          {p.away.abbr} @ {p.home.abbr} · {MARKET_LABEL[p.market] ?? p.market}
                        </div>
                        <div className="truncate text-[11px] text-mist-500">
                          {p.selection} {p.line != null ? (p.market === "spread" ? spreadLine(p.line) : p.line) : ""} · {pct(p.predicted_prob, 0)} · actual {num(p.actual, 0)}
                        </div>
                      </div>
                      <ResultBadge result={p.result} />
                    </Link>
                  </li>
                ))}
              {recent.isLoading && <Skeleton className="m-4 h-40" />}
            </ul>
          </Panel>

          <Panel>
            <PanelHeader eyebrow="Player props" title={(props.data?.props ?? []).some((p) => p.markets.pts?.line != null) ? "Largest projection vs line gaps" : "Top projected scorers"} right={<Link href="/props" className="text-xs text-volt-300 hover:underline">Props lab</Link>} />
            <div className="space-y-3 p-3">
              {(props.data?.props ?? [])
                .filter((p) => !p.injury_out)
                .sort((a, b) =>
                  a.markets.pts?.line != null || b.markets.pts?.line != null
                    ? Math.abs(b.markets.pts.mean - (b.markets.pts.line ?? b.markets.pts.mean)) - Math.abs(a.markets.pts.mean - (a.markets.pts.line ?? a.markets.pts.mean))
                    : b.markets.pts.mean - a.markets.pts.mean,
                )
                .slice(0, 3)
                .map((p) => (
                  <Link key={`${p.player_id}-${p.game?.id}`} href={`/players/${p.player_id}`} className="block">
                    <PropCard p={p} stat="pts" />
                  </Link>
                ))}
              {props.isLoading && <Skeleton className="h-40" />}
              {!props.isLoading && !(props.data?.props ?? []).length && <Empty title="No upcoming player projections">Projections appear for games inside the next 30 hours.</Empty>}
            </div>
          </Panel>
        </div>
      </div>
    </div>
  );
}

function OutlookScatter({ rows }: { rows: BoardRow[] }) {
  const pts = rows.filter((r) => r.vs_market.moneyline).map((r) => ({ value: [r.vs_market.moneyline!.no_vig_home, r.simulation.win_prob_home], name: `${r.game.away.abbr} @ ${r.game.home.abbr}`, league: r.game.league }));
  return (
    <EChart
      height={260}
      option={{
        grid: { left: 44, right: 16, top: 16, bottom: 36 },
        tooltip: { trigger: "item", backgroundColor: "rgba(10,18,34,0.96)", borderColor: C.line, textStyle: { color: C.mist, fontSize: 12 }, formatter: (p: any) => `${p.data.name}<br/>Market ${(p.value[0] * 100).toFixed(1)}% · Model ${(p.value[1] * 100).toFixed(1)}%` },
        xAxis: { type: "value", min: 0, max: 1, name: "Market (no-vig) home win %", nameLocation: "middle", nameGap: 24, ...baseAxis, axisLabel: { ...baseAxis.axisLabel, formatter: (v: number) => `${v * 100}` } },
        yAxis: { type: "value", min: 0, max: 1, name: "Model", ...baseAxis, axisLabel: { ...baseAxis.axisLabel, formatter: (v: number) => `${v * 100}` } },
        series: [
          { type: "line", data: [[0, 0], [1, 1]], showSymbol: false, lineStyle: { color: C.mist5, type: "dashed", width: 1 }, silent: true },
          { type: "scatter", symbolSize: 11, data: pts.filter((p) => p.league === "NBA"), itemStyle: { color: C.volt, borderColor: "#fff", borderWidth: 0.5 }, name: "NBA" },
          { type: "scatter", symbolSize: 9, data: pts.filter((p) => p.league === "CBB"), itemStyle: { color: C.cyan, opacity: 0.85 }, name: "CBB" },
        ],
      }}
    />
  );
}

function Comparison({ rows }: { rows: BoardRow[] }) {
  const options = rows.filter((r) => r.game.status !== "final").slice(0, 30);
  const [sel, setSel] = useState<number | null>(null);
  const id = sel ?? options[0]?.game.id ?? null;
  const detail = useApi<any>(id ? `/api/games/${id}?n_sims=2000` : null);
  const f = detail.data?.projection?.features;
  const g = detail.data?.game;
  const axes = [
    { k: "adj_ortg", name: "Adj. offense", inv: false },
    { k: "adj_drtg", name: "Adj. defense", inv: true },
    { k: "pace", name: "Pace", inv: false },
    { k: "efg", name: "eFG%", inv: false },
    { k: "tov", name: "Ball security", inv: true },
    { k: "orb", name: "Off. rebounding", inv: false },
    { k: "ftr", name: "FT rate", inv: false },
  ];
  const norm = (k: string, v: number, inv: boolean) => {
    const ranges: Record<string, [number, number]> = { adj_ortg: [95, 125], adj_drtg: [95, 125], pace: [62, 106], efg: [0.44, 0.6], tov: [0.1, 0.22], orb: [0.18, 0.36], ftr: [0.18, 0.4] };
    const [lo, hi] = ranges[k];
    const x = Math.max(0, Math.min(1, (v - lo) / (hi - lo)));
    return Math.round((inv ? 1 - x : x) * 100);
  };
  return (
    <Panel>
      <PanelHeader
        eyebrow="Game comparison"
        title="Team profile radar"
        right={
          <select value={id ?? ""} onChange={(e) => setSel(Number(e.target.value))} className="max-w-[180px] rounded-md border border-line bg-ink-900 px-2 py-1 text-xs text-mist-300 focus:outline-none">
            {options.map((r) => (
              <option key={r.game.id} value={r.game.id}>
                {r.game.away.abbr} @ {r.game.home.abbr} ({r.game.league})
              </option>
            ))}
          </select>
        }
      />
      <div className="p-2">
        {f && g ? (
          <EChart
            height={260}
            option={{
              legend: { bottom: 0, textStyle: { color: C.mist4, fontSize: 11 } },
              tooltip: { trigger: "item", backgroundColor: "rgba(10,18,34,0.96)", borderColor: C.line, textStyle: { color: C.mist, fontSize: 12 } },
              radar: {
                indicator: axes.map((a) => ({ name: a.name, max: 100 })),
                radius: "62%",
                axisName: { color: C.mist4, fontSize: 10.5 },
                splitLine: { lineStyle: { color: C.line } },
                splitArea: { areaStyle: { color: ["rgba(13,23,43,0.4)", "rgba(10,18,34,0.4)"] } },
                axisLine: { lineStyle: { color: C.line } },
              },
              series: [
                {
                  type: "radar",
                  data: [
                    { name: g.away.name, value: axes.map((a) => norm(a.k, f[`a_${a.k}`], a.inv)), lineStyle: { color: pairColors(g.away, g.home)[0] }, itemStyle: { color: pairColors(g.away, g.home)[0] }, areaStyle: { opacity: 0.18 } },
                    { name: g.home.name, value: axes.map((a) => norm(a.k, f[`h_${a.k}`], a.inv)), lineStyle: { color: pairColors(g.away, g.home)[1] }, itemStyle: { color: pairColors(g.away, g.home)[1] }, areaStyle: { opacity: 0.18 } },
                  ],
                },
              ],
            }}
          />
        ) : (
          <Skeleton className="m-2 h-[240px]" />
        )}
      </div>
      <p className="px-4 pb-3 text-[11px] text-mist-500">Pre-game, opponent-adjusted profiles (point-in-time). Defence and ball security are inverted so outward is better.</p>
    </Panel>
  );
}

function MarketTable({ rows }: { rows: BoardRow[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[760px] text-[12.5px]">
        <thead>
          <tr className="border-b border-line/70">
            {["Matchup", "Status", "Spread (home) Vegas → Model", "Cover %", "Total Vegas → Model", "Over %", "Win % (home)", "Best EV"].map((h) => (
              <th key={h} className="label px-3 py-2 text-left">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const sp = r.vs_market.spread;
            const t = r.vs_market.total;
            const evs = [sp?.ev_home, sp?.ev_away, t?.ev_over, t?.ev_under].filter((x): x is number => x != null);
            const best = evs.length ? Math.max(...evs) : null;
            return (
              <tr key={r.game.id} className="border-b border-line/40 hover:bg-volt/[0.04]">
                <td className="px-3 py-2">
                  <Link href={`/games/${r.game.id}`} className="flex items-center gap-2 hover:text-volt-300">
                    <TeamCrest team={r.game.away} size={18} />
                    <span className="text-mist">{r.game.away.abbr}</span>
                    <span className="text-mist-500">@</span>
                    <TeamCrest team={r.game.home} size={18} />
                    <span className="text-mist">{r.game.home.abbr}</span>
                    <Badge className="ml-1" tone={r.game.league === "NBA" ? "volt" : "cyan"}>
                      {r.game.league}
                    </Badge>
                  </Link>
                </td>
                <td className="px-3 py-2">
                  <StatusPill g={r.game} />
                </td>
                <td className="whitespace-nowrap px-3 py-2 font-mono tabular">
                  <span className="text-mist-400">{sp ? spreadLine(sp.market_line_home) : "—"}</span> <span className="text-mist-500">→</span> <span className="text-volt-300">{spreadLine(r.projected.spread_home)}</span>
                </td>
                <td className="px-3 py-2 font-mono tabular text-mist-300">{sp ? pct(sp.p_home_cover, 0) : "—"}</td>
                <td className="whitespace-nowrap px-3 py-2 font-mono tabular">
                  <span className="text-mist-400">{t ? num(t.market_line) : "—"}</span> <span className="text-mist-500">→</span> <span className="text-volt-300">{num(r.projected.total)}</span>
                </td>
                <td className="px-3 py-2 font-mono tabular text-mist-300">{t ? pct(t.p_over, 0) : "—"}</td>
                <td className="px-3 py-2 font-mono tabular text-mist-300">{pct(r.simulation.win_prob_home, 0)}</td>
                <td className={cn("px-3 py-2 font-mono tabular", best != null && best > 0 ? "text-gain" : "text-mist-500")}>{best != null ? `${signed(best * 100, 1)}%` : "—"}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
