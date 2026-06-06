#!/usr/bin/env tsx
/**
 * Sync state legislator photo URLs from the OpenStates source database into
 * civic_hub.state_legislators via a staging table.
 *
 * Environment:
 *   DATABASE_URL       - target civic_hub database
 *   OPENSTATES_DB_URL  - source openstates database
 *   DRY_RUN=true       - stage and report counts without updating photo_url
 *
 * Example:
 *   DATABASE_URL=postgresql://.../civic_hub \
 *   OPENSTATES_DB_URL=postgresql://.../openstates \
 *   pnpm --filter @workspace/scripts backfill:state-legislator-photos
 */
import { Client } from "pg";

const DATABASE_URL =
  process.env.DATABASE_URL ??
  "postgresql://postgres:postgres@localhost:5432/civic_hub";
const OPENSTATES_DB_URL =
  process.env.OPENSTATES_DB_URL ??
  "postgresql://postgres:postgres@localhost:5432/openstates";
const DRY_RUN = process.env.DRY_RUN === "true";
const STAGING_TABLE = "state_legislator_photo_seed";
const BATCH_SIZE = 1000;

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

async function ensureStagingTable(target: Client) {
  await target.query(`
    CREATE TABLE IF NOT EXISTS public.${STAGING_TABLE} (
      id text PRIMARY KEY,
      image text NOT NULL,
      sourced_at timestamp with time zone NOT NULL DEFAULT now()
    )
  `);
}

async function stagePhotoRows(target: Client, rows: Array<{ id: string; image: string }>) {
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    const values: unknown[] = [];
    const placeholders = batch.map((row, index) => {
      const offset = index * 2;
      values.push(row.id, row.image);
      return `($${offset + 1}, $${offset + 2}, now())`;
    });

    await target.query(
      `INSERT INTO public.${STAGING_TABLE} (id, image, sourced_at)
       VALUES ${placeholders.join(", ")}
       ON CONFLICT (id) DO UPDATE
       SET image = EXCLUDED.image,
           sourced_at = now()`,
      values,
    );
  }
}

async function main() {
  log("=== Syncing state legislator photo URLs from OpenStates ===");
  log(`Target DB: ${DATABASE_URL.replace(/:\/\/[^:]+:[^@]+@/, "://***@")}`);
  log(`Source DB: ${OPENSTATES_DB_URL.replace(/:\/\/[^:]+:[^@]+@/, "://***@")}`);
  log(`Dry run: ${DRY_RUN ? "yes" : "no"}`);

  await withClient(OPENSTATES_DB_URL, async (source) => {
    const { rows: sourceRows } = await source.query<{ id: string; image: string }>(
      `SELECT id, image
       FROM opencivicdata_person
       WHERE image IS NOT NULL
         AND btrim(image) <> ''
       ORDER BY id`,
    );

    log(`Fetched ${sourceRows.length} source rows with images`);

    await withClient(DATABASE_URL, async (target) => {
      await ensureStagingTable(target);
      await target.query(`TRUNCATE TABLE public.${STAGING_TABLE}`);
      await stagePhotoRows(target, sourceRows);

      const [{ count: stagedCount }] = (
        await target.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM public.${STAGING_TABLE}`,
        )
      ).rows;

      const [{ count: matchedCount }] = (
        await target.query<{ count: string }>(
          `SELECT count(*)::text AS count
           FROM state_legislators sl
           JOIN public.${STAGING_TABLE} seed ON seed.id = sl.id`,
        )
      ).rows;

      const [{ count: missingCount }] = (
        await target.query<{ count: string }>(
          `SELECT count(*)::text AS count
           FROM state_legislators sl
           JOIN public.${STAGING_TABLE} seed ON seed.id = sl.id
           WHERE sl.photo_url IS NULL OR btrim(sl.photo_url) = ''`,
        )
      ).rows;

      const [{ count: changedCount }] = (
        await target.query<{ count: string }>(
          `SELECT count(*)::text AS count
           FROM state_legislators sl
           JOIN public.${STAGING_TABLE} seed ON seed.id = sl.id
           WHERE seed.image IS DISTINCT FROM sl.photo_url`,
        )
      ).rows;

      log(`Staged rows: ${stagedCount}`);
      log(`Matching state_legislators rows: ${matchedCount}`);
      log(`Matches currently missing photo_url: ${missingCount}`);
      log(`Rows that would change: ${changedCount}`);

      if (DRY_RUN) {
        log("Dry run complete. No state_legislators rows were updated.");
        return;
      }

      const result = await target.query(
        `UPDATE state_legislators sl
         SET photo_url = seed.image,
             fetched_at = now()
         FROM public.${STAGING_TABLE} seed
         WHERE seed.id = sl.id
           AND seed.image IS DISTINCT FROM sl.photo_url`,
      );

      log(`Updated state_legislators rows: ${result.rowCount ?? 0}`);
    });
  });

  log("=== Done ===");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
