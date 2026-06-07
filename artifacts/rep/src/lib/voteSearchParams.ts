export const VOTE_FILTER_VALUES = [
  "all",
  "yea",
  "nay",
  "present",
  "not-voting",
] as const;

export type VoteFilter = (typeof VOTE_FILTER_VALUES)[number];

export type VoteSearchState = {
  filter: VoteFilter;
  offset: number;
  q: string;
};

type VoteSearchPatch = Partial<VoteSearchState> & {
  tab?: string | null;
};

const VALID_VOTE_FILTERS = new Set<string>(VOTE_FILTER_VALUES);

export function isVoteFilter(value: string | null | undefined): value is VoteFilter {
  return value != null && VALID_VOTE_FILTERS.has(value);
}

export function normalizeVoteOffset(value: string | number | null | undefined): number {
  const numericValue =
    typeof value === "number" ? value : Number(value ?? "0");
  return Number.isFinite(numericValue) && numericValue >= 0 ? numericValue : 0;
}

export function parseVoteSearchState(search: string): VoteSearchState {
  const params = new URLSearchParams(search);
  const filterParam = params.get("filter");
  return {
    filter: isVoteFilter(filterParam) ? filterParam : "all",
    offset: normalizeVoteOffset(params.get("offset")),
    q: params.get("q") ?? "",
  };
}

export function buildVoteSearch(search: string, patch: VoteSearchPatch): string {
  const params = new URLSearchParams(search);

  if (patch.tab === null) {
    params.delete("tab");
  } else if (patch.tab !== undefined) {
    params.set("tab", patch.tab);
  }

  if (patch.filter !== undefined) {
    if (patch.filter === "all") {
      params.delete("filter");
    } else {
      params.set("filter", patch.filter);
    }
  }

  if (patch.offset !== undefined) {
    const normalizedOffset = normalizeVoteOffset(patch.offset);
    if (normalizedOffset === 0) {
      params.delete("offset");
    } else {
      params.set("offset", String(normalizedOffset));
    }
  }

  if (patch.q !== undefined) {
    const normalizedQuery = patch.q.trim();
    if (normalizedQuery) {
      params.set("q", normalizedQuery);
    } else {
      params.delete("q");
    }
  }

  const serialized = params.toString();
  return serialized ? `?${serialized}` : "";
}
