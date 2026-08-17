export function extractSqlHeredocs(source, filename) {
  const blocks = []
  const heredoc = /<<\s*['"]?(EOSQL|SQL)['"]?\s*\n([\s\S]*?)\n\1/g
  let match
  while ((match = heredoc.exec(source)) !== null) blocks.push(match[2])
  if (blocks.length === 0) throw new Error(`No SQL heredocs found in ${filename}`)
  return blocks.join('\n\n')
}
