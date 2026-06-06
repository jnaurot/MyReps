#!/usr/bin/env tsx
/**
 * Preload state legislator photos into the local member-photo cache without
 * modifying database state.
 *
 * For each legislator with a photo_url:
 *   1. Skip if the exact upstream URL is already cached for that legislator ID.
 *   2. Try to fetch the photo from the current photo_url.
 *   3. If valid, cache it locally.
 *   4. If invalid or unreachable, log the failure and continue.
 *
 * Environment:
 *   DATABASE_URL     - target civic_hub database
 *   PHOTO_CACHE_DIR  - optional override for cache output root
 *   DELAY_MS         - delay between requests (default: 100)
 */
import { Client } from "pg";
import { getCachedPhoto, setCachedPhoto } from "../../artifacts/api-server/src/lib/photoCache";

const DATABASE_URL =
  process.env.DATABASE_URL ??
  "postgresql://postgres:postgres@localhost:5432/civic_hub";
const DELAY_MS = Number(process.env.DELAY_MS ?? "100");

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

async function sleep(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchPhoto(url: string): Promise<{
  ok: boolean;
  buffer?: Buffer;
  contentType?: string;
  status?: number;
  reason?: string;
}> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);

  try {
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: "follow",
    });
    if (!res.ok) {
      return {
        ok: false,
        status: res.status,
        reason: `HTTP ${res.status}`,
      };
    }

    const contentType = res.headers.get("content-type") ?? "image/jpeg";
    if (!contentType.startsWith("image/")) {
      return {
        ok: false,
        reason: `non-image content-type: ${contentType}`,
      };
    }

    const buffer = Buffer.from(await res.arrayBuffer());
    if (buffer.length === 0) {
      return {
        ok: false,
        reason: "empty response body",
      };
    }

    return { ok: true, buffer, contentType };
  } catch (err) {
    const reason =
      err instanceof Error ? err.message : "unknown fetch error";
    return { ok: false, reason };
  } finally {
    clearTimeout(timeout);
  }
}

async function main() {
  log("=== Preloading state legislator photos into cache ===");
  log(`Target DB: ${DATABASE_URL.replace(/:\/\/[^:]+:[^@]+@/, "://***@")}`);
  log(`Delay: ${DELAY_MS}ms between requests`);
  if (process.env.PHOTO_CACHE_DIR) {
    log(`PHOTO_CACHE_DIR override: ${process.env.PHOTO_CACHE_DIR}`);
  }

  await withClient(DATABASE_URL, async (client) => {
    const { rows } = await client.query<{
      id: string;
      photo_url: string;
    }>(
      `SELECT id, photo_url
       FROM state_legislators
       WHERE photo_url IS NOT NULL
         AND btrim(photo_url) <> ''
       ORDER BY id`,
    );

    log(`Found ${rows.length} legislators with photo URLs`);

    let cached = 0;
    let skipped = 0;
    let failed = 0;

    for (let i = 0; i < rows.length; i++) {
      const { id, photo_url } = rows[i];
      const label = `${i + 1}/${rows.length}`;

      const existing = await getCachedPhoto(photo_url, id);
      if (existing) {
        skipped++;
        if (skipped % 250 === 0) {
          log(`  ${label} skipped ${skipped} already-cached photos`);
        }
        await sleep(DELAY_MS);
        continue;
      }

      const result = await fetchPhoto(photo_url);
      if (!result.ok || !result.buffer || !result.contentType) {
        failed++;
        log(
          `  ${label} failed for ${id}: ${result.reason ?? "unknown error"}`,
        );
        await sleep(DELAY_MS);
        continue;
      }

      await setCachedPhoto(photo_url, id, result.buffer, result.contentType);
      cached++;
      if (cached % 100 === 0) {
        log(`  ${label} cached ${cached} photos`);
      }
      await sleep(DELAY_MS);
    }

    log("=== Done ===");
    log(`Cached:  ${cached}`);
    log(`Skipped: ${skipped}`);
    log(`Failed:  ${failed}`);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
