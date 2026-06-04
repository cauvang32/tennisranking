import './config/env.js' // Loads and validates required environment variables at boot
import DB from './database-postgresql.js'
import { createPushSender } from './lib/push-sender.js'

async function start() {
  console.log('🤖 Starting background FCM worker process...')

  // Initialize PostgreSQL database
  const db = new DB()
  try {
    await db.init()
    console.log('✅ PostgreSQL database connection established')
  } catch (error) {
    console.error('❌ PostgreSQL initialization failed:', error.message)
    process.exit(1)
  }

  // Initialize push sender with workers enabled
  let pushSender
  try {
    pushSender = await createPushSender({ db, runWorkers: true })
    console.log('🚀 FCM worker queue and background worker engines started successfully')
  } catch (error) {
    console.error('❌ FCM push-sender worker initialization failed:', error.message)
    process.exit(1)
  }

  console.log('✨ FCM background worker is listening for jobs in Redis.')

  // Graceful shutdown handling
  const shutdown = async (signal) => {
    console.log(`\nStopping FCM worker gracefully on ${signal}...`)
    try {
      if (pushSender) {
        await pushSender.close()
        console.log('📁 Notification queues closed.')
      }
      await db.close()
      console.log('🗄️ PostgreSQL database connection pool closed.')
      console.log('👋 FCM worker stopped successfully.')
      process.exit(0)
    } catch (err) {
      console.error('⚠️ Error during graceful shutdown:', err.message)
      process.exit(1)
    }
  }

  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))
}

start().catch(err => {
  console.error('❌ Uncaught exception in worker process:', err)
  process.exit(1)
})
