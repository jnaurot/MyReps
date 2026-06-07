import { describe, expect, it } from "vitest";
import {
  buildVoteSearch,
  isVoteFilter,
  normalizeVoteOffset,
  parseVoteSearchState,
} from "./voteSearchParams";

describe("voteSearchParams", () => {
  describe("isVoteFilter", () => {
    it("accepts valid vote filters", () => {
      expect(isVoteFilter("nay")).toBe(true);
      expect(isVoteFilter("not-voting")).toBe(true);
    });

    it("rejects invalid filters", () => {
      expect(isVoteFilter("nope")).toBe(false);
      expect(isVoteFilter(null)).toBe(false);
    });
  });

  describe("normalizeVoteOffset", () => {
    it("normalizes invalid offsets to zero", () => {
      expect(normalizeVoteOffset("-1")).toBe(0);
      expect(normalizeVoteOffset("abc")).toBe(0);
    });

    it("preserves valid non-negative offsets", () => {
      expect(normalizeVoteOffset("40")).toBe(40);
      expect(normalizeVoteOffset(20)).toBe(20);
    });
  });

  describe("parseVoteSearchState", () => {
    it("parses the canonical vote params", () => {
      expect(
        parseVoteSearchState("?tab=votes&filter=nay&offset=20&q=privacy"),
      ).toEqual({
        filter: "nay",
        offset: 20,
        q: "privacy",
      });
    });

    it("falls back to defaults for invalid values", () => {
      expect(parseVoteSearchState("?filter=bad&offset=-2")).toEqual({
        filter: "all",
        offset: 0,
        q: "",
      });
    });
  });

  describe("buildVoteSearch", () => {
    it("writes a selected vote filter into the URL", () => {
      expect(buildVoteSearch("?tab=votes", { filter: "nay", offset: 0 })).toBe(
        "?tab=votes&filter=nay",
      );
    });

    it("removes default vote state from the URL", () => {
      expect(
        buildVoteSearch("?tab=votes&filter=nay&offset=20&q=privacy", {
          filter: "all",
          offset: 0,
          q: "",
        }),
      ).toBe("?tab=votes");
    });

    it("preserves unrelated params while updating vote params", () => {
      expect(
        buildVoteSearch("?tab=votes&name=Alice&from=%2Frep%2Ffederal%2FA000360", {
          filter: "nay",
          offset: 40,
        }),
      ).toBe(
        "?tab=votes&name=Alice&from=%2Frep%2Ffederal%2FA000360&filter=nay&offset=40",
      );
    });
  });
});
