import { describe, expect, it } from 'vitest'
import { extractSqlHeredocs } from '../../scripts/migration-utils.js'

describe('K3s legacy migration parser', () => {
  it('extracts quoted and unquoted SQL heredocs in order', () => {
    const source = `psql <<'EOSQL'\nSELECT 1;\nEOSQL\npsql <<SQL\nSELECT 2;\nSQL`
    expect(extractSqlHeredocs(source, 'example.sh')).toBe('SELECT 1;\n\nSELECT 2;')
  })

  it('rejects a shell script with no SQL heredoc', () => {
    expect(() => extractSqlHeredocs('echo nope', 'bad.sh')).toThrow(
      'No SQL heredocs found in bad.sh'
    )
  })
})
