/**
 * Shared utilities for normalizing Congress.gov member data.
 * Used by both the federal route handler and the member ingestion pipeline.
 */

import { stateNameToCode } from "../routes/representativesUtils";

/**
 * Congress.gov returns member names in "Last, First" order.
 * Convert to display order "First Last".
 */
export function formatCongressMemberName(name: string): string {
  const parts = name.split(", ");
  if (parts.length === 2) return `${parts[1]} ${parts[0]}`;
  return name;
}

/**
 * Congress.gov uses different structures for the terms field depending on
 * whether the data came from a list endpoint or a detail endpoint:
 *   - list:   member.terms = { item: [...] }
 *   - detail: member.terms = [...]
 * Normalizes both to a plain array. Falls back to depictedTerms if present.
 */
export function normalizeCongressTerms(member: any): any[] {
  const raw = member?.terms?.item ?? member?.terms ?? member?.depictedTerms;
  if (!raw) return [];
  return Array.isArray(raw) ? raw : [raw];
}

export type NormalizedCongressMember = {
  bioguideId: string;
  name: string;
  party: string | null;
  state: string | null;
  chamber: string | null;
  district: string | null;
  phone: string | null;
  website: string | null;
  photoUrl: string | null;
  terms: number | null;
  inOffice: boolean | null;
  nextElection: string | null;
};

function normalizeCongressChamber(member: any): string | null {
  const chamber = normalizeCongressTerms(member).slice(-1)[0]?.chamber ?? "";
  if (chamber === "Senate") return "Senate";
  if (typeof chamber === "string" && chamber.toLowerCase().includes("house")) {
    return "House";
  }
  return null;
}

function normalizeCongressState(member: any): string | null {
  const latestTerm = normalizeCongressTerms(member).slice(-1)[0];
  const rawState =
    member?.state ??
    latestTerm?.stateCode ??
    latestTerm?.stateName ??
    null;
  if (!rawState || typeof rawState !== "string") return null;

  const normalized = stateNameToCode(rawState);
  if (normalized) return normalized;
  if (rawState.length === 2) return rawState.toUpperCase();
  return rawState;
}

export function normalizeCongressMember(member: any): NormalizedCongressMember {
  const latestTerm = normalizeCongressTerms(member).slice(-1)[0];
  const nameSource =
    member?.directOrderName ??
    member?.name ??
    member?.invertedOrderName ??
    "";

  return {
    bioguideId: member?.bioguideId ?? "",
    name: formatCongressMemberName(nameSource),
    party:
      member?.partyHistory?.[0]?.partyName ??
      member?.partyName ??
      null,
    state: normalizeCongressState(member),
    chamber: normalizeCongressChamber(member),
    district:
      member?.district != null
        ? String(member.district)
        : latestTerm?.district != null
          ? String(latestTerm.district)
          : null,
    phone:
      member?.addressInformation?.phoneNumber ??
      member?.phoneNumber ??
      member?.officeAddress ??
      member?.addressInformation?.officeAddress ??
      null,
    website: member?.officialWebsiteUrl ?? null,
    photoUrl: member?.depiction?.imageUrl ?? null,
    terms: normalizeCongressTerms(member).length,
    inOffice:
      typeof member?.currentMember === "boolean" ? member.currentMember : null,
    nextElection: member?.nextElection ?? null,
  };
}
