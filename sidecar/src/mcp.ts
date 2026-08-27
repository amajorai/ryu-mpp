import { Challenge, Mcp, Receipt } from 'mppx'

import { AppError, type McpPaymentRequestInput } from './types.ts'
import { normalizeOrigin } from './validation.ts'

const MCP_PROTOCOL_VERSION = '2025-06-18'
const MAX_ARGUMENT_BYTES = 256 * 1024
const MAX_JSON_DEPTH = 32
const MAX_JSON_NODES = 10_000
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

type JsonRpcEnvelope = {
  error?: { code?: unknown; data?: unknown; message?: unknown }
  id?: unknown
  jsonrpc?: unknown
  result?: unknown
}

export type McpSession = {
  id?: string
  protocolVersion: string
}

export type McpCallOutcome =
  | {
      challenge: Challenge.Challenge
      kind: 'payment_required'
      session: McpSession
    }
  | {
      kind: 'result'
      receipt?: Receipt.Receipt
      result: Record<string, unknown>
      session: McpSession
    }

function assertSafeJson(value: unknown): void {
  let nodes = 0
  const visit = (candidate: unknown, depth: number): void => {
    nodes += 1
    if (nodes > MAX_JSON_NODES || depth > MAX_JSON_DEPTH) {
      throw new AppError('invalid_mcp_arguments', 'MCP arguments are too deeply nested or complex.')
    }
    if (candidate === null || typeof candidate !== 'object') return
    if (Array.isArray(candidate)) {
      for (const item of candidate) visit(item, depth + 1)
      return
    }
    for (const [key, item] of Object.entries(candidate as Record<string, unknown>)) {
      if (FORBIDDEN_KEYS.has(key)) {
        throw new AppError('invalid_mcp_arguments', 'MCP arguments contain a forbidden object key.')
      }
      visit(item, depth + 1)
    }
  }
  visit(value, 0)
}

export function validateMcpPaymentRequest(input: unknown): McpPaymentRequestInput {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new AppError('invalid_mcp_request', 'MCP payment request must be an object.')
  }
  const candidate = input as Record<string, unknown>
  if (typeof candidate.url !== 'string' || candidate.url.length > 4096) {
    throw new AppError('invalid_url', 'A valid MCP server URL is required.')
  }
  let url: URL
  try {
    url = new URL(candidate.url)
  } catch {
    throw new AppError('invalid_url', 'A valid MCP server URL is required.')
  }
  normalizeOrigin(url.origin)
  if (url.hash || url.username || url.password) {
    throw new AppError('invalid_url', 'MCP server URLs cannot contain fragments or credentials.')
  }
  if (
    typeof candidate.tool !== 'string' ||
    candidate.tool.length < 1 ||
    candidate.tool.length > 128 ||
    !/^[A-Za-z0-9._:/-]+$/.test(candidate.tool)
  ) {
    throw new AppError('invalid_mcp_tool', 'MCP tool name is invalid.')
  }
  const args = candidate.arguments ?? {}
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    throw new AppError('invalid_mcp_arguments', 'MCP arguments must be an object.')
  }
  assertSafeJson(args)
  if (new TextEncoder().encode(JSON.stringify(args)).byteLength > MAX_ARGUMENT_BYTES) {
    throw new AppError('mcp_arguments_too_large', 'MCP arguments exceed 256 KiB.', 413)
  }
  const idempotencyKey = candidate.idempotencyKey
  if (
    idempotencyKey !== undefined &&
    (typeof idempotencyKey !== 'string' || !/^[A-Za-z0-9._:-]{8,128}$/.test(idempotencyKey))
  ) {
    throw new AppError('invalid_idempotency_key', 'Idempotency key format is invalid.')
  }
  return {
    arguments: args as Record<string, unknown>,
    ...(typeof idempotencyKey === 'string' ? { idempotencyKey } : {}),
    tool: candidate.tool,
    url: url.toString(),
  }
}

function parseEnvelopeText(
  text: string,
  contentType: string,
  expectedId: unknown,
): JsonRpcEnvelope | null {
  if (!text.trim()) return null
  const candidates = contentType.includes('text/event-stream')
    ? text
        .split(/\r?\n\r?\n/)
        .map((event) =>
          event
            .split(/\r?\n/)
            .filter((line) => line.startsWith('data:'))
            .map((line) => line.slice(5).trimStart())
            .join('\n'),
        )
        .filter((data) => data && data !== '[DONE]')
    : [text]

  for (const candidate of candidates) {
    try {
      const parsed: unknown = JSON.parse(candidate)
      const envelopes = Array.isArray(parsed) ? parsed : [parsed]
      for (const envelope of envelopes) {
        if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) continue
        const typed = envelope as JsonRpcEnvelope
        if (expectedId === undefined || typed.id === expectedId) return typed
      }
    } catch {
      // An SSE stream may include comments or non-JSON events before its result.
    }
  }
  throw new AppError('invalid_mcp_response', 'MCP server returned an invalid JSON-RPC response.', 502)
}

async function postMcp(
  fetcher: typeof fetch,
  url: string,
  payload: Record<string, unknown>,
  session?: McpSession,
): Promise<{ envelope: JsonRpcEnvelope | null; response: Response }> {
  const headers = new Headers({
    accept: 'application/json, text/event-stream',
    'content-type': 'application/json',
  })
  if (session?.id) headers.set('mcp-session-id', session.id)
  if (session) headers.set('mcp-protocol-version', session.protocolVersion)
  const response = await fetcher(url, {
    body: JSON.stringify(payload),
    headers,
    method: 'POST',
  })
  if (response.status === 404 && session?.id) {
    throw new AppError('mcp_session_expired', 'The MCP session expired before payment.', 409)
  }
  const envelope = parseEnvelopeText(
    await response.text(),
    response.headers.get('content-type')?.toLowerCase() ?? '',
    payload.id,
  )
  if (!response.ok && !envelope) {
    throw new AppError('mcp_http_error', `MCP server returned HTTP ${response.status}.`, 502)
  }
  return { envelope, response }
}

function parseChallenge(data: unknown): Challenge.Challenge | undefined {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return undefined
  const challenges = (data as Record<string, unknown>).challenges
  if (!Array.isArray(challenges)) return undefined
  for (const candidate of challenges) {
    const parsed = Challenge.Schema.safeParse(candidate)
    if (parsed.success) return parsed.data
  }
  return undefined
}

function paymentChallenge(envelope: JsonRpcEnvelope): Challenge.Challenge | undefined {
  if (envelope.error?.code === Mcp.paymentRequiredCode) {
    return parseChallenge(envelope.error.data)
  }
  if (!envelope.result || typeof envelope.result !== 'object' || Array.isArray(envelope.result)) {
    return undefined
  }
  const meta = (envelope.result as Record<string, unknown>)._meta
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return undefined
  return parseChallenge((meta as Record<string, unknown>)[Mcp.paymentRequiredMetaKey])
}

function resultReceipt(result: Record<string, unknown>): Receipt.Receipt | undefined {
  const meta = result._meta
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return undefined
  const parsed = Receipt.Schema.safeParse((meta as Record<string, unknown>)[Mcp.receiptMetaKey])
  return parsed.success ? parsed.data : undefined
}

function safeSessionId(response: Response): string | undefined {
  const value = response.headers.get('mcp-session-id')
  if (!value || value.length > 1024 || /[\r\n]/.test(value)) return undefined
  return value
}

async function initialize(fetcher: typeof fetch, url: string): Promise<McpSession> {
  const { envelope, response } = await postMcp(fetcher, url, {
    id: 1,
    jsonrpc: '2.0',
    method: 'initialize',
    params: {
      capabilities: {},
      clientInfo: { name: 'ryu-mpp', version: '0.1.14' },
      protocolVersion: MCP_PROTOCOL_VERSION,
    },
  })
  if (!envelope?.result || typeof envelope.result !== 'object' || Array.isArray(envelope.result)) {
    throw new AppError('mcp_initialize_failed', 'MCP server did not accept initialization.', 502)
  }
  const reportedVersion = (envelope.result as Record<string, unknown>).protocolVersion
  const protocolVersion =
    typeof reportedVersion === 'string' && /^[0-9-]{1,32}$/.test(reportedVersion)
      ? reportedVersion
      : MCP_PROTOCOL_VERSION
  const sessionId = safeSessionId(response)
  const session: McpSession = {
    ...(sessionId ? { id: sessionId } : {}),
    protocolVersion,
  }
  await postMcp(
    fetcher,
    url,
    { jsonrpc: '2.0', method: 'notifications/initialized', params: {} },
    session,
  )
  return session
}

export async function callMcpTool(
  fetcher: typeof fetch,
  request: McpPaymentRequestInput,
  credential?: Record<string, unknown>,
  existingSession?: McpSession,
): Promise<McpCallOutcome> {
  const session = existingSession ?? (await initialize(fetcher, request.url))
  const params: Record<string, unknown> = {
    arguments: request.arguments,
    name: request.tool,
  }
  if (credential) params._meta = { [Mcp.credentialMetaKey]: credential }
  const { envelope } = await postMcp(
    fetcher,
    request.url,
    { id: 2, jsonrpc: '2.0', method: 'tools/call', params },
    session,
  )
  if (!envelope) {
    throw new AppError('invalid_mcp_response', 'MCP tool call returned no JSON-RPC response.', 502)
  }
  const challenge = paymentChallenge(envelope)
  if (challenge) return { challenge, kind: 'payment_required', session }
  if (envelope.error) {
    const code = typeof envelope.error.code === 'number' ? envelope.error.code : 'unknown'
    throw new AppError('mcp_tool_error', `MCP tool call failed with JSON-RPC code ${code}.`, 409)
  }
  if (!envelope.result || typeof envelope.result !== 'object' || Array.isArray(envelope.result)) {
    throw new AppError('invalid_mcp_response', 'MCP tool call returned no result.', 502)
  }
  const result = envelope.result as Record<string, unknown>
  const receipt = resultReceipt(result)
  return { kind: 'result', ...(receipt ? { receipt } : {}), result, session }
}
