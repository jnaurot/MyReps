import { describe, expect, it } from "vitest";
import { getUsStateName, normalizeUsStateCode, requireUsStateCode } from "./usStateCodes";

describe("usStateCodes", () => {
  it("normalizes uppercase and lowercase postal codes", () => {
    expect(normalizeUsStateCode("md")).toBe("MD");
    expect(normalizeUsStateCode("MD")).toBe("MD");
  });

  it("normalizes full names and aliases", () => {
    expect(normalizeUsStateCode("Maryland")).toBe("MD");
    expect(normalizeUsStateCode("Virgin Islands")).toBe("VI");
    expect(normalizeUsStateCode("U.S. Virgin Islands")).toBe("VI");
  });

  it("normalizes OpenStates jurisdiction identifiers", () => {
    expect(
      normalizeUsStateCode("ocd-jurisdiction/country:us/state:md/government"),
    ).toBe("MD");
    expect(
      normalizeUsStateCode("ocd-jurisdiction/country:us/district:dc/government"),
    ).toBe("DC");
  });

  it("returns full names for codes", () => {
    expect(getUsStateName("pr")).toBe("Puerto Rico");
  });

  it("throws for invalid required values", () => {
    expect(() => requireUsStateCode("Atlantis", "test")).toThrow(
      "Unable to normalize state code for test",
    );
  });
});
