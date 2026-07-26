import { Router } from 'express'
import multer from 'multer'
import { body, param } from 'express-validator'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import fs from 'fs'
import fsPromises from 'fs/promises'
import config from '../config/env.js'
import { asyncHandler } from '../utils/async-handler.js'
import {
  createUploadFilename,
  ensureUploadDirectory,
  resolveUploadPath,
  toStoredUploadPath,
  validateUploadedImage
} from '../lib/upload-storage.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

// Upload directory
const UPLOAD_DIR = await ensureUploadDirectory('images')
await ensureUploadDirectory('seasons')

// Multer config for image uploads
const imageStorage = multer.diskStorage({
  destination: UPLOAD_DIR,
  filename: (_req, file, cb) => cb(null, createUploadFilename(file.mimetype))
})

const imageUploadOptions = {
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
}
const imageUpload = multer(imageUploadOptions)
const seasonImageUpload = multer({
  ...imageUploadOptions,
  storage: multer.diskStorage({
    destination: (req, _file, cb) => {
      ensureUploadDirectory('seasons', String(req.params.seasonId)).then(
        directory => cb(null, directory),
        error => cb(error)
      )
    },
    filename: (_req, file, cb) => cb(null, createUploadFilename(file.mimetype))
  })
})

// Allowed image keys for site_images
const IMAGE_KEYS = ['hero_banner', 'logo', 'favicon', 'background']
const safeImageContentType = value =>
  ['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(value)
    ? value
    : 'application/octet-stream'

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
    // CWE-22: Validate that the storage path stays within the project root
    const filePath = resolveUploadPath(image.storage_path)
    if (!filePath || !fs.existsSync(filePath)) {
      // Fallback for hero_banner
      if (key === 'hero_banner') {
        res.sendFile(join(__dirname, '..', 'public', 'image.png'))
      } else {
        res.status(404).json({ error: `Image file not found on disk` })
      }
      return
    }
    res.set({
      'Content-Type': safeImageContentType(image.content_type),
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
    validateUploadedImage,
    asyncHandler(async (req, res) => {
      const { key } = req.params

      if (!req.file) {
        res.status(400).json({ error: 'No image file provided' })
        return
      }

      const { altText = '' } = req.body || {}

      const existing = await db.getSiteImageByKey(key)
      const storagePath = toStoredUploadPath(req.file.path)

      await db.upsertSiteImage({
        key,
        filename: req.file.originalname,
        storage_path: storagePath,
        content_type: req.file.mimetype,
        file_size: req.file.size,
        alt_text: altText,
        uploaded_by: req.user?.username || 'admin'
      })
      // Delete the previous file only after the database safely references the
      // replacement. A failed DB write must not destroy the working image.
      if (existing?.storage_path && existing.storage_path !== storagePath) {
        const oldPath = resolveUploadPath(existing.storage_path)
        if (oldPath) {
          try { await fsPromises.unlink(oldPath) } catch { /* file may already be gone */ }
        }
      }

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
        const oldPath = resolveUploadPath(image.storage_path)
        if (oldPath) {
          try { await fsPromises.unlink(oldPath) } catch { /* file may already be gone */ }
        }
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
    [param('seasonId').isInt({ min: 1 }).withMessage('Invalid season ID')],
    handleValidationErrors,
    seasonImageUpload.single('image'),
    validateUploadedImage,
    asyncHandler(async (req, res) => {
      const seasonId = parseInt(req.params.seasonId)

      if (!req.file) {
        res.status(400).json({ error: 'No image file provided' })
        return
      }
      const existingSeason = await db.getSeasonById(seasonId)
      if (!existingSeason) {
        await fsPromises.unlink(req.file.path).catch(() => {})
        return res.status(404).json({ error: 'Season not found' })
      }

      const storagePath = toStoredUploadPath(req.file.path)

      await db.uploadSeasonConclusionImage(seasonId, {
        filename: req.file.originalname,
        storage_path: storagePath,
        content_type: req.file.mimetype,
        file_size: req.file.size
      })
      if (existingSeason.conclusion_image_path &&
          existingSeason.conclusion_image_path !== storagePath) {
        const oldPath = resolveUploadPath(existingSeason.conclusion_image_path)
        if (oldPath) await fsPromises.unlink(oldPath).catch(() => {})
      }

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

      // CWE-22: Validate that the conclusion image path stays within the project root
      const filePath = resolveUploadPath(season.conclusion_image_path)
      if (!filePath || !fs.existsSync(filePath)) {
        res.status(404).json({ error: 'Image file not found on disk' })
        return
      }

      res.set({
        'Content-Type': safeImageContentType(season.conclusion_image_content_type),
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
        const oldPath = resolveUploadPath(season.conclusion_image_path)
        if (oldPath) {
          try { await fsPromises.unlink(oldPath) } catch { /* file may already be gone */ }
        }
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
      const storagePath = toStoredUploadPath(destPath)

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
