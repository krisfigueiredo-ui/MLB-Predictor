"use client";

import { AnimatePresence, motion } from "framer-motion";
import { Bot, Expand, X } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";

import { AIChat } from "@/components/shell/AIChat";

export function AIPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const path = usePathname();
  const gameMatch = path.match(/^\/games\/(\d+)/);
  const playerMatch = path.match(/^\/players\/(\d+)/);
  const context = gameMatch ? { page: path, game_id: Number(gameMatch[1]) } : playerMatch ? { page: path, player_id: Number(playerMatch[1]) } : { page: path };
  return (
    <AnimatePresence>
      {open && (
        <motion.div className="fixed inset-0 z-[70]" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
          <div className="absolute inset-0 bg-black/50 backdrop-blur-[2px]" onClick={onClose} />
          <motion.aside
            initial={{ x: 480 }}
            animate={{ x: 0 }}
            exit={{ x: 480 }}
            transition={{ type: "spring", stiffness: 340, damping: 34 }}
            className="absolute inset-y-0 right-0 flex w-full max-w-[460px] flex-col border-l border-line bg-ink-950/98"
          >
            <div className="flex items-center justify-between border-b border-line px-4 py-3">
              <div className="flex items-center gap-2">
                <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-volt to-cyan">
                  <Bot className="h-4 w-4 text-white" />
                </div>
                <div>
                  <div className="font-display text-sm font-semibold text-mist">COURTSIDE AI</div>
                  <div className="text-[10.5px] text-mist-500">Answers from verified platform records, with citations</div>
                </div>
              </div>
              <div className="flex items-center gap-1">
                <Link href="/ai" onClick={onClose} className="rounded-md p-1.5 text-mist-400 hover:bg-ink-800 hover:text-mist" aria-label="Open research page">
                  <Expand className="h-4 w-4" />
                </Link>
                <button onClick={onClose} className="rounded-md p-1.5 text-mist-400 hover:bg-ink-800 hover:text-mist" aria-label="Close assistant">
                  <X className="h-4 w-4" />
                </button>
              </div>
            </div>
            <AIChat compact context={context} />
          </motion.aside>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
