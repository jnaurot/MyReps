import { Router } from "express";
import { eq, and, or, desc, sql, inArray } from "drizzle-orm";
import {
  db,
  normalizeStateVotePosition,
  stateVoteRecordsTable,
  stateBillsTable,
  stateLegislatorsTable,
} from "@workspace/db";
import {
  GetStateMemberBillsQueryParams,
  GetStateMemberVotesQueryParams,
  GetStateBillsQueryParams,
  SearchStateMembersQueryParams,
  SearchStateBillsQueryParams,
} from "@workspace/api-zod";
import {
  getStateLegislator,
  refreshStateLegislator,
  openStatesFetch,
} from "../lib/stateLegislatorCache";
import {
  getCachedPhoto,
  setCachedPhoto,
} from "../lib/photoCache";
import { fetchWithTimeout as fetch } from "../lib/http";
import {
  isProviderRateLimitError,
  sendInternalError,
  sendProviderRateLimitError,
} from "../lib/respond";
import {
  computeLegislationStageFlags,
  parseStageQuery,
  type LegislationStageKey,
} from "../lib/legislationStages";
import {
  computeChamberAwareStages,
} from "../lib/chamberAwareStages";
import { stateMemberPhotoUrl } from "./representativesUtils";

const PLACEHOLDER_SVG = Buffer.from(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200" width="200" height="200">
    <rect width="200" height="200" fill="#e5e7eb"/>
    <circle cx="100" cy="80" r="35" fill="#9ca3af"/>
    <path d="M30 180 Q100 110 170 180" fill="#9ca3af"/>
  </svg>`,
  "utf-8",
);

const PHOTO_FETCH_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36",
  Accept: "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  Referer: "https://politician.bawlmorean.com/",
} as const;

function sendPlaceholderPhoto(res: any, options?: { stale?: boolean }) {
  res
    .set("Content-Type", "image/svg+xml")
    .set("Cache-Control", "public, max-age=0, must-revalidate")
    .set("X-Photo-Stale", options?.stale ? "1" : "0")
    .set("Content-Length", String(PLACEHOLDER_SVG.length))
    .send(PLACEHOLDER_SVG);
}

function getRequestedStateMemberPhotoId(req: any): string {
  const queryMemberId = req.query?.memberId;
  if (typeof queryMemberId === "string" && queryMemberId.trim()) {
    return queryMemberId;
  }

  const legacyMemberId = req.params?.memberId;
  return typeof legacyMemberId === "string" ? decodeURIComponent(legacyMemberId) : "";
}

const router = Router();

const OPENSTATES_API_KEY = process.env.OPENSTATES_API_KEY;
const STATE_MEMBER_BILLS_CACHE_TTL_MS = 5 * 60 * 1000;
const stateMemberBillsCache = new Map<
  string,
  { fetchedAt: number; bills: ReturnType<typeof mapStateBill>[]; totalCount: number }
>();


function stateStageColumn(stage: LegislationStageKey) {
  switch (stage) {
    case "introduced":
      return stateBillsTable.stageIntroduced;
    case "committee":
      return stateBillsTable.stageCommittee;
    case "floor_vote":
      return stateBillsTable.stageFloorVote;
    case "passed":
      return stateBillsTable.stagePassed;
    case "signed_enacted":
      return stateBillsTable.stageSignedEnacted;
    case "dead":
      return stateBillsTable.stageDead;
  }
}

function mapStateBill(b: any) {
  const latestAction = b.actions?.[b.actions.length - 1];
  return {
    id: b.id ?? "",
    identifier: b.identifier,
    title: b.title ?? "Untitled",
    session: b.session ?? b.legislative_session,
    chamber: b.from_organization?.classification,
    status: b.status ?? b.latest_action_description ?? latestAction?.description,
    introducedDate: b.first_action_date ?? b.created_at?.split("T")[0],
    latestAction: b.latest_action_description ?? latestAction?.description,
    latestActionDate: b.latest_action_date ?? latestAction?.date,
    sponsors: b.sponsorships?.map((s: any) => s.name ?? "") ?? [],
    url: b.openstates_url,
    subjects: Array.isArray(b.subject)
      ? b.subject
      : b.subject
        ? [b.subject]
        : undefined,
  };
}

function getBillSortDateMs(bill: ReturnType<typeof mapStateBill>) {
  const rawDate = bill.introducedDate ?? bill.latestActionDate;
  const time = rawDate ? new Date(rawDate).getTime() : 0;
  return Number.isFinite(time) ? time : 0;
}

function sortBillsNewestFirst<T extends ReturnType<typeof mapStateBill>>(bills: T[]) {
  return bills.sort((a, b) => {
    const dateDelta = getBillSortDateMs(b) - getBillSortDateMs(a);
    if (dateDelta !== 0) return dateDelta;
    return (b.identifier ?? "").localeCompare(a.identifier ?? "");
  });
}

async function upsertStateBill({
  bill,
  sourceBill,
  jurisdiction,
}: {
  bill: ReturnType<typeof mapStateBill>;
  sourceBill: any;
  jurisdiction: string;
}) {
  const subjectsText = Array.isArray(bill.subjects)
    ? bill.subjects.join(" ")
    : "";
  const stageFlags = computeLegislationStageFlags({
    latestAction: bill.latestAction,
    status: bill.status,
    introducedDate: bill.introducedDate,
  });
  await db
    .insert(stateBillsTable)
    .values({
      id: bill.id,
      identifier: bill.identifier ?? null,
      title: bill.title,
      session: bill.session ?? null,
      chamber: bill.chamber ?? null,
      status: bill.status ?? null,
      introducedDate: bill.introducedDate ?? null,
      stageIntroduced: stageFlags.introduced,
      stageCommittee: stageFlags.committee,
      stageFloorVote: stageFlags.floor_vote,
      stagePassed: stageFlags.passed,
      stageSignedEnacted: stageFlags.signed_enacted,
      stageDead: stageFlags.dead,
      summary: null,
      subjects: bill.subjects ?? [],
      url: bill.url ?? null,
      jurisdiction,
      raw: sourceBill,
      searchVector: sql`setweight(to_tsvector('english', coalesce(${bill.title}, '')), 'A') || setweight(to_tsvector('english', coalesce(${bill.identifier ?? ""}, '')), 'B') || setweight(to_tsvector('english', coalesce(${subjectsText}, '')), 'C')`,
    })
    .onConflictDoUpdate({
      target: stateBillsTable.id,
      set: {
        title: bill.title,
        identifier: bill.identifier ?? null,
        session: bill.session ?? null,
        chamber: bill.chamber ?? null,
        status: bill.status ?? null,
        introducedDate: bill.introducedDate ?? null,
        stageIntroduced: stageFlags.introduced,
        stageCommittee: stageFlags.committee,
        stageFloorVote: stageFlags.floor_vote,
        stagePassed: stageFlags.passed,
        stageSignedEnacted: stageFlags.signed_enacted,
        stageDead: stageFlags.dead,
        subjects: bill.subjects ?? [],
        url: bill.url ?? null,
        raw: sql`COALESCE(state_bills.raw, '{}'::jsonb) || ${JSON.stringify(sourceBill)}::jsonb`,
        fetchedAt: new Date(),
        searchVector: sql`setweight(to_tsvector('english', coalesce(${bill.title}, '')), 'A') || setweight(to_tsvector('english', coalesce(${bill.identifier ?? ""}, '')), 'B') || setweight(to_tsvector('english', coalesce(${subjectsText}, '')), 'C')`,
      },
    });
}

function mapDbStateBillRow(row: typeof stateBillsTable.$inferSelect) {
  const raw = (row.raw ?? {}) as any;
  const actions: any[] = Array.isArray(raw.actions) ? raw.actions : [];
  const latestAction = actions[actions.length - 1];
  return {
    id: row.id,
    identifier: row.identifier ?? undefined,
    title: row.title ?? "Untitled",
    session: row.session ?? undefined,
    chamber: row.chamber ?? undefined,
    status: row.status ?? undefined,
    introducedDate: row.introducedDate ?? undefined,
    latestAction: latestAction?.description ?? row.status ?? undefined,
    latestActionDate: latestAction?.date ?? undefined,
    stageIntroduced: row.stageIntroduced,
    stageCommittee: row.stageCommittee,
    stageFloorVote: row.stageFloorVote,
    stagePassed: row.stagePassed,
    stageSignedEnacted: row.stageSignedEnacted,
    stageDead: row.stageDead,
    sponsors: Array.isArray(raw.sponsorships)
      ? raw.sponsorships.map((s: any) => s?.name).filter(Boolean)
      : [],
    url: row.url ?? undefined,
    subjects: row.subjects ?? undefined,
  };
}

function mapDbStateBillDetail(
  row: typeof stateBillsTable.$inferSelect,
  legislatorMap?: Map<string, { party?: string | null }>,
) {
  const raw = (row.raw ?? {}) as any;
  const actions: any[] = Array.isArray(raw.actions) ? raw.actions : [];
  const latestAction = actions[actions.length - 1];
  const introducedDate =
    row.introducedDate ?? raw.first_action_date ?? raw.created_at?.split("T")[0] ?? null;
  const actionHistoryText = actions.map((a: any) => a?.description).filter(Boolean).join(" ");
  const stageFlags = computeLegislationStageFlags({
    latestAction: latestAction?.description,
    status: actionHistoryText,
    introducedDate,
  });

  const mappedActions = actions.map((a: any) => ({
    date: a.date ?? "",
    text: a.description ?? "",
    type: a.classification?.[0],
    organizationName: a.organization?.name,
    organizationClassification: a.organization?.classification,
  }));
  const chamberAware = computeChamberAwareStages(mappedActions);
  const subjects = Array.isArray(raw.subject)
    ? raw.subject
    : raw.subject
      ? [raw.subject]
      : [];
  const sponsorships = Array.isArray(raw.sponsorships) ? raw.sponsorships : [];
  // Prefer real committee names from backfilled raw.committees (from billactionrelatedentity)
  const committees = Array.isArray(raw.committees)
    ? raw.committees.map((c: any) => ({
        name: c.name ?? "",
        chamber: c.chamber ?? undefined,
      }))
    : actions
        .filter((a: any) => a.organization)
        .map((a: any) => ({
          name: a.organization.name ?? "",
          chamber: a.organization.classification,
        }))
        .filter(
          (c: any, i: number, arr: any[]) =>
            arr.findIndex((x) => x.name === c.name) === i,
        );
  const votes = Array.isArray(raw.votes)
    ? raw.votes.map((v: any) => ({
        date: v.date ?? v.start_date ?? "",
        startDate: v.start_date,
        chamber: v.chamber ?? v.organization?.classification,
        organizationName: v.organization?.name,
        organizationClassification: v.organization?.classification,
        motionText: v.motion_text,
        motionClassification: v.motion_classification,
        sourceUrl: v.sources?.[0]?.url,
        result: v.result,
        yesCount: v.counts?.find((c: any) => c.option === "yes")?.value,
        noCount: v.counts?.find((c: any) => c.option === "no")?.value,
        absentCount: v.counts?.find((c: any) => c.option === "absent")?.value,
      }))
    : [];

  const buildSponsor = (s: any) => {
    const personId = s.person?.id ?? s.id ?? undefined;
    const legislator = personId ? legislatorMap?.get(personId) : undefined;
    return {
      name: s.name ?? "",
      party: legislator?.party ?? s.party ?? undefined,
      state: raw.jurisdiction?.name ?? row.jurisdiction ?? undefined,
      openstatesId: personId,
    };
  };

  return {
    id: row.id,
    identifier: raw.identifier ?? row.identifier,
    title: row.title ?? "Untitled",
    session: raw.legislative_session ?? row.session,
    chamber: raw.from_organization?.classification ?? row.chamber,
    status: latestAction?.description ?? row.status,
    introducedDate,
    summary: raw.abstract ?? row.summary ?? null,
    text: row.text ?? undefined,
    sponsors: sponsorships
      .filter((s: any) => s.primary)
      .map(buildSponsor),
    cosponsors: sponsorships
      .filter((s: any) => !s.primary)
      .map(buildSponsor),
    committees,
    actions: mappedActions,
    votes,
    url: raw.openstates_url ?? row.url,
    textUrl: raw.openstates_url ?? row.url,
    subjects,
    stages: {
      introduced: stageFlags.introduced,
      committee: stageFlags.committee,
      floorVote: stageFlags.floor_vote,
      passed: stageFlags.passed,
      signed: stageFlags.signed_enacted,
      enacted: stageFlags.signed_enacted,
      dead: stageFlags.dead,
      completedStages: chamberAware.completed,
      currentStage: chamberAware.current,
      currentChamber: chamberAware.currentChamber,
    },
  };
}

// State member IDs are "ocd-person/<uuid>". The frontend URL-encodes them
// so Express sees a single param like "ocd-person%2F<uuid>". We decode it here.
router.get("/state/members/search", async (req, res) => {
  const parsed = SearchStateMembersQueryParams.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid query parameters" });
  }
  const { q, jurisdiction, limit: rawLimit, offset } = parsed.data;
  const limit = Math.min(rawLimit, 100);

  try {
    req.log.info(
      { q, jurisdiction, source: "db" },
      "Searching state legislators from DB cache",
    );
    const searchPattern = `%${q}%`;
    const conditions: any[] = [
      or(
        sql`${stateLegislatorsTable.name} ILIKE ${searchPattern}`,
        sql`${stateLegislatorsTable.party} ILIKE ${searchPattern}`,
      ),
    ];

    if (jurisdiction) {
      conditions.push(eq(stateLegislatorsTable.jurisdiction, jurisdiction));
    }

    const rows = await db
      .select()
      .from(stateLegislatorsTable)
      .where(and(...conditions))
      .limit(limit)
      .offset(offset);

    const countResult = await db
      .select({ count: sql<number>`count(*)` })
      .from(stateLegislatorsTable)
      .where(and(...conditions));

    const totalCount = Number(countResult[0]?.count ?? 0);

    const members = rows.map((r) => ({
      id: r.id,
      name: r.name,
      party: r.party,
      chamber: r.chamber,
      district: r.district,
      jurisdiction: r.jurisdiction,
      photoUrl: stateMemberPhotoUrl(r.id, !!r.photoUrl),
      rawPhotoUrl: r.photoUrl ?? undefined,
      state: r.state,
    }));

    return res.json({ members, totalCount, offset });
  } catch (err) {
    req.log.error({ err }, "Error searching state legislators");
    return sendInternalError(res);
  }
});

router.get("/state/members/:memberId", async (req, res) => {
  const memberId = decodeURIComponent(req.params.memberId);
  if (!memberId) return res.status(400).json({ error: "memberId required" });

  try {
    const result = await getStateLegislator(memberId, req.log);
    req.log.info(
      { memberId, source: result.cache.source },
      "State member request served",
    );
    return res.json({
      ...result,
      legislator: {
        ...result.legislator,
        photoUrl: stateMemberPhotoUrl(memberId, !!result.legislator.photoUrl),
        rawPhotoUrl: result.legislator.photoUrl ?? undefined,
      },
    });
  } catch (err) {
    if (isProviderRateLimitError(err)) {
      req.log.warn({ err }, "State member request blocked by provider rate limit");
      return sendProviderRateLimitError(res, err);
    }
    req.log.error({ err }, "Error fetching state member");
    return sendInternalError(res);
  }
});

router.post("/state/members/:memberId/refresh", async (req, res) => {
  const memberId = decodeURIComponent(req.params.memberId);
  if (!memberId) return res.status(400).json({ error: "memberId required" });

  try {
    const result = await refreshStateLegislator(memberId, req.log);
    return res.json({
      ...result,
      legislator: {
        ...result.legislator,
        photoUrl: stateMemberPhotoUrl(memberId, !!result.legislator.photoUrl),
        rawPhotoUrl: result.legislator.photoUrl ?? undefined,
      },
    });
  } catch (err) {
    if (isProviderRateLimitError(err)) {
      req.log.warn({ err }, "State member refresh blocked by provider rate limit");
      return sendProviderRateLimitError(res, err);
    }
    req.log.error({ err }, "Error refreshing state member");
    return sendInternalError(res);
  }
});

router.post("/state/members/:memberId/bills/refresh", async (req, res) => {
  const memberId = decodeURIComponent(req.params.memberId);
  if (!memberId) return res.status(400).json({ error: "memberId required" });

  const type = req.body?.type === "cosponsored" ? "cosponsored" : "sponsored";
  const sponsorClassification = type === "cosponsored" ? "cosponsor" : "primary";

  try {
    // Clear all cached pages for this member so the next GET fetches fresh data
    for (const key of stateMemberBillsCache.keys()) {
      if (key.includes(`|${memberId}|`)) stateMemberBillsCache.delete(key);
    }

    req.log.info({ memberId, type, source: "openstates" }, "Force refreshing state member bills");

    const data = await openStatesFetch("/bills", {
      jurisdiction: req.body?.jurisdiction ?? "md",
      per_page: 20,
      page: 1,
      sponsor: memberId,
      include: "sponsorships",
      sponsor_classification: sponsorClassification,
      sort: "first_action_desc",
    });

    const sourceBills = data.results ?? [];
    const bills = sortBillsNewestFirst(sourceBills.map(mapStateBill));
    const totalCount = Number(data.pagination?.total_items ?? 0);

    const jurisdiction = req.body?.jurisdiction ?? "md";
    for (const sourceBill of sourceBills) {
      await upsertStateBill({ bill: mapStateBill(sourceBill), sourceBill, jurisdiction });
    }

    stateMemberBillsCache.set(
      [jurisdiction, memberId, sponsorClassification, 1, 20].join("|"),
      { fetchedAt: Date.now(), bills, totalCount },
    );

    return res.json({ bills, totalCount, offset: 0, refreshed: true });
  } catch (err) {
    if (isProviderRateLimitError(err)) {
      req.log.warn({ err }, "State member bills refresh blocked by provider rate limit");
      return sendProviderRateLimitError(res, err);
    }
    req.log.error({ err }, "Error refreshing state member bills");
    return sendInternalError(res);
  }
});

router.get("/state/members/:memberId/bills", async (req, res) => {
  const memberId = decodeURIComponent(req.params.memberId);
  const queryParsed = GetStateMemberBillsQueryParams.safeParse(req.query);
  if (!memberId || !queryParsed.success)
    return res.status(400).json({ error: "Invalid params" });

  try {
    const { jurisdiction, offset, limit, q, type, stages } = queryParsed.data;
    const sponsorClassification =
      type === "cosponsored" ? "cosponsor" : "primary";
    const selectedStages = parseStageQuery(stages);

    if (selectedStages.length > 0) {
      // Use @> containment against the GIN-indexed raw->'sponsorships' expression.
      // Each @> call is independently indexable; PostgreSQL bitmap-ORs the results.
      const primaryContainment = [
        sql`${stateBillsTable.raw}->'sponsorships' @> ${JSON.stringify([{ person: { id: memberId }, classification: "primary" }])}::jsonb`,
        sql`${stateBillsTable.raw}->'sponsorships' @> ${JSON.stringify([{ person: { id: memberId }, primary: true }])}::jsonb`,
      ];
      const cosponsorContainment = [
        sql`${stateBillsTable.raw}->'sponsorships' @> ${JSON.stringify([{ person: { id: memberId }, classification: "cosponsor" }])}::jsonb`,
        sql`${stateBillsTable.raw}->'sponsorships' @> ${JSON.stringify([{ person: { id: memberId }, classification: "cosponsor-primary" }])}::jsonb`,
      ];
      const sponsorCondition =
        sponsorClassification === "primary"
          ? or(...primaryContainment)
          : or(...cosponsorContainment);

      const stageCondition = or(
        ...selectedStages.map((stage) => eq(stateStageColumn(stage), true)),
      );
      const searchCondition = q
        ? sql`(${stateBillsTable.searchVector} @@ websearch_to_tsquery('english', ${q}) OR ${q} % ${stateBillsTable.title})`
        : undefined;
      const conditions = [
        eq(stateBillsTable.jurisdiction, jurisdiction),
        sponsorCondition,
        ...(stageCondition ? [stageCondition] : []),
        ...(searchCondition ? [searchCondition] : []),
      ];

      const [countResult, rows] = await Promise.all([
        db
          .select({ count: sql<number>`count(*)` })
          .from(stateBillsTable)
          .where(and(...conditions)),
        db
          .select()
          .from(stateBillsTable)
          .where(and(...conditions))
          .orderBy(
            q
              ? sql`GREATEST(ts_rank(${stateBillsTable.searchVector}, websearch_to_tsquery('english', ${q})), similarity(${q}, ${stateBillsTable.title})) desc`
              : desc(stateBillsTable.introducedDate),
          )
          .limit(limit)
          .offset(offset),
      ]);
      const totalCount = Number(countResult[0]?.count ?? 0);

      req.log.info(
        {
          memberId,
          jurisdiction,
          type,
          stages,
          offset,
          limit,
          totalCount,
          source: "db",
        },
        "Serving state member bills from DB stage index",
      );

      return res.json({
        bills: rows.map(mapDbStateBillRow),
        totalCount,
        offset,
      });
    }

    if (q) {
      // Text search without stage filter — use DB so search covers all fetched bills
      // rather than just the current in-memory page.
      const primaryContainment = [
        sql`${stateBillsTable.raw}->'sponsorships' @> ${JSON.stringify([{ person: { id: memberId }, classification: "primary" }])}::jsonb`,
        sql`${stateBillsTable.raw}->'sponsorships' @> ${JSON.stringify([{ person: { id: memberId }, primary: true }])}::jsonb`,
      ];
      const cosponsorContainment = [
        sql`${stateBillsTable.raw}->'sponsorships' @> ${JSON.stringify([{ person: { id: memberId }, classification: "cosponsor" }])}::jsonb`,
        sql`${stateBillsTable.raw}->'sponsorships' @> ${JSON.stringify([{ person: { id: memberId }, classification: "cosponsor-primary" }])}::jsonb`,
      ];
      const sponsorCondition =
        sponsorClassification === "primary"
          ? or(...primaryContainment)
          : or(...cosponsorContainment);

      const searchCondition = sql`(${stateBillsTable.searchVector} @@ websearch_to_tsquery('english', ${q}) OR ${q} % ${stateBillsTable.title})`;
      const dbConditions = [
        eq(stateBillsTable.jurisdiction, jurisdiction),
        sponsorCondition,
        searchCondition,
      ];

      // Seed DB from OpenStates if this member has no cached bills yet.
      const [memberCountRow] = await db
        .select({ count: sql<number>`count(*)` })
        .from(stateBillsTable)
        .where(and(eq(stateBillsTable.jurisdiction, jurisdiction), sponsorCondition));

      if (Number(memberCountRow?.count ?? 0) === 0) {
        const seedCacheKey = [jurisdiction, memberId, sponsorClassification, 1, 20].join("|");
        const seedCached = stateMemberBillsCache.get(seedCacheKey);
        if (!seedCached || Date.now() - seedCached.fetchedAt >= STATE_MEMBER_BILLS_CACHE_TTL_MS) {
          const data = await openStatesFetch("/bills", {
            jurisdiction,
            per_page: 20,
            page: 1,
            sponsor: memberId,
            include: "sponsorships",
            sponsor_classification: sponsorClassification,
            sort: "first_action_desc",
          });
          const sourceBills = data.results ?? [];
          for (const sourceBill of sourceBills) {
            await upsertStateBill({ bill: mapStateBill(sourceBill), sourceBill, jurisdiction });
          }
          stateMemberBillsCache.set(seedCacheKey, {
            fetchedAt: Date.now(),
            bills: sourceBills.map(mapStateBill),
            totalCount: Number(data.pagination?.total_items ?? 0),
          });
        }
      }

      const [countResult, rows] = await Promise.all([
        db.select({ count: sql<number>`count(*)` }).from(stateBillsTable).where(and(...dbConditions)),
        db.select().from(stateBillsTable).where(and(...dbConditions))
          .orderBy(sql`GREATEST(ts_rank(${stateBillsTable.searchVector}, websearch_to_tsquery('english', ${q})), similarity(${q}, ${stateBillsTable.title})) desc`)
          .limit(limit)
          .offset(offset),
      ]);

      const totalCount = Number(countResult[0]?.count ?? 0);

      req.log.info(
        { memberId, jurisdiction, type, q, offset, limit, totalCount, source: "db" },
        "Serving state member bill text search from DB",
      );

      return res.json({ bills: rows.map(mapDbStateBillRow), totalCount, offset });
    }

    // No-filter path: serve from DB. Seed from OpenStates only on empty cache.
    const primaryContainment = [
      sql`${stateBillsTable.raw}->'sponsorships' @> ${JSON.stringify([{ person: { id: memberId }, classification: "primary" }])}::jsonb`,
      sql`${stateBillsTable.raw}->'sponsorships' @> ${JSON.stringify([{ person: { id: memberId }, primary: true }])}::jsonb`,
    ];
    const cosponsorContainment = [
      sql`${stateBillsTable.raw}->'sponsorships' @> ${JSON.stringify([{ person: { id: memberId }, classification: "cosponsor" }])}::jsonb`,
      sql`${stateBillsTable.raw}->'sponsorships' @> ${JSON.stringify([{ person: { id: memberId }, classification: "cosponsor-primary" }])}::jsonb`,
    ];
    const sponsorCondition =
      sponsorClassification === "primary"
        ? or(...primaryContainment)
        : or(...cosponsorContainment);
    const dbConditions = [
      eq(stateBillsTable.jurisdiction, jurisdiction),
      sponsorCondition,
    ];

    const [memberCountRow] = await db
      .select({ count: sql<number>`count(*)` })
      .from(stateBillsTable)
      .where(and(...dbConditions));

    if (Number(memberCountRow?.count ?? 0) === 0) {
      req.log.info(
        { memberId, jurisdiction, type, source: "openstates" },
        "Seeding state member bills from OpenStates (no cached bills)",
      );
      const data = await openStatesFetch("/bills", {
        jurisdiction,
        per_page: 20,
        page: 1,
        sponsor: memberId,
        include: "sponsorships",
        sponsor_classification: sponsorClassification,
        sort: "first_action_desc",
      });
      const sourceBills = data.results ?? [];
      for (const sourceBill of sourceBills) {
        await upsertStateBill({
          bill: mapStateBill(sourceBill),
          sourceBill,
          jurisdiction,
        });
      }
    }

    const [countResult, rows] = await Promise.all([
      db.select({ count: sql<number>`count(*)` }).from(stateBillsTable).where(and(...dbConditions)),
      db
        .select()
        .from(stateBillsTable)
        .where(and(...dbConditions))
        .orderBy(desc(stateBillsTable.introducedDate))
        .limit(limit)
        .offset(offset),
    ]);
    const totalCount = Number(countResult[0]?.count ?? 0);

    req.log.info(
      {
        memberId,
        jurisdiction,
        type,
        offset,
        limit,
        totalCount,
        source: "db",
      },
      "Serving state member bills from DB",
    );

    return res.json({
      bills: rows.map(mapDbStateBillRow),
      totalCount,
      offset,
    });
  } catch (err) {
    if (isProviderRateLimitError(err)) {
      req.log.warn({ err }, "State member bills request blocked by provider rate limit");
      return sendProviderRateLimitError(res, err);
    }
    req.log.error({ err }, "Error fetching state member bills");
    return sendInternalError(res);
  }
});

async function ingestStateVotesForMember({
  jurisdiction,
  memberId,
  maxPages = 10,
}: {
  jurisdiction: string;
  memberId: string;
  maxPages?: number;
}) {
  let inserted = 0;
  let scannedBills = 0;

  for (let page = 1; page <= maxPages; page++) {
    const data = await openStatesFetch("/bills", {
      jurisdiction,
      page,
      per_page: 20,
      sponsor_id: memberId,
      include: "votes",
    });

    const bills = data.results ?? [];
    if (bills.length === 0) break;

    for (const bill of bills) {
      scannedBills++;

      for (const voteEvent of bill.votes ?? []) {
        const individualVotes: any[] = voteEvent.votes ?? [];

        for (const vote of individualVotes) {
          const personId =
            vote.voter?.id ?? vote.voter_id ?? vote.legislator_id;
          const personName = vote.voter_name ?? vote.name;

          if (personId !== memberId && personName !== "Mr. President") {
            continue;
          }

          const position = normalizeStateVotePosition(
            vote.option ?? vote.vote ?? vote.position,
          );

          await db
            .insert(stateVoteRecordsTable)
            .values({
              jurisdiction,
              legislatorId: memberId,
              legislatorName: personName ?? null,
              voteEventId: String(
                voteEvent.id ?? `${bill.id}-${voteEvent.start_date}`,
              ),
              billId: bill.id,
              billIdentifier: bill.identifier ?? null,
              billTitle: bill.title ?? null,
              chamber:
                voteEvent.chamber ??
                bill.from_organization?.classification ??
                null,
              motionText: voteEvent.motion_text ?? null,
              result: voteEvent.result ?? null,
              position,
              votedAt: voteEvent.start_date
                ? new Date(voteEvent.start_date)
                : voteEvent.date
                  ? new Date(voteEvent.date)
                  : null,
              sourceUrl: bill.openstates_url ?? null,
              raw: { bill, voteEvent, vote },
            })
            .onConflictDoUpdate({
              target: [
                stateVoteRecordsTable.jurisdiction,
                stateVoteRecordsTable.legislatorId,
                stateVoteRecordsTable.voteEventId,
              ],
              set: {
                position,
                billTitle: bill.title ?? null,
                result: voteEvent.result ?? null,
                fetchedAt: new Date(),
                raw: { bill, voteEvent, vote },
              },
            });

          inserted++;
        }
      }
    }

    if (!data.pagination?.next_page) break;
  }

  return { inserted, scannedBills };
}

router.get("/state/members/:memberId/votes", async (req, res) => {
  const memberId = decodeURIComponent(req.params.memberId);
  const queryParsed = GetStateMemberVotesQueryParams.safeParse(req.query);
  if (!memberId || !queryParsed.success)
    return res.status(400).json({ error: "Invalid params" });

  try {
    const { jurisdiction, offset, limit, filter, q } = queryParsed.data;

    // Build text search condition
    const searchCondition = q
      ? sql`${stateVoteRecordsTable.billTitle} ILIKE ${`%${q}%`}`
      : undefined;

    // Check if we have any persisted vote records for this member
    const existing = await db
      .select({ count: sql<number>`count(*)` })
      .from(stateVoteRecordsTable)
      .where(
        and(
          eq(stateVoteRecordsTable.jurisdiction, jurisdiction),
          eq(stateVoteRecordsTable.legislatorId, memberId),
          ...(searchCondition ? [searchCondition] : []),
        ),
      );

    if (Number(existing[0]?.count ?? 0) === 0) {
      req.log.info(
        { memberId, jurisdiction, source: "openstates" },
        "No state vote records in DB; triggering ingestion",
      );
      const { inserted, scannedBills } = await ingestStateVotesForMember({
        jurisdiction,
        memberId,
      });
      req.log.info(
        {
          memberId,
          jurisdiction,
          inserted,
          scannedBills,
          source: "openstates",
        },
        "State vote ingestion complete",
      );
    } else {
      req.log.info(
        {
          memberId,
          jurisdiction,
          count: Number(existing[0]?.count ?? 0),
          source: "db",
        },
        "Serving state votes from DB",
      );
    }

    // Build filter conditions
    const baseConditions: any[] = [
      eq(stateVoteRecordsTable.jurisdiction, jurisdiction),
      eq(stateVoteRecordsTable.legislatorId, memberId),
    ];

    if (filter === "yea")
      baseConditions.push(eq(stateVoteRecordsTable.position, "Yea"));
    else if (filter === "nay")
      baseConditions.push(eq(stateVoteRecordsTable.position, "Nay"));
    else if (filter === "present")
      baseConditions.push(eq(stateVoteRecordsTable.position, "Present"));
    else if (filter === "not-voting")
      baseConditions.push(eq(stateVoteRecordsTable.position, "Not Voting"));
    if (searchCondition) baseConditions.push(searchCondition);

    // Fetch paginated votes
    const rows = await db
      .select({
        billId: stateVoteRecordsTable.billId,
        billTitle: stateVoteRecordsTable.billTitle,
        billIdentifier: stateVoteRecordsTable.billIdentifier,
        date: stateVoteRecordsTable.votedAt,
        position: stateVoteRecordsTable.position,
        result: stateVoteRecordsTable.result,
      })
      .from(stateVoteRecordsTable)
      .where(and(...baseConditions))
      .orderBy(desc(stateVoteRecordsTable.votedAt))
      .limit(limit)
      .offset(offset);

    // Count total for pagination
    const countResult = await db
      .select({ count: sql<number>`count(*)` })
      .from(stateVoteRecordsTable)
      .where(and(...baseConditions));

    const totalCount = Number(countResult[0]?.count ?? 0);

    const votes = rows.map((r) => ({
      billId: r.billId,
      billTitle: r.billTitle ?? "Untitled",
      billIdentifier: r.billIdentifier ?? undefined,
      date: r.date ? new Date(r.date).toISOString().split("T")[0] : "",
      position: r.position,
      result: r.result ?? undefined,
    }));

    return res.json({ votes, totalCount, offset });
  } catch (err) {
    if (isProviderRateLimitError(err)) {
      req.log.warn({ err }, "State member votes request blocked by provider rate limit");
      return sendProviderRateLimitError(res, err);
    }
    req.log.error({ err }, "Error fetching state member votes");
    return sendInternalError(res);
  }
});

router.get("/state/bills", async (req, res) => {
  const parsed = GetStateBillsQueryParams.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: "Invalid params" });

  const { chamber, offset, limit, jurisdiction, stages } = parsed.data;
  const selectedStages = parseStageQuery(stages);

  try {
    const stageCondition =
      selectedStages.length > 0
        ? or(...selectedStages.map((stage) => eq(stateStageColumn(stage), true)))
        : undefined;
    const dbConditions = [
      eq(stateBillsTable.jurisdiction, jurisdiction),
      ...(chamber ? [eq(stateBillsTable.chamber, chamber)] : []),
      ...(stageCondition ? [stageCondition] : []),
    ];
    const dbCountResult = await db
      .select({ count: sql<number>`count(*)` })
      .from(stateBillsTable)
      .where(and(...dbConditions));
    const dbTotalCount = Number(dbCountResult[0]?.count ?? 0);

    if (dbTotalCount > offset || selectedStages.length > 0) {
      const rows = await db
        .select()
        .from(stateBillsTable)
        .where(and(...dbConditions))
        .orderBy(desc(stateBillsTable.introducedDate))
        .limit(limit)
        .offset(offset);
      req.log.info(
        { jurisdiction, chamber, stages, offset, limit, totalCount: dbTotalCount, source: "db" },
        "Serving state bills from DB cache",
      );
      return res.json({
        bills: rows.map(mapDbStateBillRow),
        totalCount: dbTotalCount,
        offset,
      });
    }

    const params: Record<string, string | number> = {
      jurisdiction,
      per_page: limit,
      page: Math.floor(offset / limit) + 1,
    };
    if (chamber) params.chamber = chamber;

    req.log.info(
      {
        jurisdiction,
        page: Math.floor(offset / limit) + 1,
        source: "openstates",
      },
      "Fetching state bills from OpenStates",
    );
    const data = await openStatesFetch("/bills", params);
    const bills = (data.results ?? []).map(mapStateBill);

    // Sort by latest action date descending (most current first)
    bills.sort((a: any, b: any) => {
      const dateA = a.latestActionDate
        ? new Date(a.latestActionDate).getTime()
        : 0;
      const dateB = b.latestActionDate
        ? new Date(b.latestActionDate).getTime()
        : 0;
      return dateB - dateA;
    });

    // Upsert into cache for search
    for (const [idx, bill] of bills.entries()) {
      const sourceBill = (data.results ?? [])[idx] ?? null;
      await upsertStateBill({ bill, sourceBill, jurisdiction });
    }

    return res.json({
      bills,
      totalCount: data.pagination?.total_items,
      offset,
    });
  } catch (err) {
    if (isProviderRateLimitError(err)) {
      req.log.warn({ err }, "State bills request blocked by provider rate limit");
      return sendProviderRateLimitError(res, err);
    }
    req.log.error({ err }, "Error fetching state bills");
    return sendInternalError(res);
  }
});

router.get("/state/bills/search", async (req, res) => {
  const parsed = SearchStateBillsQueryParams.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid query parameters" });
  }
  const { q, jurisdiction, chamber, stages, limit: rawLimit, offset } = parsed.data;
  if (!q.trim()) {
    return res.status(400).json({ error: "q must not be empty" });
  }
  const limit = Math.min(rawLimit, 100);
  const selectedStages = parseStageQuery(stages);

  try {
    const searchQuery = sql`websearch_to_tsquery('english', ${q})`;
    const conditions = [sql`(${stateBillsTable.searchVector} @@ ${searchQuery} OR ${q} % ${stateBillsTable.title})`];
    if (jurisdiction)
      conditions.push(eq(stateBillsTable.jurisdiction, jurisdiction));
    if (chamber)
      conditions.push(eq(stateBillsTable.chamber, chamber));
    const stageCondition =
      selectedStages.length > 0
        ? or(...selectedStages.map((stage) => eq(stateStageColumn(stage), true)))
        : undefined;
    if (stageCondition)
      conditions.push(stageCondition);

    const [countResult, rows] = await Promise.all([
      db.select({ count: sql<number>`count(*)` }).from(stateBillsTable).where(and(...conditions)),
      db.select().from(stateBillsTable).where(and(...conditions))
        .orderBy(sql`GREATEST(ts_rank(${stateBillsTable.searchVector}, ${searchQuery}), similarity(${q}, ${stateBillsTable.title})) desc`)
        .limit(limit)
        .offset(offset),
    ]);

    const dbCount = Number(countResult[0]?.count ?? 0);

    if (dbCount > 0 || offset > 0) {
      req.log.info(
        { q, jurisdiction, chamber, stages, totalCount: dbCount, source: "db" },
        "Serving state bill search from DB cache",
      );
      return res.json({ bills: rows.map(mapDbStateBillRow), totalCount: dbCount, offset });
    }

    // DB cache miss — fall through to OpenStates full-text search
    req.log.info(
      { q, jurisdiction, chamber, source: "openstates" },
      "State bill search DB miss; querying OpenStates",
    );

    const params: Record<string, string | number> = {
      q,
      per_page: limit,
      page: 1,
    };
    if (jurisdiction) params.jurisdiction = jurisdiction;
    if (chamber) params.chamber = chamber;

    const data = await openStatesFetch("/bills", params);
    const sourceBills: any[] = data.results ?? [];
    let bills = sourceBills.map(mapStateBill);

    // Upsert into DB so subsequent pages and repeated searches hit the cache
    for (const [idx, bill] of bills.entries()) {
      const sourceBill = sourceBills[idx];
      const billJurisdiction =
        jurisdiction ??
        sourceBill?.jurisdiction?.name ??
        sourceBill?.jurisdiction ??
        "unknown";
      await upsertStateBill({ bill, sourceBill, jurisdiction: billJurisdiction });
    }

    // Stage filters are derived from action text — apply in memory since OpenStates
    // doesn't expose stage boolean fields directly.
    if (selectedStages.length > 0) {
      bills = bills.filter((bill) => {
        const flags = computeLegislationStageFlags({
          latestAction: bill.latestAction,
          status: bill.status,
          introducedDate: bill.introducedDate,
        });
        return selectedStages.some((stage) => flags[stage]);
      });
    }

    const totalCount = selectedStages.length > 0
      ? bills.length
      : Number(data.pagination?.total_items ?? bills.length);

    req.log.info(
      { q, jurisdiction, totalCount, source: "openstates" },
      "Served state bill search from OpenStates",
    );

    return res.json({ bills: bills.slice(0, limit), totalCount, offset: 0 });
  } catch (err) {
    if (isProviderRateLimitError(err)) {
      req.log.warn({ err }, "State bill search blocked by provider rate limit");
      return sendProviderRateLimitError(res, err);
    }
    req.log.error({ err }, "Error searching state bills");
    return sendInternalError(res);
  }
});

// Bill IDs are "ocd-bill/<uuid>" — frontend URL-encodes them
async function fetchStateBillFromOpenStates(billId: string) {
  const url = new URL(`https://v3.openstates.org/bills/${billId}`);
  url.searchParams.set("include", "votes");
  url.searchParams.append("include", "sponsorships");
  url.searchParams.append("include", "actions");
  const res = await fetch(url.toString(), {
    headers: { "X-API-KEY": OPENSTATES_API_KEY! },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`OpenStates API error ${res.status}: ${text}`);
  }
  return res.json() as Promise<any>;
}

async function upsertStateBillFromApi(data: any) {
  const latestAction = data.actions?.[data.actions.length - 1];
  const introducedDate =
    data.first_action_date ?? data.created_at?.split("T")[0] ?? null;
  const actionHistoryText = Array.isArray(data.actions)
    ? data.actions.map((action: any) => action?.description).filter(Boolean).join(" ")
    : "";
  const stageFlags = computeLegislationStageFlags({
    latestAction: latestAction?.description,
    status: actionHistoryText,
    introducedDate,
  });
  const subjects = Array.isArray(data.subject)
    ? data.subject
    : data.subject
      ? [data.subject]
      : [];
  const subjectsText = subjects.join(" ");

  await db
    .insert(stateBillsTable)
    .values({
      id: data.id,
      identifier: data.identifier ?? null,
      title: data.title ?? "Untitled",
      session: data.legislative_session ?? null,
      chamber: data.from_organization?.classification ?? null,
      status: latestAction?.description ?? null,
      introducedDate,
      stageIntroduced: stageFlags.introduced,
      stageCommittee: stageFlags.committee,
      stageFloorVote: stageFlags.floor_vote,
      stagePassed: stageFlags.passed,
      stageSignedEnacted: stageFlags.signed_enacted,
      stageDead: stageFlags.dead,
      summary: data.abstract ?? null,
      subjects,
      url: data.openstates_url ?? null,
      textUrl: data.openstates_url ?? null,
      jurisdiction: data.jurisdiction?.name ?? data.jurisdiction ?? "",
      raw: data,
      searchVector: sql`setweight(to_tsvector('english', coalesce(${data.title ?? ""}, '')), 'A') || setweight(to_tsvector('english', coalesce(${data.identifier ?? ""}, '')), 'B') || setweight(to_tsvector('english', coalesce(${subjectsText}, '')), 'C') || setweight(to_tsvector('english', coalesce(${data.abstract ?? ""}, '')), 'C')`,
    })
    .onConflictDoUpdate({
      target: stateBillsTable.id,
      set: {
        title: data.title ?? "Untitled",
        identifier: data.identifier ?? null,
        status: latestAction?.description ?? null,
        introducedDate,
        stageIntroduced: stageFlags.introduced,
        stageCommittee: stageFlags.committee,
        stageFloorVote: stageFlags.floor_vote,
        stagePassed: stageFlags.passed,
        stageSignedEnacted: stageFlags.signed_enacted,
        stageDead: stageFlags.dead,
        summary: data.abstract ?? null,
        subjects,
        url: data.openstates_url ?? null,
        textUrl: data.openstates_url ?? null,
        jurisdiction: data.jurisdiction?.name ?? data.jurisdiction ?? "",
        raw: sql`COALESCE(state_bills.raw, '{}'::jsonb) || ${JSON.stringify(data)}::jsonb`,
        fetchedAt: new Date(),
        searchVector: sql`setweight(to_tsvector('english', coalesce(${data.title ?? ""}, '')), 'A') || setweight(to_tsvector('english', coalesce(${data.identifier ?? ""}, '')), 'B') || setweight(to_tsvector('english', coalesce(${subjectsText}, '')), 'C') || setweight(to_tsvector('english', coalesce(${data.abstract ?? ""}, '')), 'C')`,
      },
    });

  return mapDbStateBillDetail({
    ...data,
    id: data.id,
    title: data.title ?? "Untitled",
    identifier: data.identifier ?? null,
    session: data.legislative_session ?? null,
    chamber: data.from_organization?.classification ?? null,
    status: latestAction?.description ?? null,
    introducedDate,
    summary: data.abstract ?? null,
    subjects,
    url: data.openstates_url ?? null,
    textUrl: data.openstates_url ?? null,
    jurisdiction: data.jurisdiction?.name ?? data.jurisdiction ?? "",
    raw: data,
    stageIntroduced: stageFlags.introduced,
    stageCommittee: stageFlags.committee,
    stageFloorVote: stageFlags.floor_vote,
    stagePassed: stageFlags.passed,
    stageSignedEnacted: stageFlags.signed_enacted,
    stageDead: stageFlags.dead,
    searchVector: null,
    fetchedAt: new Date(),
  } as any);
}

router.get("/state/bills/:billId", async (req, res) => {
  const billId = decodeURIComponent(req.params.billId);
  if (!billId) return res.status(400).json({ error: "billId required" });

  try {
    // 1. Try DB first
    const [row] = await db
      .select()
      .from(stateBillsTable)
      .where(eq(stateBillsTable.id, billId))
      .limit(1);

    if (row) {
      req.log.info({ billId, source: "db" }, "Serving state bill detail from DB");
      // Build a map of sponsor person IDs → legislator info for party enrichment
      const raw = (row.raw ?? {}) as any;
      const sponsorships = Array.isArray(raw.sponsorships) ? raw.sponsorships : [];
      const personIds = sponsorships
        .map((s: any) => s.person?.id ?? s.id)
        .filter((id: string | undefined): id is string => !!id);

      let legislatorMap = new Map<string, { party?: string | null }>();
      if (personIds.length > 0) {
        const legislators = await db
          .select({ id: stateLegislatorsTable.id, party: stateLegislatorsTable.party })
          .from(stateLegislatorsTable)
          .where(inArray(stateLegislatorsTable.id, personIds));
        for (const l of legislators) {
          legislatorMap.set(l.id, { party: l.party });
        }
      }

      return res.json(mapDbStateBillDetail(row, legislatorMap));
    }

    // 2. Cache miss → fetch from OpenStates
    req.log.info({ billId, source: "openstates" }, "Fetching state bill detail from OpenStates");
    const data = await fetchStateBillFromOpenStates(billId);
    const detail = await upsertStateBillFromApi(data);
    return res.json(detail);
  } catch (err) {
    if (isProviderRateLimitError(err)) {
      req.log.warn({ err }, "State bill detail request blocked by provider rate limit");
      return sendProviderRateLimitError(res, err);
    }
    req.log.error({ err }, "Error fetching state bill detail");
    return sendInternalError(res);
  }
});

async function handleStateMemberPhoto(req: any, res: any) {
  const memberId = getRequestedStateMemberPhotoId(req);
  if (!memberId) {
    sendPlaceholderPhoto(res);
    return;
  }

  try {
    const [row] = await db
      .select({ photoUrl: stateLegislatorsTable.photoUrl })
      .from(stateLegislatorsTable)
      .where(eq(stateLegislatorsTable.id, memberId));

    if (!row?.photoUrl) {
      sendPlaceholderPhoto(res);
      return;
    }

    const cached = await getCachedPhoto(row.photoUrl, memberId);
    if (cached) {
      res
        .set("Content-Type", cached.contentType)
        .set("Cache-Control", "public, max-age=31536000, immutable")
        .set("X-Photo-Stale", "0")
        .set("Content-Length", String(cached.buffer.length))
        .send(cached.buffer);
      return;
    }

    const upstream = await fetch(row.photoUrl, {
      headers: PHOTO_FETCH_HEADERS,
    });
    if (!upstream.ok) {
      req.log.warn({ memberId, photoUrl: row.photoUrl, status: upstream.status }, "Upstream photo unavailable; serving placeholder");
      sendPlaceholderPhoto(res, { stale: true });
      return;
    }

    const contentType = upstream.headers.get("content-type") ?? "image/jpeg";
    if (!contentType.startsWith("image/")) {
      sendPlaceholderPhoto(res, { stale: true });
      return;
    }

    const buffer = Buffer.from(await upstream.arrayBuffer());
    if (buffer.length === 0) {
      sendPlaceholderPhoto(res, { stale: true });
      return;
    }

    await setCachedPhoto(row.photoUrl, memberId, buffer, contentType);

    res
      .set("Content-Type", contentType)
      .set("Cache-Control", "public, max-age=31536000, immutable")
      .set("X-Photo-Stale", "0")
      .set("Content-Length", String(buffer.length))
      .send(buffer);
  } catch (err) {
    req.log.error({ err, memberId }, "State member photo failed; serving placeholder");
    sendPlaceholderPhoto(res, { stale: true });
  }
}

// Proxy OpenStates member photos with a 1-year immutable cache.
router.get("/state/member-photo", handleStateMemberPhoto);
router.get(/^\/state\/member-photo\/(.+)$/, (req, res, next) => {
  req.params.memberId = req.params[0];
  void handleStateMemberPhoto(req, res).catch(next);
});

export default router;
