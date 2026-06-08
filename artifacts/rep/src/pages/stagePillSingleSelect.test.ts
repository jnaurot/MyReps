import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const BILL_STAGE_OPTIONS = [
  "All Bills",
  "Active Bills",
  "Became Law/Adopted",
  "Dead",
] as const;

type BillStage = (typeof BILL_STAGE_OPTIONS)[number];

const BILL_STAGE_QUERY_KEYS: Record<BillStage, string> = {
  "All Bills": "all",
  "Active Bills": "active",
  "Became Law/Adopted": "signed_enacted",
  Dead: "dead",
};

const pagesDir = resolve(import.meta.dirname);

function pageSource(filename: string): string {
  return readFileSync(resolve(pagesDir, filename), "utf8");
}

function singleSelectToggle(prev: BillStage[], stage: BillStage): BillStage[] {
  if (stage === "All Bills") return [];
  return prev.includes(stage) ? [] : [stage];
}

describe("singleSelectToggle — simplified bill status reducer behaviour", () => {
  it("selecting a stage from empty state returns [stage]", () => {
    expect(singleSelectToggle([], "Active Bills")).toEqual(["Active Bills"]);
  });

  it("selecting a different stage replaces the current selection", () => {
    expect(singleSelectToggle(["Active Bills"], "Became Law/Adopted")).toEqual(["Became Law/Adopted"]);
  });

  it("selecting the currently active stage deselects it (returns [])", () => {
    expect(singleSelectToggle(["Dead"], "Dead")).toEqual([]);
  });

  it("selecting All Bills clears any active stage selection", () => {
    expect(singleSelectToggle(["Dead"], "All Bills")).toEqual([]);
  });

  it("result never contains more than one stage", () => {
    for (const first of BILL_STAGE_OPTIONS) {
      for (const second of BILL_STAGE_OPTIONS) {
        const result = singleSelectToggle([first], second);
        expect(result.length).toBeLessThanOrEqual(1);
      }
    }
  });

  it("result is always a subset of BILL_STAGE_OPTIONS", () => {
    for (const stage of BILL_STAGE_OPTIONS) {
      const selected = singleSelectToggle([], stage);
      expect(BILL_STAGE_OPTIONS).toContain(selected[0] ?? stage);
    }
  });
});

describe("BILL_STAGE_QUERY_KEYS", () => {
  it("every display stage has a corresponding API key", () => {
    for (const stage of BILL_STAGE_OPTIONS) {
      expect(BILL_STAGE_QUERY_KEYS[stage]).toBeDefined();
      expect(typeof BILL_STAGE_QUERY_KEYS[stage]).toBe("string");
    }
  });

  it("API keys match the simplified server filters", () => {
    expect(BILL_STAGE_QUERY_KEYS["All Bills"]).toBe("all");
    expect(BILL_STAGE_QUERY_KEYS["Active Bills"]).toBe("active");
    expect(BILL_STAGE_QUERY_KEYS["Became Law/Adopted"]).toBe("signed_enacted");
    expect(BILL_STAGE_QUERY_KEYS["Dead"]).toBe("dead");
  });

  it("a single-selected stage produces a single-segment stages query param", () => {
    for (const stage of BILL_STAGE_OPTIONS) {
      const selected: BillStage[] = [stage];
      const queryParam = selected.map((s) => BILL_STAGE_QUERY_KEYS[s]).join(",");
      expect(queryParam).not.toContain(",");
      expect(queryParam).toBe(BILL_STAGE_QUERY_KEYS[stage]);
    }
  });
});

const PAGE_FILES = [
  "FederalBills.tsx",
  "StateBills.tsx",
  "FederalRepDetail.tsx",
  "StateRepDetail.tsx",
] as const;

const MULTI_SELECT_PATTERN = /\[\.\.\.prev,\s*stage\]/;

describe("Regression: stage pill toggle uses the shared single-select helper", () => {
  for (const file of PAGE_FILES) {
    it(`${file} uses toggleBillStageSelection`, () => {
      const src = pageSource(file);
      expect(src).toContain("toggleBillStageSelection");
    });

    it(`${file} does NOT use multi-select accumulation ([...prev, stage])`, () => {
      const src = pageSource(file);
      expect(MULTI_SELECT_PATTERN.test(src)).toBe(false);
    });

    it(`${file} does not retain Status On/Off wiring`, () => {
      const src = pageSource(file);
      expect(src).not.toContain("statusEnabled");
      expect(src).not.toContain('status", "on"');
      expect(src).not.toContain('get("status")');
    });
  }
});

describe("Regression: stageQuery computation from single selectedStages", () => {
  it("joining a single-element selectedStages array produces no comma", () => {
    const selected: BillStage[] = ["Became Law/Adopted"];
    const stageQuery = selected.map((s) => BILL_STAGE_QUERY_KEYS[s]).join(",");
    expect(stageQuery).toBe("signed_enacted");
    expect(stageQuery.includes(",")).toBe(false);
  });

  it("an empty selectedStages array produces an empty stageQuery (no filter sent)", () => {
    const selected: BillStage[] = [];
    const stageQuery = selected.map((s) => BILL_STAGE_QUERY_KEYS[s]).join(",");
    expect(stageQuery).toBe("");
  });
});
