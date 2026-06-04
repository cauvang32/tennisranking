import { Router } from 'express'
import { body } from 'express-validator'
import { asyncHandler } from '../utils/async-handler.js'
import config from '../config/env.js'

/**
 * Device registration router for FCM push notifications. See backend.md §1.1 / §3.
 *
 * POST /api/devices/register — upsert an FCM token for the current user (or
 * guest). Auth is optional (checkAuth): a logged-in user's id is attached when
 * present, otherwise user_id is null. CSRF is enforced by the global
 * globalCSRFProtection middleware (non-GET), and the client sends X-CSRF-Token.
 */
export const createDeviceRouter = ({
  db,
  checkAuth,
  conditionalRateLimit,
  deviceRegisterLimiter,
  handleValidationErrors
}) => {
  const router = Router()

  router.post(
    '/register',
    checkAuth,
    conditionalRateLimit(deviceRegisterLimiter),
    [
      body('token').isString().trim().isLength({ min: 10, max: 4096 })
        .withMessage('Token is required'),
      body('platform').isString().customSanitizer(v => String(v).toLowerCase())
        .isIn(['android', 'ios']).withMessage('Invalid platform'),
      body('appVersion').optional({ nullable: true }).isString().isLength({ max: 32 })
    ],
    handleValidationErrors,
    asyncHandler(async (req, res) => {
      const { token, platform, appVersion = null } = req.body
      const userId = req.user?.id ?? null
      const registeredIp = req.ip

      // Bloat prevention (FCM manage-tokens guidance + per-IP cap for guests).
      // Logged-in users are capped at maxDevicesPerUser. Guests (no auth) are
      // capped at maxGuestDevicesPerIp because they have no user_id to scope
      // the limit to. The 30-day retention sweep is the long-term backstop.
      if (userId !== null) {
        const count = await db.countDevicesByUserId(userId)
        if (count >= config.fcm.maxDevicesPerUser) {
          return res.status(429).json({
            success: false,
            error: `Device limit reached (${count}/${config.fcm.maxDevicesPerUser}). Remove an old device or wait for stale tokens to be reaped.`
          })
        }
      } else if (registeredIp) {
        const count = await db.countGuestDevicesByIp(registeredIp)
        if (count >= config.fcm.maxGuestDevicesPerIp) {
          return res.status(429).json({
            success: false,
            error: `Guest device limit reached for this IP (${count}/${config.fcm.maxGuestDevicesPerIp}). Please sign in or wait for stale tokens to be reaped.`
          })
        }
      }

      await db.upsertDevice(userId, token, platform, appVersion, registeredIp)
      res.json({ success: true, message: 'Device registered' })
    })
  )

  return router
}
