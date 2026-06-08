import { eq } from "drizzle-orm";
import {
  db,
  federalMemberBillRolesTable,
  federalBillsSyncStateTable,
} from "@workspace/db";
import {
  classifyFederalLegislationItem,
  getFederalLegislationDisplayNumber,
  getFederalLegislationTitle,
} from "./federalMemberLegislation";
import {
  computeLegislationStageFlags,
  finalizeFederalStageFlags,
} from "./legislationStages";
import { upsertFederalBill } from "./upsertFederalBill";
import { getCurrentCongressNumber } from "./federalBillProgress";
import { fetchWithTimeout as fetch } from "./http";
import { logger } from "./logger";
import { logRefreshEvent } from "./ingestFederalMembers";

const BASE = "https://api.congress.gov/v3";
const CONGRESS_API_KEY = process.env.CONGRESS_API_KEY;

// If the last successful weekly delta is older than this, fall back to a full sweep.
const FULL_SWEEP_THRESHOLD_MS = 90 * 24 * 60 * 60 * 1000;
// Overlap window subtracted from last-completed timestamp to avoid edge-case gaps.
const DELTA_BUFFER_MS = 24 * 60 * 60 * 1000;

const DELTA_KEY = "weekly_delta";

async function fetchWithRetry(url: string, maxAttempts = 3): Promise<any> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await fetch(url);
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`HTTP ${res.status}: ${text}`);
      }
      return res.json();
    } catch (err) {
      lastErr = err;
      if (attempt < maxAttempts) {
        const delay = attempt * 2000;
        logger.warn({ err, attempt, url }, `Congress bill fetch failed, retrying in ${delay}ms`);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }
  throw lastErr;
}

async function ingestCongressBillsPage(
  congress: number,
  offset: number,
  currentCongress: number,
  fromDate?: Date,
): Promise<{ inserted: number; totalExpected: number }> {
  if (!CONGRESS_API_KEY) throw new Error("CONGRESS_API_KEY not configured");

  const url = new URL(`${BASE}/bill/${congress}`);
  url.searchParams.set("api_key", CONGRESS_API_KEY);
  url.searchParams.set("format", "json");
  url.searchParams.set("limit", "250");
  url.searchParams.set("offset", String(offset));
  if (fromDate) {
    url.searchParams.set("fromDateTime", fromDate.toISOString());
    url.searchParams.set("sort", "updateDate desc");
  }

  const data = await fetchWithRetry(url.toString());
  const bills: any[] = data.bills ?? [];
  const totalExpected: number = data.pagination?.count ?? 0;

  await Promise.all(
    bills.map(async (b) => {
      const billType = (b.type ?? "").toUpperCase();
      const billNumber = b.number ?? b.billNumber;
      if (!billType || !billNumber) return;

      const billId = `${b.congress}-${billType}-${billNumber}`;
      const displayNumber = getFederalLegislationDisplayNumber(b) ?? `${b.type} ${billNumber}`;
      const title = getFederalLegislationTitle(b);
      const latestActionText = b.latestAction?.text ?? null;
      const latestActionDate = b.latestAction?.actionDate ?? null;
      const subjects: string[] =
        b.subjects?.legislativeSubjects?.item?.map((s: any) => s.name ?? s) ??
        b.subjects?.item ??
        (Array.isArray(b.subjects) ? b.subjects : []);
      const stageFlags = finalizeFederalStageFlags(
        computeLegislationStageFlags({
          latestAction: latestActionText,
          introducedDate: b.introducedDate ?? null,
        }),
        congress,
        currentCongress,
      );

      await upsertFederalBill({
        id: billId,
        title,
        type: b.type ?? null,
        number: displayNumber,
        congress: b.congress != null ? Number(b.congress) : null,
        introducedDate: b.introducedDate ?? null,
        latestAction: latestActionText,
        latestActionDate,
        chamber: b.originChamber ?? null,
        category: classifyFederalLegislationItem(b),
        policyArea: b.policyArea?.name ?? null,
        subjects,
        url: b.url ?? null,
        updateDate: b.updateDate ?? null,
        stageIntroduced: stageFlags.introduced,
        stageCommittee: stageFlags.committee,
        stageFloorVote: stageFlags.floor_vote,
        stagePassed: stageFlags.passed,
        stageSignedEnacted: stageFlags.signed_enacted,
        stageDead: stageFlags.dead,
      });

      const sponsorId: string | undefined = b.sponsors?.[0]?.bioguideId;
      if (sponsorId) {
        await db
          .insert(federalMemberBillRolesTable)
          .values({
            bioguideId: sponsorId,
            billId,
            congress: b.congress != null ? Number(b.congress) : null,
            role: "sponsor",
            fetchedAt: new Date(),
          })
          .onConflictDoNothing();
      }
    }),
  );

  return { inserted: bills.length, totalExpected };
}

async function ingestAllBillsForCongress(
  congress: number,
  currentCongress: number,
  fromDate?: Date,
): Promise<{ count: number }> {
  const start = Date.now();
  const mode = fromDate ? "delta" : "full";
  logger.info({ congress, mode, fromDate }, "Starting Congress bill ingestion");
  logRefreshEvent({ event: "congress_bills_ingest_start", congress, mode });

  let offset = 0;
  let totalIngested = 0;
  let totalExpected = 0;
  const MAX_PAGES = 200;

  for (let page = 1; page <= MAX_PAGES; page++) {
    const result = await ingestCongressBillsPage(congress, offset, currentCongress, fromDate);
    totalIngested += result.inserted;
    totalExpected = result.totalExpected;

    if (result.inserted === 0) break;
    if (totalIngested >= totalExpected) break;
    offset += result.inserted;
  }

  const durationMs = Date.now() - start;
  logger.info({ congress, count: totalIngested, durationMs, mode }, "Congress bill ingestion complete");
  logRefreshEvent({ event: "congress_bills_ingest_complete", congress, count: totalIngested, durationMs, mode });

  return { count: totalIngested };
}

async function markSyncStarted(key: string, fromDate?: Date): Promise<void> {
  await db
    .insert(federalBillsSyncStateTable)
    .values({ key, startedAt: new Date(), completedAt: null, billsProcessed: 0, fromDate: fromDate ?? null })
    .onConflictDoUpdate({
      target: federalBillsSyncStateTable.key,
      set: { startedAt: new Date(), completedAt: null, billsProcessed: 0, fromDate: fromDate ?? null },
    });
}

async function markSyncCompleted(key: string, billsProcessed: number): Promise<void> {
  await db
    .update(federalBillsSyncStateTable)
    .set({ completedAt: new Date(), billsProcessed })
    .where(eq(federalBillsSyncStateTable.key, key));
}

async function runFullIngestWithTracking(
  congress: number,
  stateKey: string,
  currentCongress: number,
): Promise<void> {
  await markSyncStarted(stateKey);
  const { count } = await ingestAllBillsForCongress(congress, currentCongress);
  await markSyncCompleted(stateKey, count);
}

/**
 * Called at server startup. Runs a full ingest for each Congress that has
 * never been fully loaded (or whose previous load was interrupted).
 * Does nothing if both Congresses are already fully ingested.
 */
export async function checkAndIngestOnStartup(): Promise<void> {
  const currentCongress = getCurrentCongressNumber();
  const prevCongress = currentCongress - 1;

  const states = await db
    .select()
    .from(federalBillsSyncStateTable)
    .where(
      eq(federalBillsSyncStateTable.key, `initial_load_${currentCongress}`),
    );
  const prevStates = await db
    .select()
    .from(federalBillsSyncStateTable)
    .where(eq(federalBillsSyncStateTable.key, `initial_load_${prevCongress}`));

  const currentState = states[0];
  const prevState = prevStates[0];

  if (!currentState?.completedAt) {
    const reason = currentState ? "interrupted" : "never_started";
    logger.info({ currentCongress, reason }, "Current Congress initial load incomplete, ingesting");
    logRefreshEvent({ event: "startup_full_ingest", congress: currentCongress, reason });
    await runFullIngestWithTracking(currentCongress, `initial_load_${currentCongress}`, currentCongress);
  } else {
    logger.info({ currentCongress }, "Current Congress initial load complete, skipping");
  }

  if (!prevState?.completedAt) {
    const reason = prevState ? "interrupted" : "never_started";
    logger.info({ prevCongress, reason }, "Previous Congress initial load incomplete, ingesting");
    logRefreshEvent({ event: "startup_full_ingest", congress: prevCongress, reason });
    await runFullIngestWithTracking(prevCongress, `initial_load_${prevCongress}`, currentCongress);
  } else {
    logger.info({ prevCongress }, "Previous Congress initial load complete, skipping");
  }
}

/**
 * Called by the weekly scheduler. Fetches only bills updated since the last
 * successful sync (minus a 1-day buffer). Falls back to a full ingest if the
 * last successful sync is older than 90 days or has never run.
 */
export async function runWeeklyDeltaIngest(): Promise<{ count: number }> {
  const currentCongress = getCurrentCongressNumber();

  const [lastSync] = await db
    .select()
    .from(federalBillsSyncStateTable)
    .where(eq(federalBillsSyncStateTable.key, DELTA_KEY));

  const lastCompletedAt = lastSync?.completedAt;
  const isTooOld =
    !lastCompletedAt ||
    Date.now() - lastCompletedAt.getTime() > FULL_SWEEP_THRESHOLD_MS;

  if (isTooOld) {
    const reason = lastCompletedAt ? "too_old" : "never_run";
    logger.info({ lastCompletedAt, reason }, "Weekly delta: falling back to full ingest");
    logRefreshEvent({ event: "weekly_full_fallback", reason });
    await markSyncStarted(DELTA_KEY);
    const { count } = await ingestAllBillsForCongress(currentCongress, currentCongress);
    await markSyncCompleted(DELTA_KEY, count);
    return { count };
  }

  const fromDate = new Date(lastCompletedAt.getTime() - DELTA_BUFFER_MS);
  logger.info({ fromDate, lastCompletedAt }, "Running weekly delta bill ingest");
  logRefreshEvent({ event: "weekly_delta_start", fromDate: fromDate.toISOString() });

  await markSyncStarted(DELTA_KEY, fromDate);
  const { count } = await ingestAllBillsForCongress(currentCongress, currentCongress, fromDate);
  await markSyncCompleted(DELTA_KEY, count);

  logRefreshEvent({ event: "weekly_delta_complete", count, fromDate: fromDate.toISOString() });
  return { count };
}
