import { describe, expect, test } from 'bun:test'
import { Mcp } from 'mppx'
import { Mppx, tempo } from 'mppx/server'

import { callMcpTool, validateMcpPaymentRequest } from './mcp.ts'
import { PATH_USD_ADDRESS } from './types.ts'

describe('MPP MCP transport', () => {
  test('rejects invalid URLs and prototype-bearing argument keys', () => {
    expect(() =>
      validateMcpPaymentRequest({ tool: 'paid.lookup', url: 'not a URL' }),
    ).toThrow('valid MCP server URL')
    expect(() =>
      validateMcpPaymentRequest({
        arguments: { nested: { constructor: { polluted: true } } },
        tool: 'paid.lookup',
        url: 'https://mpp.dev/mcp/services',
      }),
    ).toThrow('forbidden object key')
  })

  test('correlates the requested JSON-RPC id in SSE responses', async () => {
    const fetcher = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const payload = JSON.parse(String(init?.body)) as { id?: number; method: string }
      if (payload.method === 'notifications/initialized') {
        return new Response(null, { status: 202 })
      }
      const result = payload.method === 'initialize'
        ? {
            capabilities: { tools: {} },
            protocolVersion: '2025-06-18',
            serverInfo: { name: 'test', version: '1' },
          }
        : { content: [{ text: 'expected result', type: 'text' }] }
      const body = [
        'data: {"jsonrpc":"2.0","method":"notifications/progress"}',
        `data: ${JSON.stringify({ id: payload.id, jsonrpc: '2.0', result })}`,
      ].join('\n\n')
      return new Response(body, {
        headers: {
          'content-type': 'text/event-stream',
          ...(payload.method === 'initialize' ? { 'mcp-session-id': 'session-sse' } : {}),
        },
      })
    }) as typeof fetch

    const outcome = await callMcpTool(fetcher, {
      arguments: {},
      tool: 'paid.lookup',
      url: 'https://mpp.dev/mcp/services',
    })
    expect(outcome.kind).toBe('result')
    if (outcome.kind === 'result') expect(JSON.stringify(outcome.result)).toContain('expected result')
  })

  test('recognizes payment-required result metadata', async () => {
    const paymentServer = Mppx.create({
      methods: [
        tempo.charge({
          currency: PATH_USD_ADDRESS,
          decimals: 6,
          recipient: '0x0000000000000000000000000000000000000001',
          testnet: true,
        }),
      ],
      realm: 'mpp.dev',
      secretKey: 'test-secret-key-that-is-at-least-32-bytes-long',
    })
    const challenge = await paymentServer.challenge.tempo.charge({ amount: '0' })
    const fetcher = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const payload = JSON.parse(String(init?.body)) as { id?: number; method: string }
      if (payload.method === 'notifications/initialized') {
        return new Response(null, { status: 202 })
      }
      if (payload.method === 'initialize') {
        return Response.json({
          id: payload.id,
          jsonrpc: '2.0',
          result: {
            capabilities: { tools: {} },
            protocolVersion: '2025-06-18',
            serverInfo: { name: 'test', version: '1' },
          },
        })
      }
      return Response.json({
        id: payload.id,
        jsonrpc: '2.0',
        result: {
          _meta: {
            [Mcp.paymentRequiredMetaKey]: { challenges: [challenge] },
          },
          content: [{ text: 'payment needed', type: 'text' }],
        },
      })
    }) as typeof fetch

    const outcome = await callMcpTool(fetcher, {
      arguments: {},
      tool: 'paid.lookup',
      url: 'https://mpp.dev/mcp/services',
    })
    expect(outcome.kind).toBe('payment_required')
    if (outcome.kind === 'payment_required') expect(outcome.challenge.id).toBe(challenge.id)
  })
})
