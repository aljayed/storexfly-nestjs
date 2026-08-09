-- Public usernames. An account claims one from its profile once its email is
-- verified, and it becomes the handle other people can reach it by in chat.
--
-- Deliberately not an email lookup: searching by address would let anyone
-- confirm whether a given address has a Hoomri account, and harvest names off
-- a list. A handle is only findable because its owner published it.

ALTER TABLE "users" ADD COLUMN "handle" varchar(24);--> statement-breakpoint

-- Stored lowercase, so the unique index is the case-insensitive check too.
-- Null stays free: Postgres unique indexes ignore nulls, so unclaimed accounts
-- do not collide with each other.
CREATE UNIQUE INDEX "users_handle_unique_idx" ON "users" USING btree ("handle");
