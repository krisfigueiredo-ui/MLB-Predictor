"use client";

import { useMemo, useState } from "react";

import { C, EChart, SERIES, baseAxis, tooltip } from "@/components/charts/EChart";
import { PlayerPortrait, TeamCrest } from "@/components/identity/identity";
import { Badge, Empty, PageHeader, Panel, PanelHeader, ResultBadge, Segmented, Skeleton, SourceStamp, Tabs, TabsContent, TabsList, TabsTrigger, Tip } from "@/components/ui/primitives";
import { useApi } from "@/lib/api";
import { cn, featureLabel, num, pct, signed } from "@/lib/format";
import type { Player, Team } from "@/lib/types";

export default function TrendsLab() {
  return (
    <div className="space-y-6">
      <PageHeader
        index="08"
        title="Trends Lab"
        subtitle="Interactive time-series, rolling averages, splits and market history. Every series shows its sample size and source; streaks are labelled descriptive unless they clear a statistical bar."
      />
      <Tabs defaultValue="team">
        <TabsList>
          <TabsTrigger value="team">Teams & schools</TabsTrigger>
          <TabsTrigger value="player">Players</TabsTrigger>
          <TabsTrigger value="league">League landscape</TabsTrigger>
          <TabsTrigger value="model">Features & correlations</TabsTrigger>
        </TabsList>
        <TabsContent value="team" className="mt-4">
          <TeamTrends />
        </TabsContent>
        <TabsContent value="player" className="mt-4">
          <PlayerTrends />
        </TabsContent>
        <TabsContent value="league" className="mt-4">
          <LeagueLandscape />
        </TabsContent>
        <TabsContent value="model" className="mt-4">
          <FeatureView />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function TeamPicker({ value, onChange }: { value: number | null; onChange: (id: number) => void }) {
  const [league, setLeague] = useState<"NBA" | "CBB">("NBA");
  const teams = useApi<Team[]>(`/api/teams?league=${league}`);
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Segmented size="sm" value={league} onChange={setLeague} options={[{ value: "NBA", label: "NBA" }, { value: "CBB", label: "CBB" }]} />
      <select value={value ?? ""} onChange={(e) => onChange(Number(e.target.value))} className="rounded-md border border-line bg-ink-900 px-2 py-1.5 text-xs text-mist-300">
        <option value="">Select {league === "NBA" ? "team" : "school"}…</option>
        {(teams.data ?? []).map((t) => (
          <option key={t.id} value={t.id}>
            {t.name}
          </option>
        ))}
      </select>
    </div>
  );
}

function TeamTrends() {
  const [id, setId] = useState<number | null>(null);
  const tid = id ?? 1;
  const tr = useApi<any>(`/api/trends/team/${tid}`);
  const team = useApi<any>(`/api/teams/${tid}`);
  const [metric, setMetric] = useState<"efficiency" | "pace" | "scoring">("efficiency");
  const games = tr.data?.games ?? [];
  const t: Team | undefined = team.data?.team;
  return (
    <div className="space-y-4">
      <Panel className="flex flex-wrap items-center justify-between gap-3 p-3">
        <div className="flex items-center gap-3">
          {t && <TeamCrest team={t} size={36} />}
          <div>
            <div className="font-display text-lg font-semibold text-mist">{t?.name ?? "…"}</div>
            <div className="text-[11px] text-mist-500">
              {tr.data?.season} · n = {tr.data?.n_season ?? 0} games this season
            </div>
          </div>
        </div>
        <TeamPicker value={id} onChange={setId} />
      </Panel>
      {tr.isLoading ? (
        <Skeleton className="h-72" />
      ) : games.length === 0 ? (
        <Panel>
          <Empty title="No completed games for this team yet" />
        </Panel>
      ) : (
        <>
          <div className="grid gap-4 md:grid-cols-3">
            {["5", "10", "20"].map((w) => {
              const b = tr.data.windows[w];
              return (
                <Panel key={w} className="p-4">
                  <div className="flex items-center justify-between">
                    <span className="label">Last {w}</span>
                    <Badge>n={b.n}</Badge>
                  </div>
                  <div className="mt-2 grid grid-cols-3 gap-2 text-center">
                    {[
                      ["ORtg", num(b.ortg)],
                      ["DRtg", num(b.drtg)],
                      ["Pace", num(b.pace)],
                      ["Margin", signed(b.margin)],
                      ["Total", num(b.total)],
                      ["1H tot", num(b.h1_total)],
                    ].map(([k, v]) => (
                      <div key={k}>
                        <div className="text-[10px] uppercase tracking-wider text-mist-500">{k}</div>
                        <div className="font-mono text-sm font-semibold text-mist">{v}</div>
                      </div>
                    ))}
                  </div>
                  <div className="mt-3 flex flex-wrap gap-2 text-[11px]">
                    {b.ats && (
                      <span className="rounded-md bg-ink-700 px-2 py-0.5 text-mist-300">
                        ATS {b.ats.cover}-{b.ats.fail}-{b.ats.push}
                      </span>
                    )}
                    {b.ou && (
                      <span className="rounded-md bg-ink-700 px-2 py-0.5 text-mist-300">
                        O/U {b.ou.over}-{b.ou.under}-{b.ou.push}
                      </span>
                    )}
                  </div>
                  {b.margin_vs_season && (
                    <div className={cn("mt-2 text-[10.5px]", b.margin_vs_season.significant ? "text-flare" : "text-mist-500")}>
                      {b.margin_vs_season.z != null && `z = ${num(b.margin_vs_season.z, 2)} · `}
                      {b.margin_vs_season.note}
                    </div>
                  )}
                </Panel>
              );
            })}
          </div>
          <Panel>
            <PanelHeader
              eyebrow="Game-by-game with 5-game rolling average"
              title="Time series"
              right={<Segmented size="sm" value={metric} onChange={setMetric} options={[{ value: "efficiency", label: "Efficiency" }, { value: "pace", label: "Pace" }, { value: "scoring", label: "Scoring" }]} />}
            />
            <div className="p-2">
              <EChart
                height={300}
                option={{
                  grid: { left: 40, right: 16, top: 30, bottom: 30 },
                  legend: { top: 0, textStyle: { color: C.mist4, fontSize: 11 } },
                  tooltip: { ...tooltip },
                  xAxis: { type: "category", data: games.map((g: any) => `${g.date.slice(5, 10)} ${g.home ? "v" : "@"}${g.opponent}`), ...baseAxis, axisLabel: { ...baseAxis.axisLabel, interval: Math.ceil(games.length / 8) } },
                  yAxis: { type: "value", scale: true, ...baseAxis },
                  series:
                    metric === "efficiency"
                      ? [
                          { name: "ORtg", type: "scatter", symbolSize: 5, data: games.map((g: any) => g.ortg), itemStyle: { color: C.volt, opacity: 0.45 } },
                          { name: "ORtg (r5)", type: "line", smooth: true, showSymbol: false, data: games.map((g: any) => g.ortg_r5), lineStyle: { color: C.volt, width: 2.5 } },
                          { name: "DRtg", type: "scatter", symbolSize: 5, data: games.map((g: any) => g.drtg), itemStyle: { color: C.flare, opacity: 0.45 } },
                          { name: "DRtg (r5)", type: "line", smooth: true, showSymbol: false, data: games.map((g: any) => g.drtg_r5), lineStyle: { color: C.flare, width: 2.5 } },
                        ]
                      : metric === "pace"
                        ? [
                            { name: "Possessions", type: "bar", data: games.map((g: any) => g.pace), itemStyle: { color: "rgba(34,211,238,0.35)" } },
                            { name: "Pace (r5)", type: "line", smooth: true, showSymbol: false, data: games.map((g: any) => g.pace_r5), lineStyle: { color: C.cyan, width: 2.5 } },
                          ]
                        : [
                            { name: "Total", type: "bar", data: games.map((g: any) => g.total), itemStyle: { color: "rgba(47,123,255,0.35)" } },
                            { name: "Market total", type: "line", step: "middle", showSymbol: false, data: games.map((g: any) => g.total_line ?? null), lineStyle: { color: C.gold, type: "dashed" } },
                            { name: "Margin", type: "line", showSymbol: true, symbolSize: 4, data: games.map((g: any) => g.margin), lineStyle: { color: C.gain, width: 1.5 }, yAxisIndex: 0 },
                          ],
                }}
              />
            </div>
            <div className="px-4 pb-3">
              <SourceStamp source={tr.data.source.join(", ")} demo={tr.data.is_demo} />
            </div>
          </Panel>
          <div className="grid gap-4 lg:grid-cols-2">
            <Panel>
              <PanelHeader eyebrow="Splits" title="Home / away / neutral" />
              <div className="grid grid-cols-3 gap-px bg-line/40">
                {Object.entries<any>(tr.data.splits).map(([k, v]) => (
                  <div key={k} className="bg-ink-850 p-4">
                    <div className="label">{k}</div>
                    <div className="mt-1 font-mono text-lg font-semibold text-mist">{signed(v.margin)}</div>
                    <div className="text-[11px] text-mist-500">
                      avg total {num(v.total)} · n={v.n}
                    </div>
                  </div>
                ))}
              </div>
            </Panel>
            <Panel>
              <PanelHeader eyebrow="Against the spread" title="Results vs pre-game market" />
              <div className="flex flex-wrap gap-1.5 p-4">
                {games.map((g: any) =>
                  g.ats ? (
                    <Tip key={g.game_id} content={`${g.date.slice(0, 10)} ${g.home ? "vs" : "@"} ${g.opponent}: margin ${g.margin}, line ${g.spread_line}`}>
                      <span className={cn("h-5 w-5 rounded", g.ats === "cover" ? "bg-gain/70" : g.ats === "fail" ? "bg-loss/60" : "bg-gold/60")} />
                    </Tip>
                  ) : null,
                )}
              </div>
              <div className="px-4 pb-3 text-[10.5px] text-mist-500">Green = covered, red = failed, gold = push. Uses the consensus line captured before tip-off.</div>
            </Panel>
          </div>
        </>
      )}
    </div>
  );
}

function PlayerTrends() {
  const players = useApi<Player[]>("/api/players?league=NBA");
  const [id, setId] = useState<number | null>(null);
  const pid = id ?? players.data?.[0]?.id ?? null;
  const tr = useApi<any>(pid ? `/api/trends/player/${pid}` : null);
  const pl = players.data?.find((p) => p.id === pid);
  const [stat, setStat] = useState("pts");
  const g = tr.data?.games ?? [];
  return (
    <div className="space-y-4">
      <Panel className="flex flex-wrap items-center justify-between gap-3 p-3">
        <div className="flex items-center gap-3">
          {pl && <PlayerPortrait player={pl} size={44} />}
          <div>
            <div className="font-display text-lg font-semibold text-mist">{pl?.name ?? "…"}</div>
            <div className="flex items-center gap-1.5 text-[11px] text-mist-500">
              {pl?.team && <TeamCrest team={pl.team} size={14} />} {pl?.team?.name}
            </div>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Segmented size="sm" value={stat} onChange={setStat} options={["pts", "reb", "ast", "minutes", "fg3a", "usage"].map((s) => ({ value: s, label: s.toUpperCase() }))} />
          <select value={pid ?? ""} onChange={(e) => setId(Number(e.target.value))} className="rounded-md border border-line bg-ink-900 px-2 py-1.5 text-xs text-mist-300">
            {(players.data ?? []).map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} ({p.team?.abbr})
              </option>
            ))}
          </select>
        </div>
      </Panel>
      {!tr.data ? (
        <Skeleton className="h-72" />
      ) : (
        <>
          <Panel>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[720px] text-[12.5px]">
                <thead>
                  <tr className="border-b border-line/70">
                    {["Window", "n", "MIN", "PTS", "REB", "AST", "3PM", "3PA", "FGA", "USG", "PRA"].map((h) => (
                      <th key={h} className="label px-3 py-2 text-left">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {["5", "10", "20", "season"].map((w) => {
                    const b = tr.data.windows[w];
                    return (
                      <tr key={w} className="border-b border-line/40 font-mono tabular text-mist-300">
                        <td className="px-3 py-2 font-sans text-mist">{w === "season" ? "Season" : `Last ${w}`}</td>
                        <td className="px-3 py-2 text-mist-500">{b.n}</td>
                        <td className="px-3 py-2">{num(b.minutes)}</td>
                        <td className="px-3 py-2 text-mist">{num(b.pts)}</td>
                        <td className="px-3 py-2">{num(b.reb)}</td>
                        <td className="px-3 py-2">{num(b.ast)}</td>
                        <td className="px-3 py-2">{num(b.fg3m)}</td>
                        <td className="px-3 py-2">{num(b.fg3a)}</td>
                        <td className="px-3 py-2">{num(b.fga)}</td>
                        <td className="px-3 py-2">{pct(b.usage)}</td>
                        <td className="px-3 py-2">{num(b.pra)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className={cn("px-4 py-2 text-[11px]", tr.data.pts_last10_vs_season?.significant ? "text-flare" : "text-mist-500")}>
              Points, last 10 vs season: {tr.data.pts_last10_vs_season?.note}
            </div>
          </Panel>
          <Panel>
            <PanelHeader eyebrow="Rolling averages (5 / 10 games)" title={`${stat.toUpperCase()} trend`} right={<SourceStamp source={tr.data.source.join(", ")} demo={tr.data.is_demo} />} />
            <div className="p-2">
              <EChart
                height={280}
                option={{
                  grid: { left: 36, right: 16, top: 30, bottom: 30 },
                  legend: { top: 0, textStyle: { color: C.mist4, fontSize: 11 } },
                  tooltip: { ...tooltip },
                  xAxis: { type: "category", data: g.map((x: any) => `${x.date.slice(5, 10)} ${x.opponent}`), ...baseAxis, axisLabel: { ...baseAxis.axisLabel, interval: Math.ceil(g.length / 8) } },
                  yAxis: { type: "value", scale: stat === "usage", ...baseAxis },
                  series: [
                    { name: stat, type: "bar", data: g.map((x: any) => x[stat]), itemStyle: { color: "rgba(47,123,255,0.35)", borderRadius: [2, 2, 0, 0] } },
                    ...(g[0]?.[`${stat}_r5`] !== undefined
                      ? [
                          { name: "5-game", type: "line" as const, smooth: true, showSymbol: false, data: g.map((x: any) => x[`${stat}_r5`]), lineStyle: { color: C.cyan, width: 2.5 } },
                          { name: "10-game", type: "line" as const, smooth: true, showSymbol: false, data: g.map((x: any) => x[`${stat}_r10`]), lineStyle: { color: C.flare, width: 2 } },
                        ]
                      : []),
                  ],
                }}
              />
            </div>
          </Panel>
          <div className="grid gap-4 lg:grid-cols-2">
            <Panel>
              <PanelHeader eyebrow="Matchup splits" title="By opponent (this season)" />
              <div className="max-h-72 overflow-y-auto">
                <table className="w-full text-[12.5px]">
                  <tbody>
                    {tr.data.by_opponent
                      .sort((a: any, b: any) => b.n - a.n)
                      .map((o: any) => (
                        <tr key={o.opponent} className="border-b border-line/40 font-mono tabular text-mist-300">
                          <td className="px-3 py-1.5 font-sans text-mist">{o.opponent}</td>
                          <td className="px-3 py-1.5 text-mist-500">n={o.n}</td>
                          <td className="px-3 py-1.5">{num(o.pts)} pts</td>
                          <td className="px-3 py-1.5">{num(o.reb)} reb</td>
                          <td className="px-3 py-1.5">{num(o.ast)} ast</td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
            </Panel>
            <Panel>
              <PanelHeader eyebrow="Prop outcome history" title="Archived prop forecasts" />
              <div className="max-h-72 overflow-y-auto">
                <table className="w-full text-[12.5px]">
                  <tbody>
                    {tr.data.prop_history.slice(0, 30).map((h: any, i: number) => (
                      <tr key={i} className="border-b border-line/40 font-mono tabular text-mist-300">
                        <td className="px-3 py-1.5 text-mist-500">{h.date.slice(5, 10)}</td>
                        <td className="px-3 py-1.5 font-sans">{h.market.replace("prop_", "").toUpperCase()}</td>
                        <td className="px-3 py-1.5">
                          {h.selection} {h.line}
                        </td>
                        <td className="px-3 py-1.5 text-volt-300">{pct(h.prob, 0)}</td>
                        <td className="px-3 py-1.5">proj {num(h.projection)}</td>
                        <td className="px-3 py-1.5">act {num(h.actual, 0)}</td>
                        <td className="px-3 py-1.5">
                          <ResultBadge result={h.result} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {!tr.data.prop_history.length && <Empty title="No archived prop forecasts" />}
              </div>
            </Panel>
          </div>
        </>
      )}
    </div>
  );
}

function LeagueLandscape() {
  const [league, setLeague] = useState<"NBA" | "CBB">("NBA");
  const t = useApi<any>(`/api/trends/league/${league}`);
  const rows = t.data?.rows ?? [];
  const paces = rows.map((r: any) => r.pace);
  const hist = useMemo(() => {
    if (!paces.length) return [];
    const lo = Math.floor(Math.min(...paces));
    const hi = Math.ceil(Math.max(...paces));
    const bins: { x: number; n: number }[] = [];
    for (let x = lo; x <= hi; x += 1) bins.push({ x, n: paces.filter((p: number) => p >= x && p < x + 1).length });
    return bins;
  }, [paces]);
  return (
    <div className="space-y-4">
      <Segmented value={league} onChange={setLeague} options={[{ value: "NBA", label: "NBA" }, { value: "CBB", label: "CBB" }]} />
      <div className="grid gap-4 lg:grid-cols-2">
        <Panel>
          <PanelHeader eyebrow="Distribution" title="Pace (possessions per game)" right={<Badge>n={rows.length} teams</Badge>} />
          <div className="p-2">
            <EChart
              height={260}
              option={{
                grid: { left: 32, right: 12, top: 16, bottom: 26 },
                tooltip: { ...tooltip },
                xAxis: { type: "category", data: hist.map((h) => h.x), ...baseAxis },
                yAxis: { type: "value", ...baseAxis },
                series: [{ type: "bar", data: hist.map((h) => h.n), itemStyle: { color: C.cyan, borderRadius: [3, 3, 0, 0] } }],
              }}
            />
          </div>
        </Panel>
        <Panel>
          <PanelHeader eyebrow="Leaders" title="Fastest adjusted pace & best offenses" />
          <div className="grid grid-cols-2 divide-x divide-line/50">
            {[
              ["pace", "Pace"],
              ["ortg", "Offensive rating"],
            ].map(([k, label]) => (
              <div key={k}>
                <div className="label px-3 pt-3">{label}</div>
                <ol className="p-2">
                  {[...rows]
                    .sort((a: any, b: any) => b[k] - a[k])
                    .slice(0, 8)
                    .map((r: any, i: number) => (
                      <li key={r.team_id} className="flex items-center justify-between rounded px-2 py-1 text-xs hover:bg-ink-800">
                        <span className="text-mist-300">
                          <span className="mr-2 font-mono text-mist-500">{i + 1}</span>
                          {r.name}
                        </span>
                        <span className="font-mono text-mist">{num(r[k])}</span>
                      </li>
                    ))}
                </ol>
              </div>
            ))}
          </div>
        </Panel>
      </div>
      <Panel>
        <PanelHeader eyebrow="Heatmap" title="Team four-factor profile (z-scores)" />
        <div className="p-2">
          <FourFactorHeatmap rows={rows.slice(0, league === "NBA" ? 30 : 40)} />
        </div>
      </Panel>
    </div>
  );
}

function FourFactorHeatmap({ rows }: { rows: any[] }) {
  const keys = ["ortg", "drtg", "net", "pace", "efg", "tov"];
  const z = (k: string, v: number) => {
    const xs = rows.map((r) => r[k]);
    const m = xs.reduce((a, b) => a + b, 0) / xs.length;
    const sd = Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length) || 1;
    const s = (v - m) / sd;
    return k === "drtg" || k === "tov" ? -s : s;
  };
  const data = rows.flatMap((r, i) => keys.map((k, j) => [j, i, Math.round(z(k, r[k]) * 100) / 100]));
  return (
    <EChart
      height={Math.max(300, rows.length * 18)}
      option={{
        grid: { left: 130, right: 20, top: 10, bottom: 30 },
        tooltip: { backgroundColor: "rgba(10,18,34,0.96)", borderColor: C.line, textStyle: { color: C.mist, fontSize: 12 }, formatter: (p: any) => `${rows[p.value[1]].name} · ${keys[p.value[0]]}: z=${p.value[2]}` },
        xAxis: { type: "category", data: ["ORtg", "DRtg (inv)", "Net", "Pace", "eFG%", "TOV% (inv)"], ...baseAxis },
        yAxis: { type: "category", data: rows.map((r) => r.name), ...baseAxis, axisLabel: { ...baseAxis.axisLabel, fontFamily: "var(--font-sans)" } },
        visualMap: { show: false, min: -2.2, max: 2.2, inRange: { color: ["#F43F5E", "#3a1a2b", "#0A1222", "#13305f", "#2F7BFF"] } },
        series: [{ type: "heatmap", data, itemStyle: { borderColor: "#050913", borderWidth: 1 } }],
      }}
    />
  );
}

function FeatureView() {
  const [league, setLeague] = useState<"NBA" | "CBB">("NBA");
  const corr = useApi<any>(`/api/trends/correlations/${league}`);
  const models = useApi<any[]>("/api/models");
  const mv = models.data?.find((m) => m.league === league && m.name === "game" && m.is_active);
  const fi = (mv?.metrics?.feature_importance ?? []).slice(0, 18);
  return (
    <div className="space-y-4">
      <Segmented value={league} onChange={setLeague} options={[{ value: "NBA", label: "NBA" }, { value: "CBB", label: "CBB" }]} />
      <div className="grid gap-4 lg:grid-cols-2">
        <Panel>
          <PanelHeader eyebrow={mv?.version ?? "model"} title="Feature importance (gain, margin + total residual models)" />
          <div className="p-2">
            <EChart
              height={420}
              option={{
                grid: { left: 170, right: 20, top: 10, bottom: 20 },
                tooltip: { ...tooltip, valueFormatter: (v: any) => (v as number).toFixed(3) },
                xAxis: { type: "value", ...baseAxis },
                yAxis: { type: "category", inverse: true, data: fi.map((f: any) => featureLabel(f.feature)), ...baseAxis, axisLabel: { ...baseAxis.axisLabel, fontFamily: "var(--font-sans)" } },
                series: [{ type: "bar", data: fi.map((f: any, i: number) => ({ value: f.importance, itemStyle: { color: SERIES[i % 2], borderRadius: [0, 3, 3, 0] } })) }],
              }}
            />
          </div>
        </Panel>
        <Panel>
          <PanelHeader eyebrow={`n = ${corr.data?.n ?? "…"} games`} title="Correlation matrix: pre-game features vs outcomes" />
          <div className="p-2">
            {corr.data ? (
              <EChart
                height={420}
                option={{
                  grid: { left: 110, right: 10, top: 10, bottom: 90 },
                  tooltip: { backgroundColor: "rgba(10,18,34,0.96)", borderColor: C.line, textStyle: { color: C.mist, fontSize: 12 }, formatter: (p: any) => `${corr.data.columns[p.value[0]]} × ${corr.data.columns[p.value[1]]}: ${p.value[2]}` },
                  xAxis: { type: "category", data: corr.data.columns.map(featureShort), ...baseAxis, axisLabel: { ...baseAxis.axisLabel, rotate: 45 } },
                  yAxis: { type: "category", data: corr.data.columns.map(featureShort), ...baseAxis },
                  visualMap: { show: false, min: -1, max: 1, inRange: { color: ["#F43F5E", "#0A1222", "#2F7BFF"] } },
                  series: [{ type: "heatmap", data: corr.data.matrix.flatMap((row: number[], i: number) => row.map((v, j) => [j, i, v])), label: { show: true, fontSize: 8.5, color: "#E6EDF7" } }],
                }}
              />
            ) : (
              <Skeleton className="h-96" />
            )}
          </div>
        </Panel>
      </div>
    </div>
  );
}

const featureShort = (f: string) => ({ y_margin: "Actual margin", y_total: "Actual total" } as Record<string, string>)[f] ?? featureLabel(f).replace("Efficiency baseline", "Baseline");
