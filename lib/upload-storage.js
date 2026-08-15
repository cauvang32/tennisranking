import { chmod, mkdir, readFile, unlink } from 'fs/promises'
import { relative, resolve, sep } from 'path'
import crypto from 'crypto'
import { readImageDimensions } from './image-dimensions.js'
import { uploadRoot } from '../config/upload-paths.js'

export { uploadRoot }

export async function ensureUploadDirectory(...segments) {
  const directory = resolveUploadPath(segments.join('/'))
  if (!directory) throw new Error('Invalid upload directory')
  await mkdir(directory, { recursive: true, mode: 0o750 })
  await chmod(directory, 0o750).catch(() => {})
  return directory
}

export function resolveUploadPath(storedPath = '') {
  let value = String(storedPath).replace(/\\/g, '/').trim()
  if (!value) return null

  // Backward compatibility for paths stored before UPLOAD_ROOT existed.
  const legacyMarker = '/data/uploads/'
  const markerIndex = value.indexOf(legacyMarker)
  if (markerIndex >= 0) value = value.slice(markerIndex + legacyMarker.length)
  value = value.replace(/^\/+/, '').replace(/^data\/uploads\//, '').replace(/^uploads\//, '')

  const candidate = resolve(uploadRoot, value)
  if (candidate !== uploadRoot && !candidate.startsWith(`${uploadRoot}${sep}`)) return null
  return candidate
}

export function toStoredUploadPath(filePath) {
  const absolute = resolve(filePath)
  if (absolute !== uploadRoot && !absolute.startsWith(`${uploadRoot}${sep}`)) {
    throw new Error('Upload path escaped configured root')
  }
  return relative(uploadRoot, absolute).replace(/\\/g, '/')
}

/**
 * Validate that an absolute file path (e.g. req.file.path from Multer) stays
 * within the configured upload root. Returns the resolved absolute path, or
 * null if it escapes the root.
 *
 * Defense-in-depth for CWE-22: this lets callers guard every filesystem
 * operation (read/unlink/chmod) so an unvalidated path is never used in a path
 * expression — even though Multer sets req.file.path from a controlled
 * destination plus a random filename.
 */
export function resolveAbsoluteUploadPath(absolutePath) {
  const resolved = resolve(String(absolutePath))
  if (resolved !== uploadRoot && !resolved.startsWith(`${uploadRoot}${sep}`)) return null
  return resolved
}

export function createUploadFilename(mimetype) {
  const extensions = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/webp': 'webp',
    'image/gif': 'gif'
  }
  return `${crypto.randomUUID()}.${extensions[mimetype] || 'bin'}`
}

function detectedImageMime(header) {
  if (header.length >= 8 && header.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'image/png'
  }
  if (header.length >= 3 && header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff) {
    return 'image/jpeg'
  }
  if (header.length >= 6 && ['GIF87a', 'GIF89a'].includes(header.subarray(0, 6).toString('ascii'))) {
    return 'image/gif'
  }
  if (header.length >= 12 &&
      header.subarray(0, 4).toString('ascii') === 'RIFF' &&
      header.subarray(8, 12).toString('ascii') === 'WEBP') {
    return 'image/webp'
  }
  return null
}

export async function validateUploadedImage(req, res, next) {
  if (!req.file) return next()

  // CWE-22: confirm the uploaded file path stays within the upload root before
  // any filesystem operation on it. If it escaped, reject without touching an
  // unvalidated path.
  const safePath = resolveAbsoluteUploadPath(req.file.path)
  if (!safePath) {
    console.warn('⚠️  Uploaded file path escaped the upload root; rejecting request')
    return res.status(400).json({ error: 'Invalid upload path' })
  }

  try {
    const bytes = await readFile(safePath)
    const detected = detectedImageMime(bytes.subarray(0, 16))

    if (!detected || detected !== req.file.mimetype) {
      await unlink(safePath).catch(() => {})
      return res.status(400).json({ error: 'Uploaded file content does not match an allowed image format' })
    }
    const dimensions = readImageDimensions(bytes)
    const width = Number(dimensions?.width) || 0
    const height = Number(dimensions?.height) || 0
    if (!width || !height || width > 10000 || height > 10000 || width * height > 40_000_000) {
      await unlink(safePath).catch(() => {})
      return res.status(400).json({ error: 'Image dimensions are invalid or exceed the 40 megapixel limit' })
    }

    await chmod(safePath, 0o640).catch(() => {})
    req.file.detectedMime = detected
    req.file.imageDimensions = { width, height }
    next()
  } catch (error) {
    await unlink(safePath).catch(() => {})
    next(error)
  }
}
