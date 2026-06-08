import { useRef, useState, useEffect } from "react";
import { useParams, Link, useSearch } from "wouter";
import {
  useGetFederalBillDetail,
  getGetFederalBillDetailQueryKey,
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

function BillProgressBar({
  actions,
  progress,
}: {
  actions?: { date: string; text: string; type?: string }[];
  progress?: {
    introduced?: boolean;
    committee?: boolean;
    floorVote?: boolean;
    passed?: boolean;
    signed?: boolean;
  };
}) {
  const stages = ["Introduced", "Committee", "Floor Vote", "Passed", "Signed"];
  const actionTexts = (actions ?? []).map((a) => a.text.toLowerCase());

  const isReached = (stage: string) => {
    if (progress) {
      switch (stage) {
        case "Introduced": return !!progress.introduced;
        case "Committee": return !!progress.committee;
        case "Floor Vote": return !!progress.floorVote;
        case "Passed": return !!progress.passed;
        case "Signed": return !!progress.signed;
        default: return false;
      }
    }

    switch (stage) {
      case "Introduced": return true;
      case "Committee": return actionTexts.some((t) => t.includes("committee") || t.includes("referred"));
      case "Floor Vote": return actionTexts.some((t) => t.includes("vote") || t.includes("passed") || t.includes("agreed"));
      case "Passed": return actionTexts.some((t) => t.includes("passed") || t.includes("agreed to"));
      case "Signed": return actionTexts.some((t) => t.includes("signed") || t.includes("became law") || t.includes("public law"));
      default: return false;
    }
  };

  return (
    <div className="flex items-center gap-0 mt-4 mb-6">
      {stages.map((stage, i) => {
        const reached = isReached(stage);
        return (
          <div key={stage} className="flex items-center flex-1">
            <div className="flex flex-col items-center">
              {reached
                ? <CheckCircle2 className="h-5 w-5 text-green-600" />
                : <Circle className="h-5 w-5 text-muted-foreground/30" />}
              <span className={`text-[10px] mt-1 text-center leading-tight ${reached ? "text-foreground font-medium" : "text-muted-foreground"}`}>
                {stage}
              </span>
            </div>
            {i < stages.length - 1 && (
              <div className={`h-0.5 flex-1 mx-1 -mt-4 ${isReached(stages[i + 1]) ? "bg-green-600" : "bg-muted"}`} />
            )}
          </div>
        );
      })}
    </div>
  );
}

export function FederalBillDetail() {
  const { congress, billType, billNumber } = useParams<{ congress: string; billType: string; billNumber: string }>();
  const search = useSearch();
  const params = new URLSearchParams(search);
  const fromPath = params.get("from") ?? "/bills/federal";
  const fromName = params.get("name");

  const profileRef = useRef<HTMLDivElement>(null);
  const [profileHeight, setProfileHeight] = useState(300);

  const { data: bill, isLoading } = useGetFederalBillDetail(congress, billType, billNumber, {
    query: {
      enabled: !!congress && !!billType && !!billNumber,
      queryKey: getGetFederalBillDetailQueryKey(congress, billType, billNumber)
    }
  });
  const progress = bill?.progress;
  const billId = `${congress}-${billType}-${billNumber}`;
  const { toggle, check } = useBookmarks();
  const bookmarked = check(billId);

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
  }, [bill?.title, bill?.latestAction]);

  return (
    <div className="h-full flex flex-col bg-muted/20">
      <div className="shrink-0 container mx-auto px-4 py-3 max-w-4xl">
        <Link href={fromPath} className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors">
          <ChevronLeft className="h-4 w-4" /> {fromName ? `Back to ${fromName}` : "Back to Federal Bills"}
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
                    {bill.number && <Badge variant="outline" className="font-mono">{bill.number}</Badge>}
                    {bill.congress && <Badge variant="secondary">{bill.congress}th Congress</Badge>}
                    {bill.introducedDate && <span className="text-sm text-muted-foreground">Introduced {bill.introducedDate}</span>}
                  </div>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="shrink-0 -mt-1 -mr-2"
                    aria-label={bookmarked ? "Remove bookmark" : "Save bill"}
                    onClick={() => toggle({ id: billId, type: "federal", number: bill.number ?? billId, title: bill.title ?? "" })}
                  >
                    <Bookmark className={`h-5 w-5 ${bookmarked ? "fill-primary text-primary" : "text-muted-foreground"}`} />
                  </Button>
                </div>
                <h1 className="text-2xl font-black leading-tight mb-4">{bill.title}</h1>

                <BillProgressBar actions={bill.actions} progress={progress} />

                {bill.latestAction && (
                  <div className="bg-muted/50 rounded-lg p-3 text-sm">
                    <span className="text-muted-foreground font-medium">Latest action: </span>
                    {bill.latestAction}
                    {bill.latestActionDate && <span className="text-muted-foreground"> ({bill.latestActionDate})</span>}
                  </div>
                )}

                <div className="flex flex-wrap gap-4 mt-3">
                  {bill.textUrl && (
                    <a href={bill.textUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline">
                      Read full text <ExternalLink className="h-3 w-3" />
                    </a>
                  )}
                  {bill.url && (
                    <a href={bill.url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-sm text-primary hover:underline">
                      View on Congress.gov <ExternalLink className="h-3 w-3" />
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
                        <RepNameLink name={s.name} bioguideId={s.bioguideId} />
                        <PartyStateBadgeRail party={s.party} state={s.state} />
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
                      <RepNameLink name={s.name} bioguideId={s.bioguideId} />
                      <PartyStateBadgeRail party={s.party} state={s.state} />
                    </div>
                  ))}
                </div>
              </ResizableDetailCard>
            )}

            {bill.votes && bill.votes.length > 0 && (
              <ResizableDetailCard title="Votes" maxHeight={profileHeight}>
                <div className="space-y-3">
                  {[...bill.votes].sort((a, b) => (a.date ?? "").localeCompare(b.date ?? "")).map((v, i) => (
                    <div key={i} className="flex flex-col gap-2 border-b pb-3 text-sm last:border-0 sm:flex-row sm:items-start sm:justify-between">
                      <div className="min-w-0 space-y-1">
                        <div className="flex flex-wrap items-center gap-2">
                          {v.chamber && <Badge variant="secondary">{v.chamber}</Badge>}
                          {v.rollNumber !== undefined && <Badge variant="outline">Roll #{v.rollNumber}</Badge>}
                        </div>
                        <p className="text-xs text-muted-foreground">{v.date}</p>
                        {v.result && <p className="text-xs text-muted-foreground leading-snug">{v.result}</p>}
                        {v.sourceUrl && (
                          <a href={v.sourceUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-xs text-primary hover:underline">
                            Roll-call source <ExternalLink className="h-3 w-3" />
                          </a>
                        )}
                      </div>
                      <div className="flex shrink-0 flex-wrap gap-3 text-xs sm:justify-end">
                        {v.yesCount !== undefined && <span className="text-green-600 font-semibold">Yea: {v.yesCount}</span>}
                        {v.noCount !== undefined && <span className="text-red-600 font-semibold">Nay: {v.noCount}</span>}
                        {v.presentCount !== undefined && <span className="text-muted-foreground">Present: {v.presentCount}</span>}
                      </div>
                    </div>
                  ))}
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
