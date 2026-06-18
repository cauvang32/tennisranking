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

const SYSTEM_PROMPT = `Extract tennis match results from the image as JSON.
Format: "TeamA X-Y TeamB" (X, Y = scores). Higher score = winner.
Multi-word names (e.g. "Hưng Tâm") are team nicknames → matchType "duo".
Single-word names → matchType "solo".
player2Name and player4Name are always null. Output: {"matches": [{"player1Name":"...","player2Name":null,"player3Name":"...","player4Name":null,"team1Score":4,"team2Score":2,"winningTeam":1,"matchType":"duo"}]}`

/**
 * Call OpenAI-compatible vision API with an image and return parsed matches.
 * @param {string} base64Image — base64-encoded image data (without data: URI prefix)
 * @returns {Promise<{ matches: Array<MatchResult> }>}
 */
export async function parseImageMatches(base64Image) {
  const url = `${AI_BASE_URL}/chat/completions`

  const isLocalApi = !AI_BASE_URL.includes('api.openai.com')

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
  }

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.AI_API_KEY}`
    },
    body: JSON.stringify(body)
  })

  if (!response.ok) {
    const body = await response.text()
    throw new Error(`AI API error ${response.status}: ${body}`)
  }

  const data = await response.json()

  // Handle multiple API response formats:
  // 1. Standard OpenAI: { choices: [{ message: { content: "..." } }] }
  // 2. LM Studio / compatible: { output: { matches: [...] } } (raw JSON object)
  // 3. LM Studio text: { output: "..." } (raw string)
  // 4. vLLM: { text: "..." } (raw string)
  // 5. LM Studio with reasoning: { choices: [{ message: { content: "", reasoning_content: "..." } }] }

  const message = data?.choices?.[0]?.message
  const content = message?.content
  const rawOutput = data?.output
  const textOutput = data?.text

  // Try LM Studio / compatible raw output
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
  const reasoningContent = message?.reasoning_content
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

  return parsed
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
