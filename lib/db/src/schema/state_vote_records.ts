import { pgTable, serial, text, timestamp, jsonb, uniqueIndex, index, varchar } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";

export const stateVoteRecordsTable = pgTable("state_vote_records", {
  id: serial("id").primaryKey(),

  state: varchar("state", { length: 2 }).notNull(),
  legislatorId: text("legislator_id").notNull(),
  legislatorName: text("legislator_name"),

  voteEventId: text("vote_event_id").notNull(),
  billId: text("bill_id").notNull(),
  billIdentifier: text("bill_identifier"),
  billTitle: text("bill_title"),

  chamber: text("chamber"),
  motionText: text("motion_text"),
  result: text("result"),

  position: text("position").notNull(),
  votedAt: timestamp("voted_at", { withTimezone: true }),

  sourceUrl: text("source_url"),
  raw: jsonb("raw"),

  fetchedAt: timestamp("fetched_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  uniqueIndex("state_vote_records_unique_idx").on(table.state, table.legislatorId, table.voteEventId),
  index("idx_state_vote_records_member_date").on(table.state, table.legislatorId, table.votedAt),
  index("idx_state_vote_records_member_position_date").on(table.state, table.legislatorId, table.position, table.votedAt),
  index("idx_state_vote_records_bill").on(table.state, table.billId),
  index("idx_state_vote_records_vote_event").on(table.state, table.voteEventId),
]);

export const insertStateVoteRecordSchema = createInsertSchema(stateVoteRecordsTable).omit({ id: true, fetchedAt: true });
export type InsertStateVoteRecord = import("zod/v4").infer<typeof insertStateVoteRecordSchema>;
export type StateVoteRecord = typeof stateVoteRecordsTable.$inferSelect;
