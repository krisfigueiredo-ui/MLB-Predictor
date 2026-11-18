"use client";

import { BookOpen, Search } from "lucide-react";
import { useState } from "react";

import { AIChat } from "@/components/shell/AIChat";
import { Badge, PageHeader, Panel, PanelHeader } from "@/components/ui/primitives";
import { useApi } from "@/lib/api";

export default function AIPage() {
  const status = useApi<any>("/api/ai/status");
  const [q, setQ] = useState("");
  const [term, setTerm] = useState("model methodology");
  const docs = useApi<any[]>(`/api/ai/search?q=${encodeURIComponent(term)}&k=6`);
  return (
    <div className="space-y-6">
      <PageHeader
        index="12"
        title="COURTSIDE AI"
        subtitle="A research analyst powered by Claude. It retrieves records through read-only database tools and pgvector search, cites what it used, and explains the Python models' outputs. It never computes probabilities itself."
        right={status.data && <Badge tone={status.data.enabled ? "gain" : "gold"}>{status.data.enabled ? `${status.data.model} · effort ${status.data.effort}` : "API key not configured"}</Badge>}
      />
      <div className="grid gap-6 xl:grid-cols-[1fr_380px]">
        <Panel className="flex min-h-[640px] flex-col">
          <AIChat context={{ page: "/ai" }} />
        </Panel>
        <div className="space-y-6">
          <Panel>
            <PanelHeader eyebrow="Tools available to the assistant" title="Read-only data access" />
            <ul className="space-y-1 p-4 font-mono text-[11.5px] text-mist-300">
              {(status.data?.tools ?? []).map((t: string) => (
                <li key={t} className="flex items-center gap-2">
                  <span className="h-1 w-1 rounded-full bg-volt" /> {t}
                </li>
              ))}
            </ul>
          </Panel>
          <Panel>
            <PanelHeader eyebrow="Retrieval (RAG)" title="Search the knowledge base" icon={<BookOpen className="h-4 w-4 text-cyan" />} />
            <form
              className="flex gap-2 p-3"
              onSubmit={(e) => {
                e.preventDefault();
                if (q.trim()) setTerm(q);
              }}
            >
              <div className="flex flex-1 items-center gap-2 rounded-lg border border-line bg-ink-900 px-2">
                <Search className="h-3.5 w-3.5 text-mist-500" />
                <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="e.g. how is win probability calibrated?" className="w-full bg-transparent py-1.5 text-xs text-mist focus:outline-none" />
              </div>
            </form>
            <ul className="divide-y divide-line/50">
              {(docs.data ?? []).map((d) => (
                <li key={d.id} className="px-4 py-3">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm font-medium text-mist">{d.title}</span>
                    <span className="font-mono text-[10px] text-mist-500">{d.score.toFixed(2)}</span>
                  </div>
                  <div className="mt-0.5 text-[10px] uppercase tracking-wider text-volt-300">{d.source_type}</div>
                  <p className="mt-1 line-clamp-3 text-[11.5px] leading-relaxed text-mist-400">{d.content}</p>
                </li>
              ))}
            </ul>
          </Panel>
        </div>
      </div>
    </div>
  );
}
