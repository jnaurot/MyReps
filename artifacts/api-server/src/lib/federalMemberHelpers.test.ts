/**
 * Tests for the shared federal member helper utilities.
 *
 * "Should fail" tests (new behaviour — fail until federalMemberHelpers.ts is created):
 *   - All unit tests for formatCongressMemberName and normalizeCongressTerms
 *   - Source guards confirming inline duplicates are gone from federal.ts and ingestFederalMembers.ts
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  formatCongressMemberName,
  normalizeCongressMember,
  normalizeCongressTerms,
} from "./federalMemberHelpers";

// ── Unit tests — formatCongressMemberName ─────────────────────────────────────

describe("formatCongressMemberName", () => {
  it("converts 'Last, First' to 'First Last'", () => {
    expect(formatCongressMemberName("Smith, John")).toBe("John Smith");
  });

  it("returns names with suffixes unchanged (more than one comma+space — too ambiguous to flip)", () => {
    // "Biden, Joseph R., Jr." splits into 3 parts — the function only converts 2-part names.
    expect(formatCongressMemberName("Biden, Joseph R., Jr.")).toBe(
      "Biden, Joseph R., Jr.",
    );
  });

  it("returns the name unchanged when there is no comma+space separator", () => {
    expect(formatCongressMemberName("John Smith")).toBe("John Smith");
  });

  it("returns an empty string unchanged", () => {
    expect(formatCongressMemberName("")).toBe("");
  });

  it("handles a name that is only a last name (no comma)", () => {
    expect(formatCongressMemberName("Obama")).toBe("Obama");
  });
});

// ── Unit tests — normalizeCongressTerms ───────────────────────────────────────

describe("normalizeCongressTerms", () => {
  it("returns terms from the terms.item array (list-endpoint shape)", () => {
    const result = normalizeCongressTerms({
      terms: { item: [{ chamber: "Senate" }, { chamber: "House" }] },
    });
    expect(result).toEqual([{ chamber: "Senate" }, { chamber: "House" }]);
  });

  it("returns terms from a direct array (detail-endpoint shape)", () => {
    const result = normalizeCongressTerms({
      terms: [{ chamber: "House" }],
    });
    expect(result).toEqual([{ chamber: "House" }]);
  });

  it("wraps a single object from terms.item in an array", () => {
    const result = normalizeCongressTerms({
      terms: { item: { chamber: "Senate" } },
    });
    expect(result).toEqual([{ chamber: "Senate" }]);
  });

  it("falls back to depictedTerms when terms is absent", () => {
    const result = normalizeCongressTerms({
      depictedTerms: [{ chamber: "House" }],
    });
    expect(result).toEqual([{ chamber: "House" }]);
  });

  it("returns an empty array when all fields are absent", () => {
    expect(normalizeCongressTerms({})).toEqual([]);
  });

  it("returns an empty array for null input", () => {
    expect(normalizeCongressTerms(null)).toEqual([]);
  });

  it("returns an empty array for undefined input", () => {
    expect(normalizeCongressTerms(undefined)).toEqual([]);
  });
});

describe("normalizeCongressMember", () => {
  it("normalizes a list-endpoint payload into canonical storage shape", () => {
    const result = normalizeCongressMember({
      bioguideId: "V000128",
      name: "Van Hollen, Chris",
      partyName: "Democratic",
      state: "MD",
      district: null,
      nextElection: "2028",
      currentMember: true,
      depiction: { imageUrl: "https://example.com/chris.jpg" },
      terms: { item: [{ chamber: "Senate", stateCode: "MD" }] },
    });

    expect(result).toMatchObject({
      bioguideId: "V000128",
      name: "Chris Van Hollen",
      party: "Democratic",
      state: "MD",
      chamber: "Senate",
      district: null,
      photoUrl: "https://example.com/chris.jpg",
      inOffice: true,
      nextElection: "2028",
      terms: 1,
    });
  });

  it("normalizes a detail-endpoint payload with full state name into postal code", () => {
    const result = normalizeCongressMember({
      bioguideId: "V000128",
      state: "Maryland",
      directOrderName: "Chris Van Hollen",
      invertedOrderName: "Van Hollen, Chris",
      currentMember: true,
      officialWebsiteUrl: "https://www.vanhollen.senate.gov",
      depiction: { imageUrl: "https://www.congress.gov/img/member/v000128_200.jpg" },
      addressInformation: {
        phoneNumber: "(202) 224-4654",
        officeAddress: "730 Hart Senate Office Building  Washington, DC 20510",
      },
      partyHistory: [{ partyName: "Democratic" }],
      terms: [{ chamber: "Senate", stateName: "Maryland" }],
    });

    expect(result).toMatchObject({
      bioguideId: "V000128",
      name: "Chris Van Hollen",
      party: "Democratic",
      state: "MD",
      chamber: "Senate",
      phone: "(202) 224-4654",
      website: "https://www.vanhollen.senate.gov",
      photoUrl: "https://www.congress.gov/img/member/v000128_200.jpg",
      inOffice: true,
      terms: 1,
    });
  });

  it("normalizes territorial names to the requested abbreviations", () => {
    const result = normalizeCongressMember({
      bioguideId: "P000610",
      directOrderName: "Stacey E. Plaskett",
      state: "U.S. Virgin Islands",
      currentMember: true,
      terms: [{ chamber: "House of Representatives", stateName: "U.S. Virgin Islands" }],
    });

    expect(result).toMatchObject({
      bioguideId: "P000610",
      name: "Stacey E. Plaskett",
      state: "VI",
      chamber: "House",
      inOffice: true,
      terms: 1,
    });
  });

  it("normalizes 'Virgin Islands' alias to VI", () => {
    const result = normalizeCongressMember({
      bioguideId: "P000610",
      directOrderName: "Stacey E. Plaskett",
      state: "Virgin Islands",
      currentMember: true,
      terms: [{ chamber: "House of Representatives", stateName: "Virgin Islands" }],
    });

    expect(result.state).toBe("VI");
  });
});

// ── Source guards — inline helpers must be gone from callers ──────────────────

describe("federal.ts source guards — helpers removed", () => {
  const src = readFileSync(
    resolve(import.meta.dirname, "../routes/federal.ts"),
    "utf8",
  );

  it("does not define formatCongressName inline", () => {
    expect(src).not.toContain("function formatCongressName(");
  });

  it("does not define normalizeTermsItem inline", () => {
    expect(src).not.toContain("function normalizeTermsItem(");
  });

  it("imports from federalMemberHelpers", () => {
    expect(src).toContain("federalMemberHelpers");
    expect(src).toContain("normalizeCongressMember");
  });
});

describe("ingestFederalMembers.ts source guards — helpers removed", () => {
  const src = readFileSync(
    resolve(import.meta.dirname, "./ingestFederalMembers.ts"),
    "utf8",
  );

  it("does not define formatName inline", () => {
    expect(src).not.toContain("function formatName(");
  });

  it("does not define normalizeTerms inline", () => {
    expect(src).not.toContain("function normalizeTerms(");
  });

  it("imports from federalMemberHelpers", () => {
    expect(src).toContain("federalMemberHelpers");
    expect(src).toContain("normalizeCongressMember");
  });
});
