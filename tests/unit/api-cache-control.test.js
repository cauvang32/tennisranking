import { describe, expect, it, vi } from 'vitest'
import { privateApiCacheControl } from '../../middleware/api-cache-control.js'

describe('private API cache control', () => {
  it('never returns a conditional response before authorization', () => {
    const headers = new Map()
    const req = { headers: { 'if-none-match': 'W/"v-admin"' } }
    const res = {
      setHeader: vi.fn((name, value) => headers.set(name, value)),
      status: vi.fn(() => res),
      end: vi.fn()
    }
    const next = vi.fn()

    privateApiCacheControl(req, res, next)

    expect(headers.get('Cache-Control')).toContain('no-store')
    expect(headers.get('Vary')).toContain('Cookie')
    expect(next).toHaveBeenCalledOnce()
    expect(res.status).not.toHaveBeenCalled()
    expect(res.end).not.toHaveBeenCalled()
  })
})
