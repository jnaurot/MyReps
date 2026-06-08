import { describe, expect, it } from "vitest";
import { dedupeAndSortFederalBillActions } from "./federalBillActions";

describe("dedupeAndSortFederalBillActions", () => {
  it("orders same-day actions chronologically using reverse source order when time is missing", () => {
    const actions = dedupeAndSortFederalBillActions([
      {
        actionDate: "2025-10-08",
        text: "Referred to the House Committee on Natural Resources.",
      },
      {
        actionDate: "2025-10-08",
        text: "Introduced in House",
      },
    ]);

    expect(actions.map((action) => action.text)).toEqual([
      "Introduced in House",
      "Referred to the House Committee on Natural Resources.",
    ]);
  });

  it("uses actionTime when available for same-day ordering", () => {
    const actions = dedupeAndSortFederalBillActions([
      {
        actionDate: "2025-11-18",
        actionTime: "18:45:00-05:00",
        text: "On passage Passed by the Yeas and Nays: 214 - 212 (Roll no. 294).",
      },
      {
        actionDate: "2025-11-18",
        actionTime: "13:00:00-05:00",
        text: "DEBATE - The House proceeded with one hour of debate on H.J. Res. 130.",
      },
    ]);

    expect(actions.map((action) => action.text)).toEqual([
      "DEBATE - The House proceeded with one hour of debate on H.J. Res. 130.",
      "On passage Passed by the Yeas and Nays: 214 - 212 (Roll no. 294).",
    ]);
  });

  it("dedupes exact duplicate action text on the same date", () => {
    const actions = dedupeAndSortFederalBillActions([
      {
        actionDate: "2025-12-11",
        text: "Signed by President.",
      },
      {
        actionDate: "2025-12-11",
        text: "Signed by President.",
      },
    ]);

    expect(actions).toHaveLength(1);
    expect(actions[0]?.text).toBe("Signed by President.");
  });
});
