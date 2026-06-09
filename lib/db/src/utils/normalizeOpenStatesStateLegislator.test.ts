import { describe, expect, it } from "vitest";
import { normalizeOpenStatesStateLegislator } from "./normalizeOpenStatesStateLegislator";

describe("normalizeOpenStatesStateLegislator", () => {
  it("normalizes full state names into uppercase codes", () => {
    const result = normalizeOpenStatesStateLegislator({
      id: "ocd-person/test",
      name: "Jane Doe",
      party: "Independent",
      email: "jane@example.com",
      image: "https://example.com/jane.jpg",
      jurisdiction: {
        id: "ocd-jurisdiction/country:us/state:md/government",
        name: "Maryland",
      },
      current_role: {
        org_classification: "upper",
        district: "40",
      },
    });

    expect(result.state).toBe("MD");
    expect(result.chamber).toBe("Senate");
    expect(result.district).toBe("40");
  });
});
