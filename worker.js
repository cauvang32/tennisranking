import './config/env.js' // Loads and validates required environment variables at boot
import http from 'http'
import DB from './database-postgresql.js'
import { createPushSender } from './lib/push-sender.js'

// ── Lightweight health check server (for Docker HEALTHCHECK) ────────────────
// Separate from the main app so the worker has its own health probe.
// Checks: process alive, DB reachable, Redis reachable (via pushSender).
const healthServer = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({
      status: 'healthy',
      db: db?.pool ? 'connected' : 'disconnected',
      fcm: pushSender?.enabled ? 'active' : 'disabled',
      uptime: process.uptime()
    }))
  } else {
    res.writeHead(404)
    res.end()
  }
})

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

  // Start health check server on port 3002 (for Docker HEALTHCHECK)
  // Bound to 0.0.0.0 so Docker's healthcheck (which runs inside the container)
  // can reach it. Also reachable from the Docker network for compose healthchecks.
  const healthPort = 3002
  healthServer.listen(healthPort, '0.0.0.0', () => {
    console.log(`🩺 Worker health check listening on 0.0.0.0:${healthPort}`)
  })

  // Graceful shutdown handling
  const shutdown = async (signal) => {
    console.log(`\nStopping FCM worker gracefully on ${signal}...`)
    try {
      healthServer.close()
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
