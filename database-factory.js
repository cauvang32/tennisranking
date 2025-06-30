import TennisDatabaseSQLite from './database.js'
import TennisDatabasePostgreSQL from './database-postgresql.js'
import dotenv from 'dotenv'

dotenv.config()

class TennisDatabaseFactory {
  static async create() {
    const dbType = process.env.DB_TYPE || 'sqlite'
    
    if (dbType === 'postgresql') {
      console.log('🐘 Initializing PostgreSQL database...')
      const db = new TennisDatabasePostgreSQL()
      await db.init()
      return db
    } else {
      console.log('🗃️ Initializing SQLite database...')
      const db = new TennisDatabaseSQLite()
      await db.init()
      return db
    }
  }
}

export default TennisDatabaseFactory
