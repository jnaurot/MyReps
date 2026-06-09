#!/usr/bin/env tsx
/**
 * Ingest OpenStates dump into the app's PostgreSQL database.
 *
 * Usage:
 *   pnpm --filter @workspace/scripts run ingest:openstates
 *
 * Environment:
 *   DATABASE_URL          - target app database (default: postgresql://postgres:postgres@localhost:5432/civic_hub)
 *   OPENSTATES_DB_URL     - source OpenStates dump (default: postgresql://postgres:postgres@localhost:5432/openstates)
 *   JURISDICTION_ID       - OCD jurisdiction ID to ingest (default: ocd-jurisdiction/country:us/state:md/government)
 */
import { Client } from "pg";
import { normalizeOpenStatesStateLegislator, requireUsStateCode } from "@workspace/db";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/civic_hub";
const OPENSTATES_DB_URL = process.env.OPENSTATES_DB_URL ?? "postgresql://postgres:postgres@localhost:5432/openstates";
const JURISDICTION_ID = process.env.JURISDICTION_ID ?? "ocd-jurisdiction/country:us/state:md/government";
const BATCH_SIZE = Number(process.env.BATCH_SIZE ?? "5000");

const STATE_CODE = requireUsStateCode(JURISDICTION_ID, "JURISDICTION_ID");

function log(...args: unknown[]) {
  console.log(`[${new Date().toISOString()}]`, ...args);
}

// ── Stage flag computation (inlined from legislationStages.ts) ───────────────

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

// ── Normalize vote position (inlined from normalizeStateVotePosition.ts) ─────

function normalizeVotePosition(value: unknown): string {
  const v = String(value ?? "").trim().toLowerCase();
  if (["yes", "yea", "aye", "for"].includes(v)) return "Yea";
  if (["no", "nay", "against"].includes(v)) return "Nay";
  if (["present"].includes(v)) return "Present";
  if (["not voting", "absent", "excused", "no vote", "not recorded"].includes(v)) return "Not Voting";
  return "Other";
}

// ── Database helpers ─────────────────────────────────────────────────────────

async function withClient(url: string, fn: (client: Client) => Promise<void>) {
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    await fn(client);
  } finally {
    await client.end();
  }
}

async function ingestLegislators(source: Client, target: Client) {
  log(`Deleting existing legislators for ${STATE_CODE}...`);
  await target.query(`DELETE FROM state_legislators WHERE state = $1`, [STATE_CODE]);

  log("Fetching legislators from OpenStates dump...");
  const { rows } = await source.query(
    `SELECT id, name, primary_party, image, email, "current_role", extras
     FROM opencivicdata_person
     WHERE current_jurisdiction_id = $1`,
    [JURISDICTION_ID],
  );
  log(`Found ${rows.length} legislators`);

  let inserted = 0;
  for (const row of rows) {
    const normalized = normalizeOpenStatesStateLegislator({
      id: row.id,
      name: row.name,
      primary_party: row.primary_party,
      image: row.image,
      email: row.email,
      current_role: row.current_role,
      jurisdiction: { id: JURISDICTION_ID },
    });

    await target.query(
      `INSERT INTO state_legislators (id, name, party, chamber, district, photo_url, email, state, raw, fetched_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
       ON CONFLICT (id) DO UPDATE SET
         name = EXCLUDED.name,
         party = EXCLUDED.party,
         chamber = EXCLUDED.chamber,
         district = EXCLUDED.district,
         photo_url = EXCLUDED.photo_url,
         email = EXCLUDED.email,
         raw = EXCLUDED.raw,
         fetched_at = NOW()`,
      [
        row.id,
        normalized.name,
        normalized.party,
        normalized.chamber,
        normalized.district,
        normalized.photoUrl,
        normalized.email,
        normalized.state,
        JSON.stringify({ ...row.extras, current_role: row.current_role }),
      ],
    );
    inserted++;
  }
  log(`Upserted ${inserted} legislators`);
}

async function ingestBills(source: Client, target: Client) {
  log(`Deleting existing bills for ${STATE_CODE}...`);
  await target.query(`DELETE FROM state_bills WHERE state = $1`, [STATE_CODE]);

  log("Fetching bills from OpenStates dump...");
  const { rows } = await source.query(
    `SELECT b.id, b.identifier, b.title, b.first_action_date, b.latest_action_date,
            b.latest_action_description, b.subject, b.from_organization_id,
            ls.identifier as session_identifier,
            o.classification as org_classification
     FROM opencivicdata_bill b
     JOIN opencivicdata_legislativesession ls ON b.legislative_session_id = ls.id
     LEFT JOIN opencivicdata_organization o ON b.from_organization_id = o.id
     WHERE ls.jurisdiction_id = $1`,
    [JURISDICTION_ID],
  );
  log(`Found ${rows.length} bills`);

  // Fetch actions in bulk for stage flag computation
  const { rows: actionRows } = await source.query(
    `SELECT bill_id, description, date, classification
     FROM opencivicdata_billaction
     WHERE bill_id IN (SELECT b.id FROM opencivicdata_bill b
                       JOIN opencivicdata_legislativesession ls ON b.legislative_session_id = ls.id
                       WHERE ls.jurisdiction_id = $1)`,
    [JURISDICTION_ID],
  );
  const actionsByBill = new Map<string, any[]>();
  for (const a of actionRows) {
    const list = actionsByBill.get(a.bill_id) ?? [];
    list.push(a);
    actionsByBill.set(a.bill_id, list);
  }

  // Fetch sponsorships for the raw JSONB
  const { rows: sponsorRows } = await source.query(
    `SELECT bill_id, name, entity_type, "primary", classification, person_id
     FROM opencivicdata_billsponsorship
     WHERE bill_id IN (SELECT b.id FROM opencivicdata_bill b
                         JOIN opencivicdata_legislativesession ls ON b.legislative_session_id = ls.id
                         WHERE ls.jurisdiction_id = $1)`,
    [JURISDICTION_ID],
  );
  const sponsorsByBill = new Map<string, any[]>();
  for (const s of sponsorRows) {
    const list = sponsorsByBill.get(s.bill_id) ?? [];
    list.push(s);
    sponsorsByBill.set(s.bill_id, list);
  }

  let inserted = 0;
  for (const row of rows) {
    const actions = actionsByBill.get(row.id) ?? [];
    actions.sort((a: any, b: any) => (a.order ?? 0) - (b.order ?? 0));
    const latestAction = actions[actions.length - 1];

    const flags = computeStageFlags(
      latestAction?.description,
      row.latest_action_description,
      row.first_action_date,
    );

    const chamber = row.org_classification === "upper" ? "Senate" : row.org_classification === "lower" ? "House of Delegates" : null;
    const subjects = Array.isArray(row.subject) ? row.subject : row.subject ? [row.subject] : [];
    const rawSponsors = sponsorsByBill.get(row.id) ?? [];
    const sponsorships = rawSponsors.map((s: any) => ({
      person: { id: s.person_id },
      name: s.name,
      entity_type: s.entity_type,
      primary: s.primary,
      classification: s.classification,
      bill_id: s.bill_id,
    }));
    const raw = {
      id: row.id,
      identifier: row.identifier,
      title: row.title,
      actions,
      sponsorships,
      first_action_date: row.first_action_date,
      latest_action_date: row.latest_action_date,
      latest_action_description: row.latest_action_description,
      subject: subjects,
      from_organization: { classification: row.org_classification },
    };

    await target.query(
      `INSERT INTO state_bills (
        id, identifier, title, session, chamber, status,
        introduced_date, stage_introduced, stage_committee, stage_floor_vote,
        stage_passed, stage_signed_enacted, stage_dead,
        subjects, state, raw, fetched_at, search_vector
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, NOW(),
                to_tsvector('english', COALESCE($3, '') || ' ' || COALESCE($2, '')))
      ON CONFLICT (id) DO UPDATE SET
        identifier = EXCLUDED.identifier,
        title = EXCLUDED.title,
        session = EXCLUDED.session,
        chamber = EXCLUDED.chamber,
        status = EXCLUDED.status,
        introduced_date = EXCLUDED.introduced_date,
        stage_introduced = EXCLUDED.stage_introduced,
        stage_committee = EXCLUDED.stage_committee,
        stage_floor_vote = EXCLUDED.stage_floor_vote,
        stage_passed = EXCLUDED.stage_passed,
        stage_signed_enacted = EXCLUDED.stage_signed_enacted,
        stage_dead = EXCLUDED.stage_dead,
        subjects = EXCLUDED.subjects,
        raw = EXCLUDED.raw,
        search_vector = EXCLUDED.search_vector,
        fetched_at = NOW()`,
      [
        row.id,
        row.identifier,
        row.title,
        row.session_identifier,
        chamber,
        row.latest_action_description || null,
        row.first_action_date || null,
        flags.introduced,
        flags.committee,
        flags.floor_vote,
        flags.passed,
        flags.signed_enacted,
        flags.dead,
        subjects,
        STATE_CODE,
        JSON.stringify(raw),
      ],
    );
    inserted++;
    if (inserted % 1000 === 0) log(`  ...${inserted} bills processed`);
  }
  log(`Upserted ${inserted} bills`);
}

async function ingestVotes(source: Client, target: Client) {
  log(`Deleting existing vote records for ${STATE_CODE}...`);
  await target.query(`DELETE FROM state_vote_records WHERE state = $1`, [STATE_CODE]);

  log("Fetching vote records from OpenStates dump...");
  // Get total count for progress logging
  const { rows: countRow } = await source.query(
    `SELECT COUNT(*) as cnt
     FROM opencivicdata_personvote pv
     JOIN opencivicdata_voteevent ve ON pv.vote_event_id = ve.id
     JOIN opencivicdata_bill b ON ve.bill_id = b.id
     JOIN opencivicdata_legislativesession ls ON b.legislative_session_id = ls.id
     WHERE ls.jurisdiction_id = $1`,
    [JURISDICTION_ID],
  );
  const totalVotes = Number(countRow[0]?.cnt ?? 0);
  log(`Found ${totalVotes.toLocaleString()} vote records`);

  // Build a name -> voter_id map from votes that have both populated.
  // This resolves ~85% of null voter_id records.
  log("Building voter name resolution map...");
  const { rows: nameMapRows } = await source.query(
    `SELECT DISTINCT pv.voter_name, pv.voter_id
     FROM opencivicdata_personvote pv
     JOIN opencivicdata_voteevent ve ON pv.vote_event_id = ve.id
     JOIN opencivicdata_bill b ON ve.bill_id = b.id
     JOIN opencivicdata_legislativesession ls ON b.legislative_session_id = ls.id
     WHERE ls.jurisdiction_id = $1 AND pv.voter_id IS NOT NULL AND pv.voter_name IS NOT NULL`,
    [JURISDICTION_ID],
  );
  const nameToId = new Map<string, string>();
  for (const r of nameMapRows) {
    // If multiple IDs map to the same name, keep the first (usually the most recent session)
    if (!nameToId.has(r.voter_name)) nameToId.set(r.voter_name, r.voter_id);
  }
  log(`Resolved ${nameToId.size} distinct voter names`);

  // Build a temp table with ordered IDs to avoid slow OFFSET queries on large JOINs
  const tmpTable = `tmp_pvs_${STATE_CODE.replace(/[^a-z0-9]/g, "_")}`;
  log("Building vote index table...");
  await source.query(`DROP TABLE IF EXISTS ${tmpTable}`);
  await source.query(
    `CREATE TABLE ${tmpTable} AS
     SELECT pv.id, ROW_NUMBER() OVER (ORDER BY pv.id) as rn
     FROM opencivicdata_personvote pv
     JOIN opencivicdata_voteevent ve ON pv.vote_event_id = ve.id
     JOIN opencivicdata_bill b ON ve.bill_id = b.id
     JOIN opencivicdata_legislativesession ls ON b.legislative_session_id = ls.id
     WHERE ls.jurisdiction_id = $1`,
    [JURISDICTION_ID],
  );
  await source.query(`CREATE INDEX ON ${tmpTable}(rn)`);

  // Stream vote records in batches
  let offset = 0;
  let inserted = 0;
  let skipped = 0;
  let batchCount = 0;
  const maxBatches = Math.ceil(totalVotes / BATCH_SIZE) + 10;

  while (offset < totalVotes && batchCount < maxBatches) {
    batchCount++;
    const { rows } = await source.query(
      `SELECT pv.id as personvote_id, pv.voter_id, pv.voter_name, pv.option, pv.note,
              ve.id as vote_event_id, ve.motion_text, ve.result, ve.start_date,
              ve.organization_id, o.classification as org_classification,
              b.id as bill_id, b.identifier, b.title
       FROM opencivicdata_personvote pv
       JOIN ${tmpTable} t ON pv.id = t.id
       JOIN opencivicdata_voteevent ve ON pv.vote_event_id = ve.id
       JOIN opencivicdata_bill b ON ve.bill_id = b.id
       JOIN opencivicdata_legislativesession ls ON b.legislative_session_id = ls.id
       LEFT JOIN opencivicdata_organization o ON ve.organization_id = o.id
       WHERE t.rn > $1 AND t.rn <= $2
       ORDER BY pv.id`,
      [offset, offset + BATCH_SIZE],
    );

    if (rows.length === 0) break;

    const batchValues: unknown[] = [];
    const placeholders: string[] = [];
    let paramIdx = 1;
    let batchInserted = 0;
    const seenInBatch = new Set<string>();

    for (const row of rows) {
      const voterId: string | null = row.voter_id ?? nameToId.get(row.voter_name) ?? null;
      if (!voterId) {
        skipped++;
        continue;
      }

      const dedupeKey = `${STATE_CODE}|${voterId}|${row.vote_event_id}`;
      if (seenInBatch.has(dedupeKey)) continue;
      seenInBatch.add(dedupeKey);

      const position = normalizeVotePosition(row.option);
      const chamber = row.org_classification === "upper" ? "Senate" : row.org_classification === "lower" ? "House of Delegates" : null;
      const votedAt = row.start_date ? new Date(row.start_date) : null;
      const raw = JSON.stringify({
        voteEvent: {
          id: row.vote_event_id,
          motion_text: row.motion_text,
          result: row.result,
          start_date: row.start_date,
          organization_id: row.organization_id,
        },
        bill: { id: row.bill_id, identifier: row.identifier, title: row.title },
        vote: { option: row.option, voter_name: row.voter_name, note: row.note },
      });

      placeholders.push(
        `($${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, ` +
        `$${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, NOW())`,
      );
      batchValues.push(
        STATE_CODE,
        voterId,
        row.voter_name || null,
        String(row.vote_event_id),
        row.bill_id,
        row.identifier || null,
        row.title || null,
        chamber,
        row.motion_text || null,
        row.result || null,
        position,
        votedAt,
        raw,
      );
      batchInserted++;
    }

    if (batchValues.length > 0) {
      await target.query(
        `INSERT INTO state_vote_records (
          state, legislator_id, legislator_name, vote_event_id, bill_id,
          bill_identifier, bill_title, chamber, motion_text, result, position, voted_at, raw, fetched_at
        ) VALUES ${placeholders.join(", ")}
        ON CONFLICT (state, legislator_id, vote_event_id) DO UPDATE SET
          position = EXCLUDED.position,
          legislator_name = EXCLUDED.legislator_name,
          bill_identifier = EXCLUDED.bill_identifier,
          bill_title = EXCLUDED.bill_title,
          chamber = EXCLUDED.chamber,
          motion_text = EXCLUDED.motion_text,
          result = EXCLUDED.result,
          voted_at = EXCLUDED.voted_at,
          raw = EXCLUDED.raw,
          fetched_at = NOW()`,
        batchValues,
      );
      inserted += batchInserted;
    }
    offset += rows.length;

    const countRes = await target.query(`SELECT COUNT(*) as cnt FROM state_vote_records WHERE state = $1`, [STATE_CODE]);
    const tableCount = Number(countRes.rows[0]?.cnt ?? 0);
    log(`  batch ${batchCount}: offset=${offset.toLocaleString()} table_rows=${tableCount.toLocaleString()} inserted_counter=${inserted.toLocaleString()} skipped=${skipped.toLocaleString()}`);
  }

  await source.query(`DROP TABLE IF EXISTS ${tmpTable}`);
  const finalRes = await target.query(`SELECT COUNT(*) as cnt FROM state_vote_records WHERE state = $1`, [STATE_CODE]);
  const finalCount = Number(finalRes.rows[0]?.cnt ?? 0);
  log(`Upserted ${inserted.toLocaleString()} vote records (${skipped.toLocaleString()} skipped). Table now has ${finalCount.toLocaleString()} rows.`);
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  log("=== OpenStates Dump Ingestion ===");
  log(`Target DB: ${DATABASE_URL.replace(/:\/\/[^:]+:[^@]+@/, "://***@")}`);
  log(`Source DB: ${OPENSTATES_DB_URL.replace(/:\/\/[^:]+:[^@]+@/, "://***@")}`);
  log(`Jurisdiction: ${JURISDICTION_ID} (state: ${STATE_CODE})`);

  const startTime = Date.now();

  await withClient(OPENSTATES_DB_URL, async (source) => {
    await withClient(DATABASE_URL, async (target) => {
      await ingestLegislators(source, target);
      await ingestBills(source, target);
      await ingestVotes(source, target);
    });
  });

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  log(`=== Ingestion complete in ${elapsed}s ===`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
