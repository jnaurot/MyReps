import { useState, useMemo, useCallback, useEffect } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ChevronUp, ChevronDown, X, Search, GripHorizontal } from "lucide-react";
import { useResizableContentHeight } from "@/hooks/useResizableContentHeight";

export const BILL_STAGE_OPTIONS = [
  "All Bills",
  "Active Bills",
  "Became Law/Adopted",
  "Dead",
] as const;

export type BillStage = (typeof BILL_STAGE_OPTIONS)[number];

export const BILL_STAGE_QUERY_KEYS: Record<BillStage, string> = {
  "All Bills": "all",
  "Active Bills": "active",
  "Became Law/Adopted": "signed_enacted",
  Dead: "dead",
};

export function buildBillStageQuery(selectedStages: BillStage[]): string | undefined {
  const queryStages = selectedStages.filter(
    (stage): stage is Exclude<BillStage, "All Bills"> => stage !== "All Bills",
  );
  return queryStages.length > 0
    ? queryStages.map((stage) => BILL_STAGE_QUERY_KEYS[stage]).join(",")
    : undefined;
}

export function toggleBillStageSelection(
  selectedStages: BillStage[],
  stage: BillStage,
): BillStage[] {
  if (stage === "All Bills") return [];
  return selectedStages.includes(stage) ? [] : [stage];
}

export function partyColor(party?: string) {
  if (!party) return "bg-gray-100 text-gray-700";
  const p = party.toLowerCase();
  if (p.includes("democrat")) return "bg-blue-600 text-white";
  if (p.includes("republican")) return "bg-red-600 text-white";
  return "bg-gray-200 text-gray-800";
}

export function voteColor(voteCast?: string) {
  if (!voteCast) return "text-muted-foreground";
  const v = voteCast.toLowerCase();
  if (v === "yea") return "text-green-600 font-semibold";
  if (v === "nay") return "text-red-600 font-semibold";
  if (v === "present") return "text-yellow-600 font-semibold";
  return "text-muted-foreground";
}

export function billNumberClass(stageDead?: boolean | null, stageSignedEnacted?: boolean | null): string {
  if (stageDead === true) return "text-red-600 border-red-600 dark:text-red-400 dark:border-red-400";
  if (stageSignedEnacted === true) return "text-amber-600 border-amber-600 border-2 dark:text-amber-400 dark:border-amber-400";
  return "text-green-600 border-green-600 dark:text-green-400 dark:border-green-400";
}

export function voteBadgeClass(voteCast?: string) {
  if (!voteCast) return "bg-gray-100 text-gray-700";
  const v = voteCast.toLowerCase();
  if (v === "yea") return "bg-green-100 text-green-700 border-green-200";
  if (v === "nay") return "bg-red-100 text-red-700 border-red-200";
  if (v === "present") return "bg-yellow-100 text-yellow-700 border-yellow-200";
  return "bg-muted text-muted-foreground border-muted-foreground/20";
}

export function formatMoney(n?: number) {
  if (!n) return "$0";
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(0)}K`;
  return `$${n}`;
}

export function HighlightedSummary({ text, query }: { text: string; query: string }) {
  if (!query.trim()) return <span>{text}</span>;
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const parts = text.split(new RegExp(`(${escaped})`, "gi"));
  return (
    <span className="text-sm leading-relaxed text-muted-foreground">
      {parts.map((part, i) =>
        i % 2 === 1 ? (
          <mark key={i} className="bg-yellow-200 text-foreground rounded-sm px-0.5">{part}</mark>
        ) : (
          <span key={i}>{part}</span>
        )
      )}
    </span>
  );
}

export function SummarySearch({ summary, className = "", contentClassName = "", profileHeight = 300 }: { summary: string; className?: string; contentClassName?: string; profileHeight?: number }) {
  const [query, setQuery] = useState("");
  const [currentMatch, setCurrentMatch] = useState(0);
  const {
    chromeRef,
    contentRef: containerRef,
    height,
    isExpandable,
    isScrollable,
    handleMouseDown,
  } = useResizableContentHeight(profileHeight);

  const matches = useMemo(() => {
    if (!query.trim()) return 0;
    const regex = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
    return (summary.match(regex) || []).length;
  }, [summary, query]);

  const scrollToMatch = useCallback((index: number) => {
    const marks = containerRef.current?.querySelectorAll("mark");
    if (!marks || marks.length === 0) return;
    const clamped = ((index % marks.length) + marks.length) % marks.length;
    setCurrentMatch(clamped);
    (marks[clamped] as HTMLElement)?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, []);

  const handlePrev = () => scrollToMatch(currentMatch - 1);
  const handleNext = () => scrollToMatch(currentMatch + 1);

  useEffect(() => {
    if (matches > 0) scrollToMatch(0);
  }, [matches, query, scrollToMatch]);

  return (
    <Card className={`overflow-hidden flex flex-col ${className}`}>
      <CardHeader ref={chromeRef} className="pb-3 shrink-0">
        <div className="flex items-center justify-between gap-4">
          <CardTitle className="text-base">Summary</CardTitle>
          <div className="flex items-center gap-2">
            {query && (
              <>
                <span className="text-xs text-muted-foreground">
                  {matches > 0 ? `${currentMatch + 1} of ${matches}` : "0 matches"}
                </span>
                <div className="flex items-center gap-1">
                  <Button variant="ghost" size="icon" className="h-7 w-7" disabled={matches === 0} onClick={handlePrev}>
                    <ChevronUp className="h-4 w-4" />
                  </Button>
                  <Button variant="ghost" size="icon" className="h-7 w-7" disabled={matches === 0} onClick={handleNext}>
                    <ChevronDown className="h-4 w-4" />
                  </Button>
                </div>
                <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => { setQuery(""); setCurrentMatch(0); }}>
                  <X className="h-4 w-4" />
                </Button>
              </>
            )}
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
              <Input
                type="text"
                placeholder="Find in summary..."
                value={query}
                onChange={(e) => { setQuery(e.target.value); setCurrentMatch(0); }}
                className="pl-8 h-8 text-sm w-48"
              />
            </div>
          </div>
        </div>
      </CardHeader>
      <CardContent
        className={`pt-0 pr-3 ${isScrollable ? "overflow-y-auto" : "overflow-hidden"} ${contentClassName}`}
        style={height !== null ? { height } : undefined}
        ref={containerRef}
      >
        <HighlightedSummary text={summary} query={query} />
      </CardContent>
      {isExpandable && (
        <div
          className="shrink-0 h-4 flex items-center justify-center cursor-ns-resize bg-muted/30 hover:bg-muted/50 transition-colors"
          onMouseDown={handleMouseDown}
        >
          <GripHorizontal className="h-3 w-3 text-muted-foreground/50" />
        </div>
      )}
    </Card>
  );
}
