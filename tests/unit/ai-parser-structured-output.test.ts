import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const jsonResponse = (data, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: { 'Content-Type': 'application/json' }
})

const providerResponse = (content) => ({
  choices: [{
    finish_reason: 'stop',
    message: { content: JSON.stringify(content) }
  }]
})

const match = (overrides = {}) => ({
  player1Name: 'Hưng Tâm',
  player2Name: null,
  player3Name: 'Quân Tiến',
  player4Name: null,
  team1Score: 4,
  team2Score: 2,
  winningTeam: 1,
  matchType: 'duo',
  ...overrides
})

describe('AI parser structured output requests', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.stubEnv('AI_BASE_URL', 'https://api.openai.com/v1')
    vi.stubEnv('AI_API_KEY', 'test-key')
    vi.stubEnv('AI_MODEL', 'test-vision-model')
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
  })

  it('counts matches first and enforces the count in the extraction schema', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(providerResponse({ matchCount: 2 })))
      .mockResolvedValueOnce(jsonResponse(providerResponse({
        matches: [match(), match({ player1Name: 'Đức Tâm', player3Name: 'Dũng Tú' })]
      })))
    vi.stubGlobal('fetch', fetchMock)

    const { parseImageMatches } = await import('../../lib/ai-parser.js')
    const result = await parseImageMatches('aGVsbG8=')

    expect(result.matches).toHaveLength(2)
    expect(fetchMock).toHaveBeenCalledTimes(2)

    const countBody = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(countBody.response_format.type).toBe('json_schema')
    expect(countBody.response_format.json_schema.name).toBe('match_count')

    const extractionBody = JSON.parse(fetchMock.mock.calls[1][1].body)
    const matchesSchema = extractionBody.response_format.json_schema.schema.properties.matches
    expect(extractionBody.response_format.type).toBe('json_schema')
    expect(matchesSchema.minItems).toBe(2)
    expect(matchesSchema.maxItems).toBe(2)
    expect(matchesSchema.items.required).toEqual([
      'player1Name', 'player2Name', 'player3Name', 'player4Name',
      'team1Score', 'team2Score', 'winningTeam', 'matchType'
    ])
    expect(extractionBody.messages[1].content[1].image_url.detail).toBe('high')
  })

  it('rejects an incomplete extraction even if the provider ignores minItems', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(providerResponse({ matchCount: 2 })))
      .mockResolvedValueOnce(jsonResponse(providerResponse({ matches: [match()] })))
    vi.stubGlobal('fetch', fetchMock)

    const { parseImageMatches } = await import('../../lib/ai-parser.js')

    await expect(parseImageMatches('aGVsbG8='))
      .rejects.toThrow('AI returned 1 matches after detecting 2')
  })

  it('scales the output budget for screenshots containing many matches', async () => {
    const matches = Array.from({ length: 20 }, (_, index) => match({
      player1Name: `Team ${index + 1}`,
      player3Name: `Opponent ${index + 1}`
    }))
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(providerResponse({ matchCount: 20 })))
      .mockResolvedValueOnce(jsonResponse(providerResponse({ matches })))
    vi.stubGlobal('fetch', fetchMock)

    const { parseImageMatches } = await import('../../lib/ai-parser.js')
    const result = await parseImageMatches('aGVsbG8=')

    expect(result.matches).toHaveLength(20)
    const extractionBody = JSON.parse(fetchMock.mock.calls[1][1].body)
    expect(extractionBody.response_format.json_schema.schema.properties.matches.maxItems).toBe(20)
    expect(extractionBody.max_tokens).toBe(6000)
  })

  it('falls back to json_object when json_schema is unsupported', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({
        error: { message: 'response_format json_schema is unsupported' }
      }, 400))
      .mockResolvedValueOnce(jsonResponse(providerResponse({ matches: [match()] })))
    vi.stubGlobal('fetch', fetchMock)

    const { parseImageMatches } = await import('../../lib/ai-parser.js')
    const result = await parseImageMatches('aGVsbG8=')

    expect(result.matches).toHaveLength(1)
    const extractionBody = JSON.parse(fetchMock.mock.calls[1][1].body)
    expect(extractionBody.response_format).toEqual({ type: 'json_object' })
  })
})
