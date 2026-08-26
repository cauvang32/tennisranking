/**
 * JSON Streaming Utility
 *
 * Streams query results as a JSON array directly to the HTTP response,
 * keeping Node.js memory usage constant regardless of result set size.
 *
 * The client receives a standard JSON array `[{...},{...},...]` — fully
 * transparent to the frontend (no API contract change).
 */
import Cursor from 'pg-cursor'
import { finished } from 'stream/promises'
import type { Response } from 'express'
import type { Pool } from 'pg'

type Row = Record<string, any>
interface JsonStreamOptions {
  transform?: (row: Row) => Row
  sanitize?: (row: Row) => unknown
}
interface ExcelColumn { header: string; key: string; width?: number }
interface ExcelStreamOptions {
  columns: ExcelColumn[]
  filename: string
  transform?: (row: Row) => Row
}

const BATCH_SIZE = 200 // rows per DB round-trip

/**
 * Stream a SQL query as a JSON array to an Express response.
 *
 * Usage:
 *   await streamJsonResponse(db.pool, sql, params, res)
 *
 * @param {import('pg').Pool} pool - pg Pool instance
 * @param {string} sql - SQL query text
 * @param {any[]} params - Query parameters
 * @param {import('express').Response} res - Express response object
 * @param {object} [options]
 * @param {function} [options.transform] - Optional row → row transform
 * @param {function} [options.sanitize] - Optional sanitizeResponse function
 */
export async function streamJsonResponse(pool: Pool, sql: string, params: any[], res: Response, options: JsonStreamOptions = {}) {
  const { transform, sanitize } = options
  const client = await pool.connect()
  let cursor = null
  let isClosed = false

  try {
    cursor = client.query(new Cursor(sql, params))

    // Close the cursor and release the DB connection when the client disconnects
    // mid-stream. Without this, pg-cursor events keep firing until the socket closes.
    res.on('close', () => {
      if (!isClosed) {
        isClosed = true
        cursor.close(() => {})
        client.release()
      }
    })

    res.setHeader('Content-Type', 'application/json; charset=utf-8')
    res.write('[')

    let first = true

    const readBatch = () =>
      new Promise<Row[]>((resolve, reject) => {
        if (isClosed) return resolve([]) // client disconnected
        cursor.read(BATCH_SIZE, (err, rows) => {
          if (err) return reject(err)
          resolve(rows)
        })
      })

    // eslint-disable-next-line no-constant-condition
    while (true) {
      const rows = await readBatch()
      if (rows.length === 0) break

      for (let row of rows) {
        if (transform) row = transform(row)
        const json = JSON.stringify(sanitize ? sanitize(row) : row)
        res.write(first ? json : ',' + json)
        first = false
      }
      // Allow event-loop to breathe between batches
    }

    res.write(']')
    res.end()
  } catch (err) {
    isClosed = true
    cursor?.close(() => {})
    // If headers haven't been sent yet, send proper error
    if (!res.headersSent) {
      res.status(500).json({ error: 'Internal server error' })
    } else {
      // Headers already sent — best effort: close the stream
      try { res.end() } catch { /* ignore */ }
    }
    throw err
  } finally {
    if (!isClosed) {
      isClosed = true
      client.release()
    }
  }
}

/**
 * Stream a SQL query to an Excel sheet via write-excel-file streaming.
 *
 * Since write-excel-file doesn't natively support row-by-row streaming,
 * we use a chunked approach: read all rows via cursor in batches,
 * build the sheet data progressively, then flush the buffer to the response
 * once complete. This still avoids the double-buffering of old approach.
 *
 * For truly enormous datasets (100k+), consider switching to `exceljs`
 * streaming workbook API.
 *
 * @param {import('pg').Pool} pool
 * @param {string} sql
 * @param {any[]} params
 * @param {import('express').Response} res
 * @param {object} options
 * @param {Array} options.columns - Column definitions [{header, key, width}]
 * @param {string} options.filename - Download filename
 * @param {function} [options.transform] - Optional row transform
 */
export async function streamExcelResponse(pool: Pool, sql: string, params: any[], res: Response, options: ExcelStreamOptions) {
  const { columns, filename, transform } = options
  const { default: writeXlsxFile } = await import('write-excel-file/node')

  const client = await pool.connect()
  const maxRows = Math.max(1, Number(process.env.EXPORT_MAX_ROWS) || 25000)
  let cursor
  let closed = false

  try {
    cursor = client.query(new Cursor(sql, params))
    const closeCursor = () => {
      if (!closed) {
        closed = true
        cursor?.close(() => {})
      }
    }
    res.once('close', closeCursor)

    // Build header row
    const headerRow = columns.map(col => ({
      value: col.header,
      type: String,
      fontWeight: 'bold',
      backgroundColor: '#f0f0f0'
    }))

    const allRows: any[][] = [headerRow]

    const readBatch = () =>
      new Promise<Row[]>((resolve, reject) => {
        cursor.read(BATCH_SIZE, (err, rows) => {
          if (err) return reject(err)
          resolve(rows)
        })
      })

    // Read all rows through cursor in batches (constant-ish memory per batch)
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const rows = await readBatch()
      if (rows.length === 0) break

      for (let row of rows) {
        if (allRows.length > maxRows) {
          const error = new Error(`Export exceeds the configured ${maxRows} row limit`) as Error & { statusCode?: number }
          error.statusCode = 413
          throw error
        }
        if (transform) row = transform(row)
        const dataRow = columns.map(col => {
          const value = row[col.key]
          if (value === null || value === undefined) return { value: '', type: String }
          if (typeof value === 'number') return { value, type: Number }
          if (typeof value === 'boolean') return { value: value ? 'Có' : 'Không', type: String }
          return { value: String(value), type: String }
        })
        allRows.push(dataRow)
      }
    }

    closeCursor()

    // The library streams the generated archive to the socket. The explicit
    // row ceiling keeps worksheet construction within a predictable bound.
    const columnWidths = columns.map(col => ({ width: col.width || 15 }))
    const output = await (writeXlsxFile as any)(allRows, { columns: columnWidths }).toStream()

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`)
    output.pipe(res)
    await finished(output)
  } catch (error) {
    const typedError = error as Error & { statusCode?: number }
    if (!res.headersSent) {
      res.status(typedError.statusCode || 500).json({
        error: typedError.statusCode === 413 ? typedError.message : 'Failed to generate export'
      })
      return
    }
    throw error
  } finally {
    if (!closed) cursor?.close(() => {})
    client.release()
  }
}
