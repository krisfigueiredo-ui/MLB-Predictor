"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { createColumnHelper } from "@tanstack/react-table";
import { Download, Plus, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";

import { C, EChart, baseAxis, tooltip } from "@/components/charts/EChart";
import { TeamCrest } from "@/components/identity/identity";
import { DataTable } from "@/components/ui/DataTable";
import { Badge, Button, Empty, PageHeader, Panel, PanelHeader, ResultBadge, Segmented, Skeleton, Stat, Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/primitives";
import { api, exportUrl, useApi } from "@/lib/api";
import { american, cn, dateShort, MARKET_LABEL, num, pct, signed, spreadLine } from "@/lib/format";
import type { Game, PerfBlock, PredictionRow } from "@/lib/types";

export default function PicksTracker() {
  const [league, setLeague] = useState<"ALL" | "NBA" | "CBB">("ALL");
  const lq = league === "ALL" ? "" : `league=${league}`;
  return (
    <div className="space-y-6">
      <PageHeader
        index="09"
        title="Picks Tracker"
        subtitle="Every model forecast is frozen with its timestamp, model version, line and price, then graded against final results. Alongside it: your own picks journal. Nothing here places wagers."
        right={<Segmented value={league} onChange={setLeague} options={[{ value: "ALL", label: "All" }, { value: "NBA", label: "NBA" }, { value: "CBB", label: "CBB" }]} />}
      />
      <Tabs defaultValue="performance">
        <TabsList>
          <TabsTrigger value="performance">Performance</TabsTrigger>
          <TabsTrigger value="archive">Prediction archive</TabsTrigger>
          <TabsTrigger value="journal">My picks journal</TabsTrigger>
          <TabsTrigger value="diagnostics">Learning from mistakes</TabsTrigger>
        </TabsList>
        <TabsContent value="performance" className="mt-4">
          <Performance lq={lq} />
        </TabsContent>
        <TabsContent value="archive" className="mt-4">
          <Archive lq={lq} />
        </TabsContent>
        <TabsContent value="journal" className="mt-4">
          <Journal />
        </TabsContent>
        <TabsContent value="diagnostics" className="mt-4">
          <Diagnostics lq={lq} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function Performance({ lq }: { lq: string }) {
  const s = useApi<any>(`/api/performance/summary${lq ? `?${lq}` : ""}`);
  const [by, setBy] = useState<"market" | "team" | "player" | "conference">("market");
  const b = useApi<any[]>(`/api/performance/breakdown?by=${by}${lq ? `&${lq}` : ""}`);
  if (!s.data) return <Skeleton className="h-96" />;
  const t: PerfBlock = s.data.total;
  if (!t?.n) return <Panel><Empty title="No settled pre-game predictions yet" /></Panel>;
  const markets = Object.entries<PerfBlock>(s.data.by_market_detail ?? {});
  return (
    <div className="space-y-4">
      {s.data.is_demo && <div className="rounded-lg border border-flare/30 bg-flare/5 px-3 py-2 text-xs text-flare">These results grade a walk-forward backtest on synthetic demo games and demo odds. They describe the pipeline, not real-world accuracy.</div>}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-8">
        {[
          ["Total", t.n.toLocaleString()],
          ["Correct", t.wins.toLocaleString()],
          ["Incorrect", t.losses.toLocaleString()],
          ["Pushes", t.pushes],
        ].map(([k, v]) => (
          <Panel key={k as string} className="p-4">
            <Stat label={k} value={v} />
          </Panel>
        ))}
        <Panel className="p-4">
          <Stat label="Win %" value={pct(t.win_pct)} sub={`CI ${pct(t.win_pct_ci[0], 0)}–${pct(t.win_pct_ci[1], 0)}`} tone="volt" />
        </Panel>
        <Panel className="p-4">
          <Stat label="Avg predicted" value={pct(t.avg_pred_prob)} hint="If calibrated, this should match Win %." />
        </Panel>
        <Panel className="p-4">
          <Stat label="Brier / log loss" value={num(t.brier, 3)} sub={`log loss ${num(t.log_loss, 3)}`} />
        </Panel>
        <Panel className="p-4">
          <Stat label="Hypothetical units" value={signed(t.units, 1)} sub={`ROI ${pct(t.roi, 1)} · ${t.priced_n} priced`} tone={(t.units ?? 0) >= 0 ? "gain" : "loss"} hint="1 unit flat stake at the archived price, only where a valid price and settlement exist." />
        </Panel>
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <Panel>
          <PanelHeader eyebrow="Calibration" title="Predicted probability vs observed hit rate" />
          <div className="p-2">
            <EChart
              height={300}
              option={{
                grid: { left: 44, right: 16, top: 16, bottom: 40 },
                tooltip: { trigger: "item", backgroundColor: "rgba(10,18,34,0.96)", borderColor: C.line, textStyle: { color: C.mist, fontSize: 12 }, formatter: (p: any) => (p.seriesType === "scatter" ? `pred ${(p.value[0] * 100).toFixed(1)}% · obs ${(p.value[1] * 100).toFixed(1)}% · n=${p.value[2]}` : "") },
                xAxis: { type: "value", min: 0.3, max: 0.9, name: "Predicted", nameLocation: "middle", nameGap: 26, ...baseAxis, axisLabel: { ...baseAxis.axisLabel, formatter: (v: number) => `${Math.round(v * 100)}%` } },
                yAxis: { type: "value", min: 0.2, max: 1, name: "Observed", ...baseAxis, axisLabel: { ...baseAxis.axisLabel, formatter: (v: number) => `${Math.round(v * 100)}%` } },
                series: [
                  { type: "line", data: [[0.3, 0.3], [0.9, 0.9]], showSymbol: false, lineStyle: { color: C.mist5, type: "dashed" }, silent: true },
                  {
                    type: "scatter",
                    data: s.data.calibration.map((c: any) => [c.mean_pred, c.observed, c.n]),
                    symbolSize: (v: number[]) => Math.max(6, Math.min(30, Math.sqrt(v[2]) * 1.2)),
                    itemStyle: { color: C.volt, opacity: 0.85, borderColor: "#fff", borderWidth: 0.5 },
                  },
                ],
              }}
            />
          </div>
          <div className="px-4 pb-3 text-[11px] text-mist-500">Bubble size ∝ √n. ECE {num(t.ece, 3)}. Points below the diagonal indicate overconfidence.</div>
        </Panel>
        <Panel>
          <PanelHeader eyebrow="By market" title="Hit rate with 95% intervals" />
          <div className="p-2">
            <EChart
              height={300}
              option={{
                grid: { left: 100, right: 30, top: 10, bottom: 24 },
                tooltip: { ...tooltip, trigger: "axis" },
                xAxis: { type: "value", min: 0.3, max: 0.8, ...baseAxis, axisLabel: { ...baseAxis.axisLabel, formatter: (v: number) => `${Math.round(v * 100)}%` } },
                yAxis: { type: "category", data: markets.map(([k]) => MARKET_LABEL[k] ?? k), ...baseAxis, axisLabel: { ...baseAxis.axisLabel, fontFamily: "var(--font-sans)" } },
                series: [
                  { name: "Hit rate", type: "bar", data: markets.map(([, v]) => v.win_pct), itemStyle: { color: C.volt, borderRadius: [0, 3, 3, 0] }, barWidth: 10 },
                  { name: "Avg predicted", type: "scatter", data: markets.map(([, v]) => v.avg_pred_prob), symbol: "diamond", symbolSize: 10, itemStyle: { color: C.gold } },
                  {
                    type: "custom",
                    name: "95% CI",
                    renderItem: (_: any, api: any) => {
                      const i = api.value(0);
                      const lo = api.coord([api.value(1), i]);
                      const hi = api.coord([api.value(2), i]);
                      return { type: "line", shape: { x1: lo[0], y1: lo[1], x2: hi[0], y2: hi[1] }, style: { stroke: C.mist4, lineWidth: 1.5 } };
                    },
                    data: markets.map(([, v], i) => [i, v.win_pct_ci[0], v.win_pct_ci[1]]),
                    encode: { x: [1, 2], y: 0 },
                  } as any,
                ],
              }}
            />
          </div>
          <div className="px-4 pb-3 text-[11px] text-mist-500">Gold diamond = average predicted probability. Sample sizes: {markets.map(([k, v]) => `${MARKET_LABEL[k] ?? k} ${v.decided}`).join(" · ")}</div>
        </Panel>
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <Panel>
          <PanelHeader eyebrow="Rolling" title={`Hit rate (rolling ${s.data.rolling_window ?? ""}) & cumulative units`} />
          <div className="p-2">
            <EChart
              height={260}
              option={{
                grid: { left: 40, right: 44, top: 28, bottom: 26 },
                legend: { top: 0, textStyle: { color: C.mist4, fontSize: 11 } },
                tooltip: { ...tooltip },
                xAxis: { type: "category", data: s.data.cumulative_units.map((r: any) => r.t.slice(5, 10)), ...baseAxis },
                yAxis: [
                  { type: "value", ...baseAxis, name: "units" },
                  { type: "value", min: 0.3, max: 0.8, ...baseAxis, axisLabel: { ...baseAxis.axisLabel, formatter: (v: number) => `${Math.round(v * 100)}%` } },
                ],
                series: [
                  { name: "Cumulative units", type: "line", showSymbol: false, data: s.data.cumulative_units.map((r: any) => r.units), lineStyle: { color: C.gain, width: 2 }, areaStyle: { color: "rgba(34,197,94,0.08)" } },
                  { name: "Rolling hit rate", type: "line", yAxisIndex: 1, showSymbol: false, data: s.data.rolling.map((r: any) => r.rate), lineStyle: { color: C.cyan, width: 1.5 } },
                ],
              }}
            />
          </div>
        </Panel>
        <Panel>
          <PanelHeader eyebrow="Monthly" title="Performance by month" />
          <table className="w-full text-[12.5px]">
            <thead>
              <tr className="border-b border-line/70">
                {["Month", "n", "Win %", "Avg pred", "Brier", "Units"].map((h) => (
                  <th key={h} className="label px-3 py-2 text-left">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {s.data.monthly.map((m: any) => (
                <tr key={m.month} className="border-b border-line/40 font-mono tabular text-mist-300">
                  <td className="px-3 py-2 text-mist">{m.month}</td>
                  <td className="px-3 py-2">{m.decided}</td>
                  <td className="px-3 py-2">{pct(m.win_pct)}</td>
                  <td className="px-3 py-2">{pct(m.avg_pred_prob)}</td>
                  <td className="px-3 py-2">{num(m.brier, 3)}</td>
                  <td className={cn("px-3 py-2", (m.units ?? 0) >= 0 ? "text-gain" : "text-loss")}>{signed(m.units, 1)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="grid grid-cols-2 gap-px border-t border-line/60 bg-line/40">
            {Object.entries<PerfBlock>(s.data.over_under ?? {}).map(([k, v]) => (
              <div key={k} className="bg-ink-850 px-4 py-3">
                <div className="label">{k} selections</div>
                <div className="font-mono text-sm text-mist">
                  {pct(v.win_pct)} <span className="text-[11px] text-mist-500">n={v.decided}</span>
                </div>
              </div>
            ))}
          </div>
        </Panel>
      </div>
      <Panel>
        <PanelHeader
          eyebrow="Accuracy breakdown"
          title={`By ${by}`}
          right={<Segmented size="sm" value={by} onChange={setBy} options={[{ value: "market", label: "Market" }, { value: "team", label: "NBA team / school" }, { value: "player", label: "Player" }, { value: "conference", label: "Conference" }]} />}
        />
        <BreakdownTable rows={b.data ?? []} loading={b.isLoading} />
      </Panel>
    </div>
  );
}

function BreakdownTable({ rows, loading }: { rows: any[]; loading: boolean }) {
  const col = createColumnHelper<any>();
  const columns = [
    col.accessor("key", { header: "Group", cell: (c) => <span className="font-sans text-mist">{MARKET_LABEL[c.getValue()] ?? c.getValue()}</span> }),
    col.accessor("decided", { header: "n", meta: { align: "right" } }),
    col.accessor("win_pct", { header: "Win %", cell: (c) => pct(c.getValue()), meta: { align: "right" } }),
    col.accessor((r) => r.win_pct_ci?.[1] - r.win_pct_ci?.[0], { id: "ci", header: "CI width", cell: (c) => pct(c.getValue(), 0), meta: { align: "right" } }),
    col.accessor("avg_pred_prob", { header: "Avg pred", cell: (c) => pct(c.getValue()), meta: { align: "right" } }),
    col.accessor("brier", { header: "Brier", cell: (c) => num(c.getValue(), 3), meta: { align: "right" } }),
    col.accessor("units", { header: "Units", cell: (c) => <span className={(c.getValue() ?? 0) >= 0 ? "text-gain" : "text-loss"}>{signed(c.getValue(), 1)}</span>, meta: { align: "right" } }),
  ];
  if (loading) return <Skeleton className="m-4 h-48" />;
  return <DataTable data={rows} columns={columns} pageSize={12} searchable dense initialSort={[{ id: "decided", desc: true }]} />;
}

function Archive({ lq }: { lq: string }) {
  const [market, setMarket] = useState("");
  const [result, setResult] = useState("");
  const q = useApi<PredictionRow[]>(`/api/predictions?limit=1500${lq ? `&${lq}` : ""}${market ? `&market=${market}` : ""}${result ? `&result=${result}` : ""}`);
  const col = createColumnHelper<PredictionRow>();
  const columns = useMemo(
    () => [
      col.accessor("start_time", { header: "Game date", cell: (c) => dateShort(c.getValue()) }),
      col.accessor((r) => `${r.away.abbr} @ ${r.home.abbr}`, {
        id: "game",
        header: "Game",
        cell: (c) => (
          <span className="flex items-center gap-1">
            <TeamCrest team={c.row.original.away} size={15} />
            <TeamCrest team={c.row.original.home} size={15} />
            <span className="ml-1 text-mist">{c.getValue()}</span>
          </span>
        ),
      }),
      col.accessor("league", { header: "Lg" }),
      col.accessor("player", { header: "Player", cell: (c) => c.getValue() ?? "—" }),
      col.accessor("market", { header: "Market", cell: (c) => MARKET_LABEL[c.getValue()] ?? c.getValue() }),
      col.accessor("selection", { header: "Pick" }),
      col.accessor("line", { header: "Line", cell: (c) => (c.row.original.market === "spread" ? spreadLine(c.getValue()) : c.getValue() ?? "—") }),
      col.accessor("predicted_prob", { header: "Prob", cell: (c) => <span className="text-volt-300">{pct(c.getValue())}</span> }),
      col.accessor("price", { header: "Odds", cell: (c) => american(c.getValue()) }),
      col.accessor("sportsbook", { header: "Book", cell: (c) => c.getValue() ?? "consensus" }),
      col.accessor("actual", { header: "Actual", cell: (c) => num(c.getValue(), 0) }),
      col.accessor("result", { header: "Result", cell: (c) => <ResultBadge result={c.getValue()} /> }),
      col.accessor("model_version", { header: "Model", cell: (c) => <span className="text-[11px] text-mist-500">{c.getValue()}</span> }),
      col.accessor("data_as_of", { header: "Data as of", cell: (c) => <span className="text-[11px] text-mist-500">{new Date(c.getValue()).toLocaleString()}</span> }),
      col.accessor("id", { header: "ID", cell: (c) => <span className="font-mono text-[10px] text-mist-500">{c.getValue().slice(0, 8)}</span> }),
    ],
    [col],
  );
  return (
    <Panel>
      <PanelHeader
        eyebrow="Permanent archive"
        title="Model forecasts"
        right={
          <div className="flex flex-wrap items-center gap-2">
            <select value={market} onChange={(e) => setMarket(e.target.value)} className="rounded-md border border-line bg-ink-900 px-2 py-1 text-xs text-mist-300">
              <option value="">All markets</option>
              {["moneyline", "spread", "total", "h1_total", "team_total", "prop"].map((m) => (
                <option key={m} value={m}>
                  {MARKET_LABEL[m] ?? "Team totals"}
                </option>
              ))}
            </select>
            <select value={result} onChange={(e) => setResult(e.target.value)} className="rounded-md border border-line bg-ink-900 px-2 py-1 text-xs text-mist-300">
              <option value="">All results</option>
              {["win", "loss", "push", "void", "pending"].map((m) => (
                <option key={m}>{m}</option>
              ))}
            </select>
            <Button size="sm" asChild>
              <a href={exportUrl("predictions", "xlsx", lq.split("=")[1])}>
                <Download className="h-3.5 w-3.5" /> XLSX
              </a>
            </Button>
          </div>
        }
      />
      {q.isLoading ? <Skeleton className="m-4 h-96" /> : <DataTable data={q.data ?? []} columns={columns as any} pageSize={20} searchable dense />}
    </Panel>
  );
}

const EMPTY_PICK = { pick_date: new Date().toISOString().slice(0, 10), league: "NBA", game_id: "", description: "", market: "spread", selection: "home", line: "", sportsbook: "", price_american: "-110", stake_units: "1", confidence_notes: "", predicted_outcome: "" };

function Journal() {
  const qc = useQueryClient();
  const picks = useApi<any>("/api/picks");
  const games = useApi<Game[]>("/api/games?days=3");
  const [f, setF] = useState<any>(EMPTY_PICK);
  const [err, setErr] = useState<string | null>(null);
  const create = useMutation({
    mutationFn: () =>
      api("/api/picks", {
        method: "POST",
        body: JSON.stringify({
          ...f,
          game_id: f.game_id ? Number(f.game_id) : null,
          line: f.line === "" ? null : Number(f.line),
          price_american: f.price_american === "" ? null : Number(f.price_american),
          stake_units: f.stake_units === "" ? null : Number(f.stake_units),
          description: f.description || (games.data?.find((g) => g.id === Number(f.game_id)) ? `${games.data!.find((g) => g.id === Number(f.game_id))!.away.abbr} @ ${games.data!.find((g) => g.id === Number(f.game_id))!.home.abbr}` : "Custom pick"),
        }),
      }),
    onSuccess: () => {
      setF(EMPTY_PICK);
      setErr(null);
      qc.invalidateQueries({ queryKey: ["/api/picks"] });
    },
    onError: (e: any) => setErr(e.message),
  });
  const patch = useMutation({
    mutationFn: ({ id, status }: { id: string; status: string }) => api(`/api/picks/${id}`, { method: "PATCH", body: JSON.stringify({ status }) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["/api/picks"] }),
  });
  const del = useMutation({ mutationFn: (id: string) => api(`/api/picks/${id}`, { method: "DELETE" }), onSuccess: () => qc.invalidateQueries({ queryKey: ["/api/picks"] }) });
  const s = picks.data?.summary;
  const input = "w-full rounded-lg border border-line bg-ink-900 px-2.5 py-1.5 text-sm text-mist focus:border-volt/50 focus:outline-none";
  return (
    <div className="grid gap-4 xl:grid-cols-[380px_1fr]">
      <Panel>
        <PanelHeader eyebrow="New entry" title="Record a pick" icon={<Plus className="h-4 w-4 text-volt" />} />
        <form
          className="grid grid-cols-2 gap-3 p-4"
          onSubmit={(e) => {
            e.preventDefault();
            create.mutate();
          }}
        >
          <label className="col-span-2 text-xs text-mist-400">
            Game (optional — enables automatic settlement)
            <select className={input} value={f.game_id} onChange={(e) => setF({ ...f, game_id: e.target.value, league: games.data?.find((g) => g.id === Number(e.target.value))?.league ?? f.league })}>
              <option value="">— custom / no linked game —</option>
              {(games.data ?? []).map((g) => (
                <option key={g.id} value={g.id}>
                  {g.league} · {g.away.abbr} @ {g.home.abbr} · {new Date(g.start_time).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
                </option>
              ))}
            </select>
          </label>
          <label className="col-span-2 text-xs text-mist-400">
            Description
            <input className={input} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} placeholder="e.g. Celtics -4.5" />
          </label>
          <label className="text-xs text-mist-400">
            Market
            <select className={input} value={f.market} onChange={(e) => setF({ ...f, market: e.target.value, selection: e.target.value === "total" || e.target.value === "h1_total" ? "over" : "home" })}>
              {["spread", "moneyline", "total", "h1_total", "prop_pts", "prop_reb", "prop_ast", "other"].map((m) => (
                <option key={m} value={m}>
                  {MARKET_LABEL[m] ?? m}
                </option>
              ))}
            </select>
          </label>
          <label className="text-xs text-mist-400">
            Selection
            <select className={input} value={f.selection} onChange={(e) => setF({ ...f, selection: e.target.value })}>
              {(["total", "h1_total"].includes(f.market) || f.market.startsWith("prop") ? ["over", "under"] : ["home", "away"]).map((x) => (
                <option key={x}>{x}</option>
              ))}
            </select>
          </label>
          <label className="text-xs text-mist-400">
            Line
            <input className={input} value={f.line} onChange={(e) => setF({ ...f, line: e.target.value })} placeholder="-4.5" />
          </label>
          <label className="text-xs text-mist-400">
            Odds (American)
            <input className={input} value={f.price_american} onChange={(e) => setF({ ...f, price_american: e.target.value })} />
          </label>
          <label className="text-xs text-mist-400">
            Sportsbook
            <input className={input} value={f.sportsbook} onChange={(e) => setF({ ...f, sportsbook: e.target.value })} placeholder="optional" />
          </label>
          <label className="text-xs text-mist-400">
            Stake (units, hypothetical)
            <input className={input} value={f.stake_units} onChange={(e) => setF({ ...f, stake_units: e.target.value })} />
          </label>
          <label className="text-xs text-mist-400">
            Date
            <input type="date" className={input} value={f.pick_date} onChange={(e) => setF({ ...f, pick_date: e.target.value })} />
          </label>
          <label className="text-xs text-mist-400">
            League
            <select className={input} value={f.league} onChange={(e) => setF({ ...f, league: e.target.value })}>
              <option>NBA</option>
              <option>CBB</option>
            </select>
          </label>
          <label className="col-span-2 text-xs text-mist-400">
            Confidence notes
            <textarea className={input} rows={2} value={f.confidence_notes} onChange={(e) => setF({ ...f, confidence_notes: e.target.value })} />
          </label>
          {err && <div className="col-span-2 text-xs text-loss">{err}</div>}
          <Button type="submit" variant="primary" className="col-span-2" disabled={create.isPending}>
            Save pick
          </Button>
          <p className="col-span-2 text-[10.5px] text-mist-500">Linked picks settle automatically when the game goes final. Unlinked picks can be graded manually.</p>
        </form>
      </Panel>
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
          <Panel className="p-4"><Stat label="Picks" value={s?.total ?? "—"} sub={`${s?.pending ?? 0} pending`} /></Panel>
          <Panel className="p-4"><Stat label="Record" value={s ? `${s.wins}-${s.losses}-${s.pushes}` : "—"} /></Panel>
          <Panel className="p-4"><Stat label="Win %" value={pct(s?.win_pct)} tone="volt" /></Panel>
          <Panel className="p-4"><Stat label="Units" value={signed(s?.units, 2)} tone={(s?.units ?? 0) >= 0 ? "gain" : "loss"} /></Panel>
          <Panel className="p-4"><Stat label="ROI" value={pct(s?.roi, 1)} /></Panel>
        </div>
        <Panel>
          <PanelHeader eyebrow="Journal" title="Your selections" right={<Button size="sm" asChild><a href={exportUrl("picks", "xlsx")}><Download className="h-3.5 w-3.5" /> Export</a></Button>} />
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] text-[12.5px]">
              <thead>
                <tr className="border-b border-line/70">
                  {["Date", "Pick", "Market", "Line", "Odds", "Units", "Status", "P/L", ""].map((h) => (
                    <th key={h} className="label px-3 py-2 text-left">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {(picks.data?.picks ?? []).map((p: any) => (
                  <tr key={p.id} className="border-b border-line/40 text-mist-300">
                    <td className="px-3 py-2 font-mono">{p.pick_date}</td>
                    <td className="px-3 py-2">
                      <div className="text-mist">{p.description}</div>
                      <div className="text-[11px] text-mist-500">
                        {p.selection} {p.sportsbook ? `· ${p.sportsbook}` : ""} {p.confidence_notes ? `· ${p.confidence_notes}` : ""}
                      </div>
                    </td>
                    <td className="px-3 py-2">{MARKET_LABEL[p.market] ?? p.market}</td>
                    <td className="px-3 py-2 font-mono">{p.line ?? "—"}</td>
                    <td className="px-3 py-2 font-mono">{american(p.price_american)}</td>
                    <td className="px-3 py-2 font-mono">{p.stake_units ?? "—"}</td>
                    <td className="px-3 py-2">
                      {p.status === "pending" ? (
                        <select className="rounded border border-line bg-ink-900 px-1.5 py-0.5 text-xs" value={p.status} onChange={(e) => patch.mutate({ id: p.id, status: e.target.value })}>
                          {["pending", "win", "loss", "push", "void"].map((x) => (
                            <option key={x}>{x}</option>
                          ))}
                        </select>
                      ) : (
                        <ResultBadge result={p.status} />
                      )}
                    </td>
                    <td className={cn("px-3 py-2 font-mono", (p.profit_units ?? 0) >= 0 ? "text-gain" : "text-loss")}>{p.profit_units != null ? signed(p.profit_units, 2) : "—"}</td>
                    <td className="px-3 py-2">
                      <button onClick={() => del.mutate(p.id)} className="rounded p-1 text-mist-500 hover:bg-loss/10 hover:text-loss" aria-label="Delete pick">
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!picks.data?.picks?.length && <Empty title="No picks recorded yet">Use the form to log a selection. Import historical picks from Data Management.</Empty>}
          </div>
        </Panel>
      </div>
    </div>
  );
}

function Diagnostics({ lq }: { lq: string }) {
  const d = useApi<any>(`/api/diagnostics${lq ? `?${lq}` : ""}`);
  if (!d.data) return <Skeleton className="h-72" />;
  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-line bg-ink-900/60 px-4 py-3 text-xs text-mist-400">{d.data.policy}</div>
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {(d.data.findings ?? []).map((f: any, i: number) => (
          <Panel key={i} className={cn("p-4", f.systematic && "border-flare/40")}>
            <div className="flex items-start justify-between gap-2">
              <div className="text-sm font-medium text-mist">{f.question}</div>
              <Badge tone={f.systematic ? "flare" : "neutral"}>{f.systematic ? "systematic" : "noise"}</Badge>
            </div>
            <div className="mt-1 text-[11.5px] text-mist-400">{f.label}</div>
            <div className="mt-3 flex items-baseline gap-3">
              <span className="font-mono text-2xl font-semibold text-mist">
                {f.unit === "prob" ? `${signed(f.mean_error * 100, 1)} pp` : `${signed(f.mean_error, 2)} ${f.unit}`}
              </span>
              <span className="text-[11px] text-mist-500">± {f.unit === "prob" ? `${num(f.se * 200, 1)} pp` : num(2 * f.se, 2)} (2·SE) · n={f.n}</span>
            </div>
            <div className={cn("mt-2 text-[11px]", f.systematic ? "text-flare" : "text-mist-500")}>{f.verdict}</div>
            {f.miss_share_large_minutes_error != null && <div className="mt-1 text-[11px] text-mist-400">{pct(f.miss_share_large_minutes_error, 0)} of prop misses had a minutes error larger than 6.</div>}
          </Panel>
        ))}
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <Panel>
          <PanelHeader eyebrow="CBB" title="Total-forecast error by conference" />
          <table className="w-full text-[12.5px]">
            <tbody>
              {(d.data.conference_errors ?? []).map((c: any) => (
                <tr key={c.conference} className="border-b border-line/40 font-mono tabular text-mist-300">
                  <td className="px-3 py-2 font-sans text-mist">{c.conference}</td>
                  <td className="px-3 py-2 text-mist-500">n={c.n}</td>
                  <td className="px-3 py-2">MAE {num(c.mae)}</td>
                  <td className="px-3 py-2">bias {signed(c.bias)}</td>
                  <td className="px-3 py-2 font-sans text-[11px] text-mist-500">{c.flag}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!d.data.conference_errors?.length && <Empty title="Not enough CBB totals settled" />}
        </Panel>
        <Panel>
          <PanelHeader eyebrow="Injury assumptions" title="Total MAE with vs without pre-game injury news" />
          <div className="grid grid-cols-2 gap-px bg-line/40">
            {Object.entries<any>(d.data.injury_split ?? {}).map(([k, v]) => (
              <div key={k} className="bg-ink-850 p-4">
                <div className="label">{k.replace(/_/g, " ")}</div>
                <div className="font-mono text-xl text-mist">{num(v.mae)}</div>
                <div className="text-[11px] text-mist-500">n={v.n}</div>
              </div>
            ))}
          </div>
        </Panel>
      </div>
    </div>
  );
}
