export interface StateInfo {
  code: string;
  name: string;
}

export const US_STATES: StateInfo[] = [
  { code: "AL", name: "Alabama" },
  { code: "AK", name: "Alaska" },
  { code: "AZ", name: "Arizona" },
  { code: "AR", name: "Arkansas" },
  { code: "CA", name: "California" },
  { code: "CO", name: "Colorado" },
  { code: "CT", name: "Connecticut" },
  { code: "DE", name: "Delaware" },
  { code: "FL", name: "Florida" },
  { code: "GA", name: "Georgia" },
  { code: "HI", name: "Hawaii" },
  { code: "ID", name: "Idaho" },
  { code: "IL", name: "Illinois" },
  { code: "IN", name: "Indiana" },
  { code: "IA", name: "Iowa" },
  { code: "KS", name: "Kansas" },
  { code: "KY", name: "Kentucky" },
  { code: "LA", name: "Louisiana" },
  { code: "ME", name: "Maine" },
  { code: "MD", name: "Maryland" },
  { code: "MA", name: "Massachusetts" },
  { code: "MI", name: "Michigan" },
  { code: "MN", name: "Minnesota" },
  { code: "MS", name: "Mississippi" },
  { code: "MO", name: "Missouri" },
  { code: "MT", name: "Montana" },
  { code: "NE", name: "Nebraska" },
  { code: "NV", name: "Nevada" },
  { code: "NH", name: "New Hampshire" },
  { code: "NJ", name: "New Jersey" },
  { code: "NM", name: "New Mexico" },
  { code: "NY", name: "New York" },
  { code: "NC", name: "North Carolina" },
  { code: "ND", name: "North Dakota" },
  { code: "OH", name: "Ohio" },
  { code: "OK", name: "Oklahoma" },
  { code: "OR", name: "Oregon" },
  { code: "PA", name: "Pennsylvania" },
  { code: "RI", name: "Rhode Island" },
  { code: "SC", name: "South Carolina" },
  { code: "SD", name: "South Dakota" },
  { code: "TN", name: "Tennessee" },
  { code: "TX", name: "Texas" },
  { code: "UT", name: "Utah" },
  { code: "VT", name: "Vermont" },
  { code: "VA", name: "Virginia" },
  { code: "WA", name: "Washington" },
  { code: "WV", name: "West Virginia" },
  { code: "WI", name: "Wisconsin" },
  { code: "WY", name: "Wyoming" },
  { code: "DC", name: "District of Columbia" },
  { code: "PR", name: "Puerto Rico" },
  { code: "GU", name: "Guam" },
  { code: "VI", name: "U.S. Virgin Islands" },
  { code: "AS", name: "American Samoa" },
  { code: "MP", name: "Northern Mariana Islands" },
];

export function getStateName(code?: string | null): string | undefined {
  if (!code) return undefined;
  return US_STATES.find((s) => s.code === code.toUpperCase())?.name;
}

export function getStateCode(nameOrCode?: string | null): string | undefined {
  if (!nameOrCode) return undefined;
  const upper = nameOrCode.toUpperCase();
  if (US_STATES.find((s) => s.code === upper)) return upper;
  if (upper === "VIRGIN ISLANDS") return "VI";
  return US_STATES.find((s) => s.name.toUpperCase() === upper)?.code;
}

export function getStateFlagUrl(code?: string | null): string | undefined {
  if (!code) return undefined;
  const upper = code.toUpperCase();
  if (upper === "US") return "/flags/Flag_of_the_United_States.svg";
  const name = getStateName(upper);
  if (!name) return undefined;
  return `/flags/Flag_of_${name.replace(/ /g, "_")}.svg`;
}
