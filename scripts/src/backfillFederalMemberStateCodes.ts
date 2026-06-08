import pg from "pg";

const { Pool } = pg;

const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/civic_hub";

const pool = new Pool({ connectionString: DATABASE_URL });

const STATE_NAMES = [
  "Alabama",
  "Alaska",
  "Arizona",
  "Arkansas",
  "California",
  "Colorado",
  "Connecticut",
  "Delaware",
  "Florida",
  "Georgia",
  "Hawaii",
  "Idaho",
  "Illinois",
  "Indiana",
  "Iowa",
  "Kansas",
  "Kentucky",
  "Louisiana",
  "Maine",
  "Maryland",
  "Massachusetts",
  "Michigan",
  "Minnesota",
  "Mississippi",
  "Missouri",
  "Montana",
  "Nebraska",
  "Nevada",
  "New Hampshire",
  "New Jersey",
  "New Mexico",
  "New York",
  "North Carolina",
  "North Dakota",
  "Ohio",
  "Oklahoma",
  "Oregon",
  "Pennsylvania",
  "Rhode Island",
  "South Carolina",
  "South Dakota",
  "Tennessee",
  "Texas",
  "Utah",
  "Vermont",
  "Virginia",
  "Washington",
  "West Virginia",
  "Wisconsin",
  "Wyoming",
  "District of Columbia",
  "Puerto Rico",
  "Guam",
  "Virgin Islands",
  "U.S. Virgin Islands",
  "American Samoa",
  "Northern Mariana Islands",
];

const STATE_CODES: Record<string, string> = {
  alabama: "AL",
  alaska: "AK",
  arizona: "AZ",
  arkansas: "AR",
  california: "CA",
  colorado: "CO",
  connecticut: "CT",
  delaware: "DE",
  florida: "FL",
  georgia: "GA",
  hawaii: "HI",
  idaho: "ID",
  illinois: "IL",
  indiana: "IN",
  iowa: "IA",
  kansas: "KS",
  kentucky: "KY",
  louisiana: "LA",
  maine: "ME",
  maryland: "MD",
  massachusetts: "MA",
  michigan: "MI",
  minnesota: "MN",
  mississippi: "MS",
  missouri: "MO",
  montana: "MT",
  nebraska: "NE",
  nevada: "NV",
  "new hampshire": "NH",
  "new jersey": "NJ",
  "new mexico": "NM",
  "new york": "NY",
  "north carolina": "NC",
  "north dakota": "ND",
  ohio: "OH",
  oklahoma: "OK",
  oregon: "OR",
  pennsylvania: "PA",
  "rhode island": "RI",
  "south carolina": "SC",
  "south dakota": "SD",
  tennessee: "TN",
  texas: "TX",
  utah: "UT",
  vermont: "VT",
  virginia: "VA",
  washington: "WA",
  "west virginia": "WV",
  wisconsin: "WI",
  wyoming: "WY",
  "district of columbia": "DC",
  "puerto rico": "PR",
  guam: "GU",
  "u.s. virgin islands": "VI",
  "american samoa": "AS",
  "northern mariana islands": "MP",
};

function stateNameToCode(name: string): string | null {
  const normalized = name.toLowerCase();
  return STATE_CODES[normalized] ?? (normalized === "virgin islands" ? "VI" : null);
}

async function main() {
  try {
    const result = await pool.query<{
      bioguide_id: string;
      state: string | null;
    }>(
      `
      select bioguide_id, state
      from federal_members
      where state = any($1::text[])
      `,
      [STATE_NAMES],
    );

    let updated = 0;

    for (const row of result.rows) {
      if (!row.state) continue;
      const normalized = stateNameToCode(row.state);
      if (!normalized) continue;
      await pool.query(
        `
        update federal_members
        set state = $1
        where bioguide_id = $2
        `,
        [normalized, row.bioguide_id],
      );
      updated += 1;
    }

    console.log(
      JSON.stringify(
        {
          scanned: result.rowCount ?? 0,
          updated,
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
