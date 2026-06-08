import { describe, expect, it } from "vitest";
import { normalizeSummaryText } from "./summaryText";

describe("normalizeSummaryText", () => {
  it("preserves whitespace boundaries when stripping HTML tags", () => {
    expect(
      normalizeSummaryText("Rescissions Act of 2025</p><p>This bill rescinds"),
    ).toBe("Rescissions Act of 2025 This bill rescinds");
  });

  it("adds a colon when the summary starts by repeating the bill title", () => {
    expect(
      normalizeSummaryText(
        "Alaska Native Settlement Trust Eligibility ActThis bill excludes certain settlement trust payments.",
        "Alaska Native Settlement Trust Eligibility Act",
      ),
    ).toBe(
      "Alaska Native Settlement Trust Eligibility Act: This bill excludes certain settlement trust payments.",
    );
  });

  it("does not add a duplicate colon if punctuation already follows the repeated title", () => {
    expect(
      normalizeSummaryText(
        "Alaska Native Settlement Trust Eligibility Act: This bill excludes certain settlement trust payments.",
        "Alaska Native Settlement Trust Eligibility Act",
      ),
    ).toBe(
      "Alaska Native Settlement Trust Eligibility Act: This bill excludes certain settlement trust payments.",
    );
  });

  it("decodes HTML entities before returning the summary", () => {
    expect(
      normalizeSummaryText("provided&nbsp;funds &amp; oversight &#39;rules&#39;"),
    ).toBe("provided funds & oversight 'rules'");
  });

  it("returns null for empty inputs", () => {
    expect(normalizeSummaryText(null)).toBeNull();
    expect(normalizeSummaryText("")).toBeNull();
  });
});
