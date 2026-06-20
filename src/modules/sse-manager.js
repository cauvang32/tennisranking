/**
 * Server-Sent Events (SSE) manager.
 *
 * Handles real-time server data sync via SSE with polling fallback.
 * On version change: triggers cache invalidation + UI reload.
 */

let eventSource = null
let versionPollInterval = null

/**
 * Establish SSE connection for instant cache invalidation.
 * @param {string} apiBase - API base URL
 * @param {object} cache - Client cache object with serverVersion
 * @param {Function} onVersionChange - Callback when server version changes: (newVersion) => void
 * @param {Function} onReloadView - Callback to reload current view
 */
export function connectSSE(apiBase, cache, onVersionChange, onReloadView) {
  closeSSE()

  const sseUrl = `${apiBase}/events`

  try {
    eventSource = new EventSource(sseUrl, { withCredentials: true })

    eventSource.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data)
        const newVersion = data.version

        if (cache.serverVersion !== null && cache.serverVersion !== newVersion) {
          console.log(`🔄 SSE: Server data changed (${cache.serverVersion} → ${newVersion}), clearing cache`)
          onVersionChange(newVersion)
          onReloadView()
        }

        cache.serverVersion = newVersion
      } catch (parseError) {
        console.warn('⚠️ SSE: Failed to parse event data')
      }
    }

    eventSource.onopen = () => {
      console.log('🟢 SSE: Connected for real-time updates')
      stopPollingFallback()
    }

    eventSource.onerror = () => {
      console.warn('⚠️ SSE: Connection error — falling back to polling')
      startPollingFallback(apiBase, cache, onVersionChange, onReloadView)
    }
  } catch (error) {
    console.warn('⚠️ SSE: Not supported — using polling fallback')
    startPollingFallback(apiBase, cache, onVersionChange, onReloadView)
  }
}

/**
 * Close SSE connection.
 */
export function closeSSE() {
  if (eventSource) {
    eventSource.close()
    eventSource = null
  }
  stopPollingFallback()
}

/**
 * Polling fallback when SSE is unavailable.
 */
function startPollingFallback(apiBase, cache, onVersionChange, onReloadView) {
  if (versionPollInterval) return

  checkServerVersion(apiBase, cache, onVersionChange, onReloadView)
  versionPollInterval = setInterval(
    () => checkServerVersion(apiBase, cache, onVersionChange, onReloadView),
    15 * 1000
  )
  console.log('🔄 Polling fallback active (every 15s)')
}

function stopPollingFallback() {
  if (versionPollInterval) {
    clearInterval(versionPollInterval)
    versionPollInterval = null
  }
}

async function checkServerVersion(apiBase, cache, onVersionChange, onReloadView) {
  try {
    const response = await fetch(`${apiBase}/data-version`, { credentials: 'include' })

    if (response.ok) {
      const data = await response.json()
      const newVersion = data.version

      if (cache.serverVersion !== null && cache.serverVersion !== newVersion) {
        console.log(`🔄 Server data changed (${cache.serverVersion} → ${newVersion}), clearing cache`)
        onVersionChange(newVersion)
        onReloadView()
      }

      cache.serverVersion = newVersion
    }
  } catch (error) {
    console.log('⚠️ Version check failed, using local cache')
  }
}
