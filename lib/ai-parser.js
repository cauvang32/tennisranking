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

import config from '../config/env.js'

const AI_MODEL = process.env.AI_MODEL || 'gpt-4o'
const AI_BASE_URL = (process.env.AI_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, '')
const AI_API_KEY = process.env.AI_API_KEY || ''

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
  if (!AI_BASE_URL || AI_BASE_URL.includes('api.openai.com') ||
      AI_BASE_URL.includes('openai.azure.com') ||
      AI_BASE_URL.includes('api.anthropic.com') ||
      AI_BASE_URL.includes('openrouter.ai')) {
    return 'openai'
  }

  const probeUrl = `${AI_BASE_URL}/chat/completions`
  const probeHeaders = { 'Content-Type': 'application/json' }
  if (AI_API_KEY) probeHeaders['Authorization'] = `Bearer ${AI_API_KEY}`
  try {
    const resp = await fetch(probeUrl, {
      method: 'POST',
      headers: probeHeaders,
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
    console.warn(`⚠️ AI format probe failed (${probeCount}/${MAX_PROBES_PER_HOUR} used): ${err.message}. Retrying in ${PROBE_BACKOFF_MS / 1000}s.`)
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
export async function parseImageMatches(base64Image) {
  const format = await getApiFormat()

  let response
  let data

  if (format === 'openai') {
    // ── OpenAI-compatible format ────────────────────────────────────────
    const url = `${AI_BASE_URL}/chat/completions`

    const body = {
      model: AI_MODEL,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Extract all tennis match results from this screenshot.' },
            {
              type: 'image_url',
              image_url: {
                url: `data:image/png;base64,${base64Image}`,
                detail: 'high'
              }
            }
          ]
        }
      ],
      temperature: 0,
      max_tokens: 8192,
      stream: false
    }

    // Use response_format only for official OpenAI API
    const isLocalApi = !AI_BASE_URL.includes('api.openai.com')
    if (!isLocalApi) {
      body.response_format = {
        type: 'json_schema',
        json_schema: {
          name: 'match_extraction',
          schema: {
            type: 'object',
            properties: {
              matches: {
                type: 'array',
                items: {
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
                  required: ['player1Name', 'player3Name', 'team1Score', 'team2Score', 'winningTeam', 'matchType'],
                  additionalProperties: false
                }
              }
            },
            required: ['matches'],
            additionalProperties: false
          },
          strict: true
        }
      }
    } else {
      // Local APIs (e.g. Ollama, vLLM, LM Studio) - enforce json_object to guarantee JSON output
      body.response_format = {
        type: 'json_object'
      }
    }

    response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${AI_API_KEY}`
      },
      body: JSON.stringify(body)
    })
  } else {
    // ── LM Studio native format ─────────────────────────────────────────
    // Uses /api/v1/chat with { input, ... } → { output, done, ... }
    const url = `${AI_BASE_URL}/api/v1/chat`

    const body = {
      model: AI_MODEL,
      input: `${SYSTEM_PROMPT}\n\nExtract all tennis match results from this screenshot.`,
      temperature: 0,
      max_tokens: 8192,
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

  data = await response.json()

  // ── Handle multiple API response formats ──────────────────────────────

  // 1. OpenAI format: { choices: [{ message: { content: "..." } }] }
  const message = data?.choices?.[0]?.message
  const content = message?.content

  // 2. LM Studio native format: { output: "..." } (text response)
  const rawOutput = data?.output

  // 3. vLLM / some proxies: { text: "..." } (raw string)
  const textOutput = data?.text

  // 4. LM Studio with reasoning: { choices: [{ message: { content: "", reasoning_content: "..." } }] }
  const reasoningContent = message?.reasoning_content

  // 5. LM Studio raw JSON output (when model returns structured JSON in output field)
  if (rawOutput && typeof rawOutput === 'object' && rawOutput.matches) {
    if (Array.isArray(rawOutput.matches)) return rawOutput
  }

  // Try vLLM format
  if (textOutput && typeof textOutput === 'object') return textOutput

  // If we got a raw JSON object from LM Studio, return it
  if (rawOutput && typeof rawOutput === 'object') return rawOutput

  // Try OpenAI response_format json_schema format (message.content is an object)
  if (message?.content && typeof message.content === 'object') return message.content

  // Handle LM Studio / local models that put structured output in reasoning_content
  if (reasoningContent && typeof reasoningContent === 'string') {
    const rcJson = extractJSON(reasoningContent)
    if (rcJson) {
      try {
        const parsed = JSON.parse(rcJson)
        if (parsed.matches && Array.isArray(parsed.matches)) return parsed
      } catch {}
    }
  }

  // Fallback: extract from text content (string)
  const text = content || rawOutput || textOutput
  if (!text || typeof text !== 'string') {
    throw new Error(`AI returned empty response. Response: ${JSON.stringify(data).substring(0, 500)}`)
  }

  let jsonStr = extractJSON(text)
  if (!jsonStr) {
    throw new Error(`AI did not return valid JSON. Raw: ${text.substring(0, 500)}`)
  }

  // Fix common JSON issues: trailing commas
  jsonStr = jsonStr.replace(/,\s*([}\]])/g, '$1')

  let parsed
  try {
    parsed = JSON.parse(jsonStr)
  } catch {
    throw new Error(`AI returned unparseable JSON. Raw: ${text.substring(0, 500)}`)
  }

  if (!parsed.matches || !Array.isArray(parsed.matches)) {
    throw new Error('AI response missing "matches" array')
  }

  // ── Normalize alternative field names the model may use ──────────────────
  // Some models (e.g. qwen, llama) output { home_team, away_team, score }
  // instead of { player1Name, player3Name, team1Score, team2Score }.
  // Normalize all of them to the canonical format.
  const normalizedMatches = parsed.matches.map((m) => normalizeMatch(m))

  return { matches: normalizedMatches }
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

  // Last resort: simple regex
  return cleaned.match(/\{[\s\S]*\}/)?.[0] || null
}
