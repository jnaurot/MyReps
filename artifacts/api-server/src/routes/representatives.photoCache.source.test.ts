import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function getRepresentativesSource() {
  return readFileSync(resolve(import.meta.dirname, "representatives.ts"), "utf8");
}

describe("representatives.ts photo caching source guards", () => {
  it("imports stateMemberPhotoUrl from the shared representatives utils", () => {
    const src = getRepresentativesSource();
    expect(src).toContain('from "./representativesUtils"');
    expect(src).toContain("stateMemberPhotoUrl");
  });

  it("wraps state representative photos with the cached proxy URL", () => {
    const src = getRepresentativesSource();
    expect(src).toContain("photoUrl: stateMemberPhotoUrl(person.id, !!person.photoUrl),");
    expect(src).toContain("rawPhotoUrl: person.photoUrl ?? undefined,");
  });
});
