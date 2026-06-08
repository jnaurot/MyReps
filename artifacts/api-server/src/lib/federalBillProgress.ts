import { isEnactedOutcomeText } from "./legislationStages";

type BillActionItem = { date?: string; text?: string; type?: string };

export function getCurrentCongressNumber(currentYear = new Date().getFullYear()) {
  return Math.floor((currentYear - 1789) / 2) + 1;
}

export function computeFederalBillProgress({
  congress,
  latestAction,
  laws,
  actions,
  currentCongress = getCurrentCongressNumber(),
}: {
  congress?: string | number | null;
  latestAction?: string | null;
  laws?: Array<{ number?: string; type?: string }> | null;
  actions?: BillActionItem[];
  currentCongress?: number;
}) {
  const texts = (actions ?? []).map((a) => (a.text ?? "").toLowerCase());
  const types = (actions ?? []).map((a) => (a.type ?? "").toLowerCase());
  const joined = `${latestAction ?? ""} ${texts.join(" ")}`.toLowerCase();

  const hasLaw = Array.isArray(laws) && laws.length > 0;
  const signed =
    hasLaw ||
    (types.some((t) => t === "becamelaw" || t === "president") &&
      /signed|became public law|became private law|became law|public law|private law/i.test(joined));
  const committee =
    types.some((t) => t === "introreferral" || t === "committees") ||
    /(committee|referred|reported)/i.test(joined);
  const floorVote =
    types.some((t) => t === "floor") || /(roll|yea|nay|vote|agreed to)/i.test(joined);
  const passed =
    signed ||
    /(passed house|passed senate|passed\/agreed|agreed to in house|agreed to in senate|passed by|agreed to)/i.test(
      joined,
    );
  const enacted = hasLaw || isEnactedOutcomeText(joined);

  const congressNum = Number(congress ?? currentCongress);
  const dead = !enacted && congressNum < currentCongress;

  return {
    introduced: true,
    committee,
    floorVote,
    passed,
    signed,
    enacted,
    dead,
  };
}
