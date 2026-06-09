import { requireUsStateCode } from "./usStateCodes";

export interface NormalizedOpenStatesStateLegislator {
  id: string;
  name: string;
  party: string | null;
  chamber: string | null;
  district: string | null;
  photoUrl: string | null;
  email: string | null;
  phone: string | null;
  openstatesUrl: string | null;
  state: string;
  raw: unknown;
}

export function normalizeOpenStatesStateLegislator(person: any): NormalizedOpenStatesStateLegislator {
  const role = person?.current_role ?? {};
  const state = requireUsStateCode(
    person?.jurisdiction?.id ?? person?.jurisdiction?.name ?? person?.state,
    `state legislator ${person?.id ?? "unknown"}`,
  );

  return {
    id: person?.id ?? "",
    name: person?.name ?? "",
    party: person?.party ?? person?.primary_party ?? null,
    chamber:
      role.org_classification === "upper"
        ? "Senate"
        : role.org_classification === "lower"
          ? "House of Delegates"
          : null,
    district: role.district ? String(role.district) : null,
    photoUrl: person?.image ?? null,
    email: person?.email ?? null,
    phone: person?.links?.[0]?.url ?? null,
    openstatesUrl: person?.openstates_url ?? null,
    state,
    raw: person,
  };
}
