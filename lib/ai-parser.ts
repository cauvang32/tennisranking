/**
 * Tennis Ranking System — AI Image Parser
 *
 * Calls OpenAI-compatible Chat Completions API with vision capability to
 * extract match results from uploaded screenshots (chat messages, scoreboards, etc.).
 *
 * Expected env vars:
 *   AI_API_KEY    — OpenAI-compatible API key (required)
 *   AI_MODEL      — Model to use (default: "gpt-4o")
 *   AI_BASE_URL   — Base URL for API (default: "https://api.openai.com/v1")
 */

const AI_MODEL = process.env.AI_MODEL || 'gpt-4o'
const AI_BASE_URL = (process.env.AI_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, '')
const AI_API_KEY = process.env.AI_API_KEY || ''
const AI_PROBE_TIMEOUT_MS = 10000
const AI_REQUEST_TIMEOUT_MS = Number(process.env.AI_REQUEST_TIMEOUT_MS) || 60000
const MAX_MATCH_COUNT = 50

const MATCH_ITEM_SCHEMA = {
  type: 'object',
  properties: {
    player1Name: { type: 'string' },
    player2Name: { type: ['string', 'null'] },
    player3Name: { type: 'string' },
    player4Name: { type: ['string', 'null'] },
    team1Score: { type: 'integer' },
    team2Score: { type: 'integer' },
    winningTeam: { type: 'integer', enum: [1, 2] },
    matchType: { type: 'string', enum: ['solo', 'duo'] }
  },
  // Strict structured-output providers require every property to be listed,
  // including nullable properties.
  required: [
    'player1Name', 'player2Name', 'player3Name', 'player4Name',
    'team1Score', 'team2Score', 'winningTeam', 'matchType'
  ],
  additionalProperties: false
}

const MATCH_COUNT_RESPONSE_FORMAT = {
  type: 'json_schema',
  json_schema: {
    name: 'match_count',
    strict: true,
    schema: {
      type: 'object',
      properties: {
        matchCount: { type: 'integer', minimum: 0, maximum: MAX_MATCH_COUNT }
      },
      required: ['matchCount'],
      additionalProperties: false
    }
  }
}

function createMatchResponseFormat(expectedCount) {
  const matchesSchema: Record<string, any> = {
    type: 'array',
    items: MATCH_ITEM_SCHEMA
  }

  if (Number.isInteger(expectedCount)) {
    matchesSchema.minItems = expectedCount
    matchesSchema.maxItems = expectedCount
  }

  return {
    type: 'json_schema',
    json_schema: {
      name: 'match_extraction',
      strict: true,
      schema: {
        type: 'object',
        properties: { matches: matchesSchema },
        required: ['matches'],
        additionalProperties: false
      }
    }
  }
}

function extractionTokenBudget(expectedCount) {
  if (!Number.isInteger(expectedCount)) return 4000
  return Math.min(16000, Math.max(4000, expectedCount * 300))
}

// Extract hostname from AI_BASE_URL for safe domain comparison (avoid substring matching)
const AI_HOSTNAME = (() => {
  try { return new URL(AI_BASE_URL).hostname } catch { return '' }
})()

const SYSTEM_PROMPT = `You are a tennis match score extractor.  You MUST output EXACTLY this JSON structure — no extra fields, no field name changes:
{"matches":[{"player1Name":"TeamA","player2Name":null,"player3Name":"TeamB","player4Name":null,"team1Score":4,"team2Score":2,"winningTeam":1,"matchType":"duo"}]}

Rules:
- Field names are EXACTLY: player1Name, player2Name, player3Name, player4Name, team1Score, team2Score, winningTeam, matchType
- NEVER use home_team, away_team, score, or any other field names
- team1Score and team2Score are INTEGER numbers (not strings)
- winningTeam is 1 or 2 (the team with higher score)
- matchType is "duo" if names have spaces (team nicknames), "solo" if single-word names
- player2Name and player4Name are always null`

/**
 * Detect whether the configured API is LM Studio's native format
 * (uses /api/v1/chat with input/output) vs OpenAI-compatible format
 * (uses /v1/chat/completions with messages/choices).
 *
 * Strategy: send a minimal request to both endpoints and inspect the
 * response structure.  Only /v1/chat/completions returns { choices }.
 * Only /api/v1/chat returns { output }.
 */
const detectApiFormat = async () => {
  // L4: Skip probing for known OpenAI-compatible endpoints — saves tokens and latency.
  // OpenAI, Azure OpenAI, and most vLLM/Ollama proxies use the OpenAI format.
  // Compare against extracted hostname to avoid false positives from substring matching.
  if (!AI_BASE_URL || AI_HOSTNAME === 'api.openai.com' ||
      AI_HOSTNAME.endsWith('.openai.azure.com') ||
      AI_HOSTNAME === 'api.anthropic.com' ||
      AI_HOSTNAME === 'openrouter.ai') {
    return 'openai'
  }

  const probeUrl = `${AI_BASE_URL}/chat/completions`
  const probeHeaders = { 'Content-Type': 'application/json' }
  if (AI_API_KEY) probeHeaders['Authorization'] = `Bearer ${AI_API_KEY}`
  try {
    const resp = await fetch(probeUrl, {
      method: 'POST',
      headers: probeHeaders,
      signal: AbortSignal.timeout(AI_PROBE_TIMEOUT_MS),
      body: JSON.stringify({
        model: AI_MODEL,
        messages: [{ role: 'user', content: 'test' }],
        max_tokens: 10,
        stream: false
      })
    })
    const data = await resp.json()
    // OpenAI-compatible returns { choices: [...] }
    if (data?.choices && Array.isArray(data.choices)) return 'openai'
    // LM Studio native returns { output: "..." }
    if (data?.output !== undefined) return 'lmstudio'
    // Server returns 200 but with an error payload — fall through
  } catch { /* fall through */ }

  // Fallback: try LM Studio native endpoint
  const lmStudioHeaders = { 'Content-Type': 'application/json' }
  if (AI_API_KEY) lmStudioHeaders['Authorization'] = `Bearer ${AI_API_KEY}`
  try {
    const resp = await fetch(`${AI_BASE_URL}/api/v1/chat`, {
      method: 'POST',
      headers: lmStudioHeaders,
      signal: AbortSignal.timeout(AI_PROBE_TIMEOUT_MS),
      body: JSON.stringify({ model: AI_MODEL, input: 'test', max_tokens: 10, stream: false })
    })
    const data = await resp.json()
    if (data?.output !== undefined) return 'lmstudio'
  } catch { /* fall through */ }

  // Default to OpenAI-compatible (most common for local servers)
  return 'openai'
}

// H5: State machine for format detection — supports retry after transient failures.
// 'pending' → first probe needed. 'cached' → success, keep forever. 'failed' → retry after backoff.
let apiFormat = null
let probeState = 'pending' // 'pending' | 'cached' | 'failed'
let probeTime = 0
const PROBE_BACKOFF_MS = 5 * 60 * 1000 // 5 minutes between retry attempts

// L4: Limit total probes per hour to avoid burning tokens on repeated restarts
let probeCount = 0
let probeHourReset = 0
const MAX_PROBES_PER_HOUR = 2

const getApiFormat = async () => {
  // Already cached successfully — no need to re-probe
  if (probeState === 'cached') return apiFormat

  // Failed previously — only retry after backoff
  if (probeState === 'failed' && Date.now() - probeTime < PROBE_BACKOFF_MS) {
    return apiFormat || 'openai'
  }

  // L4: Enforce hourly probe budget to avoid burning tokens on repeated restarts
  const now = Date.now()
  if (now - probeHourReset > 3600 * 1000) {
    probeCount = 0
    probeHourReset = now
  }
  if (probeCount >= MAX_PROBES_PER_HOUR && probeState !== 'pending') {
    console.warn(`⚠️ AI format probe budget exhausted (${MAX_PROBES_PER_HOUR}/hour). Using cached or default 'openai'.`)
    return apiFormat || 'openai'
  }

  probeCount++
  try {
    apiFormat = await detectApiFormat()
    probeState = 'cached'
    if (apiFormat === 'lmstudio') {
      console.log('🔍 AI API detected: LM Studio native format (input/output)')
    } else {
      console.log('🔍 AI API detected: OpenAI-compatible format (messages/choices)')
    }
  } catch (err) {
    probeState = 'failed'
    probeTime = Date.now()
    // C4: Sanitize error message to prevent log injection from external API responses
    const sanitizedMsg = err.message.substring(0, 100)
      .replace(/(sk-|sk_live_|sk_test_|key-|api_key-)\S{4}[^\s"']*/g, '$1***')
    console.warn('⚠️ AI format probe failed (', probeCount + '/' + MAX_PROBES_PER_HOUR + ' used):', sanitizedMsg + '. Retrying in ' + PROBE_BACKOFF_MS / 1000 + 's.')
  }
  return apiFormat || 'openai'
}

/**
 * Call the AI vision API (OpenAI-compatible or LM Studio native) with an
 * image and return parsed matches.
 *
 * @param {string} base64Image — base64-encoded image data (without data: URI prefix)
 * @returns {Promise<{ matches: Array<MatchResult> }>}
 */
export async function parseImageMatches(base64Image, options: { signal?: AbortSignal } = {}) {
  const format = await getApiFormat()
  const createRequestSignal = () => {
    const timeoutSignal = AbortSignal.timeout(AI_REQUEST_TIMEOUT_MS)
    return options.signal
      ? AbortSignal.any([options.signal, timeoutSignal])
      : timeoutSignal
  }

  let response
  let expectedMatchCount = null

  if (format === 'openai') {
    // ── OpenAI-compatible format ────────────────────────────────────────
    const url = `${AI_BASE_URL}/chat/completions`

    const buildVisionMessages = (systemPrompt, instruction) => [
      { role: 'system', content: systemPrompt },
      {
        role: 'user',
        content: [
          { type: 'text', text: instruction },
          {
            type: 'image_url',
            image_url: {
              url: `data:image/png;base64,${base64Image}`,
              detail: 'high'
            }
          }
        ]
      }
    ]

    const sendRequest = (payload) =>
      fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${AI_API_KEY}`
        },
        signal: createRequestSignal(),
        body: JSON.stringify(payload)
      })

    // A schema guarantees the shape of each object, but an unconstrained
    // array can still be closed early. Count first, then make the extraction
    // schema require exactly that many array items.
    const countBody = {
      model: AI_MODEL,
      messages: buildVisionMessages(
        'Count tennis match result messages in screenshots. Ignore sender names and timestamps. Count every distinct result in the entire image from top to bottom.',
        'Count every tennis match result in the entire screenshot.'
      ),
      temperature: 0,
      max_tokens: 1000,
      stream: false,
      response_format: MATCH_COUNT_RESPONSE_FORMAT
    }

    const countResponse = await sendRequest(countBody)
    let supportsJsonSchema = true

    if (countResponse.ok) {
      const countData = await countResponse.json()
      expectedMatchCount = parseMatchCount(countData)
      if (!Number.isInteger(expectedMatchCount) ||
          expectedMatchCount < 0 || expectedMatchCount > MAX_MATCH_COUNT) {
        throw new Error('AI returned an invalid structured match count')
      }
      if (expectedMatchCount === 0) return { matches: [] }
    } else if (await isResponseFormatRejection(countResponse)) {
      supportsJsonSchema = false
    } else {
      response = countResponse
    }

    if (!response) {
      const countRule = Number.isInteger(expectedMatchCount)
        ? ` The screenshot contains exactly ${expectedMatchCount} matches. Return exactly ${expectedMatchCount} match objects.`
        : ''
      const body = {
        model: AI_MODEL,
        messages: buildVisionMessages(
          `${SYSTEM_PROMPT}\n- Scan the ENTIRE image from top to bottom.${countRule}`,
          Number.isInteger(expectedMatchCount)
            ? `Extract all ${expectedMatchCount} tennis match results from the entire screenshot.`
            : 'Extract all tennis match results from the entire screenshot.'
        ),
        temperature: 0,
        max_tokens: extractionTokenBudget(expectedMatchCount),
        stream: false,
        response_format: supportsJsonSchema
          ? createMatchResponseFormat(expectedMatchCount)
          : { type: 'json_object' }
      }

      response = await sendRequest(body)

      // Preserve compatibility with servers that support neither json_schema
      // nor json_object. Their plain-text JSON is still parsed below.
      if (await isResponseFormatRejection(response)) {
        const { response_format: _omit, ...retryBody } = body
        response = await sendRequest(retryBody)
      }
    }
  } else {
    // ── LM Studio native format ─────────────────────────────────────────
    // Uses /api/v1/chat with { input, ... } → { output, done, ... }
    const url = `${AI_BASE_URL}/api/v1/chat`

    const body = {
      model: AI_MODEL,
      input: `${SYSTEM_PROMPT}\n\nExtract all tennis match results from this screenshot.`,
      temperature: 0,
      max_tokens: 1000,
      stream: false
    }

    // LM Studio native API does NOT support image_url in messages.
    // If an image is provided, include it as a hint in the input text.
    if (base64Image && base64Image.length > 0) {
      throw new Error(
        'LM Studio native API does not support image input. ' +
        'To use image parsing, configure AI_BASE_URL to an OpenAI-compatible endpoint (e.g., https://api.openai.com/v1 or a vLLM proxy with vision support).'
      )
    }

    const headers = { 'Content-Type': 'application/json' }
    if (AI_API_KEY && AI_API_KEY !== 'lmstudio') {
      headers['Authorization'] = `Bearer ${AI_API_KEY}`
    }

    response = await fetch(url, {
      method: 'POST',
      headers,
      signal: createRequestSignal(),
      body: JSON.stringify(body)
    })
  }

  if (!response.ok) {
    const text = await response.text()
    // C4: Sanitize error text — truncate and strip potential API key prefixes
    // that the provider might echo back (e.g. "Invalid key: sk-proj-abc123...")
    const sanitized = text.substring(0, 100)
      .replace(/(sk-|sk_live_|sk_test_|key-|api_key-)\S{4}[^\s"']*/g, '$1***')
    throw new Error(`AI API error ${response.status}: ${sanitized}`)
  }

  const data = await response.json()
  const parsed = parseMatchesResponse(data)

  if (!parsed.matches || !Array.isArray(parsed.matches)) {
    throw new Error('AI response missing "matches" array')
  }

  if (Number.isInteger(expectedMatchCount) && parsed.matches.length !== expectedMatchCount) {
    throw new Error(
      `AI returned ${parsed.matches.length} matches after detecting ${expectedMatchCount}`
    )
  }

  // ── Normalize alternative field names the model may use ──────────────────
  // Some models (e.g. qwen, llama) output { home_team, away_team, score }
  // instead of { player1Name, player3Name, team1Score, team2Score }.
  // Normalize all of them to the canonical format.
  const normalizedMatches = parsed.matches.map((m) => normalizeMatch(m))

  return { matches: normalizedMatches }
}

async function isResponseFormatRejection(response) {
  if (response.ok || ![400, 422].includes(response.status)) return false

  let errorText = ''
  try {
    errorText = (await response.clone().text()).slice(0, 1000).toLowerCase()
  } catch {}

  return [
    'response_format',
    'json_schema',
    'json schema',
    'json_object',
    'structured output',
    'llguidance'
  ].some(marker => errorText.includes(marker))
}

function parseJsonCandidate(candidate) {
  if (candidate && typeof candidate === 'object') return candidate
  if (!candidate || typeof candidate !== 'string') return null

  let json = extractJSON(candidate)
  if (!json) return null
  json = json.replace(/,\s*([}\]])/g, '$1')

  try {
    return JSON.parse(json)
  } catch {
    return null
  }
}

function responseCandidates(data) {
  const message = data?.choices?.[0]?.message
  return [message?.content, data?.output, data?.text, message?.reasoning_content]
}

function parseMatchCount(data) {
  for (const candidate of responseCandidates(data)) {
    const parsed = parseJsonCandidate(candidate)
    if (Number.isInteger(parsed?.matchCount)) return parsed.matchCount
  }
  return null
}

function parseMatchesResponse(data) {
  const candidates = responseCandidates(data)
  for (const candidate of candidates) {
    const parsed = parseJsonCandidate(candidate)
    if (parsed?.matches && Array.isArray(parsed.matches)) return parsed
  }

  const raw = candidates.find(candidate => typeof candidate === 'string' && candidate)
  if (!raw) {
    throw new Error(`AI returned empty response. Response: ${JSON.stringify(data).substring(0, 500)}`)
  }
  throw new Error(`AI did not return valid matches JSON. Raw: ${raw.substring(0, 500)}`)
}

/**
 * Normalize a single match object to the canonical format.
 * Handles alternative field names:
 *   home_team → player1Name, away_team → player3Name
 *   score (string "X-Y") → team1Score, team2Score, winningTeam
 *   winner (1|2) → winningTeam
 */
function normalizeMatch(m) {
  const result = {
    player1Name: (typeof m.player1Name === 'string' && m.player1Name.trim()) || null,
    player2Name: null,
    player3Name: (typeof m.player3Name === 'string' && m.player3Name.trim()) || null,
    player4Name: null,
    team1Score: 0,
    team2Score: 0,
    winningTeam: 1,
    matchType: 'duo'
  }

  // Map alternative field names
  if (!result.player1Name && typeof m.home_team === 'string') result.player1Name = m.home_team.trim()
  if (!result.player3Name && typeof m.away_team === 'string') result.player3Name = m.away_team.trim()

  // Map score string "X-Y" → team1Score, team2Score
  if (typeof m.score === 'string' && /-/.test(m.score)) {
    const [s1, s2] = m.score.split('-').map(Number)
    result.team1Score = Number.isFinite(s1) ? s1 : 0
    result.team2Score = Number.isFinite(s2) ? s2 : 0
  }
  if (typeof m.team1Score === 'number') result.team1Score = m.team1Score
  if (typeof m.team2Score === 'number') result.team2Score = m.team2Score

  // Map winner field (if present)
  if (typeof m.winner === 'number') {
    result.winningTeam = m.winner === 1 ? 1 : 2
  } else {
    // Derive winningTeam from scores
    if (result.team1Score > result.team2Score) result.winningTeam = 1
    else result.winningTeam = 2
  }

  // Determine matchType: multi-word names → duo, single-word → solo
  const p1 = result.player1Name || ''
  const p3 = result.player3Name || ''
  const p1Words = p1.split(/\s+/).filter(Boolean).length
  const p3Words = p3.split(/\s+/).filter(Boolean).length

  // If either team name has multiple words, it's a team nickname → duo
  if (p1Words > 1 || p3Words > 1) {
    result.matchType = 'duo'
  } else {
    result.matchType = 'solo'
  }

  return result
}

/**
 * Extract the outermost balanced JSON object or array from text.
 * Handles: markdown code fences, trailing commas, extra text.
 * @param {string} text
 * @returns {string|null}
 */
function extractJSON(text) {
  // Strip markdown code fences
  const cleaned = text
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

  // Last resort: simple regex
  return cleaned.match(/\{[\s\S]*\}/)?.[0] || null
}
