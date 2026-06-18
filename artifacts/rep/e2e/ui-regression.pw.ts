import { expect, test, type Page } from "@playwright/test";

const federalBills = Array.from({ length: 60 }).map((_, i) => ({
  id: `bill-${i + 1}`,
  title: `Federal Bill Title ${i + 1}`,
  number: `HR ${1000 + i}`,
  congress: "119",
  chamber: i % 2 ? "Senate" : "House",
  introducedDate: "2026-01-15",
  latestAction: "Referred to Committee",
  latestActionDate: "2026-02-01",
  sponsors: ["Jane Doe"],
}));

const stateBills = Array.from({ length: 60 }).map((_, i) => ({
  id: `state-${i + 1}`,
  title: `State Bill Title ${i + 1}`,
  identifier: `HB ${100 + i}`,
  chamber: i % 2 ? "upper" : "lower",
  introducedDate: "2026-01-10",
  latestAction: "In committee",
  sponsors: ["Del. Example"],
  session: "2026",
}));

const sponsoredBills = Array.from({ length: 26 }).map((_, i) => ({
  id: `sponsored-${i + 1}`,
  title: `Sponsored Legislation ${i + 1}`,
  number: i % 3 ? `HR ${4000 + i}` : `HRES ${700 + i}`,
  congress: "119",
  chamber: "House",
  introducedDate: "2026-03-01",
  latestAction: "Referred to Committee",
  itemCategory: i % 3 ? "bill" : "resolution",
}));

const stateMemberBills = Array.from({ length: 26 }).map((_, i) => ({
  id: `state-member-${i + 1}`,
  identifier: `HB ${500 + i}`,
  chamber: "lower",
  title: `State Sponsored Bill ${i + 1}`,
  latestAction: "Hearing scheduled",
  introducedDate: "2026-01-20",
}));

function paginate<T>(items: T[], offset: number, limit: number) {
  return items.slice(offset, offset + limit);
}

async function setListViewportScrollTop(page: Page, top: number) {
  await page.locator('[data-testid="bill-item"]').first().evaluate((element, nextTop) => {
    let node = element.parentElement;
    while (node) {
      const style = window.getComputedStyle(node);
      if (/(auto|scroll)/.test(style.overflowY)) {
        node.scrollTop = Number(nextTop);
        node.dispatchEvent(new Event("scroll", { bubbles: true }));
        return;
      }
      node = node.parentElement;
    }
    throw new Error("Scrollable list viewport not found");
  }, top);
}

async function getListViewportScrollTop(page: Page) {
  return await page.locator('[data-testid="bill-item"]').first().evaluate((element) => {
    let node = element.parentElement;
    while (node) {
      const style = window.getComputedStyle(node);
      if (/(auto|scroll)/.test(style.overflowY)) {
        return node.scrollTop;
      }
      node = node.parentElement;
    }
    throw new Error("Scrollable list viewport not found");
  });
}

async function mockApi(page: Page) {
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    const offset = Number(url.searchParams.get("offset") ?? "0");
    const limit = Number(url.searchParams.get("limit") ?? "20");

    if (path === "/api/federal/bills/search") {
      return route.fulfill({
        json: {
          bills: paginate(federalBills, offset, limit).slice(0, 5),
          totalCount: 24,
          offset,
        },
      });
    }
    if (path === "/api/federal/bills") {
      const stages = url.searchParams.get("stages") ?? "";
      if (stages) return route.fulfill({ json: { bills: [], totalCount: 0, offset: 0 } });
      return route.fulfill({
        json: {
          bills: paginate(federalBills, offset, limit),
          totalCount: 48,
          offset,
        },
      });
    }
    if (path.startsWith("/api/federal/bills/")) {
      return route.fulfill({
        json: {
          title: "Federal Bill Detail",
          number: "HR 1000",
          congress: "119",
          introducedDate: "2026-01-15",
          latestAction: "Referred to Committee",
          latestActionDate: "2026-02-01",
          summary: "Summary text",
          sponsors: [],
          cosponsors: [],
          committees: [],
          actions: [],
          progress: { introduced: true, committee: true },
        },
      });
    }
    if (path === "/api/state/bills") {
      return route.fulfill({
        json: {
          bills: paginate(stateBills, offset, limit),
          totalCount: 37,
          offset,
        },
      });
    }
    if (path.startsWith("/api/state/bills/")) {
      return route.fulfill({
        json: {
          id: "state-1",
          title: "State Bill Detail",
          identifier: "HB 100",
          chamber: "lower",
          introducedDate: "2026-01-10",
          latestAction: "In committee",
          summary: "Summary text",
          sponsors: [],
          cosponsors: [],
          actions: [],
          votes: [],
          stages: { introduced: true, committee: true, completedStages: ["introduced", "committee"] },
        },
      });
    }
    if (path === "/api/federal/members/F000001") {
      return route.fulfill({
        json: {
          member: {
            bioguideId: "F000001",
            name: "Federal Member",
            chamber: "House",
            state: "Maryland",
            district: "2",
            party: "Democratic",
            photoUrl: "",
            website: "https://example.com",
          },
          cache: { stale: false, refreshedAt: "2026-05-01T00:00:00.000Z" },
        },
      });
    }
    if (path === "/api/federal/members/F000001/bills") {
      const q = url.searchParams.get("q");
      const category = url.searchParams.get("category") ?? "all";
      const stages = url.searchParams.get("stages") ?? "";
      if (stages) {
        return route.fulfill({
          json: {
            bills: [],
            totalCount: 0,
            offset: 0,
            policyAreas: [],
            category,
            categoryCounts: { all: 0, bill: 0, resolution: 0, amendment: 0, other: 0 },
            fullyIngested: true,
            sourceTotalCount: 26,
          },
        });
      }
      const list = q ? sponsoredBills.filter((b) => b.title.toLowerCase().includes(q.toLowerCase())) : sponsoredBills;
      return route.fulfill({
        json: {
          bills: paginate(list, offset, limit),
          totalCount: list.length,
          offset,
          policyAreas: [{ name: "Taxation", count: 10, pct: 50 }],
          category,
          categoryCounts: { all: 26, bill: 26, resolution: 0, amendment: 0, other: 0 },
          fullyIngested: true,
          sourceTotalCount: 26,
        },
      });
    }
    if (path === "/api/state/members/S123") {
      return route.fulfill({
        json: {
          legislator: {
            id: "S123",
            name: "State Member",
            chamber: "House of Delegates",
            district: "6",
            party: "Democratic",
            jurisdiction: "md",
            state: "MD",
            photoUrl: "",
            openstatesUrl: "https://example.com",
          },
          cache: { stale: false, refreshFailed: false },
        },
      });
    }
    if (path === "/api/state/members/S123/bills") {
      return route.fulfill({
        json: {
          bills: paginate(stateMemberBills, offset, limit),
          totalCount: 26,
          offset,
        },
      });
    }
    if (path === "/api/state/members/S123/votes") {
      return route.fulfill({ json: { votes: [], totalCount: 0, offset: 0 } });
    }
    if (path === "/api/federal/members/F000001/house-votes" || path === "/api/federal/members/F000001/senate-votes") {
      return route.fulfill({ json: { votes: [], totalCount: 0, offset: 0 } });
    }
    if (path === "/api/federal/members/F000001/committees") {
      return route.fulfill({ json: { committees: [] } });
    }
    if (path.startsWith("/api/finance")) {
      return route.fulfill({ json: {} });
    }
    return route.fulfill({ status: 404, json: { error: `Unhandled mock for ${path}` } });
  });
}

test.beforeEach(async ({ page }) => {
  await mockApi(page);
  await page.addInitScript(() => {
    localStorage.setItem("civic-hub-state", "MD");
    localStorage.removeItem("civic-hub-address");
  });
});

test("federal bills page regression", async ({ page }) => {
  await page.goto("/bills/federal");
  await expect(page).toHaveScreenshot("federal-bills.png", { fullPage: true });
});

test("state bills page regression", async ({ page }) => {
  await page.goto("/bills/state");
  await expect(page).toHaveScreenshot("state-bills.png", { fullPage: true });
});

test("federal rep bills tab regression", async ({ page }) => {
  await page.goto("/rep/federal/F000001");
  await expect(page).toHaveScreenshot("federal-rep-bills.png", { fullPage: true });
});

test("state rep bills tab regression", async ({ page }) => {
  await page.goto("/rep/state/S123");
  await expect(page).toHaveScreenshot("state-rep-bills.png", { fullPage: true });
});

test("federal bills status filter keeps displayed counts in present context", async ({
  page,
}) => {
  await page.goto("/bills/federal");
  // Button label is "Status Off" on desktop, "Status" on mobile
  await page.getByRole("button", { name: /^Status/ }).first().click();
  await page.getByRole("button", { name: "Signed/Enacted" }).click();

  await expect(page.getByText("0 bills")).toBeVisible();
  await expect(page.getByText("0–0 of 0")).toBeVisible();
  await expect(page.getByRole("button", { name: "Next" })).toBeDisabled();
});

test("federal rep category count stays in status-filter context", async ({
  page,
}) => {
  await page.goto("/rep/federal/F000001");
  // Button label is "Status Off" on desktop, "Status" on mobile
  await page.getByRole("button", { name: /^Status/ }).first().click();
  await page.getByRole("button", { name: "Signed/Enacted" }).click();

  await expect(page.getByRole("button", { name: "All (0)" })).toBeVisible();
  // "0–0 of 0" lives in a desktop-only container; the category count above is sufficient
});

test("desktop federal bills pagination resets the inner list scroll to top", async ({
  page,
  isMobile,
}) => {
  test.skip(isMobile, "Desktop-only pagination behavior");

  await page.goto("/bills/federal");
  await setListViewportScrollTop(page, 500);
  await expect.poll(() => getListViewportScrollTop(page)).toBeGreaterThan(0);

  await page.getByRole("button", { name: "Next" }).click();

  await expect(page.getByText("21–40 of 48")).toBeVisible();
  await expect.poll(() => getListViewportScrollTop(page)).toBe(0);
});

test("desktop state bills pagination resets the inner list scroll to top", async ({
  page,
  isMobile,
}) => {
  test.skip(isMobile, "Desktop-only pagination behavior");

  await page.goto("/bills/state");
  await setListViewportScrollTop(page, 500);
  await expect.poll(() => getListViewportScrollTop(page)).toBeGreaterThan(0);

  await page.getByRole("button", { name: "Next" }).click();

  await expect(page.getByText("21–37 of 37")).toBeVisible();
  await expect.poll(() => getListViewportScrollTop(page)).toBe(0);
});

test("desktop federal rep bill pagination resets the inner list scroll to top", async ({
  page,
  isMobile,
}) => {
  test.skip(isMobile, "Desktop-only pagination behavior");

  await page.goto("/rep/federal/F000001");
  await setListViewportScrollTop(page, 500);
  await expect.poll(() => getListViewportScrollTop(page)).toBeGreaterThan(0);

  await page.getByRole("button", { name: "Next" }).click();

  await expect(page.getByText("21–26 of 26")).toBeVisible();
  await expect.poll(() => getListViewportScrollTop(page)).toBe(0);
});

test("desktop state rep bill pagination resets the inner list scroll to top", async ({
  page,
  isMobile,
}) => {
  test.skip(isMobile, "Desktop-only pagination behavior");

  await page.goto("/rep/state/S123");
  await setListViewportScrollTop(page, 500);
  await expect.poll(() => getListViewportScrollTop(page)).toBeGreaterThan(0);

  await page.getByRole("button", { name: "Next" }).click();

  await expect(page.getByText("21–26 of 26")).toBeVisible();
  await expect.poll(() => getListViewportScrollTop(page)).toBe(0);
});

test("returning from bill detail restores the prior list scroll position", async ({
  page,
  isMobile,
}) => {
  test.skip(isMobile, "Desktop-only restoration behavior");

  await page.goto("/bills/federal");
  await setListViewportScrollTop(page, 500);
  const scrollBeforeOpen = await getListViewportScrollTop(page);

  await page.locator('[data-testid="bill-item"]').nth(6).click();
  await expect(page.getByRole("link", { name: /Back to Federal Bills/i })).toBeVisible();

  await page.getByRole("link", { name: /Back to Federal Bills/i }).click();
  await expect(page.getByText("1–20 of 48")).toBeVisible();
  await expect.poll(() => getListViewportScrollTop(page)).toBe(scrollBeforeOpen);
});
