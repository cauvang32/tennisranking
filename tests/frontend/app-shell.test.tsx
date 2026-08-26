// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { App } from '../../src/app/App'
import { AppProvider } from '../../src/app/app-context'

const initData = {
  lifetimeRankings: [],
  players: [{ id: 1, name: 'Anh' }],
  seasons: [{ id: 1, name: 'Mùa 2026', start_date: '2026-01-01', end_date: null, is_active: true, auto_end: false, lose_money_per_loss: 20000 }],
  activeSeasons: [],
  // PostgreSQL currently returns play-date rows; the typed API boundary must
  // normalize these before React renders them as <option> children.
  playDates: [{ play_date: '2026-08-25' }],
  activeSeason: null,
  defaultDate: '2026-08-25',
  defaultDateRankings: [{ id: 1, name: 'Anh', wins: 2, losses: 1, total_matches: 3, points: 9, win_percentage: '66.7', money_lost: '20000', form: [{ result: 'win', play_date: '2026-08-25' }] }],
  defaultDateMatches: [],
  version: 1,
  isAuthenticated: false,
  user: null,
  csrfToken: 'test-csrf'
}

class EventSourceStub {
  onmessage: ((event: MessageEvent) => void) | null = null
  onerror: (() => void) | null = null
  close = vi.fn()
}

describe('React application shell', () => {
  beforeEach(() => {
    window.history.replaceState(null, '', '#rankings')
    vi.stubGlobal('scrollTo', vi.fn())
    vi.stubGlobal('EventSource', EventSourceStub)
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/init')) return new Response(JSON.stringify(initData), { status: 200, headers: { 'Content-Type': 'application/json' } })
      if (url.includes('/rankings/')) return new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } })
      return new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } })
    }))
  })

  afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

  it('loads initial data and navigates between React feature tabs', async () => {
    render(<AppProvider><App /></AppProvider>)
    expect(await screen.findByRole('heading', { name: /Bảng xếp hạng/i })).toBeInTheDocument()
    expect(within(screen.getByRole('navigation', { name: 'Điều hướng chính' })).getAllByRole('button')).toHaveLength(5)
    expect(screen.getByRole('option', { name: '2026-08-25' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Người Chơi/i }))
    expect(await screen.findByRole('heading', { name: /Quản lý người chơi/i })).toBeInTheDocument()
    expect(window.location.hash).toBe('#players')
    expect(screen.getByText('Anh')).toBeInTheDocument()
    expect(screen.getByText('🎾 Tennis Siêu Lành Mạnh')).toBeInTheDocument()
    expect(scrollTo).toHaveBeenCalled()
    await waitFor(() => expect(fetch).toHaveBeenCalledWith(expect.stringMatching(/\/api\/init$/), expect.objectContaining({ credentials: 'include' })))
  })

  it('keeps explicit server confirmation on destructive React actions', async () => {
    const adminData = {
      ...initData,
      isAuthenticated: true,
      user: { id: 7, username: 'admin', role: 'admin', displayName: 'Admin' }
    }
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/init')) return new Response(JSON.stringify(adminData), { status: 200, headers: { 'Content-Type': 'application/json' } })
      if (url.includes('/rankings/')) return new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } })
      if (url.includes('/auth/users')) return new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } })
      if (url.includes('/cache-stats')) return new Response(JSON.stringify({ cacheStats: {} }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      if (url.includes('/admin/fcm/status')) return new Response(JSON.stringify({ status: {} }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      return new Response(JSON.stringify({ success: true }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    })
    vi.stubGlobal('fetch', fetchMock)
    render(<AppProvider><App /></AppProvider>)
    await screen.findByRole('heading', { name: /Bảng xếp hạng/i })
    const mainNavigation = screen.getByRole('navigation', { name: 'Điều hướng chính' })
    expect(within(mainNavigation).getAllByRole('button')).toHaveLength(6)
    expect(within(mainNavigation).queryByRole('button', { name: /Hình Ảnh/i })).not.toBeInTheDocument()
    fireEvent.click(within(mainNavigation).getByRole('button', { name: /Quản trị/i }))
    const managementNavigation = await screen.findByRole('navigation', { name: 'Quản trị' })
    fireEvent.click(within(managementNavigation).getByRole('button', { name: /Dữ Liệu/i }))
    expect(await screen.findByRole('heading', { name: /Xuất, sao lưu & khôi phục/i })).toBeInTheDocument()
    fireEvent.click(await screen.findByRole('button', { name: 'Xóa toàn bộ' }))
    expect(await screen.findByRole('dialog', { name: 'Xác nhận thao tác' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Xác nhận' }))

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      expect.stringMatching(/\/api\/clear-all-data$/),
      expect.objectContaining({ method: 'DELETE', body: JSON.stringify({ confirmClear: true }) })
    ))
  })
})
