import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function getSource() {
  return readFileSync(resolve(import.meta.dirname, "federal.ts"), "utf8");
}

describe("federal member bills policy area category counts", () => {
  it("applies policyAreaCondition to the categoryCounts query", () => {
    const source = getSource();
    const categoryCountQueryBlock = source.slice(
      source.indexOf("const [rows, totalResult, policyAreaRows, categoryCountRows, stageRows] ="),
      source.indexOf(".groupBy(federalBillsTable.category),", source.indexOf("categoryCountRows")) + 37,
    );

    expect(categoryCountQueryBlock.includes("...(policyAreaCondition ? [policyAreaCondition] : []),")).toBe(true);
  });
});
