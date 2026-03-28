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

  // Brotli middleware (applied before gzip fallback)
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

        zlib.brotliCompress(Buffer.from(raw), {
          params: {
            [zlib.constants.BROTLI_PARAM_MODE]: zlib.constants.BROTLI_MODE_TEXT,
            [zlib.constants.BROTLI_PARAM_QUALITY]: 4
          }
        }, (err, compressed) => {
          if (err || res.headersSent) {
            if (!res.headersSent) return originalJson(body)
            return
          }
          res.setHeader('Content-Encoding', 'br')
          res.setHeader('Content-Type', 'application/json; charset=utf-8')
          res.setHeader('Content-Length', compressed.length)
          res.removeHeader('Transfer-Encoding')
          res.end(compressed)
        })
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
