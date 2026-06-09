import { pgTable, text, date, timestamp, jsonb, uniqueIndex, index, customType, boolean, varchar } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { z } from "zod/v4";

const tsvector = customType<{ data: string }>({
  dataType() {
    return "tsvector";
  },
});

export const stateBillsTable = pgTable("state_bills", {
  id: text("id").primaryKey(),
  identifier: text("identifier"),
  title: text("title").notNull(),
  session: text("session"),
  chamber: text("chamber"),
  status: text("status"),
  introducedDate: date("introduced_date"),
  stageIntroduced: boolean("stage_introduced").default(false).notNull(),
  stageCommittee: boolean("stage_committee").default(false).notNull(),
  stageFloorVote: boolean("stage_floor_vote").default(false).notNull(),
  stagePassed: boolean("stage_passed").default(false).notNull(),
  stageSignedEnacted: boolean("stage_signed_enacted").default(false).notNull(),
  stageDead: boolean("stage_dead").default(false).notNull(),
  summary: text("summary"),
  subjects: text("subjects").array(),
  url: text("url"),
  textUrl: text("text_url"),
  text: text("text"),
  state: varchar("state", { length: 2 }).notNull(),
  raw: jsonb("raw"),
  fetchedAt: timestamp("fetched_at", { withTimezone: true }).defaultNow().notNull(),
  searchVector: tsvector("search_vector"),
}, (table) => [
  uniqueIndex("state_bills_id_idx").on(table.id),
  index("idx_state_bills_state").on(table.state),
  index("idx_state_bills_search").using("gin", table.searchVector),
  index("idx_state_bills_fetched_at").on(table.fetchedAt),
  index("idx_state_bills_stage_signed").on(table.state, table.stageSignedEnacted, table.chamber, table.introducedDate),
  index("idx_state_bills_stage_committee").on(table.state, table.stageCommittee, table.chamber, table.introducedDate),
  index("idx_state_bills_stage_floor_vote").on(table.state, table.stageFloorVote, table.chamber, table.introducedDate),
  index("idx_state_bills_stage_passed").on(table.state, table.stagePassed, table.chamber, table.introducedDate),
  index("idx_state_bills_stage_dead").on(table.state, table.stageDead, table.chamber, table.introducedDate),
  index("idx_state_bills_sponsorships_gin").using("gin", sql`(raw->'sponsorships')`),
]);

export const insertStateBillSchema = z.object({
  id: z.string(),
  identifier: z.string().optional(),
  title: z.string(),
  session: z.string().optional(),
  chamber: z.string().optional(),
  status: z.string().optional(),
  introducedDate: z.string().optional(),
  summary: z.string().optional(),
  subjects: z.array(z.string()).optional(),
  url: z.string().optional(),
  textUrl: z.string().optional(),
  state: z.string().length(2),
  raw: z.any().optional(),
});
export type InsertStateBill = z.infer<typeof insertStateBillSchema>;
export type StateBill = typeof stateBillsTable.$inferSelect;
