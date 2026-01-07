/**
 * Excel Helper Module
 * Modern replacement for ExcelJS using write-excel-file (actively maintained 2024+)
 * No vulnerabilities, TypeScript support, smaller bundle size
 */
import writeXlsxFile from 'write-excel-file/node'

/**
 * Column width mapping (characters to approximate width)
 */
const DEFAULT_WIDTHS = {
  id: 10,
  name: 30,
  date: 15,
  score: 15,
  player: 20,
  season: 20,
  number: 10,
  percentage: 15,
  money: 20,
  form: 30,
  datetime: 20,
  boolean: 15
}

/**
 * Create a data row from an object based on column schema
 */
const createDataRow = (obj, columns) => {
  return columns.map(col => {
    let value = obj[col.key]
    
    // Handle null/undefined
    if (value === null || value === undefined) {
      return { value: '', type: String }
    }
    
    // Handle dates
    if (value instanceof Date) {
      return { value, type: Date, format: 'yyyy-mm-dd' }
    }
    
    // Handle booleans
    if (typeof value === 'boolean') {
      return { value: value ? 'Có' : 'Không', type: String }
    }
    
    // Handle numbers
    if (typeof value === 'number') {
      return { value, type: Number }
    }
    
    // Default to string
    return { value: String(value), type: String }
  })
}

/**
 * Create header row with bold styling
 */
const createHeaderRow = (columns) => {
  return columns.map(col => ({
    value: col.header,
    type: String,
    fontWeight: 'bold',
    backgroundColor: '#f0f0f0'
  }))
}

/**
 * Create column widths configuration
 */
const createColumnWidths = (columns) => {
  return columns.map(col => ({ width: col.width || 15 }))
}

/**
 * Build sheet data from objects and column definitions
 */
export const buildSheetData = (data, columns) => {
  const rows = [createHeaderRow(columns)]
  
  for (const item of data) {
    rows.push(createDataRow(item, columns))
  }
  
  return rows
}

/**
 * Rankings sheet columns
 */
export const RANKINGS_COLUMNS = [
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

/**
 * Rankings sheet columns (simple - no rank/form)
 */
export const RANKINGS_SIMPLE_COLUMNS = [
  { header: 'Tên', key: 'name', width: 30 },
  { header: 'Thắng', key: 'wins', width: 10 },
  { header: 'Thua', key: 'losses', width: 10 },
  { header: 'Tổng trận', key: 'total_matches', width: 15 },
  { header: 'Điểm', key: 'points', width: 10 },
  { header: 'Tỷ lệ thắng (%)', key: 'win_percentage', width: 15 },
  { header: 'Tiền thua (VND)', key: 'money_lost', width: 20 }
]

/**
 * Players sheet columns
 */
export const PLAYERS_COLUMNS = [
  { header: 'ID', key: 'id', width: 10 },
  { header: 'Tên', key: 'name', width: 30 },
  { header: 'Ngày tạo', key: 'created_at', width: 20 }
]

/**
 * Seasons sheet columns
 */
export const SEASONS_COLUMNS = [
  { header: 'ID', key: 'id', width: 10 },
  { header: 'Tên mùa giải', key: 'name', width: 30 },
  { header: 'Ngày bắt đầu', key: 'start_date', width: 15 },
  { header: 'Ngày kết thúc', key: 'end_date', width: 15 },
  { header: 'Đang hoạt động', key: 'is_active', width: 15 },
  { header: 'Ngày tạo', key: 'created_at', width: 20 }
]

/**
 * Matches sheet columns (full)
 */
export const MATCHES_FULL_COLUMNS = [
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

/**
 * Matches sheet columns (without season)
 */
export const MATCHES_COLUMNS = [
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

/**
 * Matches sheet columns (by date - with season, no play_date)
 */
export const MATCHES_BY_DATE_COLUMNS = [
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

/**
 * Process rankings data to add rank and form_text
 */
export const processRankingsData = (rankings) => {
  return rankings.map((player, index) => ({
    rank: index + 1,
    ...player,
    form_text: player.form ? player.form.map(f => f.result === 'win' ? 'T' : 'B').join(' ') : ''
  }))
}

/**
 * Truncate sheet name to Excel's 31 character limit
 * @param {string} name - Sheet name
 * @returns {string} Truncated name
 */
const truncateSheetName = (name) => {
  if (name.length <= 31) return name
  return name.substring(0, 28) + '...'
}

/**
 * Write multi-sheet Excel workbook to buffer
 * @param {Array} sheets - Array of { name, data, columns } objects
 * @returns {Promise<Buffer>} Excel file buffer
 */
export const writeExcelBuffer = async (sheets) => {
  const sheetData = sheets.map(sheet => buildSheetData(sheet.data, sheet.columns))
  const sheetNames = sheets.map(sheet => truncateSheetName(sheet.name))
  const columnWidths = sheets.map(sheet => createColumnWidths(sheet.columns))
  
  return writeXlsxFile(sheetData, {
    sheets: sheetNames,
    columns: columnWidths,
    buffer: true
  })
}

/**
 * Create full export workbook (all data)
 */
export const createFullExportBuffer = async ({ players, seasons, matches, rankings }) => {
  return writeExcelBuffer([
    { name: 'Người chơi', data: players, columns: PLAYERS_COLUMNS },
    { name: 'Mùa giải', data: seasons, columns: SEASONS_COLUMNS },
    { name: 'Kết quả thi đấu', data: matches, columns: MATCHES_FULL_COLUMNS },
    { name: 'Bảng xếp hạng tổng', data: rankings, columns: RANKINGS_SIMPLE_COLUMNS }
  ])
}

/**
 * Create date export workbook
 */
export const createDateExportBuffer = async ({ date, rankings, matches }) => {
  const processedRankings = processRankingsData(rankings)
  
  return writeExcelBuffer([
    { name: `Bảng xếp hạng - ${date}`, data: processedRankings, columns: RANKINGS_COLUMNS },
    { name: `Trận đấu - ${date}`, data: matches, columns: MATCHES_BY_DATE_COLUMNS }
  ])
}

/**
 * Create season export workbook
 */
export const createSeasonExportBuffer = async ({ seasonName, rankings, matches }) => {
  const processedRankings = processRankingsData(rankings)
  
  return writeExcelBuffer([
    { name: `Bảng xếp hạng - ${seasonName}`, data: processedRankings, columns: RANKINGS_COLUMNS },
    { name: `Trận đấu - ${seasonName}`, data: matches, columns: MATCHES_COLUMNS }
  ])
}

/**
 * Create lifetime export workbook
 */
export const createLifetimeExportBuffer = async ({ players, seasons, matches, rankings }) => {
  const processedRankings = processRankingsData(rankings)
  
  return writeExcelBuffer([
    { name: 'Bảng xếp hạng - Toàn thời gian', data: processedRankings, columns: RANKINGS_COLUMNS },
    { name: 'Tất cả người chơi', data: players, columns: PLAYERS_COLUMNS },
    { name: 'Tất cả mùa giải', data: seasons, columns: SEASONS_COLUMNS },
    { name: 'Tất cả trận đấu', data: matches, columns: MATCHES_FULL_COLUMNS }
  ])
}

export default {
  buildSheetData,
  writeExcelBuffer,
  createFullExportBuffer,
  createDateExportBuffer,
  createSeasonExportBuffer,
  createLifetimeExportBuffer,
  processRankingsData,
  RANKINGS_COLUMNS,
  RANKINGS_SIMPLE_COLUMNS,
  PLAYERS_COLUMNS,
  SEASONS_COLUMNS,
  MATCHES_COLUMNS,
  MATCHES_FULL_COLUMNS,
  MATCHES_BY_DATE_COLUMNS
}
