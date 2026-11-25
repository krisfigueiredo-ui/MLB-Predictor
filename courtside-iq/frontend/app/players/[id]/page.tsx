"use client";

import { HeartPulse } from "lucide-react";
import Link from "next/link";
import { use, useState } from "react";

import { C, EChart, baseAxis, tooltip } from "@/components/charts/EChart";
import { StatusPill } from "@/components/game/game";
import { PlayerPortrait, RosterBadge, TeamCrest } from "@/components/identity/identity";
import { Badge, DemoBadge, Empty, ErrorState, KV, Panel, PanelHeader, ProbBar, ResultBadge, Segmented, Skeleton, SourceStamp, Stat } from "@/components/ui/primitives";
import { useApi } from "@/lib/api";
import { american, num, pct, signed, STAT_LABEL } from "@/lib/format";
import type { PredictionRow } from "@/lib/types";

export default function PlayerPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const q = useApi<any>(`/api/players/${id}`);
  const preds = useApi<PredictionRow[]>(`/api/predictions?player_id=${id}&limit=300&settled=true`);
  const [stat, setStat] = useState("pts");
  if (q.error) return <ErrorState error={q.error} />;
  if (!q.data) return <Skeleton className="h-[600px]" />;
  const p = q.data.player;
  const tr = q.data.trends;
  const proj = q.data.projection;
  const g = q.data.next_game;
  const games = tr.games ?? [];
  const opp = g ? (g.home.id === p.team?.id ? g.away : g.home) : null;
  const actualVsPred = (preds.data ?? []).filter((r) => r.market === `prop_${stat}` && r.actual != null).reverse();
  return (
    <div className="space-y-6">
      <Panel className="relative overflow-hidden">
        <div className="pointer-events-none absolute inset-0 opacity-30" style={{ background: `linear-gradient(110deg, ${p.team?.primary ?? "#2F7BFF"}aa 0%, transparent 55%)` }} />
        <div className="grid-bg pointer-events-none absolute inset-0 opacity-40" />
        <div className="relative flex flex-col gap-5 p-5 md:flex-row md:items-end">
          <PlayerPortrait player={p} size={150} />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              {p.team && <TeamCrest team={p.team} size={22} />}
              <Link href={p.team ? `/teams/${p.team.id}` : "#"} className="text-sm text-mist-300 hover:text-volt-300">
                {p.team?.name}
              </Link>
              <DemoBadge show={tr.is_demo} />
            </div>
            <h1 className="mt-1 font-display text-3xl font-semibold tracking-tight text-mist md:text-4xl">{p.name}</h1>
            <div className="mt-1 flex flex-wrap items-center gap-3 text-sm text-mist-400">
              <span>{p.position ?? "—"}</span>
              {p.jersey && <span className="font-mono">#{p.jersey}</span>}
              <RosterBadge player={p} />
              {q.data.injury && (
                <Badge tone="loss">
                  <HeartPulse className="h-3 w-3" /> {q.data.injury.status}
                </Badge>
              )}
            </div>
          </div>
          <div className="grid grid-cols-4 gap-4 md:w-[460px]">
            {["pts", "reb", "ast", "minutes"].map((k) => (
              <Stat key={k} label={k === "minutes" ? "MIN" : k.toUpperCase()} value={num(tr.windows?.season?.[k])} sub={`L10 ${num(tr.windows?.["10"]?.[k])}`} />
            ))}
          </div>
        </div>
      </Panel>

      {games.length === 0 ? (
        <Panel>
          <Empty title="No game logs for this player yet">Connect a provider or import player game logs in Data Management.</Empty>
        </Panel>
      ) : (
        <>
          <div className="grid gap-6 xl:grid-cols-[1fr_400px]">
            <Panel>
              <PanelHeader
                eyebrow="Rolling performance"
                title={`${STAT_LABEL[stat] ?? stat} · last ${games.length} games`}
                right={<Segmented size="sm" value={stat} onChange={setStat} options={["pts", "reb", "ast", "fg3m", "minutes"].map((s) => ({ value: s, label: s === "fg3m" ? "3PM" : s.toUpperCase() }))} />}
              />
              <div className="p-2">
                <EChart
                  height={300}
                  option={{
                    grid: { left: 36, right: 16, top: 30, bottom: 30 },
                    legend: { top: 0, textStyle: { color: C.mist4, fontSize: 11 } },
                    tooltip: { ...tooltip },
                    xAxis: { type: "category", data: games.map((x: any) => `${x.date.slice(5, 10)} ${x.home ? "v" : "@"}${x.opponent}`), ...baseAxis, axisLabel: { ...baseAxis.axisLabel, interval: Math.ceil(games.length / 8) } },
                    yAxis: { type: "value", ...baseAxis },
                    series: [
                      { name: "Game", type: "bar", data: games.map((x: any) => x[stat]), itemStyle: { color: (p.team?.primary ?? C.volt) + "88", borderRadius: [2, 2, 0, 0] } },
                      ...(games[0]?.[`${stat}_r5`] !== undefined
                        ? [
                            { name: "5-game avg", type: "line" as const, smooth: true, showSymbol: false, data: games.map((x: any) => x[`${stat}_r5`]), lineStyle: { color: C.cyan, width: 2.5 } },
                            { name: "10-game avg", type: "line" as const, smooth: true, showSymbol: false, data: games.map((x: any) => x[`${stat}_r10`]), lineStyle: { color: C.flare, width: 2 } },
                          ]
                        : []),
                    ],
                  }}
                />
              </div>
              <div className="grid grid-cols-2 gap-px border-t border-line/60 bg-line/40 md:grid-cols-4">
                {["5", "10", "20", "season"].map((w) => (
                  <div key={w} className="bg-ink-850 px-4 py-2.5">
                    <div className="label">{w === "season" ? "Season" : `Last ${w}`} <span className="normal-case tracking-normal text-mist-500">n={tr.windows[w].n}</span></div>
                    <div className="mt-0.5 font-mono text-[12px] text-mist-300">
                      {num(tr.windows[w].pts)} / {num(tr.windows[w].reb)} / {num(tr.windows[w].ast)} · {num(tr.windows[w].fg3a)} 3PA · USG {pct(tr.windows[w].usage, 0)}
                    </div>
                  </div>
                ))}
              </div>
              <div className="px-4 py-2">
                <SourceStamp source={tr.source?.join(", ")} />
              </div>
            </Panel>
            <Panel>
              <PanelHeader eyebrow="Next game projection" title={g ? `${g.away.abbr} @ ${g.home.abbr}` : "No scheduled game"} right={g && <StatusPill g={g} />} />
              {proj ? (
                <div className="space-y-3 p-4">
                  <div className="flex items-center gap-2 text-xs text-mist-400">
                    vs {opp && <TeamCrest team={opp} size={18} />} {opp?.name}
                  </div>
                  <div className="grid grid-cols-3 gap-3">
                    <Stat label="Proj. minutes" value={num(proj.minutes.mean)} sub={`${num(proj.minutes.p10, 0)}–${num(proj.minutes.p90, 0)}`} />
                    <Stat label="Blowout risk" value={num(Math.abs(proj.blowout_risk))} sub="|proj. spread|" />
                    <Stat label="Model" value={<span className="text-sm">{proj.model_version.split("-").slice(0, 2).join(" ")}</span>} />
                  </div>
                  {["pts", "reb", "ast", "fg3m", "pra"].map((k) => {
                    const m = proj.markets[k];
                    return (
                      <div key={k} className="rounded-lg border border-line/60 bg-ink-900/50 p-3">
                        <div className="flex items-center justify-between text-xs">
                          <span className="font-medium text-mist">{STAT_LABEL[k]}</span>
                          <span className="font-mono text-mist-400">
                            proj <span className="text-volt-300">{num(m.mean)}</span> · 80% {num(m.p10, 0)}–{num(m.p90, 0)} {m.line != null && <>· line {m.line} ({m.book} o{american(m.over_price)})</>}
                          </span>
                        </div>
                        {m.p_over != null && <ProbBar className="mt-2" left={m.p_over} right={m.p_under} push={m.p_push} leftLabel={`O ${pct(m.p_over, 0)}`} rightLabel={`U ${pct(m.p_under, 0)}`} leftColor={C.volt} rightColor={C.flare} />}
                      </div>
                    );
                  })}
                </div>
              ) : (
                <Empty title="No projection available">Projections appear for scheduled games when the props model is active.</Empty>
              )}
            </Panel>
          </div>

          <div className="grid gap-6 lg:grid-cols-2">
            <Panel>
              <PanelHeader eyebrow="Accountability" title={`Predicted vs actual: ${STAT_LABEL[stat] ?? stat}`} />
              <div className="p-2">
                {actualVsPred.length ? (
                  <EChart
                    height={260}
                    option={{
                      grid: { left: 36, right: 16, top: 30, bottom: 30 },
                      legend: { top: 0, textStyle: { color: C.mist4, fontSize: 11 } },
                      tooltip: { ...tooltip },
                      xAxis: { type: "category", data: actualVsPred.map((r) => r.start_time.slice(5, 10)), ...baseAxis },
                      yAxis: { type: "value", ...baseAxis },
                      series: [
                        { name: "Actual", type: "bar", data: actualVsPred.map((r) => r.actual), itemStyle: { color: "rgba(138,155,184,0.4)" } },
                        { name: "Projection", type: "line", data: actualVsPred.map((r) => r.predicted_value), lineStyle: { color: C.volt }, itemStyle: { color: C.volt } },
                        { name: "Line", type: "line", step: "middle", showSymbol: false, data: actualVsPred.map((r) => r.line), lineStyle: { color: C.gold, type: "dashed" } },
                      ],
                    }}
                  />
                ) : (
                  <Empty title="No settled prop forecasts for this stat" />
                )}
              </div>
            </Panel>
            <Panel>
              <PanelHeader eyebrow="Splits" title="Home / away & opponents" />
              <div className="grid grid-cols-2 gap-px bg-line/40">
                {Object.entries<any>(tr.splits ?? {}).map(([k, v]) => (
                  <div key={k} className="bg-ink-850 px-4 py-3">
                    <div className="label">{k} · n={v.n}</div>
                    <div className="font-mono text-sm text-mist">
                      {num(v.pts)} / {num(v.reb)} / {num(v.ast)} <span className="text-mist-500">· {num(v.minutes)} min</span>
                    </div>
                  </div>
                ))}
              </div>
              <div className="max-h-48 overflow-y-auto">
                {tr.by_opponent
                  ?.sort((a: any, b: any) => b.pts - a.pts)
                  .map((o: any) => (
                    <KV key={o.opponent} className="px-4" k={`vs ${o.opponent} (n=${o.n})`} v={`${num(o.pts)} pts · ${num(o.reb)} reb · ${num(o.ast)} ast`} />
                  ))}
              </div>
            </Panel>
          </div>
          <Panel>
            <PanelHeader eyebrow="Historical player props" title="Archived prop forecasts and results" />
            <div className="overflow-x-auto">
              <table className="w-full min-w-[700px] text-[12.5px]">
                <thead>
                  <tr className="border-b border-line/70">
                    {["Date", "Market", "Pick", "Line", "Prob", "Projection", "Actual", "Result"].map((h) => (
                      <th key={h} className="label px-3 py-2 text-left">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {(tr.prop_history ?? []).slice(0, 25).map((h: any, i: number) => (
                    <tr key={i} className="border-b border-line/40 font-mono tabular text-mist-300">
                      <td className="px-3 py-2">{h.date.slice(0, 10)}</td>
                      <td className="px-3 py-2 font-sans">{STAT_LABEL[h.market.replace("prop_", "")] ?? h.market}</td>
                      <td className="px-3 py-2 font-sans">{h.selection}</td>
                      <td className="px-3 py-2">{h.line}</td>
                      <td className="px-3 py-2 text-volt-300">{pct(h.prob, 0)}</td>
                      <td className="px-3 py-2">{num(h.projection)}</td>
                      <td className="px-3 py-2">{num(h.actual, 0)}</td>
                      <td className="px-3 py-2"><ResultBadge result={h.result} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {!tr.prop_history?.length && <Empty title="No prop forecasts archived yet" />}
            </div>
          </Panel>
        </>
      )}
    </div>
  );
}
