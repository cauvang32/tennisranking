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
