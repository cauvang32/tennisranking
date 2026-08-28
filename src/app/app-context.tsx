import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import type { AuthUser, Player, Season } from '../../shared/domain'
import { api, type InitData } from '../api/client'

interface AppContextValue {
  data: InitData | null
  players: Player[]
  seasons: Season[]
  user: AuthUser | null
  authenticated: boolean
  canEdit: boolean
  isAdmin: boolean
  loading: boolean
  error: string | null
  revision: number
  reload: () => Promise<void>
  login: (username: string, password: string) => Promise<string | null>
  logout: () => Promise<void>
  notify: (message: string, kind?: 'success' | 'error' | 'info') => void
}

const AppContext = createContext<AppContextValue | null>(null)

export function AppProvider({ children }: { children: ReactNode }) {
  const [data, setData] = useState<InitData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [revision, setRevision] = useState(0)
  const [toast, setToast] = useState<{ message: string; kind: string } | null>(null)

  const reload = useCallback(async () => {
    try {
      setError(null)
      const next = await api.init()
      api.setCsrfToken(next.csrfToken)
      setData(next)
      setRevision(value => value + 1)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Không thể tải dữ liệu')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void reload() }, [reload])

  const dataVersion = data?.version
  useEffect(() => {
    if (dataVersion === undefined) return
    let lastVersion = dataVersion
    let polling: number | undefined
    // Debounced reload: if several version events arrive in quick succession,
    // only the latest triggers one /api/init call instead of one per event.
    let pendingTimer: number | undefined
    const scheduleReload = () => {
      if (pendingTimer !== undefined) window.clearTimeout(pendingTimer)
      pendingTimer = window.setTimeout(() => {
        pendingTimer = undefined
        void reload()
      }, 250)
    }
    const source = new EventSource(`${api.baseUrl}/events`, { withCredentials: true })
    source.onmessage = event => {
      const payload = JSON.parse(event.data) as { version: number }
      if (payload.version !== lastVersion) {
        lastVersion = payload.version
        scheduleReload()
      }
    }
    source.onerror = () => {
      source.close()
      polling = window.setInterval(async () => {
        try {
          const payload = await api.request<{ version: number }>('/data-version')
          if (payload.version !== lastVersion) {
            lastVersion = payload.version
            scheduleReload()
          }
        } catch { /* keep the last usable screen */ }
      }, 15000)
    }
    return () => { source.close(); if (polling) clearInterval(polling); if (pendingTimer !== undefined) window.clearTimeout(pendingTimer) }
  }, [dataVersion, reload])

  const notify = useCallback((message: string, kind = 'info') => {
    setToast({ message, kind })
    window.setTimeout(() => setToast(null), 3500)
  }, [])

  const login = useCallback(async (username: string, password: string) => {
    const result = await api.login(username, password)
    if (!result.success) return result.message
    await reload()
    notify('Đăng nhập thành công', 'success')
    return null
  }, [notify, reload])

  const logout = useCallback(async () => {
    await api.logout()
    await reload()
    notify('Đã đăng xuất', 'success')
  }, [notify, reload])

  const user = data?.user || null
  const value = useMemo<AppContextValue>(() => ({
    data,
    players: data?.players || [],
    seasons: data?.seasons || [],
    user,
    authenticated: Boolean(data?.isAuthenticated),
    canEdit: user?.role === 'admin' || user?.role === 'editor',
    isAdmin: user?.role === 'admin',
    loading,
    error,
    revision,
    reload,
    login,
    logout,
    notify
  }), [data, error, loading, login, logout, notify, reload, revision, user])

  return <AppContext.Provider value={value}>
    {children}
    {toast && <div className={`toast show ${toast.kind}`} role="status">{toast.message}</div>}
  </AppContext.Provider>
}

export function useApp() {
  const context = useContext(AppContext)
  if (!context) throw new Error('useApp must be used inside AppProvider')
  return context
}
