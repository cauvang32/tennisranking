import fs from 'fs'
import config from '../config/env.js'

/**
 * FCM push sender. Sends topic-based notifications for new matches/seasons.
 * See backend.md §1.2 (payload), §4 (SDK setup), §5 (wiring).
 *
 * Degrades gracefully: if FIREBASE_SERVICE_ACCOUNT_PATH is unset or the file
 * is missing, sendMatch/sendSeason become logged no-ops so the server boots
 * without Firebase configured (local dev, CI). Never logs the FCM token (§7.5).
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
 * Create the push sender. Initializes firebase-admin lazily/once. If the
 * service account isn't configured or fails to load, returns a no-op sender.
 */
export async function createPushSender() {
  const path = config.firebase.serviceAccountPath

  const noop = {
    enabled: false,
    async sendMatch() {},
    async sendSeason() {}
  }

  if (!path) {
    console.log('📵 FCM disabled: FIREBASE_SERVICE_ACCOUNT_PATH not set (push notifications are no-ops)')
    return noop
  }
  if (!fs.existsSync(path)) {
    console.warn(`📵 FCM disabled: service account file not found at ${path} (push notifications are no-ops)`)
    return noop
  }

  let messaging
  try {
    const admin = await import('firebase-admin')
    const serviceAccount = JSON.parse(fs.readFileSync(path, 'utf8'))
    // Guard against double-init (multiple PM2 instances / hot reload).
    const app = admin.apps.length
      ? admin.apps[0]
      : admin.initializeApp({ credential: admin.credential.cert(serviceAccount) })
    messaging = admin.messaging(app)
    console.log('✅ FCM initialized (firebase-admin)')
  } catch (err) {
    console.error('📵 FCM init failed, push notifications disabled:', err.message)
    return noop
  }

  // Build + send the exact payload shape from backend.md §1.2.
  // aps.alert is set explicitly because FCM v1 does NOT merge the top-level
  // `notification` into aps.alert when apns.payload is provided — verified
  // against firebase-admin v13 (messaging-api-request-internal.js is a pure
  // HTTP passthrough, no client-side merging). Without aps.alert, iOS shows
  // badge+sound but no visible text.
  // aps.badge is OMITTED: hardcoding 1 would overwrite the user's actual
  // unread counter on every push. Omitting lets iOS keep its current count.
  async function send({ topic, type, id, title, body, channelId, clickAction }) {
    const message = {
      topic,
      notification: { title, body },
      data: { type, id: String(id), title, body },
      android: {
        priority: 'high',
        notification: { channelId, clickAction }
      },
      apns: {
        headers: { 'apns-priority': '10' },
        payload: {
          aps: {
            alert: { title, body },
            sound: 'default',
            'mutable-content': 1
          },
          type,
          id: String(id)
        }
      }
    }
    try {
      const resp = await messaging.send(message)
      // Never log the token (topic sends don't carry one anyway). §7.1
      console.log(`📨 FCM sent topic=${topic} type=${type} id=${id} resp=${resp}`)
    } catch (err) {
      // INVALID_ARGUMENT / UNREGISTERED on a brand-new topic with no subscribers
      // is normal — log and swallow so it never affects the API response. §4.4
      console.warn(`⚠️ FCM send failed topic=${topic} id=${id} code=${err.errorInfo?.code || err.code || 'unknown'}`)
    }
  }

  return {
    enabled: true,
    async sendMatch(match) {
      await send({
        topic: 'all_matches',
        type: 'match',
        id: match.id,
        title: MATCH_TITLE,
        body: buildMatchBody(match),
        channelId: 'tennis_match_channel',
        clickAction: 'OPEN_MATCH'
      })
    },
    async sendSeason(season) {
      await send({
        topic: 'all_seasons',
        type: 'season',
        id: season.id,
        title: SEASON_TITLE,
        body: buildSeasonBody(season),
        channelId: 'tennis_season_channel',
        clickAction: 'OPEN_SEASON'
      })
    }
  }
}

