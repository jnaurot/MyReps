import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const source = readFileSync(resolve(import.meta.dirname, "federal.ts"), "utf8");

describe("GET /federal/bills unified filtering source regression", () => {
  it("parses q alongside chamber/policyArea/stages", () => {
    expect(source).toContain("const { chamber, policyArea, offset, limit, stages, q } = parsed.data;");
  });

  it("builds federal bill DB conditions from a shared helper", () => {
    expect(source).toContain("function buildFederalBillsDbConditions({");
    expect(source).toContain("searchAllCongresses");
  });

  it("allows the canonical /federal/bills route to handle q searches", () => {
    expect(source).toContain("q,");
    expect(source).toContain("const searchAllCongresses = !!q || !!policyArea;");
  });
});
