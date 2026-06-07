import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

const source = readFileSync(
  join(process.cwd(), "src/pages/StateRepDetail.tsx"),
  "utf8",
);

describe("State votes URL-state regression", () => {
  it("uses shared vote search helpers and router-backed search params", () => {
    expect(source.includes("useSearchParams")).toBe(true);
    expect(source.includes("parseVoteSearchState(pageSearch)")).toBe(true);
    expect(source.includes("buildVoteSearch(")).toBe(true);
  });

  it("does not rehydrate vote state from pageSearch on mobile breakpoint changes", () => {
    expect(source.includes("}, [pageSearch, isMobile]);")).toBe(false);
    expect(source.includes("}, [pageSearch]);")).toBe(true);
  });

  it("writes the selected vote filter back into the URL", () => {
    expect(source.includes('replaceVoteSearch({ filter: f.value, offset: 0 });')).toBe(
      true,
    );
  });

  it("preserves the currently loaded page during desktop-to-mobile transitions", () => {
    expect(source.includes("const shouldUseCurrentPageVotes =")).toBe(true);
    expect(source.includes("setAllVotes(votes);")).toBe(true);
  });
});
