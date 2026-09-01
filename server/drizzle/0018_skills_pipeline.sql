CREATE TABLE IF NOT EXISTS "skill_candidates" (
	"session_id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"project_id" text,
	"score" integer NOT NULL,
	"signals" jsonb NOT NULL DEFAULT '{}',
	"topic_fingerprint" text,
	"cluster_id" text,
	"cluster_size" integer NOT NULL DEFAULT 1,
	"stage" text NOT NULL DEFAULT 'scored',
	"rejected_reason" text,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint
		WHERE conname = 'skill_candidates_session_id_sessions_id_fk'
		  AND conrelid = 'skill_candidates'::regclass
	) THEN
		ALTER TABLE "skill_candidates" ADD CONSTRAINT "skill_candidates_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;
	END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint
		WHERE conname = 'skill_candidates_user_id_users_id_fk'
		  AND conrelid = 'skill_candidates'::regclass
	) THEN
		ALTER TABLE "skill_candidates" ADD CONSTRAINT "skill_candidates_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
	END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint
		WHERE conname = 'skill_candidates_project_id_projects_id_fk'
		  AND conrelid = 'skill_candidates'::regclass
	) THEN
		ALTER TABLE "skill_candidates" ADD CONSTRAINT "skill_candidates_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
	END IF;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_candidates_stage" ON "skill_candidates" ("stage");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_candidates_cluster" ON "skill_candidates" ("cluster_id") WHERE "cluster_id" IS NOT NULL;
--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "skill_extracted_at" bigint;
