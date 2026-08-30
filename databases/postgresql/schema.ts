import { DatabaseCore } from './core.js'

export class SchemaMethods extends DatabaseCore {
  async createTables() {
    const client = await this.pool.connect()
    
    try {
      await client.query('BEGIN')
      // Serialize schema bootstrap across PM2 workers. Long-term schema changes
      // live in migrations; this lock protects legacy idempotent bootstrap DDL.
      await client.query(`SELECT pg_advisory_xact_lock(hashtext('tennis-schema-bootstrap'))`)

      // Players table
      await client.query(`
        CREATE TABLE IF NOT EXISTS players (
          id SERIAL PRIMARY KEY,
          name VARCHAR(255) UNIQUE NOT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `)

      // Seasons table - supports multiple concurrent active seasons
      // lose_money_per_loss: configurable penalty amount per loss (default 20000 VND)
      await client.query(`
        CREATE TABLE IF NOT EXISTS seasons (
          id SERIAL PRIMARY KEY,
          name VARCHAR(255) NOT NULL,
          start_date DATE NOT NULL,
          end_date DATE,
          is_active BOOLEAN DEFAULT true,
          auto_end BOOLEAN DEFAULT true,
          description TEXT,
          lose_money_per_loss INTEGER DEFAULT 20000,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          ended_at TIMESTAMP,
          ended_by VARCHAR(255)
        )
      `)

      // Season players junction table - controls which players can participate in each season
      await client.query(`
        CREATE TABLE IF NOT EXISTS season_players (
          id SERIAL PRIMARY KEY,
          season_id INTEGER NOT NULL REFERENCES seasons(id) ON DELETE CASCADE,
          player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
          added_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          added_by VARCHAR(255),
          UNIQUE(season_id, player_id)
        )
      `)

      // Matches table
      // match_type: 'duo' (đánh đôi, 4 players) or 'solo' (đánh đơn, 2 players)
      await client.query(`
        CREATE TABLE IF NOT EXISTS matches (
          id SERIAL PRIMARY KEY,
          season_id INTEGER NOT NULL REFERENCES seasons(id),
          play_date DATE NOT NULL,
          player1_id INTEGER NOT NULL REFERENCES players(id),
          player2_id INTEGER REFERENCES players(id),
          player3_id INTEGER REFERENCES players(id),
          player4_id INTEGER REFERENCES players(id),
          team1_score INTEGER NOT NULL,
          team2_score INTEGER NOT NULL,
          winning_team INTEGER NOT NULL,
          match_type VARCHAR(10) DEFAULT 'duo',
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          CONSTRAINT check_match_type CHECK (match_type IN ('solo', 'duo')),
          CONSTRAINT check_match_players CHECK (
            (match_type = 'duo' AND player2_id IS NOT NULL AND player4_id IS NOT NULL) OR
            (match_type = 'solo' AND player2_id IS NULL AND player4_id IS NULL)
          )
        )
      `)

      // Additional indexes for player lookups (form queries)
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_matches_player1_id ON matches(player1_id);
      `)
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_matches_player2_id ON matches(player2_id);
      `)
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_matches_player3_id ON matches(player3_id);
      `)
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_matches_player4_id ON matches(player4_id);
      `)

      // Composite index for season+date queries
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_matches_season_date ON matches(season_id, play_date DESC);
      `)

      // Composite index for form lookup (covering index)
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_matches_form_lookup
        ON matches(play_date DESC, created_at DESC)
        INCLUDE (player1_id, player2_id, player3_id, player4_id, winning_team);
      `)

      // Users must exist before devices declares its foreign key on a fresh DB.
      await client.query(`
        CREATE TABLE IF NOT EXISTS users (
          id SERIAL PRIMARY KEY,
          username VARCHAR(100) UNIQUE NOT NULL,
          email VARCHAR(255),
          password_hash TEXT NOT NULL,
          role VARCHAR(20) NOT NULL CHECK (role IN ('admin', 'editor', 'viewer')),
          display_name VARCHAR(255),
          is_active BOOLEAN DEFAULT true,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          last_login TIMESTAMPTZ,
          token_version INTEGER NOT NULL DEFAULT 0,
          created_by VARCHAR(100),
          notes TEXT
        )
      `)

      // FCM device registry — self-bootstrapped so a fresh DB doesn't need the
      // separate migrations/add-devices-table.sh to be run first.
      await client.query(`
        CREATE TABLE IF NOT EXISTS devices (
          id          BIGSERIAL PRIMARY KEY,
          user_id     BIGINT NULL REFERENCES users(id) ON DELETE CASCADE,
          token       TEXT NOT NULL UNIQUE,
          platform    VARCHAR(8) NOT NULL CHECK (platform IN ('android', 'ios')),
          app_version VARCHAR(32) NULL,
          created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
      `)
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_devices_user_id ON devices(user_id);
      `)
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_devices_updated_at ON devices(updated_at);
      `)
      // Idempotent column add — captured registration IP, used for the
      // per-IP cap on guest devices (FCM bloat prevention).
      await client.query(`
        ALTER TABLE devices ADD COLUMN IF NOT EXISTS registered_ip VARCHAR(45) NULL;
      `)
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_devices_registered_ip ON devices(registered_ip);
      `)

      // ── Users table (account system) ────────────────────────────────────────
      // Created here so the app bootstraps without manual migration runs.
      // Existing accounts-migration DDL was already covered, but self-bootstrapping
      // ensures fresh Docker/PM2 deploys work immediately.
      await client.query(`
        CREATE TABLE IF NOT EXISTS users (
          id SERIAL PRIMARY KEY,
          username VARCHAR(100) UNIQUE NOT NULL,
          email VARCHAR(255),
          password_hash TEXT NOT NULL,
          role VARCHAR(20) NOT NULL CHECK (role IN ('admin', 'editor', 'viewer')),
          display_name VARCHAR(255),
          is_active BOOLEAN DEFAULT true,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          last_login TIMESTAMPTZ,
          token_version INTEGER NOT NULL DEFAULT 0,
          created_by VARCHAR(100),
          notes TEXT
        )
      `)
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_users_username ON users(username)
      `)
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_users_email ON users(email)
      `)
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_users_is_active ON users(is_active)
      `)
      await client.query(`
        CREATE TABLE IF NOT EXISTS refresh_sessions (
          id BIGSERIAL PRIMARY KEY,
          token_hash CHAR(64) UNIQUE NOT NULL,
          user_id INTEGER NULL REFERENCES users(id) ON DELETE CASCADE,
          username VARCHAR(100) NOT NULL,
          expires_at TIMESTAMPTZ NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          rotated_at TIMESTAMPTZ,
          revoked_at TIMESTAMPTZ,
          replaced_by_hash CHAR(64)
        )
      `)
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_refresh_sessions_active
        ON refresh_sessions(token_hash, expires_at) WHERE revoked_at IS NULL
      `)
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_refresh_sessions_expires_at
        ON refresh_sessions(expires_at)
      `)

      // Notification preferences on users table (idempotent)
      await client.query(`
        DO $$ BEGIN
          IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                         WHERE table_name = 'users' AND column_name = 'receive_match_notifications') THEN
            ALTER TABLE users ADD COLUMN receive_match_notifications BOOLEAN NOT NULL DEFAULT true;
          END IF;
          IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                         WHERE table_name = 'users' AND column_name = 'receive_season_notifications') THEN
            ALTER TABLE users ADD COLUMN receive_season_notifications BOOLEAN NOT NULL DEFAULT true;
          END IF;
        END $$;
      `)

      // ── Site images table (self-service image editor) ──────────────────────
      await client.query(`
        CREATE TABLE IF NOT EXISTS site_images (
          id            SERIAL PRIMARY KEY,
          key           VARCHAR(64) UNIQUE NOT NULL,
          filename      VARCHAR(255) NOT NULL,
          storage_path  VARCHAR(512) NOT NULL,
          content_type  VARCHAR(64) NOT NULL,
          file_size     INTEGER NOT NULL,
          alt_text      VARCHAR(255) DEFAULT '',
          is_active     BOOLEAN DEFAULT true,
          uploaded_by   VARCHAR(255),
          uploaded_at   TIMESTAMPTZ DEFAULT NOW(),
          updated_at    TIMESTAMPTZ DEFAULT NOW()
        )
      `)
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_site_images_key_active ON site_images(key, is_active)
      `)

      // ── Season result columns (idempotent) ─────────────────────────────────
      await client.query(`
        DO $$ BEGIN
          IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                         WHERE table_name = 'seasons' AND column_name = 'final_results') THEN
            ALTER TABLE seasons ADD COLUMN final_results TEXT;
          END IF;
          IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                         WHERE table_name = 'seasons' AND column_name = 'conclusion_image_path') THEN
            ALTER TABLE seasons ADD COLUMN conclusion_image_path VARCHAR(512);
          END IF;
          IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                         WHERE table_name = 'seasons' AND column_name = 'conclusion_image_filename') THEN
            ALTER TABLE seasons ADD COLUMN conclusion_image_filename VARCHAR(255);
          END IF;
          IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                         WHERE table_name = 'seasons' AND column_name = 'conclusion_image_content_type') THEN
            ALTER TABLE seasons ADD COLUMN conclusion_image_content_type VARCHAR(64);
          END IF;
          IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                         WHERE table_name = 'seasons' AND column_name = 'conclusion_image_size') THEN
            ALTER TABLE seasons ADD COLUMN conclusion_image_size INTEGER;
          END IF;
        END $$;
      `)

      // ── Cup tournament tables ───────────────────────────────────────────────
      await client.query(`
        CREATE TABLE IF NOT EXISTS cups (
          id                SERIAL PRIMARY KEY,
          name              VARCHAR(255) NOT NULL,
          season_id         INTEGER REFERENCES seasons(id) ON DELETE SET NULL,
          format            VARCHAR(20) NOT NULL DEFAULT 'single_elimination',
          num_teams         INTEGER NOT NULL DEFAULT 8,
          regulation_text   TEXT,
          status            VARCHAR(20) DEFAULT 'draft',
          start_date        DATE,
          end_date          DATE,
          created_by        VARCHAR(255),
          created_at        TIMESTAMPTZ DEFAULT NOW(),
          updated_at        TIMESTAMPTZ DEFAULT NOW(),
          CONSTRAINT check_cup_format CHECK (format IN ('single_elimination', 'double_elimination', 'round_robin')),
          CONSTRAINT check_cup_status CHECK (status IN ('draft', 'scheduled', 'in_progress', 'completed', 'cancelled'))
        )
      `)
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_cups_season ON cups(season_id)
      `)
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_cups_status ON cups(status)
      `)

      // Cup participants
      await client.query(`
        CREATE TABLE IF NOT EXISTS cup_participants (
          id          SERIAL PRIMARY KEY,
          cup_id      INTEGER NOT NULL REFERENCES cups(id) ON DELETE CASCADE,
          player1_id  INTEGER NOT NULL REFERENCES players(id),
          player2_id  INTEGER REFERENCES players(id),
          team_name   VARCHAR(255),
          seed        INTEGER,
          UNIQUE(cup_id, player1_id, player2_id)
        )
      `)
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_cup_participants_cup ON cup_participants(cup_id)
      `)

      // Cup matches (bracket)
      await client.query(`
        CREATE TABLE IF NOT EXISTS cup_matches (
          id                   SERIAL PRIMARY KEY,
          cup_id               INTEGER NOT NULL REFERENCES cups(id) ON DELETE CASCADE,
          round_number         INTEGER NOT NULL,
          match_number         INTEGER NOT NULL,
          bracket_position     VARCHAR(32),
          team1_participant_id INTEGER REFERENCES cup_participants(id),
          team2_participant_id INTEGER REFERENCES cup_participants(id),
          team1_score          INTEGER,
          team2_score          INTEGER,
          winner_participant_id INTEGER REFERENCES cup_participants(id),
          play_date            DATE,
          status               VARCHAR(20) DEFAULT 'scheduled',
          goal_difference      INTEGER GENERATED ALWAYS AS (COALESCE(team1_score, 0) - COALESCE(team2_score, 0)) STORED,
          created_at           TIMESTAMPTZ DEFAULT NOW(),
          updated_at           TIMESTAMPTZ DEFAULT NOW(),
          CONSTRAINT check_cup_match_status CHECK (status IN ('scheduled', 'in_progress', 'completed', 'forfeited', 'cancelled', 'locked'))
        )
      `)
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_cup_matches_cup ON cup_matches(cup_id)
      `)
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_cup_matches_round ON cup_matches(cup_id, round_number, match_number)
      `)

      // Cup advancements (auto-advance winners)
      await client.query(`
        CREATE TABLE IF NOT EXISTS cup_advancements (
          id              SERIAL PRIMARY KEY,
          from_match_id   INTEGER NOT NULL REFERENCES cup_matches(id) ON DELETE CASCADE,
          to_match_id     INTEGER NOT NULL REFERENCES cup_matches(id) ON DELETE CASCADE,
          winner_slot     VARCHAR(10) NOT NULL,
          UNIQUE(from_match_id, to_match_id, winner_slot)
        )
      `)
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_cup_advancements_from ON cup_advancements(from_match_id)
      `)
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_cup_advancements_to ON cup_advancements(to_match_id)
      `)

      // ── Cup result/image columns (idempotent, auto-create if missing) ──────
      await client.query(`
        DO $$ BEGIN
          IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                         WHERE table_name = 'cups' AND column_name = 'final_results') THEN
            ALTER TABLE cups ADD COLUMN final_results TEXT;
          END IF;
          IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                         WHERE table_name = 'cups' AND column_name = 'conclusion_image_path') THEN
            ALTER TABLE cups ADD COLUMN conclusion_image_path VARCHAR(512);
          END IF;
          IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                         WHERE table_name = 'cups' AND column_name = 'conclusion_image_filename') THEN
            ALTER TABLE cups ADD COLUMN conclusion_image_filename VARCHAR(255);
          END IF;
          IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                         WHERE table_name = 'cups' AND column_name = 'conclusion_image_content_type') THEN
            ALTER TABLE cups ADD COLUMN conclusion_image_content_type VARCHAR(64);
          END IF;
          IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                         WHERE table_name = 'cups' AND column_name = 'conclusion_image_size') THEN
            ALTER TABLE cups ADD COLUMN conclusion_image_size INTEGER;
          END IF;
        END $$;
      `)

      // ── Cup performance indexes ─────────────────────────────────────────────
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_cups_created_at ON cups(created_at DESC)
      `)

      // ── General performance indexes (matches, players, seasons) ─────────────
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_matches_play_date ON matches(play_date DESC)
      `)
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_matches_winning_team ON matches(winning_team)
      `)
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_matches_created_at ON matches(created_at DESC)
      `)
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_seasons_active_start_date ON seasons(is_active DESC, start_date DESC)
      `)
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_season_players_composite ON season_players(season_id, player_id)
      `)

      // Repair the historical constraint only when it lacks the locked state;
      // avoid taking an unnecessary table lock on every application startup.
      await client.query(`
        DO $$ BEGIN
          IF NOT EXISTS (
            SELECT 1 FROM pg_constraint
            WHERE conrelid = 'cup_matches'::regclass
              AND conname = 'check_cup_match_status'
              AND pg_get_constraintdef(oid) LIKE '%locked%'
          ) THEN
            ALTER TABLE cup_matches DROP CONSTRAINT IF EXISTS check_cup_match_status;
            ALTER TABLE cup_matches ADD CONSTRAINT check_cup_match_status
              CHECK (status IN ('scheduled', 'in_progress', 'completed', 'forfeited', 'cancelled', 'locked'));
          END IF;
        END $$;
      `)

      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }


  async createDefaultSeason() {
    const existingSeasons = await this.query('SELECT COUNT(*) as count FROM seasons')
    if (existingSeasons.rows[0].count == 0) { // eslint-disable-line eqeqeq -- null check
      const currentDate = new Date().toISOString().split('T')[0]
      await this.query(`
        INSERT INTO seasons (name, start_date, is_active) 
        VALUES ($1, $2, $3)
      `, ['Mùa giải đầu tiên', currentDate, true])
    }
  }


}
