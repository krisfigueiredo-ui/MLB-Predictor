export type League = "NBA" | "CBB";

export interface Asset {
  url: string;
  license: string;
  source: string;
  verified: boolean;
}

export interface Team {
  id: number;
  league: League;
  slug: string;
  abbr: string;
  location: string;
  nickname: string;
  name: string;
  primary: string;
  secondary: string;
  conference: string | null;
  conference_name?: string | null;
  division?: string | null;
  venue?: string | null;
  logo: Asset | null;
}

export interface Player {
  id: number;
  league: League;
  name: string;
  first: string;
  last: string;
  position: string | null;
  jersey: string | null;
  team: Team | null;
  roster: { verified: boolean; source: string; season: string; verified_at: string | null } | null;
  portrait: Asset | null;
}

export interface Game {
  id: number;
  league: League;
  season: string;
  start_time: string;
  status: "scheduled" | "live" | "final" | string;
  period: number | null;
  clock: string | null;
  home: Team;
  away: Team;
  home_score: number | null;
  away_score: number | null;
  home_h1: number | null;
  away_h1: number | null;
  neutral: boolean;
  is_demo: boolean;
  source: string;
  updated_at: string;
  model?: { win_prob_home: number | null; projected_margin: number | null };
}

export interface Dist {
  mean: number;
  median: number;
  sd: number;
  p05: number;
  p25: number;
  p75: number;
  p95: number;
}

export interface Simulation {
  n_sims: number;
  win_prob_home: number;
  win_prob_home_raw: number;
  win_prob_away: number;
  home_score: Dist;
  away_score: Dist;
  margin: Dist;
  total: Dist;
  h1_total: Dist;
  margin_hist?: { x: number; count: number; p: number }[];
  total_hist?: { x: number; count: number; p: number }[];
  spread?: { line_home: number; p_home_cover: number; p_push: number; p_away_cover: number };
  totals?: { line: number; p_over: number; p_push: number; p_under: number };
  h1?: { line: number; p_over: number; p_push: number; p_under: number };
  team_totals?: Record<string, { line: number; mean: number; p_over: number; p_under: number; p_push: number }>;
}

export interface Consensus {
  captured_at?: string;
  books?: string[];
  is_demo?: boolean;
  ml_home?: number | null;
  ml_away?: number | null;
  best_ml_home?: { price: number; book: string } | null;
  best_ml_away?: { price: number; book: string } | null;
  spread_home?: number | null;
  spread_price_home?: number | null;
  spread_price_away?: number | null;
  total?: number | null;
  total_price_over?: number | null;
  total_price_under?: number | null;
  h1_total?: number | null;
  team_total_home?: number | null;
  team_total_away?: number | null;
  no_vig_home?: number;
  no_vig_away?: number;
  implied_home?: number;
  implied_away?: number;
  by_book?: Record<string, any>[];
}

export interface VsMarket {
  moneyline?: {
    market_home_price: number;
    market_away_price: number;
    no_vig_home: number;
    no_vig_away: number;
    model_home: number;
    model_away: number;
    diff_home: number;
    fair_home: number | null;
    fair_away: number | null;
    ev_home: number | null;
    ev_away: number | null;
  };
  spread?: {
    market_line_home: number;
    model_line_home: number;
    line_diff: number;
    p_home_cover: number;
    p_away_cover: number;
    p_push: number;
    market_no_vig_home: number;
    ev_home: number;
    ev_away: number;
  };
  total?: { market_line: number; model_total: number; line_diff: number; p_over: number; p_under: number; p_push: number; ev_over: number; ev_under: number };
  h1_total?: { market_line: number; model_total: number; p_over: number; p_under: number; p_push: number };
}

export interface Projected {
  margin: number;
  total: number;
  h1_total: number;
  home_score: number;
  away_score: number;
  spread_home: number;
  possessions?: number | null;
  home_pace?: number | null;
  away_pace?: number | null;
}

export interface Projection {
  game_id: number;
  model_version: string;
  model_data_source: string;
  seed: number;
  projected: Projected;
  simulation: Simulation;
  market: Consensus;
  posterior?: { margin: number; total: number; w_margin: number; w_total: number; market_informed: boolean; sigma_margin: number; sigma_total: number } | null;
  vs_market: VsMarket;
  features?: Record<string, number>;
  explain?: { margin: Explain[]; total: Explain[] };
}

export interface Explain {
  feature: string;
  value: number;
  contribution: number;
  base: number;
  structural_baseline: number;
}

export interface BoardRow {
  game: Game;
  projected: Projected;
  simulation: Simulation;
  vs_market: VsMarket;
  live?: any;
  market: Consensus;
  by_book: Record<string, any>[];
  model_version: string;
  model_data_source: string;
}

export interface PropMarket {
  mean: number;
  median: number;
  sd: number;
  p10: number;
  p90: number;
  pmf: { x: number; p: number }[];
  line?: number;
  p_over?: number;
  p_under?: number;
  p_push?: number;
  book?: string;
  over_price?: number;
  under_price?: number;
  captured_at?: string;
  ev_over?: number;
  ev_under?: number;
  model_only_mean?: number;
}

export interface PropProjection {
  player_id: number;
  team_id: number;
  model_version: string;
  injury_out: boolean;
  minutes: { mean: number; sd: number; p10: number; p90: number };
  blowout_risk: number;
  markets: Record<string, PropMarket>;
  correlation: { keys: string[]; matrix: number[][] };
  player?: Player;
  game?: Game;
}

export interface PerfBlock {
  n: number;
  decided: number;
  wins: number;
  losses: number;
  pushes: number;
  win_pct: number | null;
  win_pct_ci: [number, number];
  avg_pred_prob: number | null;
  brier: number | null;
  log_loss: number | null;
  ece: number | null;
  priced_n: number;
  units: number | null;
  roi: number | null;
}

export interface PredictionRow {
  id: string;
  created_at: string;
  data_as_of: string;
  league: League;
  game_id: number;
  start_time: string;
  home: Team;
  away: Team;
  player: string | null;
  player_id: number | null;
  model_version: string;
  market: string;
  selection: string;
  predicted_value: number | null;
  predicted_prob: number;
  line: number | null;
  sportsbook: string | null;
  price: number | null;
  actual: number | null;
  result: string;
  settled_at: string | null;
  is_demo: boolean;
  mode: string | null;
}
