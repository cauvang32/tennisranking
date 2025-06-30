#!/usr/bin/env node
import sqlite3 from 'sqlite3'
import { open } from 'sqlite'
import pg from 'pg'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import dotenv from 'dotenv'

// Load environment variables
dotenv.config()

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const { Pool } = pg

class DatabaseMigrator {
  constructor() {
    this.sqliteDb = null
    this.pgPool = null
    this.sqlitePath = join(__dirname, 'data', 'tennis.db')
    
    this.pgConfig = {
      host: process.env.DB_HOST || 'localhost',
      port: parseInt(process.env.DB_PORT) || 5432,
      database: process.env.DB_NAME || 'tennis_ranking',
      user: process.env.DB_USER || 'tennis_user',
      password: process.env.DB_PASSWORD || 'tennis_password',
    }
  }

  async initConnections() {
    try {
      console.log('🔌 Connecting to SQLite database...')
      this.sqliteDb = await open({
        filename: this.sqlitePath,
        driver: sqlite3.Database
      })
      console.log('✅ SQLite connection established')

      console.log('🔌 Connecting to PostgreSQL database...')
      this.pgPool = new Pool(this.pgConfig)
      
      // Test PostgreSQL connection
      const client = await this.pgPool.connect()
      console.log('✅ PostgreSQL connection established')
      client.release()

    } catch (error) {
      console.error('❌ Database connection failed:', error.message)
      throw error
    }
  }

  async createPostgreSQLTables() {
    console.log('🏗️ Creating PostgreSQL tables...')
    
    const client = await this.pgPool.connect()
    
    try {
      await client.query('BEGIN')

      // Drop existing tables if they exist (for clean migration)
      await client.query('DROP TABLE IF EXISTS matches CASCADE')
      await client.query('DROP TABLE IF EXISTS seasons CASCADE')
      await client.query('DROP TABLE IF EXISTS players CASCADE')

      // Players table
      await client.query(`
        CREATE TABLE players (
          id SERIAL PRIMARY KEY,
          name VARCHAR(255) UNIQUE NOT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `)

      // Seasons table
      await client.query(`
        CREATE TABLE seasons (
          id SERIAL PRIMARY KEY,
          name VARCHAR(255) NOT NULL,
          start_date DATE NOT NULL,
          end_date DATE,
          is_active BOOLEAN DEFAULT true,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `)

      // Matches table
      await client.query(`
        CREATE TABLE matches (
          id SERIAL PRIMARY KEY,
          season_id INTEGER NOT NULL REFERENCES seasons(id),
          play_date DATE NOT NULL,
          player1_id INTEGER NOT NULL REFERENCES players(id),
          player2_id INTEGER NOT NULL REFERENCES players(id),
          player3_id INTEGER NOT NULL REFERENCES players(id),
          player4_id INTEGER NOT NULL REFERENCES players(id),
          team1_score INTEGER NOT NULL,
          team2_score INTEGER NOT NULL,
          winning_team INTEGER NOT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `)

      // Create indexes for better performance
      await client.query('CREATE INDEX idx_matches_play_date ON matches(play_date)')
      await client.query('CREATE INDEX idx_matches_season_id ON matches(season_id)')
      await client.query('CREATE INDEX idx_seasons_active ON seasons(is_active)')

      await client.query('COMMIT')
      console.log('✅ PostgreSQL tables created successfully')
    } catch (error) {
      await client.query('ROLLBACK')
      console.error('❌ Failed to create PostgreSQL tables:', error.message)
      throw error
    } finally {
      client.release()
    }
  }

  async migratePlayers() {
    console.log('👥 Migrating players...')
    
    // Get all players from SQLite
    const players = await this.sqliteDb.all('SELECT * FROM players ORDER BY id')
    console.log(`📊 Found ${players.length} players in SQLite`)

    const client = await this.pgPool.connect()
    
    try {
      await client.query('BEGIN')

      for (const player of players) {
        await client.query(
          'INSERT INTO players (id, name, created_at) VALUES ($1, $2, $3)',
          [player.id, player.name, player.created_at]
        )
      }

      // Update the sequence to continue from the last ID
      if (players.length > 0) {
        const maxId = Math.max(...players.map(p => p.id))
        await client.query(`SELECT setval('players_id_seq', $1)`, [maxId])
      }

      await client.query('COMMIT')
      console.log(`✅ Successfully migrated ${players.length} players`)
    } catch (error) {
      await client.query('ROLLBACK')
      console.error('❌ Failed to migrate players:', error.message)
      throw error
    } finally {
      client.release()
    }
  }

  async migrateSeasons() {
    console.log('🏆 Migrating seasons...')
    
    // Get all seasons from SQLite
    const seasons = await this.sqliteDb.all('SELECT * FROM seasons ORDER BY id')
    console.log(`📊 Found ${seasons.length} seasons in SQLite`)

    const client = await this.pgPool.connect()
    
    try {
      await client.query('BEGIN')

      for (const season of seasons) {
        await client.query(
          'INSERT INTO seasons (id, name, start_date, end_date, is_active, created_at) VALUES ($1, $2, $3, $4, $5, $6)',
          [season.id, season.name, season.start_date, season.end_date, season.is_active, season.created_at]
        )
      }

      // Update the sequence to continue from the last ID
      if (seasons.length > 0) {
        const maxId = Math.max(...seasons.map(s => s.id))
        await client.query(`SELECT setval('seasons_id_seq', $1)`, [maxId])
      }

      await client.query('COMMIT')
      console.log(`✅ Successfully migrated ${seasons.length} seasons`)
    } catch (error) {
      await client.query('ROLLBACK')
      console.error('❌ Failed to migrate seasons:', error.message)
      throw error
    } finally {
      client.release()
    }
  }

  async migrateMatches() {
    console.log('🎾 Migrating matches...')
    
    // Get all matches from SQLite
    const matches = await this.sqliteDb.all('SELECT * FROM matches ORDER BY id')
    console.log(`📊 Found ${matches.length} matches in SQLite`)

    const client = await this.pgPool.connect()
    
    try {
      await client.query('BEGIN')

      for (const match of matches) {
        await client.query(
          `INSERT INTO matches (id, season_id, play_date, player1_id, player2_id, 
           player3_id, player4_id, team1_score, team2_score, winning_team, created_at) 
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
          [
            match.id,
            match.season_id,
            match.play_date,
            match.player1_id,
            match.player2_id,
            match.player3_id,
            match.player4_id,
            match.team1_score,
            match.team2_score,
            match.winning_team,
            match.created_at
          ]
        )
      }

      // Update the sequence to continue from the last ID
      if (matches.length > 0) {
        const maxId = Math.max(...matches.map(m => m.id))
        await client.query(`SELECT setval('matches_id_seq', $1)`, [maxId])
      }

      await client.query('COMMIT')
      console.log(`✅ Successfully migrated ${matches.length} matches`)
    } catch (error) {
      await client.query('ROLLBACK')
      console.error('❌ Failed to migrate matches:', error.message)
      throw error
    } finally {
      client.release()
    }
  }

  async verifyMigration() {
    console.log('🔍 Verifying migration...')
    
    const client = await this.pgPool.connect()
    
    try {
      // Count records in PostgreSQL
      const playersCount = await client.query('SELECT COUNT(*) FROM players')
      const seasonsCount = await client.query('SELECT COUNT(*) FROM seasons')
      const matchesCount = await client.query('SELECT COUNT(*) FROM matches')

      // Count records in SQLite
      const sqlitePlayersCount = await this.sqliteDb.get('SELECT COUNT(*) as count FROM players')
      const sqliteSeasonsCount = await this.sqliteDb.get('SELECT COUNT(*) as count FROM seasons')
      const sqliteMatchesCount = await this.sqliteDb.get('SELECT COUNT(*) as count FROM matches')

      console.log('\n📊 Migration Verification:')
      console.log(`Players: SQLite=${sqlitePlayersCount.count} → PostgreSQL=${playersCount.rows[0].count}`)
      console.log(`Seasons: SQLite=${sqliteSeasonsCount.count} → PostgreSQL=${seasonsCount.rows[0].count}`)
      console.log(`Matches: SQLite=${sqliteMatchesCount.count} → PostgreSQL=${matchesCount.rows[0].count}`)

      const playersMatch = sqlitePlayersCount.count == playersCount.rows[0].count
      const seasonsMatch = sqliteSeasonsCount.count == seasonsCount.rows[0].count
      const matchesMatch = sqliteMatchesCount.count == matchesCount.rows[0].count

      if (playersMatch && seasonsMatch && matchesMatch) {
        console.log('✅ Migration verification successful - all data migrated correctly!')
        return true
      } else {
        console.log('❌ Migration verification failed - data counts do not match!')
        return false
      }
    } catch (error) {
      console.error('❌ Migration verification failed:', error.message)
      return false
    } finally {
      client.release()
    }
  }

  async close() {
    if (this.sqliteDb) {
      await this.sqliteDb.close()
    }
    if (this.pgPool) {
      await this.pgPool.end()
    }
  }

  async migrate() {
    try {
      console.log('🚀 Starting database migration from SQLite to PostgreSQL...\n')
      
      await this.initConnections()
      await this.createPostgreSQLTables()
      await this.migratePlayers()
      await this.migrateSeasons()
      await this.migrateMatches()
      
      const verificationPassed = await this.verifyMigration()
      
      if (verificationPassed) {
        console.log('\n🎉 Database migration completed successfully!')
        console.log('🔄 You can now switch your application to use PostgreSQL')
        console.log('💾 The original SQLite database has been preserved in ./data/tennis.db')
      } else {
        console.log('\n❌ Migration completed with errors. Please check the data manually.')
      }
      
    } catch (error) {
      console.error('\n💥 Migration failed:', error.message)
      process.exit(1)
    } finally {
      await this.close()
    }
  }
}

// Run migration if this file is executed directly
if (process.argv[1] === __filename) {
  const migrator = new DatabaseMigrator()
  migrator.migrate()
}

export default DatabaseMigrator
