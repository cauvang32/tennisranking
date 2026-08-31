import { afterEach, describe, expect, it } from 'vitest'
import express from 'express'
import { validationResult } from 'express-validator'

// Set required env vars before importing modules (config/env.ts exits if absent).
process.env.ADMIN_USERNAME = 'test_admin'
process.env.ADMIN_PASSWORD = 'test_password'
process.env.EDITOR_USERNAME = 'test_editor'
process.env.EDITOR_PASSWORD = 'test_password'
process.env.JWT_SECRET = 'test_jwt_secret_at_least_32_characters_long_xyz'
process.env.CSRF_SECRET = 'test_csrf_secret_at_least_32_characters_long_xyz'

const { createCupRouter } = await import('../../routes/cups.js')

// Minimal stand-ins for the cross-cutting helpers server.ts normally injects.
const handleValidationErrors = (req, res, next) => {
  const errors = validationResult(req)
  if (!errors.isEmpty()) {
    const [err] = errors.array()
    return res.status(400).json({ error: err.msg, validationError: true })
  }
  return next()
}
const sanitizeResponse = (data) => data
const adminAuth = (req, _res, next) => { req.user = { username: 'admin', role: 'admin' }; next() }
const noopLimiter = (_req, _res, next) => next()
const makeCache = () => ({
  getOrSet: async (_k, fn) => ({ data: await fn(), hit: false }),
  invalidateByPrefix: async () => {},
  incrementVersion: async () => {},
})

let server
let base
const startApp = (db) => new Promise<void>((resolve) => {
  const app = express()
  app.use(express.json())
  app.use('/api/cups', createCupRouter({
    db,
    checkAuth: adminAuth,
    authenticateToken: adminAuth,
    requireAdmin: adminAuth,
    requireEditor: adminAuth,
    conditionalRateLimit: () => noopLimiter,
    createLimiter: () => noopLimiter,
    deleteLimiter: () => noopLimiter,
    handleValidationErrors,
    rankingsCache: makeCache(),
    sanitizeResponse,
  }))
  server = app.listen(0, () => { base = `http://127.0.0.1:${server.address().port}`; resolve() })
})
afterEach(async () => { await new Promise((r) => server.close(r)) })

const post = (path, body) => fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
const put = (path, body) => fetch(`${base}${path}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

describe('cup creation: team count', () => {
  it('rejects a non-power-of-two team count', async () => {
    let created = false
    await startApp({ createCup: async () => { created = true; return 99 }, updateCup: async () => {} })
    const res = await post('/api/cups', { name: 'Cúp X', format: 'single_elimination', numTeams: 6 })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.validationError).toBe(true)
    expect(created).toBe(false)
  })

  it('accepts a power-of-two team count', async () => {
    let created = false
    await startApp({ createCup: async () => { created = true; return 99 }, updateCup: async () => {} })
    const res = await post('/api/cups', { name: 'Cúp X', format: 'single_elimination', numTeams: 8 })
    expect(res.status).toBe(201)
    expect(created).toBe(true)
  })
})

describe('cup match edits: participant-assignment guard', () => {
  // A round-2 match whose teams have not yet been assigned by advancing round 1
  // must not be editable — otherwise it gets recorded "completed" with no winner
  // and advanceRound() later throws "No winners to advance".
  it('blocks saving a score on a match with unassigned teams', async () => {
    let scored = false
    await startApp({
      getCupById: async () => ({ id: 5, status: 'in_progress' }),
      getCupMatchById: async () => ({ id: 7, round_number: 2, match_number: 1, status: 'scheduled', team1_participant_id: null, team2_participant_id: null }),
      areAllMatchesInRoundCompleted: async () => true,
      updateCupMatchScore: async () => { scored = true; return { success: true, winnerId: null, roundComplete: false } },
    })
    const res = await put('/api/cups/5/matches/7', { team1Score: 3, team2Score: 1 })
    expect(res.status).toBe(400)
    expect(scored).toBe(false)
  })

  it('allows saving a score once both teams are assigned', async () => {
    let scored = false
    await startApp({
      getCupById: async () => ({ id: 5, status: 'in_progress' }),
      getCupMatchById: async (mid) => ({ id: mid, round_number: 2, match_number: 1, status: 'completed', team1_participant_id: 1, team2_participant_id: 2, winner_participant_id: null }),
      areAllMatchesInRoundCompleted: async (_cupId, round) => round === 1,
      updateCupMatchScore: async () => { scored = true; return { success: true, winnerId: 1, roundComplete: true } },
    })
    const res = await put('/api/cups/5/matches/7', { team1Score: 3, team2Score: 1 })
    expect(res.status).toBe(200)
    expect(scored).toBe(true)
  })

  it('blocks picking a winner on a match with unassigned teams', async () => {
    let won = false
    await startApp({
      getCupById: async () => ({ id: 5, status: 'in_progress' }),
      getCupMatchById: async () => ({ id: 9, round_number: 2, match_number: 1, status: 'scheduled', team1_participant_id: null, team2_participant_id: null }),
      areAllMatchesInRoundCompleted: async () => true,
      setCupMatchWinner: async () => { won = true; return { success: true, winnerId: 1 } },
    })
    const res = await put('/api/cups/5/matches/9/winner', { winnerParticipantId: 1 })
    expect(res.status).toBe(400)
    expect(won).toBe(false)
  })

  it('blocks setting a date on a match with unassigned teams', async () => {
    let dated = false
    await startApp({
      getCupById: async () => ({ id: 5, status: 'in_progress' }),
      getCupMatchById: async () => ({ id: 8, round_number: 2, match_number: 1, status: 'scheduled', team1_participant_id: null, team2_participant_id: null }),
      areAllMatchesInRoundCompleted: async () => true,
      updateCupMatchDate: async () => { dated = true },
    })
    const res = await put('/api/cups/5/matches/8/date', { playDate: '2026-09-01T00:00:10.000Z' })
    expect(res.status).toBe(400)
    expect(dated).toBe(false)
  })
})