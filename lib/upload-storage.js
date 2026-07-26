import { chmod, mkdir, readFile, unlink } from 'fs/promises'
import { relative, resolve, sep } from 'path'
import crypto from 'crypto'
import { imageSize } from 'image-size'
import config from '../config/env.js'

export const uploadRoot = resolve(config.uploadRoot)

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

  try {
    const bytes = await readFile(req.file.path)
    const detected = detectedImageMime(bytes.subarray(0, 16))

    if (!detected || detected !== req.file.mimetype) {
      await unlink(req.file.path).catch(() => {})
      return res.status(400).json({ error: 'Uploaded file content does not match an allowed image format' })
    }
    const dimensions = imageSize(bytes)
    const width = Number(dimensions.width) || 0
    const height = Number(dimensions.height) || 0
    if (!width || !height || width > 10000 || height > 10000 || width * height > 40_000_000) {
      await unlink(req.file.path).catch(() => {})
      return res.status(400).json({ error: 'Image dimensions are invalid or exceed the 40 megapixel limit' })
    }

    await chmod(req.file.path, 0o640).catch(() => {})
    req.file.detectedMime = detected
    req.file.imageDimensions = { width, height }
    next()
  } catch (error) {
    await unlink(req.file.path).catch(() => {})
    next(error)
  }
}
