import { describe, expect, test } from 'bun:test'

import { formatAtomicAmount, validatePaymentRequest } from './validation.ts'

describe('payment request validation', () => {
  test('rejects caller-provided authorization credentials', () => {
    expect(() =>
      validatePaymentRequest({
        headers: { Authorization: 'Bearer secret' },
        method: 'GET',
        url: 'https://mpp.dev/api/ping/paid',
      }),
    ).toThrow('not allowed')
  })

  test('rejects insecure public targets', () => {
    expect(() =>
      validatePaymentRequest({ method: 'GET', url: 'http://example.com/paid' }),
    ).toThrow('HTTPS')
  })

  test('formats atomic amounts without floating point arithmetic', () => {
    expect(formatAtomicAmount('1234567')).toBe('1.234567')
    expect(formatAtomicAmount('1000000')).toBe('1')
  })
})
