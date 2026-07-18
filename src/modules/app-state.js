/**
 * Reactive state store for the Tennis Ranking System.
 * Centralized state with event emission — modules subscribe to changes
 * instead of polling or sharing mutable references.
 */

export function createAppState() {
  const state = {
    players: [], matches: [], seasons: [], playDates: [],
    apiBase: null, isAuthenticated: false, user: null, csrfToken: null,
    serverMode: true,
    currentViewMode: 'daily', selectedDate: null, selectedSeason: null,
    activeTab: 'rankings',
    currentMatchType: 'duo', isManualWinnerMode: false, currentWinningTeam: null,
    currentSeasonPlayers: [], selectedMatchSeason: null, seasonPlayers: [],
    batchMatches: [], batchMatchId: 0, batchMatchType: 'duo',
    parsedMatchesBuffer: [],
    normalizedPlayers: []
  }

  const listeners = new Map()

  function emit(key, value) {
    const fns = listeners.get(key)
    if (fns) for (const fn of fns) fn(value)
  }

  function emitAll() {
    const fns = listeners.get('*')
    if (fns) for (const fn of fns) fn({ ...state })
  }

  return {
    get(key) { return state[key] },
    set(key, value) {
      const old = state[key]
      state[key] = value
      if (old !== value) {
        emit(key, value)
        emitAll()
      }
    },
    on(event, fn) {
      if (!listeners.has(event)) listeners.set(event, [])
      listeners.get(event).push(fn)
      return () => this.off(event, fn)
    },
    off(event, fn) {
      const fns = listeners.get(event)
      if (fns) {
        const idx = fns.indexOf(fn)
        if (idx !== -1) fns.splice(idx, 1)
      }
    },
    subscribe(fn) { return this.on('*', fn) },
    get state() { return state }
  }
}
