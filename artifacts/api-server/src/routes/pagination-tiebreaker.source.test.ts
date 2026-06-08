/**
 * Source guard: every paginated infinite-scroll query must ORDER BY a date column
 * DESC followed by a stable tiebreaker ASC so that PostgreSQL returns rows in a
 * deterministic order across pages.  Without the tiebreaker, rows whose date
 * values tie can appear at different offsets on different queries, causing the
 * front-end accumulator to stall (all returned items are duplicates, so
 * allBills.length never advances past the stall point).
 *
 * Covered query sites:
 *   federal.ts  — federal bills (main list, search, member bills) [3×]
 *   federal.ts  — house votes [1×]
 *   federal.ts  — senate roll-call votes [1×]
 *   state.ts    — state bills (3 paginated sites) [3×]
 *   state.ts    — state vote records [1×]
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const federalSrc = readFileSync(resolve(import.meta.dirname, "./federal.ts"), "utf8");
const stateSrc = readFileSync(resolve(import.meta.dirname, "./state.ts"), "utf8");

// ── helpers ───────────────────────────────────────────────────────────────────

/** Count non-overlapping occurrences of a fixed string in source. */
function countOccurrences(src: string, needle: string): number {
  let count = 0;
  let pos = 0;
  while ((pos = src.indexOf(needle, pos)) !== -1) {
    count++;
    pos += needle.length;
  }
  return count;
}

/**
 * Extract the text of a named paginated query block by slicing from a known
 * anchor string to the next `.limit(limit)` call.  Returns null if the anchor
 * is not found.
 */
function extractBlock(src: string, anchor: string): string | null {
  const start = src.indexOf(anchor);
  if (start === -1) return null;
  const limitPos = src.indexOf(".limit(limit)", start);
  if (limitPos === -1) return null;
  return src.slice(start, limitPos + ".limit(limit)".length);
}

// ── federal bills — main paginated list ──────────────────────────────────────

describe("federal.ts — main federal bills paginated list", () => {
  const block = extractBlock(federalSrc, ".where(and(...dbConditions))\n        .orderBy(desc(federalBillsTable.introducedDate)");

  it("locates the main bills orderBy block", () => {
    expect(block).not.toBeNull();
  });

  it("orders by introducedDate DESC", () => {
    expect(block).toContain("desc(federalBillsTable.introducedDate)");
  });

  it("includes a stable id ASC tiebreaker", () => {
    expect(block).toContain("asc(federalBillsTable.id)");
  });
});

// ── federal bills — full-text search / non-search conditional ────────────────

describe("federal.ts — federal bills search endpoint (non-search branch)", () => {
  // The search endpoint uses a spread: ...(q ? [...] : [desc(...), asc(...)])
  const anchor = ".where(and(...conditions))\n      .orderBy(\n        ...(q";
  const block = extractBlock(federalSrc, anchor);

  it("locates the search-endpoint orderBy block", () => {
    expect(block).not.toBeNull();
  });

  it("non-search branch orders by introducedDate DESC", () => {
    expect(block).toContain("desc(federalBillsTable.introducedDate)");
  });

  it("non-search branch includes stable id ASC tiebreaker", () => {
    expect(block).toContain("asc(federalBillsTable.id)");
  });

  it("search branch does NOT inject the tiebreaker (uses relevance rank only)", () => {
    // The search branch array is closed before the asc() expression
    const searchBranchClose = block?.indexOf("]");
    const tiebreakPos = block?.indexOf("asc(federalBillsTable.id)");
    // tiebreaker must appear after the first ] (i.e., in the non-search branch)
    expect(searchBranchClose).toBeDefined();
    expect(tiebreakPos).toBeDefined();
    expect(tiebreakPos!).toBeGreaterThan(searchBranchClose!);
  });
});

// ── federal bills — member bills (BillsList inside a member-detail route) ────

describe("federal.ts — member bills paginated list (non-search branch)", () => {
  const anchor = ".where(and(...filterConditions))\n          .orderBy(\n            ...(q";
  const block = extractBlock(federalSrc, anchor);

  it("locates the member-bills orderBy block", () => {
    expect(block).not.toBeNull();
  });

  it("non-search branch orders by introducedDate DESC", () => {
    expect(block).toContain("desc(federalBillsTable.introducedDate)");
  });

  it("non-search branch includes stable id ASC tiebreaker", () => {
    expect(block).toContain("asc(federalBillsTable.id)");
  });
});

// ── federal bills — overall tiebreaker count sanity ──────────────────────────

describe("federal.ts — asc tiebreaker occurrence count", () => {
  it("asc(federalBillsTable.id) appears exactly 4 times (main list + search + member bills + refresh)", () => {
    expect(countOccurrences(federalSrc, "asc(federalBillsTable.id)")).toBe(4);
  });
});

// ── house votes ───────────────────────────────────────────────────────────────

describe("federal.ts — house votes paginated list", () => {
  const block = extractBlock(federalSrc, ".where(and(...filterConditions))\n      .orderBy(desc(houseVotesTable.voteDate)");

  it("locates the house votes orderBy block", () => {
    expect(block).not.toBeNull();
  });

  it("orders by voteDate DESC", () => {
    expect(block).toContain("desc(houseVotesTable.voteDate)");
  });

  it("includes a stable id ASC tiebreaker", () => {
    expect(block).toContain("asc(houseVotesTable.id)");
  });
});

// ── senate roll-call votes ────────────────────────────────────────────────────

describe("federal.ts — senate roll-call votes paginated list", () => {
  const block = extractBlock(federalSrc, ".where(and(...filterConditions))\n      .orderBy(desc(senateRollCallVotesTable.voteDate)");

  it("locates the senate votes orderBy block", () => {
    expect(block).not.toBeNull();
  });

  it("orders by voteDate DESC", () => {
    expect(block).toContain("desc(senateRollCallVotesTable.voteDate)");
  });

  it("includes a stable id ASC tiebreaker", () => {
    expect(block).toContain("asc(senateRollCallVotesTable.id)");
  });
});

// ── state bills — main paginated list (DB-cache branch, no q) ────────────────

describe("state.ts — state bills main paginated list", () => {
  const block = extractBlock(
    stateSrc,
    ".from(stateBillsTable)\n        .where(and(...dbConditions))\n        .orderBy(desc(stateBillsTable.introducedDate), asc(stateBillsTable.id))",
  );

  it("locates the state bills main orderBy block", () => {
    expect(block).not.toBeNull();
  });

  it("orders by introducedDate DESC", () => {
    expect(block).toContain("desc(stateBillsTable.introducedDate)");
  });

  it("includes a stable id ASC tiebreaker", () => {
    expect(block).toContain("asc(stateBillsTable.id)");
  });
});

// ── state bills — search/non-search conditional ───────────────────────────────

describe("state.ts — state bills search endpoint (non-search branch)", () => {
  const anchor = ".where(and(...conditions))\n          .orderBy(\n            ...(q";
  const block = extractBlock(stateSrc, anchor);

  it("locates the state bills search orderBy block", () => {
    expect(block).not.toBeNull();
  });

  it("non-search branch orders by introducedDate DESC", () => {
    expect(block).toContain("desc(stateBillsTable.introducedDate)");
  });

  it("non-search branch includes stable id ASC tiebreaker", () => {
    expect(block).toContain("asc(stateBillsTable.id)");
  });
});

// ── state bills — overall tiebreaker count sanity ────────────────────────────

describe("state.ts — asc tiebreaker occurrence count", () => {
  it("asc(stateBillsTable.id) appears exactly 3 times across all paginated state-bill queries", () => {
    expect(countOccurrences(stateSrc, "asc(stateBillsTable.id)")).toBe(3);
  });

  it("asc(stateVoteRecordsTable.id) appears exactly once", () => {
    expect(countOccurrences(stateSrc, "asc(stateVoteRecordsTable.id)")).toBe(1);
  });
});

// ── state vote records ────────────────────────────────────────────────────────

describe("state.ts — state vote records paginated list", () => {
  const block = extractBlock(
    stateSrc,
    ".from(stateVoteRecordsTable)\n      .where(and(...baseConditions))\n      .orderBy(desc(stateVoteRecordsTable.votedAt), asc(stateVoteRecordsTable.id))",
  );

  it("locates the state vote records orderBy block", () => {
    expect(block).not.toBeNull();
  });

  it("orders by votedAt DESC", () => {
    expect(block).toContain("desc(stateVoteRecordsTable.votedAt)");
  });

  it("includes a stable id ASC tiebreaker", () => {
    expect(block).toContain("asc(stateVoteRecordsTable.id)");
  });
});

// ── regression: no paginated date-ordered query lacks a tiebreaker ────────────

describe("regression — no lone date-DESC orderBy without tiebreaker", () => {
  it("federal.ts has no bare orderBy(desc(...Date)) without asc tiebreaker on same line", () => {
    // Match orderBy(desc( followed by a closing ) with nothing else before the )
    const barePattern = /\.orderBy\(desc\(\w+\.(introducedDate|voteDate)\)\)/g;
    const matches = federalSrc.match(barePattern);
    expect(matches).toBeNull();
  });

  it("state.ts has no bare orderBy(desc(...Date/...At)) without asc tiebreaker on same line", () => {
    const barePattern = /\.orderBy\(desc\(\w+\.(introducedDate|votedAt)\)\)/g;
    const matches = stateSrc.match(barePattern);
    expect(matches).toBeNull();
  });
});
