import { useEffect, useMemo, useState, type ChangeEvent, type FormEvent } from 'react'
import type { Match, MatchInput, MatchType, Player, Season } from '../../../shared/domain'
import { api } from '../../api/client'
import { ConfirmButton, Empty, Loading, PageHeader, Panel, errorMessage, formatDate } from '../../components/common'
import { useApp } from '../../app/app-context'
import { Icon } from '../../components/icons'

const today = () => new Date().toISOString().slice(0, 10)

function blankMatch(seasonId = 0, playDate = today(), matchType: MatchType = 'duo'): MatchInput {
  return { seasonId, playDate, player1Id: 0, player2Id: null, player3Id: 0, player4Id: null, team1Score: 0, team2Score: 0, winningTeam: 1, matchType }
}

function PlayerSelect({ value, players, onChange, label }: { value: number | null; players: Player[]; onChange: (id: number | null) => void; label: string }) {
  return <label className="form-group">{label}<select required value={value || ''} onChange={e => onChange(e.target.value ? Number(e.target.value) : null)}><option value="">-- Chọn --</option>{players.map(player => <option key={player.id} value={player.id}>{player.name}</option>)}</select></label>
}

function winnerFromScores(team1Score: number, team2Score: number, fallback: 1 | 2): 1 | 2 {
  return team1Score === team2Score ? fallback : team1Score > team2Score ? 1 : 2
}

// Vietnamese accent-stripping: NFD decomposition drops the combining marks,
// then we lowercase and strip anything that is not a-z0-9. (Mirrors the
// pre-migration ACCENT_MAP-based normalizer but far shorter.)
function normalizeName(value: string): string {
  // Keep spaces so multi-word names stay splittable; drop other punctuation.
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9 ]/g, '')
}

// Word-level scoring used by mapTeamNameToPair: how well one normalized word
// covers one normalized player name (exact/last/first/substring/prefix).
function scoreWordAgainstPlayer(word: string, playerNorm: string): number {
  if (word === playerNorm) return 10
  const playerWords = playerNorm.split(/\s+/)
  const last = playerWords[playerWords.length - 1]!
  if (playerWords.length > 0 && word === last) return 10
  if (playerWords.length > 0 && word === playerWords[0]!) return 7
  if (playerNorm.includes(word)) return 7
  if (last.startsWith(word)) return 5
  if (word.startsWith(last)) return 5
  return 0
}

function levenshtein(a: string, b: string): number {
  const m = a.length; const n = b.length
  if (!m) return n; if (!n) return m
  let prev: number[] = Array.from({ length: n + 1 }, (_, i) => i)
  for (let i = 1; i <= m; i++) {
    const cur: number[] = new Array<number>(n + 1); cur[0] = i
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1))
    }
    prev = cur
  }
  return prev[n] ?? 0
}

/**
 * Split an AI-returned *team* name into up to two individual players.
 * The AI prompt forces player2Name/player4Name to null, so for a 2v2 match the
 * model returns each side as one string (e.g. "Anh Tú & Dũng"). Score every
 * roster player against the team words, then pick the best disjoint pair (or a
 * single player if only one matches). Returns ids or nulls for unfilled slots.
 */
function mapTeamNameToPair(teamName: string | null | undefined, players: { id: number; norm: string }[]): { p1: number | null; p2: number | null } {
  const normalized = normalizeName(teamName || '').trim()
  if (!normalized) return { p1: null, p2: null }
  const words = normalized.split(/\s+/).filter(Boolean)
  if (!words.length) return { p1: null, p2: null }
  const candidates = players
    .map(entry => ({ id: entry.id, score: words.reduce((sum, w) => sum + scoreWordAgainstPlayer(w, entry.norm), 0) }))
    .filter(entry => entry.score > 0)
  if (!candidates.length) return { p1: null, p2: null }
  candidates.sort((a, b) => b.score - a.score)
  // Single player covers all words → 1v1-ish result, leave partner empty.
  const top = candidates[0]!
  const coveredBy = (id: number) => {
    const norm = players.find(entry => entry.id === id)!.norm
    let covered = 0
    for (const w of words) if (scoreWordAgainstPlayer(w, norm) > 0) covered++
    return covered
  }
  if (candidates.length === 1 || coveredBy(top.id) === words.length && candidates.length <= 2) {
    if (words.length === 1 && candidates.length <= 2) return { p1: top.id, p2: null }
  }
  let bestPair: { p1: number | null; p2: number | null } | null = null
  let bestTotal = -1
  for (let i = 0; i < candidates.length; i++) {
    for (let j = i + 1; j < candidates.length; j++) {
      const a = candidates[i]!, b = candidates[j]!
      const normA = players.find(entry => entry.id === a.id)!.norm
      const normB = players.find(entry => entry.id === b.id)!.norm
      let covered = 0
      for (const w of words) if (scoreWordAgainstPlayer(w, normA) > 0 || scoreWordAgainstPlayer(w, normB) > 0) covered++
      const total = a.score + b.score + (covered === words.length ? 20 : 0)
      if (total > bestTotal) { bestTotal = total; bestPair = { p1: a.id, p2: b.id } }
    }
  }
  if (bestPair && bestTotal >= words.length * 3) return bestPair
  return { p1: top.id, p2: null }
}

function validate(input: MatchInput): string | null {
  const ids = input.matchType === 'solo' ? [input.player1Id, input.player3Id] : [input.player1Id, input.player2Id, input.player3Id, input.player4Id]
  if (!input.seasonId || !input.playDate || ids.some(id => !id)) return 'Vui lòng nhập đầy đủ mùa giải, ngày và người chơi'
  if (new Set(ids).size !== ids.length) return 'Mỗi vị trí phải là một người chơi khác nhau'
  if (input.team1Score < 0 || input.team2Score < 0) return 'Tỷ số không hợp lệ'
  return null
}

interface ParsedMatch {
  player1Name: string
  player2Name?: string | null
  player3Name: string
  player4Name?: string | null
  team1Score: number
  team2Score: number
  winningTeam: 1 | 2
  matchType: MatchType
}

// Editable AI-parsed match card. After parsing, each row is a full MatchInput
// pre-filled by fuzzyMatchPlayer; the user fixes players/score/winner/date
// before confirming. (Restores the pre-migration editable preview.)
function ParsedMatchCard({ match, players, seasons, onPatch, onRemove, defaultSeasonId }: {
  match: MatchInput; players: Player[]; seasons: Season[];
  onPatch: (patch: Partial<MatchInput>) => void; onRemove: () => void; defaultSeasonId: number
}) {
  const name = (id: number | null) => players.find(p => p.id === id)?.name || ''
  const selectClass = 'select-field'
  const inputClass = 'input-field'
  return (
    <div className="match-card parsed-match-card">
      <div className="match-card-header">
        <span className="match-type-badge">{match.matchType === 'solo' ? '1v1' : '2v2'}</span>
        <button type="button" className="btn btn-sm btn-danger" onClick={onRemove} title="Xóa trận đấu này"><Icon name="close" size={14} /> Xóa</button>
      </div>
      <div className="match-meta-grid">
        <label className="form-group">Mùa giải<select className={selectClass} value={match.seasonId || defaultSeasonId} onChange={e => onPatch({ seasonId: Number(e.target.value) })}><option value="">-- Chọn --</option>{seasons.filter(s => s.is_active || s.id === match.seasonId).map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
        <label className="form-group">Ngày thi đấu<input className={inputClass} type="date" value={match.playDate} onChange={e => onPatch({ playDate: e.target.value })} /></label>
      </div>
      <div className="match-teams">
        <div className="match-team match-team-1">
          <span className="match-team-label">Đội 1 · {name(match.player1Id)}{match.matchType === 'duo' ? ` + ${name(match.player2Id)}` : ''}</span>
          <div className="match-player-selects">
            <select className={selectClass} value={match.player1Id || ''} onChange={e => onPatch({ player1Id: Number(e.target.value) || 0 })}><option value="">-- Chọn --</option>{players.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
            {match.matchType === 'duo' && <select className={selectClass} value={match.player2Id || ''} onChange={e => onPatch({ player2Id: Number(e.target.value) || null })}><option value="">-- Chọn --</option>{players.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select>}
          </div>
        </div>
        <div className="match-score">
          <input className="input-field score-field" type="number" min={0} aria-label="Tỷ số đội 1" value={match.team1Score} onChange={e => onPatch({ team1Score: Number(e.target.value), winningTeam: winnerFromScores(Number(e.target.value), match.team2Score, match.winningTeam) })} />
          <span className="score-separator">:</span>
          <input className="input-field score-field" type="number" min={0} aria-label="Tỷ số đội 2" value={match.team2Score} onChange={e => onPatch({ team2Score: Number(e.target.value), winningTeam: winnerFromScores(match.team1Score, Number(e.target.value), match.winningTeam) })} />
        </div>
        <div className="match-team match-team-2">
          <span className="match-team-label">Đội 2 · {name(match.player3Id)}{match.matchType === 'duo' ? ` + ${name(match.player4Id)}` : ''}</span>
          <div className="match-player-selects">
            <select className={selectClass} value={match.player3Id || ''} onChange={e => onPatch({ player3Id: Number(e.target.value) || 0 })}><option value="">-- Chọn --</option>{players.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
            {match.matchType === 'duo' && <select className={selectClass} value={match.player4Id || ''} onChange={e => onPatch({ player4Id: Number(e.target.value) || null })}><option value="">-- Chọn --</option>{players.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select>}
          </div>
        </div>
      </div>
      <div className="match-footer">
        <select className="select-field match-winner-select" value={match.winningTeam} onChange={e => onPatch({ winningTeam: Number(e.target.value) as 1 | 2 })}><option value={1}>Đội 1 thắng</option><option value={2}>Đội 2 thắng</option></select>
      </div>
    </div>
  )
}

export function MatchesFeature() {
  const app = useApp()
  const activeSeason = app.seasons.find(season => season.is_active) || app.seasons[0]
  const defaultDate = app.data?.defaultDate || today()
  const [form, setForm] = useState<MatchInput>(() => blankMatch(activeSeason?.id, defaultDate))
  const [editingId, setEditingId] = useState<number | undefined>()
  const [eligiblePlayers, setEligiblePlayers] = useState<Player[]>(app.players)
  const [historyDate, setHistoryDate] = useState(defaultDate)
  const [history, setHistory] = useState<Match[]>(app.data?.defaultDateMatches || [])
  const [loadingHistory, setLoadingHistory] = useState(false)
  const [busy, setBusy] = useState(false)
  const [batch, setBatch] = useState<MatchInput[]>([])
  const [parsed, setParsed] = useState<MatchInput[]>([])
  const [parsing, setParsing] = useState(false)

  useEffect(() => {
    if (!form.seasonId) { setEligiblePlayers(app.players); return }
    let cancelled = false
    api.seasonPlayers(form.seasonId).then(players => { if (!cancelled) setEligiblePlayers(players.length ? players : app.players) }).catch(() => setEligiblePlayers(app.players))
    return () => { cancelled = true }
  }, [app.players, form.seasonId])

  useEffect(() => {
    if (!historyDate) return
    let cancelled = false
    setLoadingHistory(true)
    api.matchesByDate(historyDate).then(rows => { if (!cancelled) setHistory(rows) }).catch(error => app.notify(errorMessage(error), 'error')).finally(() => { if (!cancelled) setLoadingHistory(false) })
    return () => { cancelled = true }
  }, [app, app.revision, historyDate])

  const selectedIds = useMemo(() => [form.player1Id, form.player2Id, form.player3Id, form.player4Id].filter(Boolean), [form])
  const available = (current: number | null) => eligiblePlayers.filter(player => player.id === current || !selectedIds.includes(player.id))

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    const issue = validate(form)
    if (issue) { app.notify(issue, 'error'); return }
    setBusy(true)
    try {
      await api.saveMatch(form, editingId)
      app.notify(editingId ? 'Đã cập nhật trận đấu' : 'Đã ghi nhận trận đấu', 'success')
      setEditingId(undefined)
      setForm(blankMatch(form.seasonId, form.playDate, form.matchType))
      await app.reload()
      setHistory(await api.matchesByDate(form.playDate))
      setHistoryDate(form.playDate)
    } catch (error) { app.notify(errorMessage(error), 'error') } finally { setBusy(false) }
  }

  const startEdit = (match: Match) => {
    setEditingId(match.id)
    setForm({
      seasonId: match.season_id, playDate: match.play_date.slice(0, 10), matchType: match.match_type,
      player1Id: match.player1_id, player2Id: match.player2_id, player3Id: match.player3_id, player4Id: match.player4_id,
      team1Score: match.team1_score, team2Score: match.team2_score, winningTeam: match.winning_team
    })
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  const addBatch = () => {
    const issue = validate(form)
    if (issue) { app.notify(issue, 'error'); return }
    setBatch(items => [...items, { ...form }])
    setForm(blankMatch(form.seasonId, form.playDate, form.matchType))
  }

  const submitBatch = async () => {
    if (!batch.length) return
    setBusy(true)
    try {
      await api.mutate('/matches/bulk-create', 'POST', { matches: batch })
      setBatch([]); await app.reload(); app.notify('Đã ghi nhận danh sách trận đấu', 'success')
    } catch (error) { app.notify(errorMessage(error), 'error') } finally { setBusy(false) }
  }

  const handleScreenshot = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (!file) return
    setParsing(true)
    try {
      const dataUrl = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = reject; reader.readAsDataURL(file) })
      const result = await api.mutate<{ matches: ParsedMatch[] }>('/matches/parse-image', 'POST', { imageBase64: dataUrl.split(',')[1], mimeType: file.type })
      // Pre-fill each AI-parsed row into an editable match, fuzzy-resolving
      // players against the existing roster. player2/4 are optional for duo.
      setParsed((result.matches || []).map(item => {
        // For 2v2 the AI returns each side as ONE team string (the prompt forces
        // player2Name/player4Name to null), so split it into two players;
        // solo/duo rows with explicit 4 names use the per-slot matcher.
        const hasExplicitPartner = Boolean(item.player2Name || item.player4Name)
        const side1 = hasExplicitPartner
          ? { p1: findPlayer(item.player1Name), p2: item.player2Name ? (findPlayer(item.player2Name) || null) : null }
          : mapTeamNameToPair(item.player1Name, playerIndex)
        const side2 = hasExplicitPartner
          ? { p1: findPlayer(item.player3Name), p2: item.player4Name ? (findPlayer(item.player4Name) || null) : null }
          : mapTeamNameToPair(item.player3Name, playerIndex)
        return {
          ...blankMatch(activeSeason?.id, defaultDate, item.matchType),
          player1Id: side1.p1 || 0, player2Id: item.matchType === 'duo' ? side1.p2 : null,
          player3Id: side2.p1 || 0, player4Id: item.matchType === 'duo' ? side2.p2 : null,
          team1Score: item.team1Score, team2Score: item.team2Score, winningTeam: item.winningTeam
        }
      }))
      app.notify(`Đã trích xuất ${result.matches?.length || 0} trận`, 'success')
    } catch (error) { app.notify(errorMessage(error), 'error') } finally { setParsing(false); event.target.value = '' }
  }

  // Fuzzy player resolution for AI-parsed names. The AI often returns a name
  // that is not byte-identical to the stored player (accents, nickname, extra
  // words), so we match progressively: exact → substring → last/first word →
  // Levenshtein ≤ 3. This restores the pre-migration behavior of finding
  // existing players instead of silently dropping the match.
  const playerIndex = useMemo(
    () => app.players.map(player => ({ id: player.id, name: player.name, norm: normalizeName(player.name) })),
    [app.players]
  )
  const fuzzyMatchPlayer = (name?: string | null): number => {
    const target = normalizeName(name || '').trim()
    if (!target) return 0
    const exact = playerIndex.find(entry => entry.norm === target)
    if (exact) return exact.id
    const substring = playerIndex.find(entry => entry.norm.includes(target) || target.includes(entry.norm))
    if (substring) return substring.id
    const words = target.split(/\s+/)
    const wordMatch = (pred: (word: string) => boolean) => playerIndex.find(entry => entry.norm.split(/\s+/).some(pred))
    if (words.length >= 2) {
      const last = words[words.length - 1]!
      const nick = wordMatch(w => w === last || last.startsWith(w) || w.startsWith(last))
      if (nick) return nick.id
    }
    const first = words[0]!
    const firstHit = wordMatch(w => w === first || first.startsWith(w) || w.startsWith(first))
    if (firstHit) return firstHit.id
    if (words.length > 3 || target.length <= 20) {
      let best = Infinity; let bestId = 0
      for (const entry of playerIndex) {
        const d = levenshtein(target, entry.norm)
        if (d < best && d <= 3) { best = d; bestId = entry.id }
      }
      if (bestId) return bestId
    }
    return 0
  }
  const findPlayer = fuzzyMatchPlayer
  // `parsed` holds the editable matches (pre-filled by fuzzyMatchPlayer above).
  const updateParsed = (index: number, patch: Partial<MatchInput>) => setParsed(items => items.map((item, i) => i === index ? { ...item, ...patch } : item))
  const removeParsed = (index: number) => setParsed(items => items.filter((_, i) => i !== index))
  const confirmParsed = async () => {
    if (!parsed.length) return
    const valid = parsed.filter(match => !validate(match))
    const skipped = parsed.length - valid.length
    if (!valid.length) { app.notify('Không có trận nào hợp lệ — hãy kiểm tra mùa giải, ngày và người chơi trong từng thẻ.', 'error'); return }
    setBusy(true)
    try {
      await api.mutate('/matches/bulk-create', 'POST', { matches: valid })
      setParsed([])
      await app.reload()
      app.notify(skipped > 0 ? `Đã ghi nhận ${valid.length} trận, bỏ qua ${skipped} trận chưa hợp lệ` : 'Đã ghi nhận kết quả từ ảnh', skipped ? 'info' : 'success')
    } catch (error) { app.notify(errorMessage(error), 'error') } finally { setBusy(false) }
  }

  return <section className="tab-content active">
    <PageHeader icon="tennis" title="Quản lý trận đấu" subtitle="Ghi nhận 1v1, 2v2, theo lô hoặc từ ảnh" />
    {app.canEdit && <Panel className="match-entry-panel" title={editingId ? `Chỉnh sửa trận #${editingId}` : 'Ghi nhận trận đấu'}>
      <form onSubmit={submit} className="match-entry-form">
        <div className="match-meta-grid">
          <label className="form-group">Loại trận<select value={form.matchType} onChange={e => setForm(blankMatch(form.seasonId, form.playDate, e.target.value as MatchType))}><option value="duo">Đôi (2v2)</option><option value="solo">Đơn (1v1)</option></select></label>
          <label className="form-group">Mùa giải<select required value={form.seasonId || ''} onChange={e => setForm({ ...form, seasonId: Number(e.target.value), player1Id: 0, player2Id: null, player3Id: 0, player4Id: null })}><option value="">-- Chọn --</option>{app.seasons.filter(s => s.is_active || s.id === form.seasonId).map(season => <option value={season.id} key={season.id}>{season.name}</option>)}</select></label>
          <label className="form-group">Ngày thi đấu<input required type="date" value={form.playDate} onChange={e => setForm({ ...form, playDate: e.target.value })} /></label>
        </div>
        <div className="match-teams-editor">
          <fieldset className="team-editor team-one"><legend>Đội 1</legend><PlayerSelect label="Người chơi 1" players={available(form.player1Id)} value={form.player1Id} onChange={id => setForm({ ...form, player1Id: id || 0 })} />{form.matchType === 'duo' && <PlayerSelect label="Người chơi 2" players={available(form.player2Id)} value={form.player2Id} onChange={id => setForm({ ...form, player2Id: id })} />}</fieldset>
          <fieldset className="score-editor"><legend>Kết quả</legend><div className="score-inputs"><label className="form-group">Đội 1<input aria-label="Tỷ số đội 1" min={0} max={100} type="number" value={form.team1Score} onChange={e => setForm({ ...form, team1Score: Number(e.target.value), winningTeam: winnerFromScores(Number(e.target.value), form.team2Score, form.winningTeam) })} /></label><span>:</span><label className="form-group">Đội 2<input aria-label="Tỷ số đội 2" min={0} max={100} type="number" value={form.team2Score} onChange={e => setForm({ ...form, team2Score: Number(e.target.value), winningTeam: winnerFromScores(form.team1Score, Number(e.target.value), form.winningTeam) })} /></label></div><label className="form-group">Đội thắng<select value={form.winningTeam} onChange={e => setForm({ ...form, winningTeam: Number(e.target.value) as 1 | 2 })}><option value={1}>Đội 1</option><option value={2}>Đội 2</option></select></label></fieldset>
          <fieldset className="team-editor team-two"><legend>Đội 2</legend><PlayerSelect label="Người chơi 1" players={available(form.player3Id)} value={form.player3Id} onChange={id => setForm({ ...form, player3Id: id || 0 })} />{form.matchType === 'duo' && <PlayerSelect label="Người chơi 2" players={available(form.player4Id)} value={form.player4Id} onChange={id => setForm({ ...form, player4Id: id })} />}</fieldset>
        </div>
        <div className="react-form-actions"><button className="btn btn-primary" disabled={busy}>{editingId ? 'Lưu thay đổi' : 'Ghi nhận'}</button>{!editingId && <button type="button" className="btn btn-secondary" onClick={addBatch}><Icon name="plus" /> Thêm vào lô</button>}{editingId && <button type="button" className="btn btn-secondary" onClick={() => { setEditingId(undefined); setForm(blankMatch(activeSeason?.id, defaultDate)) }}>Hủy sửa</button>}</div>
      </form>
      {batch.length > 0 && <div className="batch-panel"><div className="subsection-heading"><h4>Lô chờ gửi</h4><span className="count-badge">{batch.length}</span></div>{batch.map((item, index) => <div className="batch-row" key={index}><span>{item.playDate} · {item.matchType === 'solo' ? '1v1' : '2v2'} · {item.team1Score}-{item.team2Score}</span><button type="button" className="btn btn-sm btn-danger" onClick={() => setBatch(rows => rows.filter((_, i) => i !== index))}><Icon name="trash" size={14} /> Xóa</button></div>)}<button type="button" className="btn btn-primary" disabled={busy} onClick={() => void submitBatch()}>Gửi toàn bộ</button></div>}
      <details className="image-import"><summary><Icon name="image" /> Nhập kết quả từ ảnh</summary><div className="image-import-body"><p>Chọn ảnh PNG, JPEG hoặc WebP có danh sách kết quả rõ ràng.</p><label className="btn btn-secondary file-button"><Icon name="upload" /> {parsing ? 'Đang phân tích…' : 'Chọn ảnh kết quả'}<input hidden type="file" accept="image/png,image/jpeg,image/webp" disabled={parsing} onChange={handleScreenshot} /></label>{parsed.length > 0 && <><div className="match-cards-container">{parsed.map((item, index) => <ParsedMatchCard key={index} match={item} players={app.players} seasons={app.seasons} defaultSeasonId={activeSeason?.id || 0} onPatch={patch => updateParsed(index, patch)} onRemove={() => removeParsed(index)} />)}</div><div className="react-form-actions"><button type="button" className="btn btn-primary" disabled={busy} onClick={() => void confirmParsed()}>Xác nhận tất cả ({parsed.length})</button><button type="button" className="btn btn-secondary" onClick={() => setParsed([])}>Hủy</button></div></>}</div></details>
    </Panel>}

    <Panel title="Lịch sử trận đấu" actions={<label className="compact-select">Ngày<select value={historyDate} onChange={e => setHistoryDate(e.target.value)}>{app.data?.playDates.map(date => <option key={date} value={date}>{date}</option>)}</select></label>}>
      {loadingHistory ? <Loading /> : history.length === 0 ? <Empty>Không có trận đấu ngày này</Empty> : <div className="matches-grid">{history.map(match => <article className="match-card" key={match.id}>
        <div className="match-card-header"><span className="match-type-badge">{match.match_type === 'solo' ? '1v1' : '2v2'}</span><span>{formatDate(match.play_date)}</span></div>
        <div className="match-result"><div className={match.winning_team === 1 ? 'match-side winner' : 'match-side'}>{match.winning_team === 1 && <Icon name="check" size={14} />}<strong>{match.player1_name}{match.player2_name ? ` + ${match.player2_name}` : ''}</strong></div><div className="match-score"><strong>{match.team1_score} : {match.team2_score}</strong></div><div className={match.winning_team === 2 ? 'match-side winner' : 'match-side'}>{match.winning_team === 2 && <Icon name="check" size={14} />}<strong>{match.player3_name}{match.player4_name ? ` + ${match.player4_name}` : ''}</strong></div></div>
        {app.canEdit && <div className="match-card-actions"><button type="button" className="btn btn-sm btn-secondary" onClick={() => startEdit(match)}><Icon name="edit" size={14} /> Sửa</button><ConfirmButton message="Xóa trận đấu này?" onConfirm={async () => { try { await api.mutate(`/matches/${match.id}`, 'DELETE'); setHistory(rows => rows.filter(row => row.id !== match.id)); await app.reload(); app.notify('Đã xóa trận đấu', 'success') } catch (error) { app.notify(errorMessage(error), 'error') } }}><Icon name="trash" size={14} /> Xóa</ConfirmButton></div>}
      </article>)}</div>}
    </Panel>
  </section>
}
