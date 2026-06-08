import { describe, expect, it } from "vitest";
import {
  computeLegislationStageFlags,
  finalizeFederalStageFlags,
} from "./legislationStages";

describe("computeLegislationStageFlags", () => {
  it("treats public and private law outcomes as signed/enacted", () => {
    expect(
      computeLegislationStageFlags({
        latestAction: "Became Public Law No: 119-86.",
      }),
    ).toMatchObject({
      signed_enacted: true,
      dead: false,
      passed: true,
    });

    expect(
      computeLegislationStageFlags({
        latestAction: "Became Private Law No: 119-1.",
      }),
    ).toMatchObject({
      signed_enacted: true,
      dead: false,
      passed: true,
    });
  });

  it("does not allow enacted rows to remain dead even if dead-like words appear", () => {
    expect(
      computeLegislationStageFlags({
        latestAction: "Vetoed by President. Became Public Law No: 119-86.",
      }),
    ).toMatchObject({
      signed_enacted: true,
      dead: false,
    });
  });
});

describe("finalizeFederalStageFlags", () => {
  it("forces prior-congress non-enacted rows to dead", () => {
    const flags = finalizeFederalStageFlags(
      computeLegislationStageFlags({
        latestAction: "Referred to the House Committee on Armed Services.",
      }),
      118,
      119,
    );

    expect(flags.signed_enacted).toBe(false);
    expect(flags.dead).toBe(true);
  });

  it("keeps enacted prior-congress rows out of dead", () => {
    const flags = finalizeFederalStageFlags(
      computeLegislationStageFlags({
        latestAction: "Became Public Law No: 99-86.",
      }),
      99,
      119,
    );

    expect(flags.signed_enacted).toBe(true);
    expect(flags.dead).toBe(false);
  });
});
