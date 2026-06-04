export function buildFederalBillHref(
  bill: { number?: string; congress?: string; itemCategory?: string },
  fromParam = "",
): string | null {
  if (!bill.number || !bill.congress) return null;
  if (bill.itemCategory === "amendment") return null;
  const parts = bill.number.split(" ");
  if (parts.length < 2) return null;
  return `/bills/federal/${bill.congress}/${parts[0].toLowerCase()}/${parts[1]}${fromParam}`;
}

export function buildFederalVoteBillHref(
  vote: {
    congress?: string | number | null;
    legislationType?: string | null;
    legislationNumber?: string | null;
    documentType?: string | null;
    documentNumber?: string | null;
  },
  fromParam = "",
): string | null {
  const congress = vote.congress == null ? undefined : String(vote.congress);
  const type = vote.legislationType ?? vote.documentType ?? undefined;
  const number = vote.legislationNumber ?? vote.documentNumber ?? undefined;
  if (!congress || !type || !number) return null;

  const normalizedType = type.replace(/[^A-Za-z]/g, "");
  if (!normalizedType) return null;

  return buildFederalBillHref(
    {
      congress,
      number: `${normalizedType} ${number}`,
      itemCategory: normalizedType.toLowerCase().includes("amdt")
        ? "amendment"
        : undefined,
    },
    fromParam,
  );
}
