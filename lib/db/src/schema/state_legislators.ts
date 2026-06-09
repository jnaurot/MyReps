import { pgTable, text, timestamp, jsonb, uniqueIndex, index, varchar } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";

export const stateLegislatorsTable = pgTable("state_legislators", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  party: text("party"),
  chamber: text("chamber"),
  district: text("district"),
  photoUrl: text("photo_url"),
  email: text("email"),
  phone: text("phone"),
  openstatesUrl: text("openstates_url"),
  state: varchar("state", { length: 2 }).notNull(),
  raw: jsonb("raw"),
  fetchedAt: timestamp("fetched_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  uniqueIndex("state_legislators_id_idx").on(table.id),
  index("idx_state_legislators_state_district").on(table.state, table.district),
  index("idx_state_legislators_fetched_at").on(table.fetchedAt),
]);

export const insertStateLegislatorSchema = createInsertSchema(stateLegislatorsTable).omit({ fetchedAt: true });
export type InsertStateLegislator = import("zod/v4").infer<typeof insertStateLegislatorSchema>;
export type StateLegislator = typeof stateLegislatorsTable.$inferSelect;
