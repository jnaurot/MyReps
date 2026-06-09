#!/usr/bin/env tsx
/**
 * Backfill missing sponsorships + actions into state_bills.raw,
 * and compute stage flags for bills ingested by the all-states script.
 *
 * Usage:
 *   pnpm --filter @workspace/scripts run backfill:state-bill-sponsorships
 */
import { Client } from "pg";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/civic_hub";
const OPENSTATES_DB_URL = process.env.OPENSTATES_DB_URL ?? "postgresql://postgres:postgres@localhost:5432/openstates";
const BATCH_SIZE = Number(process.env.BATCH_SIZE ?? "5000");

function log(...args: unknown[]) {
  console.log(`[${new Date().toISOString()}]`, ...args);
}

async function withClient(url: string, fn: (client: Client) => Promise<void>) {
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    await fn(client);
  } finally {
    await client.end();
  }
}

// ── Stage flag computation (inlined from legislationStages.ts) ──

function computeStageFlags(latestAction?: string | null, status?: string | null, introducedDate?: string | null) {
  const text = `${latestAction ?? ""} ${status ?? ""}`.toLowerCase();
  const introduced = !!introducedDate || text.length >= 0;
  const committee = /(committee|referred|reported)/i.test(text);
  const floorVote = /\b(roll|yea|nay|vote|floor)\b|agreed to/i.test(text);
  const signedOrEnacted = /(signed|became public law|became law|public law|enacted|approved by the governor)/i.test(text);
  const notAgreedTo = /\bnot agreed to\b/i.test(text);
  const passed = !notAgreedTo && (signedOrEnacted || /(passed house|passed senate|passed\/agreed|agreed to in house|agreed to in senate|passed by|passed enrolled|returned passed|third reading passed|adopted|adopted by)/i.test(text));
  const dead = notAgreedTo || /(died|dead|failed|vetoed|tabled indefinitely|indefinitely postponed|withdrawn)/i.test(text);
  return { introduced, committee, floor_vote: floorVote, passed, signed_enacted: signedOrEnacted, dead };
}

async function getStateJurisdictions(source: Client): Promise<{ id: string; name: string }[]> {
  const { rows } = await source.query(
    `SELECT id, name FROM opencivicdata_jurisdiction
     WHERE id ~ '^ocd-jurisdiction/country:us/state:[a-z]{2}/government$'
     ORDER BY id`,
  );
  return rows;
}

async function backfillState(
  jurisdictionId: string,
  stateName: string,
  source: Client,
  target: Client,
) {
  const stateCode = jurisdictionId.match(/state:([a-z]{2})/i)?.[1]?.toLowerCase() ?? "";
  log(`=== Backfilling ${stateName} (${stateCode}) ===`);

  // 1. Fetch bill metadata for this jurisdiction
  const { rows: billRows } = await source.query(
    `SELECT b.id, b.latest_action_description, b.first_action_date
     FROM opencivicdata_bill b
     JOIN opencivicdata_legislativesession ls ON b.legislative_session_id = ls.id
     WHERE ls.jurisdiction_id = $1`,
    [jurisdictionId],
  );
  if (billRows.length === 0) {
    log(`  No bills found in source for ${stateName}`);
    return;
  }
  log(`  ${stateName}: ${billRows.length} bills in source`);

  // 2. Fetch actions in bulk
  const { rows: actionRows } = await source.query(
    `SELECT bill_id, description, date, classification, "order"
     FROM opencivicdata_billaction
     WHERE bill_id IN (SELECT b.id FROM opencivicdata_bill b
                       JOIN opencivicdata_legislativesession ls ON b.legislative_session_id = ls.id
                       WHERE ls.jurisdiction_id = $1)`,
    [jurisdictionId],
  );
  const actionsByBill = new Map<string, any[]>();
  for (const a of actionRows) {
    const list = actionsByBill.get(a.bill_id) ?? [];
    list.push(a);
    actionsByBill.set(a.bill_id, list);
  }
  log(`  ${stateName}: ${actionRows.length} actions`);

  // 3. Fetch sponsorships in bulk
  const { rows: sponsorRows } = await source.query(
    `SELECT bill_id, name, entity_type, "primary", classification, person_id
     FROM opencivicdata_billsponsorship
     WHERE bill_id IN (SELECT b.id FROM opencivicdata_bill b
                         JOIN opencivicdata_legislativesession ls ON b.legislative_session_id = ls.id
                         WHERE ls.jurisdiction_id = $1)`,
    [jurisdictionId],
  );
  const sponsorsByBill = new Map<string, any[]>();
  for (const s of sponsorRows) {
    const list = sponsorsByBill.get(s.bill_id) ?? [];
    list.push(s);
    sponsorsByBill.set(s.bill_id, list);
  }
  log(`  ${stateName}: ${sponsorRows.length} sponsorships`);

  // 4. Build backfill rows
  const backfillRows: {
    billId: string;
    actions: any[];
    sponsorships: any[];
    introduced: boolean;
    committee: boolean;
    floorVote: boolean;
    passed: boolean;
    signedEnacted: boolean;
    dead: boolean;
  }[] = [];

  for (const row of billRows) {
    const actions = actionsByBill.get(row.id) ?? [];
    actions.sort((a: any, b: any) => (a.order ?? 0) - (b.order ?? 0));
    const latestAction = actions[actions.length - 1];
    const flags = computeStageFlags(latestAction?.description, row.latest_action_description, row.first_action_date);
    // Transform dump-format sponsorships (person_id) to API-format (person.id)
    // so that the existing @> containment queries in state.ts work correctly.
    const rawSponsors = sponsorsByBill.get(row.id) ?? [];
    const sponsorships = rawSponsors.map((s: any) => ({
      person: { id: s.person_id },
      name: s.name,
      entity_type: s.entity_type,
      primary: s.primary,
      classification: s.classification,
      bill_id: s.bill_id,
    }));

    backfillRows.push({
      billId: row.id,
      actions,
      sponsorships,
      introduced: flags.introduced,
      committee: flags.committee,
      floorVote: flags.floor_vote,
      passed: flags.passed,
      signedEnacted: flags.signed_enacted,
      dead: flags.dead,
    });
  }

  // 5. Create temp table in target DB
  const tmpTable = `tmp_bill_bf_${stateCode.replace(/[^a-z0-9]/g, "_")}`;
  await target.query(`DROP TABLE IF EXISTS ${tmpTable}`);
  await target.query(
    `CREATE TABLE ${tmpTable} (
      bill_id text NOT NULL PRIMARY KEY,
      actions jsonb,
      sponsorships jsonb,
      stage_introduced boolean NOT NULL DEFAULT false,
      stage_committee boolean NOT NULL DEFAULT false,
      stage_floor_vote boolean NOT NULL DEFAULT false,
      stage_passed boolean NOT NULL DEFAULT false,
      stage_signed_enacted boolean NOT NULL DEFAULT false,
      stage_dead boolean NOT NULL DEFAULT false
    )`,
  );

  // 6. Batch insert into temp table
  let inserted = 0;
  for (let i = 0; i < backfillRows.length; i += BATCH_SIZE) {
    const batch = backfillRows.slice(i, i + BATCH_SIZE);
    const values: unknown[] = [];
    const placeholders: string[] = [];
    let paramIdx = 1;

    for (const r of batch) {
      placeholders.push(
        `($${paramIdx++},$${paramIdx++},$${paramIdx++},$${paramIdx++},$${paramIdx++},$${paramIdx++},$${paramIdx++},$${paramIdx++},$${paramIdx++})`,
      );
      values.push(
        r.billId,
        JSON.stringify(r.actions),
        JSON.stringify(r.sponsorships),
        r.introduced,
        r.committee,
        r.floorVote,
        r.passed,
        r.signedEnacted,
        r.dead,
      );
    }

    await target.query(
      `INSERT INTO ${tmpTable} (bill_id, actions, sponsorships, stage_introduced, stage_committee, stage_floor_vote, stage_passed, stage_signed_enacted, stage_dead)
       VALUES ${placeholders.join(",")}
       ON CONFLICT (bill_id) DO NOTHING`,
      values,
    );
    inserted += batch.length;
    if (inserted % 10000 === 0) log(`  ...${inserted} rows staged`);
  }
  log(`  ${stateName}: staged ${inserted} bills`);

  // 7. Apply the backfill
  const updateRes = await target.query(
    `UPDATE state_bills b
     SET raw = b.raw || jsonb_build_object('actions', bf.actions, 'sponsorships', bf.sponsorships),
         stage_introduced = bf.stage_introduced,
         stage_committee = bf.stage_committee,
         stage_floor_vote = bf.stage_floor_vote,
         stage_passed = bf.stage_passed,
         stage_signed_enacted = bf.stage_signed_enacted,
         stage_dead = bf.stage_dead
     FROM ${tmpTable} bf
     WHERE b.id = bf.bill_id AND b.state = $1`,
    [stateCode],
  );
  const updated = Number(updateRes?.rowCount ?? 0);
  log(`  ${stateName}: ${updated} bills updated`);

  // 8. Cleanup
  await target.query(`DROP TABLE IF EXISTS ${tmpTable}`);
}

async function main() {
  log("=== State Bill Backfill (sponsorships + actions + stage flags) ===");
  log(`Target DB: ${DATABASE_URL.replace(/:\/\/[^:]+:[^@]+@/, "://***@")}`);
  log(`Source DB: ${OPENSTATES_DB_URL.replace(/:\/\/[^:]+:[^@]+@/, "://***@")}`);

  await withClient(OPENSTATES_DB_URL, async (source) => {
    await withClient(DATABASE_URL, async (target) => {
      const jurisdictions = await getStateJurisdictions(source);
      log(`Found ${jurisdictions.length} state jurisdictions`);

      let done = 0;
      for (const { id, name } of jurisdictions) {
        const start = Date.now();
        try {
          await backfillState(id, name, source, target);
        } catch (err) {
          log(`  ERROR backfilling ${name}: ${err}`);
        }
        done++;
        const elapsed = ((Date.now() - start) / 1000).toFixed(1);
        log(`  ${name} complete in ${elapsed}s (${done}/${jurisdictions.length})`);
        log("");
      }

      log(`=== Backfilled ${done}/${jurisdictions.length} states ===`);
    });
  });
}

main().catch((err) => { console.error(err); process.exit(1); });
