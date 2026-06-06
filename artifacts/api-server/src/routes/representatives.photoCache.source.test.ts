import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function getRepresentativesSource() {
  return readFileSync(resolve(import.meta.dirname, "representatives.ts"), "utf8");
}

describe("representatives.ts state photo source guards", () => {
  it("imports toBrowserPhotoUrl from the shared representatives utils", () => {
    const src = getRepresentativesSource();
    expect(src).toContain('from "./representativesUtils"');
    expect(src).toContain("toBrowserPhotoUrl");
  });

  it("returns direct browser-facing state representative photo URLs", () => {
    const src = getRepresentativesSource();
    expect(src).toContain("photoUrl: toBrowserPhotoUrl(person.photoUrl),");
  });
});
