"use client";

import Link from "next/link";
import { useId } from "react";

import { cn } from "@/lib/format";
import type { Player, Team } from "@/lib/types";

/* Central rendering rules for team/school identity.
 * - If a licensed logo asset is registered for the team (asset registry / licensed CDN), render it.
 * - Otherwise render an ORIGINAL crest built from the team's colours and abbreviation. No
 *   trademarked artwork is bundled with the application.
 */

function luminance(hex: string) {
  const h = hex.replace("#", "");
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
export const readableOn = (hex: string) => (luminance(hex) > 0.45 ? "#0A1222" : "#FFFFFF");

function shade(hex: string, amt: number) {
  const h = hex.replace("#", "");
  const c = [0, 2, 4].map((i) => Math.max(0, Math.min(255, Math.round(parseInt(h.slice(i, i + 2), 16) * (1 + amt)))));
  return `#${c.map((x) => x.toString(16).padStart(2, "0")).join("")}`;
}

/** Pick a trim colour that stays visible against the primary. */
function trimColor(t: Pick<Team, "primary" | "secondary">) {
  const d = Math.abs(luminance(t.primary) - luminance(t.secondary));
  return d < 0.08 ? readableOn(t.primary) : t.secondary;
}

export function TeamCrest({ team, size = 28, className, ring = true }: { team: Pick<Team, "abbr" | "primary" | "secondary" | "logo" | "league" | "name">; size?: number; className?: string; ring?: boolean }) {
  const id = useId().replace(/:/g, "");
  if (team.logo?.url) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={team.logo.url} alt={`${team.name} logo`} width={size} height={size} className={cn("shrink-0 object-contain", className)} />;
  }
  const fg = readableOn(team.primary);
  const trim = trimColor(team);
  const text = team.abbr.length > 3 ? team.abbr.slice(0, 4) : team.abbr;
  const fs = text.length >= 4 ? 10.5 : 13;
  const college = team.league === "CBB";
  return (
    <svg viewBox="0 0 40 40" width={size} height={size} className={cn("shrink-0 drop-shadow-[0_2px_6px_rgba(0,0,0,0.45)]", className)} role="img" aria-label={`${team.name} crest`}>
      <defs>
        <linearGradient id={`g${id}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={shade(team.primary, 0.18)} />
          <stop offset="1" stopColor={shade(team.primary, -0.28)} />
        </linearGradient>
      </defs>
      {college ? (
        <path d="M20 2 L35 7 V19 C35 28.5 28.5 34.5 20 38 C11.5 34.5 5 28.5 5 19 V7 Z" fill={`url(#g${id})`} stroke={ring ? trim : "none"} strokeWidth="1.6" />
      ) : (
        <>
          <circle cx="20" cy="20" r="18" fill={`url(#g${id})`} stroke={ring ? trim : "none"} strokeWidth="1.6" />
          <path d="M6 20 H34 M20 2.5 V37.5" stroke={fg} strokeOpacity="0.08" strokeWidth="1" />
          <path d="M9 9 Q20 20 9 31 M31 9 Q20 20 31 31" stroke={fg} strokeOpacity="0.08" fill="none" strokeWidth="1" />
        </>
      )}
      <text
        x="20"
        y={college ? 22.5 : 24.4}
        textAnchor="middle"
        fontFamily="var(--font-display), Inter, sans-serif"
        fontWeight="800"
        fontSize={fs}
        letterSpacing="-0.3"
        fill={fg}
      >
        {text}
      </text>
    </svg>
  );
}

export function TeamName({ team, size = 24, short, href = true, className }: { team: Team; size?: number; short?: boolean; href?: boolean; className?: string }) {
  const inner = (
    <span className={cn("inline-flex min-w-0 items-center gap-2", className)}>
      <TeamCrest team={team} size={size} />
      <span className="truncate font-medium text-mist">{short ? team.abbr : team.name}</span>
    </span>
  );
  return href ? (
    <Link href={`/teams/${team.id}`} className="min-w-0 hover:text-volt-300" onClick={(e) => e.stopPropagation()}>
      {inner}
    </Link>
  ) : (
    inner
  );
}

/* Illustrated player avatar.
 * Licensed portrait assets (from the asset registry) are shown when available. Otherwise we draw
 * an original, consistent illustrated avatar: a stylised athlete silhouette wearing the player's
 * team uniform colours and verified jersey number. It intentionally does not attempt to depict
 * the real person's likeness.
 */
export function PlayerPortrait({ player, size = 64, className }: { player: Pick<Player, "id" | "name" | "jersey" | "team" | "portrait">; size?: number; className?: string }) {
  const uid = useId().replace(/:/g, "");
  const team = player.team;
  const primary = team?.primary ?? "#2F7BFF";
  const secondary = team ? trimColor(team) : "#22D3EE";
  if (player.portrait?.url) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={player.portrait.url} alt={player.name} width={size} height={size * 1.15} className={cn("rounded-xl object-cover", className)} />;
  }
  const jerseyText = readableOn(primary);
  const num = player.jersey ?? "";
  const initials = player.name
    .split(" ")
    .map((s) => s[0])
    .join("")
    .slice(0, 3);
  return (
    <svg viewBox="0 0 120 138" width={size} height={size * 1.15} className={cn("shrink-0 rounded-xl", className)} role="img" aria-label={`${player.name} illustrated avatar`}>
      <defs>
        <radialGradient id={`bg${uid}`} cx="50%" cy="30%" r="80%">
          <stop offset="0" stopColor={shade(primary, 0.25)} stopOpacity="0.95" />
          <stop offset="0.6" stopColor={shade(primary, -0.45)} />
          <stop offset="1" stopColor="#050913" />
        </radialGradient>
        <linearGradient id={`skin${uid}`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#3A4B6E" />
          <stop offset="1" stopColor="#1A2643" />
        </linearGradient>
        <linearGradient id={`jer${uid}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={shade(primary, 0.12)} />
          <stop offset="1" stopColor={shade(primary, -0.3)} />
        </linearGradient>
        <linearGradient id={`rim${uid}`} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#8AB6FF" stopOpacity="0" />
          <stop offset="0.5" stopColor="#8AB6FF" stopOpacity="0.35" />
          <stop offset="1" stopColor="#8AB6FF" stopOpacity="0" />
        </linearGradient>
        <clipPath id={`clip${uid}`}>
          <rect width="120" height="138" rx="14" />
        </clipPath>
      </defs>
      <g clipPath={`url(#clip${uid})`}>
        <rect width="120" height="138" fill={`url(#bg${uid})`} />
        {/* court motif */}
        <circle cx="60" cy="150" r="62" fill="none" stroke="#fff" strokeOpacity="0.07" strokeWidth="1.5" />
        <circle cx="60" cy="150" r="30" fill="none" stroke="#fff" strokeOpacity="0.06" strokeWidth="1.5" />
        <text x="8" y="22" fontSize="14" fontWeight="800" fill="#fff" fillOpacity="0.10" fontFamily="var(--font-display), Inter">
          {team?.abbr ?? ""}
        </text>
        {/* head + neck */}
        <path d="M51 66 L51 76 Q60 81 69 76 L69 66 Z" fill={`url(#skin${uid})`} />
        <ellipse cx="60" cy="48" rx="17" ry="20" fill={`url(#skin${uid})`} />
        <path d="M43 44 Q44 26 60 26 Q76 26 77 44 Q72 34 60 34 Q48 34 43 44 Z" fill="#0B1222" fillOpacity="0.85" />
        <ellipse cx="60" cy="48" rx="17" ry="20" fill="none" stroke={`url(#rim${uid})`} strokeWidth="1.2" />
        {/* shoulders / arms */}
        <path d="M14 138 Q16 96 36 86 L50 80 L70 80 L84 86 Q104 96 106 138 Z" fill={`url(#skin${uid})`} />
        {/* jersey (tank) */}
        <path d="M33 138 L35 96 Q37 86 46 82 Q52 92 60 92 Q68 92 74 82 Q83 86 85 96 L87 138 Z" fill={`url(#jer${uid})`} />
        <path d="M46 82 Q52 92 60 92 Q68 92 74 82" fill="none" stroke={secondary} strokeWidth="3" />
        <path d="M35 96 Q37 86 46 82 M74 82 Q83 86 85 96" fill="none" stroke={secondary} strokeWidth="2.4" />
        <text
          x="60"
          y="126"
          textAnchor="middle"
          fontSize={num.length > 1 ? 26 : 28}
          fontWeight="900"
          fill={jerseyText}
          stroke={secondary}
          strokeWidth="0.8"
          fontFamily="var(--font-display), Inter, sans-serif"
          letterSpacing="-1"
        >
          {num || initials}
        </text>
      </g>
      <rect x="0.5" y="0.5" width="119" height="137" rx="13.5" fill="none" stroke="#fff" strokeOpacity="0.08" />
    </svg>
  );
}

export function RosterBadge({ player }: { player: Pick<Player, "roster"> }) {
  if (!player.roster) return null;
  return player.roster.verified ? (
    <span className="text-[10px] font-semibold uppercase tracking-wider text-gain">roster verified</span>
  ) : (
    <span title={`Affiliation from ${player.roster.source} (${player.roster.season}); confirm with a provider roster sync`} className="text-[10px] font-semibold uppercase tracking-wider text-gold">
      seed roster · unverified
    </span>
  );
}
