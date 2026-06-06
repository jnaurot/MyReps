import { describe, expect, it } from "vitest";
import {
  formatCongressName,
  getStateName,
  normalizeCensusDistrict,
  stateMemberPhotoUrl,
} from "./representativesUtils";

describe("representatives utilities", () => {
  it("normalizes Census district identifiers without preserving leading zeros", () => {
    expect(normalizeCensusDistrict("040")).toBe("40");
    expect(normalizeCensusDistrict("4A")).toBe("4");
    expect(normalizeCensusDistrict(null)).toBeNull();
    expect(normalizeCensusDistrict("")).toBeNull();
  });

  it("formats Congress.gov inverted names", () => {
    expect(formatCongressName("Van Hollen, Chris")).toBe("Chris Van Hollen");
    expect(formatCongressName("Angela Alsobrooks")).toBe("Angela Alsobrooks");
  });

  it("maps state abbreviations case-insensitively", () => {
    expect(getStateName("md")).toBe("Maryland");
    expect(getStateName("ZZ")).toBeUndefined();
  });

  it("builds a cached state member photo proxy URL", () => {
    expect(stateMemberPhotoUrl("ocd-person/abc-123", true)).toBe(
      "/api/state/member-photo?memberId=ocd-person%2Fabc-123",
    );
    expect(stateMemberPhotoUrl("ocd-person/abc-123", false)).toBeUndefined();
  });
});
