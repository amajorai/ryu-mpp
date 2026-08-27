import { createHash, randomBytes } from 'node:crypto'
import { Challenge as ChallengeCodec } from 'mppx'

import {
  AppError,
  PATH_USD_ADDRESS,
  PATH_USD_DECIMALS,
  TEMPO_TESTNET_CHAIN_ID,
  type NormalizedChallenge,
  type PaymentRequestInput,
} from './types.ts'

const MAX_BODY_BYTES = 256 * 1024
const MAX_HEADER_VALUE_BYTES = 8 * 1024
const ALLOWED_HEADERS = new Set(['accept', 'content-type', 'if-none-match'])
const ALLOWED_METHODS = new Set<PaymentRequestInput['method']>([
  'DELETE',
  'GET',
  'HEAD',
  'PATCH',
  'POST',
  'PUT',
])

export function parseAtomicAmount(value: unknown, field: string): bigint {
  if (typeof value !== 'string' || !/^(0|[1-9]\d*)$/.test(value)) {
    throw new AppError('invalid_amount', `${field} must be a non-negative integer string.`)
  }
  return BigInt(value)
}

export function formatAtomicAmount(value: string, decimals = PATH_USD_DECIMALS): string {
  const atomic = parseAtomicAmount(value, 'amount')
  const unit = 10n ** BigInt(decimals)
  const whole = atomic / unit
  const fraction = (atomic % unit).toString().padStart(decimals, '0').replace(/0+$/, '')
  return fraction.length > 0 ? `${whole}.${fraction}` : whole.toString()
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(',')}}`
}

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

export function randomToken(): string {
  return randomBytes(32).toString('base64url')
}

export function normalizeOrigin(value: string): string {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new AppError('invalid_origin', 'Origin must be a valid absolute URL.')
  }
  const insecureLoopbackAllowed =
    process.env.RYU_MPP_ALLOW_INSECURE_LOOPBACK === '1' &&
    url.protocol === 'http:' &&
    (url.hostname === '127.0.0.1' || url.hostname === '[::1]' || url.hostname === 'localhost')
  if (url.protocol !== 'https:' && !insecureLoopbackAllowed) {
    throw new AppError('insecure_origin', 'Only HTTPS payment origins are allowed.')
  }
  if (url.username || url.password) {
    throw new AppError('invalid_origin', 'Origins cannot contain credentials.')
  }
  return url.origin
}

export function validatePaymentRequest(input: unknown): PaymentRequestInput {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new AppError('invalid_request', 'Payment request must be an object.')
  }
  const candidate = input as Record<string, unknown>
  const method = typeof candidate.method === 'string' ? candidate.method.toUpperCase() : ''
  if (!ALLOWED_METHODS.has(method as PaymentRequestInput['method'])) {
    throw new AppError('invalid_method', 'Unsupported HTTP method.')
  }

  if (typeof candidate.url !== 'string' || candidate.url.length > 4096) {
    throw new AppError('invalid_url', 'A valid payment URL is required.')
  }
  let url: URL
  try {
    url = new URL(candidate.url)
  } catch {
    throw new AppError('invalid_url', 'A valid payment URL is required.')
  }
  normalizeOrigin(url.origin)
  if (url.hash || url.username || url.password) {
    throw new AppError('invalid_url', 'Payment URLs cannot contain fragments or credentials.')
  }

  let body: string | undefined
  if (candidate.body !== undefined) {
    if (typeof candidate.body !== 'string') {
      throw new AppError('invalid_body', 'Request body must be a string.')
    }
    if (new TextEncoder().encode(candidate.body).byteLength > MAX_BODY_BYTES) {
      throw new AppError('body_too_large', 'Request body exceeds 256 KiB.', 413)
    }
    body = candidate.body
  }

  let headers: Record<string, string> | undefined
  if (candidate.headers !== undefined) {
    if (!candidate.headers || typeof candidate.headers !== 'object' || Array.isArray(candidate.headers)) {
      throw new AppError('invalid_headers', 'Headers must be a string map.')
    }
    headers = {}
    for (const [rawName, rawValue] of Object.entries(candidate.headers)) {
      const name = rawName.toLowerCase()
      if (!ALLOWED_HEADERS.has(name)) {
        throw new AppError('header_not_allowed', `Header ${rawName} is not allowed.`)
      }
      if (typeof rawValue !== 'string' || rawValue.length > MAX_HEADER_VALUE_BYTES) {
        throw new AppError('invalid_header', `Header ${rawName} is invalid.`)
      }
      if (/\r|\n/.test(rawValue)) {
        throw new AppError('invalid_header', `Header ${rawName} contains forbidden characters.`)
      }
      headers[name] = rawValue
    }
  }

  const idempotencyKey = candidate.idempotencyKey
  if (
    idempotencyKey !== undefined &&
    (typeof idempotencyKey !== 'string' || !/^[A-Za-z0-9._:-]{8,128}$/.test(idempotencyKey))
  ) {
    throw new AppError('invalid_idempotency_key', 'Idempotency key format is invalid.')
  }

  return {
    ...(body === undefined ? {} : { body }),
    ...(headers === undefined ? {} : { headers }),
    ...(typeof idempotencyKey === 'string' ? { idempotencyKey } : {}),
    method: method as PaymentRequestInput['method'],
    url: url.toString(),
  }
}

export function normalizeChallenge(
  challenge: ChallengeCodec.Challenge,
  url: string,
): NormalizedChallenge {
  if (challenge.method !== 'tempo' || challenge.intent !== 'charge') {
    throw new AppError('unsupported_payment_method', 'Only Tempo charge challenges are supported.')
  }
  const request = challenge.request
  const amountAtomic = parseAtomicAmount(request.amount, 'challenge amount').toString()
  if (typeof request.currency !== 'string' || request.currency.toLowerCase() !== PATH_USD_ADDRESS) {
    throw new AppError('unsupported_currency', 'Only pathUSD on Tempo testnet is supported.')
  }
  if (typeof request.recipient !== 'string' || !/^0x[a-fA-F0-9]{40}$/.test(request.recipient)) {
    throw new AppError('invalid_payee', 'Challenge payee is invalid.')
  }
  const details = request.methodDetails
  if (!details || typeof details !== 'object' || Array.isArray(details)) {
    throw new AppError('invalid_challenge', 'Tempo challenge is missing method details.')
  }
  const chainId = (details as Record<string, unknown>).chainId
  if (chainId !== TEMPO_TESTNET_CHAIN_ID) {
    throw new AppError('unsupported_network', 'Only Tempo testnet payments are supported.')
  }
  if (challenge.expires && Date.parse(challenge.expires) <= Date.now()) {
    throw new AppError('challenge_expired', 'The payment challenge has expired.', 409)
  }
  const origin = new URL(url).origin
  const challengeHash = sha256(ChallengeCodec.serialize(challenge))
  return {
    amountAtomic,
    chainId,
    challengeHash,
    challengeId: challenge.id,
    currency: request.currency.toLowerCase(),
    decimals: PATH_USD_DECIMALS,
    ...(challenge.description ? { description: challenge.description } : {}),
    ...(challenge.digest ? { digest: challenge.digest } : {}),
    ...(challenge.expires ? { expiresAt: challenge.expires } : {}),
    intent: challenge.intent,
    method: 'tempo',
    origin,
    payee: request.recipient.toLowerCase(),
    realm: challenge.realm,
  }
}

export function safeResponseHeaders(headers: Headers): Record<string, string> {
  const safe = new Set(['content-language', 'content-type', 'etag', 'last-modified'])
  const output: Record<string, string> = {}
  for (const [name, value] of headers.entries()) {
    if (safe.has(name.toLowerCase())) output[name.toLowerCase()] = value
  }
  return output
}
