export const LEGISLATION_STAGE_KEYS = [
  "introduced",
  "committee",
  "floor_vote",
  "passed",
  "signed_enacted",
  "dead",
] as const;

export type LegislationStageKey = (typeof LEGISLATION_STAGE_KEYS)[number];
export const LEGISLATION_FILTER_KEYS = [
  ...LEGISLATION_STAGE_KEYS,
  "active",
] as const;
export type LegislationFilterKey = (typeof LEGISLATION_FILTER_KEYS)[number];

export type LegislationStageFlags = Record<LegislationStageKey, boolean>;

export const EMPTY_STAGE_FLAGS: LegislationStageFlags = {
  introduced: false,
  committee: false,
  floor_vote: false,
  passed: false,
  signed_enacted: false,
  dead: false,
};

export const ENACTED_TEXT_PATTERN =
  /(signed|became public law|became private law|became law|public law|private law|enacted|approved by the governor)/i;
export const NOT_AGREED_TO_PATTERN = /\bnot agreed to\b/i;
export const COMMITTEE_TEXT_PATTERN = /(committee|referred|reported)/i;
export const FLOOR_VOTE_TEXT_PATTERN = /\b(roll|yea|nay|vote|floor)\b|agreed to/i;
export const PASSED_TEXT_PATTERN =
  /(passed house|passed senate|passed\/agreed|agreed to in house|agreed to in senate|passed by|passed enrolled|returned passed|third reading passed|adopted|adopted by)/i;
export const DEAD_TEXT_PATTERN =
  /(died|dead|failed|vetoed|tabled indefinitely|indefinitely postponed|withdrawn)/i;

export function isEnactedOutcomeText(text: string): boolean {
  return ENACTED_TEXT_PATTERN.test(text);
}

export function finalizeFederalStageFlags(
  stageFlags: LegislationStageFlags,
  congress?: string | number | null,
  currentCongress = Math.floor((new Date().getFullYear() - 1789) / 2) + 1,
): LegislationStageFlags {
  const normalizedCongress =
    congress == null ? currentCongress : Number(congress);

  if (stageFlags.signed_enacted) {
    return { ...stageFlags, dead: false };
  }

  const dead =
    stageFlags.dead ||
    (Number.isFinite(normalizedCongress) && normalizedCongress < currentCongress);

  return { ...stageFlags, dead };
}

export function computeLegislationStageFlags({
  latestAction,
  status,
  introducedDate,
}: {
  latestAction?: string | null;
  status?: string | null;
  introducedDate?: string | null;
}): LegislationStageFlags {
  const text = `${latestAction ?? ""} ${status ?? ""}`.toLowerCase();
  const introduced = !!introducedDate || text.length >= 0;
  const committee = COMMITTEE_TEXT_PATTERN.test(text);
  const floorVote = FLOOR_VOTE_TEXT_PATTERN.test(text);
  const signedOrEnacted = isEnactedOutcomeText(text);
  // "not agreed to in Senate/House" is a failed vote — must be excluded before
  // testing "agreed to in Senate/House" or the substring match produces a false positive.
  const notAgreedTo = NOT_AGREED_TO_PATTERN.test(text);
  const passed =
    !notAgreedTo &&
    (signedOrEnacted || PASSED_TEXT_PATTERN.test(text));
  const dead = !signedOrEnacted && (notAgreedTo || DEAD_TEXT_PATTERN.test(text));

  return {
    introduced,
    committee,
    floor_vote: floorVote,
    passed,
    signed_enacted: signedOrEnacted,
    dead,
  };
}

export function isActiveLegislation(flags: LegislationStageFlags): boolean {
  return !flags.dead && !flags.signed_enacted;
}

export function matchesLegislationFilters(
  selectedFilters: LegislationFilterKey[],
  flags: LegislationStageFlags,
): boolean {
  return selectedFilters.some((filter) =>
    filter === "active" ? isActiveLegislation(flags) : flags[filter],
  );
}

export function parseStageQuery(raw?: string | null): LegislationFilterKey[] {
  if (!raw) return [];
  const allowed = new Set<string>(LEGISLATION_FILTER_KEYS);
  return raw
    .split(",")
    .map((stage) => stage.trim())
    .filter((stage): stage is LegislationFilterKey => allowed.has(stage));
}
