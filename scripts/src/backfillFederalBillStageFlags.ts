import pg from "pg";

const { Pool } = pg;

const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/civic_hub";

const pool = new Pool({ connectionString: DATABASE_URL });

const enactedPattern =
  "(signed|became public law|became private law|became law|public law|private law|enacted)";
const passedPattern =
  "(passed house|passed senate|passed/agreed|agreed to in house|agreed to in senate|passed by|passed enrolled|returned passed|third reading passed|adopted|adopted by)";
const committeePattern = "(committee|referred|reported)";
const floorVotePattern = "\\m(roll|yea|nay|vote|floor)\\M|agreed to";
const notAgreedToPattern = "not agreed to";
const deadPattern =
  "(died|dead|failed|vetoed|tabled indefinitely|indefinitely postponed|withdrawn)";

function getCurrentCongressNumber(currentYear = new Date().getFullYear()) {
  return Math.floor((currentYear - 1789) / 2) + 1;
}

async function main() {
  const currentCongress = getCurrentCongressNumber();

  try {
    const result = await pool.query(
      `
      update federal_bills
      set
        stage_introduced = true,
        stage_committee = coalesce(latest_action, '') ~* $1,
        stage_floor_vote = coalesce(latest_action, '') ~* $2,
        stage_signed_enacted = coalesce(latest_action, '') ~* $3,
        stage_passed = (
          not (coalesce(latest_action, '') ~* $4)
          and (
            (coalesce(latest_action, '') ~* $3)
            or (coalesce(latest_action, '') ~* $5)
          )
        ),
        stage_dead = case
          when coalesce(latest_action, '') ~* $3 then false
          when congress < $7 then true
          else (
            coalesce(latest_action, '') ~* $4
            or coalesce(latest_action, '') ~* $6
          )
        end
      `,
      [
        committeePattern,
        floorVotePattern,
        enactedPattern,
        notAgreedToPattern,
        passedPattern,
        deadPattern,
        currentCongress,
      ],
    );

    console.log(
      JSON.stringify(
        {
          federalBillsUpdated: result.rowCount,
          currentCongress,
        },
        null,
        2,
      ),
    );
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
