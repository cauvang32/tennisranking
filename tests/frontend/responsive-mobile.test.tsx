// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { App } from '../../src/app/App'
import { AppProvider } from '../../src/app/app-context'

const initData = {
  lifetimeRankings: [],
  players: [{ id: 1, name: 'Anh' }],
  seasons: [{ id: 1, name: 'Mùa 2026', start_date: '2026-01-01', end_date: null, is_active: true, auto_end: false, lose_money_per_loss: 20000 }],
  activeSeasons: [],
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

describe('mobile responsive markup', () => {
  beforeEach(() => {
    window.history.replaceState(null, '', '#rankings')
    vi.stubGlobal('scrollTo', vi.fn())
    vi.stubGlobal('EventSource', EventSourceStub)
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/init')) return new Response(JSON.stringify(initData), { status: 200, headers: { 'Content-Type': 'application/json' } })
      if (url.includes('/rankings/')) return new Response(JSON.stringify(initData.defaultDateRankings), { status: 200, headers: { 'Content-Type': 'application/json' } })
      return new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } })
    }))
  })

  afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

  it('marks the rankings table for stacked mobile rows with a label per cell', async () => {
    render(<AppProvider><App /></AppProvider>)
    await screen.findByRole('heading', { name: /Bảng xếp hạng/i })
    await waitFor(() => expect(screen.getByRole('table')).toBeInTheDocument())
    const table = screen.getByRole('table')
    expect(table.parentElement).toHaveClass('responsive-table')
    const cells = table.querySelectorAll('td')
    expect(cells.length).toBeGreaterThan(0)
    for (const cell of Array.from(cells)) expect(cell).toHaveAttribute('data-label')
  })

  it('keeps the players table stacked on mobile', async () => {
    render(<AppProvider><App /></AppProvider>)
    fireEvent.click(await screen.findByRole('button', { name: /Người Chơi/i }))
    await screen.findByRole('heading', { name: /Quản lý người chơi/i })
    await waitFor(() => expect(screen.getByRole('table')).toBeInTheDocument())
    const table = screen.getByRole('table')
    expect(table.parentElement).toHaveClass('responsive-table')
    const cells = table.querySelectorAll('td')
    expect(cells.length).toBeGreaterThan(0)
    for (const cell of Array.from(cells)) expect(cell).toHaveAttribute('data-label')
  })

  it('declares mobile browser meta tags in the HTML shell', () => {
    const html = readFileSync(path.join(process.cwd(), 'index.html'), 'utf8')
    expect(html).toMatch(/name="viewport"\s+content="width=device-width/)
    expect(html).toMatch(/name="theme-color"/)
    expect(html).toMatch(/apple-mobile-web-app-capable/)
  })
})