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

  it("imports the shared browser photo URL helper", () => {
    const src = getStateSource();
    expect(src).toContain('from "./representativesUtils"');
    expect(src).toContain("toBrowserPhotoUrl");
  });

  it("search endpoint returns browser-facing photo URLs", () => {
    const src = getStateSource();
    expect(src).toContain("photoUrl: toBrowserPhotoUrl(r.photoUrl)");
  });

  it("detail endpoint returns the browser-facing photo URL in the response", () => {
    const src = getStateSource();
    expect(src).toContain("photoUrl: toBrowserPhotoUrl(result.legislator.photoUrl)");
  });

  it("refresh endpoint returns the browser-facing photo URL in the response", () => {
    const src = getStateSource();
    expect(src).toContain("photoUrl: toBrowserPhotoUrl(result.legislator.photoUrl)");
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

  it("marks placeholder responses as stale when upstream fetch fails", () => {
    const src = getStateSource();
    expect(src).toContain('.set("X-Photo-Stale", options?.stale ? "1" : "0")');
    expect(src).toContain("sendPlaceholderPhoto(res, { stale: true });");
  });
});
