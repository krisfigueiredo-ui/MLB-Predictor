"use client";

import { createColumnHelper } from "@tanstack/react-table";
import Link from "next/link";
import { useMemo, useState } from "react";

import { C, EChart, baseAxis } from "@/components/charts/EChart";
import { MatchupCard, StatusPill } from "@/components/game/game";
import { PlayerPortrait, RosterBadge, TeamCrest, TeamName } from "@/components/identity/identity";
import { DataTable } from "@/components/ui/DataTable";
import { Badge, Empty, PageHeader, Panel, PanelHeader, Skeleton, SourceStamp, Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/primitives";
import { useApi } from "@/lib/api";
import { num, pct } from "@/lib/format";
import type { BoardRow, Game, League, Player, Team } from "@/lib/types";

interface TableRow {
  team_id: number;
  abbr: string;
  name: string;
  conference: string | null;
  games: number;
  wins: number;
  losses: number;
  ortg: number;
  drtg: number;
  net: number;
  pace: number;
  efg: number;
  tov: number;
  season: string;
}

const col = createColumnHelper<TableRow>();

export function LeagueCenter({ league }: { league: League }) {
  const isNBA = league === "NBA";
  const [day, setDay] = useState<string>("");
  const board = useApi<{ generated_at: string; demo: boolean; games: BoardRow[] }>(`/api/board?league=${league}&hours=40`, { refetchInterval: 60_000 });
  const schedule = useApi<Game[]>(`/api/games?league=${league}${day ? `&date=${day}` : ""}&days=2`);
  const table = useApi<{ rows: TableRow[]; source: string }>(`/api/trends/league/${league}`);
  const teams = useApi<Team[]>(`/api/teams?league=${league}`);
  const confs = useApi<any[]>(isNBA ? null : "/api/conferences");
  const players = useApi<Player[]>(isNBA ? `/api/players?league=${league}` : null);
  const teamMap = useMemo(() => Object.fromEntries((teams.data ?? []).map((t) => [t.id, t])), [teams.data]);

  const columns = useMemo(
    () => [
      col.accessor("name", {
        header: "Team",
        cell: (c) => (teamMap[c.row.original.team_id] ? <TeamName team={teamMap[c.row.original.team_id]} size={20} /> : c.getValue()),
      }),
      ...(isNBA ? [] : [col.accessor("conference", { header: "Conf", cell: (c) => <Badge>{c.getValue()}</Badge> })]),
      col.accessor((r) => `${r.wins}-${r.losses}`, { id: "record", header: "W-L" }),
      col.accessor("ortg", { header: "ORtg", cell: (c) => num(c.getValue()), meta: { align: "right" } }),
      col.accessor("drtg", { header: "DRtg", cell: (c) => num(c.getValue()), meta: { align: "right" } }),
      col.accessor("net", {
        header: "Net",
        cell: (c) => <span className={c.getValue() >= 0 ? "text-gain" : "text-loss"}>{num(c.getValue())}</span>,
        meta: { align: "right" },
      }),
      col.accessor("pace", { header: "Pace", cell: (c) => num(c.getValue()), meta: { align: "right" } }),
      col.accessor("efg", { header: "eFG%", cell: (c) => pct(c.getValue()), meta: { align: "right" } }),
      col.accessor("tov", { header: "TOV%", cell: (c) => pct(c.getValue()), meta: { align: "right" } }),
      col.accessor("games", { header: "GP", meta: { align: "right" } }),
    ],
    [teamMap, isNBA],
  );

  const games = board.data?.games ?? [];
  return (
    <div className="space-y-6">
      <PageHeader
        index={isNBA ? "02" : "03"}
        title={isNBA ? "NBA Game Center" : "College Basketball Center"}
        subtitle={
          isNBA
            ? "Schedules, live games, projections, efficiency standings and matchup analytics for all 30 franchises."
            : "Division I schools by conference: schedules, adjusted efficiency, sample-size-aware projections and neutral-site handling."
        }
        right={<SourceStamp source={table.data?.source} at={board.data?.generated_at} demo={board.data?.demo} />}
      />
      <Tabs defaultValue="slate">
        <TabsList>
          <TabsTrigger value="slate">Slate & projections</TabsTrigger>
          <TabsTrigger value="schedule">Schedule</TabsTrigger>
          <TabsTrigger value="table">Efficiency standings</TabsTrigger>
          <TabsTrigger value="teams">{isNBA ? "Teams" : "Schools & conferences"}</TabsTrigger>
          {isNBA && <TabsTrigger value="players">Players</TabsTrigger>}
        </TabsList>

        <TabsContent value="slate" className="mt-4">
          <div className="grid gap-4 md:grid-cols-2 2xl:grid-cols-3">
            {board.isLoading && Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-[250px]" />)}
            {games.map((r, i) => (
              <MatchupCard key={r.game.id} row={r} index={i} />
            ))}
          </div>
          {!board.isLoading && games.length === 0 && (
            <Panel>
              <Empty title={`No ${league} games in the next 40 hours`} />
            </Panel>
          )}
        </TabsContent>

        <TabsContent value="schedule" className="mt-4">
          <Panel>
            <PanelHeader
              title="Schedule"
              eyebrow="Two-day window"
              right={<input type="date" value={day} onChange={(e) => setDay(e.target.value)} className="rounded-md border border-line bg-ink-900 px-2 py-1 text-xs text-mist-300" />}
            />
            <ul className="divide-y divide-line/50">
              {(schedule.data ?? []).map((g) => (
                <li key={g.id}>
                  <Link href={`/games/${g.id}`} className="grid grid-cols-[1fr_auto] items-center gap-3 px-4 py-2.5 hover:bg-volt/[0.04] md:grid-cols-[110px_1fr_auto_auto]">
                    <span className="hidden font-mono text-[11px] text-mist-500 md:block">{new Date(g.start_time).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" })}</span>
                    <span className="flex min-w-0 items-center gap-2 text-sm">
                      <TeamCrest team={g.away} size={20} />
                      <span className="truncate text-mist">{g.away.name}</span>
                      <span className="font-mono text-mist-400">{g.away_score ?? ""}</span>
                      <span className="text-mist-500">{g.neutral ? "vs" : "@"}</span>
                      <TeamCrest team={g.home} size={20} />
                      <span className="truncate text-mist">{g.home.name}</span>
                      <span className="font-mono text-mist-400">{g.home_score ?? ""}</span>
                    </span>
                    <span className="hidden md:block">{g.is_demo && <Badge tone="flare">demo</Badge>}</span>
                    <StatusPill g={g} />
                  </Link>
                </li>
              ))}
              {schedule.isLoading && <Skeleton className="m-4 h-40" />}
              {!schedule.isLoading && !schedule.data?.length && <Empty title="No games on this date" />}
            </ul>
          </Panel>
        </TabsContent>

        <TabsContent value="table" className="mt-4 space-y-4">
          <Panel>
            <PanelHeader title="Offense vs defense" eyebrow={`Season to date · ${table.data?.rows?.[0]?.season ?? ""}`} />
            {table.data ? (
              <EChart
                height={340}
                option={{
                  grid: { left: 48, right: 20, top: 20, bottom: 40 },
                  tooltip: {
                    trigger: "item",
                    backgroundColor: "rgba(10,18,34,0.96)",
                    borderColor: C.line,
                    textStyle: { color: C.mist, fontSize: 12 },
                    formatter: (p: any) => `${p.data.name}<br/>ORtg ${p.value[0].toFixed(1)} · DRtg ${p.value[1].toFixed(1)}`,
                  },
                  xAxis: { type: "value", scale: true, name: "Offensive rating (pts/100)", nameLocation: "middle", nameGap: 26, ...baseAxis },
                  yAxis: { type: "value", scale: true, inverse: true, name: "Defensive rating (better ↑)", ...baseAxis },
                  series: [
                    {
                      type: "scatter",
                      symbolSize: isNBA ? 14 : 9,
                      data: table.data.rows.map((r) => ({
                        value: [r.ortg, r.drtg],
                        name: r.name,
                        itemStyle: { color: teamMap[r.team_id]?.primary === "#000000" ? C.mist4 : teamMap[r.team_id]?.primary ?? C.volt, borderColor: "#fff", borderWidth: 0.6 },
                        label: { show: isNBA, formatter: r.abbr, position: "top", color: C.mist4, fontSize: 9.5 },
                      })),
                    },
                  ],
                }}
              />
            ) : (
              <Skeleton className="m-4 h-72" />
            )}
          </Panel>
          <Panel>
            {table.data ? <DataTable data={table.data.rows} columns={columns as any} pageSize={isNBA ? 30 : 25} searchable initialSort={[{ id: "net", desc: true }]} /> : <Skeleton className="m-4 h-64" />}
            <div className="px-4 pb-3">
              <SourceStamp source="team_game_stats · possessions = FGA − ORB + TOV + 0.44·FTA" />
            </div>
          </Panel>
        </TabsContent>

        <TabsContent value="teams" className="mt-4">
          {isNBA ? (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-5">
              {(teams.data ?? []).map((t) => (
                <TeamTile key={t.id} t={t} />
              ))}
            </div>
          ) : (
            <div className="space-y-5">
              {(confs.data ?? []).map((c) => (
                <Panel key={c.id}>
                  <PanelHeader title={c.name} eyebrow={c.short} right={<Badge tone="cyan">prior strength {c.strength > 0 ? "+" : ""}{c.strength}</Badge>} />
                  <div className="grid gap-2 p-3 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-6">
                    {c.teams.map((t: Team) => (
                      <TeamTile key={t.id} t={t} compact />
                    ))}
                  </div>
                </Panel>
              ))}
              {confs.isLoading && <Skeleton className="h-64" />}
            </div>
          )}
        </TabsContent>

        {isNBA && (
          <TabsContent value="players" className="mt-4">
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
              {(players.data ?? []).map((p) => (
                <Link key={p.id} href={`/players/${p.id}`} className="panel panel-hover flex items-center gap-3 p-3">
                  <PlayerPortrait player={p} size={56} />
                  <div className="min-w-0">
                    <div className="truncate font-display text-[15px] font-semibold text-mist">{p.name}</div>
                    <div className="flex items-center gap-1.5 text-xs text-mist-400">
                      {p.team && <TeamCrest team={p.team} size={14} ring={false} />}
                      {p.team?.name}
                    </div>
                    <div className="mt-0.5 flex items-center gap-2 text-[11px] text-mist-500">
                      <span>
                        {p.position} {p.jersey ? `· #${p.jersey}` : ""}
                      </span>
                      <RosterBadge player={p} />
                    </div>
                  </div>
                </Link>
              ))}
            </div>
          </TabsContent>
        )}
      </Tabs>
      {!isNBA && (
        <p className="text-xs text-mist-500">
          College rosters turn over every season, so no college players are bundled. Individual CBB player data appears once a provider with NCAA coverage (e.g. BALLDONTLIE NCAAB tier) is
          connected.
        </p>
      )}
    </div>
  );
}

function TeamTile({ t, compact }: { t: Team; compact?: boolean }) {
  return (
    <Link href={`/teams/${t.id}`} className="panel panel-hover group relative flex items-center gap-3 overflow-hidden p-3">
      <div className="pointer-events-none absolute -right-6 -top-6 h-20 w-20 rounded-full opacity-20 blur-xl" style={{ background: t.primary }} />
      <TeamCrest team={t} size={compact ? 32 : 40} />
      <div className="min-w-0">
        <div className="truncate font-display text-sm font-semibold text-mist">{t.location}</div>
        <div className="truncate text-[11px] text-mist-400">{t.nickname}</div>
        {!compact && <div className="truncate text-[10.5px] text-mist-500">{t.division ? `${t.conference} · ${t.division}` : t.conference}</div>}
      </div>
      <div className="ml-auto flex gap-1">
        <span className="h-3 w-3 rounded-full border border-white/10" style={{ background: t.primary }} />
        <span className="h-3 w-3 rounded-full border border-white/10" style={{ background: t.secondary }} />
      </div>
    </Link>
  );
}
