-- Verify and fix seasons table schema for multi-season support
-- This script ensures end_date is nullable and adds new columns if needed

-- Make sure end_date allows NULL (it should already, but this is a safety check)
ALTER TABLE seasons ALTER COLUMN end_date DROP NOT NULL;

-- Add new columns if they don't exist (safe to run multiple times)
ALTER TABLE seasons 
ADD COLUMN IF NOT EXISTS auto_end BOOLEAN DEFAULT false,
ADD COLUMN IF NOT EXISTS description TEXT,
ADD COLUMN IF NOT EXISTS ended_at TIMESTAMP,
ADD COLUMN IF NOT EXISTS ended_by VARCHAR(100);

-- Update existing seasons to have auto_end = false if NULL
UPDATE seasons 
SET auto_end = false 
WHERE auto_end IS NULL;

-- Add comments for documentation
COMMENT ON COLUMN seasons.end_date IS 'Optional end date for the season. NULL means no end date set.';
COMMENT ON COLUMN seasons.auto_end IS 'Whether season should automatically end on end_date';
COMMENT ON COLUMN seasons.description IS 'Optional description of the season';
COMMENT ON COLUMN seasons.ended_at IS 'Timestamp when season was manually ended';
COMMENT ON COLUMN seasons.ended_by IS 'Username of admin/editor who ended the season';

-- Display current schema
SELECT 
  column_name,
  data_type,
  is_nullable,
  column_default
FROM information_schema.columns 
WHERE table_name = 'seasons'
ORDER BY ordinal_position;

-- Display confirmation
SELECT '✅ Season schema verification completed!' as status;
