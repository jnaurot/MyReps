import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

const source = readFileSync(
  resolve(import.meta.dirname, "FederalBills.tsx"),
  "utf8",
);

describe("Federal Bills unified query regression", () => {
  it("uses a single canonical getFederalBills query path for page rendering", () => {
    expect(source.includes("useSearchFederalBills")).toBe(false);
    expect(source.includes("useGetFederalBills(")).toBe(true);
  });

  it("passes text search through the canonical federal bills query", () => {
    expect(source.includes("q: searchQuery || undefined")).toBe(true);
  });
});
