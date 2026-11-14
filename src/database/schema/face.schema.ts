import {
  boolean,
  index,
  integer,
  pgTable,
  primaryKey,
  real,
  timestamp,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { users } from './users.schema';

/**
 * One face per account - what makes "one free shop for each person" mean a
 * person rather than an email address.
 *
 * `embedding` is the mean of the account's enrollment samples, stored after a
 * secret rotation (FaceTemplateCipher): similarity between two stored faces
 * is unchanged, so the duplicate search works, but a vector lifted from this
 * table cannot be compared with one from a stock model. No photo is kept -
 * frames are decoded in memory and dropped.
 *
 * Plain `real[]` rather than pgvector: the search is an exact scan done in
 * the API (FaceEnrollmentService), which needs no extension and is the right
 * shape for a uniqueness check anyway.
 */
export const faceTemplates = pgTable('face_templates', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  embedding: real('embedding').array().notNull(),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

/** The individual frontal samples behind the mean; searched alongside it. */
export const faceTemplateSamples = pgTable(
  'face_template_samples',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    slot: integer('slot').notNull(),
    embedding: real('embedding').array().notNull(),
  },
  (table) => [primaryKey({ columns: [table.userId, table.slot] })],
);

/** Audit trail of face checks: scores and the outcome, never an image. */
export const faceChecks = pgTable(
  'face_checks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    sessionId: uuid('session_id'),
    passed: boolean('passed').notNull(),
    /** capture_v2 on success; otherwise spoof, mismatch, duplicate, review, … */
    reason: varchar('reason', { length: 40 }),
    policyVersion: varchar('policy_version', { length: 80 }),
    /** Lowest liveness / same-face score seen in the session. */
    liveness: real('liveness'),
    consistency: real('consistency'),
    /** The closest other account and how close, when there was one. */
    duplicateOfId: uuid('duplicate_of_id'),
    duplicateScore: real('duplicate_score'),
    /** A duplicate or a near match: something for an operator to look at. */
    flagged: boolean('flagged').notNull().default(false),
    reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
    reviewedBy: varchar('reviewed_by', { length: 254 }),
    reviewNote: varchar('review_note', { length: 1000 }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index('face_checks_user_idx').on(table.userId),
    index('face_checks_flagged_idx').on(table.flagged, table.reviewedAt),
  ],
);

/**
 * Which key and model the stored faces were made with. Bound on first use;
 * if either changes afterwards every stored face stops being comparable, so
 * the check turns itself off rather than quietly letting duplicates through.
 */
export const faceSystem = pgTable('face_system', {
  id: integer('id').primaryKey(),
  compatibility: varchar('compatibility', { length: 64 }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type FaceCheckRow = typeof faceChecks.$inferSelect;
