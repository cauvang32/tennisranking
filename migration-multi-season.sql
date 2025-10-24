-- Add new columns to seasons table for multi-season support
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
COMMENT ON COLUMN seasons.auto_end IS 'Whether season should automatically end on end_date';
COMMENT ON COLUMN seasons.description IS 'Optional description of the season';
COMMENT ON COLUMN seasons.ended_at IS 'Timestamp when season was manually ended';
COMMENT ON COLUMN seasons.ended_by IS 'Username of admin/editor who ended the season';

-- Display confirmation
SELECT 'Migration completed successfully!' as status;