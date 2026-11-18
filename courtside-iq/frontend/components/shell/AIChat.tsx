"use client";

import { useMutation } from "@tanstack/react-query";
import { motion } from "framer-motion";
import { ArrowUp, Bot, Database, KeyRound, Loader2, Wrench } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";

import { api, useApi } from "@/lib/api";
import { cn } from "@/lib/format";

interface Msg {
  role: "user" | "assistant";
  content: string;
  citations?: any[];
  tool_calls?: any[];
  error?: string;
  model?: string;
}

const SUGGESTIONS = [
  "What are the model's largest disagreements with Vegas today?",
  "Which NCAA schools have the highest offensive efficiency?",
  "How accurate has the model been for rebounds props?",
  "Which markets have the worst probability calibration?",
  "What did the model get wrong yesterday?",
  "Which conferences produce the largest forecast errors?",
];

/** Minimal markdown: paragraphs, bullets, bold, inline code, citation markers. */
function Markdown({ text }: { text: string }) {
  const blocks = text.split(/\n{2,}/);
  const inline = (s: string) =>
    s.split(/(\*\*[^*]+\*\*|`[^`]+`|\[\d+\])/g).map((p, i) => {
      if (p.startsWith("**")) return <strong key={i} className="font-semibold text-mist">{p.slice(2, -2)}</strong>;
      if (p.startsWith("`")) return <code key={i} className="rounded bg-ink-700 px-1 font-mono text-[11.5px] text-cyan">{p.slice(1, -1)}</code>;
      if (/^\[\d+\]$/.test(p)) return <sup key={i} className="ml-0.5 rounded bg-volt/15 px-1 font-mono text-[9.5px] text-volt-300">{p.slice(1, -1)}</sup>;
      return <span key={i}>{p}</span>;
    });
  return (
    <div className="space-y-2.5 text-[13px] leading-relaxed text-mist-300">
      {blocks.map((b, i) => {
        const lines = b.split("\n");
        if (lines.every((l) => /^\s*([-*]|\d+\.)\s/.test(l)))
          return (
            <ul key={i} className="ml-4 list-disc space-y-1 marker:text-volt">
              {lines.map((l, j) => (
                <li key={j}>{inline(l.replace(/^\s*([-*]|\d+\.)\s/, ""))}</li>
              ))}
            </ul>
          );
        if (lines[0].startsWith("|"))
          return (
            <pre key={i} className="overflow-x-auto rounded-lg border border-line bg-ink-900 p-2 font-mono text-[11px] text-mist-300">
              {b}
            </pre>
          );
        if (/^#{1,4}\s/.test(lines[0]))
          return (
            <div key={i}>
              <div className="font-display text-sm font-semibold text-mist">{lines[0].replace(/^#+\s/, "")}</div>
              {lines.slice(1).map((l, j) => (
                <p key={j}>{inline(l)}</p>
              ))}
            </div>
          );
        return <p key={i}>{inline(b)}</p>;
      })}
    </div>
  );
}

export function AIChat({ compact, context }: { compact?: boolean; context?: Record<string, any> }) {
  const status = useApi<any>("/api/ai/status");
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [q, setQ] = useState("");
  const bottom = useRef<HTMLDivElement>(null);
  const ask = useMutation({
    mutationFn: (question: string) =>
      api<any>("/api/ai/ask", {
        method: "POST",
        body: JSON.stringify({ question, history: msgs.filter((m) => !m.error).map((m) => ({ role: m.role, content: m.content })), context }),
      }),
    onSuccess: (r) =>
      setMsgs((m) => [...m, { role: "assistant", content: r.answer ?? "", citations: r.citations, tool_calls: r.tool_calls, error: r.error, model: r.model }]),
    onError: (e: any) => setMsgs((m) => [...m, { role: "assistant", content: "", error: e.message }]),
  });
  useEffect(() => bottom.current?.scrollIntoView({ behavior: "smooth" }), [msgs, ask.isPending]);
  const send = (text: string) => {
    if (!text.trim() || ask.isPending) return;
    setMsgs((m) => [...m, { role: "user", content: text }]);
    setQ("");
    ask.mutate(text);
  };
  const disabled = status.data && !status.data.enabled;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className={cn("flex-1 space-y-4 overflow-y-auto px-4 py-4", !compact && "min-h-[420px]")}>
        {disabled && (
          <div className="rounded-xl border border-gold/30 bg-gold/5 p-3 text-xs text-gold">
            <div className="flex items-center gap-2 font-semibold">
              <KeyRound className="h-3.5 w-3.5" /> Claude API key not configured
            </div>
            <p className="mt-1 text-gold/80">
              Set <code className="font-mono">ANTHROPIC_API_KEY</code> on the backend to enable COURTSIDE AI. All other analytics work without it.{" "}
              <Link href="/settings" className="underline">
                Settings
              </Link>
            </p>
          </div>
        )}
        {msgs.length === 0 && (
          <div className="space-y-3">
            <div className="flex items-start gap-3">
              <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-volt to-cyan">
                <Bot className="h-3.5 w-3.5 text-white" />
              </div>
              <p className="text-[13px] leading-relaxed text-mist-300">
                I research the platform&apos;s own records: projections, odds snapshots, statistics, archived predictions and diagnostics. Probabilities come from the Python models; I
                explain them and cite the records I used.
              </p>
            </div>
            <div className="grid gap-2">
              {SUGGESTIONS.map((s) => (
                <button
                  key={s}
                  onClick={() => send(s)}
                  disabled={!!disabled}
                  className="rounded-lg border border-line bg-ink-900/60 px-3 py-2 text-left text-xs text-mist-300 transition-all hover:border-volt/40 hover:text-mist disabled:opacity-50"
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}
        {msgs.map((m, i) => (
          <motion.div key={i} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} className={cn("flex", m.role === "user" ? "justify-end" : "justify-start")}>
            {m.role === "user" ? (
              <div className="max-w-[85%] rounded-2xl rounded-br-md bg-volt/15 px-3.5 py-2 text-[13px] text-mist">{m.content}</div>
            ) : (
              <div className="w-full space-y-2">
                {m.error ? (
                  <div className="rounded-lg border border-loss/30 bg-loss/5 px-3 py-2 text-xs text-loss">{m.error}</div>
                ) : (
                  <Markdown text={m.content} />
                )}
                {!!m.tool_calls?.length && (
                  <div className="flex flex-wrap gap-1">
                    {m.tool_calls.map((t, j) => (
                      <span key={j} className="inline-flex items-center gap-1 rounded-md border border-line bg-ink-900 px-1.5 py-0.5 font-mono text-[10px] text-mist-400">
                        <Wrench className="h-2.5 w-2.5" /> {t.tool}
                      </span>
                    ))}
                  </div>
                )}
                {!!m.citations?.length && (
                  <div className="rounded-lg border border-line bg-ink-900/60 p-2">
                    <div className="label mb-1 flex items-center gap-1">
                      <Database className="h-3 w-3" /> Sources
                    </div>
                    <ol className="space-y-0.5 text-[10.5px] text-mist-400">
                      {m.citations.slice(0, 12).map((c) => (
                        <li key={c.n} className="flex gap-1.5">
                          <span className="font-mono text-volt-300">[{c.n}]</span>
                          <span className="truncate">
                            {c.table}#{String(c.id)} {c.label ? `· ${c.label}` : ""} {c.timestamp ? `· ${new Date(c.timestamp).toLocaleString()}` : ""}
                          </span>
                        </li>
                      ))}
                    </ol>
                  </div>
                )}
              </div>
            )}
          </motion.div>
        ))}
        {ask.isPending && (
          <div className="flex items-center gap-2 text-xs text-mist-400">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> Retrieving records and reasoning…
          </div>
        )}
        <div ref={bottom} />
      </div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          send(q);
        }}
        className="border-t border-line p-3"
      >
        <div className="flex items-end gap-2 rounded-xl border border-line bg-ink-900 p-2 focus-within:border-volt/50">
          <textarea
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send(q);
              }
            }}
            rows={compact ? 2 : 3}
            placeholder={disabled ? "COURTSIDE AI is disabled until an API key is configured" : "Ask about a game, team, player, market or the model…"}
            disabled={!!disabled}
            className="flex-1 resize-none bg-transparent px-1 text-[13px] text-mist placeholder:text-mist-500 focus:outline-none"
          />
          <button type="submit" disabled={!q.trim() || ask.isPending || !!disabled} className="rounded-lg bg-volt p-2 text-white transition-all hover:bg-volt-400 disabled:opacity-40" aria-label="Send">
            <ArrowUp className="h-4 w-4" />
          </button>
        </div>
        <div className="mt-1.5 px-1 text-[10px] text-mist-500">
          {status.data?.enabled ? `Model ${status.data.model} · ${status.data.tools?.length ?? 0} read-only tools` : "Claude via the Anthropic API · read-only database tools"}
        </div>
      </form>
    </div>
  );
}
