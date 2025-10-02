-- Verify and Update Multi-Season Migration
-- This script ensures all columns exist and are properly configured

-- 1. Check if columns exist and add them if missing
DO $$ 
BEGIN
    -- Add auto_end column if it doesn't exist
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                   WHERE table_name = 'seasons' AND column_name = 'auto_end') THEN
        ALTER TABLE seasons ADD COLUMN auto_end BOOLEAN DEFAULT false;
        RAISE NOTICE 'Added auto_end column';
    ELSE
        RAISE NOTICE 'auto_end column already exists';
    END IF;

    -- Add description column if it doesn't exist
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                   WHERE table_name = 'seasons' AND column_name = 'description') THEN
        ALTER TABLE seasons ADD COLUMN description TEXT;
        RAISE NOTICE 'Added description column';
    ELSE
        RAISE NOTICE 'description column already exists';
    END IF;

    -- Add ended_at column if it doesn't exist
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                   WHERE table_name = 'seasons' AND column_name = 'ended_at') THEN
        ALTER TABLE seasons ADD COLUMN ended_at TIMESTAMP;
        RAISE NOTICE 'Added ended_at column';
    ELSE
        RAISE NOTICE 'ended_at column already exists';
    END IF;

    -- Add ended_by column if it doesn't exist
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                   WHERE table_name = 'seasons' AND column_name = 'ended_by') THEN
        ALTER TABLE seasons ADD COLUMN ended_by VARCHAR(100);
        RAISE NOTICE 'Added ended_by column';
    ELSE
        RAISE NOTICE 'ended_by column already exists';
    END IF;
END $$;

-- 2. Ensure end_date is truly optional (NULL allowed)
ALTER TABLE seasons ALTER COLUMN end_date DROP NOT NULL;

-- 3. Update existing seasons to have auto_end = false if NULL
UPDATE seasons 
SET auto_end = false 
WHERE auto_end IS NULL;

-- 4. Add comments for documentation
COMMENT ON COLUMN seasons.auto_end IS 'Whether season should automatically end on end_date';
COMMENT ON COLUMN seasons.description IS 'Optional description of the season';
COMMENT ON COLUMN seasons.ended_at IS 'Timestamp when season was manually ended';
COMMENT ON COLUMN seasons.ended_by IS 'Username of admin/editor who ended the season';
COMMENT ON COLUMN seasons.end_date IS 'Optional end date for the season. NULL means no automatic end date.';

-- 5. Display final schema
\echo '=== Current seasons table schema ==='
SELECT 
    column_name, 
    data_type, 
    is_nullable,
    column_default
FROM information_schema.columns 
WHERE table_name = 'seasons' 
ORDER BY ordinal_position;

-- 6. Display confirmation
SELECT 'Multi-season migration verified and updated successfully!' as status;
