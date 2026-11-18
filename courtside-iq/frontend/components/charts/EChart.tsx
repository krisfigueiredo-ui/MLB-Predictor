"use client";

import dynamic from "next/dynamic";
import type { EChartsOption } from "echarts";

const ReactECharts = dynamic(() => import("echarts-for-react"), { ssr: false, loading: () => <div className="skeleton h-full w-full" /> });

export const C = {
  volt: "#2F7BFF",
  cyan: "#22D3EE",
  gain: "#22C55E",
  loss: "#F43F5E",
  flare: "#FF8A3D",
  gold: "#F5C451",
  mist: "#E6EDF7",
  mist4: "#8A9BB8",
  mist5: "#647696",
  line: "#1A2A46",
  ink: "#0A1222",
  violet: "#A78BFA",
};

export const SERIES = [C.volt, C.cyan, C.flare, C.violet, C.gold, C.gain];

export const baseAxis = {
  axisLine: { lineStyle: { color: C.line } },
  axisTick: { show: false },
  axisLabel: { color: C.mist5, fontSize: 10.5, fontFamily: "var(--font-mono), monospace" },
  splitLine: { lineStyle: { color: "rgba(26,42,70,0.6)", type: "dashed" as const } },
  nameTextStyle: { color: C.mist5, fontSize: 10.5 },
};

export const tooltip = {
  trigger: "axis" as const,
  backgroundColor: "rgba(10,18,34,0.96)",
  borderColor: C.line,
  borderWidth: 1,
  padding: [8, 10],
  textStyle: { color: C.mist, fontSize: 12 },
  axisPointer: { lineStyle: { color: "rgba(47,123,255,0.5)" }, crossStyle: { color: C.mist5 } },
};

export function EChart({ option, height = 260, className, onEvents }: { option: EChartsOption; height?: number | string; className?: string; onEvents?: Record<string, (p: any) => void> }) {
  return (
    <div className={className} style={{ height }}>
      <ReactECharts
        option={{ backgroundColor: "transparent", textStyle: { fontFamily: "var(--font-sans), Inter, sans-serif" }, animationDuration: 600, ...option }}
        style={{ height: "100%", width: "100%" }}
        notMerge
        lazyUpdate
        opts={{ renderer: "canvas" }}
        onEvents={onEvents}
      />
    </div>
  );
}
