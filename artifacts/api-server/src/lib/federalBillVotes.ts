export interface FederalBillVoteEntry {
  date: string;
  chamber: string;
  rollNumber?: string | number;
  result: string;
  yesCount?: number;
  noCount?: number;
  presentCount?: number;
  sourceUrl?: string;
}

function normalizeText(value?: string | null): string {
  return (value ?? "").trim();
}

function voteIdentity(vote: FederalBillVoteEntry): string {
  const date = normalizeText(vote.date);
  const chamber = normalizeText(vote.chamber).toLowerCase();
  const rollNumber = normalizeText(
    vote.rollNumber == null ? "" : String(vote.rollNumber),
  );
  const sourceUrl = normalizeText(vote.sourceUrl);
  const result = normalizeText(vote.result).toLowerCase();

  if (rollNumber) return `${date}|${chamber}|roll:${rollNumber}`;
  if (sourceUrl) return `${date}|${chamber}|url:${sourceUrl}`;
  return `${date}|${chamber}|result:${result}`;
}

function scoreVote(vote: FederalBillVoteEntry): number {
  let score = 0;
  if (normalizeText(vote.result)) score += Math.min(vote.result.length, 500);
  if (vote.rollNumber != null && String(vote.rollNumber).trim()) score += 100;
  if (normalizeText(vote.sourceUrl)) score += 50;
  if (vote.yesCount != null) score += 10;
  if (vote.noCount != null) score += 10;
  if (vote.presentCount != null) score += 10;
  return score;
}

function mergeVoteEntries(
  existing: FederalBillVoteEntry,
  incoming: FederalBillVoteEntry,
): FederalBillVoteEntry {
  const preferred =
    scoreVote(incoming) > scoreVote(existing) ? incoming : existing;
  const fallback = preferred === existing ? incoming : existing;

  return {
    date: normalizeText(preferred.date) || normalizeText(fallback.date),
    chamber:
      normalizeText(preferred.chamber) || normalizeText(fallback.chamber),
    rollNumber: preferred.rollNumber ?? fallback.rollNumber,
    result: normalizeText(preferred.result) || normalizeText(fallback.result),
    yesCount: preferred.yesCount ?? fallback.yesCount,
    noCount: preferred.noCount ?? fallback.noCount,
    presentCount: preferred.presentCount ?? fallback.presentCount,
    sourceUrl:
      normalizeText(preferred.sourceUrl) || normalizeText(fallback.sourceUrl),
  };
}

export function dedupeFederalBillVotes(
  votes: FederalBillVoteEntry[],
): FederalBillVoteEntry[] {
  const deduped = new Map<string, FederalBillVoteEntry>();

  for (const vote of votes) {
    const key = voteIdentity(vote);
    const existing = deduped.get(key);
    deduped.set(key, existing ? mergeVoteEntries(existing, vote) : vote);
  }

  return [...deduped.values()];
}
