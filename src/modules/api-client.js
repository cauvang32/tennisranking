/**
 * Unified HTTP client with CSRF injection and auth retry.
 * All feature modules route API calls through this single layer.
 */

import { getCSRFToken, makeAuthenticatedRequest } from '../modules/csrf-handler.js'

export function createApiClient(apiBase, csrfModule) {
  const base = apiBase

  async function request(path, options = {}) {
    const url = `${base}${path.startsWith('/') ? path : `/${path}`}`
    return makeAuthenticatedRequest(base, url, options)
  }

  async function get(path) {
    return request(path, { credentials: 'include' })
  }

  async function authenticated(path, options = {}) {
    return request(path, { credentials: 'include', ...options })
  }

  // ── Data loading ──────────────────────────────────────────────────────────

  async function loadInitData() {
    const res = await get('/init')
    return res.ok ? await res.json() : null
  }

  async function loadPlayers() {
    const res = await get('/players')
    return res.ok ? await res.json() : []
  }

  async function loadSeasons() {
    const res = await get('/seasons')
    return res.ok ? await res.json() : []
  }

  async function loadPlayDates() {
    const res = await get('/play-dates')
    return res.ok ? await res.json() : []
  }

  async function loadMatches(options = {}) {
    const { limit = 50, after = null } = options
    const params = new URLSearchParams({ limit: String(limit) })
    if (after) params.set('after', after)
    const res = await get(`/matches?${params}`)
    if (!res.ok) return { matches: [], cursor: null }
    const matches = await res.json()
    const cursor = res.headers.get('X-Next-Cursor')
    return { matches, cursor }
  }

  // ── Rankings ──────────────────────────────────────────────────────────────

  async function getRankings(mode, params = {}) {
    const qs = new URLSearchParams(params).toString()
    const res = await get(`/rankings/${mode}${qs ? '?' + qs : ''}`)
    return res.ok ? await res.json() : []
  }

  // ── Matches CRUD ──────────────────────────────────────────────────────────

  async function getMatchById(id) {
    const res = await get(`/matches/${id}`)
    return res.ok ? await res.json() : null
  }

  async function createMatch(data) {
    const res = await authenticated('/matches', { method: 'POST', body: JSON.stringify(data) })
    return res.ok ? await res.json() : null
  }

  async function updateMatch(id, data) {
    const res = await authenticated(`/matches/${id}`, { method: 'PUT', body: JSON.stringify(data) })
    return res.ok ? await res.json() : null
  }

  async function deleteMatch(id) {
    const res = await authenticated(`/matches/${id}`, { method: 'DELETE' })
    return res.ok ? await res.json() : null
  }

  async function bulkCreateMatches(matches) {
    const res = await authenticated('/matches/bulk-create', { method: 'POST', body: JSON.stringify({ matches }) })
    return res.ok ? await res.json() : null
  }

  async function parseImage(imageBase64, mimeType) {
    const res = await authenticated('/matches/parse-image', {
      method: 'POST', body: JSON.stringify({ imageBase64, mimeType })
    })
    return res.ok ? await res.json() : null
  }

  // ── Players ───────────────────────────────────────────────────────────────

  async function createPlayer(name) {
    const res = await authenticated('/players', { method: 'POST', body: JSON.stringify({ name }) })
    return res.ok ? await res.json() : null
  }

  async function deletePlayer(id) {
    const res = await authenticated(`/players/${id}`, { method: 'DELETE' })
    return res.ok ? await res.json() : null
  }

  // ── Seasons ───────────────────────────────────────────────────────────────

  async function createSeason(data) {
    const res = await authenticated('/seasons', { method: 'POST', body: JSON.stringify(data) })
    return res.ok ? await res.json() : null
  }

  async function updateSeason(id, data) {
    const res = await authenticated(`/seasons/${id}`, { method: 'PUT', body: JSON.stringify(data) })
    return res.ok ? await res.json() : null
  }

  async function endSeason(id, endDate) {
    const res = await authenticated(`/seasons/${id}/end`, { method: 'POST', body: JSON.stringify({ endDate }) })
    return res.ok ? await res.json() : null
  }

  async function reactivateSeason(id) {
    const res = await authenticated(`/seasons/${id}/reactivate`, { method: 'POST' })
    return res.ok ? await res.json() : null
  }

  async function deleteSeason(id) {
    const res = await authenticated(`/seasons/${id}`, { method: 'DELETE' })
    return res.ok ? await res.json() : null
  }

  async function getSeasonPlayers(seasonId) {
    const res = await get(`/seasons/${seasonId}/players`)
    return res.ok ? await res.json() : []
  }

  async function saveSeasonResults(seasonId, results) {
    const res = await authenticated(`/seasons/${seasonId}/results`, { method: 'PUT', body: JSON.stringify(results) })
    return res.ok ? await res.json() : null
  }

  // ── Export / Backup ───────────────────────────────────────────────────────

  async function exportExcel(mode) {
    return get(`/export-excel?mode=${mode}`)
  }

  async function backupJson() {
    const res = await get('/backup')
    return res.ok ? await res.json() : null
  }

  async function restoreJson(data) {
    const res = await authenticated('/restore', { method: 'POST', body: JSON.stringify(data) })
    return res.ok ? await res.json() : null
  }

  async function backupData() {
    const res = await get('/backup-data')
    return res.ok ? await res.json() : null
  }

  async function restoreData(data) {
    const res = await authenticated('/restore-data', { method: 'POST', body: JSON.stringify(data) })
    return res.ok ? await res.json() : null
  }

  async function clearAllData() {
    const res = await authenticated('/clear-all-data', { method: 'DELETE' })
    return res.ok ? await res.json() : null
  }

  // ── Cups ──────────────────────────────────────────────────────────────────

  async function getCups() {
    const res = await get('/cups')
    return res.ok ? await res.json() : []
  }

  async function createCup(data) {
    const res = await authenticated('/cups', { method: 'POST', body: JSON.stringify(data) })
    return res.ok ? await res.json() : null
  }

  async function updateCup(id, data) {
    const res = await authenticated(`/cups/${id}`, { method: 'PUT', body: JSON.stringify(data) })
    return res.ok ? await res.json() : null
  }

  async function deleteCup(id) {
    const res = await authenticated(`/cups/${id}`, { method: 'DELETE' })
    return res.ok ? await res.json() : null
  }

  async function getCupDetail(id) {
    const res = await get(`/cups/${id}`)
    return res.ok ? await res.json() : null
  }

  async function getCupMatches(id) {
    const res = await get(`/cups/${id}/matches`)
    return res.ok ? await res.json() : []
  }

  async function updateCupMatch(cupId, matchId, data) {
    const res = await authenticated(`/cups/${cupId}/matches/${matchId}`, { method: 'PUT', body: JSON.stringify(data) })
    return res.ok ? await res.json() : null
  }

  async function generateBracket(id) {
    const res = await authenticated(`/cups/${id}/generate-bracket`, { method: 'POST' })
    return res.ok ? await res.json() : null
  }

  async function getCupParticipants(id) {
    const res = await get(`/cups/${id}/participants`)
    return res.ok ? await res.json() : []
  }

  async function addCupParticipants(id, data) {
    const res = await authenticated(`/cups/${id}/participants`, { method: 'POST', body: JSON.stringify(data) })
    return res.ok ? await res.json() : null
  }

  async function removeCupParticipant(cupId, participantId) {
    const res = await authenticated(`/cups/${cupId}/participants/${participantId}`, { method: 'DELETE' })
    return res.ok ? await res.json() : null
  }

  async function getCupStatus(id) {
    const res = await get(`/cups/${id}/status`)
    return res.ok ? await res.json() : null
  }

  async function getCupAdvancements(id) {
    const res = await get(`/cups/${id}/advancements`)
    return res.ok ? await res.json() : []
  }

  // ── Users ─────────────────────────────────────────────────────────────────

  async function getUsers() {
    const res = await get('/users')
    return res.ok ? await res.json() : []
  }

  async function createUser(data) {
    const res = await authenticated('/users', { method: 'POST', body: JSON.stringify(data) })
    return res.ok ? await res.json() : null
  }

  async function updateUser(id, data) {
    const res = await authenticated(`/users/${id}`, { method: 'PUT', body: JSON.stringify(data) })
    return res.ok ? await res.json() : null
  }

  async function updatePassword(id, password) {
    const res = await authenticated(`/users/${id}/password`, { method: 'PUT', body: JSON.stringify({ password }) })
    return res.ok ? await res.json() : null
  }

  async function deleteUser(id) {
    const res = await authenticated(`/users/${id}`, { method: 'DELETE' })
    return res.ok ? await res.json() : null
  }

  // ── Admin / FCM ───────────────────────────────────────────────────────────

  async function getCacheStats() {
    const res = await get('/cache-stats')
    return res.ok ? await res.json() : null
  }

  async function getFcmStatus() {
    const res = await get('/admin/fcm/status')
    return res.ok ? await res.json() : null
  }

  async function controlFcm(action) {
    const res = await authenticated(`/admin/fcm/${action}`, { method: 'POST' })
    return res.ok ? await res.json() : null
  }

  async function sendFcmBroadcast(title, body) {
    const res = await authenticated('/admin/fcm/send', { method: 'POST', body: JSON.stringify({ title, body }) })
    return res.ok ? await res.json() : null
  }

  // ── Images ────────────────────────────────────────────────────────────────

  async function getSiteImages() {
    const res = await get('/images')
    return res.ok ? await res.json() : []
  }

  async function uploadImage(key, file, altText = '') {
    const formData = new FormData()
    formData.append('image', file)
    formData.append('altText', altText)
    const res = await authenticated(`/images/${key}`, { method: 'POST', body: formData })
    return res.ok ? await res.json() : null
  }

  async function deleteImage(key) {
    const res = await authenticated(`/images/${key}`, { method: 'DELETE' })
    return res.ok ? await res.json() : null
  }

  async function updateImageMeta(key, meta) {
    const res = await authenticated(`/images/${key}/meta`, { method: 'PUT', body: JSON.stringify(meta) })
    return res.ok ? await res.json() : null
  }

  async function migrateHero() {
    const res = await authenticated('/images/migrate-hero', { method: 'POST' })
    return res.ok ? await res.json() : null
  }

  async function uploadSeasonConclusion(seasonId, file) {
    const formData = new FormData()
    formData.append('image', file)
    formData.append('seasonId', seasonId)
    const res = await authenticated(`/images/season/${seasonId}/conclusion`, { method: 'POST', body: formData })
    return res.ok ? await res.json() : null
  }

  async function deleteConclusionImage(seasonId) {
    const res = await authenticated(`/images/season/${seasonId}/conclusion`, { method: 'DELETE' })
    return res.ok ? await res.json() : null
  }

  return {
    get, authenticated, request,
    loadInitData, loadPlayers, loadSeasons, loadPlayDates, loadMatches,
    getRankings,
    getMatchById, createMatch, updateMatch, deleteMatch, bulkCreateMatches, parseImage,
    createPlayer, deletePlayer,
    createSeason, updateSeason, endSeason, reactivateSeason, deleteSeason, getSeasonPlayers, saveSeasonResults,
    exportExcel, backupJson, restoreJson, backupData, restoreData, clearAllData,
    getCups, createCup, updateCup, deleteCup, getCupDetail, getCupMatches,
    updateCupMatch, generateBracket, getCupParticipants, addCupParticipants,
    removeCupParticipant, getCupStatus, getCupAdvancements,
    getUsers, createUser, updateUser, updatePassword, deleteUser,
    getCacheStats, getFcmStatus, controlFcm, sendFcmBroadcast,
    getSiteImages, uploadImage, deleteImage, updateImageMeta, migrateHero,
    uploadSeasonConclusion, deleteConclusionImage
  }
}
