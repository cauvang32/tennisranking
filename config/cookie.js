import config from './env.js'

/**
 * Build the shared cookie defaults and path-clearing helpers.
 * This module is purely config-driven — it reads from config/env.js
 * and works identically in PM2, Docker, or bare-metal.
 */

export const sharedCookieDefaults = { ...config.cookie.defaults }

export const withCookieDefaults = (options = {}) => {
  const base = {
    ...sharedCookieDefaults,
    path: '/',
    ...options
  }
  if (config.cookie.domain) {
    base.domain = config.cookie.domain
  }
  return base
}

/**
 * Returns all cookie paths that need to be cleared during logout.
 * Handles subpath + root path cookies for maximum compatibility.
 */
export const getCookiePathsToClear = () => {
  const paths = new Set(['/'])
  const SUBPATH = config.subpath
  const normalizedSubpath = SUBPATH && SUBPATH !== '/' ? SUBPATH : null
  if (normalizedSubpath) {
    const cleanSubpath = normalizedSubpath.endsWith('/') ? normalizedSubpath.slice(0, -1) : normalizedSubpath
    paths.add(cleanSubpath)
    paths.add(`${cleanSubpath}/`)
    paths.add(`${cleanSubpath}/api`)
    paths.add(`${cleanSubpath}/api/`)
  }
  paths.add('/api')
  paths.add('/api/')
  return Array.from(paths)
}

/**
 * Clear a named cookie on all known paths (subpath + root).
 * This is needed because browsers treat path-scoped cookies separately.
 * Uses withCookieDefaults() to ensure Domain/Secure/SameSite match creation.
 */
export const clearCookieAllPaths = (res, name, extraOptions = {}) => {
  const paths = getCookiePathsToClear()
  paths.forEach((path) => {
    res.clearCookie(name, withCookieDefaults({
      httpOnly: true,
      path,
      maxAge: 0,
      ...extraOptions
    }))
  })
}
