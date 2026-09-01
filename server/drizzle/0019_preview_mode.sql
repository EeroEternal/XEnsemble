DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'deployments' AND column_name = 'mode'
    ) THEN
        ALTER TABLE "deployments" ADD COLUMN "mode" text DEFAULT 'static' NOT NULL;
    END IF;
END $$;
