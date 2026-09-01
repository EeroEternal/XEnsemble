CREATE TABLE IF NOT EXISTS "skills" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"project_id" text,
	"session_id" text,
	"title" text NOT NULL,
	"content" text NOT NULL,
	"tags" jsonb NOT NULL DEFAULT '[]',
	"status" text NOT NULL DEFAULT 'draft',
	"source" text NOT NULL DEFAULT 'auto',
	"confidence" real,
	"duplicate_of" text,
	"cluster_size" integer NOT NULL DEFAULT 1,
	"signals" jsonb,
	"usage_count" integer NOT NULL DEFAULT 0,
	"visibility" text NOT NULL DEFAULT 'private',
	"published_at" bigint,
	"install_count" integer NOT NULL DEFAULT 0,
	"category" text,
	"forked_from" text,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint
		WHERE conname = 'skills_user_id_users_id_fk'
		  AND conrelid = 'skills'::regclass
	) THEN
		ALTER TABLE "skills" ADD CONSTRAINT "skills_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
	END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint
		WHERE conname = 'skills_project_id_projects_id_fk'
		  AND conrelid = 'skills'::regclass
	) THEN
		ALTER TABLE "skills" ADD CONSTRAINT "skills_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
	END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint
		WHERE conname = 'skills_session_id_sessions_id_fk'
		  AND conrelid = 'skills'::regclass
	) THEN
		ALTER TABLE "skills" ADD CONSTRAINT "skills_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE set null ON UPDATE no action;
	END IF;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_skills_user_status" ON "skills" ("user_id","status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_skills_market" ON "skills" ("visibility","status","published_at");
