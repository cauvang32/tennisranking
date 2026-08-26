/**
 * In-house image dimension reader.
 *
 * Replaces the `image-size` dependency. This application only ever accepts
 * PNG, JPEG, GIF and WEBP uploads (enforced by magic-byte checks at every
 * call site), so we only need to read dimensions for those four formats.
 *
 * `image-size`'s ICNS / JXL / HEIF parsers had unresolved denial-of-service
 * advisories (infinite loops) with no patched release, and those parsers were
 * unreachable here anyway — the magic-byte gate never dispatches to them.
 * Dropping the dependency removes the audit advisory at the source.
 *
 * readImageDimensions(buffer) -> { width, height } | null
 *   Returns integer width/height, or null when the buffer is not one of the
 *   four supported formats or the dimensions cannot be determined.
 */

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

export function readImageDimensions(buf) {
  // 10 bytes is the smallest valid header (GIF: 6 magic + 4 dimensions).
  if (!Buffer.isBuffer(buf) || buf.length < 10) return null

  // PNG — signature (8) + IHDR chunk; width @16, height @20 (big-endian u32).
  if (buf.length >= 24 && buf.subarray(0, 8).equals(PNG_SIGNATURE)) {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
  }

  // GIF — "GIF87a"/"GIF89a"; width @6, height @8 (little-endian u16).
  if (buf.length >= 10) {
    const header = buf.subarray(0, 6).toString('ascii')
    if (header === 'GIF87a' || header === 'GIF89a') {
      return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) }
    }
  }

  // JPEG — SOI (FF D8 FF) then scan for a Start-of-Frame marker.
  if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return readJpegDimensions(buf)
  }

  // WEBP — "RIFF" + "WEBP"; the first image chunk carries the dimensions.
  if (buf.length >= 16 &&
      buf.subarray(0, 4).toString('ascii') === 'RIFF' &&
      buf.subarray(8, 12).toString('ascii') === 'WEBP') {
    return readWebpDimensions(buf)
  }

  return null
}

/**
 * Walk a JPEG segment list to the first SOF marker and read the dimensions.
 * SOF0–SOF15 (excluding DHT=C4, JPG=C8, DAC=CC) store:
 *   precision (1), height (u16 BE), width (u16 BE).
 */
function readJpegDimensions(buf) {
  const total = buf.length
  let offset = 2
  while (offset + 4 <= total) {
    if (buf[offset] !== 0xff) {
      offset += 1
      continue
    }
    const marker = buf[offset + 1]
    if (marker === 0xff) {
      offset += 1 // fill byte
      continue
    }
    // Standalone markers carry no length segment.
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
      offset += 2
      continue
    }
    const segmentLength = buf.readUInt16BE(offset + 2)
    if (segmentLength < 2) return null
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      if (offset + 9 >= total) return null
      return {
        height: buf.readUInt16BE(offset + 5),
        width: buf.readUInt16BE(offset + 7)
      }
    }
    offset += 2 + segmentLength
  }
  return null
}

/**
 * Walk WEBP RIFF chunks to the first image chunk (VP8 / VP8L / VP8X) and read
 * the canvas dimensions. Non-image chunks (ICCP/EXIF/XMP) are skipped.
 */
function readWebpDimensions(buf) {
  const total = buf.length
  let offset = 12 // skip "RIFF" + file size + "WEBP"
  while (offset + 8 <= total) {
    const fourthByte = buf[offset + 3]
    const chunkSize = buf.readUInt32LE(offset + 4)
    const dataStart = offset + 8

    // VP8X (extended) — canvas size minus 1 in 24-bit little-endian.
    if (fourthByte === 0x58 && dataStart + 10 <= total) {
      return {
        width: buf.readUIntLE(dataStart + 4, 3) + 1,
        height: buf.readUIntLE(dataStart + 7, 3) + 1
      }
    }
    // VP8L (lossless) — 32-bit bitfield after the 0x2F signature byte.
    if (fourthByte === 0x4c && dataStart + 5 <= total && buf[dataStart] === 0x2f) {
      const value = buf.readUInt32LE(dataStart + 1)
      return {
        width: (value & 0x3fff) + 1,
        height: ((value >>> 15) & 0x3fff) + 1
      }
    }
    // VP8 (lossy) — start code then 16-bit little-endian width/height.
    if (fourthByte === 0x20 && dataStart + 10 <= total) {
      return {
        width: buf.readUInt16LE(dataStart + 6),
        height: buf.readUInt16LE(dataStart + 8)
      }
    }
    // Advance to the next chunk (WEBP chunks are word-aligned).
    offset = dataStart + chunkSize + (chunkSize % 2)
  }
  return null
}
