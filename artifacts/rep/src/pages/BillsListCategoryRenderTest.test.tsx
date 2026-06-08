// Component-level regression test for the mobile bill accumulation bug.
// Renders BillsList in mobile mode, cycles through All/Bills/Resolutions/Amendments
// twice with an Active filter active, and asserts:
//   1. The number of rendered bill-item DOM elements matches the API totalCount.
//   2. The mobile counter text (e.g. "2/2") matches — denominator comes from API,
//      numerator from allBills.length — so a mismatch (e.g. "3/2") fails the test.

import { describe, it, expect, vi, beforeAll } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BillsList } from "./FederalRepDetail";

// ── jsdom stubs ───────────────────────────────────────────────────────────────
// Run requestAnimationFrame callbacks synchronously so lastVisible updates
// in the same act() flush as the state change that triggers them.
beforeAll(() => {
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    cb(0);
    return 0;
  });
  vi.stubGlobal("cancelAnimationFrame", () => {});
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
});

// ── Fixture ───────────────────────────────────────────────────────────────────
// Rep with 2 active bills, 1 active resolution, 1 active amendment.
const BY_CATEGORY: Record<string, any[]> = {
  all: [
    { id: "119-hr-10",    title: "Infrastructure Act",  number: "HR 10",    congress: "119", itemCategory: "bill"       },
    { id: "119-hr-11",    title: "Energy Reform Act",   number: "HR 11",    congress: "119", itemCategory: "bill"       },
    { id: "119-hres-5",   title: "Climate Resolution",  number: "HRES 5",   congress: "119", itemCategory: "resolution" },
    { id: "119-samdt-99", title: "Budget Amendment",                                         itemCategory: "amendment"  },
  ],
  bill:       [
    { id: "119-hr-10", title: "Infrastructure Act", number: "HR 10", congress: "119", itemCategory: "bill" },
    { id: "119-hr-11", title: "Energy Reform Act",  number: "HR 11", congress: "119", itemCategory: "bill" },
  ],
  resolution: [
    { id: "119-hres-5", title: "Climate Resolution", number: "HRES 5", congress: "119", itemCategory: "resolution" },
  ],
  amendment:  [
    { id: "119-samdt-99", title: "Budget Amendment", itemCategory: "amendment" },
  ],
  other: [],
};

// ── Mocks ─────────────────────────────────────────────────────────────────────
vi.mock("@workspace/api-client-react", () => ({
  useGetFederalMemberBills: (_id: string, params: any) => {
    const cat = params?.category ?? "all";
    const bills = BY_CATEGORY[cat] ?? [];
    return {
      data: {
        bills,
        totalCount: bills.length,
        categoryCounts: { all: 4, bill: 2, resolution: 1, amendment: 1, other: 0 },
        fullyIngested: true,
        policyAreas: [],
      },
      isLoading: false,
      isPlaceholderData: false,
    };
  },
  useRefreshFederalMemberBills: () => ({ mutate: vi.fn(), isPending: false }),
  getGetFederalMemberBillsQueryKey: () => ["test-bills"],
}));

vi.mock("wouter", () => ({
  useParams: () => ({}),
  useSearch: () => "",
  Link: ({ children, href, ...rest }: any) => (
    <a href={href ?? "#"} {...rest}>
      {children}
    </a>
  ),
}));

vi.mock("@/hooks/useIsMobile", () => ({ useIsMobile: () => true }));
vi.mock("@/hooks/use-toast",   () => ({ toast: vi.fn() }));

// ── Helpers ───────────────────────────────────────────────────────────────────
function wrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

/** Click a button whose accessible name matches the pattern and wait for the
 *  expected number of bill-item elements to appear in the DOM. */
async function go(buttonPattern: RegExp, expectedCount: number) {
  fireEvent.click(screen.getByRole("button", { name: buttonPattern }));
  await waitFor(() => {
    expect(screen.queryAllByTestId("bill-item")).toHaveLength(expectedCount);
  });
  // The mobile counter must show "N/N" — numerator (allBills.length) must equal
  // denominator (API totalCount). A mismatch like "3/2" means stale accumulation.
  if (expectedCount > 0) {
    await waitFor(() => {
      expect(
        screen.getByText(`${expectedCount}/${expectedCount}`),
      ).toBeInTheDocument();
    });
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────────
describe("BillsList — rendered items match totalCount after cycling categories (mobile)", () => {
  it("cycle 1 then cycle 2: item count and counter text are correct at every step", async () => {
    render(
      <BillsList
        bioguideId="A000001"
        billRole="sponsored"
        onBillRoleChange={vi.fn()}
      />,
      { wrapper },
    );

    // Choose "Active"
    fireEvent.click(screen.getByRole("button", { name: "Active" }));

    // ── Cycle 1 ──────────────────────────────────────────────────────────────
    await go(/^All \(/, 4);         // All: 4 items → counter "4/4"
    await go(/^Bills \(/, 2);       // Bills: 2 items → counter "2/2"
    await go(/^Resolutions \(/, 1); // Resolutions: 1 item → counter "1/1"
    await go(/^Amendments \(/, 1);  // Amendments: 1 item → counter "1/1"

    // ── Cycle 2 — stale accumulation would inflate the counts ─────────────
    await go(/^Bills \(/, 2);       // must be 2, not 3 (bug: amendment leaked in)
    await go(/^Resolutions \(/, 1); // must be 1, not 3 (bug: all combined)
    await go(/^Amendments \(/, 1);  // must be 1, not 2 (bug)
    await go(/^All \(/, 4);         // must be 4, not stale from amendment
  });
});
