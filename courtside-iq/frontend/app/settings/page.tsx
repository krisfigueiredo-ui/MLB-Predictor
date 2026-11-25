"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, CircleSlash, KeyRound, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";

import { Badge, Button, ErrorState, KV, PageHeader, Panel, PanelHeader, Segmented, Skeleton } from "@/components/ui/primitives";
import { api, useApi } from "@/lib/api";
import { ago, cn } from "@/lib/format";

const PROVIDERS: Record<string, { env: string; label: string; docs: string; covers: string }> = {
  balldontlie: { env: "BALLDONTLIE_API_KEY", label: "BALLDONTLIE", docs: "https://docs.balldontlie.io", covers: "NBA games, live scores, box scores, active rosters, injuries; NCAAB on supported tiers" },
  the_odds_api: { env: "ODDS_API_KEY", label: "The Odds API", docs: "https://the-odds-api.com/liveapi/guides/v4/", covers: "US sportsbook moneylines, spreads, totals; 1H totals, team totals and player props via event odds" },
  sportsdataio: { env: "SPORTSDATAIO_API_KEY", label: "SportsDataIO", docs: "https://sportsdata.io/developers", covers: "Configuration and health only; map endpoints for your subscription tier" },
};

export default function SettingsPage() {
  const s = useApi<any>("/api/status", { refetchInterval: 15_000 });
  const qc = useQueryClient();
  const [token, setToken] = useState("");
  const refresh = useMutation({
    mutationFn: () => api("/api/admin/refresh", { method: "POST", headers: token ? { "X-Admin-Token": token } : {} }),
    onSuccess: () => qc.invalidateQueries(),
  });
  const [density, setDensity] = useState<"comfortable" | "compact">("comfortable");
  const [motion, setMotion] = useState<"on" | "reduced">("on");
  useEffect(() => {
    try {
      setDensity((localStorage.getItem("ciq-density") as any) ?? "comfortable");
      setMotion((localStorage.getItem("ciq-motion") as any) ?? "on");
    } catch {}
  }, []);
  const save = (k: string, v: string) => {
    try {
      localStorage.setItem(k, v);
    } catch {}
    document.documentElement.dataset[k === "ciq-density" ? "density" : "motion"] = v;
  };
  if (!s.data) return <Skeleton className="h-96" />;
  const d = s.data;
  return (
    <div className="space-y-6">
      <PageHeader index="13" title="Settings" subtitle="Provider connectivity, model configuration, refresh cadence, AI controls, licensed assets and appearance. API keys are read from server environment variables and never sent to the browser." />
      <div className="grid gap-6 xl:grid-cols-2">
        <Panel>
          <PanelHeader eyebrow="Data providers" title="Connectivity & health" right={<Badge tone={d.demo ? "flare" : "gain"}>{d.demo ? "Demo mode" : "Live mode"}</Badge>} />
          <div className="divide-y divide-line/50">
            {Object.entries<any>(d.providers).map(([k, v]) => {
              const p = PROVIDERS[k];
              return (
                <div key={k} className="px-4 py-3">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      {v.configured ? (v.ok === false ? <CircleSlash className="h-4 w-4 text-loss" /> : <CheckCircle2 className="h-4 w-4 text-gain" />) : <KeyRound className="h-4 w-4 text-mist-500" />}
                      <span className="font-medium text-mist">{p.label}</span>
                    </div>
                    <Badge tone={v.configured ? (v.ok === false ? "loss" : "gain") : "neutral"}>{v.configured ? (v.ok === false ? "error" : "configured") : "not configured"}</Badge>
                  </div>
                  <p className="mt-1 text-[11.5px] text-mist-400">{p.covers}</p>
                  <div className="mt-1 flex flex-wrap gap-x-4 text-[11px] text-mist-500">
                    <span>
                      env <code className="font-mono text-mist-300">{p.env}</code>
                    </span>
                    {v.last_check && <span>checked {ago(v.last_check)}</span>}
                    {v.latency_ms != null && <span>{Math.round(v.latency_ms)} ms</span>}
                    {v.rate_limit_remaining != null && <span>{v.rate_limit_remaining} requests remaining</span>}
                    <a href={p.docs} target="_blank" rel="noreferrer" className="text-volt-300 hover:underline">
                      docs
                    </a>
                  </div>
                  {v.message && v.ok === false && <div className="mt-1 text-[11px] text-loss">{v.message}</div>}
                </div>
              );
            })}
          </div>
          <p className="px-4 pb-3 text-[11px] text-mist-500">Without any provider key the platform runs on a clearly labelled synthetic simulator. Bookmakers are shown only when the connected odds feed returns them.</p>
        </Panel>
        <Panel>
          <PanelHeader eyebrow="Runtime" title="Refresh cadence, storage & models" />
          <div className="grid gap-6 p-4 md:grid-cols-2">
            <div>
              <KV k="Live poll interval" v={`${d.refresh.live_seconds}s`} />
              <KV k="Odds snapshot interval" v={`${d.refresh.odds_seconds}s`} />
              <KV k="Database" v={d.database} />
              <KV k="Cache" v={d.cache_backend} />
              <KV k="Odds freshness" v={ago(d.freshness.odds)} />
              <KV k="Games freshness" v={ago(d.freshness.games)} />
              <p className="mt-2 text-[10.5px] text-mist-500">Configured via LIVE_POLL_SECONDS, ODDS_POLL_SECONDS, DATABASE_URL, REDIS_URL.</p>
            </div>
            <div>
              <div className="label mb-1">Active models</div>
              {d.models.map((m: any) => (
                <KV key={m.version} k={`${m.league} ${m.name}`} v={<span className="font-mono text-[11px]">{m.version}</span>} />
              ))}
              <div className="mt-3 flex gap-2">
                <input value={token} onChange={(e) => setToken(e.target.value)} placeholder="Admin token (if set)" className="w-full rounded-md border border-line bg-ink-900 px-2 py-1 text-xs text-mist" type="password" />
                <Button size="sm" onClick={() => refresh.mutate()} disabled={refresh.isPending}>
                  <RefreshCw className={cn("h-3.5 w-3.5", refresh.isPending && "animate-spin")} /> Refresh now
                </Button>
              </div>
              {refresh.error && <ErrorState error={refresh.error} />}
            </div>
          </div>
        </Panel>
        <Panel>
          <PanelHeader eyebrow="AI" title="COURTSIDE AI controls" />
          <div className="p-4">
            <KV k="Status" v={<Badge tone={d.ai_enabled ? "gain" : "gold"}>{d.ai_enabled ? "enabled" : "disabled (no API key)"}</Badge>} />
            <KV k="Model" v={<span className="font-mono">{d.ai_model ?? "claude-opus-5-5 (when enabled)"}</span>} />
            <p className="mt-2 text-[11px] leading-relaxed text-mist-500">
              Set <code className="font-mono">ANTHROPIC_API_KEY</code> (and optionally <code className="font-mono">ANTHROPIC_MODEL</code>, <code className="font-mono">AI_EFFORT</code>) on the API server. The assistant only has read-only tools; it cannot place wagers,
              change data or retrain models.
            </p>
          </div>
        </Panel>
        <Panel>
          <PanelHeader eyebrow="Appearance" title="Display preferences (this browser)" />
          <div className="space-y-3 p-4">
            <div className="flex items-center justify-between">
              <span className="text-sm text-mist-300">Density</span>
              <Segmented size="sm" value={density} onChange={(v) => { setDensity(v); save("ciq-density", v); }} options={[{ value: "comfortable", label: "Comfortable" }, { value: "compact", label: "Compact" }]} />
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm text-mist-300">Motion</span>
              <Segmented size="sm" value={motion} onChange={(v) => { setMotion(v); save("ciq-motion", v); }} options={[{ value: "on", label: "Animated" }, { value: "reduced", label: "Reduced" }]} />
            </div>
            <p className="text-[11px] text-mist-500">Theme: COURTSIDE dark (navy / electric blue). Preferences are stored locally in this browser only.</p>
          </div>
        </Panel>
      </div>
      <AssetRegistry token={token} />
    </div>
  );
}

function AssetRegistry({ token }: { token: string }) {
  const qc = useQueryClient();
  const assets = useApi<any[]>("/api/assets");
  const teams = useApi<any[]>("/api/teams");
  const players = useApi<any[]>("/api/players");
  const [f, setF] = useState({ entity_type: "team", entity_id: "", kind: "logo", url: "", license: "", source: "", verified: false });
  const add = useMutation({
    mutationFn: () => api("/api/assets", { method: "POST", body: JSON.stringify({ ...f, entity_id: Number(f.entity_id) }), headers: token ? { "X-Admin-Token": token } : {} }),
    onSuccess: () => {
      qc.invalidateQueries();
      setF({ ...f, url: "", license: "", source: "" });
    },
  });
  const opts = f.entity_type === "team" ? teams.data ?? [] : players.data ?? [];
  const input = "w-full rounded-lg border border-line bg-ink-900 px-2.5 py-1.5 text-xs text-mist focus:border-volt/50 focus:outline-none";
  return (
    <Panel>
      <PanelHeader eyebrow="Central asset registry" title="Licensed logos & player portraits" />
      <div className="grid gap-6 p-4 xl:grid-cols-[420px_1fr]">
        <form
          className="grid grid-cols-2 gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            add.mutate();
          }}
        >
          <select className={input} value={f.entity_type} onChange={(e) => setF({ ...f, entity_type: e.target.value, kind: e.target.value === "team" ? "logo" : "portrait", entity_id: "" })}>
            <option value="team">Team / school logo</option>
            <option value="player">Player portrait</option>
          </select>
          <select className={input} value={f.entity_id} onChange={(e) => setF({ ...f, entity_id: e.target.value })} required>
            <option value="">Select…</option>
            {opts.map((o: any) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
          </select>
          <input className={cn(input, "col-span-2")} placeholder="Asset URL (https://…)" value={f.url} onChange={(e) => setF({ ...f, url: e.target.value })} required />
          <input className={input} placeholder="License (e.g. NBA Media license #…)" value={f.license} onChange={(e) => setF({ ...f, license: e.target.value })} required />
          <input className={input} placeholder="Source" value={f.source} onChange={(e) => setF({ ...f, source: e.target.value })} required />
          <label className="col-span-2 flex items-center gap-2 text-xs text-mist-400">
            <input type="checkbox" checked={f.verified} onChange={(e) => setF({ ...f, verified: e.target.checked })} /> I have verified this asset depicts the correct team/player and that we hold usage rights
          </label>
          <Button type="submit" variant="primary" className="col-span-2" size="sm" disabled={add.isPending}>
            Register asset
          </Button>
          {add.error && <div className="col-span-2"><ErrorState error={add.error} /></div>}
        </form>
        <div>
          <p className="mb-3 text-[11.5px] leading-relaxed text-mist-400">
            Official NBA and NCAA marks are trademarks. COURTSIDE IQ ships with original crests and illustrated avatars generated from each team&apos;s colours and verified jersey numbers. Register
            assets here only when you hold the rights; every logo and portrait in the app resolves through this registry, so a team or player can never display another entity&apos;s mark.
            Alternatively set <code className="font-mono">LICENSED_LOGO_BASE_URL</code> to a licensed CDN.
          </p>
          <div className="max-h-48 overflow-y-auto rounded-lg border border-line">
            <table className="w-full text-[12px]">
              <tbody>
                {(assets.data ?? []).map((a) => (
                  <tr key={a.id} className="border-b border-line/40 text-mist-300">
                    <td className="px-3 py-1.5">{a.entity_type} #{a.entity_id}</td>
                    <td className="px-3 py-1.5">{a.kind}</td>
                    <td className="max-w-[260px] truncate px-3 py-1.5 font-mono text-[11px]">{a.url}</td>
                    <td className="px-3 py-1.5">{a.license}</td>
                    <td className="px-3 py-1.5">{a.verified ? <Badge tone="gain">verified</Badge> : <Badge>unverified</Badge>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!assets.data?.length && <div className="px-3 py-4 text-center text-xs text-mist-500">No licensed assets registered. Original crests and avatars are in use.</div>}
          </div>
        </div>
      </div>
    </Panel>
  );
}
