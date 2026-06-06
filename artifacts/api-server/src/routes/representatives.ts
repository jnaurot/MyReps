import { Router } from "express";
import { and, eq } from "drizzle-orm";
import { GetRepresentativesByAddressQueryParams } from "@workspace/api-zod";
import { db, federalMembersTable } from "@workspace/db";
import { getDistrictLegislators } from "../lib/stateLegislatorCache";
import { fetchWithTimeout as fetch } from "../lib/http";
import { sendInternalError } from "../lib/respond";
import {
  formatCongressName,
  getStateName,
  normalizeCensusDistrict,
  stateMemberPhotoUrl,
} from "./representativesUtils";

const router = Router();

const CONGRESS_API_KEY = process.env.CONGRESS_API_KEY;

async function geocodeAddress(address: string): Promise<{
  lat: number;
  lng: number;
  district: string | null;
  stateCode: string | null;
  stateSenateDistrict: string | null;
  stateHouseDistrict: string | null;
  normalizedAddress: string | null;
}> {
  const url = new URL(
    "https://geocoding.geo.census.gov/geocoder/geographies/onelineaddress",
  );
  url.searchParams.set("address", address);
  url.searchParams.set("benchmark", "Public_AR_Current");
  url.searchParams.set("vintage", "Current_Current");
  url.searchParams.set("layers", "all");
  url.searchParams.set("format", "json");

  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`Census geocoder error ${res.status}`);
  const data = (await res.json()) as any;

  const match = data.result?.addressMatches?.[0];
  if (!match) throw new Error("Address not found");

  const lat = match.coordinates?.y;
  const lng = match.coordinates?.x;
  const geos = match.geographies ?? {};

  const congressionalKey = Object.keys(geos).find((k) =>
    k.includes("Congressional Districts"),
  );
  const congressional = congressionalKey ? geos[congressionalKey]?.[0] : null;
  const district = congressional?.BASENAME ?? null;

  const addr = match.addressComponents;
  const stateCode = addr?.state ?? null;

  // Census returns year-prefixed keys like "2024 State Legislative Districts - Upper"
  const upperKey = Object.keys(geos).find((k) =>
    k.includes("State Legislative Districts - Upper"),
  );
  const lowerKey = Object.keys(geos).find((k) =>
    k.includes("State Legislative Districts - Lower"),
  );
  // BASENAME is the plain district number (e.g., "40"); SLDU/SLDL are Census codes (e.g., "040")
  const upperRaw = upperKey
    ? (geos[upperKey]?.[0]?.BASENAME ?? geos[upperKey]?.[0]?.SLDU ?? null)
    : null;
  const lowerRaw = lowerKey
    ? (geos[lowerKey]?.[0]?.BASENAME ?? geos[lowerKey]?.[0]?.SLDL ?? null)
    : null;
  // Strip any remaining leading zeros
  const upperDistrict = normalizeCensusDistrict(upperRaw);
  const lowerDistrict = normalizeCensusDistrict(lowerRaw);

  const normalizedAddress = addr
    ? `${addr.fromAddress ?? ""} ${addr.preDirection ?? ""} ${addr.streetName ?? ""} ${addr.suffixType ?? ""}, ${addr.city ?? ""}, ${addr.state ?? ""} ${addr.zip ?? ""}`
        .replace(/\s+/g, " ")
        .trim()
    : null;

  return {
    lat,
    lng,
    district,
    stateCode,
    stateSenateDistrict: upperDistrict,
    stateHouseDistrict: lowerDistrict,
    normalizedAddress,
  };
}

function mapDbRowToFederalRep(row: typeof federalMembersTable.$inferSelect, stateCode: string, district: string) {
  const isSenate = row.chamber === "Senate";
  return {
    name: row.name,
    office: isSenate
      ? `U.S. Senator for ${stateCode}`
      : `U.S. Representative, ${stateCode}-${district}`,
    party: row.party ?? undefined,
    photoUrl: row.photoUrl ?? undefined,
    level: "federal" as const,
    chamber: row.chamber ?? undefined,
    bioguideId: row.bioguideId,
    district: row.district ?? undefined,
  };
}

async function fetchCongressMembersLive(stateCode: string, district: string): Promise<any[]> {
  if (!CONGRESS_API_KEY) return [];
  try {
    const senatorsUrl = new URL(`https://api.congress.gov/v3/member/${stateCode}`);
    senatorsUrl.searchParams.set("currentMember", "true");
    senatorsUrl.searchParams.set("limit", "20");
    senatorsUrl.searchParams.set("api_key", CONGRESS_API_KEY);
    senatorsUrl.searchParams.set("format", "json");

    const senatorsRes = await fetch(senatorsUrl.toString());
    const senatorsData = senatorsRes.ok ? ((await senatorsRes.json()) as any) : { members: [] };
    const senators = (senatorsData.members ?? []).filter((m: any) => {
      if (m.district) return false;
      const terms: any[] = Array.isArray(m.terms) ? m.terms : (m.terms?.item ?? []);
      return terms.some((t: any) => t.chamber === "Senate" && !t.endYear);
    });

    let houseMember: any[] = [];
    if (district) {
      const districtNum = parseInt(district, 10);
      const houseUrl = new URL(`https://api.congress.gov/v3/member/${stateCode}/${districtNum}`);
      houseUrl.searchParams.set("currentMember", "true");
      houseUrl.searchParams.set("api_key", CONGRESS_API_KEY);
      houseUrl.searchParams.set("format", "json");
      const houseRes = await fetch(houseUrl.toString());
      if (houseRes.ok) {
        const houseData = (await houseRes.json()) as any;
        houseMember = (houseData.members ?? []).filter(
          (m: any) => m.district == null || String(m.district) === String(districtNum),
        );
      }
    }

    return [...senators, ...houseMember].map((m: any) => {
      const terms: any[] = Array.isArray(m.terms) ? m.terms : (m.terms?.item ?? []);
      const latestTerm = terms.slice(-1)[0];
      const isSenate = latestTerm?.chamber === "Senate";
      return {
        name: formatCongressName(m.name),
        office: isSenate
          ? `U.S. Senator for ${stateCode}`
          : `U.S. Representative, ${stateCode}-${district}`,
        party: m.partyName,
        photoUrl: m.depiction?.imageUrl,
        level: "federal" as const,
        chamber: isSenate ? "Senate" : "House",
        bioguideId: m.bioguideId,
        district: m.district ? String(m.district) : undefined,
      };
    });
  } catch {
    return [];
  }
}

async function fetchCongressMembers(
  stateCode: string,
  district: string,
): Promise<any[]> {
  try {
    const senators = await db
      .select()
      .from(federalMembersTable)
      .where(
        and(
          eq(federalMembersTable.state, stateCode),
          eq(federalMembersTable.chamber, "Senate"),
          eq(federalMembersTable.inOffice, true),
        ),
      );

    let houseRows: typeof senators = [];
    if (district) {
      const districtNum = parseInt(district, 10);
      houseRows = await db
        .select()
        .from(federalMembersTable)
        .where(
          and(
            eq(federalMembersTable.state, stateCode),
            eq(federalMembersTable.district, String(districtNum)),
            eq(federalMembersTable.chamber, "House"),
            eq(federalMembersTable.inOffice, true),
          ),
        );
    }

    const dbResults = [...senators, ...houseRows];
    if (dbResults.length > 0) {
      return dbResults.map((row) => mapDbRowToFederalRep(row, stateCode, district));
    }
  } catch {
    // fall through to live fetch
  }

  // Fallback to Congress.gov if DB is empty (e.g. ingestion hasn't run yet)
  return fetchCongressMembersLive(stateCode, district);
}

async function fetchStateLegislators(
  stateCode: string,
  stateSenateDistrict: string | null,
  stateHouseDistrict: string | null,
  logger?: any,
): Promise<{ stateReps: any[]; cache: any }> {
  try {
    const { legislators, cache } = await getDistrictLegislators(
      stateCode,
      stateSenateDistrict,
      stateHouseDistrict,
      logger,
    );
    const stateReps = legislators.map((person) => ({
      name: person.name ?? "",
      office: person.chamber === "Senate" ? "State Senator" : "State Delegate",
      party: person.party,
      photoUrl: stateMemberPhotoUrl(person.id, !!person.photoUrl),
      rawPhotoUrl: person.photoUrl ?? undefined,
      level: "state" as const,
      chamber: person.chamber,
      openstatesId: person.id,
      district: person.district ?? undefined,
    }));
    return { stateReps, cache };
  } catch (e) {
    logger?.error({ err: e }, "Error fetching state legislators");
    return {
      stateReps: [],
      cache: {
        source: "db",
        stale: false,
        fetchedAt: new Date().toISOString(),
      },
    };
  }
}

router.get("/representatives", async (req, res) => {
  const parsed = GetRepresentativesByAddressQueryParams.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: "address is required" });
  }

  const { address } = parsed.data;

  try {
    const geo = await geocodeAddress(address);
    const stateCode = geo.stateCode ?? "";

    if (!geo.stateSenateDistrict && !geo.stateHouseDistrict) {
      req.log.warn(
        { stateCode },
        "Census geocoder returned no state legislative districts",
      );
    }

    const [federalReps, stateResult] = await Promise.all([
      fetchCongressMembers(stateCode, geo.district ?? ""),
      fetchStateLegislators(
        stateCode,
        geo.stateSenateDistrict,
        geo.stateHouseDistrict,
        req.log,
      ),
    ]);

    const representatives = [...federalReps, ...stateResult.stateReps];

    return res.json({
      address,
      normalizedAddress: geo.normalizedAddress,
      stateCode,
      stateName: getStateName(stateCode) ?? stateCode,
      stateSenateDistrict: geo.stateSenateDistrict,
      stateHouseDistrict: geo.stateHouseDistrict,
      representatives,
      stateRepCache: stateResult.cache,
    });
  } catch (err) {
    req.log.error({ err }, "Error fetching representatives");
    return sendInternalError(res);
  }
});

export default router;
