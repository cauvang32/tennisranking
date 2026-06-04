import { Queue, Worker } from 'bullmq'
import config from '../config/env.js'

/**
 * FCM Notification Queue — Fan-Out Architecture for Infinite Scaling
 *
 * Uses BullMQ (Redis-backed) with a two-stage pipeline:
 *
 *   1. DISPATCHER: Receives a single `dispatch` job per notification event.
 *      It paginates through the devices table (keyset pagination, 500 at a time)
 *      and fans out one `send-chunk` job per batch.
 *
 *   2. SENDER: Each `send-chunk` job contains up to 500 FCM tokens.
 *      It calls firebase-admin's sendEachForMulticast and handles errors
 *      (e.g. removing unregistered tokens from the database).
 *
 * This architecture allows horizontal scaling: add more sender workers across
 * machines to handle millions of devices without blocking the API thread.
 */

const QUEUE_DISPATCHER = 'fcm-dispatcher'
const QUEUE_SENDER = 'fcm-sender'
const BATCH_SIZE = 500

/**
 * Parse a Redis URL into BullMQ connection options.
 * BullMQ does NOT accept a URL string — it needs { host, port, password, db }.
 */
function parseRedisUrl(url) {
  try {
    const parsed = new URL(url)
    return {
      host: parsed.hostname || 'localhost',
      port: parseInt(parsed.port) || 6379,
      password: parsed.password || undefined,
      db: parseInt(parsed.pathname?.slice(1)) || 0,
      maxRetriesPerRequest: null // Required by BullMQ to avoid connection recovery bugs
    }
  } catch {
    return { host: 'localhost', port: 6379, maxRetriesPerRequest: null }
  }
}

/**
 * Create and return the notification queue system.
 *
 * @param {object} opts
 * @param {object} opts.db          — database instance (for getDeviceTokensBatch, removeDevicesByTokens)
 * @param {object} opts.messaging   — firebase-admin messaging instance (null if FCM disabled)
 * @param {boolean} opts.runWorkers — whether to start background workers in this process (default: true)
 * @returns {{ enqueueNotification: Function, close: Function }}
 */
export function createNotificationQueue({ db, messaging, runWorkers = true }) {
  const connection = parseRedisUrl(config.redisUrl)

  // ── Queues (producers) ──────────────────────────────────────────────────
  const dispatcherQueue = new Queue(QUEUE_DISPATCHER, { connection })
  const senderQueue = new Queue(QUEUE_SENDER, { connection })

  let dispatcherWorker = null
  let senderWorker = null

  if (runWorkers) {
    // ── Dispatcher Worker ───────────────────────────────────────────────────
    // Receives: { type: 'match'|'season', payload: { data, android, apns } }
    // Fans out: one `send-chunk` job per 500-token batch.
    dispatcherWorker = new Worker(
      QUEUE_DISPATCHER,
      async (job) => {
        const { type, payload } = job.data
        let afterId = 0
        let totalTokens = 0
        let chunks = 0

        // Paginate through all eligible device tokens
        while (true) {
          const batch = await db.getDeviceTokensBatch(type, afterId, BATCH_SIZE)
          if (!batch || batch.length === 0) break

          const tokens = batch.map(d => d.token)
          afterId = batch[batch.length - 1].id
          totalTokens += tokens.length
          chunks++

          // Enqueue a send-chunk job for this batch
          await senderQueue.add('send-chunk', {
            tokens,
            payload
          }, {
            attempts: 3,
            backoff: { type: 'exponential', delay: 2000 },
            removeOnComplete: 100,  // keep last 100 completed jobs for debugging
            removeOnFail: 500       // keep last 500 failed jobs
          })

          // If we got fewer than BATCH_SIZE, we've reached the end
          if (batch.length < BATCH_SIZE) break
        }

        console.log(`📨 FCM dispatcher: type=${type} totalTokens=${totalTokens} chunks=${chunks}`)
        return { totalTokens, chunks }
      },
      {
        connection,
        concurrency: 2,  // process up to 2 dispatch jobs concurrently
        limiter: { max: 10, duration: 1000 }  // max 10 dispatches/sec
      }
    )

    // ── Sender Worker ───────────────────────────────────────────────────────
    // Receives: { tokens: string[], payload: { data, android, apns } }
    // Calls firebase-admin sendEachForMulticast and cleans up invalid tokens.
    senderWorker = new Worker(
      QUEUE_SENDER,
      async (job) => {
        const { tokens, payload } = job.data

        if (!messaging) {
          // FCM disabled — just log and skip
          console.log(`📵 FCM sender: skipped ${tokens.length} tokens (FCM disabled)`)
          return { sent: 0, failed: 0 }
        }

        try {
          const message = {
            tokens,
            ...payload
          }
          const response = await messaging.sendEachForMulticast(message)

          // Collect invalid tokens for cleanup
          const invalidTokens = []
          response.responses.forEach((resp, idx) => {
            if (!resp.success) {
              const code = resp.error?.code
              // These error codes indicate the token is permanently invalid
              if (code === 'messaging/registration-token-not-registered' ||
                  code === 'messaging/invalid-registration-token' ||
                  code === 'messaging/invalid-argument') {
                invalidTokens.push(tokens[idx])
              }
            }
          })

          // Clean up invalid tokens from the database
          if (invalidTokens.length > 0) {
            const removed = await db.removeDevicesByTokens(invalidTokens)
            console.log(`🧹 FCM sender: removed ${removed} invalid token(s)`)
          }

          console.log(`📨 FCM sender: success=${response.successCount} fail=${response.failureCount}`)
          return { sent: response.successCount, failed: response.failureCount }
        } catch (err) {
          console.error(`❌ FCM sender error: ${err.message}`)
          throw err  // BullMQ will retry based on attempts config
        }
      },
      {
        connection,
        concurrency: 5,  // process up to 5 chunks in parallel
        limiter: { max: 20, duration: 1000 }  // max 20 chunks/sec (10,000 tokens/sec)
      }
    )

    // ── Error handlers ──────────────────────────────────────────────────────
    dispatcherWorker.on('failed', (job, err) => {
      console.error(`❌ FCM dispatcher job ${job?.id} failed: ${err.message}`)
    })
    senderWorker.on('failed', (job, err) => {
      console.error(`❌ FCM sender job ${job?.id} failed: ${err.message}`)
    })

    console.log('✅ FCM notification workers started')
  }

  console.log('✅ FCM notification queue initialized (BullMQ)')

  // ── Public API ──────────────────────────────────────────────────────────

  /**
   * Enqueue a notification dispatch. Returns immediately (non-blocking).
   * @param {'match'|'season'} type
   * @param {object} payload — the FCM message body (data, android, apns) — data-only, no notification key
   */
  async function enqueueNotification(type, payload) {
    try {
      await dispatcherQueue.add('dispatch', { type, payload }, {
        attempts: 2,
        backoff: { type: 'exponential', delay: 3000 },
        removeOnComplete: 50,
        removeOnFail: 200
      })
    } catch (err) {
      // Queue failure must never crash the API — just log
      console.error(`❌ Failed to enqueue FCM dispatch: ${err.message}`)
    }
  }

  /**
   * Graceful shutdown — close workers and queues.
   */
  async function close() {
    try {
      if (dispatcherWorker) await dispatcherWorker.close()
      if (senderWorker) await senderWorker.close()
      await dispatcherQueue.close()
      await senderQueue.close()
    } catch { /* ignore */ }
  }

  /**
   * Get queue metrics for the dashboard.
   */
  async function getMetrics() {
    try {
      const [dispatchCounts, senderCounts] = await Promise.all([
        dispatcherQueue.getJobCounts('wait', 'active', 'completed', 'failed', 'paused'),
        senderQueue.getJobCounts('wait', 'active', 'completed', 'failed', 'paused')
      ])
      
      // We check if the queues are currently paused
      const isPaused = await dispatcherQueue.isPaused()

      return {
        isPaused,
        dispatcher: dispatchCounts,
        sender: senderCounts
      }
    } catch (err) {
      console.error(`❌ Failed to get queue metrics: ${err.message}`)
      return null
    }
  }

  /**
   * Globally pause processing.
   */
  async function pauseQueue() {
    await dispatcherQueue.pause()
    await senderQueue.pause()
  }

  /**
   * Globally resume processing.
   */
  async function resumeQueue() {
    await dispatcherQueue.resume()
    await senderQueue.resume()
  }

  return { enqueueNotification, close, getMetrics, pauseQueue, resumeQueue }
}
