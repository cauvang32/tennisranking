-- Migration: Add PostgreSQL NOTIFY triggers for Redis cache invalidation
-- This enables automatic cache invalidation when data changes in the database

-- Create notification function for cache invalidation
CREATE OR REPLACE FUNCTION notify_cache_invalidation()
RETURNS TRIGGER AS $$
DECLARE
  payload JSON;
  match_date TEXT;
BEGIN
  -- Build payload with table name, action, and relevant data
  IF TG_TABLE_NAME = 'matches' THEN
    -- For matches, include the play_date for targeted invalidation
    IF TG_OP = 'DELETE' THEN
      match_date := TO_CHAR(OLD.play_date::DATE, 'YYYY-MM-DD');
      payload := json_build_object(
        'table', TG_TABLE_NAME,
        'action', TG_OP,
        'id', OLD.id,
        'date', match_date
      );
    ELSE
      match_date := TO_CHAR(NEW.play_date::DATE, 'YYYY-MM-DD');
      payload := json_build_object(
        'table', TG_TABLE_NAME,
        'action', TG_OP,
        'id', NEW.id,
        'date', match_date
      );
    END IF;
  ELSIF TG_TABLE_NAME = 'players' THEN
    IF TG_OP = 'DELETE' THEN
      payload := json_build_object(
        'table', TG_TABLE_NAME,
        'action', TG_OP,
        'id', OLD.id
      );
    ELSE
      payload := json_build_object(
        'table', TG_TABLE_NAME,
        'action', TG_OP,
        'id', NEW.id
      );
    END IF;
  ELSIF TG_TABLE_NAME = 'seasons' THEN
    IF TG_OP = 'DELETE' THEN
      payload := json_build_object(
        'table', TG_TABLE_NAME,
        'action', TG_OP,
        'id', OLD.id
      );
    ELSE
      payload := json_build_object(
        'table', TG_TABLE_NAME,
        'action', TG_OP,
        'id', NEW.id
      );
    END IF;
  ELSE
    -- Generic payload for other tables
    IF TG_OP = 'DELETE' THEN
      payload := json_build_object(
        'table', TG_TABLE_NAME,
        'action', TG_OP,
        'id', OLD.id
      );
    ELSE
      payload := json_build_object(
        'table', TG_TABLE_NAME,
        'action', TG_OP,
        'id', NEW.id
      );
    END IF;
  END IF;

  -- Send notification to cache_invalidation channel
  PERFORM pg_notify('cache_invalidation', payload::TEXT);
  
  -- Return appropriate row based on operation
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  ELSE
    RETURN NEW;
  END IF;
END;
$$ LANGUAGE plpgsql;

-- Drop existing triggers if they exist (for idempotent migration)
DROP TRIGGER IF EXISTS matches_cache_invalidation ON matches;
DROP TRIGGER IF EXISTS players_cache_invalidation ON players;
DROP TRIGGER IF EXISTS seasons_cache_invalidation ON seasons;

-- Create triggers for matches table
CREATE TRIGGER matches_cache_invalidation
AFTER INSERT OR UPDATE OR DELETE ON matches
FOR EACH ROW
EXECUTE FUNCTION notify_cache_invalidation();

-- Create triggers for players table
CREATE TRIGGER players_cache_invalidation
AFTER INSERT OR UPDATE OR DELETE ON players
FOR EACH ROW
EXECUTE FUNCTION notify_cache_invalidation();

-- Create triggers for seasons table
CREATE TRIGGER seasons_cache_invalidation
AFTER INSERT OR UPDATE OR DELETE ON seasons
FOR EACH ROW
EXECUTE FUNCTION notify_cache_invalidation();

-- Verify triggers were created
DO $$
BEGIN
  RAISE NOTICE 'Cache invalidation triggers created successfully';
  RAISE NOTICE 'Triggers active on: matches, players, seasons';
  RAISE NOTICE 'Notifications sent to channel: cache_invalidation';
END $$;
