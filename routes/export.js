import { Router } from 'express'
import ExcelJS from 'exceljs'
import { asyncHandler } from '../utils/async-handler.js'

const buildRankingsSheet = (sheet, rankings) => {
  sheet.columns = [
    { header: 'Hạng', key: 'rank', width: 10 },
    { header: 'Tên', key: 'name', width: 30 },
    { header: 'Thắng', key: 'wins', width: 10 },
    { header: 'Thua', key: 'losses', width: 10 },
    { header: 'Tổng trận', key: 'total_matches', width: 15 },
    { header: 'Điểm', key: 'points', width: 10 },
    { header: 'Tỷ lệ thắng (%)', key: 'win_percentage', width: 15 },
    { header: 'Tiền thua (VND)', key: 'money_lost', width: 20 },
    { header: 'Phong độ gần đây', key: 'form_text', width: 30 }
  ]
  const rankedData = rankings.map((player, index) => ({
    rank: index + 1,
    ...player,
    form_text: player.form ? player.form.map(f => f.result === 'win' ? 'T' : 'B').join(' ') : ''
  }))
  sheet.addRows(rankedData)
}

export const createExportRouter = ({
  db,
  checkAuth,
  authenticateToken,
  conditionalRateLimit,
  exportLimiter
}) => {
  const router = Router()

  router.get('/', checkAuth, conditionalRateLimit(exportLimiter), asyncHandler(async (req, res) => {
    const workbook = new ExcelJS.Workbook()

    const playersSheet = workbook.addWorksheet('Người chơi')
    playersSheet.columns = [
      { header: 'ID', key: 'id', width: 10 },
      { header: 'Tên', key: 'name', width: 30 },
      { header: 'Ngày tạo', key: 'created_at', width: 20 }
    ]
    const players = await db.getPlayers()
    playersSheet.addRows(players)

    const seasonsSheet = workbook.addWorksheet('Mùa giải')
    seasonsSheet.columns = [
      { header: 'ID', key: 'id', width: 10 },
      { header: 'Tên mùa giải', key: 'name', width: 30 },
      { header: 'Ngày bắt đầu', key: 'start_date', width: 15 },
      { header: 'Ngày kết thúc', key: 'end_date', width: 15 },
      { header: 'Đang hoạt động', key: 'is_active', width: 15 },
      { header: 'Ngày tạo', key: 'created_at', width: 20 }
    ]
    const seasons = await db.getSeasons()
    seasonsSheet.addRows(seasons)

    const matchesSheet = workbook.addWorksheet('Kết quả thi đấu')
    matchesSheet.columns = [
      { header: 'ID', key: 'id', width: 10 },
      { header: 'Mùa giải', key: 'season_name', width: 20 },
      { header: 'Ngày đánh', key: 'play_date', width: 15 },
      { header: 'Người chơi 1', key: 'player1_name', width: 20 },
      { header: 'Người chơi 2', key: 'player2_name', width: 20 },
      { header: 'Người chơi 3', key: 'player3_name', width: 20 },
      { header: 'Người chơi 4', key: 'player4_name', width: 20 },
      { header: 'Điểm đội 1', key: 'team1_score', width: 15 },
      { header: 'Điểm đội 2', key: 'team2_score', width: 15 },
      { header: 'Đội thắng', key: 'winning_team', width: 15 },
      { header: 'Ngày tạo', key: 'created_at', width: 20 }
    ]
    const matches = await db.getMatches()
    matchesSheet.addRows(matches)

    const rankingsSheet = workbook.addWorksheet('Bảng xếp hạng tổng')
    const rankings = await db.getPlayerStatsLifetime()
    buildRankingsSheet(rankingsSheet, rankings)

    const buffer = await workbook.xlsx.writeBuffer()
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    res.setHeader('Content-Disposition', `attachment; filename="tennis-rankings-${new Date().toISOString().split('T')[0]}.xlsx"`)
    res.send(buffer)
  }))

  router.get('/date/:date', checkAuth, conditionalRateLimit(exportLimiter), asyncHandler(async (req, res) => {
    const { date } = req.params
    const workbook = new ExcelJS.Workbook()

    const rankingsSheet = workbook.addWorksheet(`Bảng xếp hạng - ${date}`)
    const rankings = await db.getPlayerStatsByPlayDate(date)
    buildRankingsSheet(rankingsSheet, rankings)

    const matchesSheet = workbook.addWorksheet(`Trận đấu - ${date}`)
    matchesSheet.columns = [
      { header: 'ID', key: 'id', width: 10 },
      { header: 'Mùa giải', key: 'season_name', width: 20 },
      { header: 'Người chơi 1', key: 'player1_name', width: 20 },
      { header: 'Người chơi 2', key: 'player2_name', width: 20 },
      { header: 'Người chơi 3', key: 'player3_name', width: 20 },
      { header: 'Người chơi 4', key: 'player4_name', width: 20 },
      { header: 'Điểm đội 1', key: 'team1_score', width: 15 },
      { header: 'Điểm đội 2', key: 'team2_score', width: 15 },
      { header: 'Đội thắng', key: 'winning_team', width: 15 }
    ]
    const matches = await db.getMatchesByDate(date)
    matchesSheet.addRows(matches)

    const buffer = await workbook.xlsx.writeBuffer()
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument-spreadsheetml.sheet')
    res.setHeader('Content-Disposition', `attachment; filename="tennis-rankings-${date}.xlsx"`)
    res.send(buffer)
  }))

  router.get('/season/:seasonId', checkAuth, conditionalRateLimit(exportLimiter), asyncHandler(async (req, res) => {
    const { seasonId } = req.params
    const workbook = new ExcelJS.Workbook()
    const season = await db.getSeasonById(seasonId)
    const seasonName = season ? season.name : `Mùa ${seasonId}`

    const rankingsSheet = workbook.addWorksheet(`Bảng xếp hạng - ${seasonName}`)
    const rankings = await db.getPlayerStatsBySeason(seasonId)
    buildRankingsSheet(rankingsSheet, rankings)

    const matchesSheet = workbook.addWorksheet(`Trận đấu - ${seasonName}`)
    matchesSheet.columns = [
      { header: 'ID', key: 'id', width: 10 },
      { header: 'Ngày đánh', key: 'play_date', width: 15 },
      { header: 'Người chơi 1', key: 'player1_name', width: 20 },
      { header: 'Người chơi 2', key: 'player2_name', width: 20 },
      { header: 'Người chơi 3', key: 'player3_name', width: 20 },
      { header: 'Người chơi 4', key: 'player4_name', width: 20 },
      { header: 'Điểm đội 1', key: 'team1_score', width: 15 },
      { header: 'Điểm đội 2', key: 'team2_score', width: 15 },
      { header: 'Đội thắng', key: 'winning_team', width: 15 }
    ]
    const matches = await db.getMatchesBySeason(seasonId)
    matchesSheet.addRows(matches)

    const buffer = await workbook.xlsx.writeBuffer()
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    res.setHeader('Content-Disposition', `attachment; filename="tennis-rankings-season-${seasonId}.xlsx"`)
    res.send(buffer)
  }))

  router.get('/lifetime', checkAuth, conditionalRateLimit(exportLimiter), asyncHandler(async (req, res) => {
    const workbook = new ExcelJS.Workbook()

    const rankingsSheet = workbook.addWorksheet('Bảng xếp hạng - Toàn thời gian')
    const rankings = await db.getPlayerStatsLifetime()
    buildRankingsSheet(rankingsSheet, rankings)

    const playersSheet = workbook.addWorksheet('Tất cả người chơi')
    playersSheet.columns = [
      { header: 'ID', key: 'id', width: 10 },
      { header: 'Tên', key: 'name', width: 30 },
      { header: 'Ngày tạo', key: 'created_at', width: 20 }
    ]
    const players = await db.getPlayers()
    playersSheet.addRows(players)

    const seasonsSheet = workbook.addWorksheet('Tất cả mùa giải')
    seasonsSheet.columns = [
      { header: 'ID', key: 'id', width: 10 },
      { header: 'Tên mùa giải', key: 'name', width: 30 },
      { header: 'Ngày bắt đầu', key: 'start_date', width: 15 },
      { header: 'Ngày kết thúc', key: 'end_date', width: 15 },
      { header: 'Đang hoạt động', key: 'is_active', width: 15 },
      { header: 'Ngày tạo', key: 'created_at', width: 20 }
    ]
    const seasons = await db.getSeasons()
    seasonsSheet.addRows(seasons)

    const matchesSheet = workbook.addWorksheet('Tất cả trận đấu')
    matchesSheet.columns = [
      { header: 'ID', key: 'id', width: 10 },
      { header: 'Mùa giải', key: 'season_name', width: 20 },
      { header: 'Ngày đánh', key: 'play_date', width: 15 },
      { header: 'Người chơi 1', key: 'player1_name', width: 20 },
      { header: 'Người chơi 2', key: 'player2_name', width: 20 },
      { header: 'Người chơi 3', key: 'player3_name', width: 20 },
      { header: 'Người chơi 4', key: 'player4_name', width: 20 },
      { header: 'Điểm đội 1', key: 'team1_score', width: 15 },
      { header: 'Điểm đội 2', key: 'team2_score', width: 15 },
      { header: 'Đội thắng', key: 'winning_team', width: 15 },
      { header: 'Ngày tạo', key: 'created_at', width: 20 }
    ]
    const matches = await db.getMatches()
    matchesSheet.addRows(matches)

    const buffer = await workbook.xlsx.writeBuffer()
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    res.setHeader('Content-Disposition', 'attachment; filename="tennis-rankings-lifetime.xlsx"')
    res.send(buffer)
  }))

  return router
}
