"use client";

import { Segmented } from "@/components/ui/primitives";
import { american, cn, pct, signed, spreadLine } from "@/lib/format";
import type { BookQuote, Game, Ladder } from "@/lib/types";
import { useState } from "react";

const toAm = (dec: number | null) => (dec == null || !Number.isFinite(dec) || dec <= 1 ? null : dec >= 2 ? Math.round((dec - 1) * 100) : Math.round(-100 / (dec - 1)));

function Quote({ q }: { q?: BookQuote }) {
  if (!q) return <span className="text-mist-500">—</span>;
  return (
    <span className="whitespace-nowrap">
      {american(q.price)} <span className="text-[10.5px] text-mist-500">{q.book}</span>{" "}
      <span className={cn("text-[11px]", q.ev > 0 ? "text-gain" : "text-mist-500")}>{signed(q.ev * 100, 1)}%</span>
    </span>
  );
}

/** Alternate-line ladder: any line priced from the Monte Carlo simulation, with book quotes where posted. */
export function LadderTable({ ladder, g, mainSpread, mainTotal }: { ladder: Ladder; g: Game; mainSpread?: number | null; mainTotal?: number | null }) {
  const [kind, setKind] = useState<"spreads" | "totals">("spreads");
  const head = "label px-3 py-2 text-left";
  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-2">
        <Segmented size="sm" value={kind} onChange={setKind} options={[{ value: "spreads", label: `Spread (${g.home.abbr} / ${g.away.abbr})` }, { value: "totals", label: "Total" }]} />
        <span className="text-[11px] text-mist-500">Fair odds include pushes (stake returned). EV uses the best posted price.</span>
      </div>
      <div className="max-h-[420px] overflow-auto">
        {kind === "spreads" ? (
          <table className="w-full min-w-[720px] text-[12.5px]">
            <thead className="sticky top-0 bg-ink-850">
              <tr className="border-b border-line/70">
                {[`${g.home.abbr} line`, `P(${g.home.abbr} covers)`, "Push", "Fair", "Book (EV)", `P(${g.away.abbr} covers)`, "Fair", "Book (EV)"].map((h, i) => (
                  <th key={i} className={head}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {ladder.spreads.map((r) => (
                <tr key={r.line_home} className={cn("border-b border-line/40 font-mono tabular text-mist-300", mainSpread != null && r.line_home === mainSpread && "bg-volt/[0.07]")}>
                  <td className="px-3 py-1.5 text-mist">
                    {spreadLine(r.line_home)} {mainSpread != null && r.line_home === mainSpread && <span className="ml-1 font-sans text-[10px] uppercase text-volt-300">main</span>}
                  </td>
                  <td className="px-3 py-1.5 text-volt-300">{pct(r.p_home)}</td>
                  <td className="px-3 py-1.5 text-mist-500">{r.p_push > 0 ? pct(r.p_push, 1) : "—"}</td>
                  <td className="px-3 py-1.5">{american(toAm(r.fair_home))}</td>
                  <td className="px-3 py-1.5"><Quote q={r.book_home} /></td>
                  <td className="px-3 py-1.5 text-cyan">{pct(r.p_away)}</td>
                  <td className="px-3 py-1.5">{american(toAm(r.fair_away))}</td>
                  <td className="px-3 py-1.5"><Quote q={r.book_away} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <table className="w-full min-w-[640px] text-[12.5px]">
            <thead className="sticky top-0 bg-ink-850">
              <tr className="border-b border-line/70">
                {["Total", "P(over)", "Push", "Fair", "Book (EV)", "P(under)", "Fair", "Book (EV)"].map((h, i) => (
                  <th key={i} className={head}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {ladder.totals.map((r) => (
                <tr key={r.line} className={cn("border-b border-line/40 font-mono tabular text-mist-300", mainTotal != null && r.line === mainTotal && "bg-volt/[0.07]")}>
                  <td className="px-3 py-1.5 text-mist">
                    {r.line.toFixed(1)} {mainTotal != null && r.line === mainTotal && <span className="ml-1 font-sans text-[10px] uppercase text-volt-300">main</span>}
                  </td>
                  <td className="px-3 py-1.5 text-volt-300">{pct(r.p_over)}</td>
                  <td className="px-3 py-1.5 text-mist-500">{r.p_push > 0 ? pct(r.p_push, 1) : "—"}</td>
                  <td className="px-3 py-1.5">{american(toAm(r.fair_over))}</td>
                  <td className="px-3 py-1.5"><Quote q={r.book_over} /></td>
                  <td className="px-3 py-1.5 text-flare">{pct(r.p_under)}</td>
                  <td className="px-3 py-1.5">{american(toAm(r.fair_under))}</td>
                  <td className="px-3 py-1.5"><Quote q={r.book_under} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
