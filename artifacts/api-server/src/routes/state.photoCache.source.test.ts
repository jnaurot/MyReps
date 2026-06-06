import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function getStateSource() {
  return readFileSync(resolve(import.meta.dirname, "state.ts"), "utf8");
}

describe("state.ts photo caching source guards", () => {
  it("imports photo cache helpers from the shared lib", () => {
    const src = getStateSource();
    expect(src).toContain('from "../lib/photoCache"');
    expect(src).toContain("getCachedPhoto");
    expect(src).toContain("setCachedPhoto");
  });

  it("imports the shared stateMemberPhotoUrl helper", () => {
    const src = getStateSource();
    expect(src).toContain('from "./representativesUtils"');
    expect(src).toContain("stateMemberPhotoUrl");
  });

  it("search endpoint wraps photoUrl with stateMemberPhotoUrl", () => {
    const src = getStateSource();
    expect(src).toMatch(
      /photoUrl:\s*stateMemberPhotoUrl\(r\.id,\s*!!r\.photoUrl\)/,
    );
  });

  it("detail endpoint wraps legislator.photoUrl with stateMemberPhotoUrl in the response", () => {
    const src = getStateSource();
    expect(src).toMatch(
      /\/state\/members\/:memberId[\s\S]{0,400}photoUrl:\s*stateMemberPhotoUrl\(memberId,\s*!!result\.legislator\.photoUrl\)/,
    );
  });

  it("refresh endpoint wraps legislator.photoUrl with stateMemberPhotoUrl in the response", () => {
    const src = getStateSource();
    expect(src).toMatch(
      /\/state\/members\/:memberId\/refresh[\s\S]{0,400}photoUrl:\s*stateMemberPhotoUrl\(memberId,\s*!!result\.legislator\.photoUrl\)/,
    );
  });

  it("member-photo endpoint checks getCachedPhoto before hitting upstream", () => {
    const src = getStateSource();
    expect(src).toContain("async function handleStateMemberPhoto");
    expect(src).toContain("const cached = await getCachedPhoto(row.photoUrl, memberId);");
  });

  it("member-photo endpoint writes to setCachedPhoto after upstream fetch", () => {
    const src = getStateSource();
    expect(src).toContain("await setCachedPhoto(row.photoUrl, memberId, buffer, contentType);");
  });

  it("supports legacy path-based member-photo URLs", () => {
    const src = getStateSource();
    expect(src).toContain('router.get(/^\\/state\\/member-photo\\/(.+)$/');
  });
});
