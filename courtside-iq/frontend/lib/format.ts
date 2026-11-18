import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export const cn = (...c: ClassValue[]) => twMerge(clsx(c));

export const pct = (x: number | null | undefined, d = 1) => (x == null || Number.isNaN(x) ? "—" : `${(x * 100).toFixed(d)}%`);
export const num = (x: number | null | undefined, d = 1) => (x == null || Number.isNaN(x) ? "—" : x.toFixed(d));
export const signed = (x: number | null | undefined, d = 1) =>
  x == null || Number.isNaN(x) ? "—" : `${x > 0 ? "+" : x < 0 ? "−" : ""}${Math.abs(x).toFixed(d)}`;
export const american = (p: number | null | undefined) => (p == null ? "—" : p > 0 ? `+${p}` : `${p}`);
export const spreadLine = (x: number | null | undefined) => (x == null ? "—" : x === 0 ? "PK" : x > 0 ? `+${x.toFixed(1)}` : x.toFixed(1));

export function timeShort(iso: string | null | undefined) {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}
export function dateShort(iso: string | null | undefined) {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString([], { month: "short", day: "numeric" });
}
export function dateTime(iso: string | null | undefined) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}
export function ago(iso: string | null | undefined) {
  if (!iso) return "never";
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return `${Math.max(0, Math.round(s))}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

export function periodLabel(league: string, period: number | null, clock: string | null, status: string) {
  if (status === "final") return "FINAL";
  if (status !== "live") return null;
  if (!period) return "LIVE";
  const n = league === "NBA" ? 4 : 2;
  const p = period > n ? `OT${period - n > 1 ? period - n : ""}` : league === "NBA" ? `Q${period}` : `${period === 1 ? "1st" : "2nd"} H`;
  return `${p} ${clock ?? ""}`.trim();
}

export const MARKET_LABEL: Record<string, string> = {
  moneyline: "Moneyline",
  spread: "Spread",
  total: "Total",
  h1_total: "1H Total",
  team_total_home: "Home TT",
  team_total_away: "Away TT",
  prop: "Player props",
  prop_pts: "Points",
  prop_reb: "Rebounds",
  prop_ast: "Assists",
  prop_fg3m: "3PM",
  prop_stl: "Steals",
  prop_blk: "Blocks",
  prop_pra: "PTS+REB+AST",
};

export const STAT_LABEL: Record<string, string> = { pts: "Points", reb: "Rebounds", ast: "Assists", fg3m: "3-Pointers", stl: "Steals", blk: "Blocks", pra: "PTS+REB+AST" };

export const FEATURE_LABEL: Record<string, string> = {
  naive_margin: "Efficiency baseline (margin)",
  naive_total: "Efficiency baseline (total)",
  naive_h1: "Efficiency baseline (1H)",
  net_diff: "Net rating differential",
  exp_pace: "Expected pace",
  h_pace: "Home pace",
  a_pace: "Away pace",
  h_adj_ortg: "Home adj. ORtg",
  h_adj_drtg: "Home adj. DRtg",
  a_adj_ortg: "Away adj. ORtg",
  a_adj_drtg: "Away adj. DRtg",
  h_net_shrunk: "Home net (shrunk)",
  a_net_shrunk: "Away net (shrunk)",
  h_rest: "Home rest days",
  a_rest: "Away rest days",
  h_b2b: "Home back-to-back",
  a_b2b: "Away back-to-back",
  h_travel: "Home travel (mi)",
  a_travel: "Away travel (mi)",
  h_injury: "Home injury impact",
  a_injury: "Away injury impact",
  h_lineup_change: "Home lineup change",
  a_lineup_change: "Away lineup change",
  h_efg: "Home eFG%",
  a_efg: "Away eFG%",
  h_d_efg: "Home opp eFG%",
  a_d_efg: "Away opp eFG%",
  h_tov: "Home TOV%",
  a_tov: "Away TOV%",
  h_d_tov: "Home forced TOV%",
  a_d_tov: "Away forced TOV%",
  h_orb: "Home ORB%",
  a_orb: "Away ORB%",
  h_ftr: "Home FT rate",
  a_ftr: "Away FT rate",
  h_last5: "Home last-5 net",
  a_last5: "Away last-5 net",
  h_last10: "Home last-10 net",
  a_last10: "Away last-10 net",
  h_home_net: "Home net at home",
  a_away_net: "Away net on road",
  h_sos: "Home SOS",
  a_sos: "Away SOS",
  h_games: "Home games played",
  a_games: "Away games played",
  neutral: "Neutral site",
  h1_share: "1H scoring share",
  h_conf_strength: "Home conf. strength",
  a_conf_strength: "Away conf. strength",
  h_nonconf_net: "Home nonconf net",
  a_nonconf_net: "Away nonconf net",
  h_continuity: "Home roster continuity",
  a_continuity: "Away roster continuity",
  same_conf: "Conference game",
};
export const featureLabel = (f: string) => FEATURE_LABEL[f] ?? f;
