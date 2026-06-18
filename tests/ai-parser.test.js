import { describe, it, expect } from 'vitest'

// Copy of extractJSON from ai-parser.js for standalone testing
function extractJSON(text) {
  let cleaned = text
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/g, '')

  // Find outermost balanced JSON object by counting braces
  let depth = 0
  let start = -1
  for (let i = 0; i < cleaned.length; i++) {
    const ch = cleaned[i]
    if (ch === '{') {
      if (depth === 0) start = i
      depth++
    } else if (ch === '}') {
      depth--
      if (depth === 0 && start !== -1) {
        return cleaned.substring(start, i + 1)
      }
    }
  }

  // Try balanced array
  depth = 0; start = -1
  for (let i = 0; i < cleaned.length; i++) {
    const ch = cleaned[i]
    if (ch === '[') {
      if (depth === 0) start = i
      depth++
    } else if (ch === ']') {
      depth--
      if (depth === 0 && start !== -1) {
        return cleaned.substring(start, i + 1)
      }
    }
  }

  return cleaned.match(/\{[\s\S]*\}/)?.[0] || null
}

function fixTrailingCommas(str) {
  return str.replace(/,\s*([}\]])/g, '$1')
}

describe('extractJSON', () => {
  it('extracts JSON from markdown-wrapped output (exact AI format)', () => {
    const input = [
      '```json',
      '{',
      '  "matches": [',
      '    {',
      '      "player1Name": "Hưng Tâm",',
      '      "player2Name": null,',
      '      "player3Name": "Quân Tiến",',
      '      "player4Name": null,',
      '      "team1Score": 4,',
      '      "team2Score": 2,',
      '      "winningTeam": 1,',
      '      "matchType": "duo"',
      '    },',
      '    {',
      '      "player1Name": "Đức Tâm",',
      '      "player2Name": null,',
      '      "player3Name": "Dũng Tú",',
      '      "player4Name": null,',
      '      "team1Score": 4,',
      '      "team2Score": 0,',
      '      "winningTeam": 1,',
      '      "matchType": "duo"',
      '    }',
      '  ]',
      '}',
      '```'
    ].join('\n')

    const result = extractJSON(input)
    expect(result).not.toBeNull()
    const fixed = fixTrailingCommas(result)
    const parsed = JSON.parse(fixed)
    expect(parsed.matches).toHaveLength(2)
    expect(parsed.matches[0].player1Name).toBe('Hưng Tâm')
    expect(parsed.matches[0].player3Name).toBe('Quân Tiến')
    expect(parsed.matches[1].player1Name).toBe('Đức Tâm')
    expect(parsed.matches[1].player3Name).toBe('Dũng Tú')
  })

  it('extracts clean JSON without markdown', () => {
    const input = JSON.stringify({ matches: [] })
    const result = extractJSON(input)
    expect(result).toBe(input)
  })

  it('fixes trailing commas', () => {
    const input = JSON.stringify({ matches: [{ a: 1, b: 2, }] })
    const result = extractJSON(input)
    expect(result).toBe(input)
    const fixed = fixTrailingCommas(result)
    const parsed = JSON.parse(fixed)
    expect(parsed.matches[0].a).toBe(1)
  })

  it('handles nested objects correctly', () => {
    const input = JSON.stringify({
      matches: [
        { player1Name: "A", nested: { key: "value" } },
        { player1Name: "B" }
      ]
    })
    const result = extractJSON(input)
    expect(result).toBe(input)
  })

  it('handles markdown without json keyword', () => {
    const input = [
      '```',
      '{"matches": [{"player1Name": "A", "player3Name": "B", "team1Score": 1, "team2Score": 0, "winningTeam": 1, "matchType": "solo"}]}',
      '```'
    ].join('\n')
    const result = extractJSON(input)
    expect(result).not.toBeNull()
    const parsed = JSON.parse(result)
    expect(parsed.matches).toHaveLength(1)
  })

  it('returns null for non-JSON text', () => {
    const result = extractJSON('Just some text, no JSON here')
    expect(result).toBeNull()
  })

  it('handles truncated JSON (returns partial, may not parse)', () => {
    const input = '{ "matches": [ { "player1Name": "Hưng Tâm", "player3Name": "Quân Tiến", "team1Score": 4, "team2Score": 2, "winningTeam": 1, "matchType": "duo" }, { "playe'
    const result = extractJSON(input)
    // Should find partial JSON but it won't parse
    expect(result).not.toBeNull()
    // The truncated JSON won't parse, which is expected
    expect(() => JSON.parse(result)).toThrow()
  })
})
