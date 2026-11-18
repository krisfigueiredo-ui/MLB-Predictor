import { createColumnHelper } from "@tanstack/react-table";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { DataTable } from "@/components/ui/DataTable";
import { ProbBar, ResultBadge, Stat } from "@/components/ui/primitives";

describe("DataTable", () => {
  type Row = { team: string; net: number };
  const col = createColumnHelper<Row>();
  const columns = [col.accessor("team", { header: "Team" }), col.accessor("net", { header: "Net" })];
  const data = [{ team: "A", net: 1 }, { team: "B", net: 9 }, { team: "C", net: -3 }];

  it("sorts when a header is clicked and filters rows", () => {
    render(<DataTable data={data} columns={columns} searchable />);
    // numeric columns sort descending first (TanStack default), then ascending
    fireEvent.click(screen.getByText("Net"));
    let rows = screen.getAllByRole("row").slice(1);
    expect(within(rows[0]).getByText("B")).toBeInTheDocument();
    fireEvent.click(screen.getByText("Net"));
    rows = screen.getAllByRole("row").slice(1);
    expect(within(rows[0]).getByText("C")).toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText("Filter…"), { target: { value: "A" } });
    expect(screen.getAllByRole("row")).toHaveLength(2);
  });
});

describe("primitives", () => {
  it("ProbBar sizes segments by probability including pushes", () => {
    const { container } = render(<ProbBar left={0.55} right={0.4} push={0.05} />);
    const segs = container.querySelectorAll(".flex.h-1\\.5 > div");
    expect((segs[0] as HTMLElement).style.width).toBe("55.00000000000001%");
    expect(segs).toHaveLength(3);
  });
  it("ResultBadge and Stat render", () => {
    render(<><ResultBadge result="win" /><Stat label="Hit rate" value="57.3%" /></>);
    expect(screen.getByText("win")).toBeInTheDocument();
    expect(screen.getByText("57.3%")).toBeInTheDocument();
  });
});
