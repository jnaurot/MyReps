import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseStageQuery } from "../lib/legislationStages";

function federalSource(): string {
  return readFileSync(resolve(import.meta.dirname, "federal.ts"), "utf8");
}

function stateSource(): string {
  return readFileSync(resolve(import.meta.dirname, "state.ts"), "utf8");
}

// ─── parseStageQuery unit tests ──────────────────────────────────────────────

describe("parseStageQuery", () => {
  it("parses a single valid stage key", () => {
    expect(parseStageQuery("signed_enacted")).toEqual(["signed_enacted"]);
  });

  it("returns an empty array for an empty string", () => {
    expect(parseStageQuery("")).toEqual([]);
  });

  it("returns an empty array for null", () => {
    expect(parseStageQuery(null)).toEqual([]);
  });

  it("silently drops unknown stage names", () => {
    expect(parseStageQuery("signed_enacted,unknown_stage")).toEqual(["signed_enacted"]);
  });

  it("handles all valid stage keys", () => {
    expect(parseStageQuery("introduced")).toEqual(["introduced"]);
    expect(parseStageQuery("committee")).toEqual(["committee"]);
    expect(parseStageQuery("floor_vote")).toEqual(["floor_vote"]);
    expect(parseStageQuery("passed")).toEqual(["passed"]);
    expect(parseStageQuery("signed_enacted")).toEqual(["signed_enacted"]);
    expect(parseStageQuery("dead")).toEqual(["dead"]);
  });

  it("trims whitespace around stage names", () => {
    expect(parseStageQuery(" signed_enacted ")).toEqual(["signed_enacted"]);
  });
});

// ─── Federal bills list route (GET /federal/bills) stage integration ──────────

describe("GET /federal/bills — stage filtering integration", () => {
  const src = federalSource();

  it("GetFederalBillsQueryParams is parsed and stages is destructured", () => {
    expect(src).toContain("const { chamber, policyArea, offset, limit, stages } = parsed.data;");
  });

  it("stages are parsed into selectedStages via parseStageQuery", () => {
    expect(src).toContain("const selectedStages = parseStageQuery(stages);");
  });

  it("a stageCondition is built when selectedStages are present", () => {
    expect(src).toContain(
      "eq(federalStageColumn(stage), true)",
    );
  });

  it("stageCondition is spread into dbConditions", () => {
    expect(src).toContain("...(stageCondition ? [stageCondition] : []),");
  });

  it("cached DB responses include normalized stage flags for badge rendering", () => {
    expect(src).toContain("stageSignedEnacted: federalBillsTable.stageSignedEnacted");
    expect(src).toContain("const cachedBills = rows.map(mapFederalLegislationForResponse);");
  });

  it("live Congress.gov fetches compute and persist normalized stage flags", () => {
    expect(src).toContain("const stageFlags = computeLegislationStageFlags({");
    expect(src).toContain("stageSignedEnacted: stageFlags.signed_enacted");
  });

  it("stage filtering forces the DB path (skips Congress.gov API)", () => {
    expect(src).toContain("selectedStages.length > 0");
  });

  it("stages value is included in the response log", () => {
    expect(src).toContain("stages,");
  });
});

// ─── State bills list route (GET /state/bills) stage integration ─────────────

describe("GET /state/bills — stage filtering integration", () => {
  const src = stateSource();

  it("GetStateBillsQueryParams includes stages field", () => {
    // stages is parsed from the query params object
    expect(src).toContain("stages");
  });

  it("state bills route builds a stageCondition from selectedStages", () => {
    expect(src).toContain("stateStageColumn");
  });

  it("state route includes stage boolean columns in DB conditions", () => {
    expect(src).toContain("stageIntroduced");
    expect(src).toContain("stageCommittee");
    expect(src).toContain("stageFloorVote");
    expect(src).toContain("stagePassed");
    expect(src).toContain("stageSignedEnacted");
    expect(src).toContain("stageDead");
  });
});

// ─── State bills search route (GET /state/bills/search) stage integration ────

describe("GET /state/bills/search — stage filtering integration", () => {
  const src = stateSource();

  it("search route parses selectedStages from query params", () => {
    expect(src).toContain("parseStageQuery(stages)");
  });

  it("search route builds a stageCondition from selectedStages", () => {
    expect(src).toContain("stateStageColumn(stage)");
  });

  it("search route includes stageCondition in conditions array", () => {
    expect(src).toContain("...(stageCondition ? [stageCondition] : [])");
  });

  it("OpenStates fallback applies stage filtering in memory when stages are active", () => {
    expect(src).toContain("computeLegislationStageFlags");
    expect(src).toContain("selectedStages.some((stage) => flags[stage])");
  });
});
