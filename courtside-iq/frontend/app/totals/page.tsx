"use client";

import { createColumnHelper } from "@tanstack/react-table";
import { useMemo, useState } from "react";

import { C, EChart, baseAxis } from "@/components/charts/EChart";
import { DistributionChart, StatusPill } from "@/components/game/game";
import { TeamCrest } from "@/components/identity/identity";
import { DataTable } from "@/components/ui/DataTable";
import { Badge, Empty, KV, PageHeader, Panel, PanelHeader, ProbBar, Segmented, Skeleton, SourceStamp, Stat } from "@/components/ui/primitives";
import { useApi } from "@/lib/api";
import { cn, num, pct, signed } from "@/lib/format";
import type { BoardRow } from "@/lib/types";

const col = createColumnHelper<BoardRow>();

export default function TotalsLab() {
  const [league, setLeague] = useState<"ALL" | "NBA" | "CBB">("ALL");
  const board = useApi<{ generated_at: string; demo: boolean; games: BoardRow[] }>(`/api/board?hours=40${league === "ALL" ? "" : `&league=${league}`}`);
  const rows = (board.data?.games ?? []).filter((r) => r.game.status !== "final");
  const [sel, setSel] = useState<number | null>(null);
  const selId = sel ?? rows[0]?.game.id ?? null;
  const detail = useApi<any>(selId ? `/api/games/${selId}?n_sims=20000` : null);
  const sr = rows.find((r) => r.game.id === selId);

  const columns = useMemo(
    () => [
      col.accessor((r) => `${r.game.away.abbr} @ ${r.game.home.abbr}`, {
        id: "matchup",
        header: "Matchup",
        cell: (c) => (
          <span className="flex items-center gap-1.5">
            <TeamCrest team={c.row.original.game.away} size={16} /> {c.row.original.game.away.abbr} <span className="text-mist-500">@</span>
            <TeamCrest team={c.row.original.game.home} size={16} /> {c.row.original.game.home.abbr}
            <Badge className="ml-1" tone={c.row.original.game.league === "NBA" ? "volt" : "cyan"}>{c.row.original.game.league}</Badge>
          </span>
        ),
      }),
      col.accessor((r) => r.projected.possessions ?? null, { id: "poss", header: "Est. poss", cell: (c) => num(c.getValue() as number), meta: { align: "right" } }),
      col.accessor((r) => r.vs_market.total?.market_line ?? null, { id: "line", header: "Market", cell: (c) => num(c.getValue() as number), meta: { align: "right" } }),
      col.accessor((r) => r.projected.total, { id: "model", header: "Model", cell: (c) => <span className="text-volt-300">{num(c.getValue())}</span>, meta: { align: "right" } }),
      col.accessor((r) => r.vs_market.total?.line_diff ?? null, {
        id: "diff",
        header: "Δ",
        cell: (c) => <span className={cn(Math.abs((c.getValue() as number) ?? 0) >= 3 ? "text-flare" : "text-mist-400")}>{signed(c.getValue() as number)}</span>,
        meta: { align: "right" },
      }),
      col.accessor((r) => r.vs_market.total?.p_over ?? null, { id: "pover", header: "P(over)", cell: (c) => pct(c.getValue() as number), meta: { align: "right" } }),
      col.accessor((r) => r.vs_market.total?.p_push ?? null, { id: "ppush", header: "P(push)", cell: (c) => pct(c.getValue() as number, 1), meta: { align: "right" } }),
      col.accessor((r) => r.vs_market.h1_total?.market_line ?? null, { id: "h1", header: "1H mkt", cell: (c) => num(c.getValue() as number), meta: { align: "right" } }),
      col.accessor((r) => r.projected.h1_total, { id: "h1m", header: "1H model", cell: (c) => num(c.getValue()), meta: { align: "right" } }),
      col.accessor((r) => Math.max(r.vs_market.total?.ev_over ?? -1, r.vs_market.total?.ev_under ?? -1), {
        id: "ev",
        header: "Best EV",
        cell: (c) => <span className={(c.getValue() as number) > 0 ? "text-gain" : "text-mist-500"}>{(c.getValue() as number) > -1 ? `${signed((c.getValue() as number) * 100, 1)}%` : "—"}</span>,
        meta: { align: "right" },
      }),
    ],
    [],
  );

  const p = detail.data?.projection;
  return (
    <div className="space-y-6">
      <PageHeader
        index="05"
        title="Game Totals Lab"
        subtitle="Over/under research: estimated possessions, efficiency-driven totals, simulated final-score distributions, first-half and team totals."
        right={
          <>
            <Segmented value={league} onChange={setLeague} options={[{ value: "ALL", label: "All" }, { value: "NBA", label: "NBA" }, { value: "CBB", label: "CBB" }]} />
            <SourceStamp at={board.data?.generated_at} demo={board.data?.demo} />
          </>
        }
      />
      <div className="grid gap-6 xl:grid-cols-[1.15fr_1fr]">
        <Panel>
          <PanelHeader eyebrow="Board" title="Totals: market vs model" right={<span className="text-[11px] text-mist-500">click a row to analyse</span>} />
          {board.isLoading ? <Skeleton className="m-4 h-72" /> : <DataTable data={rows} columns={columns as any} pageSize={14} dense onRowClick={(r) => setSel(r.game.id)} initialSort={[{ id: "diff", desc: true }]} />}
        </Panel>
        <Panel>
          <PanelHeader eyebrow="Calibration of disagreement" title="Model total vs market total" />
          <div className="p-2">
            <EChart
              height={330}
              option={{
                grid: { left: 48, right: 16, top: 16, bottom: 40 },
                tooltip: { trigger: "item", backgroundColor: "rgba(10,18,34,0.96)", borderColor: C.line, textStyle: { color: C.mist, fontSize: 12 }, formatter: (q: any) => `${q.data.name}<br/>Market ${q.value[0]} · Model ${q.value[1].toFixed(1)}` },
                xAxis: { type: "value", scale: true, name: "Market total", nameLocation: "middle", nameGap: 26, ...baseAxis },
                yAxis: { type: "value", scale: true, name: "Model total", ...baseAxis },
                series: [
                  {
                    type: "scatter",
                    symbolSize: 10,
                    data: rows.filter((r) => r.vs_market.total).map((r) => ({ value: [r.vs_market.total!.market_line, r.projected.total], name: `${r.game.away.abbr} @ ${r.game.home.abbr}`, itemStyle: { color: r.game.league === "NBA" ? C.volt : C.cyan } })),
                    markLine: { symbol: "none", silent: true, lineStyle: { color: C.mist5, type: "dashed" }, data: [[{ coord: [100, 100] }, { coord: [260, 260] }]] },
                  },
                ],
              }}
            />
          </div>
        </Panel>
      </div>

      {sr && (
        <div className="grid gap-6 xl:grid-cols-[360px_1fr]">
          <Panel>
            <PanelHeader eyebrow="Selected game" title={`${sr.game.away.name} @ ${sr.game.home.name}`} right={<StatusPill g={sr.game} />} />
            <div className="grid grid-cols-2 gap-4 p-4">
              <Stat label="Est. possessions" value={num(sr.projected.possessions)} sub={`${sr.game.away.abbr} ${num(sr.projected.away_pace)} · ${sr.game.home.abbr} ${num(sr.projected.home_pace)}`} />
              <Stat label="Model total" value={num(sr.projected.total)} tone="volt" sub={`market ${num(sr.vs_market.total?.market_line)}`} />
              <Stat label="Projected score" value={`${num(sr.projected.away_score, 0)}–${num(sr.projected.home_score, 0)}`} />
              <Stat label="Implied PPP" value={num(sr.projected.possessions ? sr.projected.total / 2 / sr.projected.possessions : null, 3)} sub="points per possession" />
            </div>
            {p && (
              <div className="space-y-3 border-t border-line/60 p-4">
                {p.simulation.totals && <ProbBar left={p.simulation.totals.p_over} right={p.simulation.totals.p_under} push={p.simulation.totals.p_push} leftLabel={`Over ${pct(p.simulation.totals.p_over)}`} rightLabel={`Under ${pct(p.simulation.totals.p_under)}`} leftColor={C.cyan} rightColor={C.flare} />}
                {p.simulation.h1 && <ProbBar left={p.simulation.h1.p_over} right={p.simulation.h1.p_under} push={p.simulation.h1.p_push} leftLabel={`1H over ${p.simulation.h1.line}: ${pct(p.simulation.h1.p_over)}`} rightLabel={pct(p.simulation.h1.p_under)} leftColor={C.cyan} rightColor={C.flare} />}
                {Object.entries<any>(p.simulation.team_totals ?? {}).map(([side, t]) => (
                  <ProbBar key={side} left={t.p_over} right={t.p_under} push={t.p_push} leftLabel={`${side === "home" ? sr.game.home.abbr : sr.game.away.abbr} TT o${t.line}: ${pct(t.p_over)}`} rightLabel={pct(t.p_under)} leftColor={C.volt} rightColor={C.flare} />
                ))}
                <KV k="90% interval (total)" v={`${num(p.simulation.total.p05, 0)}–${num(p.simulation.total.p95, 0)}`} />
                <KV k="Interquartile range" v={`${num(p.simulation.total.p25, 0)}–${num(p.simulation.total.p75, 0)}`} />
                <KV k="Simulations" v={`${p.simulation.n_sims.toLocaleString()} · seed ${p.seed}`} />
              </div>
            )}
          </Panel>
          <div className="grid gap-6 lg:grid-cols-2">
            <Panel>
              <PanelHeader eyebrow="20,000 simulations" title="Final total distribution" />
              <div className="p-2">{p ? <DistributionChart hist={p.simulation.total_hist} line={p.simulation.totals?.line} label="Total" color={C.cyan} height={280} /> : <Skeleton className="h-64" />}</div>
            </Panel>
            <Panel>
              <PanelHeader eyebrow="Simulated final scores" title="Score density" />
              <div className="p-2">{p ? <ScoreDensity p={p} home={sr.game.home.abbr} away={sr.game.away.abbr} /> : <Skeleton className="h-64" />}</div>
            </Panel>
          </div>
        </div>
      )}
      {!board.isLoading && rows.length === 0 && (
        <Panel>
          <Empty title="No upcoming games" />
        </Panel>
      )}
    </div>
  );
}

/** Approximate joint density of (away, home) final scores from the simulation summary (bivariate normal). */
function ScoreDensity({ p, home, away }: { p: any; home: string; away: string }) {
  const hs = p.simulation.home_score;
  const as = p.simulation.away_score;
  const lo = Math.floor(Math.min(hs.p05, as.p05) - 4);
  const hi = Math.ceil(Math.max(hs.p95, as.p95) + 4);
  const step = hi - lo > 80 ? 4 : 2;
  const xs: number[] = [];
  for (let v = lo; v <= hi; v += step) xs.push(v);
  const data: [number, number, number][] = [];
  xs.forEach((a, i) =>
    xs.forEach((h, j) => {
      const z = Math.exp(-0.5 * (((a - as.mean) / as.sd) ** 2 + ((h - hs.mean) / hs.sd) ** 2));
      data.push([i, j, Math.round(z * 1000) / 1000]);
    }),
  );
  return (
    <EChart
      height={280}
      option={{
        grid: { left: 44, right: 16, top: 10, bottom: 40 },
        tooltip: { position: "top", backgroundColor: "rgba(10,18,34,0.96)", borderColor: C.line, textStyle: { color: C.mist, fontSize: 12 }, formatter: (q: any) => `${away} ${xs[q.value[0]]} – ${home} ${xs[q.value[1]]}` },
        xAxis: { type: "category", data: xs, name: away, nameLocation: "middle", nameGap: 26, ...baseAxis },
        yAxis: { type: "category", data: xs, name: home, ...baseAxis },
        visualMap: { show: false, min: 0, max: 1, inRange: { color: ["#0A1222", "#13305f", "#2F7BFF", "#22D3EE"] } },
        series: [
          { type: "heatmap", data, itemStyle: { borderColor: "#050913", borderWidth: 0.5 } },
          { type: "line", data: xs.map((_, i) => [i, i]), showSymbol: false, lineStyle: { color: C.gold, type: "dashed", width: 1 }, silent: true },
        ],
      }}
    />
  );
}
