import fs from "node:fs";
import path from "node:path";
import { max, sql, eq } from "drizzle-orm";
import { db, federalMembersTable } from "@workspace/db";
import { fetchWithTimeout as fetch } from "./http";
import { logger } from "./logger";

const BASE = "https://api.congress.gov/v3";
const CONGRESS_API_KEY = process.env.CONGRESS_API_KEY;

import {
  normalizeCongressMember,
  normalizeCongressTerms as normalizeTerms,
} from "./federalMemberHelpers";

function getLogFilePath(): string {
  const logDir = process.env.LOG_DIR ?? "./logs";
  return path.join(logDir, "member-refresh.log");
}

export function logRefreshEvent(event: Record<string, unknown>): void {
  const logFile = getLogFilePath();
  const line = JSON.stringify({ ...event, timestamp: new Date().toISOString() }) + "\n";
  try {
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    fs.appendFileSync(logFile, line, "utf8");
  } catch (err) {
    logger.warn({ err }, "Failed to write member-refresh log");
  }
}

async function fetchAllCurrentMembers(): Promise<any[]> {
  if (!CONGRESS_API_KEY) throw new Error("CONGRESS_API_KEY not configured");

  const all: any[] = [];
  let offset = 0;
  const limit = 250;

  while (true) {
    const url = new URL(`${BASE}/member`);
    url.searchParams.set("api_key", CONGRESS_API_KEY);
    url.searchParams.set("format", "json");
    url.searchParams.set("currentMember", "true");
    url.searchParams.set("limit", String(limit));
    url.searchParams.set("offset", String(offset));

    const res = await fetch(url.toString());
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Congress API error ${res.status}: ${text}`);
    }
    const data = (await res.json()) as any;
    const page: any[] = data.members ?? [];
    all.push(...page);
    if (page.length < limit) break;
    offset += limit;
  }

  return all;
}

export async function ingestAllFederalMembers(): Promise<{ count: number }> {
  const start = Date.now();
  logger.info("Starting federal member ingestion from Congress.gov");

  const raw = await fetchAllCurrentMembers();

  const values = raw
    .filter((m) => normalizeTerms(m).some((t) => !t.endYear))
    .map((m) => {
      const normalized = normalizeCongressMember(m);
      return {
        bioguideId: normalized.bioguideId,
        name: normalized.name,
        party: normalized.party,
        state: normalized.state,
        chamber: normalized.chamber,
        district: normalized.district,
        photoUrl: normalized.photoUrl,
        nextElection: normalized.nextElection,
        inOffice: normalized.inOffice ?? true,
        terms: normalized.terms,
        phone: normalized.phone,
        website: normalized.website,
        raw: m as object,
        fetchedAt: new Date(),
      };
    });

  await db.transaction(async (tx) => {
    // Mark all previously in-office members as out before upserting the fresh list
    await tx.execute(sql`UPDATE federal_members SET in_office = false WHERE in_office = true`);

    const CHUNK = 100;
    for (let i = 0; i < values.length; i += CHUNK) {
      await tx
        .insert(federalMembersTable)
        .values(values.slice(i, i + CHUNK))
        .onConflictDoUpdate({
          target: federalMembersTable.bioguideId,
          set: {
            name: sql`EXCLUDED.name`,
            party: sql`EXCLUDED.party`,
            state: sql`EXCLUDED.state`,
            chamber: sql`EXCLUDED.chamber`,
            district: sql`EXCLUDED.district`,
            photoUrl: sql`EXCLUDED.photo_url`,
            nextElection: sql`EXCLUDED.next_election`,
            inOffice: sql`EXCLUDED.in_office`,
            terms: sql`EXCLUDED.terms`,
            raw: sql`EXCLUDED.raw`,
            fetchedAt: sql`EXCLUDED.fetched_at`,
            // phone and website intentionally omitted — preserved from detail fetches
          },
        });
    }
  });

  const durationMs = Date.now() - start;
  logger.info({ count: values.length, durationMs }, "Federal member ingestion complete");
  logRefreshEvent({ event: "ingest_complete", count: values.length, durationMs });

  return { count: values.length };
}

export async function checkAndIngestIfStale(): Promise<void> {
  const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

  const [row] = await db
    .select({ latest: max(federalMembersTable.fetchedAt) })
    .from(federalMembersTable)
    .where(eq(federalMembersTable.inOffice, true));

  const latest = row?.latest;
  if (latest && Date.now() - latest.getTime() < SEVEN_DAYS_MS) {
    logger.info({ latest }, "Federal member data is fresh, skipping ingestion");
    return;
  }

  logger.info({ latest }, "Federal member data is stale or absent, ingesting");
  await ingestAllFederalMembers();
}
