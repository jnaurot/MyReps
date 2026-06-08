import { useRef, useState, useEffect } from "react";
import { useParams, Link, useSearch } from "wouter";
import {
  useGetStateBillDetail,
  getGetStateBillDetailQueryKey,
} from "@workspace/api-client-react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { ChevronLeft, ExternalLink, CheckCircle2, Circle, Bookmark } from "lucide-react";
import { Button } from "@/components/ui/button";
import { RepNameLink } from "@/components/RepNameLink";
import { SummarySearch } from "@/lib/rep-utils";
import { useBookmarks } from "@/hooks/useBookmarks";
import { ResizableDetailCard } from "@/components/ResizableDetailCard";
import { PartyStateBadgeRail } from "@/components/PartyStateBadgeRail";

type BillActionSummary = {
  date: string;
  text: string;
  type?: string;
  organizationName?: string;
  organizationClassification?: string;
};

type StateBillVoteSummary = {
  date: string;
  startDate?: string;
  chamber?: string;
  organizationName?: string;
  organizationClassification?: string;
  motionText?: string;
  motionClassification?: string[];
  sourceUrl?: string;
  result: string;
  yesCount?: number;
  noCount?: number;
  absentCount?: number;
};

function getActionStage(action: BillActionSummary) {
  const text = `${action.text} ${action.type ?? ""}`.toLowerCase();

  if (text.includes("approved by the governor") || text.includes("signed by governor") || text.includes("became law")) {
    return "Signed/Enacted";
  }
  if (text.includes("passed enrolled") || text.includes("third reading passed") || text.includes("returned passed") || text.includes("final passage")) {
    return "Passed";
  }
  if (/\b(vote|floor|yea|nay|roll)\b/.test(text) || text.includes("third reading")) {
    return "Floor Vote";
  }
  if (text.includes("committee") || text.includes("hearing") || text.includes("referral") || text.includes("referred")) {
    return "Committee";
  }
  if (text.includes("first reading") || text.includes("introduced")) {
    return "Introduced";
  }

  return undefined;
}

function getGovernorApproval(actions?: BillActionSummary[]) {
  const action = (actions ?? []).find((item) => /approved by the governor|signed by governor|became law/i.test(item.text));
  if (!action) return undefined;

  const chapter = action.text.match(/chapter\s+\d+/i)?.[0];
  return {
    date: action.date,
    chapter,
    text: action.text,
  };
}

function formatChamberName(value?: string) {
  if (value === "upper") return "Senate";
  if (value === "lower") return "House";
  return value;
}

function getVoteMotionLabel(vote: StateBillVoteSummary) {
  return vote.motionText?.replace(/^on\s+/i, "").trim();
}

function getReadingOrdinal(text?: string) {
  const match = text?.match(/\b(first|second|third)\s+reading\b/i);
  return match?.[1]?.toLowerCase();
}

function getVoteBodyClassification(vote: StateBillVoteSummary) {
  if (vote.organizationClassification) return vote.organizationClassification;
  if (vote.chamber === "upper" || vote.chamber === "lower") return vote.chamber;

  const sourceUrl = vote.sourceUrl?.toLowerCase();
  if (sourceUrl?.includes("/votes/senate/")) return "upper";
  if (sourceUrl?.includes("/votes/house/")) return "lower";

  const voteTotal = (vote.yesCount ?? 0) + (vote.noCount ?? 0) + (vote.absentCount ?? 0);
  if (voteTotal > 80) return "lower";
  if (voteTotal > 0 && voteTotal <= 60) return "upper";

  return undefined;
}

function findVoteAction(vote: StateBillVoteSummary, actions?: BillActionSummary[]) {
  const motionLabel = getVoteMotionLabel(vote)?.toLowerCase();
  const motionReading = getReadingOrdinal(motionLabel);
  const voteBody = getVoteBodyClassification(vote);
  const candidates = (actions ?? []).filter((action) => {
    const actionBody = action.organizationClassification;
    return !voteBody || !actionBody || actionBody === voteBody;
  });

  if (motionReading) {
    const readingMatch = candidates.find((action) => {
      const text = action.text.toLowerCase();
      return getReadingOrdinal(text) === motionReading && /pass|adopt|fail/i.test(action.text);
    });
    if (readingMatch) return readingMatch;
  }

  if (motionLabel) {
    const motionTerms = motionLabel.split(/\s+/).filter(Boolean);
    const motionMatch = candidates.find((action) => {
      const text = action.text.toLowerCase();
      return motionTerms.every((term) => text.includes(term)) && /pass|adopt|fail/i.test(action.text);
    });
    if (motionMatch) return motionMatch;
  }

  const sameDateMatch = vote.date
    ? candidates.find((action) => action.date === vote.date && getActionStage(action))
    : undefined;
  if (sameDateMatch) return sameDateMatch;

  return undefined;
}

function getVoteDisplay(vote: StateBillVoteSummary, actions?: BillActionSummary[]) {
  const action = findVoteAction(vote, actions);
  const body = vote.organizationName ?? formatChamberName(getVoteBodyClassification(vote) ?? vote.chamber);
  const motion = getVoteMotionLabel(vote);
  const stage = action?.text ?? motion ?? getActionStage(action ?? { date: vote.date, text: "", type: vote.motionClassification?.[0] }) ?? "Vote";
  const date = action?.date ?? vote.date;

  return {
    body,
    stage,
    date,
    actionText: action?.text,
  };
}

function formatChamberLabel(value?: string | null) {
  if (value === "lower") return "House";
  if (value === "upper") return "Senate";
  if (value === "executive") return "Governor";
  return value;
}

function StateBillProgressBar({ stages }: {
  stages?: {
    introduced?: boolean;
    committee?: boolean;
    floorVote?: boolean;
    passed?: boolean;
    signed?: boolean;
    enacted?: boolean;
    dead?: boolean;
    completedStages?: string[];
    currentStage?: string | null;
    currentChamber?: string | null;
  };
}) {
  const allStages = [
    { key: "introduced", label: "Introduced" },
    { key: "committee", label: "Committee" },
    { key: "floorVote", label: "Floor Vote" },
    { key: "passed", label: "Passed" },
    { key: "signed", label: "Signed / Enacted" },
  ] as const;

  const completed = new Set(stages?.completedStages ?? []);
  const current = stages?.currentStage;
  const currentChamber = stages?.currentChamber;

  if (stages?.dead) {
    return (
      <div className="flex items-center gap-2 mt-4 mb-6 p-3 bg-red-50 rounded-lg">
        <Circle className="h-5 w-5 text-red-600" />
        <span className="text-sm font-medium text-red-700">Bill died or failed</span>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-0 mt-4 mb-6">
      {allStages.map(({ key, label }, i) => {
        const isCompleted = completed.has(key) || (key === "signed" && completed.has("signed"));
        const isCurrent = current === key;
        const isLast = i === allStages.length - 1;
        const nextCompleted = completed.has(allStages[i + 1]?.key) || (allStages[i + 1]?.key === "signed" && completed.has("signed"));

        return (
          <div key={key} className="flex items-center flex-1">
            <div className="flex flex-col items-center">
              {isCompleted ? (
                <CheckCircle2 className="h-5 w-5 text-green-600" />
              ) : isCurrent ? (
                <Circle className="h-5 w-5 text-amber-500 fill-amber-500" />
              ) : (
                <Circle className="h-5 w-5 text-muted-foreground/30" />
              )}
              <span className={`text-[10px] mt-1 text-center leading-tight ${isCompleted || isCurrent ? "text-foreground font-medium" : "text-muted-foreground"}`}>
                {label}
                {isCurrent && currentChamber && currentChamber !== "both" ? (
                  <span className="block text-[9px] text-amber-600">{formatChamberLabel(currentChamber)}</span>
                ) : null}
              </span>
            </div>
            {!isLast && (
              <div className={`h-0.5 flex-1 mx-1 -mt-4 ${nextCompleted ? "bg-green-600" : isCurrent ? "bg-amber-300" : "bg-muted"}`} />
            )}
          </div>
        );
      })}
    </div>
  );
}

export function StateBillDetail() {
  const { billId } = useParams<{ billId: string }>();
  const apiBillId = encodeURIComponent(billId);
  const search = useSearch();
  const params = new URLSearchParams(search);
  const fromPath = params.get("from") ?? "/bills/state";
  const fromName = params.get("name");

  const { data: bill, isLoading } = useGetStateBillDetail(apiBillId, {
    query: {
      enabled: !!apiBillId,
      queryKey: getGetStateBillDetailQueryKey(apiBillId)
    }
  });
  const governorApproval = getGovernorApproval(bill?.actions);
  const { toggle, check } = useBookmarks();
  const bookmarked = check(billId);

  const profileRef = useRef<HTMLDivElement>(null);
  const [profileHeight, setProfileHeight] = useState(300);

  useEffect(() => {
    if (!profileRef.current) return;
    const el = profileRef.current;
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setProfileHeight(entry.contentRect.height);
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [bill]);

  return (
    <div className="h-full flex flex-col bg-muted/20">
      <div className="shrink-0 container mx-auto max-w-4xl px-4 py-3">
        <Link href={fromPath} className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors">
          <ChevronLeft className="h-4 w-4" /> {fromName ? `Back to ${fromName}` : "Back to State Bills"}
        </Link>
      </div>
      <div className="flex-1 overflow-y-auto">
        <div className="container mx-auto px-4 pb-16 max-w-4xl">
          {isLoading ? (
          <div className="space-y-4">
            <Skeleton className="h-48 w-full rounded-xl" />
            <Skeleton className="h-64 w-full rounded-xl" />
          </div>
        ) : bill ? (
          <div className="space-y-6">
            <Card ref={profileRef}>
              <CardContent className="p-6">
                <div className="flex items-start justify-between gap-2 mb-3">
                  <div className="flex flex-wrap gap-2">
                    {bill.identifier && <Badge variant="outline" className="font-mono">{bill.identifier}</Badge>}
                    {bill.chamber && (
                      <Badge variant="secondary">
                        {bill.chamber === "upper" ? "Senate" : bill.chamber === "lower" ? "House of Delegates" : bill.chamber}
                      </Badge>
                    )}
                    {bill.session && <Badge variant="secondary">{typeof bill.session === "string" && /^\d{4}$/.test(bill.session) ? `${bill.session} Session` : `Session ${bill.session}`}</Badge>}
                    {bill.introducedDate && <span className="text-sm text-muted-foreground">Introduced {bill.introducedDate}</span>}
                  </div>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="shrink-0 -mt-1 -mr-2"
                    aria-label={bookmarked ? "Remove bookmark" : "Save bill"}
                    onClick={() => toggle({ id: billId, type: "state", number: bill.identifier ?? billId, title: bill.title ?? "" })}
                  >
                    <Bookmark className={`h-5 w-5 ${bookmarked ? "fill-primary text-primary" : "text-muted-foreground"}`} />
                  </Button>
                </div>
                <h1 className="text-2xl font-black leading-tight mb-4">{bill.title}</h1>

                <StateBillProgressBar stages={bill.stages} />

                {bill.status && (
                  <div className="bg-muted/50 rounded-lg p-3 text-sm">
                    <span className="text-muted-foreground font-medium">Status: </span>
                    {governorApproval ? (
                      <>
                        <span>Approved by the Governor</span>
                        <span className="text-muted-foreground"> on {governorApproval.date}</span>
                        {governorApproval.chapter && (
                          <Badge variant="secondary" className="ml-2">{governorApproval.chapter}</Badge>
                        )}
                      </>
                    ) : (
                      bill.status
                    )}
                  </div>
                )}

                <div className="flex flex-wrap gap-4 mt-3">
                  {bill.textUrl && bill.textUrl !== bill.url && (
                    <a href={bill.textUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline">
                      Read full text <ExternalLink className="h-3 w-3" />
                    </a>
                  )}
                  {bill.url && (
                    <a href={bill.url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-sm text-primary hover:underline">
                      View on OpenStates <ExternalLink className="h-3 w-3" />
                    </a>
                  )}
                </div>
              </CardContent>
            </Card>

            {bill.summary && (
              <SummarySearch
                summary={bill.summary}
                className="overflow-hidden"
                contentClassName="overflow-y-auto pr-3"
                profileHeight={profileHeight}
              />
            )}

            <div className="grid md:grid-cols-2 gap-6">
              {bill.sponsors && bill.sponsors.length > 0 && (
                <ResizableDetailCard title={`Sponsor${bill.sponsors.length > 1 ? "s" : ""}`} maxHeight={profileHeight}>
                  <div className="space-y-2">
                    {bill.sponsors.map((s, i) => (
                      <div key={i} className="flex min-w-0 items-center justify-between gap-3">
                        <RepNameLink name={s.name} openstatesId={s.openstatesId} />
                        <PartyStateBadgeRail party={s.party} />
                      </div>
                    ))}
                  </div>
                </ResizableDetailCard>
              )}

              {bill.committees && bill.committees.length > 0 && (
                <ResizableDetailCard title="Committees" maxHeight={profileHeight}>
                  <div className="space-y-2">
                    {bill.committees.map((c, i) => (
                      <div key={i} className="text-sm">
                        <p className="font-medium">{c.name}</p>
                        {c.chamber && <p className="text-xs text-muted-foreground">{c.chamber}</p>}
                      </div>
                    ))}
                  </div>
                </ResizableDetailCard>
              )}
            </div>

            {bill.cosponsors && bill.cosponsors.length > 0 && (
              <ResizableDetailCard title={`Cosponsors (${bill.cosponsors.length})`} maxHeight={profileHeight}>
                <div className="grid grid-cols-1 gap-y-1 sm:grid-cols-2 sm:gap-x-6">
                  {bill.cosponsors.map((s, i) => (
                    <div key={i} className="flex min-w-0 items-center justify-between gap-3 border-b py-1.5 last:border-0">
                      <RepNameLink name={s.name} openstatesId={s.openstatesId} />
                      <PartyStateBadgeRail party={s.party} />
                    </div>
                  ))}
                </div>
              </ResizableDetailCard>
            )}

            {bill.votes && bill.votes.length > 0 && (
              <ResizableDetailCard title="Votes" maxHeight={profileHeight}>
                <div className="space-y-3">
                  {[...bill.votes]
                    .sort((a, b) => (a.date ?? "").localeCompare(b.date ?? ""))
                    .map((v, i) => {
                      const voteDisplay = getVoteDisplay(v, bill.actions);
                      const motionType = v.motionClassification?.join(", ") ?? voteDisplay.stage;

                      return (
                        <div key={i} className="flex flex-col gap-2 border-b pb-3 text-sm last:border-0 sm:flex-row sm:items-start sm:justify-between">
                          <div className="min-w-0 space-y-1">
                            <div className="flex flex-wrap items-center gap-2">
                              {voteDisplay.body && <Badge variant="secondary">{voteDisplay.body}</Badge>}
                              {v.result && (
                                <Badge
                                  variant="outline"
                                  className={
                                    v.result.toLowerCase().includes("pass")
                                      ? "border-green-300 text-green-700 bg-green-50"
                                      : v.result.toLowerCase().includes("fail")
                                        ? "border-red-300 text-red-700 bg-red-50"
                                        : ""
                                  }
                                >
                                  {v.result}
                                </Badge>
                              )}
                            </div>
                            <p className="text-xs text-muted-foreground">{v.date}</p>
                            {motionType && <p className="text-xs text-muted-foreground leading-snug">{motionType}</p>}
                            {v.sourceUrl && (
                              <a
                                href={v.sourceUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
                              >
                                Roll-call source <ExternalLink className="h-3 w-3" />
                              </a>
                            )}
                          </div>
                          <div className="flex shrink-0 flex-wrap gap-3 text-xs sm:justify-end">
                            {v.yesCount !== undefined && <span className="text-green-600 font-semibold">Yea: {v.yesCount}</span>}
                            {v.noCount !== undefined && <span className="text-red-600 font-semibold">Nay: {v.noCount}</span>}
                            {v.absentCount !== undefined && <span className="text-muted-foreground">Absent: {v.absentCount}</span>}
                          </div>
                        </div>
                      );
                    })}
                </div>
              </ResizableDetailCard>
            )}

            {bill.actions && bill.actions.length > 0 && (
              <ResizableDetailCard title="Legislative History" maxHeight={profileHeight}>
                <div className="space-y-3">
                  {(() => {
                    const seen = new Set<string>();
                    return [...bill.actions]
                      .sort((a, b) => (a.date ?? "").localeCompare(b.date ?? ""))
                      .filter((a) => {
                        const key = `${a.date}|${a.text}`;
                        if (seen.has(key)) return false;
                        seen.add(key);
                        return true;
                      })
                      .map((a, i) => (
                        <div key={i} className="grid grid-cols-[6rem_1fr] gap-4 text-sm">
                          <span className="text-muted-foreground">{a.date}</span>
                          <span className="min-w-0 leading-snug">{a.text}</span>
                        </div>
                      ));
                  })()}
                </div>
              </ResizableDetailCard>
            )}
          </div>
        ) : (
          <div className="text-center py-20 text-muted-foreground">Bill not found.</div>
        )}
      </div>
    </div>
  </div>
  );
}
