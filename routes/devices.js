import { Router } from 'express'
import { body } from 'express-validator'
import { asyncHandler } from '../utils/async-handler.js'

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
      body('token').isString().trim().isLength({ min: 1, max: 4096 })
        .withMessage('Token is required'),
      body('platform').isString().customSanitizer(v => String(v).toLowerCase())
        .isIn(['android', 'ios']).withMessage('Invalid platform'),
      body('appVersion').optional({ nullable: true }).isString().isLength({ max: 32 })
    ],
    handleValidationErrors,
    asyncHandler(async (req, res) => {
      const { token, platform, appVersion = null } = req.body
      const userId = req.user?.id ?? null
      await db.upsertDevice(userId, token, platform, appVersion)
      res.json({ success: true, message: 'Device registered' })
    })
  )

  return router
}
