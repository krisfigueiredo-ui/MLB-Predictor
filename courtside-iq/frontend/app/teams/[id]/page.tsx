"use client";

import Link from "next/link";
import { use } from "react";

import { C, EChart, baseAxis, tooltip } from "@/components/charts/EChart";
import { StatusPill } from "@/components/game/game";
import { PlayerPortrait, RosterBadge, TeamCrest } from "@/components/identity/identity";
import { Badge, DemoBadge, Empty, ErrorState, Panel, PanelHeader, Skeleton, Stat } from "@/components/ui/primitives";
import { useApi } from "@/lib/api";
import { num, signed } from "@/lib/format";

export default function TeamPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const q = useApi<any>(`/api/teams/${id}`);
  if (q.error) return <ErrorState error={q.error} />;
  if (!q.data) return <Skeleton className="h-[500px]" />;
  const t = q.data.team;
  const tr = q.data.trends;
  const w = tr.windows?.["10"];
  const games = tr.games ?? [];
  return (
    <div className="space-y-6">
      <Panel className="relative overflow-hidden">
        <div className="pointer-events-none absolute inset-0 opacity-35" style={{ background: `linear-gradient(110deg, ${t.primary}cc 0%, ${t.secondary}22 45%, transparent 70%)` }} />
        <div className="grid-bg pointer-events-none absolute inset-0 opacity-40" />
        <div className="relative flex flex-col gap-5 p-6 md:flex-row md:items-center">
          <TeamCrest team={t} size={110} />
          <div className="flex-1">
            <div className="flex items-center gap-2">
              <Badge tone={t.league === "NBA" ? "volt" : "cyan"}>{t.league}</Badge>
              <span className="text-xs text-mist-300">{t.conference_name ?? t.conference} {t.division ? `· ${t.division}` : ""}</span>
              <DemoBadge show={tr.is_demo} />
            </div>
            <h1 className="mt-1 font-display text-4xl font-semibold tracking-tight text-white">{t.location}</h1>
            <div className="text-lg text-mist-300">{t.nickname}</div>
            {t.venue && <div className="mt-1 text-xs text-mist-400">{t.venue}</div>}
          </div>
          {w && (
            <div className="grid grid-cols-4 gap-4 md:w-[480px]">
              <Stat label="ORtg L10" value={num(w.ortg)} />
              <Stat label="DRtg L10" value={num(w.drtg)} />
              <Stat label="Net L10" value={signed(w.ortg - w.drtg)} tone={w.ortg - w.drtg >= 0 ? "gain" : "loss"} />
              <Stat label="Pace L10" value={num(w.pace)} />
            </div>
          )}
        </div>
      </Panel>
      <div className="grid gap-6 xl:grid-cols-[1fr_380px]">
        <Panel>
          <PanelHeader eyebrow={`${tr.season ?? ""} · n=${tr.n_season ?? 0}`} title="Margin by game with 5-game rolling net rating" right={<Link href="/trends" className="text-xs text-volt-300 hover:underline">Trends Lab</Link>} />
          <div className="p-2">
            {games.length ? (
              <EChart
                height={280}
                option={{
                  grid: { left: 36, right: 16, top: 26, bottom: 30 },
                  legend: { top: 0, textStyle: { color: C.mist4, fontSize: 11 } },
                  tooltip: { ...tooltip },
                  xAxis: { type: "category", data: games.map((g: any) => `${g.date.slice(5, 10)} ${g.home ? "v" : "@"}${g.opponent}`), ...baseAxis, axisLabel: { ...baseAxis.axisLabel, interval: Math.ceil(games.length / 8) } },
                  yAxis: { type: "value", ...baseAxis },
                  series: [
                    { name: "Margin", type: "bar", data: games.map((g: any) => ({ value: g.margin, itemStyle: { color: g.margin >= 0 ? "rgba(34,197,94,0.6)" : "rgba(244,63,94,0.55)" } })) },
                    { name: "Net rtg (r5)", type: "line", smooth: true, showSymbol: false, data: games.map((g: any) => (g.ortg_r5 != null ? g.ortg_r5 - g.drtg_r5 : null)), lineStyle: { color: C.volt, width: 2.5 } },
                  ],
                }}
              />
            ) : (
              <Empty title="No completed games yet this season" />
            )}
          </div>
        </Panel>
        <Panel>
          <PanelHeader eyebrow="Schedule" title="Upcoming" />
          <ul className="divide-y divide-line/50">
            {q.data.upcoming.map((g: any) => {
              const opp = g.home.id === t.id ? g.away : g.home;
              return (
                <li key={g.id}>
                  <Link href={`/games/${g.id}`} className="flex items-center gap-3 px-4 py-2.5 hover:bg-volt/[0.04]">
                    <span className="w-6 text-xs text-mist-500">{g.home.id === t.id ? "vs" : "@"}</span>
                    <TeamCrest team={opp} size={22} />
                    <span className="flex-1 truncate text-sm text-mist">{opp.name}</span>
                    <StatusPill g={g} />
                  </Link>
                </li>
              );
            })}
            {!q.data.upcoming.length && <Empty title="No upcoming games" />}
          </ul>
        </Panel>
      </div>
      <Panel>
        <PanelHeader eyebrow="Roster" title={t.league === "NBA" ? "Players" : "Roster"} />
        {q.data.roster.length ? (
          <div className="grid gap-3 p-3 sm:grid-cols-2 lg:grid-cols-4">
            {q.data.roster.map((p: any) => (
              <Link key={p.id} href={`/players/${p.id}`} className="panel panel-hover flex items-center gap-3 p-3">
                <PlayerPortrait player={p} size={52} />
                <div className="min-w-0">
                  <div className="truncate font-medium text-mist">{p.name}</div>
                  <div className="text-xs text-mist-400">
                    {p.position} {p.jersey ? `· #${p.jersey}` : ""}
                  </div>
                  <RosterBadge player={p} />
                </div>
              </Link>
            ))}
          </div>
        ) : (
          <Empty title="No roster loaded">{t.league === "CBB" ? "College rosters load from a connected provider with NCAA coverage." : "Sync rosters from BALLDONTLIE to populate the full roster."}</Empty>
        )}
      </Panel>
    </div>
  );
}
