import { describe, expect, it } from 'vitest'
import { readImageDimensions } from '../../lib/image-dimensions.js'

// Minimal, hand-built image headers — just enough bytes for the dimension
// reader to parse, no pixel data.
function png(width, height) {
  const buf = Buffer.alloc(24)
  buf.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0)
  buf.writeUInt32BE(13, 8) // IHDR length
  buf.write('IHDR', 12, 'ascii')
  buf.writeUInt32BE(width, 16)
  buf.writeUInt32BE(height, 20)
  return buf
}

function gif(width, height) {
  const buf = Buffer.alloc(10)
  buf.write('GIF89a', 0, 'ascii')
  buf.writeUInt16LE(width, 6)
  buf.writeUInt16LE(height, 8)
  return buf
}

function jpeg(width, height) {
  return Buffer.from([
    0xff, 0xd8, // SOI
    0xff, 0xc0, // SOF0
    0x00, 0x11, // segment length (17)
    0x08, // precision
    (height >> 8) & 0xff, height & 0xff,
    (width >> 8) & 0xff, width & 0xff,
    0x03, // component count
    0x01, 0x22, 0x00,
    0x02, 0x11, 0x01,
    0x03, 0x11, 0x01
  ])
}

function webpVP8X(width, height) {
  const buf = Buffer.alloc(30)
  buf.write('RIFF', 0, 'ascii')
  buf.writeUInt32LE(36, 4)
  buf.write('WEBP', 8, 'ascii')
  buf.write('VP8X', 12, 'ascii')
  buf.writeUInt32LE(10, 16) // chunk size
  buf.writeUInt8(0x00, 20) // flags
  buf.writeUIntLE(width - 1, 24, 3)
  buf.writeUIntLE(height - 1, 27, 3)
  return buf
}

function webpVP8L(width, height) {
  const buf = Buffer.alloc(26)
  buf.write('RIFF', 0, 'ascii')
  buf.writeUInt32LE(20, 4)
  buf.write('WEBP', 8, 'ascii')
  buf.write('VP8L', 12, 'ascii')
  buf.writeUInt32LE(5, 16) // chunk size
  buf.writeUInt8(0x2f, 20) // VP8L signature byte
  buf.writeUInt32LE(((height - 1) << 15) | (width - 1), 21)
  return buf
}

function webpVP8(width, height) {
  const buf = Buffer.alloc(30)
  buf.write('RIFF', 0, 'ascii')
  buf.writeUInt32LE(24, 4)
  buf.write('WEBP', 8, 'ascii')
  buf.write('VP8', 12, 'ascii')
  buf.writeUInt8(0x20, 15) // fourcc is "VP8 " (trailing space)
  buf.writeUInt32LE(10, 16) // chunk size
  buf.writeUInt8(0x9d, 23) // start code
  buf.writeUInt8(0x01, 24)
  buf.writeUInt8(0x2a, 25)
  buf.writeUInt16LE(width, 26)
  buf.writeUInt16LE(height, 28)
  return buf
}

describe('readImageDimensions', () => {
  it('reads PNG dimensions (big-endian u32 in IHDR)', () => {
    expect(readImageDimensions(png(100, 200))).toEqual({ width: 100, height: 200 })
  })

  it('reads GIF dimensions (little-endian u16)', () => {
    expect(readImageDimensions(gif(300, 150))).toEqual({ width: 300, height: 150 })
  })

  it('reads JPEG dimensions from the first SOF marker', () => {
    expect(readImageDimensions(jpeg(640, 480))).toEqual({ width: 640, height: 480 })
  })

  it('reads WEBP VP8X dimensions (24-bit little-endian, minus one)', () => {
    expect(readImageDimensions(webpVP8X(800, 600))).toEqual({ width: 800, height: 600 })
  })

  it('reads WEBP VP8L dimensions (bitfield)', () => {
    expect(readImageDimensions(webpVP8L(100, 50))).toEqual({ width: 100, height: 50 })
  })

  it('reads WEBP lossy VP8 dimensions (16-bit little-endian)', () => {
    expect(readImageDimensions(webpVP8(200, 100))).toEqual({ width: 200, height: 100 })
  })

  it('returns null for unsupported formats (e.g. ICNS)', () => {
    const icns = Buffer.from([0x49, 0x43, 0x4e, 0x53, 0, 0, 0, 8, 0, 0, 0, 0])
    expect(readImageDimensions(icns)).toBeNull()
  })

  it('returns null for buffers too short to contain a header', () => {
    expect(readImageDimensions(Buffer.from([0x89, 0x50]))).toBeNull()
    expect(readImageDimensions(Buffer.alloc(0))).toBeNull()
  })

  it('returns null for non-Buffer input', () => {
    expect(readImageDimensions('not a buffer')).toBeNull()
    expect(readImageDimensions(undefined)).toBeNull()
  })

  it('returns null for a truncated JPEG with no SOF marker', () => {
    expect(readImageDimensions(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]))).toBeNull()
  })
})
