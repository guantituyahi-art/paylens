import { sql } from "drizzle-orm";
import {
  bigserial,
  check,
  date,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

export const developers = pgTable("developers", {
  id: uuid("id").primaryKey(),
  email: text("email").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const projects = pgTable(
  "projects",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    developerId: uuid("developer_id")
      .notNull()
      .references(() => developers.id),
    name: text("name").notNull(),
    timezone: text("timezone").notNull(),
    retentionDays: integer("retention_days").notNull().default(365),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("projects_developer_id_idx").on(table.developerId)],
);

export const projectKeys = pgTable(
  "project_keys",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    key: text("key").notNull().unique(),
    label: text("label"),
    status: text("status").notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    deprecatedAt: timestamp("deprecated_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (table) => [
    index("project_keys_project_id_idx").on(table.projectId),
    check("project_keys_status_check", sql`${table.status} in ('active', 'deprecated', 'revoked')`),
  ],
);

export const events = pgTable(
  "events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    eventId: uuid("event_id").notNull(),
    anonymousUserId: text("anonymous_user_id").notNull(),
    paywallSessionId: uuid("paywall_session_id").notNull(),
    eventName: text("event_name").notNull(),
    platform: text("platform").notNull(),
    appVersion: text("app_version").notNull(),
    paywallVersion: text("paywall_version"),
    productId: text("product_id"),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("events_project_event_unique").on(table.projectId, table.eventId),
    index("events_project_occurred_idx").on(table.projectId, table.occurredAt),
    index("events_project_name_occurred_idx").on(table.projectId, table.eventName, table.occurredAt),
    index("events_project_session_idx").on(table.projectId, table.paywallSessionId),
    index("events_project_user_idx").on(table.projectId, table.anonymousUserId),
  ],
);

export const feedback = pgTable(
  "feedback",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    feedbackId: uuid("feedback_id").notNull(),
    anonymousUserId: text("anonymous_user_id").notNull(),
    paywallSessionId: uuid("paywall_session_id").notNull(),
    reasonCode: text("reason_code").notNull(),
    reasonLabel: text("reason_label"),
    comment: text("comment"),
    platform: text("platform").notNull(),
    appVersion: text("app_version").notNull(),
    paywallVersion: text("paywall_version"),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("feedback_project_feedback_unique").on(table.projectId, table.feedbackId),
    index("feedback_project_occurred_idx").on(table.projectId, table.occurredAt),
    index("feedback_project_reason_occurred_idx").on(table.projectId, table.reasonCode, table.occurredAt),
    index("feedback_project_session_idx").on(table.projectId, table.paywallSessionId),
    index("feedback_project_user_idx").on(table.projectId, table.anonymousUserId),
  ],
);

export const projectDailyUsage = pgTable(
  "project_daily_usage",
  {
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    day: date("day").notNull(),
    eventCount: integer("event_count").notNull().default(0),
  },
  (table) => [primaryKey({ columns: [table.projectId, table.day] })],
);
