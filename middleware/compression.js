import compression from 'compression'
import zlib from 'zlib'

/**
 * Build compression middleware stack.
 *
 * 1. Custom Brotli middleware — manually compresses JSON responses > 1 KB
 *    when the client sends `Accept-Encoding: br`. Quality 4 for speed.
 * 2. Fallback gzip middleware via `compression` package for clients
 *    that don't support Brotli.
 *
 * Returns an array of middleware to app.use().
 */
export function createCompressionMiddleware() {
  const compressionFilter = (req, res) => {
    if (req.headers['x-no-compression']) return false
    return compression.filter(req, res)
  }

  // Brotli middleware (applied before gzip fallback).
  // Uses streaming compression (zlib.createBrotliCompress) so the
  // compressed payload is never buffered in memory. Drops Content-Length
  // and lets chunked transfer-encoding carry the body.
  const brotliMiddleware = (req, res, next) => {
    if (!compressionFilter(req, res)) return next()

    const acceptEncoding = req.headers['accept-encoding'] || ''

    if (acceptEncoding.includes('br')) {
      const originalJson = res.json.bind(res)
      res.json = (body) => {
        const raw = JSON.stringify(body)
        // Only Brotli-compress responses larger than 1 KB
        if (Buffer.byteLength(raw, 'utf8') < 1024) {
          return originalJson(body)
        }

        if (res.headersSent) return originalJson(body)

        // Set encoding headers BEFORE piping — the gzip middleware's
        // write-hook checks Content-Encoding and will skip if it's already 'br'.
        res.setHeader('Content-Encoding', 'br')
        res.setHeader('Content-Type', 'application/json; charset=utf-8')
        res.removeHeader('Content-Length')
        res.removeHeader('Transfer-Encoding')

        const brotli = zlib.createBrotliCompress({
          params: {
            [zlib.constants.BROTLI_PARAM_MODE]: zlib.constants.BROTLI_MODE_TEXT,
            [zlib.constants.BROTLI_PARAM_QUALITY]: 4
          }
        })

        brotli.on('error', (err) => {
          console.error('Brotli compression error:', err.message)
          if (!res.headersSent) {
            // Headers not sent — fall back to uncompressed.
            res.setHeader('Content-Encoding', 'identity')
            res.end(raw)
          } else if (!res.writableEnded) {
            // Already streaming compressed bytes — abort the response.
            res.destroy(err)
          }
        })

        brotli.pipe(res)
        brotli.end(raw)
      }
    }

    next()
  }

  // Gzip fallback
  const gzipMiddleware = compression({
    threshold: 1024,
    filter: compressionFilter
  })

  return [brotliMiddleware, gzipMiddleware]
}
