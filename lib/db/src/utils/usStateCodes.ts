const US_STATE_NAMES: Record<string, string> = {
  AL: "Alabama",
  AK: "Alaska",
  AZ: "Arizona",
  AR: "Arkansas",
  CA: "California",
  CO: "Colorado",
  CT: "Connecticut",
  DE: "Delaware",
  FL: "Florida",
  GA: "Georgia",
  HI: "Hawaii",
  ID: "Idaho",
  IL: "Illinois",
  IN: "Indiana",
  IA: "Iowa",
  KS: "Kansas",
  KY: "Kentucky",
  LA: "Louisiana",
  ME: "Maine",
  MD: "Maryland",
  MA: "Massachusetts",
  MI: "Michigan",
  MN: "Minnesota",
  MS: "Mississippi",
  MO: "Missouri",
  MT: "Montana",
  NE: "Nebraska",
  NV: "Nevada",
  NH: "New Hampshire",
  NJ: "New Jersey",
  NM: "New Mexico",
  NY: "New York",
  NC: "North Carolina",
  ND: "North Dakota",
  OH: "Ohio",
  OK: "Oklahoma",
  OR: "Oregon",
  PA: "Pennsylvania",
  RI: "Rhode Island",
  SC: "South Carolina",
  SD: "South Dakota",
  TN: "Tennessee",
  TX: "Texas",
  UT: "Utah",
  VT: "Vermont",
  VA: "Virginia",
  WA: "Washington",
  WV: "West Virginia",
  WI: "Wisconsin",
  WY: "Wyoming",
  DC: "District of Columbia",
  PR: "Puerto Rico",
  GU: "Guam",
  VI: "U.S. Virgin Islands",
  AS: "American Samoa",
  MP: "Northern Mariana Islands",
};

const STATE_NAME_TO_CODE: Record<string, string> = Object.fromEntries(
  Object.entries(US_STATE_NAMES).map(([code, name]) => [name.toLowerCase(), code]),
);

STATE_NAME_TO_CODE["virgin islands"] = "VI";

export function getUsStateName(code: string): string | undefined {
  return US_STATE_NAMES[code.trim().toUpperCase()];
}

export function normalizeUsStateCode(value: string | null | undefined): string | null {
  if (!value) return null;

  const trimmed = value.trim();
  if (!trimmed) return null;

  const directCode = trimmed.toUpperCase();
  if (/^[A-Z]{2}$/.test(directCode) && US_STATE_NAMES[directCode]) {
    return directCode;
  }

  const jurisdictionMatch = trimmed.match(
    /^ocd-jurisdiction\/country:us\/(?:(?:state:([a-z]{2}))|(?:district:dc))\/government$/i,
  );
  if (jurisdictionMatch) {
    return (jurisdictionMatch[1] ?? "DC").toUpperCase();
  }

  return STATE_NAME_TO_CODE[trimmed.toLowerCase()] ?? null;
}

export function requireUsStateCode(value: string | null | undefined, context: string): string {
  const normalized = normalizeUsStateCode(value);
  if (!normalized) {
    throw new Error(`Unable to normalize state code for ${context}`);
  }
  return normalized;
}
