import { describe, expect, it } from "vitest";
import { buildFederalBillHref, buildFederalVoteBillHref } from "./billHref";

describe("buildFederalBillHref", () => {
  it("builds a valid href for a bill", () => {
    expect(
      buildFederalBillHref({ number: "HR 1234", congress: "119", itemCategory: "bill" }),
    ).toBe("/bills/federal/119/hr/1234");
  });

  it("builds a valid href for a resolution", () => {
    expect(
      buildFederalBillHref({ number: "HJRES 42", congress: "119", itemCategory: "resolution" }),
    ).toBe("/bills/federal/119/hjres/42");
  });

  it("builds a href when category is null/other (uncategorised bills should still be linkable)", () => {
    expect(
      buildFederalBillHref({ number: "S 500", congress: "118", itemCategory: "other" }),
    ).toBe("/bills/federal/118/s/500");
    expect(
      buildFederalBillHref({ number: "HR 99", congress: "119", itemCategory: undefined }),
    ).toBe("/bills/federal/119/hr/99");
  });

  it("returns null for amendments (no detail page exists)", () => {
    expect(
      buildFederalBillHref({ number: "SAMDT 4954", congress: "119", itemCategory: "amendment" }),
    ).toBeNull();
  });

  it("returns null when number is missing", () => {
    expect(
      buildFederalBillHref({ congress: "119", itemCategory: "bill" }),
    ).toBeNull();
  });

  it("returns null when congress is missing", () => {
    expect(
      buildFederalBillHref({ number: "HR 1", itemCategory: "bill" }),
    ).toBeNull();
  });

  it("returns null when number has no space (unparseable)", () => {
    expect(
      buildFederalBillHref({ number: "HR1234", congress: "119", itemCategory: "bill" }),
    ).toBeNull();
  });

  it("appends fromParam when provided", () => {
    const fromParam = "?from=%2Frep%2Ffederal%2FA000001&name=Alice";
    expect(
      buildFederalBillHref({ number: "HR 1", congress: "119" }, fromParam),
    ).toBe(`/bills/federal/119/hr/1${fromParam}`);
  });

  it("lowercases the bill type in the URL", () => {
    expect(
      buildFederalBillHref({ number: "SRES 10", congress: "119" }),
    ).toBe("/bills/federal/119/sres/10");
  });
});

describe("buildFederalVoteBillHref", () => {
  it("builds a federal vote href from house vote fields", () => {
    expect(
      buildFederalVoteBillHref({
        congress: 119,
        legislationType: "HR",
        legislationNumber: "42",
      }),
    ).toBe("/bills/federal/119/hr/42");
  });

  it("normalizes punctuation in senate document types", () => {
    expect(
      buildFederalVoteBillHref({
        congress: 119,
        documentType: "S. Res.",
        documentNumber: "10",
      }),
    ).toBe("/bills/federal/119/sres/10");
  });

  it("returns null for amendments", () => {
    expect(
      buildFederalVoteBillHref({
        congress: 119,
        documentType: "S.Amdt.",
        documentNumber: "4954",
      }),
    ).toBeNull();
  });
});
