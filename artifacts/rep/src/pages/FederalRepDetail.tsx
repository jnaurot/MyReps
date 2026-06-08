import { useEffect, useRef, useState } from "react";
import { useMobileInfiniteScroll } from "@/hooks/useMobileInfiniteScroll";
import { useParams, Link, useSearch, useSearchParams } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetFederalMember,
  useGetFederalMemberBills,
  useGetFederalMemberHouseVotes,
  useGetFederalMemberSenateVotes,
  useGetFederalMemberCommittees,
  useSearchCandidateFinance,
  useGetCandidateFinance,
  useRefreshFederalMember,
  useRefreshFederalMemberBills,
  getGetFederalMemberQueryKey,
  getGetFederalMemberBillsQueryKey,
  getGetFederalMemberHouseVotesQueryKey,
  getGetFederalMemberSenateVotesQueryKey,
  getGetFederalMemberCommitteesQueryKey,
  getSearchCandidateFinanceQueryKey,
  getGetCandidateFinanceQueryKey,
} from "@workspace/api-client-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { RepProfileCard } from "@/components/RepProfileCard";
import { VoteListCard } from "@/components/VoteListCard";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { toast } from "@/hooks/use-toast";
import {
  ExternalLink,
  ChevronLeft,
  ChevronDown,
  ChevronUp,
  Users,
  FileText,
  Vote,
  DollarSign,
  RefreshCw,
  AlertTriangle,
  Search,
  X,
} from "lucide-react";
import { Input } from "@/components/ui/input";
import { RepNameLink } from "@/components/RepNameLink";
import {
  partyColor,
  formatMoney,
  BILL_STAGE_OPTIONS,
  buildBillStageQuery,
  billNumberClass,
  toggleBillStageSelection,
  type BillStage,
} from "@/lib/rep-utils";
import { getStateCode } from "@/lib/states";
import { PageShell } from "@/components/layout/PageShell";
import { ListViewport } from "@/components/layout/ListViewport";
import { PaginationFooter } from "@/components/layout/PaginationFooter";
import { FilterBar } from "@/components/layout/FilterBar";
import { StatusStagePills } from "@/components/layout/StatusFilterControls";
import { useIsMobile } from "@/hooks/useIsMobile";
import { useDebounce } from "@/hooks/useDebounce";
import { buildFederalBillHref, buildFederalVoteBillHref } from "@/lib/billHref";
import { billFromParam } from "@/lib/routes";
import { buildVoteSearch, parseVoteSearchState, type VoteFilter } from "@/lib/voteSearchParams";

function PolicyAreaChart({
  policyAreas,
  type,
  fullyIngested,
  category,
  categoryTotal,
  onPolicyAreaClick,
}: {
  policyAreas?: Array<{ name?: string; count?: number; pct?: number }>;
  type?: "sponsored" | "cosponsored";
  fullyIngested?: boolean;
  category: "all" | "bill" | "resolution" | "amendment" | "other";
  categoryTotal?: number;
  onPolicyAreaClick?: (area: string) => void;
}) {
  if (!policyAreas || policyAreas.length === 0) return null;

  const total = policyAreas.reduce((sum, item) => sum + (item.count ?? 0), 0);
  const totalForCategory = categoryTotal ?? total;
  const categoryLabel =
    category === "all"
      ? "legislation records"
      : category === "bill"
        ? "bills"
        : category === "resolution"
          ? "resolutions"
          : category === "amendment"
            ? "amendments"
            : "other items";
  const label =
    type === "cosponsored"
      ? "Cosponsored Legislation Support"
      : "Sponsored Legislation Focus";

  return (
    <div className="shrink-0 mb-4">
      <p className="text-xs text-muted-foreground font-semibold uppercase tracking-wide mb-2">
        {label}
      </p>
      {type === "cosponsored" && (
        <p className="text-[10px] text-muted-foreground mb-2">
          Cosponsored bills may reflect party support patterns more than
          personal legislative priorities.
        </p>
      )}
      <div className="space-y-1.5">
        {policyAreas.map((item) => (
          <div key={item.name} className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => onPolicyAreaClick?.(item.name ?? "")}
              className="text-xs w-24 truncate shrink-0 hover:underline hover:text-primary transition-colors text-left"
              title={item.name}
            >
              {item.name}
            </button>
            <div className="flex-1 h-2 bg-muted rounded-full overflow-hidden">
              <div
                className="h-full bg-primary rounded-full"
                style={{ width: `${item.pct}%` }}
              />
            </div>
            <span className="text-xs text-muted-foreground w-8 text-right">
              {item.pct}%
            </span>
          </div>
        ))}
      </div>
      <p className="text-[10px] text-muted-foreground mt-1">
        Based on {total} of {totalForCategory} {categoryLabel} with policy
        areas.
      </p>
    </div>
  );
}

export function BillsList({
  bioguideId,
  memberName,
  billRole,
  onBillRoleChange,
  filtersCollapsed,
  onBillViewChange,
}: {
  bioguideId: string;
  memberName?: string;
  billRole: "sponsored" | "cosponsored";
  onBillRoleChange: (role: "sponsored" | "cosponsored") => void;
  filtersCollapsed?: boolean;
  onBillViewChange?: (view: "list" | "policyArea") => void;
}) {
  const queryClient = useQueryClient();
  const isMobile = useIsMobile();
  const pageSearch = useSearch();
  const initialParams = new URLSearchParams(pageSearch);
  const [billView, setBillView] = useState<"list" | "policyArea">(
    initialParams.get("billView") === "policyArea" ? "policyArea" : "list",
  );
  const effectiveCollapsed = !!filtersCollapsed && billView === "list";
  useEffect(() => { onBillViewChange?.(billView); }, [billView, onBillViewChange]);
  const [category, setCategory] = useState<
    "all" | "bill" | "resolution" | "amendment" | "other"
  >(() => {
    const value = initialParams.get("category");
    return value === "bill" ||
      value === "resolution" ||
      value === "amendment" ||
      value === "other"
      ? value
      : "all";
  });
  const [selectedStages, setSelectedStages] = useState<BillStage[]>(() => {
    const raw = initialParams.get("stages");
    if (!raw) return [];
    const parsed = raw.split(",").filter((s): s is BillStage =>
      BILL_STAGE_OPTIONS.includes(s as BillStage),
    );
    return parsed;
  });
  const listViewportRef = useRef<HTMLDivElement | null>(null);
  const restoredScrollRef = useRef(false);
  const [offset, setOffset] = useState(() => {
    const raw = Number(initialParams.get("offset") ?? "0");
    return Number.isFinite(raw) && raw >= 0 ? raw : 0;
  });
  const [searchQuery, setSearchQuery] = useState(initialParams.get("q") ?? "");
  const debouncedSearchQuery = useDebounce(searchQuery, 300);
  const [policyArea, setPolicyArea] = useState(initialParams.get("policyArea") ?? "");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [allBills, setAllBills] = useState<any[]>([]);
  const appendedOffsetRef = useRef(new Set<number>());
  const scrollRatioRef = useRef(0);
  const [lastVisible, setLastVisible] = useState(1);
  const prevFilterKeyRef = useRef<string | null>(null);
  const limit = 20;

  // Sync policyArea state with URL param changes (direct nav / back button)
  useEffect(() => {
    const params = new URLSearchParams(pageSearch);
    const urlPolicyArea = params.get("policyArea") ?? "";
    setPolicyArea((prev) => {
      if (prev !== urlPolicyArea) {
        setOffset(0);
      }
      return urlPolicyArea;
    });
  }, [pageSearch]);
  const selectedStatusActive = selectedStages.length > 0;
  const stageQuery = buildBillStageQuery(selectedStages);

  const filterKey = `${billRole}|${category}|${debouncedSearchQuery}|${stageQuery ?? ""}|${policyArea}`;

  const queryParams = {
    type: billRole,
    offset,
    limit,
    q: debouncedSearchQuery || undefined,
    category,
    stages: stageQuery,
    policyArea: policyArea || undefined,
  };
  const { data, isLoading, isPlaceholderData } = useGetFederalMemberBills(
    bioguideId,
    queryParams,
    {
      query: {
        enabled: !!bioguideId,
        queryKey: getGetFederalMemberBillsQueryKey(bioguideId, queryParams),
        placeholderData: (previous) => previous,
        refetchInterval: (query) =>
          query.state.data?.fullyIngested === false ? 4000 : false,
      },
    },
  );
  const refreshBillsMutation = useRefreshFederalMemberBills({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({
          queryKey: getGetFederalMemberBillsQueryKey(bioguideId),
        });
        toast({
          title: "Legislation refreshed",
          description: "Sponsored legislation is being indexed.",
          duration: 5000,
        });
      },
      onError: (err: Error) => {
        toast({
          title: "Refresh failed",
          description: err.message || "Could not refresh legislation.",
          variant: "destructive",
          duration: 5000,
        });
      },
    },
  });

  const backPathParams = new URLSearchParams();
  backPathParams.set("billView", billView);
  backPathParams.set("category", category);
  backPathParams.set("offset", String(offset));
  if (debouncedSearchQuery) backPathParams.set("q", debouncedSearchQuery);
  if (policyArea) backPathParams.set("policyArea", policyArea);
  if (selectedStages.length > 0)
    backPathParams.set("stages", selectedStages.join(","));
  const backPath = `/rep/federal/${bioguideId}?${backPathParams.toString()}`;
  const scrollStorageKey = `scroll:${backPath}:bills`;
  const fromParam = memberName
    ? `?from=${encodeURIComponent(backPath)}&name=${encodeURIComponent(memberName)}`
    : `?from=${encodeURIComponent(backPath)}`;
  const categoryOptions: Array<{
    value: typeof category;
    label: string;
    hideWhenZero?: boolean;
  }> = [
    { value: "all", label: "All" },
    { value: "bill", label: "Bills" },
    { value: "resolution", label: "Resolutions" },
    { value: "amendment", label: "Amendments" },
    { value: "other", label: "Other", hideWhenZero: true },
  ];
  const roleLabel =
    billRole === "cosponsored"
      ? "Cosponsored Legislation"
      : "Sponsored Legislation";
  const statusFilterActive = selectedStatusActive;
  const displayedBills = data?.bills ?? [];
  const displayedPagedBills = displayedBills;
  const displayedTotalCount = data?.totalCount ?? 0;

  useEffect(() => {
    if (isLoading) return;
    if (!statusFilterActive) return;
    if (offset >= displayedTotalCount && offset !== 0) setOffset(0);
  }, [
    displayedTotalCount,
    isLoading,
    offset,
    statusFilterActive,
  ]);

  useEffect(() => {
    restoredScrollRef.current = false;
  }, [scrollStorageKey]);

  useEffect(() => {
    if (billView !== "list") return;
    if (isMobile) return;
    if (isLoading) return;
    if (restoredScrollRef.current) return;
    if (typeof window === "undefined") return;
    const raw = window.sessionStorage.getItem(scrollStorageKey);
    if (!raw) {
      restoredScrollRef.current = true;
      return;
    }
    const scrollTop = Number(raw);
    if (!Number.isFinite(scrollTop)) {
      restoredScrollRef.current = true;
      return;
    }
    const id = window.requestAnimationFrame(() => {
      if (listViewportRef.current) {
        listViewportRef.current.scrollTop = scrollTop;
      }
      restoredScrollRef.current = true;
    });
    return () => window.cancelAnimationFrame(id);
  }, [billView, isMobile, isLoading, scrollStorageKey]);

  // Mobile: accumulate bills across pages; atomically reset + replace when filter changes
  useEffect(() => {
    if (!isMobile) return;
    if (isLoading || isPlaceholderData) return;

    if (prevFilterKeyRef.current !== filterKey) {
      appendedOffsetRef.current = new Set();
      prevFilterKeyRef.current = filterKey;
    }

    if (appendedOffsetRef.current.has(offset)) return;
    appendedOffsetRef.current.add(offset);

    if (offset === 0) {
      setAllBills(displayedBills);
    } else if (displayedBills.length > 0) {
      setAllBills((prev) => {
        const seen = new Set(prev.map((b) => b.id));
        const fresh = displayedBills.filter((b) => !seen.has(b.id));
        return fresh.length > 0 ? [...prev, ...fresh] : prev;
      });
    }
  }, [isMobile, isLoading, isPlaceholderData, filterKey, offset, displayedBills]);

  // Mobile: update visible counter after allBills changes
  useEffect(() => {
    if (!isMobile || allBills.length === 0) return;
    const el = listViewportRef.current;
    if (!el) return;
    const id = window.requestAnimationFrame(() => {
      const { scrollTop, scrollHeight, clientHeight } = el;
      const ratio = scrollHeight > 0 ? (scrollTop + clientHeight) / scrollHeight : 1;
      scrollRatioRef.current = ratio;
      const visible = Math.max(1, Math.round(ratio * allBills.length));
      setLastVisible(Math.min(visible, allBills.length));
    });
    return () => window.cancelAnimationFrame(id);
  }, [allBills.length, isMobile]);

  const { sentinelRef, triggerIfNearBottom } = useMobileInfiniteScroll({
    isMobile,
    listViewportRef,
    allItemsLength: allBills.length,
    totalCount: displayedTotalCount,
    loading: isLoading,
    isPlaceholder: isPlaceholderData,
    onLoadNext: setOffset,
  });

  const handleScroll: React.UIEventHandler<HTMLDivElement> = (e) => {
    if (!isMobile) return;
    const { scrollTop, scrollHeight, clientHeight } = e.currentTarget;
    if (scrollHeight <= clientHeight) return;
    const ratio = (scrollTop + clientHeight) / scrollHeight;
    scrollRatioRef.current = ratio;
    const visible = Math.max(1, Math.round(ratio * allBills.length));
    setLastVisible(Math.min(visible, allBills.length));
    triggerIfNearBottom(e.currentTarget);
  };

  function internalBillHref(bill: {
    number?: string;
    congress?: string;
    itemCategory?: string;
  }) {
    return buildFederalBillHref(bill, fromParam);
  }

  const billsToRender = isMobile
    ? (allBills as typeof displayedBills)
    : displayedPagedBills;

  return (
    <div className="flex flex-col h-full pb-4">
      <div className={effectiveCollapsed ? "hidden sm:block" : undefined}>
        <div className="flex items-center shrink-0 pb-4 gap-1 sm:gap-2 sm:justify-between">
          <div className="flex gap-1 sm:gap-2">
            <Button
              size="sm"
              variant={billRole === "sponsored" ? "default" : "outline"}
              className="max-sm:text-xs max-sm:px-2 max-sm:h-7"
              onClick={() => {
                onBillRoleChange("sponsored");
                setOffset(0);
              }}
            >
              Sponsored
            </Button>
            <Button
              size="sm"
              variant={billRole === "cosponsored" ? "default" : "outline"}
              className="max-sm:text-xs max-sm:px-2 max-sm:h-7"
              onClick={() => {
                onBillRoleChange("cosponsored");
                setOffset(0);
              }}
            >
              Cosponsored
            </Button>
          </div>
          <div className="flex gap-1 sm:gap-2">
            <Button
              size="sm"
              variant={billView === "list" ? "default" : "outline"}
              className="max-sm:text-xs max-sm:px-2 max-sm:h-7"
              onClick={() => setBillView("list")}
            >
              List
            </Button>
            <Button
              size="sm"
              variant={billView === "policyArea" ? "default" : "outline"}
              className="max-sm:text-xs max-sm:px-2 max-sm:h-7"
              onClick={() => setBillView("policyArea")}
            >
              Policy Area
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="hidden sm:inline-flex"
              onClick={() =>
                refreshBillsMutation.mutate({
                  bioguideId,
                  data: { type: billRole },
                })
              }
              disabled={refreshBillsMutation.isPending}
              title="Refresh legislation"
            >
              <RefreshCw
                className={`h-4 w-4 ${refreshBillsMutation.isPending ? "animate-spin" : ""}`}
              />
            </Button>
          </div>
        </div>
        <StatusStagePills
          selectedStages={selectedStages}
          onToggleStage={(stage) => {
            setSelectedStages((prev) => toggleBillStageSelection(prev, stage));
            setOffset(0);
          }}
        />
        <FilterBar className="flex flex-wrap gap-2 max-sm:flex-nowrap max-sm:overflow-x-auto max-sm:pb-1 max-sm:[&>*]:shrink-0">
          {categoryOptions.map((option) => {
            const count =
              data?.categoryCounts?.[option.value] ?? 0;
            if (option.hideWhenZero && count === 0) return null;
            return (
              <Button
                key={option.value}
                size="sm"
                variant={category === option.value ? "default" : "outline"}
                onClick={() => {
                  setCategory(option.value);
                  setOffset(0);
                }}
              >
                {`${option.label} (${count})`}
              </Button>
            );
          })}
        </FilterBar>
        <FilterBar className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search bills..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-9"
          />
        </FilterBar>
        {policyArea && (
          <div className="flex items-center gap-2">
            <Badge variant="secondary" className="flex items-center gap-1.5">
              Policy: {policyArea}
              <button
                type="button"
                onClick={() => {
                  setPolicyArea("");
                  setOffset(0);
                }}
                className="ml-1 rounded-full hover:bg-muted p-0.5"
                aria-label="Clear policy area filter"
              >
                <X className="h-3 w-3" />
              </button>
            </Badge>
          </div>
        )}
      </div>

      {billView === "list" ? (
        <div className="flex-1 min-h-0 flex flex-col">
          <p className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-2 shrink-0">
            {roleLabel}
          </p>
          {data?.fullyIngested === false && (
            <p className="text-xs text-amber-600 mb-2 shrink-0">
              Indexing sponsored legislation. Counts may update.
            </p>
          )}
          <ListViewport
            ref={listViewportRef}
            onScroll={handleScroll}
          >
            <div>
              {isLoading && !allBills.length && (
                <>
                  {[...Array(5)].map((_, i) => (
                    <Skeleton key={i} className="h-20 w-full" />
                  ))}
                </>
              )}

              {!isLoading && billsToRender.length === 0 && (
                <p className="text-muted-foreground text-center py-10">
                  No legislation found.
                </p>
              )}

              {billsToRender.map((bill) => {
                const href = internalBillHref(bill);
                const compactMode = statusFilterActive;
                const card = (
                  <Card
                    className={
                      href
                        ? "hover:border-primary transition-colors cursor-pointer"
                        : "transition-colors"
                    }
                  >
                    <CardContent className={compactMode ? "p-3" : "p-4"}>
                      <div className="flex items-start justify-between gap-4">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 mb-1">
                            {bill.number && (
                              <Badge
                                variant="outline"
                                className={`text-xs font-mono shrink-0 ${billNumberClass(bill.stageDead, bill.stageSignedEnacted)}`}
                              >
                                {bill.number}
                              </Badge>
                            )}
                            {bill.itemCategory && (
                              <Badge
                                variant="secondary"
                                className="text-xs capitalize"
                              >
                                {bill.itemCategory}
                              </Badge>
                            )}
                            {bill.chamber && (
                              <Badge variant="secondary" className="text-xs">
                                {bill.chamber}
                              </Badge>
                            )}
                          </div>
                          <p
                            className={`font-medium ${compactMode ? "text-sm line-clamp-1" : "text-sm line-clamp-2"}`}
                          >
                            {bill.title}
                          </p>
                          {bill.latestAction && (
                            <p
                              className={`text-muted-foreground mt-1 ${compactMode ? "text-[11px] line-clamp-1" : "text-xs line-clamp-1"}`}
                            >
                              {bill.latestAction}
                            </p>
                          )}
                          {!href && bill.url && (
                            <a
                              className="text-xs text-primary mt-2 inline-flex items-center gap-1"
                              href={bill.url.replace(
                                "api.congress.gov/v3",
                                "www.congress.gov",
                              )}
                              target="_blank"
                              rel="noreferrer"
                            >
                              View source <ExternalLink className="h-3 w-3" />
                            </a>
                          )}
                        </div>
                        {bill.introducedDate && (
                          <span className="text-xs text-muted-foreground shrink-0">
                            {bill.introducedDate}
                          </span>
                        )}
                      </div>
                    </CardContent>
                  </Card>
                );
                return href ? (
                  <Link
                    key={bill.id}
                    data-testid="bill-item"
                    href={href}
                    onClick={() => {
                      if (typeof window === "undefined") return;
                      const top = listViewportRef.current?.scrollTop ?? 0;
                      window.sessionStorage.setItem(
                        scrollStorageKey,
                        String(top),
                      );
                    }}
                  >
                    {card}
                  </Link>
                ) : (
                  <div key={bill.id} data-testid="bill-item">{card}</div>
                );
              })}
              {isMobile && <div ref={sentinelRef} className="h-16" />}
            </div>
          </ListViewport>
          <div className="sm:hidden text-xs text-center text-muted-foreground py-2 shrink-0">
            {allBills.length > 0 && displayedTotalCount > 0
              ? `${lastVisible}/${displayedTotalCount}${isLoading ? " ···" : ""}`
              : isLoading ? "···" : ""}
          </div>
          <div className="hidden sm:block">
            <PaginationFooter
              offset={offset}
              limit={limit}
              totalCount={displayedTotalCount}
              onPrevious={() => setOffset(Math.max(0, offset - limit))}
              onNext={() => setOffset(offset + limit)}
            />
          </div>
        </div>
      ) : (
        <ListViewport>
          {isLoading && (
            <div className="space-y-3">
              {[...Array(5)].map((_, i) => (
                <Skeleton key={i} className="h-8 w-full" />
              ))}
            </div>
          )}
          {!isLoading && data?.policyAreas && data.policyAreas.length > 0 && (
            <>
              <PolicyAreaChart
                policyAreas={data.policyAreas}
                type={billRole}
                fullyIngested={data?.fullyIngested}
                category={category}
                categoryTotal={
                  statusFilterActive
                    ? displayedTotalCount
                    : category === "all"
                      ? data.categoryCounts?.all
                      : data.categoryCounts?.[category]
                }
                onPolicyAreaClick={(area) => {
                  setPolicyArea(area);
                  setOffset(0);
                  setBillView("list");
                }}
              />
              {data?.fullyIngested === false && (
                <p className="text-xs text-amber-600 mt-2">
                  Policy Area is based on cached legislation so far.
                </p>
              )}
            </>
          )}
          {!isLoading &&
            (!data?.policyAreas || data.policyAreas.length === 0) && (
              <p className="text-muted-foreground text-center py-10">
                No policy area data available.
              </p>
            )}
        </ListViewport>
      )}
    </div>
  );
}

function VotesList({
  bioguideId,
  memberChamber,
  memberName,
}: {
  bioguideId: string;
  memberChamber?: string;
  memberName?: string;
}) {
  const isMobile = useIsMobile();
  const pageSearch = useSearch();
  const [searchParams, setSearchParams] = useSearchParams();
  const initialVoteState = parseVoteSearchState(pageSearch);
  const initialParams = new URLSearchParams(pageSearch);
  const [offset, setOffset] = useState(() => {
    return initialVoteState.offset;
  });
  const [filter, setFilter] = useState<VoteFilter>(() => initialVoteState.filter);
  const [searchQuery, setSearchQuery] = useState(initialParams.get("q") ?? "");
  const [mobileRestoreTargetOffset, setMobileRestoreTargetOffset] = useState(
    () => initialVoteState.offset,
  );
  const debouncedSearchQuery = useDebounce(searchQuery, 300);
  const listViewportRef = useRef<HTMLDivElement | null>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [allVotes, setAllVotes] = useState<any[]>([]);
  const appendedOffsetRef = useRef(new Set<number>());
  const scrollRatioRef = useRef(0);
  const [lastVisible, setLastVisible] = useState(1);
  const restoredScrollRef = useRef(false);
  const prevFilterKeyRef = useRef<string | null>(null);
  const limit = 20;

  const normalizedChamber = memberChamber?.toLowerCase().trim() ?? "";
  const isSenator = normalizedChamber === "senate";
  const isHouse =
    normalizedChamber === "" || normalizedChamber.includes("house");

  const houseParams = { offset, limit, filter, q: debouncedSearchQuery || undefined };
  const senateParams = { offset, limit, filter, q: debouncedSearchQuery || undefined };

  const houseQuery = useGetFederalMemberHouseVotes(bioguideId, houseParams, {
    query: {
      enabled: !!bioguideId && isHouse,
      queryKey: getGetFederalMemberHouseVotesQueryKey(bioguideId, houseParams),
      placeholderData: (previous) => previous,
    },
  });

  const senateQuery = useGetFederalMemberSenateVotes(bioguideId, senateParams, {
    query: {
      enabled: !!bioguideId && isSenator,
      queryKey: getGetFederalMemberSenateVotesQueryKey(
        bioguideId,
        senateParams,
      ),
      placeholderData: (previous) => previous,
    },
  });

  const data = isSenator ? senateQuery.data : houseQuery.data;
  const isLoading = isSenator ? senateQuery.isLoading : houseQuery.isLoading;
  const isPlaceholderData = isSenator ? senateQuery.isPlaceholderData : houseQuery.isPlaceholderData;
  const totalCount = data?.totalCount ?? 0;
  const votes = data?.votes ?? [];

  const filterKey = `${filter}|${debouncedSearchQuery}`;

  // Mobile: reset accumulation when filters change
  useEffect(() => {
    if (!isMobile) return;
    if (prevFilterKeyRef.current === filterKey) return;
    if (prevFilterKeyRef.current !== null) {
      setAllVotes([]);
      appendedOffsetRef.current = new Set();
    }
    prevFilterKeyRef.current = filterKey;
  }, [filterKey, isMobile]);

  // Mobile: append new page to accumulated list
  useEffect(() => {
    if (!isMobile) return;
    if (isLoading || isPlaceholderData) return;
    if (allVotes.length > 0) return;
    if (votes.length === 0) return;
    appendedOffsetRef.current = new Set([offset]);
    setAllVotes(votes);
  }, [allVotes.length, isLoading, isMobile, isPlaceholderData, offset, votes]);

  useEffect(() => {
    if (!isMobile) return;
    if (isLoading || isPlaceholderData) return;
    if (appendedOffsetRef.current.has(offset)) return;
    appendedOffsetRef.current.add(offset);
    if (votes.length > 0) {
      setAllVotes((prev) => [...prev, ...votes]);
    }
  }, [isMobile, isLoading, isPlaceholderData, offset, votes]);

  // Mobile: update visible counter after allVotes changes
  useEffect(() => {
    if (!isMobile || allVotes.length === 0) return;
    const el = listViewportRef.current;
    if (!el) return;
    const id = window.requestAnimationFrame(() => {
      const { scrollTop, scrollHeight, clientHeight } = el;
      const ratio = scrollHeight > 0 ? (scrollTop + clientHeight) / scrollHeight : 1;
      scrollRatioRef.current = ratio;
      const visible = Math.max(1, Math.round(ratio * allVotes.length));
      setLastVisible(Math.min(visible, allVotes.length));
    });
    return () => window.cancelAnimationFrame(id);
  }, [allVotes.length, isMobile]);

  const { sentinelRef, triggerIfNearBottom } = useMobileInfiniteScroll({
    isMobile,
    listViewportRef,
    allItemsLength: allVotes.length,
    totalCount,
    loading: isLoading,
    isPlaceholder: isPlaceholderData,
    onLoadNext: setOffset,
  });

  const handleScroll: React.UIEventHandler<HTMLDivElement> = (e) => {
    if (!isMobile) return;
    const { scrollTop, scrollHeight, clientHeight } = e.currentTarget;
    if (scrollHeight <= clientHeight) return;
    const ratio = (scrollTop + clientHeight) / scrollHeight;
    scrollRatioRef.current = ratio;
    const visible = Math.max(1, Math.round(ratio * allVotes.length));
    setLastVisible(Math.min(visible, allVotes.length));
    triggerIfNearBottom(e.currentTarget);
  };

  const shouldUseCurrentPageVotes =
    isMobile && allVotes.length === 0 && !isLoading && !isPlaceholderData;
  const votesToRender = isMobile
    ? (
        shouldUseCurrentPageVotes ? votes : allVotes
      ) as typeof votes
    : votes;
  const returnParams = new URLSearchParams(pageSearch);
  const returnPath = `/rep/federal/${bioguideId}?${returnParams.toString()}`;
  const restorationScrollStorageKey = `scroll:${returnPath}:votes`;
  const backPathParams = new URLSearchParams();
  backPathParams.set("tab", "votes");
  backPathParams.set("offset", String(offset));
  if (debouncedSearchQuery) backPathParams.set("q", debouncedSearchQuery);
  if (filter !== "all") backPathParams.set("filter", filter);
  const backPath = `/rep/federal/${bioguideId}?${backPathParams.toString()}`;
  const scrollStorageKey = `scroll:${backPath}:votes`;
  const fromParam = memberName
    ? billFromParam(backPath, memberName)
    : `?from=${encodeURIComponent(backPath)}`;

  const replaceVoteSearch = (patch: {
    filter?: VoteFilter;
    offset?: number;
    q?: string;
  }) => {
    const currentSearch = searchParams.toString();
    const nextSearch = buildVoteSearch(
      currentSearch ? `?${currentSearch}` : "",
      { tab: "votes", ...patch },
    );
    const normalizedCurrentSearch = currentSearch ? `?${currentSearch}` : "";
    if (nextSearch === normalizedCurrentSearch) return;
    setSearchParams(new URLSearchParams(nextSearch), { replace: true });
  };

  useEffect(() => {
    restoredScrollRef.current = false;
  }, [restorationScrollStorageKey]);

  useEffect(() => {
    const nextVoteState = parseVoteSearchState(pageSearch);
    setMobileRestoreTargetOffset(nextVoteState.offset);
    setOffset(nextVoteState.offset);
    setFilter(nextVoteState.filter);
    setSearchQuery(nextVoteState.q);
  }, [pageSearch]);

  useEffect(() => {
    if (debouncedSearchQuery === initialVoteState.q) return;
    setOffset(0);
    setMobileRestoreTargetOffset(0);
    replaceVoteSearch({ q: debouncedSearchQuery, offset: 0 });
  }, [debouncedSearchQuery]);

  useEffect(() => {
    if (offset === initialVoteState.offset) return;
    replaceVoteSearch({ offset });
  }, [offset]);

  useEffect(() => {
    if (!isMobile) return;
    if (mobileRestoreTargetOffset <= 0) return;
    if (isLoading || isPlaceholderData) return;
    if (allVotes.length > mobileRestoreTargetOffset) return;
    if (allVotes.length >= totalCount) return;
    const nextOffset = allVotes.length;
    if (nextOffset !== offset) {
      setOffset(nextOffset);
    }
  }, [
    allVotes.length,
    isLoading,
    isMobile,
    isPlaceholderData,
    mobileRestoreTargetOffset,
    offset,
    totalCount,
  ]);

  useEffect(() => {
    if (isLoading) return;
    if (isPlaceholderData) return;
    if (restoredScrollRef.current) return;
    if (typeof window === "undefined") return;
    const raw = window.sessionStorage.getItem(restorationScrollStorageKey);
    if (!raw) {
      restoredScrollRef.current = true;
      return;
    }
    const scrollTop = Number(raw);
    if (!Number.isFinite(scrollTop)) {
      restoredScrollRef.current = true;
      return;
    }
    if (isMobile && allVotes.length <= mobileRestoreTargetOffset) return;
    const id = window.requestAnimationFrame(() => {
      if (listViewportRef.current) {
        listViewportRef.current.scrollTop = scrollTop;
      }
      restoredScrollRef.current = true;
    });
    return () => window.cancelAnimationFrame(id);
  }, [
    allVotes.length,
    isLoading,
    isMobile,
    isPlaceholderData,
    mobileRestoreTargetOffset,
    restorationScrollStorageKey,
  ]);

  const voteFilters: { value: VoteFilter; label: string }[] = [
    { value: "all", label: "All" },
    { value: "yea", label: "Yea" },
    { value: "nay", label: "Nay" },
    { value: "present", label: "Present" },
    { value: "not-voting", label: "Not Voting" },
  ];

  return (
    <div className="flex flex-col h-full">
      <FilterBar className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input
          placeholder="Search votes..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="pl-9"
        />
      </FilterBar>
      <FilterBar className="flex flex-wrap gap-2 max-sm:flex-nowrap max-sm:overflow-x-auto max-sm:pb-1 max-sm:[&>*]:shrink-0">
        {voteFilters.map((f) => (
          <Button
            key={f.value}
            size="sm"
            variant={filter === f.value ? "default" : "outline"}
            onClick={() => {
              setFilter(f.value);
              setOffset(0);
              setMobileRestoreTargetOffset(0);
              replaceVoteSearch({ filter: f.value, offset: 0 });
            }}
          >
            {f.label}
          </Button>
        ))}
      </FilterBar>

      <ListViewport
        ref={listViewportRef}
        onScroll={handleScroll}
      >
        {isLoading && !allVotes.length && (
          <div>
            {[...Array(5)].map((_, i) => (
              <Skeleton key={i} className="h-20 w-full" />
            ))}
          </div>
        )}

        {!isLoading && votesToRender.length === 0 && (
          <p className="text-muted-foreground text-center py-10">
            No voting records found.
          </p>
        )}

        {votesToRender.map((vote: any) => {
          const href = buildFederalVoteBillHref(vote, fromParam);
          const key = `${vote.congress ?? "unknown"}-${vote.date ?? "undated"}-${vote.rollCallNumber}`;
          return (
            <VoteListCard
              key={key}
              href={href}
              badges={[
                {
                  label: memberChamber ?? "Congress",
                  variant: "outline",
                  className: "text-xs",
                },
                ...((vote.legislationType || vote.documentType) &&
                (vote.legislationNumber || vote.documentNumber)
                  ? [{
                      label: `${vote.legislationType || vote.documentType} ${vote.legislationNumber || vote.documentNumber}`,
                      variant: "secondary" as const,
                      className: "text-xs",
                    }]
                  : []),
              ]}
              title={
                vote.voteTitle ??
                vote.voteDescription ??
                "Untitled Vote"
              }
              subtitle={vote.voteQuestion}
              date={vote.date}
              voteCast={vote.voteCast}
              voteResult={vote.voteResult}
              onClick={() => {
                if (typeof window === "undefined") return;
                const top = listViewportRef.current?.scrollTop ?? 0;
                window.sessionStorage.setItem(scrollStorageKey, String(top));
              }}
            />
          );
        })}
        {isMobile && <div ref={sentinelRef} className="h-16" />}
      </ListViewport>

      <div className="sm:hidden text-xs text-center text-muted-foreground py-2 shrink-0">
        {allVotes.length > 0 && totalCount > 0
          ? `${lastVisible}/${totalCount}${isLoading ? " ···" : ""}`
          : isLoading ? "···" : ""}
      </div>
      <div className="hidden sm:block">
        <PaginationFooter
          offset={offset}
          limit={limit}
          totalCount={totalCount}
          onPrevious={() => setOffset(Math.max(0, offset - limit))}
          onNext={() => setOffset(offset + limit)}
        />
      </div>
    </div>
  );
}

function CommitteesList({ bioguideId }: { bioguideId: string }) {
  const { data, isLoading } = useGetFederalMemberCommittees(bioguideId, {
    query: {
      enabled: !!bioguideId,
      queryKey: getGetFederalMemberCommitteesQueryKey(bioguideId),
    },
  });

  return (
    <div className="flex flex-col h-full">
      <ListViewport className="space-y-3">
        {isLoading && (
          <div className="space-y-3">
            {[...Array(3)].map((_, i) => (
              <Skeleton key={i} className="h-32 w-full" />
            ))}
          </div>
        )}

        {!isLoading && !data?.committees?.length && (
          <p className="text-muted-foreground text-center py-10">
            No committee memberships found.
          </p>
        )}

        {!isLoading &&
          data?.committees?.map((c, i) => (
            <Card key={i}>
              <CardHeader className="pb-3">
                <CardTitle className="text-base">{c.name}</CardTitle>
                <div className="flex gap-2">
                  {c.chamber && (
                    <Badge variant="outline" className="text-xs">
                      {c.chamber}
                    </Badge>
                  )}
                  {c.rank && (
                    <Badge variant="secondary" className="text-xs">
                      {c.rank}
                    </Badge>
                  )}
                </div>
              </CardHeader>
              {c.members && c.members.length > 0 && (
                <CardContent className="pt-0">
                  <p className="text-xs text-muted-foreground font-semibold uppercase tracking-wide mb-2">
                    Members
                  </p>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-1">
                    {c.members.map((m, j) => (
                      <div
                        key={j}
                        className="flex items-center justify-between text-sm py-1 border-b last:border-0"
                      >
                        <RepNameLink name={m.name} bioguideId={m.bioguideId} />
                        <div className="flex gap-1">
                          {m.party && (
                            <Badge className={`text-xs ${partyColor(m.party)}`}>
                              {m.party?.charAt(0)}
                            </Badge>
                          )}
                          {m.state && (
                            <span className="text-muted-foreground text-xs">
                              {m.state}
                            </span>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </CardContent>
              )}
            </Card>
          ))}
      </ListViewport>
    </div>
  );
}

function FinanceTab({ name, state }: { name: string; state?: string }) {
  const searchName = name.split(",")[0].trim();
  const { data: searchData, isLoading: searchLoading } =
    useSearchCandidateFinance(
      { name: searchName, state },
      {
        query: {
          enabled: !!name,
          queryKey: getSearchCandidateFinanceQueryKey({
            name: searchName,
            state,
          }),
        },
      },
    );

  const candidateId = searchData?.candidates?.[0]?.id;
  const { data: financeData, isLoading: financeLoading } =
    useGetCandidateFinance(
      candidateId ?? "",
      {},
      {
        query: {
          enabled: !!candidateId,
          queryKey: getGetCandidateFinanceQueryKey(candidateId ?? "", {}),
        },
      },
    );

  return (
    <div className="flex flex-col h-full">
      <ListViewport className="space-y-6">
        {(searchLoading || financeLoading) && (
          <div className="space-y-3">
            {[...Array(3)].map((_, i) => (
              <Skeleton key={i} className="h-24 w-full" />
            ))}
          </div>
        )}

        {!searchLoading && !financeLoading && !candidateId && (
          <div className="text-center py-10 text-muted-foreground">
            <DollarSign className="h-10 w-10 mx-auto mb-3 opacity-30" />
            <p>No FEC campaign finance records found for this member.</p>
          </div>
        )}

        {!searchLoading && !financeLoading && candidateId && financeData && (
          <>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              {[
                {
                  label: "Total Raised",
                  value: formatMoney(financeData.totalRaised),
                },
                {
                  label: "Total Spent",
                  value: formatMoney(financeData.totalSpent),
                },
                {
                  label: "Cash on Hand",
                  value: formatMoney(financeData.cashOnHand),
                },
              ].map((item) => (
                <Card key={item.label}>
                  <CardContent className="p-4 text-center">
                    <p className="text-2xl font-black">{item.value}</p>
                    <p className="text-xs text-muted-foreground mt-1">
                      {item.label}
                    </p>
                  </CardContent>
                </Card>
              ))}
            </div>

            <div className="grid md:grid-cols-2 gap-6">
              {financeData?.topDonors && financeData.topDonors.length > 0 && (
                <Card>
                  <CardHeader className="pb-3">
                    <CardTitle className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                      Top Donors
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="pt-0 space-y-2">
                    {financeData.topDonors.map((d, i) => (
                      <div
                        key={i}
                        className="flex items-center justify-between py-1.5 border-b last:border-0"
                      >
                        <div>
                          <p className="text-sm font-medium">{d.name}</p>
                          {d.type && (
                            <p className="text-xs text-muted-foreground capitalize">
                              {d.type}
                            </p>
                          )}
                        </div>
                        <span className="text-sm font-bold text-green-700">
                          {formatMoney(d.total)}
                        </span>
                      </div>
                    ))}
                  </CardContent>
                </Card>
              )}

              {financeData?.topIndustries &&
                financeData.topIndustries.length > 0 && (
                  <Card>
                    <CardHeader className="pb-3">
                      <CardTitle className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                        Top Industries
                      </CardTitle>
                    </CardHeader>
                    <CardContent className="pt-0 space-y-2">
                      {financeData.topIndustries.map((d, i) => (
                        <div
                          key={i}
                          className="flex items-center justify-between py-1.5 border-b last:border-0"
                        >
                          <p className="text-sm font-medium">{d.name}</p>
                          <span className="text-sm font-bold text-green-700">
                            {formatMoney(d.total)}
                          </span>
                        </div>
                      ))}
                    </CardContent>
                  </Card>
                )}
            </div>
          </>
        )}
      </ListViewport>
    </div>
  );
}

export function FederalRepDetail() {
  const { bioguideId } = useParams<{ bioguideId: string }>();
  const queryClient = useQueryClient();
  const pageSearch = useSearch();
  const initialParams = new URLSearchParams(pageSearch);

  const memberQueryKey = [...getGetFederalMemberQueryKey(bioguideId), "v2"];

  const { data: memberData, isLoading } = useGetFederalMember(bioguideId, {
    query: { enabled: !!bioguideId, queryKey: memberQueryKey },
  });

  const member = memberData?.member;
  const cache = memberData?.cache;

  const [billRole, setBillRole] = useState<"sponsored" | "cosponsored">(
    "sponsored",
  );
  const [topIssuesExpanded, setTopIssuesExpanded] = useState(false);
  const isMobile = useIsMobile();
  const [activeTab, setActiveTab] = useState(() => {
    const tab = initialParams.get("tab");
    return tab === "votes" || tab === "committees" || tab === "finance"
      ? tab
      : "bills";
  });
  const [billsFiltersCollapsed, setBillsFiltersCollapsed] = useState(false);
  const billViewRef = useRef<"list" | "policyArea">("list");
  const { data: billSummaryData } = useGetFederalMemberBills(
    bioguideId,
    { type: billRole, offset: 0, limit: 1 },
    {
      query: {
        enabled: !!bioguideId,
        queryKey: getGetFederalMemberBillsQueryKey(bioguideId, {
          type: billRole,
          offset: 0,
          limit: 1,
        }),
        placeholderData: (previous) => previous,
      },
    },
  );

  const topPolicyAreas = (billSummaryData?.policyAreas ?? [])
    .filter((p) => p.name && p.name !== "Other")
    .slice(0, 8);

  const refreshMutation = useRefreshFederalMember({
    mutation: {
      onSuccess: () => {
        toast({
          title: "Refreshed",
          description: "Member data has been updated.",
          duration: 5000,
        });
        queryClient.invalidateQueries({ queryKey: memberQueryKey });
      },
      onError: (err: Error) => {
        toast({
          title: "Refresh failed",
          description: err.message || "Could not refresh from Congress.gov.",
          variant: "destructive",
          duration: 5000,
        });
      },
    },
  });
  const refreshBillsMutation = useRefreshFederalMemberBills({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({
          queryKey: getGetFederalMemberBillsQueryKey(bioguideId),
        });
      },
      onError: (err: Error) => {
        toast({
          title: "Legislation refresh failed",
          description: err.message || "Could not refresh legislation.",
          variant: "destructive",
          duration: 5000,
        });
      },
    },
  });

  const handleRefresh = (e?: React.MouseEvent | React.SyntheticEvent) => {
    if (!bioguideId) return;
    e?.preventDefault?.();
    refreshMutation.mutate({ bioguideId });
    refreshBillsMutation.mutate({ bioguideId, data: { type: billRole } });
  };

  useEffect(() => {
    const params = new URLSearchParams(pageSearch);
    const tab = params.get("tab");
    setActiveTab(
      tab === "votes" || tab === "committees" || tab === "finance"
        ? tab
        : "bills",
    );
  }, [pageSearch]);

  return (
    <PageShell>
        <Link
          href="/"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground mb-6 transition-colors shrink-0"
        >
          <ChevronLeft className="h-4 w-4" /> Back to search
        </Link>

        {isLoading ? (
          <div className="space-y-4">
            <Skeleton className="h-32 w-full rounded-xl" />
            <Skeleton className="h-96 w-full rounded-xl" />
          </div>
        ) : member ? (
          <>
            {member.inOffice === false && (
              <div className="mb-4 flex items-center gap-2 text-sm text-muted-foreground bg-muted border border-border rounded-lg px-4 py-3">
                <AlertTriangle className="h-4 w-4 shrink-0" />
                <span>This member is no longer serving in Congress.</span>
              </div>
            )}
            {cache?.stale && (
              <div className="mb-4 flex items-center gap-2 text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-4 py-3">
                <AlertTriangle className="h-4 w-4 shrink-0" />
                <span className="flex-1">Data may be outdated.</span>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-auto py-1 px-2 text-amber-700 hover:text-amber-800 hover:bg-amber-100"
                  onClick={handleRefresh}
                  disabled={
                    refreshMutation.isPending || refreshBillsMutation.isPending
                  }
                >
                  {refreshMutation.isPending ||
                  refreshBillsMutation.isPending ? (
                    <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    "Refresh"
                  )}
                </Button>
              </div>
            )}

            <RepProfileCard
              photoUrl={member.photoUrl}
              name={member.name}
              belowPhoto={member.website && (
                <a
                  href={member.website}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-xs text-primary hover:underline whitespace-nowrap"
                >
                  Official Website <ExternalLink className="h-3 w-3" />
                </a>
              )}
            >
              <div>
                  <h1 className="sm:text-3xl max-sm:text-[clamp(1rem,4.5vw,1.875rem)] font-black mb-1 sm:mb-2 leading-tight sm:leading-normal">
                    {member.name}
                  </h1>
                  <div className="flex flex-wrap max-sm:flex-nowrap gap-2 max-sm:gap-1 mb-2 sm:mb-3">
                    {member.party && (
                      <Badge className={`${partyColor(member.party)} max-sm:px-1 max-sm:text-[10px]`}>
                        {member.party}
                      </Badge>
                    )}
                    {member.chamber && (
                      <Badge variant="outline" className="max-sm:px-1 max-sm:text-[10px]">
                        <span className="sm:hidden">{member.chamber === "House of Representatives" ? "House" : member.chamber}</span>
                        <span className="hidden sm:inline">{member.chamber}</span>
                      </Badge>
                    )}
                    {member.state && (
                      <Badge variant="secondary" className="max-sm:px-1 max-sm:text-[10px]">
                        <span className="sm:hidden">{getStateCode(member.state) ?? member.state}</span>
                        <span className="hidden sm:inline">{member.state}</span>
                      </Badge>
                    )}
                    {member.district && (
                      <Badge variant="secondary" className="max-sm:px-1 max-sm:text-[10px]">
                        <span className="sm:hidden">Dist. {member.district}</span>
                        <span className="hidden sm:inline">District {member.district}</span>
                      </Badge>
                    )}
                  </div>
                  {billSummaryData?.policyAreas &&
                    billSummaryData.policyAreas.length > 0 && (
                      <div
                        className={`mb-1 ${
                          topIssuesExpanded
                            ? "flex flex-wrap gap-2 items-center"
                            : "max-sm:grid max-sm:grid-cols-[auto_minmax(0,1fr)] max-sm:gap-x-2 sm:flex sm:flex-wrap sm:items-center sm:gap-2"
                        }`}
                      >
                        <span className="text-xs text-muted-foreground font-medium shrink-0">
                          <span className="hidden sm:inline">
                            {billRole === "cosponsored" ? "Top Support Areas" : "Top Sponsored Issues"}:
                          </span>
                          <span className="sm:hidden">
                            {topPolicyAreas.length > 1 ? "Top Issues" : (billRole === "cosponsored" ? "Top Support Areas" : "Top Sponsored Issues")}:
                          </span>
                        </span>
                        {topIssuesExpanded ? (
                          <>
                            {topPolicyAreas.map((area) => (
                              <Badge
                                key={area.name}
                                variant="outline"
                                className="text-xs bg-primary/5 border-primary/20"
                              >
                                {area.name}
                              </Badge>
                            ))}
                            {topPolicyAreas.length > 1 && (
                              <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                className="h-6 px-2 text-xs shrink-0"
                                onClick={() => setTopIssuesExpanded((prev) => !prev)}
                              >
                                Hide <ChevronUp className="h-3 w-3 ml-1" />
                              </Button>
                            )}
                          </>
                        ) : (
                          <div className="max-sm:flex max-sm:flex-wrap max-sm:gap-1 sm:contents">
                            {topPolicyAreas[0] && (
                              <Badge
                                variant="outline"
                                className="text-xs bg-primary/5 border-primary/20 min-w-0 max-sm:w-full sm:max-w-[36ch] truncate"
                              >
                                {topPolicyAreas[0].name}
                              </Badge>
                            )}
                            {topPolicyAreas.length > 1 && (
                              <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                className="h-6 px-2 text-xs shrink-0"
                                onClick={() => setTopIssuesExpanded((prev) => !prev)}
                              >
                                show more... <ChevronDown className="h-3 w-3 ml-1" />
                              </Button>
                            )}
                          </div>
                        )}
                      </div>
                    )}
                  <div className="flex flex-wrap gap-4 text-sm text-muted-foreground">
                    {member.phone && <span>{member.phone}</span>}
                    {member.nextElection && (
                      <span>Next election: {member.nextElection}</span>
                    )}
                  </div>
                  {member.website && (
                    <a
                      href={member.website}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="hidden sm:inline-flex items-center gap-1 text-sm text-primary hover:underline mt-2"
                    >
                      Official Website{" "}
                      <ExternalLink className="h-3 w-3" />
                    </a>
                  )}
                </div>
            </RepProfileCard>

            <Tabs
              value={activeTab}
              onValueChange={(v) => {
                if (v === "bills" && activeTab !== "bills") setBillsFiltersCollapsed(false);
                setActiveTab(v);
              }}
              className="flex flex-col flex-1 min-h-0"
            >
              <div className="flex items-stretch gap-1 mb-6 shrink-0 max-sm:mb-4">
                <TabsList className="flex-1">
                  <TabsTrigger
                    value="bills"
                    className="flex-1 gap-1.5"
                    onClick={() => {
                      if (isMobile && activeTab === "bills" && billViewRef.current === "list") {
                        setBillsFiltersCollapsed((prev) => !prev);
                      }
                    }}
                  >
                    <FileText className="h-4 w-4" />
                    <span className="hidden sm:inline">Bills</span>
                  </TabsTrigger>
                  <TabsTrigger value="votes" className="flex-1 gap-1.5">
                    <Vote className="h-4 w-4" />
                    <span className="hidden sm:inline">Votes</span>
                  </TabsTrigger>
                  <TabsTrigger value="committees" className="flex-1 gap-1.5">
                    <Users className="h-4 w-4" />
                    <span className="hidden sm:inline">Committees</span>
                  </TabsTrigger>
                  <TabsTrigger value="finance" className="flex-1 gap-1.5">
                    <DollarSign className="h-4 w-4" />
                    <span className="hidden sm:inline">Finance</span>
                  </TabsTrigger>
                </TabsList>
                <Button
                  size="sm"
                  variant="outline"
                  className="sm:hidden shrink-0 px-2"
                  onClick={handleRefresh}
                  disabled={refreshMutation.isPending || refreshBillsMutation.isPending}
                  title="Refresh data"
                >
                  <RefreshCw className={`h-4 w-4 ${refreshMutation.isPending || refreshBillsMutation.isPending ? "animate-spin" : ""}`} />
                </Button>
              </div>

              <TabsContent
                value="bills"
                className="flex-1 min-h-0 data-[state=active]:flex data-[state=active]:flex-col"
              >
                <BillsList
                  bioguideId={bioguideId}
                  memberName={member.name}
                  billRole={billRole}
                  onBillRoleChange={setBillRole}
                  filtersCollapsed={billsFiltersCollapsed}
                  onBillViewChange={(v) => { billViewRef.current = v; }}
                />
              </TabsContent>
              <TabsContent
                value="votes"
                className="flex-1 min-h-0 data-[state=active]:flex data-[state=active]:flex-col"
              >
                <VotesList
                  bioguideId={bioguideId}
                  memberChamber={member.chamber}
                  memberName={member.name}
                />
              </TabsContent>
              <TabsContent
                value="committees"
                className="flex-1 min-h-0 data-[state=active]:flex data-[state=active]:flex-col"
              >
                <CommitteesList bioguideId={bioguideId} />
              </TabsContent>
              <TabsContent
                value="finance"
                className="flex-1 min-h-0 data-[state=active]:flex data-[state=active]:flex-col"
              >
                <FinanceTab name={member.name ?? ""} state={member.state} />
              </TabsContent>
            </Tabs>
          </>
        ) : (
          <div className="text-center py-20 text-muted-foreground">
            Member not found.
          </div>
        )}
    </PageShell>
  );
}
