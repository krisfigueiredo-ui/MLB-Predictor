"use client";

import { Calculator } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";

import { C, EChart, baseAxis, tooltip } from "@/components/charts/EChart";
import { EVChips, LineMovementChart, ModelVsVegas, StatusPill } from "@/components/game/game";
import { LadderTable } from "@/components/game/Ladder";
import { TeamCrest } from "@/components/identity/identity";
import { Badge, Empty, KV, PageHeader, Panel, PanelHeader, Segmented, Skeleton, SourceStamp } from "@/components/ui/primitives";
import { useApi } from "@/lib/api";
import { american, cn, num, pct, signed, spreadLine } from "@/lib/format";
import type { BoardRow } from "@/lib/types";

/* ---- odds math (mirrors app/services/odds_math.py) ---- */
const toDec = (a: number) => 1 + (a > 0 ? a / 100 : 100 / -a);
const implied = (a: number) => 1 / toDec(a);
const toAm = (d: number) => (d >= 2 ? Math.round((d - 1) * 100) : Math.round(-100 / (d - 1)));

export default function SpreadsPage() {
  const [league, setLeague] = useState<"ALL" | "NBA" | "CBB">("ALL");
  const board = useApi<{ generated_at: string; demo: boolean; games: BoardRow[] }>(`/api/board?hours=40${league === "ALL" ? "" : `&league=${league}`}`);
  const rows = (board.data?.games ?? []).filter((r) => r.vs_market.spread);
  const [sel, setSel] = useState<number | null>(null);
  const selRow = rows.find((r) => r.game.id === sel) ?? rows[0];
  const mv = useApi<any>(selRow ? `/api/odds/${selRow.game.id}/movement` : null);
  const books = useMemo(() => Array.from(new Set(rows.flatMap((r) => r.by_book.map((b) => b.book as string)))).sort(), [rows]);
  const [mkt, setMkt] = useState<"spreads" | "totals" | "h2h">("spreads");

  return (
    <div className="space-y-6">
      <PageHeader
        index="06"
        title="Spreads & Vegas Odds"
        subtitle="Sportsbook lines side by side with model spreads, cover probabilities (pushes accounted for), no-vig fair prices and timestamped line movement."
        right={
          <>
            <Segmented value={league} onChange={setLeague} options={[{ value: "ALL", label: "All" }, { value: "NBA", label: "NBA" }, { value: "CBB", label: "CBB" }]} />
            <SourceStamp at={board.data?.generated_at} demo={board.data?.demo} />
          </>
        }
      />
      <Panel>
        <PanelHeader eyebrow="Line screen" title="Home spread by sportsbook" right={<span className="text-[11px] text-mist-500">Only books returned by the connected odds provider are shown. Best price highlighted.</span>} />
        <div className="overflow-x-auto">
          <table className="w-full min-w-[900px] text-[12.5px]">
            <thead>
              <tr className="border-b border-line/70">
                <th className="label px-3 py-2 text-left">Matchup</th>
                <th className="label px-3 py-2 text-left">Tip</th>
                {books.map((b) => (
                  <th key={b} className="label px-3 py-2 text-right">{b}</th>
                ))}
                <th className="label px-3 py-2 text-right text-volt-300">Model</th>
                <th className="label px-3 py-2 text-right">Home cover</th>
                <th className="label px-3 py-2 text-right">Push</th>
                <th className="label px-3 py-2 text-right">EV (home/away)</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const prices = r.by_book.map((b) => b.spreads_home?.price ?? -1000);
                const best = Math.max(...prices.map((p) => (p > 0 ? p : -10000 / p)));
                return (
                  <tr key={r.game.id} onClick={() => setSel(r.game.id)} className={cn("cursor-pointer border-b border-line/40 hover:bg-volt/[0.04]", selRow?.game.id === r.game.id && "bg-volt/[0.06]")}>
                    <td className="px-3 py-2">
                      <span className="flex items-center gap-1.5 text-mist">
                        <TeamCrest team={r.game.away} size={16} /> {r.game.away.abbr} <span className="text-mist-500">@</span> <TeamCrest team={r.game.home} size={16} /> {r.game.home.abbr}
                        <Badge className="ml-1" tone={r.game.league === "NBA" ? "volt" : "cyan"}>{r.game.league}</Badge>
                      </span>
                    </td>
                    <td className="px-3 py-2"><StatusPill g={r.game} /></td>
                    {books.map((b) => {
                      const bk = r.by_book.find((x) => x.book === b)?.spreads_home;
                      const isBest = bk && (bk.price > 0 ? bk.price : -10000 / bk.price) === best;
                      return (
                        <td key={b} className="whitespace-nowrap px-3 py-2 text-right font-mono tabular">
                          {bk ? (
                            <span className={cn(isBest ? "text-gain" : "text-mist-300")}>
                              {spreadLine(bk.line)} <span className="text-[10.5px] text-mist-500">{american(bk.price)}</span>
                            </span>
                          ) : (
                            <span className="text-mist-500">—</span>
                          )}
                        </td>
                      );
                    })}
                    <td className="px-3 py-2 text-right font-mono font-semibold tabular text-volt-300">{spreadLine(r.projected.spread_home)}</td>
                    <td className="px-3 py-2 text-right font-mono tabular text-mist-300">{pct(r.vs_market.spread!.p_home_cover)}</td>
                    <td className="px-3 py-2 text-right font-mono tabular text-mist-500">{pct(r.vs_market.spread!.p_push, 1)}</td>
                    <td className="whitespace-nowrap px-3 py-2 text-right font-mono tabular">
                      <span className={r.vs_market.spread!.ev_home > 0 ? "text-gain" : "text-mist-500"}>{signed(r.vs_market.spread!.ev_home * 100, 1)}</span>
                      <span className="text-mist-500"> / </span>
                      <span className={r.vs_market.spread!.ev_away > 0 ? "text-gain" : "text-mist-500"}>{signed(r.vs_market.spread!.ev_away * 100, 1)}</span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {board.isLoading && <Skeleton className="m-4 h-48" />}
          {!board.isLoading && !rows.length && <Empty title="No priced games in the window" />}
        </div>
      </Panel>

      {selRow && (
        <div className="grid gap-6 xl:grid-cols-[1fr_1fr]">
          <Panel>
            <PanelHeader eyebrow="Model vs Vegas" title={`${selRow.game.away.name} @ ${selRow.game.home.name}`} right={<Link href={`/games/${selRow.game.id}`} className="text-xs text-volt-300 hover:underline">Game page</Link>} />
            <ModelVsVegas g={selRow.game} vs={selRow.vs_market} projected={selRow.projected} sim={selRow.simulation} />
            <div className="border-t border-line/60 p-4">
              <EVChips vs={selRow.vs_market} g={selRow.game} />
              {selRow.vs_market.moneyline && (
                <div className="mt-4 grid grid-cols-2 gap-x-6 md:grid-cols-3">
                  <KV k="Book implied (home)" v={pct(implied(selRow.vs_market.moneyline.market_home_price))} />
                  <KV k="No-vig (home)" v={pct(selRow.vs_market.moneyline.no_vig_home)} />
                  <KV k="Overround" v={pct(implied(selRow.vs_market.moneyline.market_home_price) + implied(selRow.vs_market.moneyline.market_away_price) - 1, 2)} />
                  <KV k="Fair ML (model)" v={`${american(selRow.vs_market.moneyline.fair_home)} / ${american(selRow.vs_market.moneyline.fair_away)}`} />
                  <KV k="Market ML" v={`${american(selRow.vs_market.moneyline.market_home_price)} / ${american(selRow.vs_market.moneyline.market_away_price)}`} />
                </div>
              )}
            </div>
          </Panel>
          <Panel>
            <PanelHeader
              eyebrow="Odds movement"
              title="Timestamped snapshots"
              right={<Segmented size="sm" value={mkt} onChange={setMkt} options={[{ value: "spreads", label: "Spread" }, { value: "totals", label: "Total" }, { value: "h2h", label: "ML" }]} />}
            />
            <div className="p-2">{mv.data?.n ? <LineMovementChart series={mv.data.series} market={mkt} height={260} /> : <Skeleton className="h-60" />}</div>
            {mv.data?.model_history?.length > 0 && (
              <div className="border-t border-line/60 p-2">
                <div className="label px-2 pt-1">Model probability across archived snapshots</div>
                <EChart
                  height={150}
                  option={{
                    grid: { left: 40, right: 12, top: 16, bottom: 24 },
                    tooltip: { ...tooltip },
                    legend: { top: 0, right: 8, textStyle: { color: C.mist4, fontSize: 10 } },
                    xAxis: { type: "time", ...baseAxis },
                    yAxis: { type: "value", min: 0, max: 1, ...baseAxis, axisLabel: { ...baseAxis.axisLabel, formatter: (v: number) => `${v * 100}%` } },
                    series: ["moneyline", "spread", "total"].map((m, i) => ({
                      name: m,
                      type: "line",
                      showSymbol: true,
                      symbolSize: 5,
                      data: mv.data.model_history.filter((h: any) => h.market === m).map((h: any) => [h.data_as_of, h.prob]),
                      lineStyle: { color: [C.volt, C.cyan, C.flare][i] },
                      itemStyle: { color: [C.volt, C.cyan, C.flare][i] },
                    })),
                  }}
                />
              </div>
            )}
          </Panel>
        </div>
      )}
      {selRow?.simulation.ladder && (
        <Panel>
          <PanelHeader eyebrow="Alternate lines" title={`${selRow.game.away.abbr} @ ${selRow.game.home.abbr}: simulated ladder vs posted alternates`} />
          <LadderTable ladder={selRow.simulation.ladder} g={selRow.game} mainSpread={selRow.market.spread_home} mainTotal={selRow.market.total} />
        </Panel>
      )}
      <OddsCalculator />
    </div>
  );
}

function OddsCalculator() {
  const [a, setA] = useState("-110");
  const [b, setB] = useState("-110");
  const [p, setP] = useState("54");
  const pa = Number(a);
  const pb = Number(b);
  const valid = Math.abs(pa) >= 100 && Math.abs(pb) >= 100;
  const ia = valid ? implied(pa) : NaN;
  const ib = valid ? implied(pb) : NaN;
  const nvA = ia / (ia + ib);
  const model = Number(p) / 100;
  const ev = valid ? model * (toDec(pa) - 1) - (1 - model) : NaN;
  const kelly = valid ? Math.max(0, ((toDec(pa) - 1) * model - (1 - model)) / (toDec(pa) - 1)) : NaN;
  const input = "w-full rounded-lg border border-line bg-ink-900 px-3 py-2 font-mono text-sm text-mist focus:border-volt/50 focus:outline-none";
  return (
    <Panel>
      <PanelHeader eyebrow="Tools" title="No-vig & expected value calculator" icon={<Calculator className="h-4 w-4 text-volt" />} />
      <div className="grid gap-6 p-4 md:grid-cols-[1fr_1fr]">
        <div className="grid grid-cols-3 gap-3">
          <label className="text-xs text-mist-400">
            Side A price
            <input className={input} value={a} onChange={(e) => setA(e.target.value)} />
          </label>
          <label className="text-xs text-mist-400">
            Side B price
            <input className={input} value={b} onChange={(e) => setB(e.target.value)} />
          </label>
          <label className="text-xs text-mist-400">
            Your prob. A (%)
            <input className={input} value={p} onChange={(e) => setP(e.target.value)} />
          </label>
          <p className="col-span-3 text-[11px] text-mist-500">American odds. Probability is your own estimate (e.g. from the model). Research only: the platform never places wagers.</p>
        </div>
        <div className="grid grid-cols-2 gap-x-6">
          <KV k="Implied A / B" v={valid ? `${pct(ia)} / ${pct(ib)}` : "—"} />
          <KV k="Overround (vig)" v={valid ? pct(ia + ib - 1, 2) : "—"} />
          <KV k="No-vig A / B" v={valid ? `${pct(nvA)} / ${pct(1 - nvA)}` : "—"} />
          <KV k="Fair price A" v={valid ? american(toAm(1 / nvA)) : "—"} />
          <KV k="EV per unit (A)" v={<span className={ev > 0 ? "text-gain" : "text-loss"}>{Number.isFinite(ev) ? `${signed(ev * 100, 2)}%` : "—"}</span>} />
          <KV k="Full Kelly fraction" v={Number.isFinite(kelly) ? pct(kelly, 1) : "—"} />
          <KV k="Break-even prob (A)" v={valid ? pct(ia) : "—"} />
          <KV k="Edge vs no-vig" v={valid ? `${signed((model - nvA) * 100, 1)} pp` : "—"} />
        </div>
      </div>
    </Panel>
  );
}
