#!/usr/bin/env tsx
/**
 * Ingest OpenStates dump for ALL US states.
 *
 * Usage:
 *   pnpm --filter @workspace/scripts run ingest:openstates:all
 */
import { Client } from "pg";
import { normalizeOpenStatesStateLegislator, requireUsStateCode } from "@workspace/db";

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

async function ingestState(
  jurisdictionId: string,
  stateName: string,
  source: Client,
  target: Client,
) {
  const stateCode = requireUsStateCode(jurisdictionId, `jurisdiction ${jurisdictionId}`);
  log(`=== Ingesting ${stateName} (${stateCode}) ===`);

  // Legislators
  const { rows: legislatorRows } = await source.query(
    `SELECT id, name, primary_party, image, email, "current_role", extras
     FROM opencivicdata_person
     WHERE current_jurisdiction_id = $1`,
    [jurisdictionId],
  );

  await target.query(`DELETE FROM state_legislators WHERE state = $1`, [stateCode]);
  for (const row of legislatorRows) {
    const normalized = normalizeOpenStatesStateLegislator({
      id: row.id,
      name: row.name,
      primary_party: row.primary_party,
      image: row.image,
      email: row.email,
      current_role: row.current_role,
      jurisdiction: { id: jurisdictionId },
    });
    await target.query(
      `INSERT INTO state_legislators (id, name, party, chamber, district, photo_url, email, state, raw, fetched_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
       ON CONFLICT (id) DO UPDATE SET
         name = EXCLUDED.name, party = EXCLUDED.party, chamber = EXCLUDED.chamber,
         district = EXCLUDED.district, photo_url = EXCLUDED.photo_url, email = EXCLUDED.email,
         raw = EXCLUDED.raw, fetched_at = NOW()`,
      [
        row.id, normalized.name, normalized.party, normalized.chamber, normalized.district,
        normalized.photoUrl, normalized.email, normalized.state,
        JSON.stringify({ ...row.extras, current_role: row.current_role }),
      ],
    );
  }
  log(`  ${stateName}: ${legislatorRows.length} legislators`);

  // Bills
  const { rows: billRows } = await source.query(
    `SELECT b.id, b.identifier, b.title, b.first_action_date, b.latest_action_date,
            b.latest_action_description, b.subject, b.from_organization_id,
            ls.identifier as session_identifier, o.classification as org_classification
     FROM opencivicdata_bill b
     JOIN opencivicdata_legislativesession ls ON b.legislative_session_id = ls.id
     LEFT JOIN opencivicdata_organization o ON b.from_organization_id = o.id
     WHERE ls.jurisdiction_id = $1`,
    [jurisdictionId],
  );

  // Fetch actions + sponsorships in bulk for stage flags and raw JSONB
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

  await target.query(`DELETE FROM state_bills WHERE state = $1`, [stateCode]);
  for (const row of billRows) {
    const chamber = row.org_classification === "upper" ? "Senate" : row.org_classification === "lower" ? "House of Delegates" : null;
    const subjects = Array.isArray(row.subject) ? row.subject : row.subject ? [row.subject] : [];

    const actions = actionsByBill.get(row.id) ?? [];
    actions.sort((a: any, b: any) => (a.order ?? 0) - (b.order ?? 0));
    const latestAction = actions[actions.length - 1];
    const flags = computeStageFlags(latestAction?.description, row.latest_action_description, row.first_action_date);

    const rawSponsors = sponsorsByBill.get(row.id) ?? [];
    const sponsorships = rawSponsors.map((s: any) => ({
      person: { id: s.person_id },
      name: s.name,
      entity_type: s.entity_type,
      primary: s.primary,
      classification: s.classification,
      bill_id: s.bill_id,
    }));

    await target.query(
      `INSERT INTO state_bills (
        id, identifier, title, session, chamber, status, introduced_date,
        subjects, state, raw, fetched_at, search_vector,
        stage_introduced, stage_committee, stage_floor_vote, stage_passed, stage_signed_enacted, stage_dead
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW(), to_tsvector('english', COALESCE($3, '') || ' ' || COALESCE($2, '')),
                $11, $12, $13, $14, $15, $16)
       ON CONFLICT (id) DO UPDATE SET
         identifier = EXCLUDED.identifier, title = EXCLUDED.title, session = EXCLUDED.session,
         chamber = EXCLUDED.chamber, status = EXCLUDED.status, introduced_date = EXCLUDED.introduced_date,
         subjects = EXCLUDED.subjects, raw = EXCLUDED.raw, search_vector = EXCLUDED.search_vector,
         stage_introduced = EXCLUDED.stage_introduced, stage_committee = EXCLUDED.stage_committee,
         stage_floor_vote = EXCLUDED.stage_floor_vote, stage_passed = EXCLUDED.stage_passed,
         stage_signed_enacted = EXCLUDED.stage_signed_enacted, stage_dead = EXCLUDED.stage_dead,
         fetched_at = NOW()`,
      [
        row.id, row.identifier, row.title, row.session_identifier, chamber,
        row.latest_action_description || null, row.first_action_date || null,
        subjects, stateCode,
        JSON.stringify({
          id: row.id, identifier: row.identifier, title: row.title,
          first_action_date: row.first_action_date, latest_action_date: row.latest_action_date,
          latest_action_description: row.latest_action_description, subject: subjects,
          from_organization: { classification: row.org_classification },
          actions, sponsorships,
        }),
        flags.introduced, flags.committee, flags.floor_vote, flags.passed, flags.signed_enacted, flags.dead,
      ],
    );
  }
  log(`  ${stateName}: ${billRows.length} bills`);

  // Votes
  const { rows: countRow } = await source.query(
    `SELECT COUNT(*) as cnt FROM opencivicdata_personvote pv
     JOIN opencivicdata_voteevent ve ON pv.vote_event_id = ve.id
     JOIN opencivicdata_bill b ON ve.bill_id = b.id
     JOIN opencivicdata_legislativesession ls ON b.legislative_session_id = ls.id
     WHERE ls.jurisdiction_id = $1`,
    [jurisdictionId],
  );
  const totalVotes = Number(countRow[0]?.cnt ?? 0);

  // Build name->id map
  const { rows: nameMapRows } = await source.query(
    `SELECT DISTINCT pv.voter_name, pv.voter_id
     FROM opencivicdata_personvote pv
     JOIN opencivicdata_voteevent ve ON pv.vote_event_id = ve.id
     JOIN opencivicdata_bill b ON ve.bill_id = b.id
     JOIN opencivicdata_legislativesession ls ON b.legislative_session_id = ls.id
     WHERE ls.jurisdiction_id = $1 AND pv.voter_id IS NOT NULL AND pv.voter_name IS NOT NULL`,
    [jurisdictionId],
  );
  const nameToId = new Map<string, string>();
  for (const r of nameMapRows) if (!nameToId.has(r.voter_name)) nameToId.set(r.voter_name, r.voter_id);

  await target.query(`DELETE FROM state_vote_records WHERE state = $1`, [stateCode]);

  // Build a temp table with ordered IDs to avoid slow OFFSET queries on large JOINs
  const tmpTable = `tmp_pvs_${stateCode.replace(/[^a-z0-9]/g, "_")}`;
  log(`  ${stateName}: building vote index...`);
  await source.query(`DROP TABLE IF EXISTS ${tmpTable}`);
  await source.query(
    `CREATE TABLE ${tmpTable} AS
     SELECT pv.id, ROW_NUMBER() OVER (ORDER BY pv.id) as rn
     FROM opencivicdata_personvote pv
     JOIN opencivicdata_voteevent ve ON pv.vote_event_id = ve.id
     JOIN opencivicdata_bill b ON ve.bill_id = b.id
     JOIN opencivicdata_legislativesession ls ON b.legislative_session_id = ls.id
     WHERE ls.jurisdiction_id = $1`,
    [jurisdictionId],
  );
  await source.query(`CREATE INDEX ON ${tmpTable}(rn)`);

  let offset = 0;
  let inserted = 0;
  let skipped = 0;
  const maxBatches = Math.ceil(totalVotes / BATCH_SIZE) + 10;

  for (let batch = 1; batch <= maxBatches; batch++) {
    const { rows } = await source.query(
      `SELECT pv.voter_id, pv.voter_name, pv.option, ve.id as vote_event_id, ve.motion_text, ve.result, ve.start_date,
              ve.organization_id, o.classification as org_classification, b.id as bill_id, b.identifier, b.title
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
      const voterId = row.voter_id ?? nameToId.get(row.voter_name) ?? null;
      if (!voterId) { skipped++; continue; }

      const dedupeKey = `${stateCode}|${voterId}|${row.vote_event_id}`;
      if (seenInBatch.has(dedupeKey)) continue;
      seenInBatch.add(dedupeKey);

      const position = (() => {
        const v = String(row.option ?? "").trim().toLowerCase();
        if (["yes","yea","aye","for"].includes(v)) return "Yea";
        if (["no","nay","against"].includes(v)) return "Nay";
        if (["present"].includes(v)) return "Present";
        if (["not voting","absent","excused","no vote","not recorded"].includes(v)) return "Not Voting";
        return "Other";
      })();

      const chamber = row.org_classification === "upper" ? "Senate" : row.org_classification === "lower" ? "House of Delegates" : null;
      const votedAt = row.start_date ? new Date(row.start_date) : null;
      const raw = JSON.stringify({ voteEvent: { id: row.vote_event_id, motion_text: row.motion_text, result: row.result, start_date: row.start_date, organization_id: row.organization_id }, bill: { id: row.bill_id, identifier: row.identifier, title: row.title }, vote: { option: row.option, voter_name: row.voter_name } });

      placeholders.push(
        `($${paramIdx++},$${paramIdx++},$${paramIdx++},$${paramIdx++},$${paramIdx++},` +
        `$${paramIdx++},$${paramIdx++},$${paramIdx++},$${paramIdx++},$${paramIdx++},$${paramIdx++},$${paramIdx++},$${paramIdx++},NOW())`
      );
      batchValues.push(stateCode, voterId, row.voter_name || null, String(row.vote_event_id), row.bill_id, row.identifier || null, row.title || null, chamber, row.motion_text || null, row.result || null, position, votedAt, raw);
      batchInserted++;
    }

    if (batchValues.length > 0) {
      await target.query(
        `INSERT INTO state_vote_records (state, legislator_id, legislator_name, vote_event_id, bill_id, bill_identifier, bill_title, chamber, motion_text, result, position, voted_at, raw, fetched_at)
         VALUES ${placeholders.join(",")}
         ON CONFLICT (state, legislator_id, vote_event_id) DO UPDATE SET
           position = EXCLUDED.position, legislator_name = EXCLUDED.legislator_name,
           bill_identifier = EXCLUDED.bill_identifier, bill_title = EXCLUDED.bill_title,
           chamber = EXCLUDED.chamber, motion_text = EXCLUDED.motion_text,
           result = EXCLUDED.result, voted_at = EXCLUDED.voted_at, raw = EXCLUDED.raw, fetched_at = NOW()`,
        batchValues,
      );
      inserted += batchInserted;
    }
    offset += rows.length;
  }

  await source.query(`DROP TABLE IF EXISTS ${tmpTable}`);
  log(`  ${stateName}: ${inserted.toLocaleString()} votes (${skipped.toLocaleString()} skipped)`);
}

const SKIP_STATE_CODES = new Set(["dc", "md", "ak"]);

async function main() {
  log("=== OpenStates All-States Ingestion ===");
  log(`Target DB: ${DATABASE_URL.replace(/:\/\/[^:]+:[^@]+@/, "://***@")}`);
  log(`Source DB: ${OPENSTATES_DB_URL.replace(/:\/\/[^:]+:[^@]+@/, "://***@")}`);

  await withClient(OPENSTATES_DB_URL, async (source) => {
    await withClient(DATABASE_URL, async (target) => {
      const jurisdictions = await getStateJurisdictions(source);
      const toProcess = jurisdictions.filter((j) => {
        const code = j.id.match(/state:([a-z]{2})/i)?.[1]?.toLowerCase() ?? "";
        return !SKIP_STATE_CODES.has(code);
      });
      log(`Found ${jurisdictions.length} state jurisdictions, ${toProcess.length} to process (skipping ${SKIP_STATE_CODES.size})`);

      let done = 0;
      for (const { id, name } of toProcess) {
        const start = Date.now();
        try {
          await ingestState(id, name, source, target);
        } catch (err) {
          log(`  ERROR ingesting ${name}: ${err}`);
        }
        done++;
        const elapsed = ((Date.now() - start) / 1000).toFixed(1);
        log(`  ${name} complete in ${elapsed}s (${done}/${toProcess.length})`);
        log(""); // blank line between states
      }

      log(`=== Ingested ${done}/${toProcess.length} states ===`);
    });
  });
}

main().catch((err) => { console.error(err); process.exit(1); });
