export type UserRole = 'admin' | 'editor' | 'viewer'
export type MatchType = 'solo' | 'duo'
export type ViewMode = 'daily' | 'season' | 'lifetime'
export type CupStatus = 'draft' | 'scheduled' | 'in_progress' | 'completed' | 'cancelled'
export type CupFormat = 'single_elimination' | 'double_elimination' | 'round_robin'

export interface AuthUser {
  id?: number
  username: string
  email?: string | null
  role: UserRole
  displayName?: string | null
  display_name?: string | null
  tokenVersion?: number
}

export interface Player {
  id: number
  name: string
  created_at?: string
}

export interface Season {
  id: number
  name: string
  start_date: string
  end_date: string | null
  is_active: boolean
  auto_end: boolean
  description?: string | null
  lose_money_per_loss: number
  final_results?: string | null
  conclusion_image_path?: string | null
  conclusion_image_filename?: string | null
  created_at?: string
}

export interface Match {
  id: number
  season_id: number
  season_name?: string
  play_date: string
  match_type: MatchType
  player1_id: number
  player2_id: number | null
  player3_id: number
  player4_id: number | null
  player1_name?: string
  player2_name?: string | null
  player3_name?: string
  player4_name?: string | null
  team1_score: number
  team2_score: number
  winning_team: 1 | 2
  win_money?: number
  lose_money?: number
  created_at?: string
}

export interface MatchInput {
  seasonId: number
  playDate: string
  player1Id: number
  player2Id: number | null
  player3Id: number
  player4Id: number | null
  team1Score: number
  team2Score: number
  winningTeam: 1 | 2
  matchType: MatchType
}

export interface Ranking {
  id?: number
  player_id?: number
  name?: string
  player_name?: string
  wins: number
  losses: number
  total_matches?: number
  matches_played?: number
  points: number
  win_rate?: number | string
  win_percentage?: number | string
  money?: number | string
  money_lost?: number | string
  total_money?: number | string
  form?: Array<'win' | 'loss' | 'W' | 'L' | { result: 'win' | 'loss' | 'W' | 'L'; play_date?: string }>
  rank?: number
}

export interface CupParticipant {
  id: number
  cup_id?: number
  player1_id: number
  player2_id: number | null
  player1_name?: string
  player2_name?: string | null
  team_name?: string | null
  seed?: number | null
}

export interface CupMatch {
  id: number
  cup_id: number
  round_number: number
  match_number?: number
  participant1_id: number | null
  participant2_id: number | null
  team1_participant_id?: number | null
  team2_participant_id?: number | null
  participant1_name?: string | null
  participant2_name?: string | null
  team1_name?: string | null
  team2_name?: string | null
  t1_p1_name?: string | null
  t1_p2_name?: string | null
  t1_team_name?: string | null
  t2_p1_name?: string | null
  t2_p2_name?: string | null
  t2_team_name?: string | null
  team1_score?: number | null
  team2_score?: number | null
  winner_participant_id?: number | null
  status?: string
  play_date?: string | null
}

export interface Cup {
  id: number
  name: string
  season_id: number | null
  season_name?: string | null
  format: CupFormat
  num_teams: number
  status: CupStatus
  regulation_text?: string | null
  start_date?: string | null
  end_date?: string | null
  final_results?: string | null
  conclusion_image_path?: string | null
  created_at?: string
  participants?: CupParticipant[]
  bracket?: CupMatch[]
}

export interface ManagedUser extends AuthUser {
  id: number
  is_active: boolean
  notes?: string | null
  last_login?: string | null
  created_at?: string
}

export interface SiteImage {
  key: string
  filename?: string
  alt_text?: string
  is_active?: boolean
  file_size?: number
  content_type?: string
  updated_at?: string
}

export interface ApiErrorBody {
  error?: string
  message?: string
  code?: string
  details?: unknown
}

export interface ApiSuccess<T = unknown> {
  success: true
  data?: T
  id?: number
  message?: string
}
