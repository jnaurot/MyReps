#!/usr/bin/env tsx
/**
 * Backfill state bill summaries and source URLs from the OpenStates dump.
 *
 * Fills:
 *   - state_bills.summary        ← opencivicdata_billabstract.abstract
 *   - state_bills.url            ← constructed OpenStates URL
 *   - state_bills.text_url       ← first opencivicdata_billsource.url
 *   - state_bills.raw            ← merged JSONB with abstract + sources
 *
 * Usage:
 *   export $(grep -v '^#' .env | xargs)
 *   npx tsx scripts/src/backfillStateBillSummariesAndUrls.ts
 */
import { Client } from "pg";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/civic_hub";
const OPENSTATES_DB_URL = process.env.OPENSTATES_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:5432/openstates";
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

function buildOpenStatesUrl(jurisdiction: string, session: string, identifier: string): string {
  const cleanId = identifier.replace(/\s+/g, "");
  return `https://openstates.org/${jurisdiction}/bills/${session}/${cleanId}/`;
}

async function main() {
  log("=== Backfilling state bill summaries and source URLs ===");

  await withClient(OPENSTATES_DB_URL, async (source) => {
    await withClient(DATABASE_URL, async (target) => {
      // Get all state jurisdictions
      const { rows: jurisdictions } = await source.query(
        `SELECT id, name FROM opencivicdata_jurisdiction
         WHERE id ~ '^ocd-jurisdiction/country:us/state:[a-z]{2}/government$'
            OR id = 'ocd-jurisdiction/country:us/district:dc/government'
         ORDER BY id`,
      );

      for (const j of jurisdictions) {
        const stateCode = j.id.match(/state:([a-z]{2})/i)?.[1]?.toLowerCase()
          ?? j.id.match(/district:([a-z]{2})/i)?.[1]?.toLowerCase()
          ?? "";
        if (!stateCode) continue;

        log(`--- ${j.name} (${stateCode}) ---`);

        // 1. Fetch abstracts from dump
        const { rows: abstracts } = await source.query(
          `SELECT ba.bill_id, ba.abstract
           FROM opencivicdata_billabstract ba
           JOIN opencivicdata_bill b ON ba.bill_id = b.id
           JOIN opencivicdata_legislativesession ls ON b.legislative_session_id = ls.id
           WHERE ls.jurisdiction_id = $1
             AND ba.abstract IS NOT NULL
             AND ba.abstract != ''`,
          [j.id],
        );
        log(`  Abstracts: ${abstracts.length}`);

        // 2. Fetch source URLs from dump
        const { rows: sources } = await source.query(
          `SELECT bs.bill_id, bs.url
           FROM opencivicdata_billsource bs
           JOIN opencivicdata_bill b ON bs.bill_id = b.id
           JOIN opencivicdata_legislativesession ls ON b.legislative_session_id = ls.id
           WHERE ls.jurisdiction_id = $1`,
          [j.id],
        );
        log(`  Sources: ${sources.length}`);

        // Build maps
        const abstractByBill = new Map<string, string>();
        for (const row of abstracts) {
          abstractByBill.set(row.bill_id, row.abstract);
        }

        const urlByBill = new Map<string, string>();
        for (const row of sources) {
          if (!urlByBill.has(row.bill_id)) {
            urlByBill.set(row.bill_id, row.url);
          }
        }

        // 3. Get existing state_bills for this jurisdiction
        const { rows: bills } = await target.query(
          `SELECT id, identifier, session, raw FROM state_bills WHERE state = $1`,
          [stateCode],
        );
        log(`  Bills in DB: ${bills.length}`);

        let updatedSummary = 0;
        let updatedUrl = 0;

        // Batch update in chunks
        for (let i = 0; i < bills.length; i += BATCH_SIZE) {
          const batch = bills.slice(i, i + BATCH_SIZE);

          for (const bill of batch) {
            const abstract = abstractByBill.get(bill.id);
            const sourceUrl = urlByBill.get(bill.id);
            const openstatesUrl = buildOpenStatesUrl(stateCode, bill.session, bill.identifier);

            const newRaw: Record<string, unknown> = { ...(bill.raw ?? {}) };
            let changed = false;

            if (abstract) {
              newRaw.abstract = abstract;
              changed = true;
            }
            if (sourceUrl) {
              newRaw.sources = [{ url: sourceUrl }];
              changed = true;
            }
            newRaw.openstates_url = openstatesUrl;

            await target.query(
              `UPDATE state_bills
               SET summary = COALESCE($1, summary),
                   url = COALESCE($2, url),
                   text_url = COALESCE($2, text_url),
                   raw = COALESCE(raw, '{}'::jsonb) || $3::jsonb
               WHERE id = $4`,
              [
                abstract ?? null,
                sourceUrl ?? openstatesUrl,
                JSON.stringify(newRaw),
                bill.id,
              ],
            );

            if (abstract) updatedSummary++;
            if (sourceUrl) updatedUrl++;
          }
        }

        log(`  Updated summaries: ${updatedSummary}, URLs: ${updatedUrl}`);
      }
    });
  });

  log("=== Done ===");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
