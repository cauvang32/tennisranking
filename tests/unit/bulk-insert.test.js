import { describe, it, expect } from 'vitest'
import { buildBulkInsert } from '../../utils/bulk-insert.js'

const COLUMNS = [
  { name: 'season_id' },
  { name: 'play_date' },
  { name: 'player1_id' },
  { name: 'created_at', expr: (p) => `COALESCE(${p}, now())` }
]

describe('buildBulkInsert', () => {
  it('builds a single-row INSERT with $1 placeholders in column order', () => {
    const { text, params } = buildBulkInsert('matches', COLUMNS, [[1, '2026-01-01', 7, null]])
    expect(text).toBe(
      "INSERT INTO matches (season_id, play_date, player1_id, created_at) VALUES ($1, $2, $3, COALESCE($4, now()))"
    )
    expect(params).toEqual([1, '2026-01-01', 7, null])
  })

  it('numbers placeholders sequentially across rows', () => {
    const { text, params } = buildBulkInsert('matches', COLUMNS, [
      [1, '2026-01-01', 7, null],
      [2, '2026-01-02', 8, '2026-01-02T10:00:00Z']
    ])
    expect(text).toBe(
      "INSERT INTO matches (season_id, play_date, player1_id, created_at) VALUES " +
      '($1, $2, $3, COALESCE($4, now())), ($5, $6, $7, COALESCE($8, now()))'
    )
    expect(params).toEqual([1, '2026-01-01', 7, null, 2, '2026-01-02', 8, '2026-01-02T10:00:00Z'])
  })

  it('flattens params in row-major order matching tuple order', () => {
    const cols = [{ name: 'a' }, { name: 'b' }]
    const { params } = buildBulkInsert('t', cols, [[1, 2], [3, 4], [5, 6]])
    expect(params).toEqual([1, 2, 3, 4, 5, 6])
  })

  it('applies the per-column expr transform with the correct placeholder', () => {
    const { text } = buildBulkInsert('matches', COLUMNS, [[1, '2026-01-01', 7, '2026-01-01T00:00:00Z']])
    expect(text).toContain('COALESCE($4, now())')
  })

  it('supports single-column tables', () => {
    const { text, params } = buildBulkInsert('players', [{ name: 'name' }], [['A'], ['B']])
    expect(text).toBe('INSERT INTO players (name) VALUES ($1), ($2)')
    expect(params).toEqual(['A', 'B'])
  })

  it('throws on empty rows', () => {
    expect(() => buildBulkInsert('matches', COLUMNS, [])).toThrow('at least one row')
    expect(() => buildBulkInsert('matches', COLUMNS, undefined)).toThrow('at least one row')
    expect(() => buildBulkInsert('matches', COLUMNS, 'nope')).toThrow('at least one row')
  })

  it('throws when a row has the wrong number of values', () => {
    expect(() => buildBulkInsert('matches', COLUMNS, [[1, '2026-01-01']])).toThrow('expected 4')
    expect(() => buildBulkInsert('matches', COLUMNS, [[1, '2026-01-01', 7, null, 'extra']])).toThrow('expected 4')
    expect(() => buildBulkInsert('matches', COLUMNS, ['not-an-array'])).toThrow('values')
  })

  it('preserves null/undefined values as parameters', () => {
    const { params } = buildBulkInsert('matches', COLUMNS, [[1, '2026-01-01', 7, undefined]])
    expect(params[3]).toBeUndefined()
  })
})
