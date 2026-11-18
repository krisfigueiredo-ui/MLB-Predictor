"use client";

import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";

import { API_BASE, api } from "./api";
import type { Game } from "./types";

export interface TickerPayload {
  generated_at: string;
  demo: boolean;
  games: Game[];
}

/** Live ticker: Server-Sent Events when available, falling back to 20s polling. */
export function useTicker(league?: string) {
  const [sse, setSse] = useState<TickerPayload | null>(null);
  const [sseOk, setSseOk] = useState(false);
  const esRef = useRef<EventSource | null>(null);
  const qs = league ? `?league=${league}` : "";

  useEffect(() => {
    if (typeof window === "undefined" || !("EventSource" in window)) return;
    const es = new EventSource(`${API_BASE}/api/stream/ticker${qs}`);
    esRef.current = es;
    es.addEventListener("ticker", (e) => {
      try {
        setSse(JSON.parse((e as MessageEvent).data));
        setSseOk(true);
      } catch {}
    });
    es.onerror = () => setSseOk(false);
    return () => es.close();
  }, [qs]);

  const poll = useQuery<TickerPayload>({
    queryKey: ["ticker", league],
    queryFn: () => api(`/api/ticker${qs}`),
    refetchInterval: sseOk ? false : 20_000,
  });
  return { data: sseOk && sse ? sse : poll.data, transport: sseOk ? "stream" : "polling", isLoading: !sse && poll.isLoading };
}

export function useStatus() {
  return useQuery<any>({ queryKey: ["status"], queryFn: () => api("/api/status"), refetchInterval: 30_000 });
}

export function useNow(intervalMs = 1000) {
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => {
    setNow(new Date());
    const t = setInterval(() => setNow(new Date()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}
