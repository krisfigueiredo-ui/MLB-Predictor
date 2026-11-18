"use client";

import { useQuery, type UseQueryOptions } from "@tanstack/react-query";

export const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "";

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export async function api<T = any>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: { ...(init?.body && !(init.body instanceof FormData) ? { "Content-Type": "application/json" } : {}), ...init?.headers },
  });
  if (!res.ok) {
    let msg = res.statusText;
    try {
      const j = await res.json();
      msg = typeof j.detail === "string" ? j.detail : JSON.stringify(j.detail ?? j);
    } catch {}
    throw new ApiError(res.status, msg);
  }
  return res.json() as Promise<T>;
}

export function useApi<T = any>(path: string | null, opts?: Partial<UseQueryOptions<T>>) {
  return useQuery<T>({
    queryKey: [path],
    queryFn: () => api<T>(path as string),
    enabled: !!path,
    ...(opts as any),
  });
}

export const exportUrl = (dataset: string, format: "csv" | "xlsx" | "json", league?: string) =>
  `${API_BASE}/api/data/export/${dataset}?format=${format}${league ? `&league=${league}` : ""}`;
