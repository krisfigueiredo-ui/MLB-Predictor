"use client";

import {
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
  type SortingState,
} from "@tanstack/react-table";
import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight, Search } from "lucide-react";
import { useState } from "react";

import { cn } from "@/lib/format";

export function DataTable<T>({
  data,
  columns,
  pageSize = 15,
  searchable,
  dense,
  onRowClick,
  initialSort,
  className,
}: {
  data: T[];
  columns: ColumnDef<T, any>[];
  pageSize?: number;
  searchable?: boolean;
  dense?: boolean;
  onRowClick?: (row: T) => void;
  initialSort?: SortingState;
  className?: string;
}) {
  const [sorting, setSorting] = useState<SortingState>(initialSort ?? []);
  const [filter, setFilter] = useState("");
  const table = useReactTable({
    data,
    columns,
    state: { sorting, globalFilter: filter },
    onSortingChange: setSorting,
    onGlobalFilterChange: setFilter,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    initialState: { pagination: { pageSize } },
  });
  const pages = table.getPageCount();
  return (
    <div className={cn("w-full", className)}>
      {searchable && (
        <div className="flex items-center gap-2 border-b border-line/70 px-3 py-2">
          <Search className="h-3.5 w-3.5 text-mist-500" />
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter…"
            className="w-full bg-transparent text-xs text-mist placeholder:text-mist-500 focus:outline-none"
          />
        </div>
      )}
      <div className="overflow-x-auto">
        <table className="w-full min-w-[640px] text-left text-[12.5px]">
          <thead>
            {table.getHeaderGroups().map((hg) => (
              <tr key={hg.id} className="border-b border-line/70">
                {hg.headers.map((h) => (
                  <th
                    key={h.id}
                    onClick={h.column.getToggleSortingHandler()}
                    className={cn(
                      "label select-none whitespace-nowrap px-3 py-2 font-semibold",
                      h.column.getCanSort() && "cursor-pointer hover:text-mist",
                      (h.column.columnDef.meta as any)?.align === "right" && "text-right",
                    )}
                  >
                    <span className="inline-flex items-center gap-1">
                      {flexRender(h.column.columnDef.header, h.getContext())}
                      {h.column.getIsSorted() === "asc" && <ArrowUp className="h-3 w-3" />}
                      {h.column.getIsSorted() === "desc" && <ArrowDown className="h-3 w-3" />}
                    </span>
                  </th>
                ))}
              </tr>
            ))}
          </thead>
          <tbody>
            {table.getRowModel().rows.map((r) => (
              <tr
                key={r.id}
                onClick={onRowClick ? () => onRowClick(r.original) : undefined}
                className={cn("border-b border-line/40 transition-colors hover:bg-volt/[0.04]", onRowClick && "cursor-pointer")}
              >
                {r.getVisibleCells().map((c) => (
                  <td
                    key={c.id}
                    className={cn(
                      "whitespace-nowrap px-3 tabular text-mist-300",
                      dense ? "py-1.5" : "py-2.5",
                      (c.column.columnDef.meta as any)?.align === "right" && "text-right",
                    )}
                  >
                    {flexRender(c.column.columnDef.cell, c.getContext())}
                  </td>
                ))}
              </tr>
            ))}
            {table.getRowModel().rows.length === 0 && (
              <tr>
                <td colSpan={columns.length} className="px-3 py-8 text-center text-xs text-mist-500">
                  No rows
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {pages > 1 && (
        <div className="flex items-center justify-between px-3 py-2 text-[11px] text-mist-400">
          <span>
            {table.getFilteredRowModel().rows.length.toLocaleString()} rows · page {table.getState().pagination.pageIndex + 1} / {pages}
          </span>
          <div className="flex gap-1">
            <button aria-label="previous page" className="rounded-md p-1 hover:bg-ink-700 disabled:opacity-30" onClick={() => table.previousPage()} disabled={!table.getCanPreviousPage()}>
              <ChevronLeft className="h-4 w-4" />
            </button>
            <button aria-label="next page" className="rounded-md p-1 hover:bg-ink-700 disabled:opacity-30" onClick={() => table.nextPage()} disabled={!table.getCanNextPage()}>
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
