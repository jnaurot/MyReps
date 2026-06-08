import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function getSource(name: string): string {
  const path = resolve(import.meta.dirname, `${name}.tsx`);
  return readFileSync(path, "utf8");
}

describe("Policy area filter regression", () => {
  it("BillsList passes policyArea to the member bills hook", () => {
    const source = getSource("FederalRepDetail");
    // queryParams object must include policyArea
    expect(source.includes("policyArea: policyArea || undefined")).toBe(true);
    // queryParams is passed to useGetFederalMemberBills
    expect(source.includes("useGetFederalMemberBills(")).toBe(true);
    expect(source.includes("bioguideId,")).toBe(true);
    expect(source.includes("queryParams,")).toBe(true);
  });

  it("PolicyAreaChart accepts onPolicyAreaClick callback", () => {
    const source = getSource("FederalRepDetail");
    expect(
      source.includes("onPolicyAreaClick?: (area: string) => void"),
    ).toBe(true);
  });

  it("PolicyAreaChart calls onPolicyAreaClick when a bar is clicked", () => {
    const source = getSource("FederalRepDetail");
    expect(
      source.includes('onClick={() => onPolicyAreaClick?.(item.name ?? "")}'),
    ).toBe(true);
  });

  it("BillsList provides onPolicyAreaClick to PolicyAreaChart", () => {
    const source = getSource("FederalRepDetail");
    expect(source.includes("onPolicyAreaClick={(area) => {")).toBe(true);
    expect(source.includes("setPolicyArea(area);")).toBe(true);
    expect(source.includes("setOffset(0);")).toBe(true);
    expect(source.includes('setBillView("list");')).toBe(true);
  });

  it("Clear button resets policyArea state", () => {
    const source = getSource("FederalRepDetail");
    expect(source.includes('setPolicyArea("");')).toBe(true);
  });

  it("BillsList syncs policyArea state from URL param changes", () => {
    const source = getSource("FederalRepDetail");
    expect(source.includes('const params = new URLSearchParams(pageSearch);')).toBe(true);
    expect(source.includes('const urlPolicyArea = params.get("policyArea") ?? "";')).toBe(true);
    expect(source.includes('setPolicyArea((prev) => {')).toBe(true);
  });

  it("FederalBills passes policyArea through the canonical listing hook", () => {
    const source = getSource("FederalBills");
    expect(source.includes("useGetFederalBills(")).toBe(true);
    expect(source.includes("q: searchQuery || undefined")).toBe(true);
    expect(source.includes("policyArea,")).toBe(true);
    expect(source.includes("offset,")).toBe(true);
    expect(source.includes("limit,")).toBe(true);
    expect(source.includes("useSearchFederalBills")).toBe(false);
  });
});
