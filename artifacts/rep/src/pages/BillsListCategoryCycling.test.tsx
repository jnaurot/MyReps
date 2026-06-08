import { describe, it, expect } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useRef, useState, useEffect } from "react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// ── Fixture ──────────────────────────────────────────────────────────────────
// A rep with 2 active bills, 1 active resolution, 1 active amendment.
const PASSED_BILLS = [
  { id: "119-hr-10", title: "Infrastructure Act", itemCategory: "bill" },
  { id: "119-hr-11", title: "Energy Reform Act",  itemCategory: "bill" },
];
const PASSED_RESOLUTIONS = [
  { id: "119-hres-5", title: "Climate Resolution", itemCategory: "resolution" },
];
const PASSED_AMENDMENTS = [
  { id: "119-samdt-99", title: "Budget Amendment", itemCategory: "amendment" },
];
const PASSED_ALL = [...PASSED_BILLS, ...PASSED_RESOLUTIONS, ...PASSED_AMENDMENTS];

function fk(category: string) {
  // Matches BillsList filterKey: `${billRole}|${category}|${query}|${stageQuery}|${policyArea}`
  return `sponsored|${category}||active|`;
}

// ── Minimal hook — mirrors the mobile useEffect block in BillsList ───────────
// Keep in sync with FederalRepDetail.tsx BillsList. If those effects change,
// update this hook so the behavioral tests stay meaningful.
function useMobileAccumulation({
  filterKey,
  offset,
  bills,
  isLoading = false,
  isPlaceholderData = false,
}: {
  filterKey: string;
  offset: number;
  bills: any[];
  isLoading?: boolean;
  isPlaceholderData?: boolean;
}) {
  const [allBills, setAllBills] = useState<any[]>([]);
  const appendedOffsetRef = useRef(new Set<number>());
  const prevFilterKeyRef = useRef<string | null>(null);

  // Single effect — atomically resets on filter change, then appends/replaces
  useEffect(() => {
    if (isLoading || isPlaceholderData) return;

    if (prevFilterKeyRef.current !== filterKey) {
      appendedOffsetRef.current = new Set();
      prevFilterKeyRef.current = filterKey;
    }

    if (appendedOffsetRef.current.has(offset)) return;
    appendedOffsetRef.current.add(offset);

    if (offset === 0) {
      setAllBills(bills);
    } else if (bills.length > 0) {
      setAllBills((prev) => {
        const seen = new Set(prev.map((b) => b.id));
        const fresh = bills.filter((b) => !seen.has(b.id));
        return fresh.length > 0 ? [...prev, ...fresh] : prev;
      });
    }
  }, [isLoading, isPlaceholderData, filterKey, offset, bills]);

  return allBills;
}

// ── Source guard — verifies BillsList carries the fix ────────────────────────
function getBillsListSource() {
  return readFileSync(resolve(import.meta.dirname, "FederalRepDetail.tsx"), "utf8");
}

describe("BillsList source — mobile accumulation fix", () => {
  it("single effect atomically resets on filter change then replaces on offset 0", () => {
    const src = getBillsListSource();
    expect(src).toContain("prevFilterKeyRef.current !== filterKey");
    expect(src).toContain("appendedOffsetRef.current = new Set()");
    expect(src).toContain("offset === 0");
    expect(src).toContain("setAllBills(displayedBills)");
  });
});

// ── Behavioral tests ─────────────────────────────────────────────────────────
describe("BillsList mobile accumulation — cycling categories with Active Bills status filter", () => {
  it("cycle 1: All → Bills → Resolutions → Amendments shows correct counts", () => {
    const { result, rerender } = renderHook(
      (props: Parameters<typeof useMobileAccumulation>[0]) =>
        useMobileAccumulation(props),
      { initialProps: { filterKey: fk("all"), offset: 0, bills: PASSED_ALL } },
    );

    expect(result.current).toHaveLength(4); // All: 4 total

    act(() => { rerender({ filterKey: fk("bill"),       offset: 0, bills: PASSED_BILLS       }); });
    expect(result.current).toHaveLength(2); // Bills: 2

    act(() => { rerender({ filterKey: fk("resolution"), offset: 0, bills: PASSED_RESOLUTIONS }); });
    expect(result.current).toHaveLength(1); // Resolutions: 1

    act(() => { rerender({ filterKey: fk("amendment"),  offset: 0, bills: PASSED_AMENDMENTS  }); });
    expect(result.current).toHaveLength(1); // Amendments: 1
  });

  it("cycle 2: revisiting each category shows exact counts — no stale accumulation", () => {
    const { result, rerender } = renderHook(
      (props: Parameters<typeof useMobileAccumulation>[0]) =>
        useMobileAccumulation(props),
      { initialProps: { filterKey: fk("all"), offset: 0, bills: PASSED_ALL } },
    );

    // Cycle 1 — prime the accumulated state
    act(() => { rerender({ filterKey: fk("bill"),       offset: 0, bills: PASSED_BILLS       }); });
    act(() => { rerender({ filterKey: fk("resolution"), offset: 0, bills: PASSED_RESOLUTIONS }); });
    act(() => { rerender({ filterKey: fk("amendment"),  offset: 0, bills: PASSED_AMENDMENTS  }); });

    // Cycle 2 — each revisit must show only its own items
    act(() => { rerender({ filterKey: fk("bill"),       offset: 0, bills: PASSED_BILLS       }); });
    expect(result.current).toHaveLength(2); // was 3 before fix (amendment leaked in)

    act(() => { rerender({ filterKey: fk("resolution"), offset: 0, bills: PASSED_RESOLUTIONS }); });
    expect(result.current).toHaveLength(1); // was 3 before fix

    act(() => { rerender({ filterKey: fk("amendment"),  offset: 0, bills: PASSED_AMENDMENTS  }); });
    expect(result.current).toHaveLength(1); // was 2 before fix

    act(() => { rerender({ filterKey: fk("all"),        offset: 0, bills: PASSED_ALL         }); });
    expect(result.current).toHaveLength(4); // All: back to full set
  });

  it("a category with zero matching items clears the list rather than leaving stale items", () => {
    const { result, rerender } = renderHook(
      (props: Parameters<typeof useMobileAccumulation>[0]) =>
        useMobileAccumulation(props),
      { initialProps: { filterKey: fk("bill"), offset: 0, bills: PASSED_BILLS } },
    );

    expect(result.current).toHaveLength(2);

    act(() => { rerender({ filterKey: fk("other"), offset: 0, bills: [] }); });
    expect(result.current).toHaveLength(0); // stale bills must be gone
  });

  it("pagination accumulates across offset pages within the same filter", () => {
    const page0 = PASSED_BILLS;                                               // 2 items
    const page1 = [{ id: "119-hr-20", title: "Bill C", itemCategory: "bill" }]; // 1 item

    const { result, rerender } = renderHook(
      (props: Parameters<typeof useMobileAccumulation>[0]) =>
        useMobileAccumulation(props),
      { initialProps: { filterKey: fk("bill"), offset: 0, bills: page0 } },
    );

    expect(result.current).toHaveLength(2);

    act(() => { rerender({ filterKey: fk("bill"), offset: 2, bills: page1 }); });
    expect(result.current).toHaveLength(3); // page 0 + page 1
  });

  it("background refetch for the same filter and offset does not double-append", () => {
    const bills = PASSED_BILLS;
    const refetched = [...PASSED_BILLS]; // same content, new array reference

    const { result, rerender } = renderHook(
      (props: Parameters<typeof useMobileAccumulation>[0]) =>
        useMobileAccumulation(props),
      { initialProps: { filterKey: fk("bill"), offset: 0, bills } },
    );

    expect(result.current).toHaveLength(2);

    act(() => { rerender({ filterKey: fk("bill"), offset: 0, bills: refetched }); });
    expect(result.current).toHaveLength(2); // not 4
  });
});
