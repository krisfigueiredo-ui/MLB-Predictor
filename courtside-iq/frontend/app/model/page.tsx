"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { FlaskConical, Loader2, Play, SlidersHorizontal } from "lucide-react";
import { useMemo, useState } from "react";

import { C, EChart, SERIES, baseAxis, tooltip } from "@/components/charts/EChart";
import { DistributionChart } from "@/components/game/game";
import { Badge, Button, Empty, KV, PageHeader, Panel, PanelHeader, Segmented, Skeleton, Stat } from "@/components/ui/primitives";
import { api, useApi } from "@/lib/api";
import { cn, dateTime, featureLabel, num, pct, signed } from "@/lib/format";
import type { BoardRow } from "@/lib/types";

export default function ModelIntelligence() {
  const models = useApi<any[]>("/api/models");
  const [league, setLeague] = useState<"NBA" | "CBB">("NBA");
  const list = (models.data ?? []).filter((m) => m.league === league);
  const [sel, setSel] = useState<number | null>(null);
  const game = list.find((m) => m.id === sel) ?? list.find((m) => m.name === "game" && m.is_active);
  const props = list.find((m) => m.name === "props" && m.is_active);
  const qc = useQueryClient();
  const train = useMutation({ mutationFn: () => api(`/api/models/train?league=${league}`, { method: "POST" }), onSuccess: () => qc.invalidateQueries({ queryKey: ["/api/models"] }) });
  const tune = useMutation({ mutationFn: (n: number) => api<any>(`/api/models/tune?league=${league}&trials=${n}`, { method: "POST" }) });

  return (
    <div className="space-y-6">
      <PageHeader
        index="10"
        title="Model Intelligence"
        subtitle="League-specific LightGBM + CatBoost ensembles with XGBoost benchmarks, strict chronological validation, calibration, SHAP explanations and Monte Carlo simulation."
        right={
          <>
            <Segmented value={league} onChange={(v) => { setLeague(v); setSel(null); }} options={[{ value: "NBA", label: "NBA" }, { value: "CBB", label: "CBB" }]} />
            <Button size="sm" onClick={() => train.mutate()} disabled={train.isPending}>
              {train.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />} Retrain
            </Button>
            <Button size="sm" onClick={() => tune.mutate(15)} disabled={tune.isPending}>
              {tune.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <SlidersHorizontal className="h-3.5 w-3.5" />} Optuna (15 trials)
            </Button>
          </>
        }
      />
      {train.error && <div className="text-xs text-loss">{(train.error as Error).message}</div>}
      {tune.data && (
        <Panel className="p-4 text-xs text-mist-300">
          Optuna best validation MAE (margin) <span className="font-mono text-volt-300">{num(tune.data.best_mae, 3)}</span> over {tune.data.n_trials} trials · params{" "}
          <span className="font-mono text-mist-400">{JSON.stringify(tune.data.best_params)}</span>. Apply by retraining with these overrides (tuned on a chronological validation fold only).
        </Panel>
      )}

      <Panel>
        <PanelHeader eyebrow="Registry" title="Model versions" right={<span className="text-[11px] text-mist-500">Older versions are kept; their archived predictions are never rewritten.</span>} />
        <div className="overflow-x-auto">
          <table className="w-full min-w-[820px] text-[12.5px]">
            <thead>
              <tr className="border-b border-line/70">
                {["Version", "Type", "Algorithm", "Trained", "Train window", "Rows", "Data source", "Status"].map((h) => (
                  <th key={h} className="label px-3 py-2 text-left">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {list.map((m) => (
                <tr key={m.id} onClick={() => m.name === "game" && setSel(m.id)} className={cn("cursor-pointer border-b border-line/40 text-mist-300 hover:bg-volt/[0.04]", game?.id === m.id && "bg-volt/[0.06]")}>
                  <td className="px-3 py-2 font-mono text-mist">{m.version}</td>
                  <td className="px-3 py-2">{m.name}</td>
                  <td className="max-w-[360px] truncate px-3 py-2 text-[11.5px] text-mist-400" title={m.algorithm}>{m.algorithm}</td>
                  <td className="px-3 py-2">{dateTime(m.trained_at)}</td>
                  <td className="px-3 py-2 font-mono text-[11px]">{m.train_start ? `${m.train_start.slice(0, 10)} → ${m.train_end?.slice(0, 10)}` : "—"}</td>
                  <td className="px-3 py-2 font-mono">{m.n_train.toLocaleString()}</td>
                  <td className="px-3 py-2">{m.data_source === "synthetic_demo" ? <Badge tone="flare">synthetic demo</Badge> : <Badge tone="gain">{m.data_source}</Badge>}</td>
                  <td className="px-3 py-2">{m.is_active ? <Badge tone="volt">active</Badge> : <Badge>retired</Badge>}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {models.isLoading && <Skeleton className="m-4 h-24" />}
        </div>
      </Panel>

      {game ? <GameModelCard m={game} /> : !models.isLoading && <Panel><Empty title="No trained model for this league" /></Panel>}
      {props && <PropsModelCard m={props} />}
      <SimulationExplorer league={league} />
    </div>
  );
}

function GameModelCard({ m }: { m: any }) {
  const mt = m.metrics;
  const t = mt.test;
  const bm = mt.benchmarks;
  const wf = mt.walk_forward ?? [];
  const blend = mt.market_blend;
  return (
    <div className="space-y-4">
      {m.data_source === "synthetic_demo" && (
        <div className="flex items-center gap-2 rounded-lg border border-flare/30 bg-flare/5 px-3 py-2 text-xs text-flare">
          <FlaskConical className="h-4 w-4" /> Trained and evaluated on synthetic demo seasons. These metrics describe the simulator, not real basketball. Import real history (Data Management) or connect a provider and retrain.
        </div>
      )}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-8">
        <Panel className="p-4"><Stat label="Margin MAE" value={num(t.margin.mae, 2)} sub={`RMSE ${num(t.margin.rmse, 2)}`} tone="volt" /></Panel>
        <Panel className="p-4"><Stat label="Total MAE" value={num(t.total.mae, 2)} sub={`RMSE ${num(t.total.rmse, 2)}`} tone="volt" /></Panel>
        <Panel className="p-4"><Stat label="1H total MAE" value={num(t.h1_total.mae, 2)} /></Panel>
        <Panel className="p-4"><Stat label="Win Brier" value={num(t.win_calibrated.brier, 3)} sub={`raw ${num(t.win_raw.brier, 3)}`} /></Panel>
        <Panel className="p-4"><Stat label="Win log loss" value={num(t.win_calibrated.log_loss, 3)} /></Panel>
        <Panel className="p-4"><Stat label="ECE" value={num(t.win_calibrated.ece, 3)} sub={`raw ${num(t.win_raw.ece, 3)}`} /></Panel>
        <Panel className="p-4"><Stat label="Winner hit rate" value={pct(t.win_calibrated.hit_rate)} sub={`CI ${pct(t.win_calibrated.hit_rate_ci[0], 0)}–${pct(t.win_calibrated.hit_rate_ci[1], 0)}`} /></Panel>
        <Panel className="p-4"><Stat label="Test games" value={t.margin.n} sub={`${mt.split.test[0].slice(0, 10)} → ${mt.split.test[1].slice(0, 10)}`} /></Panel>
      </div>
      <div className="grid gap-4 lg:grid-cols-3">
        <Panel>
          <PanelHeader eyebrow="Benchmarks (held-out test)" title="MAE: lower is better" />
          <div className="p-2">
            <EChart
              height={240}
              option={{
                grid: { left: 70, right: 16, top: 26, bottom: 24 },
                legend: { top: 0, textStyle: { color: C.mist4, fontSize: 11 } },
                tooltip: { ...tooltip, valueFormatter: (v: any) => (v as number).toFixed(2) },
                xAxis: { type: "category", data: ["Margin", "Total"], ...baseAxis },
                yAxis: { type: "value", min: (v: { min: number }) => Math.floor(v.min * 0.9), ...baseAxis },
                series: [
                  { name: "LGBM+CatBoost", type: "bar", data: [t.margin.mae, t.total.mae], itemStyle: { color: C.volt, borderRadius: [3, 3, 0, 0] } },
                  { name: "XGBoost", type: "bar", data: [bm.xgboost.margin.mae, bm.xgboost.total.mae], itemStyle: { color: C.violet, borderRadius: [3, 3, 0, 0] } },
                  { name: "Efficiency baseline", type: "bar", data: [bm.naive_efficiency.margin.mae, bm.naive_efficiency.total.mae], itemStyle: { color: C.mist5, borderRadius: [3, 3, 0, 0] } },
                ],
              }}
            />
          </div>
        </Panel>
        <Panel>
          <PanelHeader eyebrow="Rolling walk-forward" title="Expanding-window folds" />
          <div className="p-2">
            <EChart
              height={240}
              option={{
                grid: { left: 40, right: 44, top: 26, bottom: 24 },
                legend: { top: 0, textStyle: { color: C.mist4, fontSize: 11 } },
                tooltip: { ...tooltip },
                xAxis: { type: "category", data: wf.map((f: any) => `F${f.fold} (${f.n_test})`), ...baseAxis },
                yAxis: [{ type: "value", scale: true, ...baseAxis, name: "MAE" }, { type: "value", scale: true, ...baseAxis, name: "Brier" }],
                series: [
                  { name: "Margin MAE", type: "line", data: wf.map((f: any) => f.margin.mae), lineStyle: { color: C.volt }, itemStyle: { color: C.volt } },
                  { name: "Total MAE", type: "line", data: wf.map((f: any) => f.total.mae), lineStyle: { color: C.cyan }, itemStyle: { color: C.cyan } },
                  { name: "Win Brier", type: "bar", yAxisIndex: 1, data: wf.map((f: any) => f.win.brier), itemStyle: { color: "rgba(255,138,61,0.35)" } },
                ],
              }}
            />
          </div>
          <div className="px-4 pb-3 text-[10.5px] text-mist-500">Each fold trains only on games before its first test game.</div>
        </Panel>
        <Panel>
          <PanelHeader eyebrow="Reliability diagram" title="Calibrated win probability" />
          <div className="p-2">
            <EChart
              height={240}
              option={{
                grid: { left: 40, right: 16, top: 16, bottom: 30 },
                tooltip: { trigger: "item", backgroundColor: "rgba(10,18,34,0.96)", borderColor: C.line, textStyle: { color: C.mist, fontSize: 12 }, formatter: (p: any) => (p.value?.[2] != null ? `pred ${(p.value[0] * 100).toFixed(0)}% · obs ${(p.value[1] * 100).toFixed(0)}% · n=${p.value[2]}` : "") },
                xAxis: { type: "value", min: 0, max: 1, ...baseAxis },
                yAxis: { type: "value", min: 0, max: 1, ...baseAxis },
                series: [
                  { type: "line", data: [[0, 0], [1, 1]], showSymbol: false, lineStyle: { color: C.mist5, type: "dashed" }, silent: true },
                  { type: "line", data: t.reliability.map((r: any) => [r.mean_pred, r.observed, r.n]), symbolSize: (v: number[]) => Math.max(5, Math.sqrt(v[2]) * 1.4), lineStyle: { color: C.gain }, itemStyle: { color: C.gain } },
                ],
              }}
            />
          </div>
        </Panel>
      </div>
      <div className="grid gap-4 lg:grid-cols-[1fr_1fr]">
        <Panel>
          <PanelHeader eyebrow="Feature importance (gain)" title="What the residual models use" />
          <div className="p-2">
            <EChart
              height={360}
              option={{
                grid: { left: 170, right: 16, top: 6, bottom: 20 },
                tooltip: { ...tooltip, valueFormatter: (v: any) => (v as number).toFixed(3) },
                xAxis: { type: "value", ...baseAxis },
                yAxis: { type: "category", inverse: true, data: mt.feature_importance.slice(0, 15).map((f: any) => featureLabel(f.feature)), ...baseAxis, axisLabel: { ...baseAxis.axisLabel, fontFamily: "var(--font-sans)" } },
                series: [{ type: "bar", data: mt.feature_importance.slice(0, 15).map((f: any, i: number) => ({ value: f.importance, itemStyle: { color: SERIES[i % 3], borderRadius: [0, 3, 3, 0] } })) }],
              }}
            />
          </div>
        </Panel>
        <Panel>
          <PanelHeader eyebrow="Market-informed probabilities" title="Model-only vs market-blended (test fold)" />
          {blend?.fit ? (
            <div className="space-y-4 p-4">
              <div className="grid grid-cols-2 gap-4">
                <Stat label="Weight on model · spread" value={num(blend.fit.w_margin, 3)} sub={`n=${blend.fit.n_margin} calibration games`} />
                <Stat label="Weight on model · total" value={num(blend.fit.w_total, 3)} sub={`σ ${num(blend.fit.sigma_total, 2)}`} />
              </div>
              <table className="w-full text-[12.5px]">
                <thead>
                  <tr className="border-b border-line/70">
                    {["Evaluation", "n", "Brier", "Log loss", "ECE"].map((h) => (
                      <th key={h} className="label px-2 py-2 text-left">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {Object.entries<any>(blend.test ?? {}).map(([k, v]) => (
                    <tr key={k} className="border-b border-line/40 font-mono tabular text-mist-300">
                      <td className="px-2 py-1.5 font-sans text-mist">{k.replace(/_/g, " ")}</td>
                      <td className="px-2 py-1.5">{v.n}</td>
                      <td className="px-2 py-1.5">{num(v.brier, 4)}</td>
                      <td className="px-2 py-1.5">{num(v.log_loss, 4)}</td>
                      <td className="px-2 py-1.5">{num(v.ece, 3)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="text-[11px] leading-relaxed text-mist-500">
                Against-the-spread and over/under probabilities combine the model with the pre-game market line (weight fit by MSE on the calibration fold; never on test data). A low model weight
                means the market already contains most of the information the model has — reported as-is rather than tuned away.
              </p>
            </div>
          ) : (
            <Empty title="Not enough historical market lines to fit a blend">Probabilities use the model alone until ≥100 calibration games have pre-game lines.</Empty>
          )}
        </Panel>
      </div>
      <Panel>
        <PanelHeader eyebrow="Training configuration" title="Splits & hyperparameters" />
        <div className="grid gap-6 p-4 md:grid-cols-3">
          <div>
            <div className="label mb-1">Chronological split</div>
            <KV k="Train" v={`${mt.split.train[0].slice(0, 10)} → ${mt.split.train[1].slice(0, 10)} (${mt.split.n_train})`} />
            <KV k="Calibration" v={`${mt.split.calibration[0].slice(0, 10)} → ${mt.split.calibration[1].slice(0, 10)} (${mt.split.n_cal})`} />
            <KV k="Test" v={`${mt.split.test[0].slice(0, 10)} → ${mt.split.test[1].slice(0, 10)} (${mt.split.n_test})`} />
          </div>
          <div>
            <div className="label mb-1">Residual structure (simulation)</div>
            <KV k="σ margin" v={num(mt.residuals.sigma_margin, 2)} />
            <KV k="σ total" v={num(mt.residuals.sigma_total, 2)} />
            <KV k="σ first half" v={num(mt.residuals.sigma_h1, 2)} />
            <KV k="ρ(margin, total)" v={num(mt.residuals.rho, 3)} />
          </div>
          <div>
            <div className="label mb-1">LightGBM</div>
            <pre className="overflow-x-auto rounded-lg border border-line bg-ink-900 p-2 font-mono text-[10.5px] text-mist-400">{JSON.stringify(m.params?.lgb, null, 1)}</pre>
          </div>
        </div>
      </Panel>
    </div>
  );
}

function PropsModelCard({ m }: { m: any }) {
  const t = m.metrics?.test ?? {};
  const stats = ["pts", "reb", "ast", "fg3m", "stl", "blk", "pra"].filter((s) => t[s]);
  return (
    <Panel>
      <PanelHeader eyebrow={m.version} title="Player props model — held-out evaluation" right={<Badge>{m.metrics?.n_eval_sample} sampled test rows</Badge>} />
      <div className="overflow-x-auto">
        <table className="w-full min-w-[640px] text-[12.5px]">
          <thead>
            <tr className="border-b border-line/70">
              {["Stat", "MAE", "RMSE", "Bias", "Over-prob Brier", "ECE", "NB dispersion r"].map((h) => (
                <th key={h} className="label px-3 py-2 text-left">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            <tr className="border-b border-line/40 font-mono tabular text-mist-300">
              <td className="px-3 py-2 font-sans text-mist">Minutes</td>
              <td className="px-3 py-2">{num(t.minutes?.mae, 2)}</td>
              <td className="px-3 py-2">{num(t.minutes?.rmse, 2)}</td>
              <td className="px-3 py-2">{signed(t.minutes?.bias, 2)}</td>
              <td className="px-3 py-2">—</td>
              <td className="px-3 py-2">—</td>
              <td className="px-3 py-2">σ {num(m.params?.sigma_minutes, 2)}</td>
            </tr>
            {stats.map((s) => (
              <tr key={s} className="border-b border-line/40 font-mono tabular text-mist-300">
                <td className="px-3 py-2 font-sans text-mist">{s.toUpperCase()}</td>
                <td className="px-3 py-2">{num(t[s].mae, 2)}</td>
                <td className="px-3 py-2">{num(t[s].rmse, 2)}</td>
                <td className="px-3 py-2">{signed(t[s].bias, 2)}</td>
                <td className="px-3 py-2">{num(t[s].over?.brier, 3)}</td>
                <td className="px-3 py-2">{num(t[s].over?.ece, 3)}</td>
                <td className="px-3 py-2">{m.params?.dispersion?.[s] != null ? num(m.params.dispersion[s], 1) : "summed"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <PropBlend blend={m.params?.prop_blend} />
    </Panel>
  );
}

function PropBlend({ blend }: { blend: any }) {
  if (!blend) return <p className="px-4 py-3 text-[11px] text-mist-500">Line anchoring uses the 0.5 prior until enough settled prop forecasts exist to fit per-stat weights.</p>;
  const ev = Object.entries<any>(blend.evaluation ?? {});
  return (
    <div className="border-t border-line/60">
      <div className="px-4 pt-3">
        <div className="label">Line-anchoring weights (fitted from settled forecasts)</div>
        <p className="mt-1 text-[11px] text-mist-500">
          mean = w·model + (1−w)·line. w is fit on the oldest 70% of settled forecasts and scored on the newest 30%; a fitted w is adopted only if it beats the 0.5 prior on that holdout.
          Fitted {blend.fitted_at ? new Date(blend.fitted_at).toLocaleString() : "—"}.
        </p>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[720px] text-[12.5px]">
          <thead>
            <tr className="border-b border-line/70">
              {["Stat", "n", "w in use", "Holdout MSE model", "line", "prior 0.5", "fitted", "Decision"].map((h) => (
                <th key={h} className="label px-3 py-2 text-left">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {ev.map(([k, v]) => (
              <tr key={k} className="border-b border-line/40 font-mono tabular text-mist-300">
                <td className="px-3 py-2 font-sans text-mist">{k.toUpperCase()}</td>
                <td className="px-3 py-2">{v.n}</td>
                <td className="px-3 py-2 text-volt-300">{blend.weights?.[k] != null ? num(blend.weights[k], 3) : "—"}</td>
                <td className="px-3 py-2">{num(v.holdout_mse_model_only, 2)}</td>
                <td className="px-3 py-2">{num(v.holdout_mse_line_only, 2)}</td>
                <td className="px-3 py-2">{num(v.holdout_mse_prior, 2)}</td>
                <td className="px-3 py-2">{num(v.holdout_mse_blended, 2)}</td>
                <td className="px-3 py-2 font-sans text-[11px] text-mist-500">{v.decision ?? v.status ?? (k === "pra" ? "sum of anchored PTS/REB/AST" : "")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function SimulationExplorer({ league }: { league: string }) {
  const board = useApi<{ games: BoardRow[] }>(`/api/board?league=${league}&hours=40`);
  const games = board.data?.games ?? [];
  const [gid, setGid] = useState<number | null>(null);
  const [n, setN] = useState("10000");
  const id = gid ?? games[0]?.game.id;
  const sim = useApi<any>(id ? `/api/simulate/${id}?n=${n}` : null);
  const g = games.find((x) => x.game.id === id)?.game;
  const s = sim.data?.simulation;
  const hist = useMemo(() => s?.total_hist ?? [], [s]);
  return (
    <Panel>
      <PanelHeader
        eyebrow="Monte Carlo"
        title="Simulation explorer"
        right={
          <div className="flex flex-wrap items-center gap-2">
            <select value={id ?? ""} onChange={(e) => setGid(Number(e.target.value))} className="rounded-md border border-line bg-ink-900 px-2 py-1 text-xs text-mist-300">
              {games.map((r) => (
                <option key={r.game.id} value={r.game.id}>
                  {r.game.away.abbr} @ {r.game.home.abbr}
                </option>
              ))}
            </select>
            <Segmented size="sm" value={n} onChange={setN} options={[{ value: "10000", label: "10k" }, { value: "50000", label: "50k" }, { value: "100000", label: "100k" }]} />
          </div>
        }
      />
      {!s ? (
        <Skeleton className="m-4 h-64" />
      ) : (
        <div className="grid gap-4 p-4 lg:grid-cols-[300px_1fr_1fr]">
          <div>
            <KV k="Simulations" v={sim.data.n.toLocaleString()} />
            <KV k="Seed" v={<span className="font-mono">{sim.data.seed}</span>} />
            <KV k={`${g?.home.abbr} win`} v={pct(s.win_prob_home)} />
            <KV k="Margin mean / median" v={`${signed(s.margin.mean)} / ${signed(s.margin.median, 0)}`} />
            <KV k="Margin 90% PI" v={`${signed(s.margin.p05, 0)} … ${signed(s.margin.p95, 0)}`} />
            <KV k="Total mean / median" v={`${num(s.total.mean)} / ${num(s.total.median, 0)}`} />
            <KV k="Total 90% PI" v={`${num(s.total.p05, 0)} … ${num(s.total.p95, 0)}`} />
            {s.spread && <KV k={`Cover ${s.spread.line_home}`} v={`${pct(s.spread.p_home_cover)} (push ${pct(s.spread.p_push, 1)})`} />}
            {s.totals && <KV k={`Over ${s.totals.line}`} v={`${pct(s.totals.p_over)} (push ${pct(s.totals.p_push, 1)})`} />}
            <p className="mt-2 text-[10.5px] text-mist-500">Same seed ⇒ identical results. Increase n to shrink Monte Carlo error (≈ ±{pct(1 / Math.sqrt(Number(n)), 1)} on probabilities).</p>
          </div>
          <div>
            <div className="label mb-1">Margin</div>
            <DistributionChart hist={s.margin_hist} line={s.spread ? -s.spread.line_home : null} label="Margin" height={240} />
          </div>
          <div>
            <div className="label mb-1">Total</div>
            <DistributionChart hist={hist} line={s.totals?.line} label="Total" color={C.cyan} height={240} />
          </div>
        </div>
      )}
    </Panel>
  );
}
