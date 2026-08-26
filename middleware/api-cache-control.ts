/**
 * Authenticated API responses may contain role- or user-specific data.
 * Prevent storage and ensure conditional headers can never complete a request
 * before route authentication and authorization middleware runs.
 */
export function privateApiCacheControl(_req, res, next) {
  res.setHeader('Cache-Control', 'private, no-store, max-age=0')
  res.setHeader('Pragma', 'no-cache')
  res.setHeader('Expires', '0')
  res.setHeader('Vary', 'Cookie, Authorization')
  next()
}
