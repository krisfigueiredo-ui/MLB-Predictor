"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Download, FileSpreadsheet, Loader2, ShieldAlert, UploadCloud } from "lucide-react";
import { useRef, useState } from "react";

import { C, EChart } from "@/components/charts/EChart";
import { Badge, Button, Empty, ErrorState, KV, PageHeader, Panel, PanelHeader, Segmented, Skeleton, Stat } from "@/components/ui/primitives";
import { api, exportUrl, useApi } from "@/lib/api";
import { cn, dateTime, pct } from "@/lib/format";

const DATASETS: { key: string; label: string; desc: string }[] = [
  { key: "predictions", label: "Model predictions", desc: "Archive incl. props, results, versions" },
  { key: "picks", label: "Historical picks", desc: "Your journal with settlement" },
  { key: "accuracy", label: "Prediction accuracy", desc: "Totals and per-market metrics" },
  { key: "odds", label: "Vegas odds", desc: "Timestamped snapshots (current season)" },
  { key: "games", label: "Game results", desc: "Schedules and scores" },
  { key: "team_stats", label: "Team box scores", desc: "Possession-level box stats" },
  { key: "player_stats", label: "Player game logs", desc: "Minutes and counting stats" },
  { key: "teams", label: "NBA & NCAA teams", desc: "Registry with colours & conferences" },
  { key: "league_table", label: "Trend report", desc: "Season efficiency table" },
  { key: "diagnostics", label: "Model diagnostics", desc: "Error analysis findings" },
];

export default function DataCenter() {
  const qc = useQueryClient();
  const [file, setFile] = useState<File | null>(null);
  const [kind, setKind] = useState("");
  const [league, setLeague] = useState("");
  const [tz, setTz] = useState("America/New_York");
  const [drag, setDrag] = useState(false);
  const [dsId, setDsId] = useState<number | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const history = useApi<any[]>("/api/data/imports");
  const ds = useApi<any>(dsId ? `/api/data/imports/${dsId}` : null);
  const quality = useApi<any>("/api/data/quality");
  const upload = useMutation({
    mutationFn: async () => {
      const fd = new FormData();
      fd.append("file", file!);
      if (kind) fd.append("kind", kind);
      if (league) fd.append("league", league);
      fd.append("timezone_name", tz);
      return api<any>("/api/data/import", { method: "POST", body: fd });
    },
    onSuccess: (r) => {
      setDsId(r.id);
      qc.invalidateQueries({ queryKey: ["/api/data/imports"] });
    },
  });
  const approve = useMutation({
    mutationFn: (body: any) => api(`/api/data/imports/${dsId}/approve`, { method: "POST", body: JSON.stringify(body) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: [`/api/data/imports/${dsId}`] }),
  });
  const commit = useMutation({
    mutationFn: () => api<any>(`/api/data/imports/${dsId}/commit`, { method: "POST" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [`/api/data/imports/${dsId}`] });
      qc.invalidateQueries({ queryKey: ["/api/data/imports"] });
      qc.invalidateQueries({ queryKey: ["/api/data/quality"] });
    },
  });
  const sel = "rounded-lg border border-line bg-ink-900 px-2.5 py-1.5 text-xs text-mist-300";
  return (
    <div className="space-y-6">
      <PageHeader
        index="11"
        title="Data Management Center"
        subtitle="Import your own CSV, Excel or JSON data through a validated cleaning pipeline, review every proposed change, then export anything on the platform."
      />
      <div className="grid gap-6 xl:grid-cols-[420px_1fr]">
        <Panel>
          <PanelHeader eyebrow="Import" title="Upload a dataset" icon={<UploadCloud className="h-4 w-4 text-volt" />} />
          <div className="space-y-3 p-4">
            <div
              onDragOver={(e) => {
                e.preventDefault();
                setDrag(true);
              }}
              onDragLeave={() => setDrag(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDrag(false);
                if (e.dataTransfer.files[0]) setFile(e.dataTransfer.files[0]);
              }}
              onClick={() => inputRef.current?.click()}
              className={cn(
                "flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed px-4 py-10 text-center transition-all",
                drag ? "border-volt bg-volt/10" : "border-line hover:border-volt/50 hover:bg-ink-800",
              )}
            >
              <FileSpreadsheet className="h-8 w-8 text-volt-300" />
              <div className="text-sm font-medium text-mist">{file ? file.name : "Drop a file or click to browse"}</div>
              <div className="text-[11px] text-mist-500">{file ? `${(file.size / 1024).toFixed(1)} KB` : "CSV · XLSX · JSON: games, player stats, odds, predictions, picks"}</div>
              <input ref={inputRef} type="file" accept=".csv,.xlsx,.json" className="hidden" onChange={(e) => e.target.files?.[0] && setFile(e.target.files[0])} />
            </div>
            <div className="grid grid-cols-3 gap-2">
              <select className={sel} value={kind} onChange={(e) => setKind(e.target.value)} aria-label="Dataset type">
                <option value="">Auto-detect type</option>
                {["games", "player_stats", "odds", "predictions", "picks"].map((k) => (
                  <option key={k} value={k}>
                    {k}
                  </option>
                ))}
              </select>
              <select className={sel} value={league} onChange={(e) => setLeague(e.target.value)} aria-label="League">
                <option value="">League: detect</option>
                <option value="NBA">NBA</option>
                <option value="CBB">NCAA (CBB)</option>
              </select>
              <select className={sel} value={tz} onChange={(e) => setTz(e.target.value)} aria-label="Source timezone">
                {["America/New_York", "America/Chicago", "America/Denver", "America/Los_Angeles", "UTC"].map((z) => (
                  <option key={z}>{z}</option>
                ))}
              </select>
            </div>
            <Button variant="primary" className="w-full" disabled={!file || upload.isPending} onClick={() => upload.mutate()}>
              {upload.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <UploadCloud className="h-4 w-4" />} Validate & preview
            </Button>
            {upload.error && <ErrorState error={upload.error} />}
            <ol className="space-y-1 text-[11px] text-mist-500">
              <li>1. Original bytes are preserved (SHA-256) before any change.</li>
              <li>2. Columns are standardised and mapped to the canonical schema.</li>
              <li>3. Teams, schools and players are matched to registry IDs; dates converted to UTC.</li>
              <li>4. Duplicates, missing values, invalid scores, probability ranges, odds timing and affiliation conflicts are checked.</li>
              <li>5. Unresolved rows are quarantined; destructive fixes wait for your approval.</li>
            </ol>
          </div>
        </Panel>

        <div className="space-y-4">
          {!dsId && (
            <Panel>
              <Empty title="No dataset selected" icon={<FileSpreadsheet className="h-6 w-6" />}>
                Upload a file, or open a previous import from the history below to review its Data Quality Scorecard.
              </Empty>
            </Panel>
          )}
          {dsId && !ds.data && <Skeleton className="h-96" />}
          {ds.data && <ImportReview d={ds.data} onApprove={(b) => approve.mutate(b)} onCommit={() => commit.mutate()} committing={commit.isPending} commitResult={commit.data} commitError={commit.error} />}
        </div>
      </div>

      <div className="grid gap-6 xl:grid-cols-[1fr_1fr]">
        <Panel>
          <PanelHeader eyebrow="Export center" title="Download platform data" icon={<Download className="h-4 w-4 text-cyan" />} />
          <div className="divide-y divide-line/50">
            {DATASETS.map((d) => (
              <div key={d.key} className="flex items-center justify-between gap-3 px-4 py-2.5">
                <div className="min-w-0">
                  <div className="text-sm font-medium text-mist">{d.label}</div>
                  <div className="text-[11px] text-mist-500">{d.desc}</div>
                </div>
                <div className="flex gap-1">
                  {(["csv", "xlsx", "json"] as const).map((f) => (
                    <a key={f} href={exportUrl(d.key, f)} className="rounded-md border border-line px-2 py-1 font-mono text-[10.5px] uppercase text-mist-300 hover:border-volt/50 hover:text-volt-300">
                      {f}
                    </a>
                  ))}
                </div>
              </div>
            ))}
          </div>
          <p className="px-4 py-3 text-[10.5px] text-mist-500">Excel exports include styled headers, frozen panes, filters, number formats and a README sheet with timestamp and licensing notes. Respect your data providers&apos; redistribution terms.</p>
        </Panel>
        <div className="space-y-6">
          <Panel>
            <PanelHeader eyebrow="Platform data health" title="Integrity checks" />
            {quality.data ? (
              <div className="grid gap-4 p-4 md:grid-cols-2">
                <div>
                  {Object.entries<number>(quality.data.counts).map(([k, v]) => (
                    <KV key={k} k={k} v={v.toLocaleString()} />
                  ))}
                </div>
                <div>
                  <div className="label mb-1">Game sources</div>
                  {Object.entries<number>(quality.data.game_sources).map(([k, v]) => (
                    <KV key={k} k={k} v={v.toLocaleString()} />
                  ))}
                  <div className="label mb-1 mt-3">Checks</div>
                  {Object.entries<number>(quality.data.checks).map(([k, v]) => (
                    <KV key={k} k={k.replace(/_/g, " ")} v={<span className={v ? "text-gold" : "text-gain"}>{v}</span>} />
                  ))}
                </div>
              </div>
            ) : (
              <Skeleton className="m-4 h-40" />
            )}
          </Panel>
          <Panel>
            <PanelHeader eyebrow="History" title="Previous imports" />
            <ul className="divide-y divide-line/50">
              {(history.data ?? []).map((h) => (
                <li key={h.id}>
                  <button onClick={() => setDsId(h.id)} className={cn("grid w-full grid-cols-[1fr_auto] items-center gap-2 px-4 py-2.5 text-left hover:bg-volt/[0.04]", dsId === h.id && "bg-volt/[0.06]")}>
                    <div className="min-w-0">
                      <div className="truncate text-sm text-mist">{h.filename}</div>
                      <div className="text-[11px] text-mist-500">
                        {h.kind} · {h.rows} rows · {h.valid} valid · {h.quarantined} quarantined · {dateTime(h.uploaded_at)}
                      </div>
                    </div>
                    <Badge tone={h.status === "committed" ? "gain" : h.status === "approved" ? "volt" : "neutral"}>{h.status}</Badge>
                  </button>
                </li>
              ))}
              {!history.data?.length && <Empty title="No imports yet" />}
            </ul>
          </Panel>
        </div>
      </div>
    </div>
  );
}

function ImportReview({ d, onApprove, onCommit, committing, commitResult, commitError }: { d: any; onApprove: (b: any) => void; onCommit: () => void; committing: boolean; commitResult: any; commitError: unknown }) {
  const sc = d.scorecard ?? {};
  const [filter, setFilter] = useState<"all" | "valid" | "quarantined" | "duplicate">("all");
  const [tab, setTab] = useState<"rows" | "log" | "mapping">("rows");
  const recs = (d.records ?? []).filter((r: any) => filter === "all" || r.status === filter);
  const destructive = (d.log ?? []).filter((l: any) => l.destructive);
  const pendingDestructive = destructive.filter((l: any) => !l.approved).length;
  const quality = sc.quality_score ?? 0;
  return (
    <>
      <Panel>
        <PanelHeader
          eyebrow={`Data Quality Scorecard · ${d.kind}`}
          title={d.filename}
          right={<Badge tone={d.status === "committed" ? "gain" : "volt"}>{d.status}</Badge>}
        />
        <div className="grid gap-4 p-4 md:grid-cols-[160px_1fr]">
          <EChart
            height={150}
            option={{
              series: [
                {
                  type: "gauge",
                  startAngle: 220,
                  endAngle: -40,
                  min: 0,
                  max: 100,
                  radius: "95%",
                  progress: { show: true, width: 10, roundCap: true, itemStyle: { color: quality >= 80 ? C.gain : quality >= 50 ? C.gold : C.loss } },
                  axisLine: { lineStyle: { width: 10, color: [[1, "#13203888"]] } },
                  pointer: { show: false },
                  axisTick: { show: false },
                  splitLine: { show: false },
                  axisLabel: { show: false },
                  detail: { offsetCenter: [0, "0%"], formatter: "{value}", color: C.mist, fontSize: 26, fontWeight: 700 },
                  title: { offsetCenter: [0, "38%"], color: C.mist4, fontSize: 10 },
                  data: [{ value: quality, name: "quality score" }],
                },
              ],
            }}
          />
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <Stat label="Imported rows" value={sc.rows} />
            <Stat label="Valid" value={sc.valid} tone="gain" />
            <Stat label="Quarantined" value={sc.quarantined} tone={sc.quarantined ? "flare" : undefined} />
            <Stat label="Duplicates" value={sc.duplicates} />
            <Stat label="Rejected" value={sc.rejected} />
            <Stat label="Missingness" value={pct(sc.overall_missing, 1)} />
            <Stat label="Warnings" value={sc.warnings} />
            <Stat label="Schema coverage" value={pct(sc.coverage, 0)} sub={sc.missing_required_columns?.length ? `missing: ${sc.missing_required_columns.join(", ")}` : "all required columns found"} />
          </div>
        </div>
        <div className="flex flex-wrap gap-2 border-t border-line/60 px-4 py-3">
          {Object.entries<number>(sc.checks ?? {}).map(([k, v]) => (
            <span key={k} className={cn("rounded-md border px-2 py-0.5 text-[11px]", v ? "border-gold/30 bg-gold/5 text-gold" : "border-line text-mist-500")}>
              {k.replace(/_/g, " ")}: {v}
            </span>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2 border-t border-line/60 px-4 py-3">
          {pendingDestructive > 0 && (
            <span className="flex items-center gap-1.5 text-xs text-gold">
              <ShieldAlert className="h-4 w-4" /> {pendingDestructive} destructive correction(s) need approval (duplicate removal, rescaling).
            </span>
          )}
          <div className="ml-auto flex gap-2">
            <Button size="sm" disabled={d.status === "committed" || pendingDestructive === 0} onClick={() => onApprove({ approve_destructive: true })}>
              Approve proposed corrections
            </Button>
            <Button size="sm" variant="primary" disabled={d.status === "committed" || committing || pendingDestructive > 0} onClick={onCommit}>
              {committing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CheckCircle2 className="h-3.5 w-3.5" />} Commit {sc.valid} valid rows
            </Button>
          </div>
          {commitResult && <span className="w-full text-xs text-gain">Committed {commitResult.committed} {commitResult.kind} rows. Quarantined rows remain available for review.</span>}
          {commitError ? <ErrorState error={commitError} /> : null}
        </div>
      </Panel>
      <Panel>
        <PanelHeader
          eyebrow="Preview of proposed changes"
          title={tab === "rows" ? "Records" : tab === "log" ? "Cleaning decisions log" : "Column mapping"}
          right={
            <div className="flex flex-wrap gap-2">
              <Segmented size="sm" value={tab} onChange={setTab} options={[{ value: "rows", label: "Rows" }, { value: "log", label: `Log (${d.log?.length ?? 0})` }, { value: "mapping", label: "Mapping" }]} />
              {tab === "rows" && <Segmented size="sm" value={filter} onChange={setFilter} options={[{ value: "all", label: "All" }, { value: "valid", label: "Valid" }, { value: "quarantined", label: "Quarantine" }, { value: "duplicate", label: "Dupes" }]} />}
            </div>
          }
        />
        {tab === "rows" && (
          <div className="max-h-[440px] overflow-auto">
            <table className="w-full min-w-[760px] text-[12px]">
              <thead className="sticky top-0 bg-ink-850">
                <tr className="border-b border-line/70">
                  <th className="label px-3 py-2 text-left">Row</th>
                  <th className="label px-3 py-2 text-left">Status</th>
                  <th className="label px-3 py-2 text-left">Cleaned values</th>
                  <th className="label px-3 py-2 text-left">Issues</th>
                  <th className="label px-3 py-2 text-left" />
                </tr>
              </thead>
              <tbody>
                {recs.map((r: any) => (
                  <tr key={r.row} className="border-b border-line/40 align-top">
                    <td className="px-3 py-2 font-mono text-mist-500">{r.row}</td>
                    <td className="px-3 py-2">
                      <Badge tone={r.status === "valid" ? "gain" : r.status === "duplicate" ? "neutral" : "flare"}>{r.status}</Badge>
                    </td>
                    <td className="px-3 py-2 font-mono text-[11px] text-mist-300">
                      {Object.entries(r.cleaned ?? {})
                        .filter(([k]) => !k.endsWith("_id"))
                        .slice(0, 7)
                        .map(([k, v]) => `${k}=${typeof v === "number" ? Math.round((v as number) * 1000) / 1000 : String(v).slice(0, 22)}`)
                        .join(" · ")}
                    </td>
                    <td className="px-3 py-2 text-[11px]">
                      {r.issues.map((i: any, j: number) => (
                        <div key={j} className={i.severity === "error" ? "text-loss" : "text-gold"}>
                          {i.field}: {i.msg}
                        </div>
                      ))}
                    </td>
                    <td className="px-3 py-2">
                      {r.status === "quarantined" && !r.issues.some((i: any) => i.severity === "error") && d.status !== "committed" && (
                        <button className="text-[11px] text-volt-300 hover:underline" onClick={() => onApprove({ release_rows: [r.row] })}>
                          release
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!recs.length && <Empty title="No rows in this filter" />}
          </div>
        )}
        {tab === "log" && (
          <div className="max-h-[440px] overflow-auto">
            <table className="w-full text-[12px]">
              <tbody>
                {(d.log ?? []).map((l: any, i: number) => (
                  <tr key={i} className="border-b border-line/40">
                    <td className="px-3 py-1.5 font-mono text-mist-500">{l.row ?? "—"}</td>
                    <td className="px-3 py-1.5 text-mist-300">{l.action.replace(/_/g, " ")}</td>
                    <td className="px-3 py-1.5 font-mono text-[11px] text-mist-400">{l.field}</td>
                    <td className="px-3 py-1.5 font-mono text-[11px] text-mist-400">
                      {l.before} → <span className="text-mist">{l.after}</span>
                    </td>
                    <td className="px-3 py-1.5">{l.destructive && <Badge tone={l.approved ? "gain" : "gold"}>{l.approved ? "approved" : "needs approval"}</Badge>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {tab === "mapping" && (
          <div className="grid gap-4 p-4 md:grid-cols-2">
            <div>
              <div className="label mb-1">Canonical ← source column</div>
              {Object.entries<string>(d.mapping?.mapping ?? {}).map(([k, v]) => (
                <KV key={k} k={<span className="font-mono">{k}</span>} v={<span className="font-mono text-mist-400">{v}</span>} />
              ))}
            </div>
            <div>
              <div className="label mb-1">Unmapped source columns (kept in raw)</div>
              <div className="flex flex-wrap gap-1">
                {(d.mapping?.unmapped ?? []).map((c: string) => (
                  <Badge key={c}>{c}</Badge>
                ))}
              </div>
              <div className="mt-3 text-[11px] text-mist-500">
                Raw file SHA-256 <span className="font-mono">{d.sha256?.slice(0, 16)}…</span> · timezone {d.mapping?.timezone}
              </div>
            </div>
          </div>
        )}
      </Panel>
    </>
  );
}
