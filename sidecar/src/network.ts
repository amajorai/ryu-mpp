import { AppError, type PaymentPolicy } from './types.ts'

const MAX_REQUEST_BYTES = 256 * 1024
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024
const REQUEST_TIMEOUT_MS = 30_000
const MAX_REDIRECTS = 3

export function assertAllowedTarget(url: URL, policy: PaymentPolicy): void {
  if (url.username || url.password || url.hash) {
    throw new AppError('invalid_target', 'Payment targets cannot contain credentials or fragments.')
  }
  if (!policy.allowedOrigins.includes(url.origin)) {
    throw new AppError('origin_not_allowed', 'Payment origin is not on the allowlist.', 403)
  }
}

function copyRequestHeaders(request: Request, url: URL): Record<string, string> {
  const headers: Record<string, string> = { host: url.host }
  for (const [name, value] of request.headers.entries()) {
    const lower = name.toLowerCase()
    if (
      lower === 'connection' ||
      lower === 'content-length' ||
      lower === 'host' ||
      lower === 'proxy-authorization' ||
      lower === 'transfer-encoding' ||
      lower === 'upgrade' ||
      lower === 'x-ryu-forwarded-authorization'
    ) {
      continue
    }
    headers[lower] = value
  }
  return headers
}

async function requestOnce(request: Request, policy: PaymentPolicy): Promise<Response> {
  const url = new URL(request.url)
  assertAllowedTarget(url, policy)
  const body = request.body ? new Uint8Array(await request.arrayBuffer()) : undefined
  if (body && body.byteLength > MAX_REQUEST_BYTES) {
    throw new AppError('body_too_large', 'Payment request body exceeds 256 KiB.', 413)
  }

  const port = process.env.RYU_CORE_PORT?.trim()
  const token = process.env.RYU_EXT_TOKEN?.trim()
  if (!(port && token)) {
    throw new AppError(
      'egress_unavailable',
      'Ryu guarded network egress is unavailable.',
      503,
    )
  }
  const response = await fetch(`http://127.0.0.1:${port}/api/host/capability/egress.fetch`, {
    body: JSON.stringify({
      body_base64: body ? Buffer.from(body).toString('base64') : undefined,
      headers: Object.entries(copyRequestHeaders(request, url)).map(([name, value]) => ({
        name,
        value,
      })),
      method: request.method,
      url: url.toString(),
    }),
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'x-ryu-plugin-id': process.env.RYU_EXT_PLUGIN_ID?.trim() || '@ryu/mpp',
    },
    method: 'POST',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS + 5000),
  })
  const payload = (await response.json().catch(() => null)) as {
    body_base64?: unknown
    error?: string | { message?: string }
    headers?: unknown
    status?: unknown
  } | null
  if (!response.ok) {
    const detail =
      typeof payload?.error === 'string'
        ? payload.error
        : payload?.error?.message ?? 'Ryu guarded network egress failed.'
    throw new AppError('egress_failed', detail, response.status >= 500 ? 502 : response.status)
  }
  if (
    typeof payload?.status !== 'number' ||
    !Number.isInteger(payload.status) ||
    payload.status < 100 ||
    payload.status > 599 ||
    typeof payload.body_base64 !== 'string'
  ) {
    throw new AppError('egress_failed', 'Ryu returned an invalid network response.', 502)
  }
  const headers = new Headers()
  if (Array.isArray(payload.headers)) {
    for (const header of payload.headers) {
      if (
        typeof header === 'object' &&
        header !== null &&
        'name' in header &&
        'value' in header &&
        typeof header.name === 'string' &&
        typeof header.value === 'string'
      ) {
        headers.append(header.name, header.value)
      }
    }
  }
  const responseBody = Buffer.from(payload.body_base64, 'base64')
  if (responseBody.byteLength > MAX_RESPONSE_BYTES) {
    throw new AppError('response_too_large', 'Payment response exceeds 2 MiB.', 502)
  }
  return new Response(responseBody, { headers, status: payload.status })
}

export function createGovernedFetch(policyProvider: () => PaymentPolicy): typeof fetch {
  const governedFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    let request = new Request(input, { ...init, redirect: 'manual' })
    const originalOrigin = new URL(request.url).origin
    for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount += 1) {
      const response = await requestOnce(request.clone(), policyProvider())
      if (![301, 302, 303, 307, 308].includes(response.status)) return response
      if (redirectCount === MAX_REDIRECTS) {
        throw new AppError('too_many_redirects', 'Payment target redirected too many times.', 502)
      }
      const location = response.headers.get('location')
      if (!location) return response
      const nextUrl = new URL(location, request.url)
      if (nextUrl.origin !== originalOrigin) {
        throw new AppError('cross_origin_redirect', 'Cross-origin payment redirects are blocked.', 502)
      }
      const switchToGet = response.status === 303 || ((response.status === 301 || response.status === 302) && request.method === 'POST')
      request = new Request(nextUrl, {
        headers: request.headers,
        method: switchToGet ? 'GET' : request.method,
        ...(switchToGet || !request.body ? {} : { body: await request.clone().arrayBuffer(), duplex: 'half' }),
        redirect: 'manual',
      } as RequestInit)
    }
    throw new AppError('too_many_redirects', 'Payment target redirected too many times.', 502)
  }
  return governedFetch as typeof fetch
}
