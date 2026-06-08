import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Parses a TSX file and finds JSX elements whose className contains a target class.
 * Uses a simple tokenizer approach that is robust against most formatting changes.
 */
function findElementsWithClass(source: string, targetClass: string): Array<{ tag: string; className: string; line: number }> {
  const results: Array<{ tag: string; className: string; line: number }> = [];
  const lines = source.split("\n");

  // Regex to match opening JSX tags with className attribute
  // Handles: className="...", className={`...`}, className={"..."}, className={clsx("...")} etc.
  const tagRegex = /<([A-Za-z][A-Za-z0-9]*)\b[^>]*?\bclassName=(?:\{`?"?([^`"\}]+)"?`?\}|"([^"]+)")/g;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let match;
    while ((match = tagRegex.exec(line)) !== null) {
      const tag = match[1];
      // match[2] is inside braces/backticks, match[3] is raw string
      const className = (match[2] ?? match[3] ?? "").trim();
      if (className.includes(targetClass)) {
        results.push({ tag, className, line: i + 1 });
      }
    }
  }

  return results;
}

function getPageSource(name: string): string {
  const path = resolve(import.meta.dirname, `${name}.tsx`);
  return readFileSync(path, "utf8");
}

function getLayoutSource(name: string): string {
  const path = resolve(import.meta.dirname, `../components/layout/${name}.tsx`);
  return readFileSync(path, "utf8");
}

const pageShellPages = [
  "FederalRepDetail",
  "StateRepDetail",
  "FederalBills",
  "StateBills",
];

const mobileInfiniteScrollPages = [
  "FederalBills",
  "StateBills",
  "FederalRepDetail",
  "StateRepDetail",
];

describe("Scroll layout regression", () => {
  it("PageShell keeps fixed viewport and non-scrolling outer container", () => {
    const source = getLayoutSource("PageShell");
    expect(source.includes("h-[calc(100dvh-4rem)]")).toBe(true);
    expect(source.includes("overflow-hidden")).toBe(true);
  });

  it("ListViewport enforces a single inner scroll region", () => {
    const source = getLayoutSource("ListViewport");
    expect(source.includes("overflow-y-auto")).toBe(true);
    expect(source.includes("min-h-0")).toBe(true);
    expect(source.includes("pr-1")).toBe(true);
  });

  it.each(pageShellPages)("%s uses shared PageShell and ListViewport", (name) => {
    const source = getPageSource(name);
    expect(source.includes("<PageShell")).toBe(true);
    expect(source.includes("<ListViewport")).toBe(true);
  });

  it.each(mobileInfiniteScrollPages)(
    "%s binds IntersectionObserver to the inner ListViewport scroll root",
    (name) => {
      const source = getPageSource(name);
      expect(source.includes('root: listViewportRef.current')).toBe(true);
    },
  );

  it("Home keeps fixed outer container and inner scrolling area", () => {
    const source = getPageSource("Home");
    const outerMatches = findElementsWithClass(source, "overflow-hidden");
    const outer = outerMatches.find((m) =>
      m.className.includes("h-[calc(100dvh-4rem)]") &&
      m.className.includes("overflow-hidden"),
    );
    const inner = findElementsWithClass(source, "overflow-y-auto");
    expect(outer).toBeTruthy();
    expect(inner.length).toBeGreaterThan(0);
  });
});
