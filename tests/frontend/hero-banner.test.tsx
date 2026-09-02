// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AppProvider } from '../../src/app/app-context'
import { HeroBanner } from '../../src/components/HeroBanner'

const initData = {
  lifetimeRankings: [],
  players: [],
  seasons: [],
  activeSeasons: [],
  playDates: [],
  activeSeason: null,
  defaultDate: null,
  defaultDateRankings: [],
  defaultDateMatches: [],
  version: 1,
  isAuthenticated: false,
  user: null,
  csrfToken: 'test-csrf'
}

function mockFetchWithImages(images: unknown) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.endsWith('/init')) return new Response(JSON.stringify(initData), { status: 200, headers: { 'Content-Type': 'application/json' } })
    if (url.includes('/images')) return new Response(JSON.stringify(images), { status: 200, headers: { 'Content-Type': 'application/json' } })
    return new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } })
  })
}

describe('HeroBanner', () => {
  beforeEach(() => { vi.stubGlobal('EventSource', class { close = vi.fn() }) })
  afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

  it('renders nothing when no active hero banner is set', async () => {
    vi.stubGlobal('fetch', mockFetchWithImages([]))
    render(<AppProvider><HeroBanner /></AppProvider>)
    await waitFor(() => expect(screen.queryByRole('img')).not.toBeInTheDocument())
    expect(document.querySelector('.hero-banner')).toBeNull()
  })

  it('renders the uploaded cover image at the top with a cache-busted URL', async () => {
    vi.stubGlobal('fetch', mockFetchWithImages([
      { key: 'hero_banner', is_active: true, alt_text: 'Bìa CLB', updated_at: '2026-09-02T10:00:00.000Z' }
    ]))
    render(<AppProvider><HeroBanner /></AppProvider>)
    const img = await screen.findByRole('img', { name: /Bìa CLB/i })
    expect(img).toHaveClass('hero-banner-image')
    expect(img.getAttribute('src')).toContain('/images/hero_banner/file?v=2026-09-02T10')
    expect(document.querySelector('.hero-banner')).not.toBeNull()
  })

  it('hides an inactive hero banner row', async () => {
    vi.stubGlobal('fetch', mockFetchWithImages([
      { key: 'hero_banner', is_active: false, alt_text: 'Bìa CLB', updated_at: '2026-09-02T10:00:00.000Z' }
    ]))
    render(<AppProvider><HeroBanner /></AppProvider>)
    await waitFor(() => expect(screen.queryByRole('img')).not.toBeInTheDocument())
  })
})