import fs from 'fs'
import config from '../config/env.js'
import { createNotificationQueue } from './notification-queue.js'

/**
 * FCM push sender. Sends topic-based notifications for new matches/seasons.
 * See backend.md §1.2 (payload), §4 (SDK setup), §5 (wiring).
 *
 * Now uses BullMQ fan-out architecture: sendMatch/sendSeason instantly enqueue
 * a dispatch job and return — the actual Firebase calls happen asynchronously
 * in background workers. If FCM is not configured, everything degrades to
 * logged no-ops so the server boots without Firebase (local dev, CI).
 * Never logs the FCM token (§7.5).
 */

const MATCH_TITLE = '⚽ Kết Quả Trận Đấu Mới!'
const SEASON_TITLE = '📅 Giải Đấu Mới Khởi Tranh!'

// Build the human-readable body from a match row (see getMatchById columns).
// Duo: "P1 & P2 vs P3 & P4 (s1 - s2)"  Solo: "P1 vs P3 (s1 - s2)"
function buildMatchBody(match) {
  const isSolo = (match.match_type || 'duo') === 'solo'
  const team1 = isSolo
    ? match.player1_name
    : [match.player1_name, match.player2_name].filter(Boolean).join(' & ')
  const team2 = isSolo
    ? match.player3_name
    : [match.player3_name, match.player4_name].filter(Boolean).join(' & ')
  return `${team1} vs ${team2} (${match.team1_score} - ${match.team2_score})`
}

function buildSeasonBody(season) {
  return season?.name ? String(season.name) : 'Giải đấu mới'
}

/**
 * Build the FCM payload shape (Data-Only Message).
 *
 * No `notification` key at root, no `android.notification`, no `apns.aps.alert`.
 * This prevents the OS from auto-drawing a system notification on both Android
 * and iOS — the Flutter app's background handler is the sole renderer, which
 * eliminates the duplicate-notification bug.
 *
 * Firebase requires every value inside `data` to be a string.
 */
function buildPayload({ type, id, title, body }) {
  return {
    data: {
      type: String(type),
      id: String(id),
      title: String(title),
      body: String(body)
    },
    android: {
      priority: 'high'
    },
    apns: {
      headers: {
        'apns-priority': '5',
        'apns-push-type': 'background'
      },
      payload: {
        aps: {
          'content-available': 1   // wake Flutter background handler
        }
      }
    }
  }
}

/**
 * Create the push sender. Initializes firebase-admin lazily/once and sets up
 * the BullMQ notification queue. If the service account isn't configured or
 * fails to load, returns a sender that enqueues jobs but the workers will
 * skip actual Firebase calls (graceful degradation).
 *
 * @param {object} opts
 * @param {object} opts.db — database instance (required for device token queries)
 */
export async function createPushSender({ db, runWorkers = process.env.RUN_WORKERS !== 'false' } = {}) {
  const path = config.firebase.serviceAccountPath

  const noop = {
    enabled: false,
    async sendMatch() {},
    async sendSeason() {},
    async close() {}
  }

  // If no db is provided, we can't query device tokens — degrade to noop
  if (!db) {
    console.log('📵 FCM disabled: no database instance provided (push notifications are no-ops)')
    return noop
  }

  let messaging = null

  if (!path) {
    console.log('📵 FCM path not set — OK if using a separate tennis-worker container for Firebase sends. Queue will enqueue jobs normally.')
  } else if (!fs.existsSync(path)) {
    console.warn(`📵 FCM service account file not found at ${path}. Queue will run, but Firebase sends will be skipped.`)
  } else {
    try {
      // In ESM, `await import(...)` returns the module namespace, not the
      // default export. firebase-admin's surface is the default export, so we
      // need .default — without it, `admin.apps` is undefined and `.length` throws.
      const admin = (await import('firebase-admin')).default
      const serviceAccount = JSON.parse(fs.readFileSync(path, 'utf8'))
      // Guard against double-init (multiple PM2 instances / hot reload).
      const app = admin.apps.length
        ? admin.apps[0]
        : admin.initializeApp({ credential: admin.credential.cert(serviceAccount) })
      messaging = admin.messaging(app)
      console.log('✅ FCM initialized (firebase-admin)')
    } catch (err) {
      console.error('📵 FCM init failed. Queue will run, but Firebase sends will be skipped:', err.message)
      // messaging stays null — the queue workers will skip actual sends
    }
  }

  // Initialize the BullMQ notification queue with the db and messaging instances
  const queue = createNotificationQueue({ db, messaging, runWorkers })

  return {
    enabled: true,
    async sendMatch(match) {
      const body = buildMatchBody(match)
      const payload = buildPayload({
        type: 'match',
        id: match.id,
        title: MATCH_TITLE,
        body
      })
      await queue.enqueueNotification('match', payload)
    },
    async sendSeason(season) {
      const body = buildSeasonBody(season)
      const payload = buildPayload({
        type: 'season',
        id: season.id,
        title: SEASON_TITLE,
        body
      })
      await queue.enqueueNotification('season', payload)
    },
    async sendCustom(title, body) {
      const payload = buildPayload({
        type: 'custom',
        id: Date.now(),
        title,
        body
      })
      // We use 'custom' type which gets resolved in database-postgresql to send to all active users
      await queue.enqueueNotification('custom', payload)
    },
    async getStatus() {
      if (!queue.getMetrics) return null
      return await queue.getMetrics()
    },
    async pause() {
      if (queue.pauseQueue) await queue.pauseQueue()
    },
    async resume() {
      if (queue.resumeQueue) await queue.resumeQueue()
    },
    async close() {
      await queue.close()
    }
  }
}
