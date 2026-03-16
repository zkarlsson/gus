-- Add privacy and pinning columns to existing memories table
-- Safe to run multiple times (IF NOT EXISTS / idempotent)

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'memories' AND column_name = 'pinned'
  ) THEN
    ALTER TABLE memories ADD COLUMN pinned BOOLEAN DEFAULT false;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'memories' AND column_name = 'sensitivity'
  ) THEN
    ALTER TABLE memories ADD COLUMN sensitivity TEXT DEFAULT 'private';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'memories' AND column_name = 'audience'
  ) THEN
    ALTER TABLE memories ADD COLUMN audience TEXT[] DEFAULT '{}';
  END IF;
END $$;
