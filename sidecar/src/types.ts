export const TEMPO_TESTNET_CHAIN_ID = 42_431
export const PATH_USD_ADDRESS = '0x20c0000000000000000000000000000000000000'
export const PATH_USD_DECIMALS = 6

export type PaymentPolicy = {
  allowedOrigins: string[]
  approvalThresholdAtomic: string
  autoPay: boolean
  dailySpendCapAtomic: string
  enabledMethods: ['tempo']
  maxPerRequestAtomic: string
  testnetOnly: true
  version: 1
}

export type PaymentRequestInput = {
  body?: string
  headers?: Record<string, string>
  idempotencyKey?: string
  method: 'DELETE' | 'GET' | 'HEAD' | 'PATCH' | 'POST' | 'PUT'
  url: string
}

export type McpPaymentRequestInput = {
  arguments: Record<string, unknown>
  idempotencyKey?: string
  tool: string
  url: string
}

export type NormalizedChallenge = {
  amountAtomic: string
  chainId: number
  challengeHash: string
  challengeId: string
  currency: string
  decimals: number
  description?: string
  digest?: string
  expiresAt?: string
  intent: string
  method: 'tempo'
  origin: string
  payee: string
  realm: string
}

export type BudgetSnapshot = {
  availableAtomic: string
  dailyCapAtomic: string
  pendingAtomic: string
  spentAtomic: string
}

export type PolicyDecision =
  | {
      budget: BudgetSnapshot
      kind: 'allowed'
    }
  | {
      budget: BudgetSnapshot
      kind: 'approval_required'
      reason: string
    }
  | {
      budget: BudgetSnapshot
      kind: 'blocked'
      reason: string
    }

export type PreparedPayment = {
  approvalToken: string
  budget: BudgetSnapshot
  challenge: NormalizedChallenge
  expiresAt: string
  request:
    | ({ transport: 'http' } & Pick<PaymentRequestInput, 'method' | 'url'>)
    | { tool: string; transport: 'mcp'; url: string }
  requiresApproval: boolean
}

export type PaymentPreparation =
  | {
      kind: 'payment_required'
      payment: PreparedPayment
    }
  | {
      kind: 'ready'
      resource: PaidResource
    }

export type ReceiptProjection = {
  amountAtomic: string
  chainId: number
  challengeId: string
  currency: string
  id: string
  method: string
  origin: string
  payee: string
  reference: string
  status: 'success'
  timestamp: string
}

export type PaidResource = {
  body: string
  contentType: string | null
  headers: Record<string, string>
  status: number
}

export type PaymentResult = {
  receipt: ReceiptProjection
  resource: PaidResource
}

export type WalletStatus = {
  address: string | null
  balanceAtomic: string
  configured: boolean
  currency: typeof PATH_USD_ADDRESS
  decimals: typeof PATH_USD_DECIMALS
  network: 'Tempo testnet'
}

export type ServiceCatalogItem = {
  categories: string[]
  description: string
  endpoints: Array<{
    method: string
    path: string
    price?: string
  }>
  id: string
  name: string
  status?: string
  url: string
}

export class AppError extends Error {
  readonly code: string
  readonly status: number

  constructor(code: string, message: string, status = 400) {
    super(message)
    this.name = 'AppError'
    this.code = code
    this.status = status
  }
}
