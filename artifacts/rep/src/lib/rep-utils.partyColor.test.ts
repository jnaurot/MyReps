import { describe, expect, it } from "vitest";
import { partyColor } from "@/lib/rep-utils";

describe("partyColor", () => {
  it("maps party abbreviations to the expected badge colors", () => {
    expect(partyColor("D")).toContain("bg-blue-600");
    expect(partyColor("R")).toContain("bg-red-600");
  });

  it("maps full party names to the expected badge colors", () => {
    expect(partyColor("Democratic")).toContain("bg-blue-600");
    expect(partyColor("Republican")).toContain("bg-red-600");
  });

  it("falls back to neutral styling for unknown parties", () => {
    expect(partyColor("Independent")).toContain("bg-gray-200");
  });
});
