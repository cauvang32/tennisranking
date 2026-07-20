/**
 * CSRF token handler with auto token refresh.
 *
 * Manages CSRF token fetching and inclusion in authenticated requests.
 * The backend derives CSRF secrets from user ID (deterministic per user).
 * The frontend reads the derived CSRF token from API responses.
 *
 * When a request fails with 401/403 (expired access token), the handler
 * automatically calls POST /api/auth/refresh to get a new access token
 * and CSRF token, then retries the request once.
 */

let cachedCsrfToken = null
let isRefreshing = false       // Guard against concurrent refresh attempts
let refreshPromise = null      // Shared refresh promise for concurrent requests

/**
 * Get the current CSRF token, fetching from server if not cached.
 * @param {string} apiBase - API base URL
 * @param {boolean} forceRefresh - If true, always fetch a fresh token
 * @returns {Promise<string|null>} CSRF token or null on failure
 */
export async function getCSRFToken(apiBase, forceRefresh = false) {
  if (!forceRefresh && cachedCsrfToken) {
    return cachedCsrfToken
  }

  try {
    const response = await fetch(`${apiBase}/csrf-token`, {
      credentials: 'include'
    })

    if (response.ok) {
      const data = await response.json()
      cachedCsrfToken = data.csrfToken
      return cachedCsrfToken
    }
  } catch (error) {
    console.error('Failed to get CSRF token:', error)
  }

  // If the cached token exists but the fetch failed (e.g. session changed),
  // clear it so the next request will re-fetch a fresh token.
  if (cachedCsrfToken) {
    cachedCsrfToken = null
  }

  return null
}

/**
 * Reset the cached CSRF token (call after login/logout).
 */
export function resetCSRFToken() {
  cachedCsrfToken = null
}

/**
 * Update the cached CSRF token (called after successful refresh).
 * @param {string} token - New CSRF token
 */
export function setCSRFToken(token) {
  cachedCsrfToken = token
}

/**
 * Refresh the access token via the refresh endpoint.
 * @param {string} apiBase - API base URL
 * @returns {Promise<object|null>} { csrfToken, user } or null on failure
 */
export async function refreshAuthToken(apiBase) {
  try {
    const response = await fetch(`${apiBase}/auth/refresh`, {
      method: 'POST',
      credentials: 'include'
    })

    if (response.ok) {
      const data = await response.json()
      if (data.success && data.csrfToken) {
        cachedCsrfToken = data.csrfToken
        return { csrfToken: data.csrfToken, user: data.user }
      }
    }
    // Refresh token expired or invalid — session is truly gone
    return null
  } catch (error) {
    console.error('Token refresh failed:', error)
    return null
  }
}

/**
 * Refresh the access token, with guard against concurrent refreshes.
 * If multiple requests trigger refresh simultaneously, only one actually
 * calls the server; the others wait for its result.
 * @param {string} apiBase - API base URL
 * @returns {Promise<object|null>} { csrfToken, user } or null on failure
 */
async function refreshOnce(apiBase) {
  if (isRefreshing && refreshPromise) {
    // Another request is already refreshing — wait for it
    return refreshPromise
  }

  isRefreshing = true
  refreshPromise = refreshAuthToken(apiBase).finally(() => {
    isRefreshing = false
    refreshPromise = null
  })

  return refreshPromise
}

/**
 * Make an authenticated request with CSRF protection and auto-refresh.
 * On 401/403, automatically refreshes the access token and retries once.
 * @param {string} apiBase - API base URL
 * @param {string} url - API URL
 * @param {object} options - Fetch options
 * @returns {Promise<Response>} Fetch response
 */
export async function makeAuthenticatedRequest(apiBase, url, options = {}) {
  const csrfToken = await getCSRFToken(apiBase)
  if (!csrfToken) {
    throw new Error('CSRF token required')
  }

  // Resolve the request URL.
  // Some callers pass bare paths ('/cups'), others prepend apiBase
  // ('${apiBase}/cups'). Handle both.
  // DO NOT use new URL(url, base) for relative paths — a leading '/' in `url`
  // replaces the entire base pathname, so '/cups' against '.../tennis/api/'
  // resolves to 'https://hungsanity.com/cups', dropping '/tennis/api' entirely.
  let fullUrl
  if (url.startsWith('http://') || url.startsWith('https://')) {
    fullUrl = url
  } else {
    fullUrl = apiBase.endsWith('/') ? apiBase + url.slice(1) : apiBase + url
  }
  const parsedUrl = new URL(fullUrl)
  const allowedOrigin = new URL(apiBase).origin
  if (parsedUrl.origin !== allowedOrigin) {
    throw new Error('Invalid request URL: external URLs not allowed')
  }
  if (!parsedUrl.pathname.includes('/api/')) {
    throw new Error('Invalid request URL: must target API endpoint')
  }

  // For FormData (file uploads), don't set Content-Type — browser sets it with boundary
  const isFormData = options.body instanceof FormData
  const headers = {
    ...(isFormData ? {} : { 'Content-Type': 'application/json' }),
    'X-CSRF-Token': csrfToken,
    ...options.headers
  }

  const fetchOptions = {
    ...options,
    headers,
    credentials: 'include'
  }

  // Clone the body if present, so we can retry after refresh.
  // Request.body is a stream that can only be read once.
  // FormData cannot be cloned, so we can't retry FormData requests.
  let bodyClone = null
  if (options.body && !(options.body instanceof FormData)) {
    bodyClone = options.body
  }

  const response = await fetch(parsedUrl.toString(), fetchOptions)

  // On 401 (expired access token) or 403 (CSRF mismatch from expired token),
  // try to refresh the access token and retry once. Skip retry for FormData
  // since it cannot be re-sent (stream consumed).
  if ((response.status === 401 || response.status === 403) && !isFormData) {
    const result = await refreshOnce(apiBase)
    if (result) {
      // Fetch a fresh CSRF token derived from the new session
      // The refresh may not return a csrfToken, so always fetch from /csrf-token
      const newCsrf = await getCSRFToken(apiBase, true)
      if (!newCsrf) {
        throw new Error('Phiên làm việc đã hết hạn. Vui lòng đăng nhập lại.')
      }

      const retryHeaders = {
        ...(isFormData ? {} : { 'Content-Type': 'application/json' }),
        'X-CSRF-Token': newCsrf,
        ...options.headers
      }

      const retryOptions = {
        ...options,
        headers: retryHeaders,
        credentials: 'include'
      }
      if (bodyClone) {
        retryOptions.body = bodyClone
      }

      const retryResponse = await fetch(parsedUrl.toString(), retryOptions)

      // The cached token from refreshOnce() is reusable (hash:true), so it remains
      // valid for subsequent requests. No need to fetch a fresh token here.

      return retryResponse
    }
    // Refresh failed — session is truly expired (refresh token also gone).
    // Throw so the caller's catch block shows the session-expired message.
    throw new Error('Phiên làm việc đã hết hạn. Vui lòng đăng nhập lại.')
  }

  return response
}
