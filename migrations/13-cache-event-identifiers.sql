CREATE OR REPLACE FUNCTION notify_cache_invalidation()
RETURNS TRIGGER AS $$
DECLARE
  payload JSON;
  row_id BIGINT;
  match_date TEXT;
  old_match_date TEXT;
  season_id_value BIGINT;
  old_season_id_value BIGINT;
BEGIN
  -- Bulk operations (restore, clear-all-data) set this session flag around the
  -- whole transaction. Per-row notifications would be hundreds per restore and
  -- each one bumps the data version, which fans out to every client as an
  -- /api/init call and trips the init rate limiter. In bulk mode the row
  -- triggers stay silent and the route notifies once after the transaction
  -- commits (notify_cache_invalidation_tx, called from the application).
  IF (current_setting('tennis.cache_bulk_tx', TRUE) = '1') THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    row_id := OLD.id;
  ELSE
    row_id := NEW.id;
  END IF;

  IF TG_TABLE_NAME = 'matches' THEN
    IF TG_OP <> 'DELETE' THEN
      match_date := TO_CHAR(NEW.play_date::DATE, 'YYYY-MM-DD');
      season_id_value := NEW.season_id;
    END IF;
    IF TG_OP <> 'INSERT' THEN
      old_match_date := TO_CHAR(OLD.play_date::DATE, 'YYYY-MM-DD');
      old_season_id_value := OLD.season_id;
    END IF;
  END IF;

  payload := json_build_object(
    'eventId', txid_current()::TEXT || ':' || TG_TABLE_NAME || ':' || TG_OP || ':' || row_id,
    'table', TG_TABLE_NAME,
    'action', TG_OP,
    'id', row_id,
    'date', match_date,
    'oldDate', old_match_date,
    'seasonId', season_id_value,
    'oldSeasonId', old_season_id_value
  );

  PERFORM pg_notify('cache_invalidation', payload::TEXT);
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Bulk-mode transaction notification. Called by the application once per bulk
-- operation (restore, clear-all-data) after the transaction commits — the
-- only way to fire exactly once per transaction, because pg_transaction
-- triggers are not supported in PostgreSQL. The eventId is stable per
-- transaction, so cluster workers claim it once and the data version is
-- bumped exactly once for the whole bulk transaction.
DROP FUNCTION IF EXISTS notify_cache_invalidation_tx();
CREATE OR REPLACE FUNCTION notify_cache_invalidation_tx()
RETURNS void AS $$
BEGIN
  PERFORM pg_notify('cache_invalidation', json_build_object(
    'eventId', txid_current()::TEXT || ':bulk:COMMIT:0',
    'table', 'bulk',
    'action', 'COMMIT',
    'id', 0
  )::TEXT);
END;
$$ LANGUAGE plpgsql;
