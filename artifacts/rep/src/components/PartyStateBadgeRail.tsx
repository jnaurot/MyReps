import { Badge } from "@/components/ui/badge";
import { partyColor } from "@/lib/rep-utils";

function partyAbbreviation(party?: string) {
  if (!party) return "";
  const normalized = party.trim();
  if (!normalized) return "";
  return normalized.charAt(0).toUpperCase();
}

export function PartyStateBadgeRail({
  party,
  state,
}: {
  party?: string | null;
  state?: string | null;
}) {
  const partyLabel = partyAbbreviation(party ?? undefined);
  if (!partyLabel && !state) return null;

  return (
    <div className="grid w-14 shrink-0 grid-cols-[1.75rem_minmax(0,1fr)] items-center justify-items-end gap-1">
      <div className="flex w-7 justify-center">
        {partyLabel ? (
          <Badge className={`w-7 justify-center px-0 text-xs ${partyColor(party ?? undefined)}`}>
            {partyLabel}
          </Badge>
        ) : null}
      </div>
      <span className="w-full text-right text-xs text-muted-foreground">{state ?? ""}</span>
    </div>
  );
}
