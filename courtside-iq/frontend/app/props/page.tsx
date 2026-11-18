"use client";

import Link from "next/link";
import { useMemo, useState } from "react";

import { C, EChart, baseAxis, tooltip } from "@/components/charts/EChart";
import { PropCard } from "@/components/game/game";
import { PlayerPortrait, RosterBadge, TeamCrest } from "@/components/identity/identity";
import { Empty, KV, PageHeader, Panel, PanelHeader, ProbBar, Segmented, Skeleton, SourceStamp, Stat } from "@/components/ui/primitives";
import { useApi } from "@/lib/api";
import { american, num, pct, signed, STAT_LABEL } from "@/lib/format";
import type { PropProjection } from "@/lib/types";

const STATS = ["pts", "reb", "ast", "fg3m", "stl", "blk", "pra"];

export default function PropsLab() {
  const q = useApi<{ generated_at: string; props: PropProjection[] }>("/api/props?league=NBA&hours=30");
  const [stat, setStat] = useState("pts");
  const [sort, setSort] = useState<"edge" | "proj" | "minutes">("edge");
  const [team, setTeam] = useState("ALL");
  const [sel, setSel] = useState<string | null>(null);
  const all = q.data?.props ?? [];
  const teams = useMemo(() => Array.from(new Set(all.map((p) => p.player?.team?.abbr).filter(Boolean))).sort() as string[], [all]);
  const list = useMemo(() => {
    const xs = all.filter((p) => team === "ALL" || p.player?.team?.abbr === team);
    const key = (p: PropProjection) => {
      const m = p.markets[stat];
      if (sort === "minutes") return p.minutes.mean;
      if (sort === "proj") return m.mean;
      return m.line != null ? Math.abs(m.mean - m.line) : -1 + m.mean / 1000;
    };
    return [...xs].sort((a, b) => key(b) - key(a));
  }, [all, stat, sort, team]);
  const selected = list.find((p) => `${p.player_id}-${p.game?.id}` === sel) ?? list[0];
  const hasLines = all.some((p) => p.markets.pts?.line != null);

  return (
    <div className="space-y-6">
      <PageHeader
        index="07"
        title="Player Props Lab"
        subtitle="Three-stage model: projected minutes → usage and per-minute opportunity → correlated count distributions. Probabilities, not just point projections."
        right={<SourceStamp at={q.data?.generated_at} demo={all.some((p) => p.game?.is_demo)} />}
      />
      <Panel className="flex flex-wrap items-center gap-3 p-3">
        <Segmented value={stat} onChange={setStat} options={STATS.map((s) => ({ value: s, label: s === "pra" ? "PRA" : STAT_LABEL[s] }))} />
        <Segmented value={sort} onChange={setSort} options={[{ value: "edge", label: "Largest gap" }, { value: "proj", label: "Projection" }, { value: "minutes", label: "Minutes" }]} />
        <select value={team} onChange={(e) => setTeam(e.target.value)} className="rounded-md border border-line bg-ink-900 px-2 py-1.5 text-xs text-mist-300">
          <option value="ALL">All teams</option>
          {teams.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
        {!hasLines && all.length > 0 && <span className="text-[11px] text-gold">No sportsbook prop lines posted yet for these games — showing model distributions only.</span>}
      </Panel>
      {q.isLoading && <Skeleton className="h-96" />}
      {!q.isLoading && all.length === 0 && (
        <Panel>
          <Empty title="No player projections in the next 30 hours">Projections require player game logs from a connected provider (or the demo dataset) and an active props model.</Empty>
        </Panel>
      )}
      {selected && (
        <div className="grid gap-6 xl:grid-cols-[1fr_440px]">
          <div className="grid content-start gap-3 md:grid-cols-2 2xl:grid-cols-3">
            {list.map((p) => (
              <PropCard key={`${p.player_id}-${p.game?.id}`} p={p} stat={stat} active={selected === p} onClick={() => setSel(`${p.player_id}-${p.game?.id}`)} />
            ))}
          </div>
          <PropDetail p={selected} stat={stat} />
        </div>
      )}
    </div>
  );
}

function PropDetail({ p, stat }: { p: PropProjection; stat: string }) {
  const m = p.markets[stat];
  const pl = p.player!;
  const tr = useApi<any>(`/api/trends/player/${p.player_id}`);
  const recent = (tr.data?.games ?? []).slice(-15);
  return (
    <div className="space-y-4 xl:sticky xl:top-[76px] xl:self-start">
      <Panel className="overflow-hidden">
        <div className="relative flex gap-4 p-4">
          <div className="pointer-events-none absolute inset-0 opacity-20" style={{ background: `linear-gradient(120deg, ${pl.team?.primary ?? "#2F7BFF"}, transparent 70%)` }} />
          <PlayerPortrait player={pl} size={92} className="relative" />
          <div className="relative min-w-0">
            <Link href={`/players/${pl.id}`} className="font-display text-xl font-semibold text-mist hover:text-volt-300">
              {pl.name}
            </Link>
            <div className="mt-0.5 flex items-center gap-1.5 text-xs text-mist-400">
              {pl.team && <TeamCrest team={pl.team} size={16} />} {pl.team?.name} · {pl.position} {pl.jersey ? `· #${pl.jersey}` : ""}
            </div>
            <RosterBadge player={pl} />
            {p.game && (
              <div className="mt-2 text-[11px] text-mist-500">
                {p.game.away.abbr} @ {p.game.home.abbr} · {new Date(p.game.start_time).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" })}
              </div>
            )}
          </div>
        </div>
        <div className="grid grid-cols-3 gap-3 border-t border-line/60 p-4">
          <Stat label={`${STAT_LABEL[stat]} proj`} value={num(m.mean)} tone="volt" sub={`median ${num(m.median, 0)} · sd ${num(m.sd)}`} />
          <Stat label="Line" value={m.line ?? "—"} sub={m.book ? `${m.book} · o${american(m.over_price)} u${american(m.under_price)}` : "not posted"} />
          <Stat label="80% range" value={`${num(m.p10, 0)}–${num(m.p90, 0)}`} />
        </div>
        {m.p_over != null && (
          <div className="space-y-2 border-t border-line/60 px-4 py-3">
            <ProbBar left={m.p_over} right={m.p_under ?? 0} push={m.p_push ?? 0} leftLabel={`Over ${pct(m.p_over)}`} rightLabel={`Under ${pct(m.p_under)}`} leftColor={C.volt} rightColor={C.flare} />
            <div className="grid grid-cols-2 gap-x-4">
              <KV k="EV over / under" v={`${signed((m.ev_over ?? 0) * 100, 1)}% / ${signed((m.ev_under ?? 0) * 100, 1)}%`} />
              <KV k="Model-only mean" v={num(m.model_only_mean)} />
            </div>
            <p className="text-[10.5px] text-mist-500">When a line exists the distribution is anchored 50/50 between the model mean and the line (documented prior); the pure model mean is shown for transparency.</p>
          </div>
        )}
      </Panel>
      <Panel>
        <PanelHeader eyebrow="Probability distribution" title={`${STAT_LABEL[stat]} outcomes`} />
        <div className="p-2">
          <EChart
            height={200}
            option={{
              grid: { left: 36, right: 10, top: 16, bottom: 24 },
              tooltip: { ...tooltip, valueFormatter: (v: any) => `${(v * 100).toFixed(1)}%` },
              xAxis: { type: "category", data: m.pmf.map((x) => x.x), ...baseAxis },
              yAxis: { type: "value", ...baseAxis, axisLabel: { ...baseAxis.axisLabel, formatter: (v: number) => `${Math.round(v * 100)}%` } },
              series: [
                {
                  type: "bar",
                  data: m.pmf.map((x) => ({ value: x.p, itemStyle: { color: m.line != null ? (x.x > m.line ? C.volt : C.flare) : C.volt, opacity: 0.9, borderRadius: [2, 2, 0, 0] } })),
                },
              ],
            }}
          />
        </div>
      </Panel>
      <div className="grid grid-cols-2 gap-4">
        <Panel>
          <PanelHeader eyebrow="Stage 1" title="Minutes" />
          <div className="space-y-1 px-4 py-3">
            <KV k="Expected" v={num(p.minutes.mean)} />
            <KV k="SD" v={num(p.minutes.sd)} />
            <KV k="10th–90th" v={`${num(p.minutes.p10, 0)}–${num(p.minutes.p90, 0)}`} />
            <KV k="Blowout risk (|spread|)" v={num(Math.abs(p.blowout_risk))} />
          </div>
        </Panel>
        <Panel>
          <PanelHeader eyebrow="Correlation" title="Simulated stats" />
          <div className="p-1">
            <EChart
              height={150}
              option={{
                grid: { left: 40, right: 6, top: 6, bottom: 22 },
                xAxis: { type: "category", data: p.correlation.keys, ...baseAxis },
                yAxis: { type: "category", data: p.correlation.keys, ...baseAxis },
                visualMap: { show: false, min: -0.2, max: 1, inRange: { color: ["#0A1222", "#1F5FE0", "#22D3EE"] } },
                series: [
                  {
                    type: "heatmap",
                    data: p.correlation.matrix.flatMap((row, i) => row.map((v, j) => [j, i, Math.round(v * 100) / 100])),
                    label: { show: true, color: "#fff", fontSize: 9.5 },
                  },
                ],
              }}
            />
          </div>
        </Panel>
      </div>
      <Panel>
        <PanelHeader eyebrow="Recent form" title={`Last ${recent.length} games`} right={<SourceStamp source={tr.data?.source?.join(", ")} />} />
        <div className="p-2">
          {recent.length ? (
            <EChart
              height={170}
              option={{
                grid: { left: 32, right: 10, top: 20, bottom: 24 },
                tooltip: { ...tooltip },
                xAxis: { type: "category", data: recent.map((g: any) => g.opponent), ...baseAxis },
                yAxis: { type: "value", ...baseAxis },
                series: [
                  { type: "bar", name: stat, data: recent.map((g: any) => g[stat]), itemStyle: { color: "rgba(47,123,255,0.55)", borderRadius: [2, 2, 0, 0] } },
                  ...(m.line != null ? [{ type: "line" as const, name: "line", data: recent.map(() => m.line), showSymbol: false, lineStyle: { color: C.gold, type: "dashed" as const } }] : []),
                ],
              }}
            />
          ) : (
            <Skeleton className="h-40" />
          )}
        </div>
      </Panel>
    </div>
  );
}
