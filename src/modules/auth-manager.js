import { getCSRFToken as moduleGetCSRFToken } from './csrf-handler.js'

/**
 * Authentication manager.
 *
 * Handles login, logout, auth status checking, and UI updates
 * based on authentication state. Works with httpOnly cookies.
 */

/**
 * Detect server mode and API base URL.
 * @param {string} initialApiBase - Initially detected API base
 * @returns {Promise<{ serverMode: boolean, apiBase: string }>}
 */
export async function detectServerMode(initialApiBase) {
  try {
    const response = await fetch(`${initialApiBase}/players`, {
      credentials: 'include',
      headers: { 'Accept': 'application/json' }
    })

    if (response.ok) {
      return { serverMode: true, apiBase: initialApiBase }
    }
    throw new Error(`Server responded with ${response.status}`)
  } catch (error) {
    // Try fallback URL
    const currentOrigin = window.location.origin
    const fallbackApiBase = initialApiBase.includes('/tennis/api')
      ? `${currentOrigin}/api`
      : `${currentOrigin}/tennis/api`

    try {
      const fallbackResponse = await fetch(`${fallbackApiBase}/players`, {
        credentials: 'include',
        headers: { 'Accept': 'application/json' }
      })

      if (fallbackResponse.ok) {
        return { serverMode: true, apiBase: fallbackApiBase }
      }
    } catch {
      // Fallback also failed
    }

    return { serverMode: false, apiBase: null }
  }
}

/**
 * Check authentication status from the server.
 * @param {string} apiBase - API base URL
 * @returns {Promise<{ isAuthenticated: boolean, user: object|null, csrfToken: string|null }>}
 */
export async function checkAuthStatus(apiBase) {
  try {
    const response = await fetch(`${apiBase}/auth/status`, {
      method: 'GET',
      credentials: 'include'
    })

    if (response.ok) {
      const data = await response.json()
      return {
        isAuthenticated: data.authenticated,
        user: data.user,
        csrfToken: data.csrfToken
      }
    }
  } catch (error) {
    console.log('Auth status check failed:', error)
  }

  return { isAuthenticated: false, user: null, csrfToken: null }
}

/**
 * Login with username and password.
 * @param {string} apiBase - API base URL
 * @param {string} username
 * @param {string} password
 * @returns {Promise<{ success: boolean, message: string, user?: object, csrfToken?: string }>}
 */
export async function login(apiBase, username, password) {
  try {
    // 1. Fetch the one-time login CSRF token and establish the cookie
    const getResponse = await fetch(`${apiBase}/auth/login`, {
      method: 'GET',
      credentials: 'include'
    })

    if (!getResponse.ok) {
      return { success: false, message: 'Không thể khởi tạo phiên đăng nhập (Lỗi CSRF)' }
    }

    const { loginCsrf } = await getResponse.json()
    const csrfToken = await moduleGetCSRFToken(apiBase)

    // 2. Perform the POST login request, sending the token in the body
    const response = await fetch(`${apiBase}/auth/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(csrfToken ? { 'X-CSRF-Token': csrfToken } : {})
      },
      credentials: 'include',
      body: JSON.stringify({
        username,
        password,
        _loginCsrf: loginCsrf,
        ...(csrfToken ? { _csrf: csrfToken } : {})
      })
    })

    const data = await response.json()

    if (response.ok) {
      return {
        success: true,
        message: data.message,
        user: data.user,
        csrfToken: data.csrfToken,
        isAPIClient: data.authMethod === 'bearer_token'
      }
    }

    return { success: false, message: data.error }
  } catch (error) {
    return { success: false, message: 'Lỗi kết nối server' }
  }
}

/**
 * Logout from the server.
 * @param {string} apiBase - API base URL
 * @param {string} csrfToken - Current CSRF token
 */
export async function logout(apiBase, csrfToken) {
  try {
    const headers = { 'Content-Type': 'application/json' }
    if (csrfToken) {
      headers['X-CSRF-Token'] = csrfToken
    }

    await fetch(`${apiBase}/auth/logout`, {
      method: 'POST',
      headers,
      credentials: 'include'
    })
  } catch (error) {
    console.log('Logout request failed:', error)
  }
}

/**
 * Auto-detect API base URL from the current page location.
 * @returns {string} API base URL
 */
export function getApiBaseUrl() {
  const currentPath = window.location.pathname
  const currentOrigin = window.location.origin
  const currentHost = window.location.host

  if (currentPath.startsWith('/tennis')) {
    return `${currentOrigin}/tennis/api`
  }

  const isProduction = !currentHost.includes('localhost') && !currentHost.includes('127.0.0.1')

  if (isProduction) {
    const pathSegments = currentPath.split('/').filter(s => s && s !== 'index.html')
    if (pathSegments.length > 0) {
      const commonSubpaths = ['tennis', 'app', 'ranking', 'admin', 'dashboard']
      if (commonSubpaths.includes(pathSegments[0])) {
        return `${currentOrigin}/${pathSegments[0]}/api`
      }
    }
    return `${currentOrigin}/tennis/api`
  }

  return `${currentOrigin}/api`
}

/**
 * Update UI elements based on authentication status.
 * @param {object} app - App instance with isAuthenticated and user properties
 */
export function updateUIForAuthStatus(app) {
  const isAuthenticated = app.isAuthenticated ?? false
  const user = app.user ?? null
  const userRole = user?.role || null

  if (isAuthenticated) {
    document.body.classList.add('authenticated')
  } else {
    document.body.classList.remove('authenticated')
  }

  const userName = document.querySelector('.user-name')
  const userRoleBadge = document.querySelector('.user-role.badge')
  if (userName && user) {
    userName.textContent = user.displayName || user.username
  }
  if (userRoleBadge && user) {
    userRoleBadge.textContent = user.role === 'admin'
      ? 'Admin'
      : (user.role === 'editor' ? 'Editor' : 'Viewer')
  }

  const editElements = document.querySelectorAll('.edit-only')
  editElements.forEach(el => {
    el.classList.toggle('hidden', !(isAuthenticated && (userRole === 'admin' || userRole === 'editor')))
  })

  const adminElements = document.querySelectorAll('.admin-only')
  adminElements.forEach(el => {
    el.classList.toggle('hidden', userRole !== 'admin')
  })

  // NOTE: `edit-only` already covers admin+editor — no separate `editor-only` class in HTML

  const guestInfoElements = document.querySelectorAll('.guest-info')
  guestInfoElements.forEach(el => {
    el.classList.toggle('hidden', isAuthenticated && (userRole === 'admin' || userRole === 'editor'))
  })

  document.querySelectorAll('.logged-in-only').forEach(el => {
    el.style.display = isAuthenticated ? '' : 'none'
  })
  document.querySelectorAll('.logged-out-only').forEach(el => {
    el.style.display = isAuthenticated ? 'none' : ''
  })
}
