export interface FederalBillAction {
  date: string;
  text: string;
  type?: string;
}

interface FederalBillActionInternal extends FederalBillAction {
  actionTime?: string;
  sourceIndex: number;
}

function actionKey(action: FederalBillAction): string {
  return `${action.date}|${action.text}`;
}

function parseActionTimestamp(date: string, actionTime?: string): number | null {
  if (!date || !actionTime) return null;

  const normalizedTime = actionTime.trim();
  if (!normalizedTime) return null;

  const timestamp = Date.parse(`${date}T${normalizedTime}`);
  return Number.isFinite(timestamp) ? timestamp : null;
}

export function dedupeAndSortFederalBillActions(
  rawActions: Array<{ actionDate?: string | null; text?: string | null; type?: string | null; actionTime?: string | null }>,
): FederalBillAction[] {
  const deduped = new Map<string, FederalBillActionInternal>();

  rawActions.forEach((action, sourceIndex) => {
    const date = action.actionDate ?? "";
    const text = (action.text ?? "").trim();
    if (!text) return;

    const normalized: FederalBillActionInternal = {
      date,
      text,
      type: action.type ?? undefined,
      actionTime: action.actionTime ?? undefined,
      sourceIndex,
    };

    const key = actionKey(normalized);
    if (!deduped.has(key)) {
      deduped.set(key, normalized);
    }
  });

  return [...deduped.values()]
    .sort((a, b) => {
      const dateCompare = (a.date ?? "").localeCompare(b.date ?? "");
      if (dateCompare !== 0) return dateCompare;

      const aTimestamp = parseActionTimestamp(a.date, a.actionTime);
      const bTimestamp = parseActionTimestamp(b.date, b.actionTime);
      if (aTimestamp !== null && bTimestamp !== null && aTimestamp !== bTimestamp) {
        return aTimestamp - bTimestamp;
      }

      // Congress.gov action feeds arrive newest-first. When same-day entries do
      // not expose actionTime, reverse the source order so the displayed history
      // reads earliest-to-latest within that date.
      return b.sourceIndex - a.sourceIndex;
    })
    .map(({ date, text, type }) => ({ date, text, type }));
}
