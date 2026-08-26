/**
 * Build a parameterized multi-row INSERT statement.
 *
 * Pure function (no DB access) so it is trivially unit-testable. Used to batch
 * bulk restores (PERF-1) instead of one round-trip per row.
 *
 * SECURITY: `table` and column `name`s must be trusted constants (never user
 * input) — they are interpolated into the SQL text. All VALUES are parameterized.
 *
 * @param {string} table - trusted table name
 * @param {Array<{ name: string, expr?: (placeholder: string) => string }>} columns
 *   - name: trusted column name
 *   - expr: optional transform applied to the placeholder for this column.
 *     Use to wrap a value in an expression, e.g. `p => `COALESCE(${p}, now())``.
 * @param {Array<Array<any>>} rows - one value array per row, aligned to columns
 * @returns {{ text: string, params: any[] }}
 * @throws if rows is empty or a row's length does not match columns
 */
export function buildBulkInsert(table, columns, rows) {
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error('buildBulkInsert requires at least one row')
  }
  const colCount = columns.length
  const valueTuples = []
  const params = []

  rows.forEach((row, i) => {
    if (!Array.isArray(row) || row.length !== colCount) {
      throw new Error(
        `buildBulkInsert: row ${i} has ${row?.length ?? 0} values, expected ${colCount}`
      )
    }
    const exprs = []
    for (let j = 0; j < colCount; j++) {
      params.push(row[j])
      const placeholder = `$${params.length}`
      exprs.push(columns[j].expr ? columns[j].expr(placeholder) : placeholder)
    }
    valueTuples.push(`(${exprs.join(', ')})`)
  })

  const colList = columns.map((c) => c.name).join(', ')
  return {
    text: `INSERT INTO ${table} (${colList}) VALUES ${valueTuples.join(', ')}`,
    params
  }
}
