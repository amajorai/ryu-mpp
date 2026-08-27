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

export type BudgetSnapshot = {
  availableAtomic: string
  dailyCapAtomic: string
  pendingAtomic: string
  spentAtomic: string
}

export type WalletStatus = {
  address: string | null
  balanceAtomic: string
  configured: boolean
  currency: string
  decimals: number
  network: string
}

export type Status = {
  budget: BudgetSnapshot
  policy: PaymentPolicy
  wallet: WalletStatus
}

export type Service = {
  categories: string[]
  description: string
  endpoints: Array<{ method: string; path: string; price?: string }>
  id: string
  name: string
  status?: string
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

export type PreparedPayment = {
  approvalToken: string
  budget: BudgetSnapshot
  challenge: NormalizedChallenge
  expiresAt: string
  request:
    | { method: string; transport: 'http'; url: string }
    | { tool: string; transport: 'mcp'; url: string }
  requiresApproval: boolean
}

export type Receipt = {
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

export type Preparation =
  | { kind: 'payment_required'; payment: PreparedPayment }
  | { kind: 'ready'; resource: PaidResource }

export type PaymentResult = { receipt: Receipt; resource: PaidResource }
