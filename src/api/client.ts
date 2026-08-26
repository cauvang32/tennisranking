import type {
  ApiErrorBody,
  AuthUser,
  Cup,
  CupMatch,
  CupParticipant,
  ManagedUser,
  Match,
  MatchInput,
  Player,
  Ranking,
  Season,
  SiteImage,
  ViewMode
} from '../../shared/domain'

export class ApiError extends Error {
  constructor(message: string, public readonly status: number, public readonly body?: ApiErrorBody) {
    super(message)
  }
}

export interface InitData {
  lifetimeRankings: Ranking[]
  players: Player[]
  seasons: Season[]
  activeSeasons: Season[]
  playDates: string[]
  activeSeason: Season | null
  defaultDate: string | null
  defaultDateRankings: Ranking[]
  defaultDateMatches: Match[]
  version: number
  isAuthenticated: boolean
  user: AuthUser | null
  csrfToken: string
}

type RawPlayDate = string | { play_date?: string | null }
type RawInitData = Omit<InitData, 'playDates'> & { playDates?: RawPlayDate[] }

function normalizePlayDates(values: RawPlayDate[] | undefined): string[] {
  return (values || [])
    .map(value => typeof value === 'string' ? value : value.play_date || '')
    .filter((value): value is string => Boolean(value))
}

interface LoginResult {
  success: boolean
  message: string
  user?: AuthUser
  csrfToken?: string
}

export function getApiBase(): string {
  const base = import.meta.env.BASE_URL || '/'
  const normalized = base.endsWith('/') ? base.slice(0, -1) : base
  return `${window.location.origin}${normalized}/api`.replace(/([^:]\/)\/+/g, '$1')
}

class ApiClient {
  private csrfToken: string | null = null
  private refreshPromise: Promise<boolean> | null = null

  constructor(public readonly baseUrl = getApiBase()) {}

  setCsrfToken(token: string | null | undefined) {
    this.csrfToken = token || null
  }

  private url(path: string): string {
    const normalized = path.startsWith('/') ? path : `/${path}`
    return `${this.baseUrl}${normalized}`
  }

  private async readError(response: Response): Promise<ApiError> {
    const body = await response.json().catch(() => ({})) as ApiErrorBody
    return new ApiError(body.error || body.message || `HTTP ${response.status}`, response.status, body)
  }

  async getCsrfToken(force = false): Promise<string> {
    if (this.csrfToken && !force) return this.csrfToken
    const response = await fetch(this.url('/csrf-token'), { credentials: 'include' })
    if (!response.ok) throw await this.readError(response)
    const data = await response.json() as { csrfToken: string }
    this.csrfToken = data.csrfToken
    return data.csrfToken
  }

  private async refresh(): Promise<boolean> {
    if (this.refreshPromise) return this.refreshPromise
    this.refreshPromise = (async () => {
      const response = await fetch(this.url('/auth/refresh'), { method: 'POST', credentials: 'include' })
      if (!response.ok) return false
      const data = await response.json() as { success?: boolean; csrfToken?: string }
      this.setCsrfToken(data.csrfToken)
      return Boolean(data.success)
    })().finally(() => { this.refreshPromise = null })
    return this.refreshPromise
  }

  async request<T>(path: string, options: RequestInit = {}, retry = true): Promise<T> {
    const method = (options.method || 'GET').toUpperCase()
    const mutating = !['GET', 'HEAD', 'OPTIONS'].includes(method)
    const isFormData = options.body instanceof FormData
    const headers = new Headers(options.headers)
    headers.set('Accept', 'application/json')
    if (!isFormData && options.body !== undefined) headers.set('Content-Type', 'application/json')
    if (mutating) headers.set('X-CSRF-Token', await this.getCsrfToken())

    const response = await fetch(this.url(path), {
      ...options,
      credentials: 'include',
      headers
    })

    if ((response.status === 401 || response.status === 403) && retry && await this.refresh()) {
      await this.getCsrfToken(true)
      return this.request<T>(path, options, false)
    }
    if (!response.ok) throw await this.readError(response)
    if (response.status === 204) return undefined as T
    const contentType = response.headers.get('content-type') || ''
    return contentType.includes('application/json') ? response.json() as Promise<T> : response as T
  }

  async login(username: string, password: string): Promise<LoginResult> {
    const setup = await fetch(this.url('/auth/login'), { credentials: 'include' })
    if (!setup.ok) return { success: false, message: 'Không thể khởi tạo phiên đăng nhập' }
    const { loginCsrf } = await setup.json() as { loginCsrf: string }
    const csrfToken = await this.getCsrfToken(true)
    const response = await fetch(this.url('/auth/login'), {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
      body: JSON.stringify({ username, password, _loginCsrf: loginCsrf, _csrf: csrfToken })
    })
    const data = await response.json().catch(() => ({})) as LoginResult & ApiErrorBody
    if (!response.ok) return { success: false, message: data.error || data.message || 'Đăng nhập thất bại' }
    this.setCsrfToken(data.csrfToken)
    return data
  }

  async logout(): Promise<void> {
    try { await this.request('/auth/logout', { method: 'POST' }, false) } finally { this.csrfToken = null }
  }

  init = async (): Promise<InitData> => {
    const data = await this.request<RawInitData>('/init')
    return { ...data, playDates: normalizePlayDates(data.playDates) }
  }
  players = () => this.request<Player[]>('/players')
  seasons = () => this.request<Season[]>('/seasons')
  seasonPlayers = (id: number) => this.request<Player[]>(`/seasons/${id}/players`)
  playDates = async () => normalizePlayDates(await this.request<RawPlayDate[]>('/play-dates'))
  matchesByDate = (date: string) => this.request<Match[]>(`/matches/by-date/${encodeURIComponent(date)}`)
  matchesBySeason = (id: number) => this.request<Match[]>(`/matches/by-season/${id}`)
  match = (id: number) => this.request<Match>(`/matches/${id}`)
  rankings = (mode: ViewMode, value?: string | number) => {
    const path = mode === 'lifetime' ? '/rankings/lifetime' : mode === 'season'
      ? `/rankings/season/${value}` : `/rankings/date/${value}`
    return this.request<Ranking[]>(path)
  }
  cups = () => this.request<Cup[]>('/cups')
  cup = (id: number) => this.request<Cup>(`/cups/${id}`)
  cupBracket = (id: number) => this.request<CupMatch[]>(`/cups/${id}/bracket`)
  cupParticipants = (id: number) => this.request<CupParticipant[]>(`/cups/${id}/participants`)
  users = () => this.request<ManagedUser[]>('/auth/users')
  images = () => this.request<SiteImage[]>('/images')

  mutate = <T = unknown>(path: string, method: 'POST' | 'PUT' | 'DELETE', body?: unknown) =>
    this.request<T>(path, { method, body: body === undefined ? undefined : JSON.stringify(body) })

  saveMatch = (data: MatchInput, id?: number) => this.mutate(`/matches${id ? `/${id}` : ''}`, id ? 'PUT' : 'POST', data)

  async upload<T>(path: string, file: File, fields: Record<string, string> = {}): Promise<T> {
    const form = new FormData()
    form.append('image', file)
    Object.entries(fields).forEach(([key, value]) => form.append(key, value))
    return this.request<T>(path, { method: 'POST', body: form })
  }

  async download(path: string, filename: string): Promise<void> {
    const response = await this.request<Response>(path)
    const blob = await response.blob()
    const href = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = href
    anchor.download = filename
    anchor.click()
    URL.revokeObjectURL(href)
  }
}

export const api = new ApiClient()
