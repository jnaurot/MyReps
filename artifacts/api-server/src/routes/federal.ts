import { Router } from "express";
import { eq, and, or, asc, desc, sql, inArray, lt } from "drizzle-orm";
import { XMLParser } from "fast-xml-parser";
import {
  getCachedPhoto,
  setCachedPhoto,
} from "../lib/photoCache";
import {
  db,
  normalizeVoteCast,
  federalBillsTable,
  federalMembersTable,
  federalMemberBillRolesTable,
  federalMemberBillCacheStatusTable,
  federalCommitteesTable,
  federalMemberCommitteesTable,
} from "@workspace/db";
import {
  houseVotesTable,
  houseVoteRecordsTable,
  senateRollCallVotesTable,
  senatorVotePositionsTable,
} from "@workspace/db";
import {
  GetFederalMemberParams,
  GetFederalMemberBillsParams,
  GetFederalMemberBillsQueryParams,
  GetFederalMemberCommitteesParams,
  GetFederalBillsQueryParams,
  GetFederalBillDetailParams,
  GetFederalStateMembersQueryParams,
  GetFederalMemberHouseVotesParams,
  GetFederalMemberHouseVotesQueryParams,
  GetFederalMemberSenateVotesParams,
  GetFederalMemberSenateVotesQueryParams,
  SearchFederalMembersQueryParams,
  SearchFederalBillsQueryParams,
} from "@workspace/api-zod";
import { fetchWithTimeout as fetch } from "../lib/http";
import {
  sendInternalError,
  ProviderRateLimitError,
  isProviderRateLimitError,
  sendProviderRateLimitError,
} from "../lib/respond";
import { logger } from "../lib/logger";
import {
  classifyFederalLegislationItem,
  getFederalLegislationDisplayNumber,
  getFederalLegislationItemId,
  getFederalLegislationTitle,
  mapFederalLegislationForResponse,
  shouldResumeMemberLegislationIngestion,
  type FederalLegislationCategory,
} from "../lib/federalMemberLegislation";
import { upsertFederalBill } from "../lib/upsertFederalBill";
import {
  computeLegislationStageFlags,
  finalizeFederalStageFlags,
  LEGISLATION_STAGE_KEYS,
  parseStageQuery,
  type LegislationFilterKey,
  type LegislationStageKey,
} from "../lib/legislationStages";
import { computeFederalBillProgress, getCurrentCongressNumber } from "../lib/federalBillProgress";
import { dedupeAndSortFederalBillActions } from "../lib/federalBillActions";
import { dedupeFederalBillVotes } from "../lib/federalBillVotes";
import { shouldRefetchField } from "../lib/summaryCacheUtils";
import { normalizeSummaryText } from "../lib/summaryText";

const router = Router();

const STALE_THRESHOLD_MS = 7 * 24 * 60 * 60 * 1000;

const CONGRESS_API_KEY = process.env.CONGRESS_API_KEY;
const BASE = "https://api.congress.gov/v3";

function federalStageColumn(stage: LegislationStageKey) {
  switch (stage) {
    case "introduced":
      return federalBillsTable.stageIntroduced;
    case "committee":
      return federalBillsTable.stageCommittee;
    case "floor_vote":
      return federalBillsTable.stageFloorVote;
    case "passed":
      return federalBillsTable.stagePassed;
    case "signed_enacted":
      return federalBillsTable.stageSignedEnacted;
    case "dead":
      return federalBillsTable.stageDead;
  }
}

function buildFederalBillsStageCondition(selectedStages: LegislationFilterKey[]) {
  if (selectedStages.length === 0) return undefined;

  return or(
    ...selectedStages.map((stage) =>
      stage === "active"
        ? and(
            eq(federalBillsTable.stageDead, false),
            eq(federalBillsTable.stageSignedEnacted, false),
          )
        : eq(federalStageColumn(stage), true),
    ),
  );
}

function buildFederalBillsDbConditions({
  q,
  chamberFilter,
  policyArea,
  stageCondition,
  currentCongress,
  searchAllCongresses,
}: {
  q?: string;
  chamberFilter: string | null;
  policyArea?: string;
  stageCondition?: ReturnType<typeof or>;
  currentCongress: number;
  searchAllCongresses: boolean;
}) {
  const conditions = [];

  if (!searchAllCongresses) {
    conditions.push(eq(federalBillsTable.congress, currentCongress));
  }
  if (q) {
    const searchQuery = sql`websearch_to_tsquery('english', ${q})`;
    conditions.push(
      sql`(${federalBillsTable.searchVector} @@ ${searchQuery} OR ${q} % ${federalBillsTable.title})`,
    );
  }
  if (chamberFilter) {
    conditions.push(eq(federalBillsTable.chamber, chamberFilter));
  }
  if (policyArea) {
    conditions.push(eq(federalBillsTable.policyArea, policyArea));
  }
  if (stageCondition) {
    conditions.push(stageCondition);
  }

  return conditions;
}

async function congressFetch(
  path: string,
  params: Record<string, string | number> = {},
  logger?: any,
) {
  if (!CONGRESS_API_KEY) throw new Error("CONGRESS_API_KEY not configured");
  const url = new URL(`${BASE}${path}`);
  url.searchParams.set("api_key", CONGRESS_API_KEY);
  url.searchParams.set("format", "json");
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, String(v));
  }
  logger?.info(
    { url: url.toString(), source: "congress.gov" },
    "Fetching from Congress.gov",
  );
  const res = await fetch(url.toString());
  if (!res.ok) {
    const text = await res.text();
    if (
      res.status === 429 ||
      (res.status === 403 && text.toLowerCase().includes("rate"))
    ) {
      throw new ProviderRateLimitError({
        provider: "Congress.gov",
        detail: text.slice(0, 200),
      });
    }
    throw new Error(`Congress API error ${res.status}: ${text}`);
  }
  return res.json() as Promise<any>;
}

import {
  formatCongressMemberName as formatCongressName,
  normalizeCongressTerms as normalizeTermsItem,
} from "../lib/federalMemberHelpers";

function getLastName(name: string): string {
  // Congress.gov raw format is "Last, First"; after formatting it's "First Last"
  if (name.includes(", ")) {
    return name.split(", ")[0]?.trim().toLowerCase() ?? "";
  }
  const parts = name.trim().split(/\s+/);
  return parts[parts.length - 1]?.toLowerCase() ?? "";
}

function memberPhotoUrl(bioguideId: string, hasPhoto: boolean): string | undefined {
  return hasPhoto ? `/api/federal/member-photo/${bioguideId}` : undefined;
}

function normalizeMemberFromRaw(m: any) {
  return {
    bioguideId: m.bioguideId ?? "",
    name: m.directOrderName ?? m.invertedOrderName ?? "",
    party: m.partyHistory?.[0]?.partyName,
    state: m.state,
    chamber: normalizeTermsItem(m).slice(-1)[0]?.chamber ?? undefined,
    district: m.district != null ? String(m.district) : undefined,
    phone: m.officeAddress,
    website: m.officialWebsiteUrl,
    photoUrl: memberPhotoUrl(m.bioguideId ?? "", !!m.depiction?.imageUrl),
    terms: normalizeTermsItem(m).length,
    inOffice: m.currentMember,
    nextElection: m.nextElection,
  };
}

function mapDbRowToMember(row: typeof federalMembersTable.$inferSelect) {
  const raw = (row.raw ?? {}) as any;
  return {
    bioguideId: row.bioguideId,
    name: row.name,
    party: row.party ?? undefined,
    state: row.state ?? undefined,
    chamber: row.chamber ?? undefined,
    district: row.district ?? undefined,
    phone: row.phone ?? undefined,
    website: row.website ?? undefined,
    photoUrl: memberPhotoUrl(row.bioguideId, !!row.photoUrl),
    terms: raw.terms != null ? Number(raw.terms) : undefined,
    inOffice: row.inOffice ?? undefined,
    nextElection: row.nextElection ?? undefined,
  };
}

function isStale(row: typeof federalMembersTable.$inferSelect): boolean {
  return Date.now() - new Date(row.fetchedAt).getTime() > STALE_THRESHOLD_MS;
}

// House Clerk XML comcode -> committee name mapping (standing + select committees, 119th Congress)
const HOUSE_COMMITTEE_NAMES: Record<string, string> = {
  AG00: "Committee on Agriculture",
  AP00: "Committee on Appropriations",
  AS00: "Committee on Armed Services",
  BA00: "Committee on Financial Services",
  BU00: "Committee on the Budget",
  ED00: "Committee on Education and the Workforce",
  FA00: "Committee on Foreign Affairs",
  GO00: "Committee on Oversight and Government Reform",
  HA00: "Committee on House Administration",
  HM00: "Committee on Homeland Security",
  IF00: "Committee on Energy and Commerce",
  IG00: "Permanent Select Committee on Intelligence",
  JU00: "Committee on the Judiciary",
  PW00: "Committee on Transportation and Infrastructure",
  RU00: "Committee on Rules",
  SM00: "Committee on Small Business",
  SO00: "Committee on Ethics",
  SY00: "Committee on Science, Space, and Technology",
  VR00: "Committee on Veterans' Affairs",
  WM00: "Committee on Ways and Means",
  EC00: "Joint Economic Committee",
  IT00: "Joint Committee on Taxation",
  JL00: "Joint Committee on the Library",
  JP00: "Joint Committee on Printing",
  ZL00: "Select Committee on the Strategic Competition Between the U.S. and the Chinese Communist Party",
  ZR00: "Select Subcommittee on the Weaponization of the Federal Government",
};

async function fetchHouseCommitteesFromClerkXml(): Promise<
  Map<string, string[]>
> {
  const res = await fetch("https://clerk.house.gov/xml/lists/MemberData.xml", {
    headers: { "User-Agent": "CivicHub/1.0" },
  });
  if (!res.ok) throw new Error(`House Clerk XML error ${res.status}`);
  const xml = await res.text();
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
  });
  const obj = parser.parse(xml);

  const memberMap = new Map<string, string[]>();
  const members = obj?.MemberData?.members?.member ?? [];
  for (const m of Array.isArray(members) ? members : [members]) {
    const bioguideId =
      m?.memberInfo?.bioguideID ?? m?.["member-info"]?.bioguideID;
    if (!bioguideId) continue;
    const assignments: string[] = [];
    const committeeAssignments =
      m?.committeeAssignments ?? m?.["committee-assignments"];
    const committees = committeeAssignments?.committee ?? [];
    for (const c of Array.isArray(committees) ? committees : [committees]) {
      const code = c?.["@_comcode"];
      if (code) assignments.push(code);
    }
    memberMap.set(bioguideId, assignments);
  }
  return memberMap;
}

async function fetchSenateCommitteesFromXml(
  bioguideId: string,
): Promise<Array<{ code: string; name: string }>> {
  // Senate committee XMLs are per-committee. To avoid fetching all ~20 committee XMLs
  // on every request, we fetch the Senate contact XML to get all senator names, then
  // try to match the requested senator against committee rosters.
  // NOTE: This is a best-effort approach. The Senate XML does not include bioguideIds.

  // Step 1: Get the senator's name from our cached member data
  const rows = await db
    .select()
    .from(federalMembersTable)
    .where(eq(federalMembersTable.bioguideId, bioguideId))
    .limit(1);
  const memberName = rows[0]?.name;
  if (!memberName) return [];

  const lastName = memberName.split(" ").pop()?.toLowerCase() ?? "";

  // Step 2: Fetch Senate contact XML to get all senator names for matching
  const contactRes = await fetch(
    "https://www.senate.gov/general/contact_information/senators_cfm.xml",
    { headers: { "User-Agent": "CivicHub/1.0" } },
  );
  if (!contactRes.ok) return [];
  const contactXml = await contactRes.text();
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
  });
  const contactObj = parser.parse(contactXml);

  const senators = contactObj?.contact_information?.member ?? [];
  let targetLastName = "";
  for (const s of Array.isArray(senators) ? senators : [senators]) {
    const id = s?.bioguide_id;
    if (id === bioguideId) {
      targetLastName = (s?.last_name ?? "").toLowerCase().trim();
      break;
    }
  }
  if (!targetLastName) targetLastName = lastName;

  // Step 3: Fetch all Senate committee XMLs and search for the senator
  const committeeCodes = [
    "SSEG",
    "SSBK",
    "SSAF",
    "SSAP",
    "SSAS",
    "SSBU",
    "SSCM",
    "SSEG",
    "SSFI",
    "SSFR",
    "SSGA",
    "SSHR",
    "SSHS",
    "SSJU",
    "SSRA",
    "SSSB",
    "SSVA",
    "SSCM",
    "SLET",
  ];
  const results: Array<{ code: string; name: string }> = [];

  for (const code of committeeCodes) {
    try {
      const res = await fetch(
        `https://www.senate.gov/general/committee_membership/committee_memberships_${code}.xml`,
        { headers: { "User-Agent": "CivicHub/1.0" } },
      );
      if (!res.ok) continue;
      const xml = await res.text();
      const obj = parser.parse(xml);
      const committeeName =
        obj?.committee_membership?.committees?.committee_name ?? "";
      const members =
        obj?.committee_membership?.committees?.members?.member ?? [];
      for (const m of Array.isArray(members) ? members : [members]) {
        const memberLastName = (m?.name?.last ?? "").toLowerCase().trim();
        if (memberLastName === targetLastName) {
          results.push({ code, name: committeeName });
          break;
        }
      }
    } catch {
      // ignore individual committee fetch failures
    }
  }

  return results;
}

function computePolicyAreas(
  rows: Array<{ name: string | null; count: string | number }>,
): Array<{ name: string; count: number; pct: number }> {
  const total = rows.reduce((sum, r) => sum + Number(r.count), 0);
  if (total === 0) return [];

  return rows.map((r) => ({
    name: r.name ?? "Unknown",
    count: Number(r.count),
    pct: Math.round((Number(r.count) / total) * 100),
  }));
}

async function fetchAndCacheFederalMember(bioguideId: string, logger?: any) {
  logger?.info(
    { bioguideId, source: "congress.gov" },
    "Fetching federal member from Congress.gov",
  );
  const data = await congressFetch(`/member/${bioguideId}`, {}, logger);
  const m = data.member ?? {};
  const mapped = normalizeMemberFromRaw(m);

  await db
    .insert(federalMembersTable)
    .values({
      bioguideId: mapped.bioguideId || bioguideId,
      name: mapped.name,
      party: mapped.party ?? null,
      state: mapped.state ?? null,
      chamber: mapped.chamber ?? null,
      district: mapped.district ?? null,
      phone: mapped.phone ?? null,
      website: mapped.website ?? null,
      photoUrl: m.depiction?.imageUrl ?? null,
      terms: mapped.terms != null ? Number(mapped.terms) : null,
      inOffice: mapped.inOffice ?? null,
      nextElection: mapped.nextElection ?? null,
      raw: m,
      fetchedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: federalMembersTable.bioguideId,
      set: {
        name: mapped.name,
        party: mapped.party ?? null,
        state: mapped.state ?? null,
        chamber: mapped.chamber ?? null,
        district: mapped.district ?? null,
        phone: mapped.phone ?? null,
        website: mapped.website ?? null,
        photoUrl: m.depiction?.imageUrl ?? null,
        terms: mapped.terms != null ? Number(mapped.terms) : null,
        inOffice: mapped.inOffice ?? null,
        nextElection: mapped.nextElection ?? null,
        raw: m,
        fetchedAt: new Date(),
      },
    });

  // Ingest committee assignments from official XML sources
  try {
    const chamber = mapped.chamber?.toLowerCase() ?? "";
    let assignments: Array<{ code: string; name: string }> = [];

    if (chamber.includes("house")) {
      const houseMap = await fetchHouseCommitteesFromClerkXml();
      const codes = houseMap.get(mapped.bioguideId || bioguideId) ?? [];
      assignments = codes.map((code) => ({
        code,
        name: HOUSE_COMMITTEE_NAMES[code] ?? `Committee ${code}`,
      }));
    } else if (chamber.includes("senate")) {
      assignments = await fetchSenateCommitteesFromXml(
        mapped.bioguideId || bioguideId,
      );
    }

    // Upsert committees and member assignments within a transaction
    await db.transaction(async (tx) => {
      for (const a of assignments) {
        await tx
          .insert(federalCommitteesTable)
          .values({
            id: a.code,
            name: a.name,
            chamber: mapped.chamber ?? null,
            fetchedAt: new Date(),
          })
          .onConflictDoUpdate({
            target: federalCommitteesTable.id,
            set: {
              name: a.name,
              chamber: mapped.chamber ?? null,
              fetchedAt: new Date(),
            },
          });
        await tx
          .insert(federalMemberCommitteesTable)
          .values({
            bioguideId: mapped.bioguideId || bioguideId,
            committeeId: a.code,
            fetchedAt: new Date(),
          })
          .onConflictDoUpdate({
            target: [
              federalMemberCommitteesTable.bioguideId,
              federalMemberCommitteesTable.committeeId,
            ],
            set: { fetchedAt: new Date() },
          });
      }

      // Mark committee data as fetched even if empty (prevents repeated XML fetches)
      await tx
        .update(federalMembersTable)
        .set({ committeeFetchedAt: new Date() })
        .where(
          eq(federalMembersTable.bioguideId, mapped.bioguideId || bioguideId),
        );
    });
  } catch (err) {
    logger?.warn(
      { err, bioguideId },
      "Failed to ingest committee assignments from XML",
    );
  }

  return mapped;
}

// Proxy congress.gov member photos with a 1-year immutable cache so the
// browser caches them indefinitely instead of re-fetching every 2 days.
router.get("/federal/member-photo/:bioguideId", async (req, res) => {
  const { bioguideId } = req.params;
  try {
    const [row] = await db
      .select({ photoUrl: federalMembersTable.photoUrl })
      .from(federalMembersTable)
      .where(eq(federalMembersTable.bioguideId, bioguideId));

    if (!row?.photoUrl) { res.status(404).end(); return; }

    const cached = await getCachedPhoto(row.photoUrl, bioguideId);
    if (cached) {
      res
        .set("Content-Type", cached.contentType)
        .set("Cache-Control", "public, max-age=31536000, immutable")
        .set("Content-Length", String(cached.buffer.length))
        .send(cached.buffer);
      return;
    }

    const upstream = await fetch(row.photoUrl);
    if (!upstream.ok) { res.status(502).end(); return; }

    const contentType = upstream.headers.get("content-type") ?? "image/jpeg";
    const buffer = Buffer.from(await upstream.arrayBuffer());

    await setCachedPhoto(row.photoUrl, bioguideId, buffer, contentType);

    res
      .set("Content-Type", contentType)
      .set("Cache-Control", "public, max-age=31536000, immutable")
      .set("Content-Length", String(buffer.length))
      .send(buffer);
  } catch (err) {
    sendInternalError(res, "Photo unavailable");
  }
});

router.get("/federal/state-members", async (req, res) => {
  const parsed = GetFederalStateMembersQueryParams.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: "Invalid params" });

  const { state } = parsed.data;
  const stateUpper = state.toUpperCase();

  try {
    // DB-first: serve from federal_members populated by weekly ingestion
    const rows = await db
      .select()
      .from(federalMembersTable)
      .where(
        and(
          eq(federalMembersTable.state, stateUpper),
          eq(federalMembersTable.inOffice, true),
        ),
      );

    let mapped: any[];

    if (rows.length > 0) {
      mapped = rows.map((row) => {
        const isSenate = row.chamber === "Senate";
        return {
          name: row.name,
          office: isSenate
            ? `U.S. Senator for ${stateUpper}`
            : `U.S. Representative, ${stateUpper}-${row.district ?? ""}`,
          party: row.party ?? undefined,
          photoUrl: memberPhotoUrl(row.bioguideId, !!row.photoUrl),
          level: "federal" as const,
          chamber: row.chamber ?? undefined,
          bioguideId: row.bioguideId,
          district: row.district ?? undefined,
        };
      });
    } else {
      // Fallback to Congress.gov if ingestion hasn't populated the DB yet
      const url = new URL(`${BASE}/member/${stateUpper}`);
      url.searchParams.set("api_key", CONGRESS_API_KEY!);
      url.searchParams.set("format", "json");
      url.searchParams.set("currentMember", "true");
      url.searchParams.set("limit", "250");

      const response = await fetch(url.toString());
      if (!response.ok) {
        const text = await response.text();
        throw new Error(`Congress API error ${response.status}: ${text}`);
      }
      const data = (await response.json()) as any;

      mapped = (data.members ?? [])
        .filter((m: any) => normalizeTermsItem(m).some((t: any) => !t.endYear))
        .map((m: any) => {
          const latestTerm = normalizeTermsItem(m).slice(-1)[0];
          const isSenate = latestTerm?.chamber === "Senate";
          return {
            name: formatCongressName(m.name),
            office: isSenate
              ? `U.S. Senator for ${stateUpper}`
              : `U.S. Representative, ${stateUpper}-${m.district ?? ""}`,
            party: m.partyName,
            photoUrl: memberPhotoUrl(m.bioguideId, !!m.depiction?.imageUrl),
            level: "federal" as const,
            chamber: isSenate ? "Senate" : "House",
            bioguideId: m.bioguideId,
            district: m.district ? String(m.district) : undefined,
          };
        });
    }

    // Sort: senators first, then representatives, then last name ascending
    mapped.sort((a: any, b: any) => {
      const aIsSenate = a.chamber === "Senate" ? 0 : 1;
      const bIsSenate = b.chamber === "Senate" ? 0 : 1;
      if (aIsSenate !== bIsSenate) return aIsSenate - bIsSenate;
      return getLastName(a.name).localeCompare(getLastName(b.name));
    });

    return res.json({
      stateCode: stateUpper,
      stateName: stateUpper,
      representatives: mapped,
    });
  } catch (err) {
    if (isProviderRateLimitError(err)) return sendProviderRateLimitError(res, err);
    req.log.error({ err }, "Error fetching federal state members");
    return sendInternalError(res);
  }
});

router.get("/federal/members/search", async (req, res) => {
  const parsed = SearchFederalMembersQueryParams.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid query parameters" });
  }
  const { q, limit: rawLimit, offset } = parsed.data;
  const limit = Math.min(rawLimit, 100);

  try {
    req.log.info(
      { q, source: "db" },
      "Searching federal members from DB cache",
    );
    const searchPattern = `%${q}%`;

    const rows = await db
      .select()
      .from(federalMembersTable)
      .where(
        or(
          sql`${federalMembersTable.name} ILIKE ${searchPattern}`,
          sql`${federalMembersTable.state} ILIKE ${searchPattern}`,
          sql`${federalMembersTable.party} ILIKE ${searchPattern}`,
        ),
      )
      .limit(limit)
      .offset(offset);

    const countResult = await db
      .select({ count: sql<number>`count(*)` })
      .from(federalMembersTable)
      .where(
        or(
          sql`${federalMembersTable.name} ILIKE ${searchPattern}`,
          sql`${federalMembersTable.state} ILIKE ${searchPattern}`,
          sql`${federalMembersTable.party} ILIKE ${searchPattern}`,
        ),
      );

    const totalCount = Number(countResult[0]?.count ?? 0);
    const members = rows.map(mapDbRowToMember);

    return res.json({ members, totalCount, offset });
  } catch (err) {
    if (isProviderRateLimitError(err)) return sendProviderRateLimitError(res, err);
    req.log.error({ err }, "Error searching federal members");
    return sendInternalError(res);
  }
});

router.get("/federal/members/:bioguideId", async (req, res) => {
  const parsed = GetFederalMemberParams.safeParse(req.params);
  if (!parsed.success) return res.status(400).json({ error: "Invalid params" });

  const bioguideId = parsed.data.bioguideId;

  try {
    const rows = await db
      .select()
      .from(federalMembersTable)
      .where(eq(federalMembersTable.bioguideId, bioguideId))
      .limit(1);
    const cached = rows[0];

    if (cached) {
      const stale = isStale(cached);
      if (!stale) {
        req.log.info(
          { bioguideId, source: "db" },
          "Serving federal member from cache",
        );
        return res.json({
          member: mapDbRowToMember(cached),
          cache: {
            source: "db",
            stale: false,
            fetchedAt: cached.fetchedAt.toISOString(),
          },
        });
      }
      // Stale cache — try to refresh
      try {
        req.log.info(
          { bioguideId, source: "congress.gov" },
          "Refreshing stale federal member from Congress.gov",
        );
        const fresh = await fetchAndCacheFederalMember(bioguideId, req.log);
        return res.json({
          member: fresh,
          cache: {
            source: "congress.gov",
            stale: false,
            fetchedAt: new Date().toISOString(),
          },
        });
      } catch (err) {
        req.log.warn(
          { err, bioguideId, source: "db" },
          "Failed to refresh stale federal member; returning cached data",
        );
        return res.json({
          member: mapDbRowToMember(cached),
          cache: {
            source: "db",
            stale: true,
            fetchedAt: cached.fetchedAt.toISOString(),
            refreshFailed: true,
          },
        });
      }
    }

    // Cache miss
    req.log.info(
      { bioguideId, source: "congress.gov" },
      "Cache miss; fetching federal member from Congress.gov",
    );
    const fresh = await fetchAndCacheFederalMember(bioguideId, req.log);
    return res.json({
      member: fresh,
      cache: {
        source: "congress.gov",
        stale: false,
        fetchedAt: new Date().toISOString(),
      },
    });
  } catch (err) {
    if (isProviderRateLimitError(err)) return sendProviderRateLimitError(res, err);
    req.log.error({ err }, "Error fetching federal member");
    return sendInternalError(res);
  }
});

router.post("/federal/members/:bioguideId/refresh", async (req, res) => {
  const parsed = GetFederalMemberParams.safeParse(req.params);
  if (!parsed.success) return res.status(400).json({ error: "Invalid params" });

  const bioguideId = parsed.data.bioguideId;

  try {
    req.log.info(
      { bioguideId, source: "congress.gov" },
      "Force refreshing federal member from Congress.gov",
    );
    const fresh = await fetchAndCacheFederalMember(bioguideId, req.log);
    return res.json({
      member: fresh,
      cache: {
        source: "congress.gov",
        stale: false,
        fetchedAt: new Date().toISOString(),
      },
    });
  } catch (err) {
    // On failure, return cached data if available
    const rows = await db
      .select()
      .from(federalMembersTable)
      .where(eq(federalMembersTable.bioguideId, bioguideId))
      .limit(1);
    const cached = rows[0];
    if (cached) {
      req.log.warn(
        { err, bioguideId, source: "db" },
        "Refresh failed; returning cached federal member",
      );
      return res.json({
        member: mapDbRowToMember(cached),
        cache: {
          source: "db",
          stale: isStale(cached),
          fetchedAt: cached.fetchedAt.toISOString(),
          refreshFailed: true,
        },
      });
    }
    if (isProviderRateLimitError(err)) return sendProviderRateLimitError(res, err);
    req.log.error({ err }, "Error refreshing federal member");
    return sendInternalError(res);
  }
});

function getCurrentCongress() {
  return getCurrentCongressNumber();
}

const activeBillIngestions = new Set<string>();

async function withPageRetry<T>(
  fn: () => Promise<T>,
  maxAttempts = 3,
  baseDelayMs = 2000,
): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt < maxAttempts) {
        await new Promise((r) => setTimeout(r, baseDelayMs * attempt));
      }
    }
  }
  throw lastErr;
}

async function ingestFederalMemberBillsPage(
  bioguideId: string,
  role: "sponsor" | "cosponsor",
  page: number,
  logger?: any,
): Promise<{ inserted: number; totalExpected: number; billItems: any[] }> {
  const endpoint =
    role === "sponsor" ? "sponsored-legislation" : "cosponsored-legislation";
  const key =
    role === "sponsor" ? "sponsoredLegislation" : "cosponsoredLegislation";

  logger?.info(
    { bioguideId, role, page, source: "congress.gov" },
    "Ingesting member bills page from Congress.gov",
  );
  const data = await congressFetch(
    `/member/${bioguideId}/${endpoint}`,
    { offset: (page - 1) * 250, limit: 250 },
    logger,
  );
  const allItems: any[] = data[key] ?? data.bills ?? [];

  // Keep the legacy bill tables populated for existing bill detail/search flows,
  // but cache every Congress.gov member-legislation record for profile pages.
  const currentCongress = getCurrentCongress();
  const allBillIds = allItems.map((b) => getFederalLegislationItemId(b));
  const deadPreviousCongressIds = new Set(
    (
      await db
        .select({ id: federalBillsTable.id })
        .from(federalBillsTable)
        .where(
          and(
            inArray(federalBillsTable.id, allBillIds),
            eq(federalBillsTable.stageDead, true),
            lt(federalBillsTable.congress, currentCongress),
          ),
        )
    ).map((r) => r.id),
  );

  await Promise.all(
    allItems.map(async (b) => {
      const billId = getFederalLegislationItemId(b);
      const displayNumber = getFederalLegislationDisplayNumber(b);
      const title = getFederalLegislationTitle(b);
      const latestActionText = b.latestAction?.text ?? null;
      const latestActionDate = b.latestAction?.actionDate ?? null;
      const stageFlags = finalizeFederalStageFlags(
        computeLegislationStageFlags({
          latestAction: latestActionText,
          introducedDate: b.introducedDate ?? null,
        }),
        b.congress != null ? Number(b.congress) : null,
        currentCongress,
      );
      const billCongress = b.congress != null ? Number(b.congress) : null;
      const subjects =
        b.subjects?.item ?? (Array.isArray(b.subjects) ? b.subjects : []);

      if (deadPreviousCongressIds.has(billId)) {
        // Bill is already correctly marked dead from a finished congress — immutable, skip upsert.
        // Still record the member's role so the legislation list stays complete.
        await db
          .insert(federalMemberBillRolesTable)
          .values({
            bioguideId,
            billId,
            congress: billCongress,
            role,
            fetchedAt: new Date(),
          })
          .onConflictDoNothing();
        return;
      }

      await upsertFederalBill({
        id: billId,
        title,
        type: b.type ?? null,
        number: displayNumber ?? null,
        amendmentNumber: b.amendmentNumber != null ? String(b.amendmentNumber) : null,
        congress: billCongress,
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

      await db
        .insert(federalMemberBillRolesTable)
        .values({
          bioguideId,
          billId,
          congress: billCongress,
          role,
          fetchedAt: new Date(),
        })
        .onConflictDoNothing();
    }),
  );

  const totalExpected = data.pagination?.count ?? 0;
  return { inserted: allItems.length, totalExpected, billItems: allItems };
}

async function ingestFederalMemberBills(
  bioguideId: string,
  role: "sponsor" | "cosponsor",
  logger?: any,
  opts?: { startPage?: number; skipCacheWrite?: boolean },
) {
  const jobKey = `${bioguideId}:${role}`;
  if (activeBillIngestions.has(jobKey)) {
    logger?.info(
      { bioguideId, role },
      "Bill ingestion already in progress; skipping duplicate",
    );
    return;
  }
  activeBillIngestions.add(jobKey);

  try {
    const currentCongress = getCurrentCongress();
    let page = opts?.startPage ?? 1;
    let hasMore = true;
    let totalIngested = 0;
    let sourceTotalCount = 0;
    const MAX_PAGES = 200;

    while (hasMore && page <= MAX_PAGES) {
      const { inserted, totalExpected } = await withPageRetry(() =>
        ingestFederalMemberBillsPage(bioguideId, role, page, logger),
      );
      totalIngested += inserted;
      sourceTotalCount = totalExpected;

      if (inserted === 0) {
        hasMore = false;
        break;
      }

      hasMore = totalIngested < totalExpected && inserted >= 250;
      page++;
    }

    const localCountResult = await db
      .select({ count: sql<number>`count(*)` })
      .from(federalMemberBillRolesTable)
      .where(
        and(
          eq(federalMemberBillRolesTable.bioguideId, bioguideId),
          eq(federalMemberBillRolesTable.role, role),
        ),
      );
    const localCount = Number(localCountResult[0]?.count ?? 0);
    const sourceRecordsScanned =
      ((opts?.startPage ?? 1) - 1) * 250 + totalIngested;
    const fullyIngested =
      sourceTotalCount === 0 || sourceRecordsScanned >= sourceTotalCount;

    logger?.info(
      {
        bioguideId,
        role,
        totalIngested,
        localCount,
        sourceRecordsScanned,
        sourceTotalCount,
        source: "db",
      },
      "Member bill background ingestion complete",
    );

    if (!opts?.skipCacheWrite) {
      await db
        .insert(federalMemberBillCacheStatusTable)
        .values({
          bioguideId,
          role,
          congress: currentCongress,
          fullyIngested,
          localCount,
          sourceTotalCount,
          lastFetchedAt: new Date(),
          lastFullSyncAt: fullyIngested ? new Date() : null,
        })
        .onConflictDoUpdate({
          target: [
            federalMemberBillCacheStatusTable.bioguideId,
            federalMemberBillCacheStatusTable.role,
            federalMemberBillCacheStatusTable.congress,
          ],
          set: {
            fullyIngested,
            localCount,
            sourceTotalCount,
            lastFetchedAt: new Date(),
            lastFullSyncAt: fullyIngested ? new Date() : null,
          },
        });
    }
  } finally {
    activeBillIngestions.delete(jobKey);
  }
}

router.get("/federal/members/:bioguideId/bills", async (req, res) => {
  const paramsParsed = GetFederalMemberBillsParams.safeParse(req.params);
  const queryParsed = GetFederalMemberBillsQueryParams.safeParse(req.query);
  if (!paramsParsed.success || !queryParsed.success)
    return res.status(400).json({ error: "Invalid params" });

  const { bioguideId } = paramsParsed.data;
  const { type, offset, limit, q, stages, policyArea } = queryParsed.data;
  const category = (
    typeof req.query.category === "string" ? req.query.category : "all"
  ) as FederalLegislationCategory;
  if (!["all", "bill", "resolution", "amendment", "other"].includes(category)) {
    return res.status(400).json({ error: "Invalid category" });
  }
  const role = type === "sponsored" ? "sponsor" : "cosponsor";
  const selectedStages = parseStageQuery(stages);

  try {
    // Skip ingestion for former members — serve cached data only
    const memberRow = await db
      .select({ inOffice: federalMembersTable.inOffice })
      .from(federalMembersTable)
      .where(eq(federalMembersTable.bioguideId, bioguideId))
      .limit(1);
    const memberInOffice = memberRow[0]?.inOffice;
    const skipIngestion = memberInOffice === false;

    // Build search condition if q is provided
    const searchCondition = q
      ? sql`(${federalBillsTable.searchVector} @@ websearch_to_tsquery('english', ${q}) OR ${q} % ${federalBillsTable.title})`
      : undefined;
    const categoryCondition =
      category && category !== "all"
        ? eq(federalBillsTable.category, category)
        : undefined;
    const stageCondition = buildFederalBillsStageCondition(selectedStages);
    const policyAreaCondition = policyArea
      ? eq(federalBillsTable.policyArea, policyArea)
      : undefined;

    const currentCongress = getCurrentCongress();

    // Both cache checks are independent — run them in parallel.
    const [cachedCountResult, cacheStatusRows] = await Promise.all([
      db
        .select({ count: sql<number>`count(*)` })
        .from(federalMemberBillRolesTable)
        .where(
          and(
            eq(federalMemberBillRolesTable.bioguideId, bioguideId),
            eq(federalMemberBillRolesTable.role, role),
          ),
        ),
      db
        .select()
        .from(federalMemberBillCacheStatusTable)
        .where(
          and(
            eq(federalMemberBillCacheStatusTable.bioguideId, bioguideId),
            eq(federalMemberBillCacheStatusTable.role, role),
            eq(federalMemberBillCacheStatusTable.congress, currentCongress),
          ),
        )
        .limit(1),
    ]);

    const cachedCount = Number(cachedCountResult[0]?.count ?? 0);
    const cacheStatus = cacheStatusRows[0];

    let bills: any[] = [];
    let totalCount = 0;
    // Former members can't introduce new legislation — treat whatever is cached as complete.
    let fullyIngested = skipIngestion ? true : (cacheStatus?.fullyIngested ?? false);
    let sourceTotalCount = cacheStatus?.sourceTotalCount ?? cachedCount;

    if (cachedCount === 0 && !skipIngestion) {
      // Cold start: fetch page 1 synchronously so the user gets immediate results,
      // then continue the rest in the background.
      req.log.info(
        { bioguideId, role, source: "congress.gov" },
        "No cached member bills; fetching first page synchronously",
      );
      const { inserted: firstPageCount, totalExpected } =
        await ingestFederalMemberBillsPage(bioguideId, role, 1, req.log);
      sourceTotalCount = totalExpected;

      if (firstPageCount > 0) {
        await db
          .insert(federalMemberBillCacheStatusTable)
          .values({
            bioguideId,
            role,
            congress: currentCongress,
            fullyIngested: firstPageCount >= totalExpected,
            localCount: firstPageCount,
            sourceTotalCount: totalExpected,
            lastFetchedAt: new Date(),
            lastHeadSyncAt: new Date(),
          })
          .onConflictDoUpdate({
            target: [
              federalMemberBillCacheStatusTable.bioguideId,
              federalMemberBillCacheStatusTable.role,
              federalMemberBillCacheStatusTable.congress,
            ],
            set: {
              fullyIngested: firstPageCount >= totalExpected,
              localCount: firstPageCount,
              sourceTotalCount: totalExpected,
              lastFetchedAt: new Date(),
              lastHeadSyncAt: new Date(),
            },
          });
      }

      fullyIngested = firstPageCount >= totalExpected;

      // Background ingestion for remaining pages (fire-and-forget), starting from page 2
      if (firstPageCount < totalExpected) {
        ingestFederalMemberBills(bioguideId, role, req.log, {
          startPage: 2,
        }).catch((err) => {
          req.log?.warn(
            { err, bioguideId, role },
            "Background bill ingestion failed",
          );
        });
      }
    } else {
      if (
        !skipIngestion &&
        shouldResumeMemberLegislationIngestion({
          cachedCount,
          cacheStatus,
          active: activeBillIngestions.has(`${bioguideId}:${role}`),
        })
      ) {
        // Partial cache exists and no background job is running — resume it.
        req.log.info(
          { bioguideId, role, cachedCount, source: "db" },
          "Partial member bills cache; resuming background ingestion",
        );
        ingestFederalMemberBills(bioguideId, role, req.log).catch((err) => {
          req.log?.warn(
            { err, bioguideId, role },
            "Background bill ingestion failed",
          );
        });
      } else {
        req.log.info(
          { bioguideId, role, cachedCount, source: "db" },
          "Serving member bills from cache",
        );
      }
    }

    const memberConditions = [
      eq(federalMemberBillRolesTable.bioguideId, bioguideId),
      eq(federalMemberBillRolesTable.role, role),
    ];
    const filterConditions = [
      ...memberConditions,
      ...(categoryCondition ? [categoryCondition] : []),
      ...(stageCondition ? [stageCondition] : []),
      ...(searchCondition ? [searchCondition] : []),
      ...(policyAreaCondition ? [policyAreaCondition] : []),
    ];
    const joinClause = eq(federalMemberBillRolesTable.billId, federalBillsTable.id);

    // All five reads are independent — run them in parallel.
    const [rows, totalResult, policyAreaRows, categoryCountRows, stageRows] =
      await Promise.all([
        db
          .select({
            id: federalBillsTable.id,
            title: federalBillsTable.title,
            number: federalBillsTable.number,
            congress: federalBillsTable.congress,
            introducedDate: federalBillsTable.introducedDate,
            latestAction: federalBillsTable.latestAction,
            latestActionDate: federalBillsTable.latestActionDate,
            stageIntroduced: federalBillsTable.stageIntroduced,
            stageCommittee: federalBillsTable.stageCommittee,
            stageFloorVote: federalBillsTable.stageFloorVote,
            stagePassed: federalBillsTable.stagePassed,
            stageSignedEnacted: federalBillsTable.stageSignedEnacted,
            stageDead: federalBillsTable.stageDead,
            policyArea: federalBillsTable.policyArea,
            url: federalBillsTable.url,
            category: federalBillsTable.category,
            type: federalBillsTable.type,
          })
          .from(federalMemberBillRolesTable)
          .innerJoin(federalBillsTable, joinClause)
          .where(and(...filterConditions))
          .orderBy(
            ...(q
              ? [sql`GREATEST(ts_rank(${federalBillsTable.searchVector}, websearch_to_tsquery('english', ${q})), similarity(${q}, ${federalBillsTable.title})) desc`]
              : [desc(federalBillsTable.introducedDate), asc(federalBillsTable.id)]),
          )
          .limit(limit)
          .offset(offset),

        db
          .select({ count: sql<number>`count(*)` })
          .from(federalMemberBillRolesTable)
          .innerJoin(federalBillsTable, joinClause)
          .where(and(...filterConditions)),

        db
          .select({
            name: federalBillsTable.policyArea,
            count: sql<number>`count(*)`,
          })
          .from(federalMemberBillRolesTable)
          .innerJoin(federalBillsTable, joinClause)
          .where(
            and(
              ...memberConditions,
              sql`${federalBillsTable.policyArea} is not null`,
              ...(categoryCondition ? [categoryCondition] : []),
              ...(stageCondition ? [stageCondition] : []),
              ...(searchCondition ? [searchCondition] : []),
            ),
          )
          .groupBy(federalBillsTable.policyArea)
          .orderBy(sql`count(*) desc`),

        db
          .select({
            category: federalBillsTable.category,
            count: sql<number>`count(*)`,
          })
          .from(federalMemberBillRolesTable)
          .innerJoin(federalBillsTable, joinClause)
          .where(
            and(
              ...memberConditions,
              ...(stageCondition ? [stageCondition] : []),
              ...(searchCondition ? [searchCondition] : []),
              ...(policyAreaCondition ? [policyAreaCondition] : []),
            ),
          )
          .groupBy(federalBillsTable.category),

        db
          .select({
            category: federalBillsTable.category,
            introduced: sql<number>`sum(case when ${federalBillsTable.stageIntroduced} then 1 else 0 end)`,
            committee: sql<number>`sum(case when ${federalBillsTable.stageCommittee} then 1 else 0 end)`,
            floorVote: sql<number>`sum(case when ${federalBillsTable.stageFloorVote} then 1 else 0 end)`,
            passed: sql<number>`sum(case when ${federalBillsTable.stagePassed} then 1 else 0 end)`,
            signedEnacted: sql<number>`sum(case when ${federalBillsTable.stageSignedEnacted} then 1 else 0 end)`,
            dead: sql<number>`sum(case when ${federalBillsTable.stageDead} then 1 else 0 end)`,
          })
          .from(federalMemberBillRolesTable)
          .innerJoin(federalBillsTable, joinClause)
          .where(
            and(
              ...memberConditions,
              ...(categoryCondition ? [categoryCondition] : []),
              ...(searchCondition ? [searchCondition] : []),
            ),
          )
          .groupBy(federalBillsTable.category),
      ]);

    totalCount = Number(totalResult[0]?.count ?? 0);
    bills = rows.map(mapFederalLegislationForResponse);

    const policyAreas = computePolicyAreas(policyAreaRows);
    const categoryCounts: Record<string, number> = {
      all: 0,
      bill: 0,
      resolution: 0,
      amendment: 0,
      other: 0,
    };
    for (const row of categoryCountRows) {
      categoryCounts[row.category ?? "other"] = Number(row.count);
    }
    categoryCounts.all = Object.values(categoryCounts).reduce(
      (sum, count) => sum + count,
      0,
    );
    const emptyCategoryCounts = () => ({
      all: 0,
      bill: 0,
      resolution: 0,
      amendment: 0,
      other: 0,
    });
    const stageCounts: Record<string, ReturnType<typeof emptyCategoryCounts>> =
      Object.fromEntries(
        LEGISLATION_STAGE_KEYS.map((stage) => [stage, emptyCategoryCounts()]),
      );
    for (const row of stageRows) {
      const categoryKey =
        row.category === "bill" ||
        row.category === "resolution" ||
        row.category === "amendment"
          ? row.category
          : "other";
      const values: Record<LegislationStageKey, number> = {
        introduced: Number(row.introduced ?? 0),
        committee: Number(row.committee ?? 0),
        floor_vote: Number(row.floorVote ?? 0),
        passed: Number(row.passed ?? 0),
        signed_enacted: Number(row.signedEnacted ?? 0),
        dead: Number(row.dead ?? 0),
      };
      for (const stage of LEGISLATION_STAGE_KEYS) {
        stageCounts[stage][categoryKey] += values[stage];
        stageCounts[stage].all += values[stage];
      }
    }

    return res.json({
      bills,
      totalCount,
      offset,
      policyAreas,
      fullyIngested,
      sourceTotalCount,
      category,
      categoryCounts,
      stageCounts,
    });
  } catch (err) {
    if (isProviderRateLimitError(err)) return sendProviderRateLimitError(res, err);
    req.log.error({ err }, "Error fetching member bills");
    return sendInternalError(res);
  }
});

router.post("/federal/members/:bioguideId/bills/refresh", async (req, res) => {
  const paramsParsed = GetFederalMemberBillsParams.safeParse(req.params);
  const body = req.body;
  if (!paramsParsed.success)
    return res.status(400).json({ error: "Invalid params" });

  const { bioguideId } = paramsParsed.data;
  const type = body?.type === "cosponsored" ? "cosponsored" : "sponsored";
  const role = type === "sponsored" ? "sponsor" : "cosponsor";

  try {
    req.log.info(
      { bioguideId, role, source: "congress.gov" },
      "Force refreshing member bills from Congress.gov",
    );
    await ingestFederalMemberBills(bioguideId, role, req.log);

    // Fetch first page from DB for immediate response
    const refreshJoin = eq(federalMemberBillRolesTable.billId, federalBillsTable.id);
    const refreshMemberCond = [
      eq(federalMemberBillRolesTable.bioguideId, bioguideId),
      eq(federalMemberBillRolesTable.role, role),
    ];

    const [rows, totalResult, policyAreaRows, categoryCountRows] = await Promise.all([
      db
        .select({
          id: federalBillsTable.id,
          title: federalBillsTable.title,
          number: federalBillsTable.number,
          congress: federalBillsTable.congress,
          introducedDate: federalBillsTable.introducedDate,
          latestAction: federalBillsTable.latestAction,
          latestActionDate: federalBillsTable.latestActionDate,
          stageIntroduced: federalBillsTable.stageIntroduced,
          stageCommittee: federalBillsTable.stageCommittee,
          stageFloorVote: federalBillsTable.stageFloorVote,
          stagePassed: federalBillsTable.stagePassed,
          stageSignedEnacted: federalBillsTable.stageSignedEnacted,
          stageDead: federalBillsTable.stageDead,
          policyArea: federalBillsTable.policyArea,
          url: federalBillsTable.url,
          category: federalBillsTable.category,
          type: federalBillsTable.type,
        })
        .from(federalMemberBillRolesTable)
        .innerJoin(federalBillsTable, refreshJoin)
        .where(and(...refreshMemberCond))
        .orderBy(desc(federalBillsTable.introducedDate), asc(federalBillsTable.id))
        .limit(20)
        .offset(0),

      db
        .select({ count: sql<number>`count(*)` })
        .from(federalMemberBillRolesTable)
        .innerJoin(federalBillsTable, refreshJoin)
        .where(and(...refreshMemberCond)),

      db
        .select({ name: federalBillsTable.policyArea, count: sql<number>`count(*)` })
        .from(federalMemberBillRolesTable)
        .innerJoin(federalBillsTable, refreshJoin)
        .where(and(...refreshMemberCond, sql`${federalBillsTable.policyArea} is not null`))
        .groupBy(federalBillsTable.policyArea)
        .orderBy(sql`count(*) desc`),

      db
        .select({ category: federalBillsTable.category, count: sql<number>`count(*)` })
        .from(federalMemberBillRolesTable)
        .innerJoin(federalBillsTable, refreshJoin)
        .where(and(...refreshMemberCond))
        .groupBy(federalBillsTable.category),
    ]);

    const totalCount = Number(totalResult[0]?.count ?? 0);
    const policyAreas = computePolicyAreas(policyAreaRows);
    const categoryCounts: Record<string, number> = { all: 0, bill: 0, resolution: 0, amendment: 0, other: 0 };
    for (const row of categoryCountRows) {
      categoryCounts[row.category ?? "other"] = Number(row.count);
    }
    categoryCounts.all = Object.values(categoryCounts).reduce((s, c) => s + c, 0);

    const bills = rows.map(mapFederalLegislationForResponse);
    const statusRows = await db
      .select()
      .from(federalMemberBillCacheStatusTable)
      .where(
        and(
          eq(federalMemberBillCacheStatusTable.bioguideId, bioguideId),
          eq(federalMemberBillCacheStatusTable.role, role),
          eq(federalMemberBillCacheStatusTable.congress, getCurrentCongress()),
        ),
      )
      .limit(1);
    const status = statusRows[0];

    return res.json({
      bills,
      totalCount,
      offset: 0,
      policyAreas,
      fullyIngested: true,
      sourceTotalCount: status?.sourceTotalCount ?? totalCount,
      category: "all",
      categoryCounts,
      refreshed: true,
    });
  } catch (err) {
    if (isProviderRateLimitError(err)) return sendProviderRateLimitError(res, err);
    req.log.error({ err }, "Error refreshing member bills");
    return sendInternalError(res);
  }
});

function parseClerkVoteXml(xml: string) {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
  });
  const obj = parser.parse(xml);
  const meta = obj["rollcall-vote"]["vote-metadata"];
  const data = obj["rollcall-vote"]["vote-data"]["recorded-vote"] ?? [];
  const memberVotes = (Array.isArray(data) ? data : [data]).map((rv: any) => ({
    bioguideId: rv.legislator["@_name-id"],
    name: rv.legislator["#text"] || rv.legislator,
    party: rv.legislator["@_party"],
    state: rv.legislator["@_state"],
    voteCast: normalizeVoteCast(rv.vote),
  }));
  return {
    metadata: {
      legisNum: meta["legis-num"],
      voteQuestion: meta["vote-question"],
      voteResult: meta["vote-result"],
      voteDescription: meta["vote-desc"],
      actionDate: meta["action-date"],
      actionTime: meta["action-time"]?.["@_time-etz"],
    },
    memberVotes,
  };
}

async function discoverAndIngestVotes(congress: number, session: number) {
  const url = new URL(`${BASE}/house-vote/${congress}/${session}`);
  url.searchParams.set("api_key", CONGRESS_API_KEY!);
  url.searchParams.set("format", "json");
  url.searchParams.set("limit", "250");

  const res = await fetch(url.toString());
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Congress API error ${res.status}: ${text}`);
  }
  const data = (await res.json()) as any;
  const votes: any[] = data.houseRollCallVotes ?? [];

  // Batch process in chunks of 5 to avoid overwhelming Clerk server
  const chunkSize = 5;
  for (let i = 0; i < votes.length; i += chunkSize) {
    const chunk = votes.slice(i, i + chunkSize);
    await Promise.all(
      chunk.map(async (vote: any) => {
        const existing = await db
          .select({ id: houseVotesTable.id })
          .from(houseVotesTable)
          .where(
            and(
              eq(houseVotesTable.congress, vote.congress),
              eq(houseVotesTable.session, vote.sessionNumber),
              eq(houseVotesTable.rollCallNumber, vote.rollCallNumber),
            ),
          )
          .limit(1);

        if (existing.length > 0) return; // Already ingested

        const xmlUrl = vote.sourceDataURL;
        if (!xmlUrl) return;

        try {
          const xmlRes = await fetch(xmlUrl);
          if (!xmlRes.ok) return;
          const xml = await xmlRes.text();
          const parsed = parseClerkVoteXml(xml);

          await db.transaction(async (tx) => {
            const [inserted] = await tx
              .insert(houseVotesTable)
              .values({
                congress: vote.congress,
                session: vote.sessionNumber,
                rollCallNumber: vote.rollCallNumber,
                year: new Date(vote.startDate).getFullYear(),
                voteDate: vote.startDate
                  ? new Date(vote.startDate).toISOString().split("T")[0]
                  : null,
                legislationType: vote.legislationType ?? null,
                legislationNumber: vote.legislationNumber ?? null,
                voteQuestion: parsed.metadata.voteQuestion ?? null,
                voteResult: parsed.metadata.voteResult ?? null,
                voteDescription: parsed.metadata.voteDescription ?? null,
                sourceDataUrl: xmlUrl,
              })
              .returning({ id: houseVotesTable.id });

            if (inserted && parsed.memberVotes.length > 0) {
              await tx.insert(houseVoteRecordsTable).values(
                parsed.memberVotes.map((m: any) => ({
                  voteId: inserted.id,
                  bioguideId: m.bioguideId,
                  memberName: m.name,
                  party: m.party ?? null,
                  state: m.state ?? null,
                  voteCast: normalizeVoteCast(m.voteCast),
                })),
              );
            }
          });
        } catch {
          // Ignore individual vote fetch/parse failures
        }
      }),
    );
  }
}

router.get("/federal/members/:bioguideId/house-votes", async (req, res) => {
  const paramsParsed = GetFederalMemberHouseVotesParams.safeParse(req.params);
  const queryParsed = GetFederalMemberHouseVotesQueryParams.safeParse(
    req.query,
  );
  if (!paramsParsed.success || !queryParsed.success)
    return res.status(400).json({ error: "Invalid params" });

  const { bioguideId } = paramsParsed.data;
  const { offset, limit, filter, q } = queryParsed.data;

  try {
    // Determine current congress/session for discovery
    const currentYear = new Date().getFullYear();
    const currentCongress = Math.floor((currentYear - 1789) / 2) + 1;
    const currentSession = currentYear % 2 === 1 ? 1 : 2;

    // Build text search condition
    const searchPattern = q ? `%${q}%` : undefined;
    const buildSearchCondition = () => {
      if (!searchPattern) return undefined;
      return or(
        sql`${houseVotesTable.voteQuestion} ILIKE ${searchPattern}`,
        sql`${houseVotesTable.voteDescription} ILIKE ${searchPattern}`,
        sql`${houseVotesTable.legislationType} ILIKE ${searchPattern}`,
        sql`${houseVotesTable.legislationNumber} ILIKE ${searchPattern}`,
      );
    };
    const searchCondition = buildSearchCondition();

    // Check how many total votes exist for this member
    const countResult = await db
      .select({ count: sql<number>`count(*)` })
      .from(houseVoteRecordsTable)
      .innerJoin(
        houseVotesTable,
        eq(houseVoteRecordsTable.voteId, houseVotesTable.id),
      )
      .where(
        and(
          eq(houseVoteRecordsTable.bioguideId, bioguideId),
          ...(searchCondition ? [searchCondition] : []),
        ),
      );

    const totalInDb = Number(countResult[0]?.count ?? 0);

    // If DB has fewer votes than requested, trigger discovery/ingestion
    if (totalInDb < offset + limit) {
      await discoverAndIngestVotes(currentCongress, currentSession);
      // Also try previous session if current session is early
      if (currentSession === 2) {
        await discoverAndIngestVotes(currentCongress, 1);
      }
    }

    // Build filter condition
    const filterConditions: any[] = [
      eq(houseVoteRecordsTable.bioguideId, bioguideId),
    ];
    if (filter === "yea")
      filterConditions.push(eq(houseVoteRecordsTable.voteCast, "Yea"));
    if (filter === "nay")
      filterConditions.push(eq(houseVoteRecordsTable.voteCast, "Nay"));
    if (filter === "present")
      filterConditions.push(eq(houseVoteRecordsTable.voteCast, "Present"));
    if (filter === "not-voting")
      filterConditions.push(eq(houseVoteRecordsTable.voteCast, "Not Voting"));
    if (searchCondition) filterConditions.push(searchCondition);

    // Fetch paginated votes
    const votes = await db
      .select({
        congress: houseVotesTable.congress,
        rollCallNumber: houseVotesTable.rollCallNumber,
        date: houseVotesTable.voteDate,
        legislationType: houseVotesTable.legislationType,
        legislationNumber: houseVotesTable.legislationNumber,
        voteQuestion: houseVotesTable.voteQuestion,
        voteDescription: houseVotesTable.voteDescription,
        voteResult: houseVotesTable.voteResult,
        voteCast: houseVoteRecordsTable.voteCast,
      })
      .from(houseVoteRecordsTable)
      .innerJoin(
        houseVotesTable,
        eq(houseVoteRecordsTable.voteId, houseVotesTable.id),
      )
      .where(and(...filterConditions))
      .orderBy(desc(houseVotesTable.voteDate), asc(houseVotesTable.id))
      .limit(limit)
      .offset(offset);

    // Get total count for pagination
    const totalCountResult = await db
      .select({ count: sql<number>`count(*)` })
      .from(houseVoteRecordsTable)
      .innerJoin(
        houseVotesTable,
        eq(houseVoteRecordsTable.voteId, houseVotesTable.id),
      )
      .where(and(...filterConditions));

    const totalCount = Number(totalCountResult[0]?.count ?? 0);

    const normalizedVotes = votes.map((v) => ({
      ...v,
      voteCast: normalizeVoteCast(v.voteCast),
    }));

    return res.json({ votes: normalizedVotes, totalCount, offset });
  } catch (err) {
    if (isProviderRateLimitError(err)) return sendProviderRateLimitError(res, err);
    req.log.error({ err }, "Error fetching house votes");
    return sendInternalError(res);
  }
});

async function resolveLisMemberId(bioguideId: string): Promise<string | null> {
  logger.info({ bioguideId }, "Resolving LIS member ID");
  const cached = await db
    .select({ lisId: federalMembersTable.lisId })
    .from(federalMembersTable)
    .where(eq(federalMembersTable.bioguideId, bioguideId))
    .limit(1);
  if (cached.length > 0 && cached[0].lisId) {
    logger.info({ bioguideId, lisId: cached[0].lisId }, "Found LIS mapping in cache");
    return cached[0].lisId;
  }

  try {
    const data = await congressFetch(`/member/${bioguideId}`);
    const m = data.member ?? {};
    const name = m.directOrderName ?? m.invertedOrderName ?? "";
    // Congress.gov returns full state name in m.state, but Senate XML uses 2-letter codes.
    // Prefer stateCode from the latest term if available.
    const latestTerm = normalizeTermsItem(m).slice(-1)[0] ?? {};
    const state = latestTerm.stateCode ?? m.state;
    if (name && state) {
      const lastName = name.split(" ").pop() ?? "";
      logger.info({ bioguideId, name, state, lastName }, "Searching vote positions for LIS mapping");
      const match = await db
        .selectDistinct({ lisMemberId: senatorVotePositionsTable.lisMemberId })
        .from(senatorVotePositionsTable)
        .where(
          and(
            eq(senatorVotePositionsTable.state, state),
            sql`${senatorVotePositionsTable.senatorName} ILIKE ${"%" + lastName + "%"}`,
          ),
        )
        .limit(1);
      if (match.length > 0) {
        await db
          .update(federalMembersTable)
          .set({ lisId: match[0].lisMemberId })
          .where(eq(federalMembersTable.bioguideId, bioguideId));
        logger.info({ bioguideId, lisId: match[0].lisMemberId }, "Stored LIS mapping");
        return match[0].lisMemberId;
      }
    }
  } catch (err) {
    logger.warn({ err, bioguideId }, "Error resolving LIS member ID");
  }
  logger.info({ bioguideId }, "No LIS mapping found");
  return null;
}

async function discoverSenateVotes(
  congress: number,
  session: number,
): Promise<number[]> {
  const url = `https://www.senate.gov/legislative/LIS/roll_call_lists/vote_menu_${congress}_${session}.htm`;
  logger.info({ url, congress, session }, "Discovering senate votes");
  const res = await fetch(url, { headers: { "User-Agent": "CivicHub/1.0" } });
  if (!res.ok) {
    logger.warn({ status: res.status, url }, "Failed to discover senate votes");
    return [];
  }
  const html = await res.text();

  const matches = html.matchAll(/vote_\d+_\d+_(\d{5})\.htm/g);
  const numbers = new Set<number>();
  for (const m of matches) {
    numbers.add(parseInt(m[1], 10));
  }
  const result = Array.from(numbers).sort((a, b) => b - a);
  logger.info({ count: result.length, congress, session }, "Discovered senate roll calls");
  return result;
}

function buildSenateVoteXmlUrl(
  congress: number,
  session: number,
  rollCall: number,
): string {
  const padded = String(rollCall).padStart(5, "0");
  return `https://www.senate.gov/legislative/LIS/roll_call_votes/vote${congress}${session}/vote_${congress}_${session}_${padded}.xml`;
}

function parseSenateVoteXml(xml: string): {
  metadata: any;
  memberVotes: Array<{
    lisMemberId: string;
    name: string;
    state: string;
    party: string;
    voteCast: string;
  }>;
} {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
  });
  const obj = parser.parse(xml);
  const vote = obj.roll_call_vote;

  const doc = vote.document ?? {};
  const members = vote.members?.member ?? [];
  const memberArray = Array.isArray(members) ? members : [members];

  return {
    metadata: {
      congress: Number(vote.congress),
      session: Number(vote.session),
      rollCallNumber: Number(vote.vote_number),
      voteDate: vote.vote_date
        ? new Date(vote.vote_date).toISOString().split("T")[0]
        : null,
      voteQuestion: vote.vote_question_text ?? vote.question ?? null,
      voteResult: vote.vote_result_text ?? vote.vote_result ?? null,
      majorityRequirement: vote.majority_requirement ?? null,
      voteTitle: vote.vote_title ?? null,
      documentType: doc.document_type ?? null,
      documentNumber: doc.document_number ?? null,
      documentTitle: doc.document_title ?? null,
      issue: vote.vote_document_text ?? null,
    },
    memberVotes: memberArray.map((m: any) => ({
      lisMemberId: m.lis_member_id,
      name: `${m.first_name} ${m.last_name}`,
      state: m.state,
      party: m.party,
      voteCast: normalizeVoteCast(m.vote_cast),
    })),
  };
}

async function ingestSenateVotes(congress: number, session: number) {
  logger.info({ congress, session }, "Starting senate vote ingestion");
  const rollCalls = await discoverSenateVotes(congress, session);
  logger.info({ count: rollCalls.length, congress, session }, "Processing senate roll calls");

  const chunkSize = 5;
  let ingestedCount = 0;
  for (let i = 0; i < rollCalls.length; i += chunkSize) {
    const chunk = rollCalls.slice(i, i + chunkSize);
    await Promise.all(
      chunk.map(async (rollCall) => {
        const existing = await db
          .select({ id: senateRollCallVotesTable.id })
          .from(senateRollCallVotesTable)
          .where(
            and(
              eq(senateRollCallVotesTable.congress, congress),
              eq(senateRollCallVotesTable.session, session),
              eq(senateRollCallVotesTable.rollCallNumber, rollCall),
            ),
          )
          .limit(1);
        if (existing.length > 0) return;

        try {
          const xmlUrl = buildSenateVoteXmlUrl(congress, session, rollCall);
          const res = await fetch(xmlUrl, {
            headers: { "User-Agent": "CivicHub/1.0" },
          });
          if (!res.ok) return;
          const xml = await res.text();
          const parsed = parseSenateVoteXml(xml);

          await db.transaction(async (tx) => {
            const [inserted] = await tx
              .insert(senateRollCallVotesTable)
              .values({
                ...parsed.metadata,
                sourceXmlUrl: xmlUrl,
                sourceHtmlUrl: xmlUrl.replace(".xml", ".htm"),
              })
              .returning({ id: senateRollCallVotesTable.id });

            if (inserted && parsed.memberVotes.length > 0) {
              await tx.insert(senatorVotePositionsTable).values(
                parsed.memberVotes.map((m) => ({
                  voteId: inserted.id,
                  lisMemberId: m.lisMemberId,
                  senatorName: m.name,
                  state: m.state ?? null,
                  party: m.party ?? null,
                  voteCast: normalizeVoteCast(m.voteCast),
                  bioguideId: null,
                })),
              );
              ingestedCount++;
              logger?.info(
                { rollCall, members: parsed.memberVotes.length, congress, session },
                "Ingested senate roll call",
              );
            }
          });
        } catch (err) {
          logger.warn({ err, rollCall, congress, session }, "Failed to ingest senate roll call");
        }
      }),
    );
  }
  logger.info({ ingestedCount, congress, session }, "Senate vote ingestion complete");
}

router.get("/federal/members/:bioguideId/senate-votes", async (req, res) => {
  req.log.info({ bioguideId: req.params.bioguideId, query: req.query }, "GET /federal/members/:bioguideId/senate-votes");
  const paramsParsed = GetFederalMemberSenateVotesParams.safeParse(req.params);
  const queryParsed = GetFederalMemberSenateVotesQueryParams.safeParse(
    req.query,
  );
  if (!paramsParsed.success || !queryParsed.success) {
    return res.status(400).json({ error: "Invalid params" });
  }

  const { bioguideId } = paramsParsed.data;
  const { offset, limit, filter, q } = queryParsed.data;

  try {
    const currentYear = new Date().getFullYear();
    const currentCongress = Math.floor((currentYear - 1789) / 2) + 1;
    const currentSession = currentYear % 2 === 1 ? 1 : 2;

    // Build text search condition
    const searchPattern = q ? `%${q}%` : undefined;
    const buildSearchCondition = () => {
      if (!searchPattern) return undefined;
      return or(
        sql`${senateRollCallVotesTable.voteQuestion} ILIKE ${searchPattern}`,
        sql`${senateRollCallVotesTable.voteTitle} ILIKE ${searchPattern}`,
        sql`${senateRollCallVotesTable.documentType} ILIKE ${searchPattern}`,
        sql`${senateRollCallVotesTable.documentNumber} ILIKE ${searchPattern}`,
      );
    };
    const searchCondition = buildSearchCondition();

    const lisMemberId = await resolveLisMemberId(bioguideId);
    req.log.info({ bioguideId, lisMemberId }, "Resolved LIS member ID for senate votes");

    const baseConditions: any[] = lisMemberId
      ? [eq(senatorVotePositionsTable.lisMemberId, lisMemberId)]
      : [];

    if (baseConditions.length === 0) {
      req.log.info({ bioguideId }, "No LIS mapping found, triggering senate vote ingestion");
      await ingestSenateVotes(currentCongress, currentSession);
      if (currentSession === 2) await ingestSenateVotes(currentCongress, 1);
      // Retry now that vote records exist for name matching
      const retryLisId = await resolveLisMemberId(bioguideId);
      req.log.info({ bioguideId, retryLisId }, "Retry resolved LIS member ID after ingestion");
      if (!retryLisId) {
        req.log.warn({ bioguideId }, "No LIS mapping after ingestion, returning empty votes");
        return res.json({ votes: [], totalCount: 0, offset });
      }
      baseConditions.push(
        eq(senatorVotePositionsTable.lisMemberId, retryLisId),
      );
    }

    const countResult = await db
      .select({ count: sql<number>`count(*)` })
      .from(senatorVotePositionsTable)
      .innerJoin(
        senateRollCallVotesTable,
        eq(senatorVotePositionsTable.voteId, senateRollCallVotesTable.id),
      )
      .where(
        and(...baseConditions, ...(searchCondition ? [searchCondition] : [])),
      );

    const totalInDb = Number(countResult[0]?.count ?? 0);
    req.log.info({ bioguideId, totalInDb }, "Total senate votes in DB for member");

    if (totalInDb < offset + limit) {
      req.log.info({ bioguideId, totalInDb, offset, limit }, "Not enough votes in DB, triggering more ingestion");
      await ingestSenateVotes(currentCongress, currentSession);
      if (currentSession === 2) await ingestSenateVotes(currentCongress, 1);
    }

    const filterConditions = [...baseConditions];
    if (filter === "yea")
      filterConditions.push(eq(senatorVotePositionsTable.voteCast, "Yea"));
    if (filter === "nay")
      filterConditions.push(eq(senatorVotePositionsTable.voteCast, "Nay"));
    if (filter === "present")
      filterConditions.push(eq(senatorVotePositionsTable.voteCast, "Present"));
    if (filter === "not-voting")
      filterConditions.push(
        inArray(senatorVotePositionsTable.voteCast, ["Not Voting", "Absent"]),
      );
    if (searchCondition) filterConditions.push(searchCondition);

    const votes = await db
      .select({
        congress: senateRollCallVotesTable.congress,
        rollCallNumber: senateRollCallVotesTable.rollCallNumber,
        date: senateRollCallVotesTable.voteDate,
        documentType: senateRollCallVotesTable.documentType,
        documentNumber: senateRollCallVotesTable.documentNumber,
        voteQuestion: senateRollCallVotesTable.voteQuestion,
        voteTitle: senateRollCallVotesTable.voteTitle,
        voteResult: senateRollCallVotesTable.voteResult,
        voteCast: senatorVotePositionsTable.voteCast,
      })
      .from(senatorVotePositionsTable)
      .innerJoin(
        senateRollCallVotesTable,
        eq(senatorVotePositionsTable.voteId, senateRollCallVotesTable.id),
      )
      .where(and(...filterConditions))
      .orderBy(desc(senateRollCallVotesTable.voteDate), asc(senateRollCallVotesTable.id))
      .limit(limit)
      .offset(offset);

    const normalized = votes.map((v) => ({
      ...v,
      voteCast: normalizeVoteCast(v.voteCast),
    }));

    const totalCountResult = await db
      .select({ count: sql<number>`count(*)` })
      .from(senatorVotePositionsTable)
      .innerJoin(
        senateRollCallVotesTable,
        eq(senatorVotePositionsTable.voteId, senateRollCallVotesTable.id),
      )
      .where(and(...filterConditions));

    const totalCount = Number(totalCountResult[0]?.count ?? 0);
    req.log.info({ count: normalized.length, totalCount }, "Senate votes query returning");

    return res.json({
      votes: normalized,
      totalCount,
      offset,
    });
  } catch (err) {
    if (isProviderRateLimitError(err)) return sendProviderRateLimitError(res, err);
    req.log.error({ err }, "Error fetching senate votes");
    return sendInternalError(res);
  }
});

router.get("/federal/members/:bioguideId/committees", async (req, res) => {
  const parsed = GetFederalMemberCommitteesParams.safeParse(req.params);
  if (!parsed.success) return res.status(400).json({ error: "Invalid params" });

  const { bioguideId } = parsed.data;

  try {
    // Option A: serve from DB cache (member profile only — no committee rosters)
    const cachedRows = await db
      .select({
        name: federalCommitteesTable.name,
        chamber: federalCommitteesTable.chamber,
        committeeCode: federalCommitteesTable.id,
      })
      .from(federalMemberCommitteesTable)
      .innerJoin(
        federalCommitteesTable,
        eq(federalMemberCommitteesTable.committeeId, federalCommitteesTable.id),
      )
      .where(eq(federalMemberCommitteesTable.bioguideId, bioguideId));

    if (cachedRows.length > 0) {
      req.log.info(
        { bioguideId, source: "db" },
        "Serving member committees from cache",
      );
      return res.json({
        committees: cachedRows.map((r) => ({
          name: r.name,
          chamber: r.chamber ?? undefined,
          committeeCode: r.committeeCode,
        })),
      });
    }

    // Check if we already fetched committees and found none (prevents repeated XML fetches)
    const memberRows = await db
      .select()
      .from(federalMembersTable)
      .where(eq(federalMembersTable.bioguideId, bioguideId))
      .limit(1);
    if (memberRows[0]?.committeeFetchedAt) {
      req.log.info(
        { bioguideId, source: "db" },
        "Committee data already fetched; no assignments found",
      );
      return res.json({ committees: [] });
    }

    // Cache miss: fetch from official XML sources
    req.log.info(
      { bioguideId, source: "house_clerk|senate" },
      "Cache miss; fetching member committees from official XML",
    );

    const chamber = memberRows[0]?.chamber?.toLowerCase() ?? "";
    let committees: Array<{
      name: string;
      chamber?: string;
      committeeCode: string;
    }> = [];

    if (chamber.includes("house")) {
      const houseMap = await fetchHouseCommitteesFromClerkXml();
      const codes = houseMap.get(bioguideId) ?? [];
      committees = codes.map((code) => ({
        name: HOUSE_COMMITTEE_NAMES[code] ?? `Committee ${code}`,
        chamber: memberRows[0]?.chamber ?? undefined,
        committeeCode: code,
      }));
    } else if (chamber.includes("senate")) {
      const senateAssignments = await fetchSenateCommitteesFromXml(bioguideId);
      committees = senateAssignments.map((a) => ({
        name: a.name,
        chamber: memberRows[0]?.chamber ?? undefined,
        committeeCode: a.code,
      }));
    }

    // Cache the results
    for (const c of committees) {
      await db
        .insert(federalCommitteesTable)
        .values({
          id: c.committeeCode,
          name: c.name,
          chamber: c.chamber ?? null,
          fetchedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: federalCommitteesTable.id,
          set: {
            name: c.name,
            chamber: c.chamber ?? null,
            fetchedAt: new Date(),
          },
        });
      await db
        .insert(federalMemberCommitteesTable)
        .values({
          bioguideId,
          committeeId: c.committeeCode,
          fetchedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: [
            federalMemberCommitteesTable.bioguideId,
            federalMemberCommitteesTable.committeeId,
          ],
          set: { fetchedAt: new Date() },
        });
    }

    // Mark that we've checked committees (even if empty, to prevent repeated fetches)
    await db
      .update(federalMembersTable)
      .set({ committeeFetchedAt: new Date() })
      .where(eq(federalMembersTable.bioguideId, bioguideId));

    // NOTE: Option B (full committee rosters with all members) is not implemented.
    // The current endpoint returns this member's assignments only. To add member
    // rosters, fetch committee member lists from official sources, cache in a
    // `federal_committee_members` table, and join here. That would require
    // storing rank/role per member and keeping rosters fresh when membership
    // changes.

    return res.json({ committees });
  } catch (err) {
    if (isProviderRateLimitError(err)) return sendProviderRateLimitError(res, err);
    req.log.error({ err }, "Error fetching member committees");
    return sendInternalError(res);
  }
});

router.get("/federal/bills", async (req, res) => {
  const parsed = GetFederalBillsQueryParams.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: "Invalid params" });

  const { chamber, policyArea, offset, limit, stages, q } = parsed.data;
  const selectedStages = parseStageQuery(stages);

  try {
    // Calculate current congress (1st Congress was 1789-1791)
    const currentYear = new Date().getFullYear();
    const currentCongress = Math.floor((currentYear - 1789) / 2) + 1;
    const chamberFilter =
      chamber && chamber !== "both"
        ? chamber.charAt(0).toUpperCase() + chamber.slice(1)
        : null;

    const stageCondition = buildFederalBillsStageCondition(selectedStages);
    const searchAllCongresses = !!q || !!policyArea;

    // DB-first: serve cached page if present for this congress/chamber.
    const dbConditions = buildFederalBillsDbConditions({
      q,
      chamberFilter,
      policyArea,
      stageCondition,
      currentCongress,
      searchAllCongresses,
    });
    const dbCountResult = await db
      .select({ count: sql<number>`count(*)` })
      .from(federalBillsTable)
      .where(and(...dbConditions));
    const dbTotalCount = Number(dbCountResult[0]?.count ?? 0);

    if (dbTotalCount > offset || searchAllCongresses || selectedStages.length > 0) {
      const rows = await db
        .select({
          id: federalBillsTable.id,
          title: federalBillsTable.title,
          number: federalBillsTable.number,
          congress: federalBillsTable.congress,
          introducedDate: federalBillsTable.introducedDate,
          latestAction: federalBillsTable.latestAction,
          latestActionDate: federalBillsTable.latestActionDate,
          stageIntroduced: federalBillsTable.stageIntroduced,
          stageCommittee: federalBillsTable.stageCommittee,
          stageFloorVote: federalBillsTable.stageFloorVote,
          stagePassed: federalBillsTable.stagePassed,
          stageSignedEnacted: federalBillsTable.stageSignedEnacted,
          stageDead: federalBillsTable.stageDead,
          chamber: federalBillsTable.chamber,
          policyArea: federalBillsTable.policyArea,
          subjects: federalBillsTable.subjects,
          url: federalBillsTable.url,
          category: federalBillsTable.category,
          type: federalBillsTable.type,
        })
        .from(federalBillsTable)
        .where(and(...dbConditions))
        .orderBy(desc(federalBillsTable.introducedDate), asc(federalBillsTable.id))
        .limit(limit)
        .offset(offset);

      const cachedBills = rows.map(mapFederalLegislationForResponse);

      req.log.info(
        {
          q,
          chamber,
          policyArea,
          stages,
          offset,
          limit,
          totalCount: dbTotalCount,
          source: "db",
        },
        "Serving federal bills from DB cache",
      );
      return res.json({ bills: cachedBills, totalCount: dbTotalCount, offset });
    }

    const params: Record<string, string | number> = {
      offset,
      limit,
      sort: "introducedDate desc",
    };
    if (chamberFilter) {
      params.chamber = chamberFilter;
    }

    const data = await congressFetch(
      `/bill/${currentCongress}`,
      params,
      req.log,
    );
    const bills = (data.bills ?? []).map((b: any) => {
      const billType = String(b.type ?? "").toUpperCase();
      const stageFlags = computeLegislationStageFlags({
        latestAction: b.latestAction?.text ?? null,
        introducedDate: b.introducedDate ?? null,
      });
      const billCongress =
        b.congress != null ? Number(b.congress) : currentCongress;
      const normalizedStageFlags = finalizeFederalStageFlags(
        stageFlags,
        billCongress,
        currentCongress,
      );
      return {
        id: `${b.congress}-${billType}-${b.number}`,
        title: b.title ?? "Untitled",
        type: billType || null,
        number: `${billType} ${b.number}`,
        congress: String(b.congress),
        introducedDate: b.introducedDate,
        latestAction: b.latestAction?.text,
        latestActionDate: b.latestAction?.actionDate,
        sponsors: b.sponsors?.map((s: any) => s.fullName) ?? [],
        url: b.url,
        status: b.latestAction?.text,
        chamber: b.originChamber,
        policyArea: b.policyArea?.name ?? undefined,
        subjects:
          b.subjects?.item ??
          (Array.isArray(b.subjects) ? b.subjects : undefined),
        category: classifyFederalLegislationItem(b),
        stageIntroduced: normalizedStageFlags.introduced,
        stageCommittee: normalizedStageFlags.committee,
        stageFloorVote: normalizedStageFlags.floor_vote,
        stagePassed: normalizedStageFlags.passed,
        stageSignedEnacted: normalizedStageFlags.signed_enacted,
        stageDead: normalizedStageFlags.dead,
      };
    });

    // Ensure most current first by latest action date
    bills.sort((a: any, b: any) => {
      const dateA = a.latestActionDate
        ? new Date(a.latestActionDate).getTime()
        : 0;
      const dateB = b.latestActionDate
        ? new Date(b.latestActionDate).getTime()
        : 0;
      return dateB - dateA;
    });

    req.log.info(
      { count: bills.length, q, source: "congress.gov" },
      "Fetched federal bills from Congress.gov",
    );

    // Upsert into cache for search
    for (const bill of bills) {
      await upsertFederalBill({
        id: bill.id,
        title: bill.title,
        type: bill.type ?? null,
        number: bill.number ?? null,
        congress: bill.congress != null ? Number(bill.congress) : null,
        introducedDate: bill.introducedDate ?? null,
        latestAction: bill.latestAction ?? null,
        latestActionDate: bill.latestActionDate ?? null,
        chamber: bill.chamber ?? null,
        category: bill.category ?? null,
        policyArea: bill.policyArea ?? null,
        subjects: bill.subjects ?? [],
        url: bill.url ?? null,
        stageIntroduced: bill.stageIntroduced ?? false,
        stageCommittee: bill.stageCommittee ?? false,
        stageFloorVote: bill.stageFloorVote ?? false,
        stagePassed: bill.stagePassed ?? false,
        stageSignedEnacted: bill.stageSignedEnacted ?? false,
        stageDead: bill.stageDead ?? false,
        raw: bill,
      });
    }

    return res.json({ bills, totalCount: data.pagination?.count, offset });
  } catch (err) {
    if (isProviderRateLimitError(err)) return sendProviderRateLimitError(res, err);
    req.log.error({ err }, "Error fetching federal bills");
    return sendInternalError(res);
  }
});

router.get("/federal/bills/search", async (req, res) => {
  const parsed = SearchFederalBillsQueryParams.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid query parameters" });
  }
  const { q, policyArea, limit: rawLimit, offset } = parsed.data;
  if (!q && !policyArea) {
    return res.status(400).json({ error: "Provide q or policyArea" });
  }
  const limit = Math.min(rawLimit, 100);

  try {
    req.log.info({ q, policyArea, source: "db" }, "Searching federal bills from DB cache");
    const conditions = buildFederalBillsDbConditions({
      q,
      chamberFilter: null,
      policyArea,
      stageCondition: undefined,
      currentCongress: getCurrentCongressNumber(),
      searchAllCongresses: true,
    });

    const rows = await db
      .select()
      .from(federalBillsTable)
      .where(and(...conditions))
      .orderBy(
        ...(q
          ? [sql`GREATEST(ts_rank(${federalBillsTable.searchVector}, websearch_to_tsquery('english', ${q})), similarity(${q}, ${federalBillsTable.title})) desc`]
          : [desc(federalBillsTable.introducedDate), asc(federalBillsTable.id)]),
      )
      .limit(limit)
      .offset(offset);

    const countResult = await db
      .select({ count: sql<number>`count(*)` })
      .from(federalBillsTable)
      .where(and(...conditions));

    const totalCount = Number(countResult[0]?.count ?? 0);

    const bills = rows.map((b) => ({
      id: b.id,
      title: b.title,
      number: b.number,
      congress: b.congress,
      introducedDate: b.introducedDate,
      latestAction: b.latestAction,
      latestActionDate: b.latestActionDate,
      stageIntroduced: b.stageIntroduced,
      stageCommittee: b.stageCommittee,
      stageFloorVote: b.stageFloorVote,
      stagePassed: b.stagePassed,
      stageSignedEnacted: b.stageSignedEnacted,
      stageDead: b.stageDead,
      summary: b.summary,
      policyArea: b.policyArea,
      subjects: b.subjects,
      url: b.url,
      status: b.latestAction,
      chamber: b.chamber,
      itemCategory: b.category ?? undefined,
      legislationType: b.type ?? undefined,
    }));

    return res.json({ bills, totalCount, offset });
  } catch (err) {
    if (isProviderRateLimitError(err)) return sendProviderRateLimitError(res, err);
    req.log.error({ err }, "Error searching federal bills");
    return sendInternalError(res);
  }
});

router.get(
  "/federal/bills/:congress/:billType/:billNumber",
  async (req, res) => {
    const parsed = GetFederalBillDetailParams.safeParse(req.params);
    if (!parsed.success)
      return res.status(400).json({ error: "Invalid params" });

    const { congress, billType, billNumber } = parsed.data;
    const billTypeUpper = billType.toUpperCase();

    try {
      const billId = `${congress}-${billTypeUpper}-${billNumber}`;

      // Check DB cache and fetch bill metadata in parallel
      const [existingRows, billData] = await Promise.all([
        db
          .select({
            summary: federalBillsTable.summary,
            summaryFetchedAt: federalBillsTable.summaryFetchedAt,
            textUrl: federalBillsTable.textUrl,
            textUrlFetchedAt: federalBillsTable.textUrlFetchedAt,
          })
          .from(federalBillsTable)
          .where(eq(federalBillsTable.id, billId))
          .limit(1),
        congressFetch(`/bill/${congress}/${billType}/${billNumber}`, {}, req.log),
      ]);

      const bill = billData.bill ?? {};
      const billUpdateDate: string | null = bill.updateDate ?? null;
      const cached = existingRows[0];
      const needsSummaryFetch = shouldRefetchField({
        fetchedAt: cached?.summaryFetchedAt,
        billUpdateDate,
      });
      const needsTextFetch = shouldRefetchField({
        fetchedAt: cached?.textUrlFetchedAt,
        billUpdateDate,
      });

      const [cosponsorsData, committeesData, actionsData, summaryData, textData] =
        await Promise.allSettled([
          congressFetch(
            `/bill/${congress}/${billType}/${billNumber}/cosponsors`,
            { limit: 50 },
            req.log,
          ),
          congressFetch(
            `/bill/${congress}/${billType}/${billNumber}/committees`,
            {},
            req.log,
          ),
          congressFetch(
            `/bill/${congress}/${billType}/${billNumber}/actions`,
            { limit: 250 },
            req.log,
          ),
          needsSummaryFetch
            ? congressFetch(
                `/bill/${congress}/${billType}/${billNumber}/summaries`,
                {},
                req.log,
              )
            : Promise.resolve(null),
          needsTextFetch
            ? congressFetch(
                `/bill/${congress}/${billType}/${billNumber}/text`,
                {},
                req.log,
              )
            : Promise.resolve(null),
        ]);

      const rawCosponsors = cosponsorsData.status === "fulfilled" ? cosponsorsData.value.cosponsors : undefined;
      const cosponsors = (rawCosponsors?.item ?? (Array.isArray(rawCosponsors) ? rawCosponsors : [])).map((c: any) => ({
        name: c.fullName ?? c.name ?? "",
        party: c.party,
        state: c.state,
        bioguideId: c.bioguideId,
      }));

      const rawCommittees = committeesData.status === "fulfilled" ? committeesData.value.committees : undefined;
      const committees = (rawCommittees?.item ?? (Array.isArray(rawCommittees) ? rawCommittees : [])).map((c: any) => ({
        name: c.name ?? "",
        chamber: c.chamber,
        committeeCode: c.systemCode,
      }));

      const rawActionsRaw = actionsData.status === "fulfilled" ? actionsData.value.actions : undefined;
      const rawActions: any[] = rawActionsRaw?.item ?? (Array.isArray(rawActionsRaw) ? rawActionsRaw : []);
      const actions = dedupeAndSortFederalBillActions(rawActions);
      const votes = dedupeFederalBillVotes(rawActions.flatMap((a: any) => {
        const recordedVotes: any[] = a.recordedVotes ?? [];
        if (recordedVotes.length === 0) return [];
        const countMatch = (a.text ?? "").match(/(\d+)\s*[-–]\s*(\d+)/);
        const yesCount = countMatch ? Number(countMatch[1]) : undefined;
        const noCount = countMatch ? Number(countMatch[2]) : undefined;
        const presentMatch = (a.text ?? "").match(/(\d+)\s+Present/i);
        const presentCount = presentMatch ? Number(presentMatch[1]) : undefined;
        return recordedVotes.map((rv: any) => ({
          date: a.actionDate ?? "",
          chamber: rv.chamber ?? "",
          rollNumber: rv.rollNumber,
          result: a.text ?? "",
          yesCount,
          noCount,
          presentCount,
          sourceUrl: rv.url,
        }));
      }));
      const progress = computeFederalBillProgress({
        congress,
        latestAction: bill.latestAction?.text,
        laws: bill.laws,
        actions,
      });

      const currentCongress = getCurrentCongressNumber();
      const stageFlags = finalizeFederalStageFlags(
        computeLegislationStageFlags({
          latestAction: bill.latestAction?.text,
          introducedDate: bill.introducedDate,
        }),
        Number(congress),
        currentCongress,
      );

      const fetchedSummaryRaw =
        needsSummaryFetch && summaryData.status === "fulfilled" && summaryData.value !== null
          ? (summaryData.value.summaries?.item?.[0]?.text ?? summaryData.value.summaries?.[0]?.text ?? null)
          : null;
      const fetchedSummary = normalizeSummaryText(fetchedSummaryRaw, bill.title ?? null);
      const summary = needsSummaryFetch
        ? fetchedSummary
        : normalizeSummaryText(cached?.summary ?? null, bill.title ?? null);

      let textUrl: string | null | undefined;
      if (needsTextFetch) {
        const textVersions =
          textData.status === "fulfilled" && textData.value !== null
            ? (textData.value.textVersions ?? [])
            : [];
        const latestText = textVersions[0];
        textUrl =
          latestText?.formats?.find((f: any) => f.type === "PDF")?.url ??
          latestText?.formats?.[0]?.url ??
          null;
      } else {
        textUrl = cached?.textUrl ?? null;
      }

      req.log.info(
        {
          billId: `${congress}-${billTypeUpper}-${billNumber}`,
          source: "congress.gov",
          actionsStatus: actionsData.status,
          actionsCount: actions.length,
          votesCount: votes.length,
          cosponsorsCount: cosponsors.length,
          committeesCount: committees.length,
        },
        "Fetched federal bill detail from Congress.gov",
      );

      // Normalize subjects from Congress.gov nested structure (may be { item: [...] })
      const billSubjects =
        bill.subjects?.item ??
        (Array.isArray(bill.subjects) ? bill.subjects : []);
      const now = new Date();
      const newSummaryFetchedAt = needsSummaryFetch ? now : (cached?.summaryFetchedAt ?? null);
      const newTextUrlFetchedAt = needsTextFetch ? now : (cached?.textUrlFetchedAt ?? null);
      await upsertFederalBill({
        id: billId,
        title: bill.title ?? "Untitled",
        type: billTypeUpper,
        number: `${billTypeUpper} ${billNumber}`,
        category: classifyFederalLegislationItem({ type: billTypeUpper, number: billNumber }),
        congress: Number(congress),
        introducedDate: bill.introducedDate ?? null,
        latestAction: bill.latestAction?.text ?? null,
        latestActionDate: bill.latestAction?.actionDate ?? null,
        summary,
        updateDate: billUpdateDate,
        summaryFetchedAt: newSummaryFetchedAt,
        textUrlFetchedAt: newTextUrlFetchedAt,
        policyArea: bill.policyArea?.name ?? null,
        subjects: billSubjects,
        url: bill.url ?? null,
        textUrl: textUrl ?? null,
        stageIntroduced: stageFlags.introduced,
        stageCommittee: stageFlags.committee,
        stageFloorVote: stageFlags.floor_vote,
        stagePassed: stageFlags.passed,
        stageSignedEnacted: stageFlags.signed_enacted,
        stageDead: stageFlags.dead,
        raw: bill,
      });

      return res.json({
        id: `${congress}-${billTypeUpper}-${billNumber}`,
        title: bill.title ?? "Untitled",
        number: `${billTypeUpper} ${billNumber}`,
        congress: String(congress),
        introducedDate: bill.introducedDate,
        summary: summary ?? undefined,
        status: bill.latestAction?.text,
        latestAction: bill.latestAction?.text,
        latestActionDate: bill.latestAction?.actionDate,
        sponsors:
          bill.sponsors?.map((s: any) => ({
            name: s.fullName ?? s.name ?? "",
            party: s.party,
            state: s.state,
            bioguideId: s.bioguideId,
          })) ?? [],
        cosponsors,
        committees,
        actions,
        votes,
        progress,
        url: bill.url,
        textUrl,
        policyArea: bill.policyArea?.name ?? undefined,
        subjects: undefined,
      });
    } catch (err) {
      if (isProviderRateLimitError(err)) return sendProviderRateLimitError(res, err);
      req.log.error({ err }, "Error fetching bill detail");
      return sendInternalError(res);
    }
  },
);

export default router;
