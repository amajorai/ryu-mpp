import { describe, expect, test } from 'bun:test'
import { Challenge, Credential, Mcp, Receipt } from 'mppx'
import { Mppx, tempo } from 'mppx/server'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'

import { MppPaymentClient } from './client.ts'
import { PaymentStore } from './store.ts'
import { PATH_USD_ADDRESS } from './types.ts'
import { MemorySecretVault, MppWallet } from './wallet.ts'

describe('governed MPP payment', () => {
  test('prepares, approves, signs, verifies, and stores a protocol receipt', async () => {
    const vault = new MemorySecretVault()
    const privateKey = generatePrivateKey()
    await vault.set('wallet', privateKey)
    const account = privateKeyToAccount(privateKey)
    const server = Mppx.create({
      methods: [
        tempo.charge({
          currency: PATH_USD_ADDRESS,
          decimals: 6,
          recipient: account.address,
          testnet: true,
        }),
      ],
      realm: 'mpp.dev',
      secretKey: 'test-secret-key-that-is-at-least-32-bytes-long',
    })
    const targetFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init)
      const result = await server.charge({ amount: '0', scope: 'GET /paid' })(request)
      if (result.status === 402) return result.challenge
      return result.withReceipt(Response.json({ data: 'paid' }))
    }) as typeof fetch

    const store = new PaymentStore(':memory:')
    const client = new MppPaymentClient(store, new MppWallet(vault), targetFetch)
    try {
      const prepared = await client.prepare({ method: 'GET', url: 'https://mpp.dev/paid' })
      expect(prepared.kind).toBe('payment_required')
      if (prepared.kind !== 'payment_required') throw new Error('expected payment challenge')
      expect(prepared.payment.requiresApproval).toBe(true)

      const result = await client.pay(prepared.payment.approvalToken)
      expect(result.resource.status).toBe(200)
      expect(result.receipt.status).toBe('success')
      expect(result.receipt.method).toBe('tempo')
      expect(store.listReceipts()).toHaveLength(1)
      await expect(client.pay(prepared.payment.approvalToken)).rejects.toThrow('already used')
    } finally {
      store.close()
    }
  })

  test('prepares and settles an MCP payment-required tool call', async () => {
    const vault = new MemorySecretVault()
    const privateKey = generatePrivateKey()
    await vault.set('wallet', privateKey)
    const account = privateKeyToAccount(privateKey)
    const paymentServer = Mppx.create({
      methods: [
        tempo.charge({
          currency: PATH_USD_ADDRESS,
          decimals: 6,
          recipient: account.address,
          testnet: true,
        }),
      ],
      realm: 'mpp.dev',
      secretKey: 'test-secret-key-that-is-at-least-32-bytes-long',
    })
    const targetFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init)
      const payload = (await request.json()) as {
        id?: number
        method: string
        params?: Record<string, unknown>
      }
      if (payload.method === 'initialize') {
        return Response.json(
          {
            id: payload.id,
            jsonrpc: '2.0',
            result: {
              capabilities: { tools: {} },
              protocolVersion: '2025-06-18',
              serverInfo: { name: 'paid-test', version: '1.0.0' },
            },
          },
          { headers: { 'mcp-session-id': 'session-1' } },
        )
      }
      if (payload.method === 'notifications/initialized') {
        return new Response(null, { status: 202 })
      }

      const meta = payload.params?._meta as Record<string, unknown> | undefined
      const credential = meta?.[Mcp.credentialMetaKey]
      const paymentHeaders = new Headers()
      if (credential && typeof credential === 'object') {
        paymentHeaders.set(
          'authorization',
          Credential.serialize(credential as Credential.Credential),
        )
      }
      const payment = await paymentServer.charge({ amount: '0', scope: 'MCP premium_tool' })(
        new Request('https://mpp.dev/mcp/services', { headers: paymentHeaders, method: 'POST' }),
      )
      if (payment.status === 402) {
        const challenge = Challenge.fromResponseList(payment.challenge)[0]
        if (!challenge) throw new Error('test server did not issue a challenge')
        return Response.json({
          error: {
            code: Mcp.paymentRequiredCode,
            data: { challenges: [challenge], httpStatus: 402 },
            message: 'Payment required',
          },
          id: payload.id,
          jsonrpc: '2.0',
        })
      }
      const paidResponse = payment.withReceipt(Response.json({ ok: true }))
      const receipt = Receipt.fromResponse(paidResponse)
      return Response.json({
        id: payload.id,
        jsonrpc: '2.0',
        result: {
          _meta: { [Mcp.receiptMetaKey]: receipt },
          content: [{ text: 'paid MCP result', type: 'text' }],
        },
      })
    }) as typeof fetch

    const store = new PaymentStore(':memory:')
    const client = new MppPaymentClient(store, new MppWallet(vault), targetFetch)
    try {
      const prepared = await client.prepareMcp({
        arguments: { query: 'tempo' },
        tool: 'premium_tool',
        url: 'https://mpp.dev/mcp/services',
      })
      expect(prepared.kind).toBe('payment_required')
      if (prepared.kind !== 'payment_required') throw new Error('expected MCP payment challenge')
      expect(prepared.payment.request).toEqual({
        tool: 'premium_tool',
        transport: 'mcp',
        url: 'https://mpp.dev/mcp/services',
      })

      const result = await client.pay(prepared.payment.approvalToken)
      expect(result.resource.status).toBe(200)
      expect(result.resource.body).toContain('paid MCP result')
      expect(result.receipt.method).toBe('tempo')
      expect(store.listReceipts()).toHaveLength(1)
    } finally {
      store.close()
    }
  })
})
