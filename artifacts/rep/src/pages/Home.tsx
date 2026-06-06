import { useState, useEffect } from "react";
import { Link, useSearch } from "wouter";
import {
  useGetRepresentativesByAddress,
  getGetRepresentativesByAddressQueryKey,
  useGetFederalStateMembers,
  getGetFederalStateMembersQueryKey,
  useSearchFederalBills,
  getSearchFederalBillsQueryKey,
  useSearchStateBills,
  getSearchStateBillsQueryKey,
  useSearchFederalMembers,
  getSearchFederalMembersQueryKey,
  useSearchStateMembers,
  getSearchStateMembersQueryKey,
} from "@workspace/api-client-react";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Search, AlertTriangle, FileText } from "lucide-react";
import { useAppState } from "@/lib/app-state";
import { useIsMobile } from "@/hooks/useIsMobile";
import { useDebounce } from "@/hooks/useDebounce";
import { US_STATES, getStateName, getStateFlagUrl } from "@/lib/states";
import { partyColor } from "@/lib/rep-utils";
import { StateMemberPhotoImage } from "@/components/StateMemberPhotoImage";
import type { Representative } from "@workspace/api-client-react";

// Exported for testing. Reps are loaded via searchAddress (from lastSearchedAddress),
// so the query box intentionally starts empty — the "Showing results for" header
// already shows the active address, and the box should be ready for bill/rep search.
export function resolveInitialQuery(pageSearch: string): string {
  const q = new URLSearchParams(pageSearch).get("q");
  return q ?? "";
}

export function Home() {
  const { selectedState, setSelectedState, lastSearchedAddress, setLastSearchedAddress } = useAppState();
  const isMobile = useIsMobile();
  const pageSearch = useSearch();
  const [homeDropdownState, setHomeDropdownState] = useState(lastSearchedAddress ? "" : (selectedState ?? ""));
  const [searchAddress, setSearchAddress] = useState(lastSearchedAddress ?? "");
  const [activeTextQuery, setActiveTextQuery] = useState("");
  const [query, setQuery] = useState(() => resolveInitialQuery(pageSearch));
  const [fallbackQuery, setFallbackQuery] = useState<string | null>(null);
  const [fallbackState, setFallbackState] = useState<string | null>(null);
  const [addressAttemptPending, setAddressAttemptPending] = useState(false);
  const [inputFocused, setInputFocused] = useState(false);
  const debouncedQuery = useDebounce(query.trim(), 250);

  const searchLimit = 5;

  // Dropdown queries — fire while typing (debounced). Use standard query key functions so
  // the results queries below share the cache when activeTextQuery === debouncedQuery.
  const acFbParams = { q: debouncedQuery, limit: searchLimit };
  const acSbParams = { q: debouncedQuery, jurisdiction: selectedState?.toLowerCase(), limit: searchLimit };
  const acMemParams = { q: debouncedQuery, limit: searchLimit };

  const { data: acFederalBills } = useSearchFederalBills(acFbParams, {
    query: { enabled: !!debouncedQuery, queryKey: getSearchFederalBillsQueryKey(acFbParams) },
  });
  const { data: acStateBills } = useSearchStateBills(acSbParams, {
    query: { enabled: !!debouncedQuery, queryKey: getSearchStateBillsQueryKey(acSbParams) },
  });
  const { data: acFederalMembers } = useSearchFederalMembers(acMemParams, {
    query: { enabled: !!debouncedQuery, queryKey: getSearchFederalMembersQueryKey(acMemParams) },
  });
  const { data: acStateMembers } = useSearchStateMembers(acMemParams, {
    query: { enabled: !!debouncedQuery, queryKey: getSearchStateMembersQueryKey(acMemParams) },
  });

  const hasAcResults =
    (acFederalBills?.bills?.length ?? 0) > 0 ||
    (acStateBills?.bills?.length ?? 0) > 0 ||
    (acFederalMembers?.members?.length ?? 0) > 0 ||
    (acStateMembers?.members?.length ?? 0) > 0;

  const { data, isLoading, error } = useGetRepresentativesByAddress(
    { address: searchAddress },
    {
      query: {
        enabled: !!searchAddress,
        queryKey: getGetRepresentativesByAddressQueryKey({ address: searchAddress }),
      },
    },
  );

  // When address search results arrive, update global selected state to match
  useEffect(() => {
    if (data?.stateCode) {
      setSelectedState(data.stateCode.toUpperCase());
    }
  }, [data?.stateCode, setSelectedState]);

  const showStateMembers = !lastSearchedAddress && !!selectedState;
  const { data: stateMembersData, isLoading: stateMembersLoading } = useGetFederalStateMembers(
    { state: selectedState || "" },
    {
      query: {
        enabled: showStateMembers,
        queryKey: getGetFederalStateMembersQueryKey({ state: selectedState || "" }),
      },
    },
  );

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = query.trim();
    if (!trimmed) return;

    // Address-first path — save current state so it can be restored if lookup fails
    setFallbackState(selectedState);
    setSearchAddress(trimmed);
    setLastSearchedAddress(trimmed);
    setHomeDropdownState("");
    setSelectedState(null);
    setActiveTextQuery("");

    // Keep pending fallback until address query resolves
    setFallbackQuery(trimmed);
    setAddressAttemptPending(true);
  };

  // Results queries — fire after Enter. Share cache with dropdown queries above when
  // activeTextQuery === debouncedQuery (the normal case after a brief typing pause).
  const resFbParams = { q: activeTextQuery, limit: searchLimit };
  const resSbParams = { q: activeTextQuery, jurisdiction: selectedState?.toLowerCase(), limit: searchLimit };
  const resMemParams = { q: activeTextQuery, limit: searchLimit };

  const { data: federalBillsSearch, isLoading: fbLoading } = useSearchFederalBills(resFbParams, {
    query: { enabled: !!activeTextQuery, queryKey: getSearchFederalBillsQueryKey(resFbParams) },
  });
  const { data: stateBillsSearch, isLoading: sbLoading } = useSearchStateBills(resSbParams, {
    query: { enabled: !!activeTextQuery, queryKey: getSearchStateBillsQueryKey(resSbParams) },
  });
  const { data: federalMembersSearch, isLoading: fmLoading } = useSearchFederalMembers(resMemParams, {
    query: { enabled: !!activeTextQuery, queryKey: getSearchFederalMembersQueryKey(resMemParams) },
  });
  const { data: stateMembersSearch, isLoading: smLoading } = useSearchStateMembers(resMemParams, {
    query: { enabled: !!activeTextQuery, queryKey: getSearchStateMembersQueryKey(resMemParams) },
  });

  const textSearchLoading = fbLoading || sbLoading || fmLoading || smLoading;
  const hasTextResults =
    (federalBillsSearch?.bills?.length ?? 0) > 0 ||
    (stateBillsSearch?.bills?.length ?? 0) > 0 ||
    (federalMembersSearch?.members?.length ?? 0) > 0 ||
    (stateMembersSearch?.members?.length ?? 0) > 0;

  const activeStateCode = data?.stateCode?.toUpperCase() ?? selectedState ?? null;
  const activeStateName = getStateName(activeStateCode) ?? "your area";
  const flagUrl = getStateFlagUrl(activeStateCode) ?? getStateFlagUrl("US");

  useEffect(() => {
    if (!addressAttemptPending) return;
    if (!searchAddress) return;
    if (isLoading) return;

    const repsCount = data?.representatives?.length ?? 0;
    const hasAddressSignal = !!(data?.normalizedAddress || data?.stateCode || repsCount > 0);
    const addressFailed = !!error || !hasAddressSignal;

    if (addressFailed && fallbackQuery) {
      // Fallback to bills/representatives text search if address lookup failed.
      // Restore the state context so state bill search is scoped correctly.
      setSearchAddress("");
      setLastSearchedAddress(null);
      setActiveTextQuery(fallbackQuery);
      if (fallbackState) {
        setSelectedState(fallbackState);
        setHomeDropdownState(fallbackState);
      }
    } else if (!addressFailed) {
      // Address resolved — clear input so user can immediately search bills
      setQuery("");
    }

    setAddressAttemptPending(false);
    setFallbackQuery(null);
    setFallbackState(null);
  }, [
    addressAttemptPending,
    searchAddress,
    isLoading,
    error,
    data,
    fallbackQuery,
    fallbackState,
    setLastSearchedAddress,
  ]);

  function renderTextSearchResults() {
    if (textSearchLoading) {
      return (
        <div className="text-center py-20">
          <div className="w-10 h-10 border-4 border-accent border-t-transparent rounded-full animate-spin mx-auto mb-4"></div>
          <p className="text-lg text-muted-foreground">Searching bills and representatives...</p>
        </div>
      );
    }

    if (!hasTextResults) {
      return (
        <div className="text-center py-20 text-muted-foreground">
          <div className="w-24 h-24 bg-muted rounded-full flex items-center justify-center mx-auto mb-6">
            <Search className="h-10 w-10 opacity-50" />
          </div>
          <h2 className="text-2xl font-semibold mb-2">No results found</h2>
          <p className="max-w-md mx-auto">Try a different search term.</p>
        </div>
      );
    }

    return (
      <div className="space-y-12">
        {(federalMembersSearch?.members?.length ?? 0) > 0 && (
          <section>
            <div className="flex items-center justify-between border-b pb-2 mb-4 sticky top-0 bg-muted z-10">
              <h2 className="text-2xl font-black">Federal Representatives</h2>
              <Badge variant="secondary">{federalMembersSearch?.totalCount}</Badge>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {federalMembersSearch?.members?.map((member) => (
                <Link key={member.bioguideId} href={`/rep/federal/${member.bioguideId}`} className="block group">
                  <Card className="h-full transition-all duration-200 hover:shadow-md hover:border-accent">
                    <CardHeader className="flex flex-row items-center gap-4 pb-2">
                      <Avatar className="h-14 w-14 border-2 border-muted">
                        <AvatarImage src={member.photoUrl} alt={member.name} className="object-cover object-top" />
                        <AvatarFallback>{member.name?.substring(0, 2)}</AvatarFallback>
                      </Avatar>
                      <div className="flex flex-col">
                        <h3 className="font-bold text-base group-hover:text-accent transition-colors">{member.name}</h3>
                        <p className="text-sm text-muted-foreground">{member.chamber}{member.district ? `, District ${member.district}` : ""}</p>
                      </div>
                    </CardHeader>
                    <CardContent>
                      <div className="flex flex-wrap gap-2 mt-1">
                        {member.party && <Badge className={`${partyColor(member.party)} hover:${partyColor(member.party)} font-medium text-xs`}>{member.party}</Badge>}
                        {member.state && <Badge variant="outline" className="text-xs">{member.state}</Badge>}
                      </div>
                    </CardContent>
                  </Card>
                </Link>
              ))}
            </div>
          </section>
        )}

        {(stateMembersSearch?.members?.length ?? 0) > 0 && (
          <section>
            <div className="flex items-center justify-between border-b pb-2 mb-4 sticky top-0 bg-muted z-10">
              <h2 className="text-2xl font-black">State Representatives</h2>
              <Badge variant="secondary">{stateMembersSearch?.totalCount}</Badge>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {stateMembersSearch?.members?.map((member) => (
                <Link key={member.id} href={`/rep/state/${encodeURIComponent(member.id)}`} className="block group">
                  <Card className="h-full transition-all duration-200 hover:shadow-md hover:border-accent">
                    <CardHeader className="flex flex-row items-center gap-4 pb-2">
                      <Avatar className="h-14 w-14 border-2 border-muted">
                        <AvatarImage src={member.photoUrl} alt={member.name} className="object-cover object-top" />
                        <AvatarFallback>{member.name?.substring(0, 2)}</AvatarFallback>
                      </Avatar>
                      <div className="flex flex-col">
                        <h3 className="font-bold text-base group-hover:text-accent transition-colors">{member.name}</h3>
                        <p className="text-sm text-muted-foreground">{member.chamber}{member.district ? `, District ${member.district}` : ""}</p>
                      </div>
                    </CardHeader>
                    <CardContent>
                      <div className="flex flex-wrap gap-2 mt-1">
                        {member.party && <Badge className={`${partyColor(member.party)} hover:${partyColor(member.party)} font-medium text-xs`}>{member.party}</Badge>}
                        {member.jurisdiction && <Badge variant="outline" className="text-xs">{member.jurisdiction}</Badge>}
                      </div>
                    </CardContent>
                  </Card>
                </Link>
              ))}
            </div>
          </section>
        )}

        {(federalBillsSearch?.bills?.length ?? 0) > 0 && (
          <section>
            <div className="flex items-center justify-between border-b pb-2 mb-4 sticky top-0 bg-muted z-10">
              <h2 className="text-2xl font-black">Federal Bills</h2>
              <Badge variant="secondary">{federalBillsSearch?.totalCount}</Badge>
            </div>
            <div className="space-y-3">
              {federalBillsSearch?.bills?.map((bill) => (
                <Link key={bill.id} href={(bill.number && bill.congress)
                  ? `/bills/federal/${bill.congress}/${bill.number.split(" ")[0]?.toLowerCase()}/${bill.number.split(" ")[1]}?${billFromParam(activeTextQuery || query.trim())}`
                  : "#"}
                  className="block group"
                >
                  <Card className="hover:border-primary transition-colors cursor-pointer">
                    <CardContent className="p-4">
                      <div className="flex items-start justify-between gap-4">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 mb-1">
                            {bill.number && <Badge variant="outline" className="text-xs font-mono shrink-0">{bill.number}</Badge>}
                            {bill.chamber && <Badge variant="secondary" className="text-xs">{bill.chamber}</Badge>}
                          </div>
                          <p className="font-medium text-sm line-clamp-2">{bill.title}</p>
                          {bill.latestAction && <p className="text-xs text-muted-foreground mt-1 line-clamp-1">{bill.latestAction}</p>}
                        </div>
                        {bill.introducedDate && <span className="text-xs text-muted-foreground shrink-0">{bill.introducedDate}</span>}
                      </div>
                    </CardContent>
                  </Card>
                </Link>
              ))}
            </div>
          </section>
        )}

        {(stateBillsSearch?.bills?.length ?? 0) > 0 && (
          <section>
            <div className="flex items-center justify-between border-b pb-2 mb-4 sticky top-0 bg-muted z-10">
              <h2 className="text-2xl font-black">State Bills {selectedState && <span className="text-lg font-normal text-muted-foreground">({selectedState})</span>}</h2>
              <Badge variant="secondary">{stateBillsSearch?.totalCount}</Badge>
            </div>
            <div className="space-y-3">
              {stateBillsSearch?.bills?.map((bill) => (
                <Link key={bill.id} href={`/bills/state/${encodeURIComponent(bill.id)}?${billFromParam(activeTextQuery || query.trim())}`} className="block group">
                  <Card className="hover:border-primary transition-colors cursor-pointer">
                    <CardContent className="p-4">
                      <div className="flex items-start justify-between gap-4">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 mb-1">
                            {bill.identifier && <Badge variant="outline" className="text-xs font-mono shrink-0">{bill.identifier}</Badge>}
                            {selectedState && <Badge variant="secondary" className="text-xs">{selectedState}</Badge>}
                            {bill.chamber && <Badge variant="secondary" className="text-xs">{bill.chamber}</Badge>}
                          </div>
                          <p className="font-medium text-sm line-clamp-2">{bill.title}</p>
                          {bill.latestAction && <p className="text-xs text-muted-foreground mt-1 line-clamp-1">{bill.latestAction}</p>}
                        </div>
                        {bill.introducedDate && <span className="text-xs text-muted-foreground shrink-0">{bill.introducedDate}</span>}
                      </div>
                    </CardContent>
                  </Card>
                </Link>
              ))}
            </div>
          </section>
        )}

      </div>
    );
  }

  const groupReps = (reps?: Representative[]) => {
    const safeReps = Array.isArray(reps) ? reps : [];
    const federal = safeReps.filter((r) => r.level === "federal");
    const state = safeReps.filter((r) => r.level === "state");
    const local = safeReps.filter((r) => r.level === "local");
    return { federal, state, local };
  };

  const renderRepCard = (rep: Representative) => {
    const partyCls = partyColor(rep.party);

    let linkHref = "#";
    if (rep.level === "federal" && rep.bioguideId) {
      linkHref = `/rep/federal/${rep.bioguideId}`;
    } else if (rep.level === "state" && (rep.openstatesId || rep.name)) {
      const slug = rep.openstatesId || rep.name.toLowerCase().replace(/\s+/g, '-');
      linkHref = `/rep/state/${encodeURIComponent(slug)}`;
    }

    return (
      <Link key={rep.bioguideId || rep.openstatesId || `${rep.name}-${rep.office}`} href={linkHref} className="block group">
        <Card className="h-full transition-all duration-200 hover:shadow-md hover:border-accent">
          <CardHeader className="flex flex-row items-center gap-4 pb-2">
            <Avatar className="h-16 w-16 border-2 border-muted">
              {rep.level === "state" && rep.openstatesId ? (
                <StateMemberPhotoImage
                  proxyPhotoUrl={rep.photoUrl}
                  rawPhotoUrl={rep.rawPhotoUrl}
                  alt={rep.name}
                  className="h-full w-full object-cover object-top"
                  fallbackClassName="flex h-full w-full items-center justify-center bg-muted"
                  fallbackText={rep.name.substring(0, 2)}
                />
              ) : (
                <>
                  <AvatarImage src={rep.photoUrl} alt={rep.name} className="object-cover object-top" />
                  <AvatarFallback>{rep.name.substring(0, 2)}</AvatarFallback>
                </>
              )}
            </Avatar>
            <div className="flex flex-col">
              <h3 className="font-bold text-lg group-hover:text-accent transition-colors">{rep.name}</h3>
              <p className="text-sm text-muted-foreground">{rep.office}</p>
            </div>
          </CardHeader>
          <CardContent>
            <div className="flex flex-wrap gap-2 mt-2">
              {rep.party && (
                <Badge className={`${partyCls} hover:${partyCls} font-medium`}>
                  {rep.party}
                </Badge>
              )}
              {rep.chamber && (
                <Badge variant="outline">{rep.chamber}</Badge>
              )}
            </div>
          </CardContent>
        </Card>
      </Link>
    );
  };

  function billFromParam(q: string) {
    const back = q ? `/?q=${encodeURIComponent(q)}` : "/";
    return `from=${encodeURIComponent(back)}&name=Search`;
  }

  return (
    <div className="h-[calc(100dvh-4rem)] flex flex-col overflow-hidden">
      {/* Hero Section */}
      <div
        data-testid="home-hero"
        className="bg-primary text-primary-foreground py-20 max-sm:py-4 px-4 relative overflow-visible shrink-0 z-20"
      >
        <div data-testid="home-hero-background" className="absolute inset-0 overflow-hidden pointer-events-none">
          {flagUrl && (
            <div
              className="absolute inset-0 opacity-20 bg-cover bg-center"
              style={{ backgroundImage: `url('${flagUrl}')` }}
            />
          )}
        </div>
        <div className="container mx-auto max-w-3xl relative z-10 text-center">
          <h1 className="text-xl sm:text-4xl md:text-5xl font-black mb-6 max-sm:mb-2 tracking-tight whitespace-nowrap">
            Know Your Representatives
          </h1>
          <p className="hidden sm:block text-lg md:text-xl text-primary-foreground/80 mb-10 max-w-2xl mx-auto">
            Discover who represents you at the federal and state levels. Track their bills, votes, and campaign finance.
          </p>

          <div className="flex flex-col gap-4 max-sm:gap-2 max-w-xl mx-auto">
            <form onSubmit={handleSubmit} className="flex flex-col gap-4 max-sm:gap-2">
              <div className="flex flex-col sm:flex-row gap-3">
                <div className="relative flex-grow">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-5 w-5 text-muted-foreground" />
                  <Input
                    type="text"
                    placeholder={
                      lastSearchedAddress
                        ? (isMobile ? "Search bills or representatives" : "Search bills or representatives... then hit <return>")
                        : (isMobile ? "Enter address, bill, or representative" : "Enter address, bill, or representative... then hit <return>")
                    }
                    className="pl-10 h-14 max-sm:h-10 text-lg max-sm:text-sm bg-background text-foreground border-0 shadow-lg rounded-xl focus-visible:ring-accent"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    onFocus={() => setInputFocused(true)}
                    onBlur={(e) => {
                      const related = e.relatedTarget as HTMLElement | null;
                      const container = e.currentTarget.closest(".relative");
                      if (!container?.contains(related)) setInputFocused(false);
                    }}
                  />
                  {inputFocused && hasAcResults && (
                    <div
                      data-testid="global-search-autocomplete"
                      className="absolute left-0 right-0 top-full mt-1 bg-popover border rounded-xl shadow-xl z-[100] max-h-[min(28rem,60vh)] overflow-y-auto text-left"
                    >
                      {(acFederalMembers?.members?.length ?? 0) > 0 && (
                        <div className="py-2">
                          <p className="px-4 py-1 text-xs font-semibold text-muted-foreground uppercase tracking-wide">Federal Representatives</p>
                          {acFederalMembers?.members?.map((m) => (
                            <Link key={m.bioguideId} href={`/rep/federal/${m.bioguideId}`} className="flex items-center gap-3 px-4 py-2 hover:bg-accent/10 transition-colors"
                              onMouseDown={(e) => e.preventDefault()}
                            >
                              <Avatar className="h-8 w-8 border">
                                <AvatarImage src={m.photoUrl} alt={m.name} />
                                <AvatarFallback className="text-xs">{m.name?.substring(0, 2)}</AvatarFallback>
                              </Avatar>
                              <div className="min-w-0">
                                <p className="text-sm font-medium truncate">{m.name}</p>
                                <p className="text-xs text-muted-foreground">{m.chamber}{m.district ? `, District ${m.district}` : ""} · {m.state}</p>
                              </div>
                            </Link>
                          ))}
                        </div>
                      )}
                      {(acStateMembers?.members?.length ?? 0) > 0 && (
                        <div className="py-2 border-t">
                          <p className="px-4 py-1 text-xs font-semibold text-muted-foreground uppercase tracking-wide">State Representatives</p>
                          {acStateMembers?.members?.map((m) => (
                            <Link key={m.id} href={`/rep/state/${encodeURIComponent(m.id)}`} className="flex items-center gap-3 px-4 py-2 hover:bg-accent/10 transition-colors"
                              onMouseDown={(e) => e.preventDefault()}
                            >
                              <Avatar className="h-8 w-8 border">
                                <AvatarImage src={m.photoUrl} alt={m.name} />
                                <AvatarFallback className="text-xs">{m.name?.substring(0, 2)}</AvatarFallback>
                              </Avatar>
                              <div className="min-w-0">
                                <p className="text-sm font-medium truncate">{m.name}</p>
                                <p className="text-xs text-muted-foreground">{m.chamber}{m.district ? `, District ${m.district}` : ""} · {m.jurisdiction}</p>
                              </div>
                            </Link>
                          ))}
                        </div>
                      )}
                      {(acFederalBills?.bills?.length ?? 0) > 0 && (
                        <div className="py-2 border-t">
                          <p className="px-4 py-1 text-xs font-semibold text-muted-foreground uppercase tracking-wide">Federal Bills</p>
                          {acFederalBills?.bills?.map((b) => (
                            <Link key={b.id} href={(b.number && b.congress)
                              ? `/bills/federal/${b.congress}/${b.number.split(" ")[0]?.toLowerCase()}/${b.number.split(" ")[1]}?${billFromParam(query.trim())}`
                              : "#"}
                              className="flex items-start gap-3 px-4 py-2 hover:bg-accent/10 transition-colors"
                              onMouseDown={(e) => e.preventDefault()}
                            >
                              <FileText className="h-4 w-4 text-muted-foreground mt-0.5 shrink-0" />
                              <div className="min-w-0">
                                <p className="text-xs font-mono font-semibold text-foreground uppercase">{b.number ?? b.id.split("-").slice(1).join(" ").toUpperCase()}</p>
                                <p className="text-sm text-muted-foreground truncate">{b.title}</p>
                              </div>
                            </Link>
                          ))}
                        </div>
                      )}
                      {(acStateBills?.bills?.length ?? 0) > 0 && (
                        <div className="py-2 border-t">
                          <p className="px-4 py-1 text-xs font-semibold text-muted-foreground uppercase tracking-wide">State Bills{selectedState ? ` (${selectedState})` : ""}</p>
                          {acStateBills?.bills?.map((b) => (
                            <Link key={b.id} href={`/bills/state/${encodeURIComponent(b.id)}?${billFromParam(query.trim())}`} className="flex items-start gap-3 px-4 py-2 hover:bg-accent/10 transition-colors"
                              onMouseDown={(e) => e.preventDefault()}
                            >
                              <FileText className="h-4 w-4 text-muted-foreground mt-0.5 shrink-0" />
                              <div className="min-w-0">
                                <p className="text-xs font-mono font-semibold text-foreground uppercase">{b.identifier ?? b.id}</p>
                                <p className="text-sm text-muted-foreground truncate">{b.title}</p>
                              </div>
                            </Link>
                          ))}
                        </div>
                      )}

                    </div>
                  )}
                </div>
              </div>
<div className="flex items-center justify-center gap-2">
                <span className="text-sm text-primary-foreground/70">Or select a state:</span>
                <Select
                  value={homeDropdownState}
                  onValueChange={(v) => {
                    setHomeDropdownState(v);
                    setSelectedState(v || null);
                    setQuery("");
                    setSearchAddress("");
                    setLastSearchedAddress(null);
                    setActiveTextQuery("");
                  }}
                >
                  <SelectTrigger className="w-56 max-sm:w-44 max-sm:text-sm bg-background text-foreground border-0 shadow-lg rounded-xl">
                    <SelectValue placeholder="Select a state" />
                  </SelectTrigger>
                  <SelectContent>
                    {US_STATES.map((s) => (
                      <SelectItem key={s.code} value={s.code}>{s.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </form>
          </div>
        </div>
      </div>

      {/* Results header - address search */}
      {!isLoading && !error && data && (data.normalizedAddress || data.stateName) && (
        <div className="shrink-0 bg-muted/30">
          <div className="container mx-auto px-4 pt-6">
            <p className="text-sm text-muted-foreground uppercase tracking-wider font-bold">Showing results for</p>
            <h2 className="text-2xl font-semibold">{data.normalizedAddress ?? activeStateName}</h2>
          </div>
        </div>
      )}

      {/* Results header - state members */}
      {!isLoading && !stateMembersLoading && !error && showStateMembers && stateMembersData && (
        <div className="shrink-0 bg-muted/30">
          <div className="container mx-auto px-4 pt-6">
            <p className="text-sm text-muted-foreground uppercase tracking-wider font-bold">Federal representatives for</p>
            <h2 className="text-2xl max-sm:text-sm font-semibold">{stateMembersData.stateName ?? activeStateName}</h2>
          </div>
        </div>
      )}

      {/* Scrollable results */}
      <div className="flex-1 min-h-0 overflow-y-auto bg-muted/30">
        <div className="container mx-auto px-4 pt-6 pb-12">
          {(isLoading || stateMembersLoading) && (
            <div className="text-center py-20">
              <div className="w-10 h-10 border-4 border-accent border-t-transparent rounded-full animate-spin mx-auto mb-4"></div>
              <p className="text-lg text-muted-foreground">
                {isLoading ? "Finding your representatives..." : `Loading federal representatives for ${activeStateName}...`}
              </p>
            </div>
          )}

          {error && (
            <div className="bg-destructive/10 border border-destructive/20 text-destructive p-6 rounded-lg text-center max-w-2xl mx-auto">
              <h3 className="font-bold text-lg mb-2">Error finding representatives</h3>
              <p>Please check your address and try again. Make sure it&apos;s a valid US address.</p>
            </div>
          )}

          {!isLoading && !error && data && !activeTextQuery && (
            <div className="space-y-16">
              {(() => {
                const { federal, state, local } = groupReps(data.representatives ?? []);
                return (
                  <>
                    {federal.length > 0 && (
                      <section>
                        <h2 className="text-3xl max-sm:text-xl font-black mb-6 border-b pb-2 sticky top-0 bg-muted z-10">Federal Representatives</h2>
                        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                          {federal.map(renderRepCard)}
                        </div>
                      </section>
                    )}

                    {state.length > 0 && (
                      <section>
                        <div className="flex items-center justify-between border-b pb-2 mb-6 sticky top-0 bg-muted z-10">
                          <h2 className="text-3xl max-sm:text-xl font-black">State Representatives</h2>
                          {data?.stateRepCache?.stale && (
                            <div className="flex items-center gap-1.5 text-sm text-amber-700">
                              <AlertTriangle className="h-4 w-4" />
                              <span>Data may be outdated</span>
                            </div>
                          )}
                        </div>
                        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                          {state.map(renderRepCard)}
                        </div>
                      </section>
                    )}

                    {local.length > 0 && (
                      <section>
                        <h2 className="text-3xl font-black mb-6 border-b pb-2 sticky top-0 bg-muted z-10">Local Representatives</h2>
                        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                          {local.map(renderRepCard)}
                        </div>
                      </section>
                    )}
                  </>
                );
              })()}
            </div>
          )}

          {!isLoading && !stateMembersLoading && !error && showStateMembers && stateMembersData && (
            <div className="space-y-16">
              {stateMembersData.representatives && stateMembersData.representatives.length > 0 && (
                <section>
                  <h2 className="text-3xl max-sm:text-xl font-black mb-6 border-b pb-2 sticky top-0 bg-muted z-10">Federal Representatives</h2>
                  <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                    {stateMembersData.representatives.map(renderRepCard)}
                  </div>
                </section>
              )}
            </div>
          )}

          {activeTextQuery && renderTextSearchResults()}

          {!activeTextQuery && !isLoading && !stateMembersLoading && !error && !data && !stateMembersData && (
            <div className="text-center py-20 text-muted-foreground">
              <div className="w-24 h-24 bg-muted rounded-full flex items-center justify-center mx-auto mb-6">
                <Search className="h-10 w-10 opacity-50" />
              </div>
              <h2 className="text-2xl font-semibold mb-2">Ready to search</h2>
              <p className="max-w-md mx-auto">Enter an address, bill, or representative above, or select a state to explore.</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
