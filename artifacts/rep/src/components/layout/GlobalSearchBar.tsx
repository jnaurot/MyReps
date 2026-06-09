import { useEffect, useMemo, useState } from "react";
import { Link, useLocation } from "wouter";
import {
  getSearchFederalBillsQueryKey,
  useSearchFederalBills,
  useSearchStateBills,
  useSearchFederalMembers,
  useSearchStateMembers,
} from "@workspace/api-client-react";
import { Search, FileText } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { useDebounce } from "@/hooks/useDebounce";

function federalBillHref(bill: { number?: string | null; congress?: string | null }) {
  if (!bill.number || !bill.congress) return "#";
  const [rawType, rawNumber] = bill.number.split(" ");
  if (!rawType || !rawNumber) return "#";
  return `/bills/federal/${bill.congress}/${rawType.toLowerCase()}/${rawNumber}`;
}

export function GlobalSearchBar({
  onSearchModeChange,
  onQueryChange,
  value,
  onValueChange,
  showResults = true,
}: {
  onSearchModeChange?: (active: boolean) => void;
  onQueryChange?: (query: string) => void;
  value?: string;
  onValueChange?: (query: string) => void;
  showResults?: boolean;
} = {}) {
  const [, setLocation] = useLocation();
  const [internalQuery, setInternalQuery] = useState(value ?? "");
  const query = value ?? internalQuery;
  const debounced = useDebounce(query.trim(), 250);
  // In filter mode (showResults=false) the parent page owns the search — don't
  // run redundant queries and don't navigate on submit.
  const acEnabled = !!debounced && showResults;
  const params = { q: debounced, limit: 5 };

  const { data: federalBills } = useSearchFederalBills(params, {
    query: { enabled: acEnabled, queryKey: getSearchFederalBillsQueryKey(params) },
  });
  const { data: stateBills } = useSearchStateBills(params, {
    query: { enabled: acEnabled, queryKey: ["globalSearch", "stateBills", params] as const },
  });
  const { data: federalMembers } = useSearchFederalMembers(params, {
    query: { enabled: acEnabled, queryKey: ["globalSearch", "federalMembers", params] as const },
  });
  const { data: stateMembers } = useSearchStateMembers(params, {
    query: { enabled: acEnabled, queryKey: ["globalSearch", "stateMembers", params] as const },
  });

  const firstResultHref = useMemo(() => {
    const fb = federalBills?.bills?.[0];
    if (fb) return federalBillHref({ number: fb.number, congress: fb.congress });
    const sb = stateBills?.bills?.[0];
    if (sb) return `/bills/state/${encodeURIComponent(sb.id)}`;
    const fm = federalMembers?.members?.[0];
    if (fm) return `/rep/federal/${fm.bioguideId}`;
    const sm = stateMembers?.members?.[0];
    if (sm) return `/rep/state/${encodeURIComponent(sm.id)}`;
    return null;
  }, [federalBills, stateBills, federalMembers, stateMembers]);

  const hasResults =
    (federalBills?.bills?.length ?? 0) > 0 ||
    (stateBills?.bills?.length ?? 0) > 0 ||
    (federalMembers?.members?.length ?? 0) > 0 ||
    (stateMembers?.members?.length ?? 0) > 0;
  const showInlineResults = !!debounced && showResults;

  useEffect(() => {
    onSearchModeChange?.(showInlineResults);
  }, [onSearchModeChange, showInlineResults]);

  useEffect(() => {
    onQueryChange?.(debounced);
  }, [debounced, onQueryChange]);

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (firstResultHref) {
      setLocation(firstResultHref);
    }
  };

  return (
    <form onSubmit={onSubmit} className="relative shrink-0 mb-4">
      <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground z-10" />
      <Input
        type="text"
        placeholder="Search bills & representatives..."
        className="pl-9 bg-background"
        value={query}
        onChange={(e) => {
          const next = e.target.value;
          if (value === undefined) setInternalQuery(next);
          onValueChange?.(next);
        }}
      />
      {showResults && showInlineResults && (
        <div className="mt-2 bg-popover border rounded-xl max-h-[24rem] overflow-y-auto text-left">
          {!hasResults && (
            <p className="px-4 py-3 text-sm text-muted-foreground">No results for "{debounced}".</p>
          )}
          {(federalMembers?.members?.length ?? 0) > 0 && (
            <div className="py-2">
              <p className="px-4 py-1 text-xs font-semibold text-muted-foreground uppercase tracking-wide">Federal Representatives</p>
              {federalMembers?.members?.map((m) => (
                <Link
                  key={m.bioguideId}
                  href={`/rep/federal/${m.bioguideId}`}
                  className="flex items-center gap-3 px-4 py-2 hover:bg-accent/10 transition-colors"
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
          {(stateMembers?.members?.length ?? 0) > 0 && (
            <div className="py-2 border-t">
              <p className="px-4 py-1 text-xs font-semibold text-muted-foreground uppercase tracking-wide">State Representatives</p>
              {stateMembers?.members?.map((m) => (
                <Link
                  key={m.id}
                  href={`/rep/state/${encodeURIComponent(m.id)}`}
                  className="flex items-center gap-3 px-4 py-2 hover:bg-accent/10 transition-colors"
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
          {(federalBills?.bills?.length ?? 0) > 0 && (
            <div className="py-2 border-t">
              <p className="px-4 py-1 text-xs font-semibold text-muted-foreground uppercase tracking-wide">Federal Bills</p>
              {federalBills?.bills?.map((b) => (
                <Link
                  key={b.id}
                  href={federalBillHref({ number: b.number, congress: b.congress })}
                  className="flex items-start gap-3 px-4 py-2 hover:bg-accent/10 transition-colors"
                >
                  <FileText className="h-4 w-4 text-muted-foreground mt-0.5 shrink-0" />
                  <div className="min-w-0">
                    <p className="text-sm font-medium truncate">{b.title}</p>
                    <p className="text-xs text-muted-foreground">{b.number ?? b.id}</p>
                  </div>
                </Link>
              ))}
            </div>
          )}
          {(stateBills?.bills?.length ?? 0) > 0 && (
            <div className="py-2 border-t">
              <p className="px-4 py-1 text-xs font-semibold text-muted-foreground uppercase tracking-wide">State Bills</p>
              {stateBills?.bills?.map((b) => (
                <Link
                  key={b.id}
                  href={`/bills/state/${encodeURIComponent(b.id)}`}
                  className="flex items-start gap-3 px-4 py-2 hover:bg-accent/10 transition-colors"
                >
                  <FileText className="h-4 w-4 text-muted-foreground mt-0.5 shrink-0" />
                  <div className="min-w-0">
                    <p className="text-sm font-medium truncate">{b.title}</p>
                    <p className="text-xs text-muted-foreground">{b.identifier ?? b.id}</p>
                  </div>
                </Link>
              ))}
            </div>
          )}
        </div>
      )}
    </form>
  );
}
