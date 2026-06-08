import { useState, useEffect, useRef } from "react";
import { useMobileInfiniteScroll } from "@/hooks/useMobileInfiniteScroll";
import { useParams, Link, useSearch, useSearchParams } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetStateMember,
  useGetStateMemberBills,
  useGetStateMemberVotes,
  useSearchCandidateFinance,
  useGetCandidateFinance,
  useRefreshStateMember,
  useRefreshStateMemberBills,
  getGetStateMemberQueryKey,
  getGetStateMemberBillsQueryKey,
  getGetStateMemberVotesQueryKey,
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
  ChevronLeft,
  Users,
  FileText,
  Vote,
  DollarSign,
  ExternalLink,
  RefreshCw,
  AlertTriangle,
  Search,
} from "lucide-react";
import { Input } from "@/components/ui/input";
import {
  partyColor,
  formatMoney,
  BILL_STAGE_OPTIONS,
  buildBillStageQuery,
  billNumberClass,
  toggleBillStageSelection,
  type BillStage,
} from "@/lib/rep-utils";
import { PageShell } from "@/components/layout/PageShell";
import { ListViewport } from "@/components/layout/ListViewport";
import { PaginationFooter } from "@/components/layout/PaginationFooter";
import { FilterBar } from "@/components/layout/FilterBar";
import { StatusStagePills } from "@/components/layout/StatusFilterControls";
import { useIsMobile } from "@/hooks/useIsMobile";
import { useDebounce } from "@/hooks/useDebounce";
import { getApiErrorStatus, getApiErrorMessage } from "@/lib/apiError";
import { billFromParam, stateBillPath } from "@/lib/routes";
import { buildVoteSearch, parseVoteSearchState, type VoteFilter } from "@/lib/voteSearchParams";

function StateBillsList({ memberId, jurisdiction, memberName, onRefresh, refreshPending, billType, onBillTypeChange }: { memberId: string; jurisdiction?: string; memberName?: string; onRefresh?: () => void; refreshPending?: boolean; billType: "sponsored" | "cosponsored"; onBillTypeChange: (t: "sponsored" | "cosponsored") => void }) {
  const isMobile = useIsMobile();
  const pageSearch = useSearch();
  const initialParams = new URLSearchParams(pageSearch);
  const type = billType;
  const setType = onBillTypeChange;
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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [allBills, setAllBills] = useState<any[]>([]);
  const appendedOffsetRef = useRef(new Set<number>());
  const scrollRatioRef = useRef(0);
  const [lastVisible, setLastVisible] = useState(1);
  const prevFilterKeyRef = useRef<string | null>(null);
  const limit = 20;
  const statusFilterActive = selectedStages.length > 0;
  const stageQuery = buildBillStageQuery(selectedStages);

  const filterKey = `${type}|${debouncedSearchQuery}|${stageQuery ?? ""}`;

  const queryParams = {
    type,
    jurisdiction,
    offset,
    limit,
    q: debouncedSearchQuery || undefined,
    stages: stageQuery,
  };
  const { data, isLoading, isPlaceholderData, error } = useGetStateMemberBills(memberId, queryParams, {
    query: {
      enabled: !!memberId,
      queryKey: getGetStateMemberBillsQueryKey(memberId, queryParams),
      placeholderData: (previous) => previous,
    }
  });
  const visibleBills = data?.bills ?? [];
  const effectiveTotalCount = data?.totalCount ?? 0;
  const rateLimited = getApiErrorStatus(error) === 429;
  const errorMessage = error ? getApiErrorMessage(error) : undefined;

  const backPathParams = new URLSearchParams();
  backPathParams.set("type", type);
  backPathParams.set("offset", String(offset));
  if (debouncedSearchQuery) backPathParams.set("q", debouncedSearchQuery);
  if (selectedStages.length > 0)
    backPathParams.set("stages", selectedStages.join(","));
  const backPath = `/rep/state/${memberId}?${backPathParams.toString()}`;
  const scrollStorageKey = `scroll:${backPath}:bills`;
  const fromParam = memberName
    ? `?from=${encodeURIComponent(backPath)}&name=${encodeURIComponent(memberName)}`
    : `?from=${encodeURIComponent(backPath)}`;

  useEffect(() => {
    restoredScrollRef.current = false;
  }, [scrollStorageKey]);

  useEffect(() => {
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
  }, [isMobile, isLoading, scrollStorageKey]);

  // Mobile: reset accumulation when filters change
  useEffect(() => {
    if (!isMobile) return;
    if (prevFilterKeyRef.current === filterKey) return;
    if (prevFilterKeyRef.current !== null) {
      setAllBills([]);
      appendedOffsetRef.current = new Set();
    }
    prevFilterKeyRef.current = filterKey;
  }, [filterKey, isMobile]);

  // Mobile: append new page to accumulated list
  useEffect(() => {
    if (!isMobile) return;
    if (isLoading || isPlaceholderData) return;
    if (appendedOffsetRef.current.has(offset)) return;
    appendedOffsetRef.current.add(offset);
    if (visibleBills.length > 0) {
      setAllBills((prev) => [...prev, ...visibleBills]);
    }
  }, [isMobile, isLoading, isPlaceholderData, offset, visibleBills]);

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
    totalCount: effectiveTotalCount,
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

  const billsToRender = isMobile ? (allBills as typeof visibleBills) : visibleBills;

  return (
    <div className="flex flex-col h-full pb-4">
      <FilterBar className="flex justify-between items-center gap-2 flex-wrap">
        <div className="flex gap-2">
          <Button size="sm" variant={type === "sponsored" ? "default" : "outline"} onClick={() => { setType("sponsored"); setOffset(0); }}>Sponsored</Button>
          <Button size="sm" variant={type === "cosponsored" ? "default" : "outline"} onClick={() => { setType("cosponsored"); setOffset(0); }}>Cosponsored</Button>
          {onRefresh && (
            <Button
              size="sm"
              variant="outline"
              className="hidden sm:inline-flex"
              onClick={onRefresh}
              disabled={refreshPending}
              title="Refresh bills"
            >
              <RefreshCw className={`h-4 w-4 ${refreshPending ? "animate-spin" : ""}`} />
            </Button>
          )}
        </div>
      </FilterBar>
      <StatusStagePills
        selectedStages={selectedStages}
        onToggleStage={(stage) => {
          setSelectedStages((prev) => toggleBillStageSelection(prev, stage));
          setOffset(0);
        }}
      />
      <FilterBar className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input
          placeholder="Search bills..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="pl-9"
        />
      </FilterBar>

      <p className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-2 shrink-0">
        {type === "cosponsored" ? "Cosponsored Bills" : "Sponsored Bills"}
      </p>
      <ListViewport
        ref={listViewportRef}
        onScroll={handleScroll}
      >
        {isLoading && !allBills.length && <div>{[...Array(5)].map((_, i) => <Skeleton key={i} className="h-20 w-full" />)}</div>}

        {!isLoading && error && (
          <Card className={rateLimited ? "border-amber-300 bg-amber-50" : "border-destructive/40"}>
            <CardContent className="flex gap-3 p-4 text-sm">
              <AlertTriangle className={rateLimited ? "mt-0.5 h-4 w-4 shrink-0 text-amber-600" : "mt-0.5 h-4 w-4 shrink-0 text-destructive"} />
              <div>
                <p className="font-semibold">
                  {rateLimited ? "OpenStates rate limit reached" : "Could not load state bills"}
                </p>
                <p className="mt-1 text-muted-foreground">{errorMessage}</p>
              </div>
            </CardContent>
          </Card>
        )}

        {!isLoading && !error && billsToRender.length === 0 && (
          <p className="text-muted-foreground text-center py-10">No bills found.</p>
        )}

        {!error && billsToRender.map((bill) => {
          return (
            <Link
              key={bill.id}
              href={`/bills/state/${encodeURIComponent(bill.id)}${fromParam}`}
              onClick={() => {
                if (typeof window === "undefined") return;
                const top = listViewportRef.current?.scrollTop ?? 0;
                window.sessionStorage.setItem(scrollStorageKey, String(top));
              }}
            >
              <Card className="hover:border-primary transition-colors cursor-pointer">
                <CardContent className={statusFilterActive ? "p-3" : "p-4"}>
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        {bill.identifier && <Badge variant="outline" className={`text-xs font-mono shrink-0 ${billNumberClass(bill.stageDead, bill.stageSignedEnacted)}`}>{bill.identifier}</Badge>}
                        {bill.session && <Badge variant="outline" className="text-xs shrink-0">Session {bill.session}</Badge>}
                        {bill.chamber && <Badge variant="secondary" className="text-xs">{bill.chamber}</Badge>}
                      </div>
                      <p className={`font-medium ${statusFilterActive ? "text-sm line-clamp-1" : "text-sm line-clamp-2"}`}>{bill.title}</p>
                      {bill.latestAction && <p className={`text-muted-foreground mt-1 ${statusFilterActive ? "text-[11px] line-clamp-1" : "text-xs line-clamp-1"}`}>{bill.latestAction}</p>}
                    </div>
                    {bill.introducedDate && <span className="text-xs text-muted-foreground shrink-0">{bill.introducedDate}</span>}
                  </div>
                </CardContent>
              </Card>
            </Link>
          );
        })}
        {isMobile && <div ref={sentinelRef} className="h-16" />}
      </ListViewport>

      <div className="sm:hidden text-xs text-center text-muted-foreground py-2 shrink-0">
        {allBills.length > 0 && effectiveTotalCount > 0
          ? `${lastVisible}/${effectiveTotalCount}${isLoading ? " ···" : ""}`
          : isLoading ? "···" : ""}
      </div>
      <div className="hidden sm:block">
        <PaginationFooter
          offset={offset}
          limit={limit}
          totalCount={effectiveTotalCount}
          onPrevious={() => setOffset(Math.max(0, offset - limit))}
          onNext={() => setOffset(offset + limit)}
        />
      </div>
    </div>
  );
}

function StateVotesList({ memberId, jurisdiction, memberName, memberChamber }: { memberId: string; jurisdiction?: string; memberName?: string; memberChamber?: string }) {
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

  const queryParams = { jurisdiction, offset, limit, filter, q: debouncedSearchQuery || undefined };
  const { data, isLoading, isPlaceholderData } = useGetStateMemberVotes(memberId, queryParams, {
    query: {
      enabled: !!memberId,
      queryKey: getGetStateMemberVotesQueryKey(memberId, queryParams),
      placeholderData: (previous) => previous,
    }
  });

  const votes = data?.votes ?? [];
  const totalCount = data?.totalCount ?? 0;
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
  const returnPath = `/rep/state/${memberId}?${returnParams.toString()}`;
  const restorationScrollStorageKey = `scroll:${returnPath}:votes`;
  const backPathParams = new URLSearchParams();
  backPathParams.set("tab", "votes");
  backPathParams.set("offset", String(offset));
  if (debouncedSearchQuery) backPathParams.set("q", debouncedSearchQuery);
  if (filter !== "all") backPathParams.set("filter", filter);
  const backPath = `/rep/state/${memberId}?${backPathParams.toString()}`;
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
        {isLoading && !allVotes.length && <div>{[...Array(5)].map((_, i) => <Skeleton key={i} className="h-16 w-full" />)}</div>}

        {!isLoading && votesToRender.length === 0 && (
          <p className="text-muted-foreground text-center py-10">No voting records found.</p>
        )}

        {votesToRender.map((vote, i) => {
          const href = vote.billId ? `${stateBillPath(vote.billId)}${fromParam}` : null;
          return (
            <VoteListCard
              key={i}
              href={href}
              badges={[
                {
                  label: memberChamber ?? "State",
                  variant: "outline",
                  className: "text-xs",
                },
                ...(vote.billIdentifier
                  ? [{
                      label: vote.billIdentifier,
                      variant: "secondary" as const,
                      className: "text-xs font-mono",
                    }]
                  : []),
              ]}
              title={vote.billTitle}
              date={vote.date}
              voteCast={vote.position}
              voteResult={vote.result}
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

function StateFinanceTab({ name, state }: { name: string; state?: string }) {
  const { data: searchData, isLoading: searchLoading } = useSearchCandidateFinance({ name, state }, {
    query: { enabled: !!name, queryKey: getSearchCandidateFinanceQueryKey({ name, state }) }
  });

  const candidateId = searchData?.candidates?.[0]?.id;
  const { data: financeData, isLoading: financeLoading } = useGetCandidateFinance(candidateId ?? "", {}, {
    query: { enabled: !!candidateId, queryKey: getGetCandidateFinanceQueryKey(candidateId ?? "", {}) }
  });

  return (
    <div className="flex flex-col h-full">
      <ListViewport className="space-y-6">
        {(searchLoading || financeLoading) && <div className="space-y-3">{[...Array(3)].map((_, i) => <Skeleton key={i} className="h-24 w-full" />)}</div>}

        {!searchLoading && !financeLoading && !candidateId && (
          <div className="text-center py-10 text-muted-foreground">
            <DollarSign className="h-10 w-10 mx-auto mb-3 opacity-30" />
            <p>No FEC campaign finance records found for this member.</p>
            <p className="text-sm mt-2">State legislators may not have federal FEC filings.</p>
          </div>
        )}

        {!searchLoading && !financeLoading && candidateId && financeData && (
          <>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              {[
                { label: "Total Raised", value: formatMoney(financeData.totalRaised) },
                { label: "Total Spent", value: formatMoney(financeData.totalSpent) },
                { label: "Cash on Hand", value: formatMoney(financeData.cashOnHand) },
              ].map((item) => (
                <Card key={item.label}>
                  <CardContent className="p-4 text-center">
                    <p className="text-2xl font-black">{item.value}</p>
                    <p className="text-xs text-muted-foreground mt-1">{item.label}</p>
                  </CardContent>
                </Card>
              ))}
            </div>

            <div className="grid md:grid-cols-2 gap-6">
              {financeData?.topDonors && financeData.topDonors.length > 0 && (
                <Card>
                  <CardHeader className="pb-3">
                    <CardTitle className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">Top Donors</CardTitle>
                  </CardHeader>
                  <CardContent className="pt-0 space-y-2">
                    {financeData.topDonors.map((d, i) => (
                      <div key={i} className="flex items-center justify-between py-1.5 border-b last:border-0">
                        <div>
                          <p className="text-sm font-medium">{d.name}</p>
                          {d.type && <p className="text-xs text-muted-foreground capitalize">{d.type}</p>}
                        </div>
                        <span className="text-sm font-bold text-green-700">{formatMoney(d.total)}</span>
                      </div>
                    ))}
                  </CardContent>
                </Card>
              )}

              {financeData?.topIndustries && financeData.topIndustries.length > 0 && (
                <Card>
                  <CardHeader className="pb-3">
                    <CardTitle className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">Top Industries</CardTitle>
                  </CardHeader>
                  <CardContent className="pt-0 space-y-2">
                    {financeData.topIndustries.map((d, i) => (
                      <div key={i} className="flex items-center justify-between py-1.5 border-b last:border-0">
                        <p className="text-sm font-medium">{d.name}</p>
                        <span className="text-sm font-bold text-green-700">{formatMoney(d.total)}</span>
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

function CommitteesFromBills() {
  return (
    <div className="flex flex-col h-full">
      <ListViewport>
        <div className="text-center py-10 text-muted-foreground">
          <Users className="h-10 w-10 mx-auto mb-3 opacity-30" />
          <p>Committee memberships for state legislators are available through the state legislature website.</p>
        </div>
      </ListViewport>
    </div>
  );
}

export function StateRepDetail() {
  const { memberId } = useParams<{ memberId: string }>();
  const apiMemberId = encodeURIComponent(memberId);
  const queryClient = useQueryClient();
  const pageSearch = useSearch();
  const initialParams = new URLSearchParams(pageSearch);

  const { data: memberData, isLoading } = useGetStateMember(apiMemberId, {
    query: { enabled: !!apiMemberId, queryKey: getGetStateMemberQueryKey(apiMemberId) }
  });

  const member = memberData?.legislator;
  const cache = memberData?.cache;

  const [billType, setBillType] = useState<"sponsored" | "cosponsored">("sponsored");
  const [activeTab, setActiveTab] = useState(() => {
    const tab = initialParams.get("tab");
    return tab === "votes" || tab === "committees" || tab === "finance"
      ? tab
      : "bills";
  });

  const refreshMutation = useRefreshStateMember({
    mutation: {
      onSuccess: () => {
        toast({
          title: "Refreshed",
          description: "Legislator data has been updated.",
          duration: 5000,
        });
      },
      onError: (err: Error) => {
        toast({
          title: "Refresh failed",
          description: err.message || "Could not refresh from OpenStates.",
          variant: "destructive",
          duration: 5000,
        });
      },
    },
  });

  const refreshBillsMutation = useRefreshStateMemberBills({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({
          queryKey: getGetStateMemberBillsQueryKey(apiMemberId),
        });
        toast({
          title: "Bills refreshed",
          description: "Sponsored legislation is being updated.",
          duration: 5000,
        });
      },
      onError: (err: Error) => {
        toast({
          title: "Bills refresh failed",
          description: err.message || "Could not refresh bills.",
          variant: "destructive",
          duration: 5000,
        });
      },
    },
  });

  useEffect(() => {
    if (cache?.refreshFailed) {
      toast({
        title: "Data may be outdated",
        description: "Could not refresh from OpenStates. Showing cached data.",
        variant: "destructive",
        duration: 5000,
      });
    }
  }, [cache?.refreshFailed]);

  const handleRefresh = (e?: React.MouseEvent | React.SyntheticEvent) => {
    if (!apiMemberId) return;
    e?.preventDefault?.();
    refreshMutation.mutate({ memberId: apiMemberId });
    refreshBillsMutation.mutate({
      memberId: apiMemberId,
      data: { type: billType },
    });
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
        <Link href="/" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground mb-6 transition-colors shrink-0">
          <ChevronLeft className="h-4 w-4" /> Back to search
        </Link>

        {isLoading ? (
          <div className="space-y-4">
            <Skeleton className="h-32 w-full rounded-xl" />
            <Skeleton className="h-96 w-full rounded-xl" />
          </div>
        ) : member ? (
          <>
            {cache?.stale && (
              <div className="mb-4 flex items-center gap-2 text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-4 py-3">
                <AlertTriangle className="h-4 w-4 shrink-0" />
                <span className="flex-1">Data may be outdated.</span>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-auto py-1 px-2 text-amber-700 hover:text-amber-800 hover:bg-amber-100"
                  onClick={handleRefresh}
                  disabled={refreshMutation.isPending}
                >
                  {refreshMutation.isPending ? (
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
              belowPhoto={member.openstatesUrl && (
                <a href={member.openstatesUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-xs text-primary hover:underline">
                  OpenStates Profile <ExternalLink className="h-3 w-3" />
                </a>
              )}
            >
              <div>
                  <h1 className="text-3xl font-black mb-1 sm:mb-2 leading-tight sm:leading-normal">{member.name}</h1>
                  <div className="flex flex-wrap gap-2 mb-2 sm:mb-3">
                    {member.party && <Badge className={partyColor(member.party)}>{member.party}</Badge>}
                    {member.chamber && <Badge variant="outline">{member.chamber}</Badge>}
                    {member.district && <Badge variant="secondary">District {member.district}</Badge>}
                  </div>
                  <div className="flex flex-wrap gap-4 text-sm text-muted-foreground">
                    {member.email && <a href={`mailto:${member.email}`} className="hover:text-foreground transition-colors">{member.email}</a>}
                    {member.phone && <span>{member.phone}</span>}
                  </div>
                  {member.openstatesUrl && (
                    <a href={member.openstatesUrl} target="_blank" rel="noopener noreferrer" className="hidden sm:inline-flex items-center gap-1 text-sm text-primary hover:underline mt-2">
                      OpenStates Profile <ExternalLink className="h-3 w-3" />
                    </a>
                  )}
                </div>
            </RepProfileCard>

            <Tabs value={activeTab} onValueChange={setActiveTab} className="flex flex-col flex-1 min-h-0">
              <div className="flex items-stretch gap-1 mb-6 shrink-0 max-sm:mb-4">
                <TabsList className="flex-1">
                  <TabsTrigger value="bills" className="flex-1 gap-1.5"><FileText className="h-4 w-4" /><span className="hidden sm:inline">Bills</span></TabsTrigger>
                  <TabsTrigger value="votes" className="flex-1 gap-1.5"><Vote className="h-4 w-4" /><span className="hidden sm:inline">Votes</span></TabsTrigger>
                  <TabsTrigger value="committees" className="flex-1 gap-1.5"><Users className="h-4 w-4" /><span className="hidden sm:inline">Committees</span></TabsTrigger>
                  <TabsTrigger value="finance" className="flex-1 gap-1.5"><DollarSign className="h-4 w-4" /><span className="hidden sm:inline">Finance</span></TabsTrigger>
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

              <TabsContent value="bills" className="flex-1 min-h-0 data-[state=active]:flex data-[state=active]:flex-col"><StateBillsList memberId={apiMemberId} jurisdiction={member.jurisdiction} memberName={member.name} onRefresh={handleRefresh} refreshPending={refreshMutation.isPending || refreshBillsMutation.isPending} billType={billType} onBillTypeChange={setBillType} /></TabsContent>
              <TabsContent value="votes" className="flex-1 min-h-0 data-[state=active]:flex data-[state=active]:flex-col"><StateVotesList memberId={apiMemberId} jurisdiction={member.jurisdiction} memberName={member.name} memberChamber={member.chamber} /></TabsContent>
              <TabsContent value="committees" className="flex-1 min-h-0 data-[state=active]:flex data-[state=active]:flex-col"><CommitteesFromBills /></TabsContent>
              <TabsContent value="finance" className="flex-1 min-h-0 data-[state=active]:flex data-[state=active]:flex-col"><StateFinanceTab name={member.name ?? ""} state={member.state} /></TabsContent>
            </Tabs>
          </>
        ) : (
          <div className="text-center py-20 text-muted-foreground">Member not found.</div>
        )}
    </PageShell>
  );
}
