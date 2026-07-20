import { Router, json as expressJson } from 'express'
import multer from 'multer'
import { body, param, query } from 'express-validator'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import fs from 'fs'
import fsPromises from 'fs/promises'
import config from '../config/env.js'
import { asyncHandler } from '../utils/async-handler.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

// Upload directory
const UPLOAD_DIR = join(__dirname, '..', 'data', 'uploads', 'images')
const SEASON_UPLOAD_DIR = join(__dirname, '..', 'data', 'uploads', 'seasons')

// Ensure upload directories exist
for (const dir of [UPLOAD_DIR, SEASON_UPLOAD_DIR]) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
}

// Multer config for image uploads
const imageStorage = multer.diskStorage({
  destination: (req, _file, cb) => {
    // Support season-specific uploads via query or body
    const seasonId = req.body?.seasonId || req.query?.seasonId
    if (seasonId) {
      const seasonDir = join(SEASON_UPLOAD_DIR, String(seasonId))
      if (!fs.existsSync(seasonDir)) fs.mkdirSync(seasonDir, { recursive: true })
      cb(null, seasonDir)
    } else {
      cb(null, UPLOAD_DIR)
    }
  },
  filename: (req, file, cb) => {
    // Sanitize filename: keep extension, use timestamp + random prefix
    const ext = file.mimetype.split('/')[1] || 'png'
    const prefix = `${Date.now()}-${Math.random().toString(36).substring(2, 8)}`
    cb(null, `${prefix}.${ext}`)
  }
})

const imageUpload = multer({
  storage: imageStorage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB max
  fileFilter: (_req, file, cb) => {
    // SECURITY (S1): SVG removed — SVG files can contain embedded <script> tags
    // or event handlers (onload/onerror) that execute in the browser context of
    // the serving domain. This is a stored XSS vector. OWASP 2026 Top 10 A05.
    // Only allow raster image formats that cannot contain executable content.
    const allowed = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']
    if (allowed.includes(file.mimetype)) {
      cb(null, true)
    } else {
      cb(new Error('Invalid image type. Only PNG, JPEG, WebP, GIF allowed.'))
    }
  }
})

// Allowed image keys for site_images
const IMAGE_KEYS = ['hero_banner', 'logo', 'favicon', 'background']

export const createImageRouter = ({
  db,
  checkAuth,
  authenticateToken,
  requireAdmin,
  conditionalRateLimit,
  createLimiter,
  deleteLimiter,
  handleValidationErrors,
  rankingsCache,
  sanitizeResponse,
}) => {
  const router = Router()

  // ── GET /api/images — List all active site images ──
  router.get('/', checkAuth, asyncHandler(async (req, res) => {
    const cacheKey = 'site-images'
    const { data: images, hit: cacheHit } = await rankingsCache.getOrSet(
      cacheKey,
      () => db.getSiteImages()
    )
    if (!config.isProduction) res.set('Redis-Cache', cacheHit ? 'HIT' : 'MISS')
    res.json(sanitizeResponse(images))
  }))

  // ── GET /api/images/:key — Get single image metadata ──
  router.get('/:key', checkAuth, [
    param('key').isIn(IMAGE_KEYS).withMessage('Invalid image key')
  ], handleValidationErrors, asyncHandler(async (req, res) => {
    const { key } = req.params
    const image = await db.getSiteImageByKey(key)
    if (!image) {
      res.status(404).json({ error: `Image "${key}" not found` })
      return
    }
    res.json(sanitizeResponse(image))
  }))

  // ── GET /api/images/:key/file — Serve the actual image file ──
  router.get('/:key/file', checkAuth, [
    param('key').isIn(IMAGE_KEYS).withMessage('Invalid image key')
  ], handleValidationErrors, asyncHandler(async (req, res) => {
    const { key } = req.params
    const image = await db.getSiteImageByKey(key)
    if (!image || !image.storage_path) {
      // Fallback: serve the default image.png for hero_banner
      if (key === 'hero_banner') {
        res.sendFile(join(__dirname, '..', 'public', 'image.png'))
      } else {
        res.status(404).json({ error: `Image "${key}" not available` })
      }
      return
    }
    const filePath = join(__dirname, '..', image.storage_path)
    if (!fs.existsSync(filePath)) {
      // Fallback for hero_banner
      if (key === 'hero_banner') {
        res.sendFile(join(__dirname, '..', 'public', 'image.png'))
      } else {
        res.status(404).json({ error: `Image file not found on disk` })
      }
      return
    }
    res.set({
      'Content-Type': image.content_type || 'image/png',
      'Cache-Control': 'public, max-age=31536000, immutable',
      'X-Content-Type-Options': 'nosniff'
    })
    res.sendFile(filePath)
  }))

  // ── POST /api/images/:key — Upload/replace image ──
  router.post(
    '/:key',
    authenticateToken,
    requireAdmin,
    conditionalRateLimit(createLimiter),
    [param('key').isIn(IMAGE_KEYS).withMessage('Invalid image key')],
    handleValidationErrors,
    imageUpload.single('image'),
    asyncHandler(async (req, res) => {
      const { key } = req.params

      if (!req.file) {
        res.status(400).json({ error: 'No image file provided' })
        return
      }

      const { altText = '' } = req.body || {}

      // Delete old file if replacing (P6: async to avoid blocking event loop)
      const existing = await db.getSiteImageByKey(key)
      if (existing && existing.storage_path) {
        const oldPath = join(__dirname, '..', existing.storage_path)
        try { await fsPromises.unlink(oldPath) } catch { /* file may already be gone */ }
      }

      const storagePath = req.file.path.replace(
        join(__dirname, '..'), ''
      ).replace(/\\/g, '/') // Normalize for Windows

      await db.upsertSiteImage({
        key,
        filename: req.file.originalname,
        storage_path: storagePath,
        content_type: req.file.mimetype,
        file_size: req.file.size,
        alt_text: altText,
        uploaded_by: req.user?.username || 'admin'
      })

      await rankingsCache.invalidateOnImageChange()
      res.json({
        success: true,
        message: `Image "${key}" updated successfully`,
        url: `/api/images/${key}/file`
      })
    })
  )

  // ── PUT /api/images/:key/meta — Update metadata (alt_text, is_active) ──
  router.put(
    '/:key/meta',
    authenticateToken,
    requireAdmin,
    [
      param('key').isIn(IMAGE_KEYS).withMessage('Invalid image key'),
      body('altText').optional().isString().isLength({ max: 255 }).withMessage('Alt text too long'),
      body('isActive').optional().isBoolean().withMessage('isActive must be boolean')
    ],
    handleValidationErrors,
    asyncHandler(async (req, res) => {
      const { key } = req.params
      const { altText, isActive } = req.body

      const image = await db.getSiteImageByKey(key)
      if (!image) {
        res.status(404).json({ error: `Image "${key}" not found` })
        return
      }

      await db.updateSiteImageMeta(key, { altText, isActive })
      await rankingsCache.invalidateOnImageChange()
      res.json({ success: true, message: `Image "${key}" metadata updated` })
    })
  )

  // ── DELETE /api/images/:key — Remove site image ──
  router.delete(
    '/:key',
    authenticateToken,
    requireAdmin,
    conditionalRateLimit(deleteLimiter),
    [param('key').isIn(IMAGE_KEYS).withMessage('Invalid image key')],
    handleValidationErrors,
    asyncHandler(async (req, res) => {
      const { key } = req.params
      const image = await db.getSiteImageByKey(key)
      if (!image) {
        res.status(404).json({ error: `Image "${key}" not found` })
        return
      }
      // Delete old file (P6: async to avoid blocking event loop)
      if (image.storage_path) {
        const oldPath = join(__dirname, '..', image.storage_path)
        try { await fsPromises.unlink(oldPath) } catch { /* file may already be gone */ }
      }
      // Set is_active to false AND clear storage_path so the placeholder is shown
      await db.query(`UPDATE site_images SET is_active = false, storage_path = NULL, updated_at = NOW() WHERE key = $1`, [key])
      // Invalidate cache — wrapped so SSE listener errors don't 500 the response
      try { await rankingsCache.invalidateOnImageChange() } catch (err) {
        console.error('Cache invalidation failed after image delete:', err.message)
      }
      res.json({ success: true, message: `Image "${key}" removed` })
    })
  )

  // ── POST /api/images/season/:seasonId/conclusion — Upload season conclusion image ──
  router.post(
    '/season/:seasonId/conclusion',
    authenticateToken,
    requireAdmin,
    imageUpload.single('image'),
    asyncHandler(async (req, res) => {
      const seasonId = parseInt(req.params.seasonId)

      if (!req.file) {
        res.status(400).json({ error: 'No image file provided' })
        return
      }

      const storagePath = req.file.path.replace(
        join(__dirname, '..'), ''
      ).replace(/\\/g, '/')

      await db.uploadSeasonConclusionImage(seasonId, {
        filename: req.file.originalname,
        storage_path: storagePath,
        content_type: req.file.mimetype,
        file_size: req.file.size
      })

      await rankingsCache.invalidateOnSeasonChange()
      res.json({
        success: true,
        message: 'Conclusion image uploaded successfully',
        url: `/api/images/season/${seasonId}/conclusion/file`
      })
    })
  )

  // ── GET /api/images/season/:seasonId/conclusion/file — Serve season conclusion image ──
  router.get(
    '/season/:seasonId/conclusion/file',
    checkAuth,
    [param('seasonId').isInt({ min: 1 }).withMessage('Invalid season ID')],
    handleValidationErrors,
    asyncHandler(async (req, res) => {
      const seasonId = parseInt(req.params.seasonId)
      const season = await db.getSeasonById(seasonId)
      if (!season || !season.conclusion_image_path) {
        res.status(404).json({ error: 'Conclusion image not found' })
        return
      }

      const filePath = join(__dirname, '..', season.conclusion_image_path)
      if (!fs.existsSync(filePath)) {
        res.status(404).json({ error: 'Image file not found on disk' })
        return
      }

      res.set({
        'Content-Type': season.conclusion_image_content_type || 'image/png',
        'Cache-Control': 'public, max-age=31536000, immutable',
        'X-Content-Type-Options': 'nosniff'
      })
      res.sendFile(filePath)
    })
  )

  // ── DELETE /api/images/season/:seasonId/conclusion — Remove season conclusion image ──
  router.delete(
    '/season/:seasonId/conclusion',
    authenticateToken,
    requireAdmin,
    conditionalRateLimit(deleteLimiter),
    [param('seasonId').isInt({ min: 1 }).withMessage('Invalid season ID')],
    handleValidationErrors,
    asyncHandler(async (req, res) => {
      const seasonId = parseInt(req.params.seasonId)
      const season = await db.getSeasonById(seasonId)

      if (!season) {
        res.status(404).json({ error: 'Season not found' })
        return
      }

      // Delete old file (P6: async to avoid blocking event loop)
      if (season.conclusion_image_path) {
        const oldPath = join(__dirname, '..', season.conclusion_image_path)
        try { await fsPromises.unlink(oldPath) } catch { /* file may already be gone */ }
      }

      await db.deleteSeasonConclusionImage(seasonId)
      await rankingsCache.invalidateOnSeasonChange()
      res.json({ success: true, message: 'Conclusion image removed' })
    })
  )

  // ── POST /api/images/migrate-hero — One-time migration: copy public/image.png ──
  router.post(
    '/migrate-hero',
    authenticateToken,
    requireAdmin,
    asyncHandler(async (req, res) => {
      const srcPath = join(__dirname, '..', 'public', 'image.png')
      if (!fs.existsSync(srcPath)) {
        res.status(404).json({ error: 'Source image.png not found' })
        return
      }

      // Copy to uploads directory
      const destPath = join(UPLOAD_DIR, 'hero-banner-migrated.png')
      fs.copyFileSync(srcPath, destPath)

      const stat = fs.statSync(destPath)
      const storagePath = destPath.replace(join(__dirname, '..'), '').replace(/\\/g, '/')

      await db.upsertSiteImage({
        key: 'hero_banner',
        filename: 'image.png',
        storage_path: storagePath,
        content_type: 'image/png',
        file_size: stat.size,
        alt_text: 'Banner trang chủ',
        uploaded_by: req.user?.username || 'admin'
      })

      await rankingsCache.invalidateOnImageChange()
      res.json({
        success: true,
        message: 'Hero banner migrated from public/image.png'
      })
    })
  )

  return router
}
