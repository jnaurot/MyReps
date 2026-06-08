import { describe, expect, it } from "vitest";
import { dedupeFederalBillVotes } from "./federalBillVotes";

describe("dedupeFederalBillVotes", () => {
  it("dedupes repeated roll-call references by date, chamber, and roll number", () => {
    const votes = dedupeFederalBillVotes([
      {
        date: "2021-05-11",
        chamber: "Senate",
        rollNumber: 183,
        result:
          "Passed Senate without amendment by Yea-Nay Vote. 52 - 47. Record Vote Number: 183.",
        yesCount: 52,
        noCount: 47,
        sourceUrl: "https://example.com/senate-183",
      },
      {
        date: "2021-05-11",
        chamber: "Senate",
        rollNumber: 183,
        result:
          "Passed/agreed to in Senate: Passed Senate without amendment by Yea-Nay Vote. 52 - 47. Record Vote Number: 183.",
        yesCount: 52,
        noCount: 47,
        sourceUrl: "https://example.com/senate-183",
      },
    ]);

    expect(votes).toHaveLength(1);
    expect(votes[0]?.rollNumber).toBe(183);
    expect(votes[0]?.result).toContain("Passed/agreed to in Senate");
  });

  it("falls back to source url when roll number is missing", () => {
    const votes = dedupeFederalBillVotes([
      {
        date: "2021-06-24",
        chamber: "House",
        result: "On motion to suspend the rules and pass.",
        sourceUrl: "https://example.com/house-vote",
      },
      {
        date: "2021-06-24",
        chamber: "House",
        result: "Passed/agreed to in House: On motion to suspend the rules and pass.",
        sourceUrl: "https://example.com/house-vote",
      },
    ]);

    expect(votes).toHaveLength(1);
    expect(votes[0]?.sourceUrl).toBe("https://example.com/house-vote");
    expect(votes[0]?.result).toContain("Passed/agreed to in House");
  });

  it("keeps distinct roll calls on the same date separate", () => {
    const votes = dedupeFederalBillVotes([
      {
        date: "2021-06-24",
        chamber: "House",
        rollNumber: 181,
        result: "On passage Passed by the Yeas and Nays: 218 - 208.",
      },
      {
        date: "2021-06-24",
        chamber: "House",
        rollNumber: 182,
        result: "On motion to recommit Failed by the Yeas and Nays: 210 - 216.",
      },
    ]);

    expect(votes).toHaveLength(2);
  });
});
