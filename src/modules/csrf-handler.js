/**
 * CSRF token handler.
 *
 * Manages CSRF token fetching and inclusion in authenticated requests.
 * The backend derives CSRF secrets from user ID (deterministic per user).
 * The frontend reads the derived CSRF token from API responses.
 */

let cachedCsrfToken = null

/**
 * Get the current CSRF token, fetching from server if not cached.
 * @param {string} apiBase - API base URL
 * @returns {Promise<string|null>} CSRF token or null on failure
 */
export async function getCSRFToken(apiBase) {
  if (cachedCsrfToken) {
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

  return null
}

/**
 * Reset the cached CSRF token (call after login/logout).
 */
export function resetCSRFToken() {
  cachedCsrfToken = null
}

/**
 * Make an authenticated request with CSRF protection.
 * @param {string} url - API URL
 * @param {object} options - Fetch options
 * @returns {Promise<Response>} Fetch response
 */
export async function makeAuthenticatedRequest(apiBase, url, options = {}) {
  const csrfToken = await getCSRFToken(apiBase)
  if (!csrfToken) {
    throw new Error('CSRF token required')
  }

  // SSRF Protection: Validate URL targets our own API only
  const allowedOrigin = window.location.origin
  const parsedUrl = new URL(url, allowedOrigin)
  if (parsedUrl.origin !== allowedOrigin) {
    throw new Error('Invalid request URL: external URLs not allowed')
  }
  if (!parsedUrl.pathname.includes('/api/')) {
    throw new Error('Invalid request URL: must target API endpoint')
  }

  const headers = {
    'Content-Type': 'application/json',
    'X-CSRF-Token': csrfToken,
    ...options.headers
  }

  return fetch(url, {
    ...options,
    headers,
    credentials: 'include'
  })
}
